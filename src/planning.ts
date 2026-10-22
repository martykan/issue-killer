import type { Database } from 'bun:sqlite';
import { TEAM_FIELD } from './queries.ts';
import type { ProjectField } from './projects.ts';

// Plan view: a project team's open issues by person × release, with a local draft of pending changes on top.

export const RELEASE_FIELD = 'Release';
export const UNPLANNED = '';

export type PlanCard = {
    number: number;
    title: string;
    url: string;
    itemId: string;
    priority: string | null;
    status: string | null;
    assignees: string[];
    /** Effective values (draft applied) and the values currently on GitHub. */
    release: string;
    assignee: string;
    githubRelease: string;
    githubAssignee: string;
    effort: string | null;
    severity: string | null;
    recommendation: string | null;
    summary: string | null;
};

export type PlanRelease = { title: string; startDate: string; endDate: string; state: 'past' | 'current' | 'upcoming' };

export function projectFields(db: Database, projectNumber: number) {
    const row = db.query<{ node_id: string; fields_json: string }, [number]>('SELECT node_id, fields_json FROM projects WHERE number = ?').get(projectNumber);
    if (!row) return null;
    return { projectId: row.node_id, fields: JSON.parse(row.fields_json) as ProjectField[] };
}

export function defaultProject(db: Database) {
    return db.query<{ n: number | null }, []>('SELECT MIN(number) AS n FROM projects').get()?.n ?? null;
}

export function getReleases(fields: ProjectField[]): PlanRelease[] {
    const field = fields.find(f => f.name === RELEASE_FIELD);
    const today = new Date().toISOString().slice(0, 10);
    return (field?.iterations ?? []).map(i => {
        const end = new Date(new Date(i.startDate).getTime() + i.duration * 86_400_000).toISOString().slice(0, 10);
        const state = i.completed || end <= today ? 'past' : i.startDate <= today ? 'current' : 'upcoming';
        return { title: i.title, startDate: i.startDate, endDate: end, state };
    });
}

export function getPlan(db: Database, projectNumber: number, team: string) {
    const project = projectFields(db, projectNumber);
    if (!project) return null;
    const releases = getReleases(project.fields);
    const value = (field: string) => `(SELECT v.value FROM project_item_values v WHERE v.item_id = pi.item_id AND v.field = '${field}')`;
    const rows = db
        .query<Record<string, string | number | null>, [number, string]>(
            `SELECT i.number, i.title, i.url, pi.item_id, ${value('Priority')} AS priority, ${value('Status')} AS status,
                    ${value(RELEASE_FIELD)} AS release,
                    (SELECT json_group_array(login) FROM issue_assignees WHERE issue_number = i.number) AS assignees,
                    a.effort, a.severity, a.recommendation, a.summary,
                    c.release AS plan_release, c.assignee AS plan_assignee
             FROM issues i
             JOIN project_items pi ON pi.number = i.number AND pi.content_type = 'Issue' AND pi.archived = 0
                  AND pi.project_number = ? AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')
             JOIN project_item_values t ON t.item_id = pi.item_id AND t.field = '${TEAM_FIELD}' AND t.value = ?
             LEFT JOIN issue_analysis a ON a.issue_number = i.number
             LEFT JOIN plan_changes c ON c.issue_number = i.number
             WHERE i.state = 'OPEN'`,
        )
        .all(projectNumber, team);

    const cards: PlanCard[] = rows.map(r => {
        const assignees = JSON.parse(String(r.assignees)) as string[];
        const githubRelease = (r.release as string | null) ?? UNPLANNED;
        const githubAssignee = assignees[0] ?? '';
        return {
            number: Number(r.number),
            title: String(r.title),
            url: String(r.url),
            itemId: String(r.item_id),
            priority: r.priority as string | null,
            status: r.status as string | null,
            assignees,
            release: (r.plan_release as string | null) ?? githubRelease,
            assignee: (r.plan_assignee as string | null) ?? githubAssignee,
            githubRelease,
            githubAssignee,
            effort: r.effort as string | null,
            severity: r.severity as string | null,
            recommendation: r.recommendation as string | null,
            summary: r.summary as string | null,
        };
    });

    const suggestion = db
        .query<{ result_json: string; model: string; cost_usd: number | null; generated_at: string }, [string]>(
            'SELECT result_json, model, cost_usd, generated_at FROM plan_suggestions WHERE team = ? ORDER BY id DESC LIMIT 1',
        )
        .get(team);

    const teamField = project.fields.find(f => f.name === TEAM_FIELD);
    return {
        project: projectNumber,
        team,
        teams: teamField?.options ?? [],
        releases,
        cards,
        pendingChanges: cards.filter(c => c.release !== c.githubRelease || c.assignee !== c.githubAssignee).length,
        suggestion: suggestion
            ? { ...JSON.parse(suggestion.result_json), model: suggestion.model, costUsd: suggestion.cost_usd, generatedAt: suggestion.generated_at }
            : null,
    };
}

/** Records a draft change; a value equal to what's on GitHub drops that part of the change. */
export function setPlanChange(db: Database, number: number, change: { release?: string; assignee?: string }) {
    const current = db
        .query<{ release: string | null; assignee: string | null }, [number]>('SELECT release, assignee FROM plan_changes WHERE issue_number = ?')
        .get(number);
    const gh = db
        .query<{ release: string | null; assignee: string | null }, [number, number]>(
            `SELECT (SELECT v.value FROM project_items pi JOIN project_item_values v ON v.item_id = pi.item_id
                     WHERE pi.number = ?1 AND pi.content_type = 'Issue' AND v.field = '${RELEASE_FIELD}' LIMIT 1) AS release,
                    (SELECT json_extract(json_group_array(login), '$[0]') FROM issue_assignees WHERE issue_number = ?2) AS assignee`,
        )
        .get(number, number);
    let release = change.release !== undefined ? change.release : (current?.release ?? null);
    let assignee = change.assignee !== undefined ? change.assignee : (current?.assignee ?? null);
    if (release !== null && release === (gh?.release ?? '')) release = null;
    if (assignee !== null && assignee === (gh?.assignee ?? '')) assignee = null;
    if (release === null && assignee === null) db.query('DELETE FROM plan_changes WHERE issue_number = ?').run(number);
    else
        db.query(
            `INSERT INTO plan_changes (issue_number, release, assignee, changed_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(issue_number) DO UPDATE SET release = excluded.release, assignee = excluded.assignee, changed_at = excluded.changed_at`,
        ).run(number, release, assignee, new Date().toISOString());
}

export function discardPlanChanges(db: Database, numbers?: number[]) {
    if (!numbers) db.exec('DELETE FROM plan_changes');
    else for (const n of numbers) db.query('DELETE FROM plan_changes WHERE issue_number = ?').run(n);
}
