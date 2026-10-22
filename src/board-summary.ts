import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { type Card, getBoard } from './board.ts';
import { runClaude } from './claude.ts';
import { promptPath } from './paths.ts';
import { OWNER_TEAM_KEYWORDS, TEAM_FIELD } from './queries.ts';

export const DEFAULT_SUMMARY_MODEL = 'sonnet';

export type BoardSummary = {
    team: {
        headline: string;
        summary: string;
        highlights: string[];
        risks: string[];
        next_steps: { action: string; owner: string | null }[];
    };
    members: { login: string; status: string; next_steps: string[] }[];
};

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['team', 'members'],
    properties: {
        team: {
            type: 'object',
            additionalProperties: false,
            required: ['headline', 'summary', 'highlights', 'risks', 'next_steps'],
            properties: {
                headline: { type: 'string', description: 'One line, the gist' },
                summary: { type: 'string', description: '2-4 sentences' },
                highlights: { type: 'array', items: { type: 'string' } },
                risks: { type: 'array', items: { type: 'string' } },
                next_steps: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['action', 'owner'],
                        properties: { action: { type: 'string' }, owner: { type: ['string', 'null'] } },
                    },
                },
            },
        },
        members: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['login', 'status', 'next_steps'],
                properties: { login: { type: 'string' }, status: { type: 'string' }, next_steps: { type: 'array', items: { type: 'string' } } },
            },
        },
    },
};

const ITEMS_PER_COLUMN = 12;
const STALE_DAYS = 14;
const COLUMN_LABELS = { todo: 'To do', wip: 'In progress', review: 'In review' } as const;

const age = (iso: string) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return days === 0 ? 'today' : `${days}d ago`;
};

function describeCard(c: Card, triage: Map<number, string>): string {
    if (c.kind === 'issue') {
        const note = triage.get(c.number);
        return `- Issue #${c.number} "${c.title}"${c.priority ? ` [${c.priority}]` : ''}${c.status ? ` status: ${c.status}` : ''}, updated ${age(c.updatedAt)}${note ? ` — triage: ${note}` : ''}`;
    }
    const review = c.draft
        ? 'draft'
        : c.changesRequestedBy.length
          ? `changes requested by ${c.changesRequestedBy.join(', ')}`
          : c.reviewDecision === 'APPROVED'
            ? `approved by ${c.approvedBy.join(', ')}`
            : c.requested.length
              ? `waiting for review from ${c.requested.join(', ')}`
              : 'no reviewer requested';
    const stale = (Date.now() - new Date(c.updatedAt).getTime()) / 86_400_000 > STALE_DAYS;
    return (
        `- PR #${c.number} "${c.title}": ${review}; CI ${c.ci?.toLowerCase() ?? 'unknown'}${c.conflicting ? '; merge conflicts' : ''}; ` +
        `+${c.additions}/−${c.deletions}; opened ${age(c.createdAt)}, updated ${age(c.updatedAt)}${stale ? ' (STALE)' : ''}` +
        (c.issues.length ? `; closes ${c.issues.map(i => `#${i.number}`).join(', ')}` : '')
    );
}

/** Compact markdown digest of the board (+ unowned project work) that fits a single prompt. */
export function buildBoardDigest(db: Database, teamSlug: string): string {
    const board = getBoard(db, teamSlug);
    if (!board) throw new Error(`Unknown team ${teamSlug}`);
    const triage = new Map(
        db
            .query<{ issue_number: number; recommendation: string; summary: string }, []>('SELECT issue_number, recommendation, summary FROM issue_analysis')
            .all()
            .map(a => [a.issue_number, `${a.recommendation}: ${a.summary.slice(0, 160)}`]),
    );

    const lines = [
        `Today is ${new Date().toISOString().slice(0, 10)}. Team: ${board.team.name} (${board.members.map(m => m.login).join(', ')}).`,
        `STALE = no update for more than ${STALE_DAYS} days.`,
    ];
    for (const m of board.members) {
        lines.push('', `## ${m.login}`);
        if (m.reviewing.length) {
            const oldest = [...m.reviewing].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
            lines.push(
                `Review requests waiting on ${m.login}: ${m.reviewing.length} ready PRs. Longest waiting: ` +
                    oldest
                        .slice(0, 5)
                        .map(r => `#${r.number} by ${r.author} (updated ${age(r.updatedAt)})`)
                        .join(', '),
            );
        }
        for (const key of ['todo', 'wip', 'review'] as const) {
            const cards = m.columns[key];
            lines.push(`### ${COLUMN_LABELS[key]} (${cards.length})`);
            for (const c of cards.slice(0, ITEMS_PER_COLUMN)) lines.push(describeCard(c, triage));
            if (cards.length > ITEMS_PER_COLUMN) {
                const rest = cards.slice(ITEMS_PER_COLUMN);
                const stale = rest.filter(c => (Date.now() - new Date(c.updatedAt).getTime()) / 86_400_000 > STALE_DAYS).length;
                lines.push(`- …and ${rest.length} more (${stale} of them stale)`);
            }
        }
    }

    // Unassigned issues the team owns in the project (GitHub team ↔ project Team via the same keywords as triage).
    const keyword = OWNER_TEAM_KEYWORDS[teamSlug];
    if (keyword) {
        const unowned = db
            .query<{ number: number; title: string; priority: string | null; status: string | null }, [string]>(
                `SELECT i.number, i.title,
                        (SELECT v2.value FROM project_item_values v2 WHERE v2.item_id = pi.item_id AND v2.field = 'Priority') AS priority,
                        (SELECT v3.value FROM project_item_values v3 WHERE v3.item_id = pi.item_id AND v3.field = 'Status') AS status
                 FROM issues i
                 JOIN project_items pi ON pi.number = i.number AND pi.content_type = 'Issue' AND pi.archived = 0
                      AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')
                 JOIN project_item_values v ON v.item_id = pi.item_id AND v.field = '${TEAM_FIELD}' AND lower(v.value) LIKE '%' || ? || '%'
                 WHERE i.state = 'OPEN' AND NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_number = i.number)
                 ORDER BY CASE WHEN priority LIKE 'HIGH%' THEN 0 WHEN priority LIKE 'MEDIUM%' THEN 1 ELSE 2 END, i.updated_at DESC`,
            )
            .all(keyword);
        if (unowned.length) {
            lines.push('', `## Unassigned issues owned by the team in the project (${unowned.length})`);
            for (const u of unowned.slice(0, 15)) {
                lines.push(`- Issue #${u.number} "${u.title}"${u.priority ? ` [${u.priority}]` : ''}${u.status ? ` status: ${u.status}` : ''}`);
            }
            if (unowned.length > 15) lines.push(`- …and ${unowned.length - 15} more`);
        }
    }
    return lines.join('\n');
}

export async function summarizeBoard(db: Database, teamSlug: string, model = DEFAULT_SUMMARY_MODEL) {
    const digest = buildBoardDigest(db, teamSlug);
    const run = await runClaude<BoardSummary>({
        systemPrompt: readFileSync(promptPath('board-summary.md'), 'utf8'),
        prompt: digest,
        schema: SCHEMA,
        model,
    });
    const generatedAt = new Date().toISOString();
    db.query('INSERT INTO board_summaries (team_slug, result_json, model, cost_usd, duration_ms, generated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        teamSlug,
        JSON.stringify(run.result),
        run.model,
        run.costUsd,
        run.durationMs,
        generatedAt,
    );
    return getLatestSummary(db, teamSlug);
}

export function getLatestSummary(db: Database, teamSlug: string) {
    const row = db
        .query<{ result_json: string; model: string; cost_usd: number | null; generated_at: string }, [string]>(
            'SELECT result_json, model, cost_usd, generated_at FROM board_summaries WHERE team_slug = ? ORDER BY id DESC LIMIT 1',
        )
        .get(teamSlug);
    if (!row) return null;
    return { ...(JSON.parse(row.result_json) as BoardSummary), model: row.model, costUsd: row.cost_usd, generatedAt: row.generated_at };
}
