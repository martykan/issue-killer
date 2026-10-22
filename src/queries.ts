import type { Database } from 'bun:sqlite';
import { ENUMS, promptVersion } from './analysis/prompt.ts';

// Project items belonging to issue `i` (issues of the synced repo only; numbers can collide across repos).
const PROJECT_ITEM_SQL = `SELECT pi.item_id FROM project_items pi WHERE pi.number = i.number AND pi.content_type = 'Issue'
    AND pi.archived = 0 AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')`;

/** Project field holding team ownership. */
export const TEAM_FIELD = 'Team';

/**
 * Claude's owner_team → keyword that appears in the matching project Team option (e.g. "Connect devs 🔌").
 * Owner teams without a project counterpart (desktop, mobile, security, firmware, unknown) never count as a mismatch.
 */
export const OWNER_TEAM_KEYWORDS: Record<string, string> = {
    'suite-connect': 'connect',
    'suite-wallet': 'wallet',
    'suite-trading': 'trade',
    'suite-growth': 'growth',
    'suite-earn': 'earn',
    'suite-networks': 'network',
    devops: 'devops',
    qa: 'qa',
};
const OWNER_KEYWORD_SQL = `CASE a.owner_team ${Object.entries(OWNER_TEAM_KEYWORDS)
    .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
    .join(' ')} END`;
const PROJECT_TEAM_SQL = `(SELECT v.value FROM project_item_values v WHERE v.item_id IN (${PROJECT_ITEM_SQL}) AND v.field = '${TEAM_FIELD}' LIMIT 1)`;

// Triage signals, computed on the fly from synced data. Each is a boolean SQL expression over `i` (issues).
// `weak` signals are common enough that they're only offered as filters, not shown as badges.
export const SIGNALS = {
    fixed_by_pr: {
        label: 'Closing PR merged',
        description: 'Open, but a PR linked as closing it was merged',
        sql: `i.state = 'OPEN' AND EXISTS (SELECT 1 FROM issue_references r WHERE r.issue_number = i.number
              AND r.source_type = 'PullRequest' AND r.will_close = 1 AND r.source_state = 'MERGED')`,
    },
    merged_pr_ref: {
        label: 'Merged PR mention',
        description: 'Open, and mentioned by at least one merged PR',
        sql: `i.state = 'OPEN' AND EXISTS (SELECT 1 FROM issue_references r WHERE r.issue_number = i.number
              AND r.source_type = 'PullRequest' AND r.source_state = 'MERGED')`,
    },
    stale: {
        label: 'Stale >1y',
        description: 'Open, no activity for over a year',
        sql: `i.state = 'OPEN' AND i.updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-365 days')`,
    },
    awaiting_team: {
        label: 'Awaiting team',
        description: 'Open, and the last word (issue or latest comment) is from an outside contributor',
        sql: `i.state = 'OPEN' AND COALESCE(
                (SELECT c.author FROM comments c WHERE c.issue_number = i.number ORDER BY c.created_at DESC LIMIT 1),
                i.author) IN (SELECT login FROM temp.people WHERE status = 'external')`,
    },
    reporter_left: {
        label: 'Reporter left',
        description: 'Open, reported by a former team member (nobody may be following up)',
        sql: `i.state = 'OPEN' AND i.author IN (SELECT login FROM temp.people WHERE status = 'former')`,
    },
    assignee_left: {
        label: 'No active assignee',
        description: 'Open, assigned, but none of the assignees is a current org member',
        sql: `i.state = 'OPEN' AND EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_number = i.number)
              AND NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_number = i.number
                              AND a.login IN (SELECT login FROM temp.people WHERE status = 'member'))`,
    },
    no_team: {
        label: 'No project team',
        description: `Open, in a project but its ${TEAM_FIELD} field is not set`,
        sql: `i.state = 'OPEN' AND EXISTS (${PROJECT_ITEM_SQL}) AND ${PROJECT_TEAM_SQL} IS NULL`,
    },
    team_mismatch: {
        label: 'Claude: other team',
        description: `Open, and Claude's suggested owner team differs from the project ${TEAM_FIELD}`,
        sql: `i.state = 'OPEN' AND EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number
              AND ${OWNER_KEYWORD_SQL} IS NOT NULL AND ${PROJECT_TEAM_SQL} IS NOT NULL
              AND lower(${PROJECT_TEAM_SQL}) NOT LIKE '%' || ${OWNER_KEYWORD_SQL} || '%')`,
    },
    unlabeled: {
        weak: true,
        label: 'No labels',
        description: 'Open, without any label',
        sql: `i.state = 'OPEN' AND NOT EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_number = i.number)`,
    },
    unassigned: {
        weak: true,
        label: 'Unassigned',
        description: 'Open, nobody assigned',
        sql: `i.state = 'OPEN' AND NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_number = i.number)`,
    },
    untyped: {
        weak: true,
        label: 'No type',
        description: 'Open, issue type (Bug/Feature/Task) not set',
        sql: `i.state = 'OPEN' AND i.issue_type IS NULL`,
    },
} as const satisfies Record<string, { label: string; description: string; sql: string; weak?: boolean }>;

export type SignalKey = keyof typeof SIGNALS;
const SIGNAL_KEYS = Object.keys(SIGNALS) as SignalKey[];

const SORTS: Record<string, string> = {
    updated: 'i.updated_at DESC',
    updated_asc: 'i.updated_at ASC',
    created: 'i.created_at DESC',
    created_asc: 'i.created_at ASC',
    comments: 'i.comments_count DESC, i.updated_at DESC',
    reactions: 'i.reactions_count DESC, i.updated_at DESC',
    severity: `(SELECT CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
                FROM issue_analysis a WHERE a.issue_number = i.number) ASC NULLS LAST, i.updated_at DESC`,
};

// Analysis filters: query param -> issue_analysis column (multiple values = any of).
const ANALYSIS_FILTERS: Record<string, string> = {
    rec: 'recommendation',
    owner: 'owner_team',
    rel: 'team_relevance',
    kind: 'kind',
    severity: 'severity',
    confidence: 'confidence',
};

const OUTDATED_SQL = 'a.prompt_version != ? OR a.issue_updated_at < i.updated_at';

export const NO_VALUE = '__none';

const PAGE_SIZE = 50;

/**
 * Classifies everyone seen in the data as member | former | bot | external.
 * GitHub only exposes *current* org membership (synced into org_members), so people who left look like
 * outside contributors. Anyone non-member with 30+ issues/comments is assumed to be former staff.
 */
export function prepareTempTables(db: Database) {
    db.exec(`
        DROP TABLE IF EXISTS temp.people;
        CREATE TEMP TABLE people (login TEXT PRIMARY KEY, status TEXT NOT NULL, activity INTEGER NOT NULL);
        WITH activity AS (
            SELECT author, author_association FROM comments
            UNION ALL SELECT author, author_association FROM issues
        ),
        stats AS (
            SELECT author AS login, COUNT(*) AS n,
                   MAX(author_association IN ('MEMBER', 'OWNER', 'COLLABORATOR')) AS assoc
            FROM activity WHERE author IS NOT NULL GROUP BY author
        )
        INSERT INTO temp.people
        SELECT login,
               CASE
                   WHEN assoc OR login IN (SELECT login FROM main.org_members) THEN 'member'
                   WHEN login LIKE '%bot' OR login LIKE '%[bot]'
                        OR login IN ('sentry', 'Copilot', 'github-actions', 'coderabbitai', 'dependabot') THEN 'bot'
                   WHEN n >= 30 THEN 'former'
                   ELSE 'external'
               END,
               n
        FROM stats;
        INSERT OR IGNORE INTO temp.people SELECT login, 'member', 0 FROM main.org_members;
    `);
}

type Filter = { where: string; args: (string | number)[] };

export function buildFilter(p: URLSearchParams, { skipLabels = false } = {}): Filter {
    const where: string[] = [];
    const args: (string | number)[] = [];

    const state = p.get('state') ?? 'open';
    if (state === 'open' || state === 'closed') {
        where.push('i.state = ?');
        args.push(state.toUpperCase());
    }

    const q = p.get('q')?.trim();
    if (q) {
        const num = q.match(/^#?(\d+)$/);
        if (num) {
            where.push('i.number = ?');
            args.push(Number(num[1]));
        } else {
            const inComments = p.get('in') === 'all';
            for (const token of q.split(/\s+/)) {
                const like = `%${token}%`;
                where.push(
                    inComments
                        ? `(i.title LIKE ? OR i.body LIKE ? OR EXISTS (SELECT 1 FROM comments c WHERE c.issue_number = i.number AND c.body LIKE ?))`
                        : '(i.title LIKE ? OR i.body LIKE ?)',
                );
                args.push(like, like, ...(inComments ? [like] : []));
            }
        }
    }

    const labels = p.getAll('label');
    if (labels.length && !skipLabels) {
        // Any of the selected labels.
        where.push(
            `EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_number = i.number AND l.label IN (${labels.map(() => '?').join(',')}))`,
        );
        args.push(...labels);
    }
    for (const label of p.getAll('nolabel')) {
        where.push('NOT EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_number = i.number AND l.label = ?)');
        args.push(label);
    }

    const type = p.get('type');
    if (type === 'none') where.push('i.issue_type IS NULL');
    else if (type) {
        where.push('i.issue_type = ?');
        args.push(type);
    }

    const assignee = p.get('assignee');
    if (assignee) {
        where.push('EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_number = i.number AND a.login = ?)');
        args.push(assignee);
    }

    const team = p.get('team');
    if (team) {
        const inTeam = 'SELECT login FROM team_members WHERE team_slug = ?';
        const assigned = `EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_number = i.number AND a.login IN (${inTeam}))`;
        const reported = `i.author IN (${inTeam})`;
        const role = p.get('team_role');
        if (role === 'assignee') where.push(assigned);
        else if (role === 'author') where.push(reported);
        else {
            where.push(`(${assigned} OR ${reported})`);
            args.push(team);
        }
        args.push(team);
    }

    const author = p.get('author');
    if (author) {
        where.push('i.author = ?');
        args.push(author);
    }

    for (const s of p.getAll('signal')) {
        if (s in SIGNALS) where.push(`(${SIGNALS[s as SignalKey].sql})`);
    }

    const ai = p.get('ai');
    if (ai === 'none') where.push('NOT EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number)');
    else if (ai === 'done') where.push('EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number)');
    else if (ai === 'outdated') {
        where.push(`EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number AND (${OUTDATED_SQL}))`);
        args.push(promptVersion());
    }
    // Project fields: pf=Field=Value, repeatable. Values of the same field are OR'd, different fields AND'd.
    const projectFilters = new Map<string, string[]>();
    for (const pf of p.getAll('pf')) {
        const eq = pf.indexOf('=');
        if (eq <= 0) continue;
        const field = pf.slice(0, eq);
        projectFilters.set(field, [...(projectFilters.get(field) ?? []), pf.slice(eq + 1)]);
    }
    for (const [field, vals] of projectFilters) {
        const values = vals.filter(v => v !== NO_VALUE);
        const parts: string[] = [];
        if (values.length) {
            parts.push(
                `EXISTS (SELECT 1 FROM project_item_values v WHERE v.item_id IN (${PROJECT_ITEM_SQL}) AND v.field = ? AND v.value IN (${values.map(() => '?').join(',')}))`,
            );
            args.push(field, ...values);
        }
        if (vals.includes(NO_VALUE)) {
            parts.push(`NOT EXISTS (SELECT 1 FROM project_item_values v WHERE v.item_id IN (${PROJECT_ITEM_SQL}) AND v.field = ?)`);
            args.push(field);
        }
        where.push(`(${parts.join(' OR ')})`);
    }

    // Close candidates: triage recommends closing or the agent proposes it.
    if (p.get('cand') === 'close') {
        where.push(`(EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number AND a.recommendation LIKE 'close_%')
            OR EXISTS (SELECT 1 FROM issue_investigations v WHERE v.issue_number = i.number AND v.proposed_action LIKE 'close_%'))`);
    }

    // Topic from the Topics view (topic or subtopic id).
    for (const topic of p.getAll('topic')) {
        where.push('EXISTS (SELECT 1 FROM topic_issues ti WHERE ti.issue_number = i.number AND ti.topic_id = ?)');
        args.push(Number(topic));
    }

    const inv = p.get('inv');
    if (inv === 'none') where.push('NOT EXISTS (SELECT 1 FROM issue_investigations v WHERE v.issue_number = i.number)');
    else if (inv === 'done') where.push('EXISTS (SELECT 1 FROM issue_investigations v WHERE v.issue_number = i.number)');
    else if (inv === 'close') {
        where.push(`EXISTS (SELECT 1 FROM issue_investigations v WHERE v.issue_number = i.number AND v.proposed_action LIKE 'close_%')`);
    }
    for (const [param, column] of Object.entries(ANALYSIS_FILTERS)) {
        const values = p.getAll(param);
        if (!values.length) continue;
        where.push(
            `EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number AND a.${column} IN (${values.map(() => '?').join(',')}))`,
        );
        args.push(...values);
    }

    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const signalColumns = SIGNAL_KEYS.map(k => `(${SIGNALS[k].sql}) AS sig_${k}`).join(',\n');

function pickSignals(row: Record<string, unknown>): SignalKey[] {
    return SIGNAL_KEYS.filter(k => row[`sig_${k}`]);
}

export function listIssues(db: Database, p: URLSearchParams) {
    const { where, args } = buildFilter(p);
    const sort = SORTS[p.get('sort') ?? 'updated'] ?? SORTS.updated;
    const page = Math.max(1, Number(p.get('page')) || 1);

    const total = db.query<{ n: number }, typeof args>(`SELECT COUNT(*) n FROM issues i ${where}`).get(...args)?.n ?? 0;

    const rows = db
        .query<Record<string, unknown>, typeof args>(
            `SELECT i.number, i.title, i.state, i.state_reason, i.issue_type, i.author, i.comments_count,
                    i.reactions_count, i.created_at, i.updated_at, i.closed_at,
                    (SELECT json_group_array(label) FROM issue_labels WHERE issue_number = i.number) AS labels,
                    (SELECT json_group_array(login) FROM issue_assignees WHERE issue_number = i.number) AS assignees,
                    (SELECT json_object('summary', a.summary, 'recommendation', a.recommendation, 'confidence', a.confidence,
                            'ownerTeam', a.owner_team, 'teamRelevance', a.team_relevance, 'severity', a.severity)
                     FROM issue_analysis a WHERE a.issue_number = i.number) AS analysis,
                    (SELECT json_object('verdict', v.verdict, 'confidence', v.confidence, 'proposedAction', v.proposed_action)
                     FROM issue_investigations v WHERE v.issue_number = i.number) AS investigation,
                    (SELECT json_group_object(v.field, v.value) FROM project_item_values v WHERE v.item_id IN (${PROJECT_ITEM_SQL})) AS project,
                    ${signalColumns}
             FROM issues i ${where}
             ORDER BY ${sort}
             LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        )
        .all(...args);

    // Label facet counts ignore the label filter itself so you can see what else you could pick.
    const facet = buildFilter(p, { skipLabels: true });
    const labelCounts = db
        .query<{ label: string; n: number }, typeof args>(
            `SELECT l.label, COUNT(*) n FROM issue_labels l JOIN issues i ON i.number = l.issue_number
             ${facet.where} GROUP BY l.label ORDER BY n DESC`,
        )
        .all(...facet.args);

    return {
        total,
        page,
        pageSize: PAGE_SIZE,
        labelCounts,
        items: rows.map(r => ({
            number: r.number,
            title: r.title,
            state: r.state,
            stateReason: r.state_reason,
            issueType: r.issue_type,
            author: r.author,
            commentsCount: r.comments_count,
            reactionsCount: r.reactions_count,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            closedAt: r.closed_at,
            labels: JSON.parse(r.labels as string),
            assignees: JSON.parse(r.assignees as string),
            signals: pickSignals(r),
            analysis: r.analysis ? JSON.parse(r.analysis as string) : null,
            investigation: r.investigation ? JSON.parse(r.investigation as string) : null,
            project: JSON.parse((r.project as string | null) ?? '{}'),
        })),
    };
}

export function getIssue(db: Database, number: number) {
    const row = db
        .query<Record<string, unknown>, [number]>(`SELECT i.*, ${signalColumns} FROM issues i WHERE i.number = ?`)
        .get(number);
    if (!row) return null;

    const labels = db
        .query<{ name: string; color: string | null }, [number]>(
            `SELECT il.label AS name, l.color FROM issue_labels il LEFT JOIN labels l ON l.name = il.label
             WHERE il.issue_number = ? ORDER BY il.label`,
        )
        .all(number);
    const assignees = db
        .query(
            `SELECT a.login, p.status FROM issue_assignees a LEFT JOIN temp.people p ON p.login = a.login
             WHERE a.issue_number = ?`,
        )
        .all(number);
    const authorStatus =
        db.query<{ status: string }, [string]>('SELECT status FROM temp.people WHERE login = ?').get(String(row.author))
            ?.status ?? null;
    const comments = db
        .query(
            `SELECT node_id AS id, author, author_association AS authorAssociation, body, url,
                    reactions_count AS reactionsCount, created_at AS createdAt, updated_at AS updatedAt,
                    (SELECT status FROM temp.people p WHERE p.login = comments.author) AS authorStatus
             FROM comments WHERE issue_number = ? ORDER BY created_at`,
        )
        .all(number);
    const references = db
        .query(
            `SELECT source_type AS type, source_repo AS repo, source_number AS number, source_title AS title,
                    source_state AS state, source_url AS url, will_close AS willClose, referenced_at AS referencedAt
             FROM issue_references WHERE issue_number = ? ORDER BY will_close DESC, referenced_at DESC`,
        )
        .all(number);
    const children = db
        .query('SELECT number, title, state FROM issues WHERE parent_number = ? ORDER BY number')
        .all(number);
    const parent = row.parent_number
        ? db.query('SELECT number, title, state FROM issues WHERE number = ?').get(row.parent_number as number)
        : null;
    const analysis = getAnalysis(db, number);
    const investigation = getInvestigation(db, number);
    const project = db
        .query<{ title: string; url: string; fields: string }, [number]>(
            `SELECT p.title, p.url, (SELECT json_group_object(v.field, v.value) FROM project_item_values v WHERE v.item_id = pi.item_id) AS fields
             FROM project_items pi JOIN projects p ON p.number = pi.project_number
             WHERE pi.number = ? AND pi.content_type = 'Issue' AND pi.archived = 0
               AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')`,
        )
        .all(number)
        .map(r => ({ title: r.title, url: r.url, fields: JSON.parse(r.fields) as Record<string, string> }));
    const actions = db
        .query(
            `SELECT action, state_reason AS stateReason, duplicate_of AS duplicateOf, comment, comment_url AS commentUrl,
                    performed_by AS performedBy, performed_at AS performedAt
             FROM issue_actions WHERE issue_number = ? ORDER BY id DESC`,
        )
        .all(number);

    return {
        number: row.number,
        title: row.title,
        body: row.body,
        url: row.url,
        state: row.state,
        stateReason: row.state_reason,
        issueType: row.issue_type,
        author: row.author,
        authorAssociation: row.author_association,
        authorStatus,
        milestone: row.milestone,
        commentsCount: row.comments_count,
        reactionsCount: row.reactions_count,
        thumbsUpCount: row.thumbs_up_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at,
        syncedAt: row.synced_at,
        signals: pickSignals(row),
        labels,
        assignees,
        comments,
        references,
        parent,
        children,
        analysis,
        investigation,
        actions,
        projects: project,
    };
}

export function getInvestigation(db: Database, number: number) {
    const v = db
        .query<Record<string, unknown>, [number]>(
            `SELECT v.*, v.issue_updated_at < i.updated_at AS outdated FROM issue_investigations v
             JOIN issues i ON i.number = v.issue_number WHERE v.issue_number = ?`,
        )
        .get(number);
    if (!v) return null;
    return {
        ...JSON.parse(v.result_json as string),
        model: v.model,
        repoSha: v.repo_sha,
        sessionId: v.session_id,
        costUsd: v.cost_usd,
        durationMs: v.duration_ms,
        numTurns: v.num_turns,
        investigatedAt: v.investigated_at,
        outdated: !!v.outdated,
    };
}

export function getAnalysis(db: Database, number: number) {
    const a = db
        .query<Record<string, unknown>, [string, number]>(
            `SELECT a.*, (${OUTDATED_SQL}) AS outdated FROM issue_analysis a JOIN issues i ON i.number = a.issue_number
             WHERE a.issue_number = ?`,
        )
        .get(promptVersion(), number);
    if (!a) return null;
    return {
        ...JSON.parse(a.result_json as string),
        model: a.model,
        promptVersion: a.prompt_version,
        costUsd: a.cost_usd,
        durationMs: a.duration_ms,
        analyzedAt: a.analyzed_at,
        outdated: !!a.outdated,
    };
}

export function getMeta(db: Database) {
    const one = <T>(sql: string) => db.query<T, []>(sql).get() as T;
    const signalCounts = Object.fromEntries(
        SIGNAL_KEYS.map(k => [k, one<{ n: number }>(`SELECT COUNT(*) n FROM issues i WHERE ${SIGNALS[k].sql}`).n]),
    );
    return {
        repo: one<{ value: string } | null>("SELECT value FROM sync_state WHERE key = 'repo'")?.value ?? null,
        lastSyncAt: one<{ value: string } | null>("SELECT value FROM sync_state WHERE key = 'last_sync_at'")?.value ?? null,
        totals: one<{ open: number; closed: number }>(
            "SELECT SUM(state = 'OPEN') AS open, SUM(state = 'CLOSED') AS closed FROM issues",
        ),
        signals: SIGNAL_KEYS.map(k => ({
            key: k,
            label: SIGNALS[k].label,
            description: SIGNALS[k].description,
            weak: 'weak' in SIGNALS[k],
            count: signalCounts[k],
        })),
        labels: db.query('SELECT name, color, description FROM labels ORDER BY name COLLATE NOCASE').all(),
        teams: db
            .query(
                `SELECT t.slug, t.name, COUNT(tm.login) AS members FROM teams t
                 LEFT JOIN team_members tm ON tm.team_slug = t.slug GROUP BY t.slug ORDER BY t.slug`,
            )
            .all(),
        hasOrgData: (one<{ n: number }>('SELECT COUNT(*) n FROM org_members').n ?? 0) > 0,
        analysis: getAnalysisStats(db),
        projects: getProjectStats(db),
        investigations: db
            .query<{ total: number; proposedClose: number; cost: number | null }, []>(
                `SELECT COUNT(*) AS total, SUM(v.proposed_action LIKE 'close_%') AS proposedClose, SUM(v.cost_usd) AS cost
                 FROM issue_investigations v JOIN issues i ON i.number = v.issue_number WHERE i.state = 'OPEN'`,
            )
            .get(),
        types: db
            .query<{ t: string }, []>('SELECT DISTINCT issue_type AS t FROM issues WHERE issue_type IS NOT NULL ORDER BY 1')
            .all()
            .map(r => r.t),
        assignees: db
            .query<{ login: string }, []>(
                `SELECT a.login FROM issue_assignees a JOIN issues i ON i.number = a.issue_number
                 WHERE i.state = 'OPEN' GROUP BY a.login ORDER BY COUNT(*) DESC`,
            )
            .all()
            .map(r => r.login),
    };
}

function getAnalysisStats(db: Database) {
    const version = promptVersion();
    const totals = db
        .query<{ analyzed: number; outdated: number; cost: number | null }, [string]>(
            `SELECT COUNT(*) AS analyzed, SUM(${OUTDATED_SQL}) AS outdated, SUM(a.cost_usd) AS cost
             FROM issue_analysis a JOIN issues i ON i.number = a.issue_number WHERE i.state = 'OPEN'`,
        )
        .get(version);
    // Open-issue counts per value of each filterable column.
    const counts = Object.fromEntries(
        Object.entries(ANALYSIS_FILTERS).map(([param, column]) => [
            param,
            Object.fromEntries(
                db
                    .query<{ v: string; n: number }, []>(
                        `SELECT a.${column} AS v, COUNT(*) AS n FROM issue_analysis a JOIN issues i ON i.number = a.issue_number
                         WHERE i.state = 'OPEN' GROUP BY 1`,
                    )
                    .all()
                    .map(r => [r.v, r.n]),
            ),
        ]),
    );
    return {
        promptVersion: version,
        enums: ENUMS,
        analyzedOpen: totals?.analyzed ?? 0,
        outdatedOpen: totals?.outdated ?? 0,
        totalCostUsd: totals?.cost ?? 0,
        counts,
    };
}

/** Synced projects with their filterable fields and open-issue counts per value. */
function getProjectStats(db: Database) {
    const projects = db
        .query<{ number: number; title: string; url: string; fields_json: string }, []>('SELECT * FROM projects ORDER BY number')
        .all();
    return projects.map(p => {
        const fields = (JSON.parse(p.fields_json) as { name: string; type: string; options: string[] | null }[]).filter(f =>
            ['SINGLE_SELECT', 'ITERATION'].includes(f.type),
        );
        const counts = db
            .query<{ field: string; value: string; n: number }, [number]>(
                `SELECT v.field, v.value, COUNT(*) AS n FROM project_item_values v
                 JOIN project_items pi ON pi.item_id = v.item_id
                 JOIN issues i ON i.number = pi.number AND i.state = 'OPEN'
                 WHERE pi.project_number = ? AND pi.content_type = 'Issue' AND pi.archived = 0
                   AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')
                 GROUP BY 1, 2`,
            )
            .all(p.number);
        return {
            number: p.number,
            title: p.title,
            url: p.url,
            fields: fields.map(f => {
                const values = counts.filter(c => c.field === f.name);
                // Iteration options aren't listed by the API; use the values seen on items instead.
                const options = f.options ?? [...new Set(values.map(v => v.value))].sort();
                return { name: f.name, options: options.map(o => ({ value: o, count: values.find(v => v.value === o)?.n ?? 0 })) };
            }),
        };
    });
}
