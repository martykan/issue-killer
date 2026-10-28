import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promptPath } from '../paths.ts';
import { getSettings } from '../settings.ts';


export const ENUMS = {
    kind: ['bug', 'feature', 'improvement', 'tech_debt', 'test_flake', 'support_question', 'docs', 'tracking', 'other'],
    owner_team: [
        'suite-connect',
        'suite-wallet',
        'suite-desktop',
        'suite-mobile',
        'suite-trading',
        'suite-networks',
        'suite-earn',
        'suite-growth',
        'suite-security',
        'qa',
        'firmware',
        'devops',
        'unknown',
    ],
    team_relevance: ['high', 'medium', 'low', 'none'],
    recommendation: [
        'prioritize',
        'keep',
        'needs_info',
        'close_fixed',
        'close_duplicate',
        'close_obsolete',
        'close_wont_fix',
        'close_stale',
    ],
    confidence: ['high', 'medium', 'low'],
    severity: ['critical', 'high', 'medium', 'low', 'none'],
    effort: ['small', 'medium', 'large', 'unknown'],
} as const;

type Enums = typeof ENUMS;
export type AnalysisResult = { [K in keyof Enums]: Enums[K][number] } & {
    summary: string;
    reasoning: string;
    next_step: string;
    area: string;
    suggested_labels: string[];
};

const str = { type: 'string' };
export const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'summary',
        'kind',
        'area',
        'owner_team',
        'team_relevance',
        'recommendation',
        'confidence',
        'reasoning',
        'next_step',
        'severity',
        'effort',
        'suggested_labels',
    ],
    properties: {
        summary: str,
        kind: { type: 'string', enum: ENUMS.kind },
        area: str,
        owner_team: { type: 'string', enum: ENUMS.owner_team },
        team_relevance: { type: 'string', enum: ENUMS.team_relevance },
        recommendation: { type: 'string', enum: ENUMS.recommendation },
        confidence: { type: 'string', enum: ENUMS.confidence },
        reasoning: str,
        next_step: str,
        severity: { type: 'string', enum: ENUMS.severity },
        effort: { type: 'string', enum: ENUMS.effort },
        suggested_labels: { type: 'array', items: str },
    },
};

function promptTemplate() {
    return readFileSync(promptPath('analyze.md'), 'utf8');
}

/** Changes whenever the prompt or output schema changes; analyses with another version are "outdated". */
export function promptVersion(db: Database): string {
    return createHash('sha256')
        .update(promptTemplate())
        // Relevance is judged for the user's team, so changing it makes analyses outdated.
        .update(getSettings(db).myTeam ?? '')
        .update(JSON.stringify(RESULT_SCHEMA))
        .digest('hex')
        .slice(0, 10);
}

export function buildSystemPrompt(db: Database): string {
    const labels = db
        .query<{ name: string; description: string | null }, []>('SELECT name, description FROM labels ORDER BY name COLLATE NOCASE')
        .all()
        .map(l => `- ${l.name}${l.description ? ` – ${l.description}` : ''}`)
        .join('\n');
    const team = getSettings(db).myTeam;
    const myTeam = team ? `\`${team}\`` : 'not configured (answer `none`)';
    return promptTemplate().replace('{{LABELS}}', labels).replaceAll('{{MY_TEAM}}', myTeam);
}

const BODY_LIMIT = 12_000;
const COMMENT_LIMIT = 3_000;
const COMMENTS_BUDGET = 30_000;

const clip = (text: string, limit: number) =>
    text.length > limit ? `${text.slice(0, limit)}\n[… truncated ${text.length - limit} chars …]` : text;
const day = (iso: string | null) => iso?.slice(0, 10) ?? '-';

/** Renders an issue with everything the model needs as compact markdown. Expects temp.people to exist. */
export function buildIssuePrompt(db: Database, number: number): { prompt: string; updatedAt: string } {
    const issue = db
        .query<Record<string, string | number | null>, [number]>(
            `SELECT i.*, (SELECT status FROM temp.people p WHERE p.login = i.author) AS author_status
             FROM issues i WHERE number = ?`,
        )
        .get(number);
    if (!issue) throw new Error(`Issue #${number} not in DB`);

    const labels = db
        .query<{ label: string }, [number]>('SELECT label FROM issue_labels WHERE issue_number = ? ORDER BY label')
        .all(number)
        .map(l => l.label);
    const assignees = db
        .query<{ login: string; status: string | null }, [number]>(
            `SELECT a.login, p.status FROM issue_assignees a LEFT JOIN temp.people p ON p.login = a.login
             WHERE a.issue_number = ?`,
        )
        .all(number)
        .map(a => `${a.login} (${a.status ?? 'unknown'})`);
    const refs = db
        .query<Record<string, string | number | null>, [number]>(
            `SELECT * FROM issue_references WHERE issue_number = ? ORDER BY referenced_at`,
        )
        .all(number);
    const children = db
        .query<{ number: number; title: string; state: string }, [number]>(
            'SELECT number, title, state FROM issues WHERE parent_number = ? ORDER BY number',
        )
        .all(number);
    const parent = issue.parent_number
        ? db
              .query<{ number: number; title: string; state: string }, [number]>(
                  'SELECT number, title, state FROM issues WHERE number = ?',
              )
              .get(Number(issue.parent_number))
        : null;
    const comments = db
        .query<{ author: string | null; status: string | null; body: string; created_at: string }, [number]>(
            `SELECT c.author, p.status, c.body, c.created_at FROM comments c
             LEFT JOIN temp.people p ON p.login = c.author
             WHERE c.issue_number = ? ORDER BY c.created_at`,
        )
        .all(number);

    const lines: string[] = [
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
        '',
        `# #${issue.number}: ${issue.title}`,
        '',
        `- State: ${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ''}`,
        `- Type: ${issue.issue_type ?? 'not set'}`,
        `- Author: ${issue.author ?? 'ghost'} (${issue.author_status ?? 'unknown'})`,
        `- Assignees: ${assignees.join(', ') || 'none'}`,
        `- Labels: ${labels.join(', ') || 'none'}`,
        `- Milestone: ${issue.milestone ?? 'none'}`,
        `- Created: ${day(issue.created_at as string)}, last updated: ${day(issue.updated_at as string)}` +
            (issue.closed_at ? `, closed: ${day(issue.closed_at as string)}` : ''),
        `- Reactions: ${issue.reactions_count} (👍 ${issue.thumbs_up_count}), comments: ${issue.comments_count}`,
    ];
    const projects = db
        .query<{ title: string; fields: string | null }, [number]>(
            `SELECT p.title, (SELECT group_concat(v.field || ': ' || v.value, ', ') FROM project_item_values v WHERE v.item_id = pi.item_id) AS fields
             FROM project_items pi JOIN projects p ON p.number = pi.project_number
             WHERE pi.number = ? AND pi.content_type = 'Issue' AND pi.archived = 0
               AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')`,
        )
        .all(number);
    for (const p of projects) lines.push(`- Project "${p.title}": ${p.fields ?? 'no fields set'}`);
    if (parent) lines.push(`- Parent issue: #${parent.number} ${parent.title} [${parent.state}]`);
    if (children.length) {
        lines.push(`- Sub-issues (${children.length}):`);
        for (const c of children) lines.push(`  - #${c.number} ${c.title} [${c.state}]`);
    }

    if (refs.length) {
        lines.push('', '## Linked pull requests / issues', '');
        const ownRepo = db.query<{ value: string }, []>("SELECT value FROM sync_state WHERE key = 'repo'").get()?.value;
        for (const r of refs) {
            const kind = r.source_type === 'PullRequest' ? 'PR' : 'Issue';
            const repo = r.source_repo === ownRepo ? '' : String(r.source_repo);
            lines.push(
                `- ${kind} ${repo}#${r.source_number} [${r.source_state}] ${r.source_title ?? ''}` +
                    (r.will_close ? ' — linked as closing this issue' : '') +
                    (r.referenced_at ? ` (referenced ${day(r.referenced_at as string)})` : ''),
            );
        }
    }

    lines.push('', '## Description', '', clip(String(issue.body ?? '').trim() || '(empty)', BODY_LIMIT));

    if (comments.length) {
        lines.push('', `## Comments (${comments.length})`);
        const rendered = comments.map(
            c => `\n### ${c.author ?? 'ghost'} (${c.status ?? 'unknown'}) · ${day(c.created_at)}\n\n${clip(c.body.trim(), COMMENT_LIMIT)}`,
        );
        // Keep the first comments (context) and as many of the latest ones (current state) as fit.
        const head = rendered.slice(0, 3);
        let budget = COMMENTS_BUDGET - head.reduce((n, c) => n + c.length, 0);
        const tail: string[] = [];
        for (let i = rendered.length - 1; i >= head.length; i--) {
            if (rendered[i]!.length > budget) break;
            budget -= rendered[i]!.length;
            tail.unshift(rendered[i]!);
        }
        const omitted = rendered.length - head.length - tail.length;
        lines.push(...head);
        if (omitted > 0) lines.push(`\n[… ${omitted} comments omitted …]`);
        lines.push(...tail);
    }

    return { prompt: lines.join('\n'), updatedAt: String(issue.updated_at) };
}
