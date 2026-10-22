import type { Database } from 'bun:sqlite';

// Board view: per team member, their assigned issues and open PRs in TODO → WIP → In review columns.

export type IssueCard = {
    kind: 'issue';
    number: number;
    title: string;
    url: string;
    status: string | null;
    priority: string | null;
    release: string | null;
    labels: string[];
    updatedAt: string;
};

export type PullCard = {
    kind: 'pr';
    number: number;
    title: string;
    url: string;
    draft: boolean;
    reviewDecision: string | null;
    ci: string | null;
    conflicting: boolean;
    approvedBy: string[];
    changesRequestedBy: string[];
    requested: string[];
    additions: number;
    deletions: number;
    createdAt: string;
    updatedAt: string;
    issues: { number: number; title: string }[];
};

export type Card = IssueCard | PullCard;
export type Column = 'todo' | 'wip' | 'review';

type PullRow = {
    number: number;
    title: string;
    url: string;
    author: string | null;
    is_draft: number;
    review_decision: string | null;
    ci_state: string | null;
    mergeable: string | null;
    additions: number;
    deletions: number;
    review_requests: string;
    reviews: string;
    closing_issues: string;
    created_at: string;
    updated_at: string;
};

/** Project Status → column for issues without an open PR. Done-ish statuses are left out. */
function issueColumn(status: string | null): Column | null {
    if (!status) return 'todo';
    if (/approved|done/i.test(status)) return null;
    if (/qa|review/i.test(status)) return 'review';
    if (/progress/i.test(status)) return 'wip';
    return 'todo'; // To do, Blocked, …
}

const PRIORITY_ORDER = (p: string | null) => (p ? (/high/i.test(p) ? 0 : /medium/i.test(p) ? 1 : /low/i.test(p) ? 2 : 3) : 3);

export function getBoard(db: Database, teamSlug: string) {
    const team = db.query<{ slug: string; name: string }, [string]>('SELECT slug, name FROM teams WHERE slug = ?').get(teamSlug);
    if (!team) return null;
    const logins = db
        .query<{ login: string }, [string]>('SELECT login FROM team_members WHERE team_slug = ? ORDER BY login COLLATE NOCASE')
        .all(teamSlug)
        .map(r => r.login);

    const pulls = db.query<PullRow, []>('SELECT * FROM pull_requests').all();
    const issueTitle = db.query<{ title: string }, [number]>('SELECT title FROM issues WHERE number = ?');
    const projectValue = (field: string) =>
        `(SELECT v.value FROM project_items pi JOIN project_item_values v ON v.item_id = pi.item_id
          WHERE pi.number = i.number AND pi.content_type = 'Issue' AND pi.archived = 0
            AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo') AND v.field = '${field}' LIMIT 1)`;
    const assignedIssues = db.query<
        { number: number; title: string; url: string; updated_at: string; status: string | null; priority: string | null; release: string | null; labels: string },
        [string]
    >(
        `SELECT i.number, i.title, i.url, i.updated_at, ${projectValue('Status')} AS status, ${projectValue('Priority')} AS priority,
                ${projectValue('Release')} AS release,
                (SELECT json_group_array(label) FROM issue_labels WHERE issue_number = i.number) AS labels
         FROM issues i JOIN issue_assignees a ON a.issue_number = i.number
         WHERE i.state = 'OPEN' AND a.login = ?`,
    );

    const toPullCard = (p: PullRow): PullCard => {
        const reviews = JSON.parse(p.reviews) as { author: string | null; state: string }[];
        const issues = (JSON.parse(p.closing_issues) as number[]).map(n => ({ number: n, title: issueTitle.get(n)?.title ?? '' }));
        return {
            kind: 'pr',
            number: p.number,
            title: p.title,
            url: p.url,
            draft: !!p.is_draft,
            reviewDecision: p.review_decision,
            ci: p.ci_state,
            conflicting: p.mergeable === 'CONFLICTING',
            approvedBy: reviews.filter(r => r.state === 'APPROVED').map(r => r.author ?? 'ghost'),
            changesRequestedBy: reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author ?? 'ghost'),
            requested: JSON.parse(p.review_requests),
            additions: p.additions,
            deletions: p.deletions,
            createdAt: p.created_at,
            updatedAt: p.updated_at,
            issues,
        };
    };

    const members = logins.map(login => {
        const columns: Record<Column, Card[]> = { todo: [], wip: [], review: [] };
        const own = pulls.filter(p => p.author === login).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        const coveredIssues = new Set(own.flatMap(p => JSON.parse(p.closing_issues) as number[]));
        for (const p of own) columns[p.is_draft ? 'wip' : 'review'].push(toPullCard(p));

        const issues = assignedIssues
            .all(login)
            .filter(i => !coveredIssues.has(i.number))
            .sort((a, b) => PRIORITY_ORDER(a.priority) - PRIORITY_ORDER(b.priority) || b.updated_at.localeCompare(a.updated_at));
        for (const i of issues) {
            const column = issueColumn(i.status);
            if (!column) continue;
            columns[column].push({
                kind: 'issue',
                number: i.number,
                title: i.title,
                url: i.url,
                status: i.status,
                priority: i.priority,
                release: i.release,
                labels: JSON.parse(i.labels),
                updatedAt: i.updated_at,
            });
        }

        // Ready-for-review PRs by others that wait on this person.
        const reviewing = pulls
            .filter(p => !p.is_draft && p.author !== login && (JSON.parse(p.review_requests) as string[]).includes(login))
            .map(p => ({ number: p.number, title: p.title, url: p.url, author: p.author, updatedAt: p.updated_at }));

        return { login, columns, reviewing };
    });

    const lastSync = db.query<{ value: string }, []>("SELECT value FROM sync_state WHERE key = 'last_sync_at'").get()?.value ?? null;
    return { team, members, lastSyncAt: lastSync };
}
