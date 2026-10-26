import type { Database } from 'bun:sqlite';
import type { GitHubClient, RateLimit } from './github.ts';

// GitHub Projects (v2) sync. Needs a token with read:project. Projects are small (a few thousand items) and have no
// "updated since" filter, so each sync re-fetches all items of the configured projects.

const FIELD_VALUE = `
    __typename
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldIterationValue { title startDate field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
`;

const PROJECT_QUERY = `
query($org: String!, $number: Int!, $after: String) {
    organization(login: $org) {
        projectV2(number: $number) {
            id title url
            fields(first: 50) {
                nodes {
                    ... on ProjectV2FieldCommon { id name dataType }
                    ... on ProjectV2SingleSelectField { options { id name } }
                    ... on ProjectV2IterationField {
                        configuration {
                            iterations { id title startDate duration }
                            completedIterations { id title startDate duration }
                        }
                    }
                }
            }
            items(first: 100, after: $after) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                    id isArchived
                    content {
                        __typename
                        ... on Issue { number repository { nameWithOwner } }
                        ... on PullRequest { number repository { nameWithOwner } }
                    }
                    fieldValues(first: 30) { nodes { ${FIELD_VALUE} } }
                }
            }
        }
    }
    rateLimit { remaining resetAt cost }
}`;

type FieldValueNode = {
    __typename: string;
    name?: string;
    title?: string;
    text?: string;
    number?: number;
    date?: string;
    field?: { name?: string };
};

type Iteration = { id: string; title: string; startDate: string; duration: number };
type FieldNode = {
    id?: string;
    name?: string;
    dataType?: string;
    options?: { id: string; name: string }[];
    configuration?: { iterations: Iteration[]; completedIterations: Iteration[] };
};

/** Stored in projects.fields_json. Option/iteration ids are needed to write field values back (Plan view). */
export type ProjectField = {
    id: string;
    name: string;
    type: string;
    options: string[] | null;
    optionIds?: Record<string, string>;
    iterations?: (Iteration & { completed: boolean })[];
};

type ItemNode = {
    id: string;
    isArchived: boolean;
    content: { __typename: string; number?: number; repository?: { nameWithOwner: string } } | null;
    fieldValues: { nodes: FieldValueNode[] };
};

type ProjectData = {
    organization: {
        projectV2: {
            id: string;
            title: string;
            url: string;
            fields: { nodes: FieldNode[] };
            items: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ItemNode[] };
        } | null;
    };
    rateLimit: RateLimit;
};

// Only these field types hold values worth filtering on; built-ins (title, assignees, labels…) come from the issue itself.
const VALUE_TYPES = new Set(['SINGLE_SELECT', 'ITERATION', 'TEXT', 'NUMBER', 'DATE']);

function fieldValue(v: FieldValueNode): string | null {
    const value = v.name ?? v.title ?? v.text ?? v.date ?? (v.number !== undefined ? String(v.number) : undefined);
    return value ?? null;
}

export async function syncProject(db: Database, gh: GitHubClient, org: string, number: number, log: (msg: string) => void) {
    const items: ItemNode[] = [];
    let project: NonNullable<ProjectData['organization']['projectV2']> | null = null;
    let after: string | null = null;
    do {
        const data: ProjectData = await gh.query(PROJECT_QUERY, { org, number, after });
        const p = data.organization.projectV2;
        if (!p) throw new Error(`Project ${org}/${number} not found`);
        project ??= p;
        items.push(...p.items.nodes);
        after = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
    } while (after);
    if (!project) return;

    const fields = project.fields.nodes.filter(f => f.name && f.dataType && VALUE_TYPES.has(f.dataType));

    db.transaction(() => {
        db.query(
            `INSERT INTO projects (number, node_id, title, url, fields_json, synced_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(number) DO UPDATE SET node_id = excluded.node_id, title = excluded.title, url = excluded.url,
                 fields_json = excluded.fields_json, synced_at = excluded.synced_at`,
        ).run(
            number,
            project.id,
            project.title,
            project.url,
            JSON.stringify(
                fields.map(
                    (f): ProjectField => ({
                        id: f.id!,
                        name: f.name!,
                        type: f.dataType!,
                        options: f.options?.map(o => o.name) ?? null,
                        ...(f.options ? { optionIds: Object.fromEntries(f.options.map(o => [o.name, o.id])) } : {}),
                        ...(f.configuration
                            ? {
                                  iterations: [
                                      ...f.configuration.completedIterations.map(i => ({ ...i, completed: true })),
                                      ...f.configuration.iterations.map(i => ({ ...i, completed: false })),
                                  ].sort((a, b) => a.startDate.localeCompare(b.startDate)),
                              }
                            : {}),
                    }),
                ),
            ),
            new Date().toISOString(),
        );
        db.query('DELETE FROM project_items WHERE project_number = ?').run(number);
        const insertItem = db.query(
            `INSERT INTO project_items (item_id, project_number, content_type, repo, number, archived) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const insertValue = db.query('INSERT OR REPLACE INTO project_item_values (item_id, field, value) VALUES (?, ?, ?)');
        for (const item of items) {
            insertItem.run(
                item.id,
                number,
                item.content?.__typename ?? 'DraftIssue',
                item.content?.repository?.nameWithOwner ?? null,
                item.content?.number ?? null,
                item.isArchived ? 1 : 0,
            );
            for (const v of item.fieldValues.nodes) {
                const field = v.field?.name;
                const value = fieldValue(v);
                if (field && value !== null && fields.some(f => f.name === field)) insertValue.run(item.id, field, value);
            }
        }
    })();
    log(`  project ${project.title} (#${number}): ${items.length} items`);
}

export type ProjectChoice = { number: number; title: string };

const PROJECT_LIST_QUERY = `
query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { projectsV2(first: 50) { nodes { number title closed items { totalCount } } } }
}`;

type ProjectListData = {
    repository: { projectsV2: { nodes: { number: number; title: string; closed: boolean; items: { totalCount: number } }[] } } | null;
};

/** Open projects linked to the repo for the setup wizard, biggest first. */
export async function listProjects(gh: GitHubClient, owner: string, name: string): Promise<ProjectChoice[]> {
    const data: ProjectListData = await gh.query(PROJECT_LIST_QUERY, { owner, name });
    return (data.repository?.projectsV2.nodes ?? [])
        .filter(p => !p.closed)
        .sort((a, b) => b.items.totalCount - a.items.totalCount)
        .map(p => ({ number: p.number, title: p.title }));
}
