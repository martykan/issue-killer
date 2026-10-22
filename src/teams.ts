import type { Database } from 'bun:sqlite';
import { OWNER_TEAM_KEYWORDS, SIGNALS, TEAM_FIELD } from './queries.ts';

type IssueRow = {
    number: number;
    team: string | null;
    status: string | null;
    priority: string | null;
    release: string | null;
    assignees: string; // JSON array
    in_project: number;
    stale: number;
    awaiting: number;
    rec: string | null;
    owner: string | null;
    inv_action: string | null;
};

export type TeamSummary = {
    team: string | null; // null = in project without a team
    open: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    unassigned: number;
    stale: number;
    awaitingTeam: number;
    analyzed: number;
    claudeClose: number;
    agentClose: number;
    /** Triage recommends closing OR the agent proposes closing. */
    closeCandidates: number;
    otherTeam: number;
};

export type TeamDetail = {
    assignees: { login: string; open: number; inProgress: number }[];
    releases: { release: string; open: number }[];
    priorityStatus: Record<string, Record<string, number>>;
};

const NONE = '(none)';

const emptySummary = (team: string | null): TeamSummary => ({
    team,
    open: 0,
    byStatus: {},
    byPriority: {},
    unassigned: 0,
    stale: 0,
    awaitingTeam: 0,
    analyzed: 0,
    claudeClose: 0,
    agentClose: 0,
    closeCandidates: 0,
    otherTeam: 0,
});

/** Per-team breakdown of open issues of one project (the team = its Team field). */
export function getTeamsOverview(db: Database, projectNumber: number) {
    const project = db
        .query<{ number: number; title: string; url: string; fields_json: string }, [number]>('SELECT * FROM projects WHERE number = ?')
        .get(projectNumber);
    if (!project) return null;
    const fields = JSON.parse(project.fields_json) as { name: string; options: string[] | null }[];
    const optionsOf = (name: string) => fields.find(f => f.name === name)?.options ?? [];

    const value = (field: string) => `(SELECT v.value FROM project_item_values v WHERE v.item_id = pi.item_id AND v.field = '${field}')`;
    const rows = db
        .query<IssueRow, [number]>(
            `SELECT i.number, ${value(TEAM_FIELD)} AS team, ${value('Status')} AS status, ${value('Priority')} AS priority,
                    ${value('Release')} AS release,
                    (SELECT json_group_array(login) FROM issue_assignees a WHERE a.issue_number = i.number) AS assignees,
                    pi.item_id IS NOT NULL AS in_project,
                    (${SIGNALS.stale.sql}) AS stale, (${SIGNALS.awaiting_team.sql}) AS awaiting,
                    a.recommendation AS rec, a.owner_team AS owner, v.proposed_action AS inv_action
             FROM issues i
             LEFT JOIN project_items pi ON pi.number = i.number AND pi.content_type = 'Issue' AND pi.archived = 0
                  AND pi.project_number = ? AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')
             LEFT JOIN issue_analysis a ON a.issue_number = i.number
             LEFT JOIN issue_investigations v ON v.issue_number = i.number
             WHERE i.state = 'OPEN'`,
        )
        .all(projectNumber);

    const summaries = new Map<string | null, TeamSummary>();
    const details = new Map<string | null, TeamDetail & { _assignees: Map<string, { open: number; inProgress: number }>; _releases: Map<string, number> }>();
    let notInProject = 0;

    for (const r of rows) {
        if (!r.in_project) {
            notInProject++;
            continue;
        }
        const team = r.team;
        let s = summaries.get(team);
        if (!s) {
            s = emptySummary(team);
            summaries.set(team, s);
        }
        let d = details.get(team);
        if (!d) {
            d = { assignees: [], releases: [], priorityStatus: {}, _assignees: new Map(), _releases: new Map() };
            details.set(team, d);
        }
        const status = r.status ?? NONE;
        const priority = r.priority ?? NONE;
        const assignees = JSON.parse(r.assignees) as string[];
        const inProgress = /progress|review/i.test(status);

        s.open++;
        s.byStatus[status] = (s.byStatus[status] ?? 0) + 1;
        s.byPriority[priority] = (s.byPriority[priority] ?? 0) + 1;
        if (!assignees.length) s.unassigned++;
        if (r.stale) s.stale++;
        if (r.awaiting) s.awaitingTeam++;
        if (r.rec) s.analyzed++;
        if (r.rec?.startsWith('close_')) s.claudeClose++;
        if (r.inv_action?.startsWith('close_')) s.agentClose++;
        if (r.rec?.startsWith('close_') || r.inv_action?.startsWith('close_')) s.closeCandidates++;
        const kw = r.owner ? OWNER_TEAM_KEYWORDS[r.owner] : undefined;
        if (kw && team && !team.toLowerCase().includes(kw)) s.otherTeam++;

        for (const login of assignees) {
            const a = d._assignees.get(login) ?? { open: 0, inProgress: 0 };
            a.open++;
            if (inProgress) a.inProgress++;
            d._assignees.set(login, a);
        }
        if (r.release) d._releases.set(r.release, (d._releases.get(r.release) ?? 0) + 1);
        d.priorityStatus[priority] ??= {};
        d.priorityStatus[priority][status] = (d.priorityStatus[priority][status] ?? 0) + 1;
    }

    // Keep the project's own option order for teams; teams without open issues still show up.
    const teamOrder = [...optionsOf(TEAM_FIELD), null];
    const teams = teamOrder
        .filter(t => t === null ? summaries.has(null) : true)
        .map(t => summaries.get(t) ?? emptySummary(t));

    const teamDetails = Object.fromEntries(
        [...details].map(([team, d]) => [
            team ?? '',
            {
                assignees: [...d._assignees].map(([login, a]) => ({ login, ...a })).sort((a, b) => b.open - a.open),
                releases: [...d._releases].map(([release, open]) => ({ release, open })).sort((a, b) => a.release.localeCompare(b.release, undefined, { numeric: true })),
                priorityStatus: d.priorityStatus,
            } satisfies TeamDetail,
        ]),
    );

    return {
        project: { number: project.number, title: project.title, url: project.url },
        teamField: TEAM_FIELD,
        statuses: [...optionsOf('Status'), NONE],
        priorities: [...optionsOf('Priority')].reverse().concat(NONE), // HIGH first
        teams,
        details: teamDetails,
        notInProject,
    };
}
