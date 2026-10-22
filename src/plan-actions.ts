import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { runClaude } from './claude.ts';
import type { GitHubClient } from './github.ts';
import { promptPath } from './paths.ts';
import { getPlan, projectFields, RELEASE_FIELD, setPlanChange } from './planning.ts';

// ---------- Apply the draft plan to GitHub ----------

const SET_ITERATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { iterationId: $iterationId } }) {
        projectV2Item { id }
    }
}`;
const CLEAR_FIELD = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
}`;
const ADD_ASSIGNEES = `
mutation($id: ID!, $users: [ID!]!) { addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: $users }) { clientMutationId } }`;
const REMOVE_ASSIGNEES = `
mutation($id: ID!, $users: [ID!]!) { removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: $users }) { clientMutationId } }`;

export type ApplyResult = { applied: number; failed: { number: number; error: string }[] };

/** Writes pending Release / assignee changes of one team's plan to GitHub (needs the `project` token scope). */
export async function applyPlan(db: Database, gh: GitHubClient, projectNumber: number, team: string): Promise<ApplyResult> {
    const plan = getPlan(db, projectNumber, team);
    const project = projectFields(db, projectNumber);
    if (!plan || !project) throw new Error('Project not synced');
    const releaseField = project.fields.find(f => f.name === RELEASE_FIELD);
    if (!releaseField?.iterations) throw new Error(`No iteration field "${RELEASE_FIELD}" in the project`);

    const userIds = new Map<string, string>();
    const userId = async (login: string) => {
        if (!userIds.has(login)) {
            const res = await gh.query<{ user: { id: string } | null }>('query($login: String!) { user(login: $login) { id } }', { login }, 1);
            if (!res.user) throw new Error(`Unknown GitHub user ${login}`);
            userIds.set(login, res.user.id);
        }
        return userIds.get(login)!;
    };
    const viewer = (await gh.query<{ viewer: { login: string } }>('query { viewer { login } }', {})).viewer.login;

    const result: ApplyResult = { applied: 0, failed: [] };
    for (const card of plan.cards.filter(c => c.release !== c.githubRelease || c.assignee !== c.githubAssignee)) {
        try {
            const notes: string[] = [];
            if (card.release !== card.githubRelease) {
                const vars = { projectId: project.projectId, itemId: card.itemId, fieldId: releaseField.id };
                if (card.release) {
                    const iteration = releaseField.iterations.find(i => i.title === card.release);
                    if (!iteration) throw new Error(`Unknown release ${card.release}`);
                    await gh.query(SET_ITERATION, { ...vars, iterationId: iteration.id }, 1);
                } else {
                    await gh.query(CLEAR_FIELD, vars, 1);
                }
                notes.push(`release ${card.githubRelease || '–'} → ${card.release || '–'}`);
            }
            if (card.assignee !== card.githubAssignee) {
                const issueId = db.query<{ node_id: string }, [number]>('SELECT node_id FROM issues WHERE number = ?').get(card.number)!.node_id;
                if (card.githubAssignee) await gh.query(REMOVE_ASSIGNEES, { id: issueId, users: [await userId(card.githubAssignee)] }, 1);
                if (card.assignee) await gh.query(ADD_ASSIGNEES, { id: issueId, users: [await userId(card.assignee)] }, 1);
                notes.push(`assignee ${card.githubAssignee || '–'} → ${card.assignee || '–'}`);
            }

            // Mirror locally so the board is right before the next sync.
            db.transaction(() => {
                if (card.release !== card.githubRelease) {
                    if (card.release)
                        db.query('INSERT OR REPLACE INTO project_item_values (item_id, field, value) VALUES (?, ?, ?)').run(card.itemId, RELEASE_FIELD, card.release);
                    else db.query('DELETE FROM project_item_values WHERE item_id = ? AND field = ?').run(card.itemId, RELEASE_FIELD);
                }
                if (card.assignee !== card.githubAssignee) {
                    if (card.githubAssignee) db.query('DELETE FROM issue_assignees WHERE issue_number = ? AND login = ?').run(card.number, card.githubAssignee);
                    if (card.assignee) db.query('INSERT OR IGNORE INTO issue_assignees (issue_number, login) VALUES (?, ?)').run(card.number, card.assignee);
                }
                db.query('DELETE FROM plan_changes WHERE issue_number = ?').run(card.number);
                db.query(
                    `INSERT INTO issue_actions (issue_number, action, comment, performed_by, performed_at) VALUES (?, 'plan', ?, ?, ?)`,
                ).run(card.number, notes.join('; '), viewer, new Date().toISOString());
            })();
            result.applied++;
        } catch (err) {
            const message = (err as Error).message;
            result.failed.push({
                number: card.number,
                error: /INSUFFICIENT_SCOPES|required scopes|project/i.test(message) && /scope/i.test(message)
                    ? 'Token lacks the `project` scope – run: gh auth refresh -s project'
                    : message.slice(0, 200),
            });
        }
    }
    return result;
}

// ---------- Claude suggestions ----------

export type PlanSuggestion = {
    summary: string;
    releases: { release: string; focus: string }[];
    moves: { issue: number; release: string; assignee: string | null; reason: string }[];
};

const SUGGESTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'releases', 'moves'],
    properties: {
        summary: { type: 'string' },
        releases: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['release', 'focus'],
                properties: { release: { type: 'string' }, focus: { type: 'string' } },
            },
        },
        moves: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['issue', 'release', 'assignee', 'reason'],
                properties: {
                    issue: { type: 'integer' },
                    release: { type: 'string', description: 'Release title, or "" to unplan' },
                    assignee: { type: ['string', 'null'], description: 'login, or null to keep the current assignee' },
                    reason: { type: 'string' },
                },
            },
        },
    },
};

const EFFORT_POINTS: Record<string, number> = { small: 1, medium: 3, large: 8 };

export async function suggestPlan(db: Database, projectNumber: number, team: string, model = 'sonnet') {
    const plan = getPlan(db, projectNumber, team);
    if (!plan) throw new Error('Project not synced');
    const active = plan.releases.filter(r => r.state !== 'past');
    const past = new Set(plan.releases.filter(r => r.state === 'past').map(r => r.title));
    const people = [...new Set(plan.cards.map(c => c.assignee).filter(Boolean))].sort();

    const describe = (c: (typeof plan.cards)[number]) =>
        `- #${c.number} "${c.title}"${c.priority ? ` [${c.priority}]` : ''}${c.status ? ` status: ${c.status}` : ''}` +
        `${c.assignee ? ` → ${c.assignee}` : ' (unassigned)'}${c.effort ? ` effort: ${c.effort}` : ''}` +
        `${c.recommendation ? ` triage: ${c.recommendation}` : ''}${c.summary ? ` — ${c.summary.slice(0, 140)}` : ''}`;

    const lines = [
        `Today is ${new Date().toISOString().slice(0, 10)}. Project team: ${team}. People: ${people.join(', ') || 'none'}.`,
        `Releases (Release field): ${active.map(r => `${r.title} (${r.startDate} → ${r.endDate}${r.state === 'current' ? ', CURRENT' : ''})`).join('; ')}.`,
        `Effort points: small=1, medium=3, large=8 (from Claude triage; many issues are unestimated).`,
    ];
    for (const r of active) {
        const cards = plan.cards.filter(c => c.release === r.title);
        const points = cards.reduce((n, c) => n + (EFFORT_POINTS[c.effort ?? ''] ?? 0), 0);
        lines.push('', `## Release ${r.title} – ${cards.length} issues, ~${points} pts estimated`);
        for (const person of [...people, '']) {
            const own = cards.filter(c => c.assignee === person);
            if (own.length) lines.push(`${person || 'Unassigned'} (${own.length}):`, ...own.map(describe));
        }
    }
    const overdue = plan.cards.filter(c => past.has(c.release));
    if (overdue.length) lines.push('', `## Overdue – planned for a finished release, still open (${overdue.length})`, ...overdue.map(c => `${describe(c)} (was ${c.release})`));
    const backlog = plan.cards
        .filter(c => !c.release)
        .sort((a, b) => rank(a.priority) - rank(b.priority));
    lines.push('', `## Unplanned backlog (${backlog.length}, highest priority first)`, ...backlog.slice(0, 70).map(describe));
    if (backlog.length > 70) lines.push(`- …and ${backlog.length - 70} more lower-priority issues`);

    const run = await runClaude<PlanSuggestion>({
        systemPrompt: readFileSync(promptPath('plan-suggest.md'), 'utf8'),
        prompt: lines.join('\n'),
        schema: SUGGESTION_SCHEMA,
        model,
    });
    // Keep only moves that reference real issues/releases/people.
    const known = new Set(plan.cards.map(c => c.number));
    const releaseTitles = new Set(active.map(r => r.title));
    run.result.moves = run.result.moves.filter(
        m => known.has(m.issue) && (m.release === '' || releaseTitles.has(m.release)) && (m.assignee === null || people.includes(m.assignee)),
    );
    db.query('INSERT INTO plan_suggestions (team, result_json, model, cost_usd, generated_at) VALUES (?, ?, ?, ?, ?)').run(
        team,
        JSON.stringify(run.result),
        run.model,
        run.costUsd,
        new Date().toISOString(),
    );
    return run.result;
}

const rank = (p: string | null) => (p ? (/high/i.test(p) ? 0 : /medium/i.test(p) ? 1 : 2) : 3);

/** Copies accepted suggestion moves into the draft plan. */
export function acceptMoves(db: Database, moves: { issue: number; release: string; assignee: string | null }[]) {
    db.transaction(() => {
        for (const m of moves) setPlanChange(db, m.issue, { release: m.release, ...(m.assignee !== null ? { assignee: m.assignee } : {}) });
    })();
}
