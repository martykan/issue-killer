import type { Database } from 'bun:sqlite';
import { getState, setState } from './db.ts';
import type { GitHubClient, RateLimit } from './github.ts';
import { syncProject } from './projects.ts';

const RATE_LIMIT = 'rateLimit { remaining resetAt cost }';

const COMMENT_FIELDS = `
    id author { login } authorAssociation body url createdAt updatedAt
    reactions { totalCount }
`;

const REFERENCE_FIELDS = `
    ... on CrossReferencedEvent {
        createdAt willCloseTarget
        source {
            __typename
            ... on PullRequest { number title state url repository { nameWithOwner } }
            ... on Issue { number title state url repository { nameWithOwner } }
        }
    }
`;

const ISSUE_FIELDS = `
    id number title body url state stateReason locked
    createdAt updatedAt closedAt
    author { login } authorAssociation
    issueType { name }
    milestone { title }
    parent { number }
    subIssuesSummary { total completed }
    reactions { totalCount }
    thumbsUp: reactions(content: THUMBS_UP) { totalCount }
    assignees(first: 20) { nodes { login } }
    labels(first: 50) { nodes { name } }
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        nodes { number title state url repository { nameWithOwner } }
    }
    comments(first: 50) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
    }
    timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 25) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REFERENCE_FIELDS} }
    }
`;

const ISSUES_QUERY = `
query($owner: String!, $name: String!, $first: Int!, $after: String, $since: DateTime) {
    repository(owner: $owner, name: $name) {
        issues(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: ASC }, filterBy: { since: $since }) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { ${ISSUE_FIELDS} }
        }
    }
    ${RATE_LIMIT}
}`;

const MORE_COMMENTS_QUERY = `
query($id: ID!, $after: String) {
    node(id: $id) { ... on Issue {
        comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
    } }
    ${RATE_LIMIT}
}`;

const MORE_REFERENCES_QUERY = `
query($id: ID!, $after: String) {
    node(id: $id) { ... on Issue {
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100, after: $after) {
            pageInfo { hasNextPage endCursor } nodes { ${REFERENCE_FIELDS} }
        }
    } }
    ${RATE_LIMIT}
}`;

const LABELS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
        labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { name color description } }
    }
    ${RATE_LIMIT}
}`;

const ORG_MEMBERS_QUERY = `
query($org: String!, $after: String) {
    organization(login: $org) {
        membersWithRole(first: 100, after: $after) { pageInfo { hasNextPage endCursor } edges { role node { login } } }
    }
    ${RATE_LIMIT}
}`;

const TEAMS_QUERY = `
query($org: String!, $after: String) {
    organization(login: $org) {
        teams(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { slug name parentTeam { slug } members(first: 100) { totalCount nodes { login } } }
        }
    }
    ${RATE_LIMIT}
}`;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Connection<T> = { pageInfo: PageInfo; nodes: T[] };
type Actor = { login: string } | null;

type GqlComment = {
    id: string;
    author: Actor;
    authorAssociation: string;
    body: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    reactions: { totalCount: number };
};

type GqlRefSource = {
    __typename: 'PullRequest' | 'Issue';
    number: number;
    title: string;
    state: string;
    url: string;
    repository: { nameWithOwner: string };
};

// `source` is null/empty for references from repos we can't see.
type GqlReference = { createdAt: string; willCloseTarget: boolean; source: GqlRefSource | Record<string, never> | null };

type GqlIssue = {
    id: string;
    number: number;
    title: string;
    body: string;
    url: string;
    state: string;
    stateReason: string | null;
    locked: boolean;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    author: Actor;
    authorAssociation: string;
    issueType: { name: string } | null;
    milestone: { title: string } | null;
    parent: { number: number } | null;
    subIssuesSummary: { total: number; completed: number };
    reactions: { totalCount: number };
    thumbsUp: { totalCount: number };
    assignees: { nodes: { login: string }[] };
    labels: { nodes: { name: string }[] };
    closedByPullRequestsReferences: { nodes: Omit<GqlRefSource, '__typename'>[] };
    comments: Connection<GqlComment> & { totalCount: number };
    timelineItems: Connection<GqlReference>;
};

export type SyncOptions = {
    owner: string;
    name: string;
    full: boolean;
    pageSize: number;
    /** Org project numbers to sync; remembered in sync_state once given. */
    projects?: number[];
    log?: (msg: string) => void;
};

export type SyncResult = { issues: number; comments: number; removed: number; durationMs: number };

const CURSOR_KEY = 'issues_updated_cursor';
const LAST_SYNC_KEY = 'last_sync_at';

export async function syncRepo(db: Database, gh: GitHubClient, opts: SyncOptions): Promise<SyncResult> {
    const log = opts.log ?? console.log;
    const started = Date.now();
    const runStartedAt = new Date(started).toISOString();
    const repoKey = `${opts.owner}/${opts.name}`;

    const storedRepo = getState(db, 'repo');
    if (storedRepo && storedRepo !== repoKey) {
        throw new Error(`Database belongs to ${storedRepo}, refusing to sync ${repoKey}. Use a different --db.`);
    }
    setState(db, 'repo', repoKey);

    await syncLabels(db, gh, opts);
    await syncOrg(db, gh, opts.owner, log);

    if (opts.projects) setState(db, 'projects', opts.projects.join(','));
    const projects = (getState(db, 'projects') ?? '').split(',').filter(Boolean).map(Number);
    for (const number of projects) {
        try {
            await syncProject(db, gh, opts.owner, number, log);
        } catch (err) {
            // Not fatal: e.g. token without read:project.
            log(`  skipping project ${number}: ${(err as Error).message.slice(0, 160)}`);
        }
    }

    const since = opts.full ? undefined : getState(db, CURSOR_KEY);
    log(since ? `Incremental sync of issues updated since ${since}` : 'Full sync of all issues');

    const persist = makePersister(db);
    let after: string | null = null;
    let total: number | undefined;
    let issuesDone = 0;
    let commentsDone = 0;

    do {
        const data: {
            repository: { issues: Connection<GqlIssue> & { totalCount: number } };
            rateLimit: RateLimit;
        } = await gh.query(ISSUES_QUERY, {
            owner: opts.owner,
            name: opts.name,
            first: opts.pageSize,
            after,
            since: since ?? null,
        });
        const page = data.repository.issues;
        total ??= page.totalCount;

        for (const issue of page.nodes) {
            await fetchRemainingComments(gh, issue);
            await fetchRemainingReferences(gh, issue);
        }

        const syncedAt = new Date().toISOString();
        db.transaction(() => {
            for (const issue of page.nodes) persist(issue, syncedAt);
            // Issues come ordered by updatedAt ASC, so the last one is a safe resume point
            // (an interrupted run, even a full one, continues from here next time).
            const last = page.nodes.at(-1);
            if (last) setState(db, CURSOR_KEY, last.updatedAt);
        })();

        issuesDone += page.nodes.length;
        commentsDone += page.nodes.reduce((n, i) => n + i.comments.nodes.length, 0);
        log(`  ${issuesDone}/${total} issues (rate limit remaining: ${data.rateLimit.remaining})`);

        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);

    let removed = 0;
    if (opts.full) {
        // Anything not touched by a complete full sync was deleted or transferred on GitHub.
        removed = db.query('DELETE FROM issues WHERE synced_at < ?').run(runStartedAt).changes;
        if (removed) log(`  removed ${removed} issues no longer present on GitHub`);
    }
    setState(db, LAST_SYNC_KEY, runStartedAt);

    return { issues: issuesDone, comments: commentsDone, removed, durationMs: Date.now() - started };
}

async function syncLabels(db: Database, gh: GitHubClient, opts: SyncOptions) {
    type Label = { name: string; color: string; description: string | null };
    const labels: Label[] = [];
    let after: string | null = null;
    do {
        const data: { repository: { labels: Connection<Label> } } = await gh.query(LABELS_QUERY, {
            owner: opts.owner,
            name: opts.name,
            after,
        });
        labels.push(...data.repository.labels.nodes);
        const { pageInfo } = data.repository.labels;
        after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);

    db.transaction(() => {
        db.exec('DELETE FROM labels');
        const insert = db.query('INSERT INTO labels (name, color, description) VALUES (?, ?, ?)');
        for (const l of labels) insert.run(l.name, l.color, l.description);
    })();
}

async function syncOrg(db: Database, gh: GitHubClient, org: string, log: (msg: string) => void) {
    type Team = { slug: string; name: string; parentTeam: { slug: string } | null; members: { totalCount: number; nodes: { login: string }[] } };
    const members: { role: string; login: string }[] = [];
    const teams: Team[] = [];
    try {
        let after: string | null = null;
        do {
            const data: {
                organization: { membersWithRole: { pageInfo: PageInfo; edges: { role: string; node: { login: string } }[] } };
            } = await gh.query(ORG_MEMBERS_QUERY, { org, after });
            const conn = data.organization.membersWithRole;
            members.push(...conn.edges.map(e => ({ role: e.role, login: e.node.login })));
            after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
        } while (after);
        do {
            const data: { organization: { teams: Connection<Team> } } = await gh.query(TEAMS_QUERY, { org, after });
            teams.push(...data.organization.teams.nodes);
            const { pageInfo } = data.organization.teams;
            after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
        } while (after);
    } catch (err) {
        // Not fatal: everything else works, member-based signals just stay empty.
        log(`  skipping org membership sync (${(err as Error).message.slice(0, 120)}); needs a token with read:org`);
        return;
    }
    if (!members.length) {
        log('  org membership not visible to this token, skipping');
        return;
    }
    for (const t of teams) {
        if (t.members.totalCount > t.members.nodes.length) log(`  warning: team ${t.slug} truncated to ${t.members.nodes.length} members`);
    }

    db.transaction(() => {
        db.exec('DELETE FROM org_members; DELETE FROM team_members; DELETE FROM teams;');
        const insertMember = db.query('INSERT INTO org_members (login, role) VALUES (?, ?)');
        for (const m of members) insertMember.run(m.login, m.role);
        const insertTeam = db.query('INSERT INTO teams (slug, name, parent_slug) VALUES (?, ?, ?)');
        const insertTeamMember = db.query('INSERT INTO team_members (team_slug, login) VALUES (?, ?)');
        for (const t of teams) {
            insertTeam.run(t.slug, t.name, t.parentTeam?.slug ?? null);
            for (const m of t.members.nodes) insertTeamMember.run(t.slug, m.login);
        }
    })();
    log(`  org ${org}: ${members.length} members, ${teams.length} teams`);
}

async function fetchRemainingComments(gh: GitHubClient, issue: GqlIssue) {
    let { pageInfo } = issue.comments;
    while (pageInfo.hasNextPage) {
        const data: { node: { comments: Connection<GqlComment> } } = await gh.query(MORE_COMMENTS_QUERY, {
            id: issue.id,
            after: pageInfo.endCursor,
        });
        issue.comments.nodes.push(...data.node.comments.nodes);
        pageInfo = data.node.comments.pageInfo;
    }
}

async function fetchRemainingReferences(gh: GitHubClient, issue: GqlIssue) {
    let { pageInfo } = issue.timelineItems;
    while (pageInfo.hasNextPage) {
        const data: { node: { timelineItems: Connection<GqlReference> } } = await gh.query(MORE_REFERENCES_QUERY, {
            id: issue.id,
            after: pageInfo.endCursor,
        });
        issue.timelineItems.nodes.push(...data.node.timelineItems.nodes);
        pageInfo = data.node.timelineItems.pageInfo;
    }
}

function makePersister(db: Database) {
    const upsertIssue = db.query(`
        INSERT INTO issues (
            number, node_id, title, body, url, state, state_reason, issue_type, author, author_association,
            milestone, parent_number, sub_issues_total, sub_issues_completed, comments_count, reactions_count,
            thumbs_up_count, locked, created_at, updated_at, closed_at, synced_at
        ) VALUES (
            $number, $node_id, $title, $body, $url, $state, $state_reason, $issue_type, $author, $author_association,
            $milestone, $parent_number, $sub_issues_total, $sub_issues_completed, $comments_count, $reactions_count,
            $thumbs_up_count, $locked, $created_at, $updated_at, $closed_at, $synced_at
        )
        ON CONFLICT(number) DO UPDATE SET
            node_id = excluded.node_id, title = excluded.title, body = excluded.body, url = excluded.url,
            state = excluded.state, state_reason = excluded.state_reason, issue_type = excluded.issue_type,
            author = excluded.author, author_association = excluded.author_association, milestone = excluded.milestone,
            parent_number = excluded.parent_number, sub_issues_total = excluded.sub_issues_total,
            sub_issues_completed = excluded.sub_issues_completed, comments_count = excluded.comments_count,
            reactions_count = excluded.reactions_count, thumbs_up_count = excluded.thumbs_up_count,
            locked = excluded.locked, created_at = excluded.created_at, updated_at = excluded.updated_at,
            closed_at = excluded.closed_at, synced_at = excluded.synced_at
    `);
    const deleteLabels = db.query('DELETE FROM issue_labels WHERE issue_number = ?');
    const insertLabel = db.query('INSERT OR IGNORE INTO issue_labels (issue_number, label) VALUES (?, ?)');
    const deleteAssignees = db.query('DELETE FROM issue_assignees WHERE issue_number = ?');
    const insertAssignee = db.query('INSERT OR IGNORE INTO issue_assignees (issue_number, login) VALUES (?, ?)');
    const deleteComments = db.query('DELETE FROM comments WHERE issue_number = ?');
    const insertComment = db.query(`
        INSERT OR REPLACE INTO comments (node_id, issue_number, author, author_association, body, url, reactions_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteRefs = db.query('DELETE FROM issue_references WHERE issue_number = ?');
    const upsertRef = db.query(`
        INSERT INTO issue_references (issue_number, source_type, source_repo, source_number, source_title, source_state, source_url, will_close, referenced_at)
        VALUES ($issue_number, $source_type, $source_repo, $source_number, $source_title, $source_state, $source_url, $will_close, $referenced_at)
        ON CONFLICT(issue_number, source_repo, source_number) DO UPDATE SET
            will_close = MAX(will_close, excluded.will_close),
            referenced_at = COALESCE(issue_references.referenced_at, excluded.referenced_at)
    `);

    return (issue: GqlIssue, syncedAt: string) => {
        const n = issue.number;
        upsertIssue.run({
            number: n,
            node_id: issue.id,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            state: issue.state,
            state_reason: issue.stateReason,
            issue_type: issue.issueType?.name ?? null,
            author: issue.author?.login ?? null,
            author_association: issue.authorAssociation,
            milestone: issue.milestone?.title ?? null,
            parent_number: issue.parent?.number ?? null,
            sub_issues_total: issue.subIssuesSummary.total,
            sub_issues_completed: issue.subIssuesSummary.completed,
            comments_count: issue.comments.totalCount,
            reactions_count: issue.reactions.totalCount,
            thumbs_up_count: issue.thumbsUp.totalCount,
            locked: issue.locked ? 1 : 0,
            created_at: issue.createdAt,
            updated_at: issue.updatedAt,
            closed_at: issue.closedAt,
            synced_at: syncedAt,
        });

        // Child collections are always fetched in full, so replace them wholesale.
        deleteLabels.run(n);
        for (const l of issue.labels.nodes) insertLabel.run(n, l.name);

        deleteAssignees.run(n);
        for (const a of issue.assignees.nodes) insertAssignee.run(n, a.login);

        deleteComments.run(n);
        for (const c of issue.comments.nodes) {
            insertComment.run(
                c.id,
                n,
                c.author?.login ?? null,
                c.authorAssociation,
                c.body,
                c.url,
                c.reactions.totalCount,
                c.createdAt,
                c.updatedAt,
            );
        }

        deleteRefs.run(n);
        for (const pr of issue.closedByPullRequestsReferences.nodes) {
            upsertRef.run({
                issue_number: n,
                source_type: 'PullRequest',
                source_repo: pr.repository.nameWithOwner,
                source_number: pr.number,
                source_title: pr.title,
                source_state: pr.state,
                source_url: pr.url,
                will_close: 1,
                referenced_at: null,
            });
        }
        for (const ref of issue.timelineItems.nodes) {
            const src = ref.source;
            if (!src || !('number' in src)) continue;
            upsertRef.run({
                issue_number: n,
                source_type: src.__typename,
                source_repo: src.repository.nameWithOwner,
                source_number: src.number,
                source_title: src.title,
                source_state: src.state,
                source_url: src.url,
                will_close: ref.willCloseTarget ? 1 : 0,
                referenced_at: ref.createdAt,
            });
        }
    };
}
