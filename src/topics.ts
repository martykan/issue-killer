import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { runClaude } from './claude.ts';
import { promptPath } from './paths.ts';
import { SIGNALS, TEAM_FIELD } from './queries.ts';

// Topics view: Claude clusters a scope's open issues into topics → subtopics (+ likely duplicates).

export const DEFAULT_TOPICS_MODEL = 'sonnet';

type Result = {
    topics: {
        name: string;
        description: string;
        subtopics: { name: string; description: string; issues: number[]; duplicate_groups: number[][] }[];
    }[];
};

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['topics'],
    properties: {
        topics: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'description', 'subtopics'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    subtopics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['name', 'description', 'issues', 'duplicate_groups'],
                            properties: {
                                name: { type: 'string' },
                                description: { type: 'string' },
                                issues: { type: 'array', items: { type: 'integer' } },
                                duplicate_groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
                            },
                        },
                    },
                },
            },
        },
    },
};

/** "team:<value>" → issues whose project Team is <value>; "all" → every open issue. */
function scopeIssues(db: Database, scope: string) {
    const team = scope.startsWith('team:') ? scope.slice(5) : null;
    return db
        .query<{ number: number; title: string; labels: string; summary: string | null; area: string | null }, string[]>(
            `SELECT i.number, i.title,
                    (SELECT group_concat(label, ', ') FROM issue_labels WHERE issue_number = i.number) AS labels,
                    a.summary, a.area
             FROM issues i LEFT JOIN issue_analysis a ON a.issue_number = i.number
             WHERE i.state = 'OPEN'
               ${team ? `AND EXISTS (SELECT 1 FROM project_items pi JOIN project_item_values v ON v.item_id = pi.item_id
                         WHERE pi.number = i.number AND pi.content_type = 'Issue' AND pi.archived = 0
                           AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')
                           AND v.field = '${TEAM_FIELD}' AND v.value = ?)` : ''}
             ORDER BY i.number`,
        )
        .all(...(team ? [team] : []));
}

export async function generateTopicMap(db: Database, scope: string, model = DEFAULT_TOPICS_MODEL) {
    const issues = scopeIssues(db, scope);
    if (issues.length < 5) throw new Error(`Only ${issues.length} open issues in this scope – nothing to organize`);
    const input = issues
        .map(i => `#${i.number} ${i.title}${i.labels ? ` [${i.labels}]` : ''}${i.area ? ` (area: ${i.area})` : ''}${i.summary ? ` — ${i.summary.slice(0, 160)}` : ''}`)
        .join('\n');
    const run = await runClaude<Result>({
        systemPrompt: readFileSync(promptPath('topics.md'), 'utf8'),
        prompt: `${issues.length} open issues:\n\n${input}`,
        schema: SCHEMA,
        model,
        timeoutMs: 10 * 60_000,
    });

    // Keep the model honest: only known issues, each once; anything left out goes to "Unsorted".
    const known = new Set(issues.map(i => i.number));
    const seen = new Set<number>();
    for (const t of run.result.topics) {
        for (const s of t.subtopics) {
            s.issues = s.issues.filter(n => known.has(n) && !seen.has(n) && (seen.add(n), true));
            s.duplicate_groups = s.duplicate_groups.map(g => [...new Set(g)].filter(n => s.issues.includes(n))).filter(g => g.length > 1);
        }
        t.subtopics = t.subtopics.filter(s => s.issues.length);
    }
    run.result.topics = run.result.topics.filter(t => t.subtopics.length);
    const leftover = issues.map(i => i.number).filter(n => !seen.has(n));
    if (leftover.length) {
        run.result.topics.push({
            name: 'Unsorted',
            description: 'Issues the model did not place.',
            subtopics: [{ name: 'Unsorted', description: 'Not assigned to a topic.', issues: leftover, duplicate_groups: [] }],
        });
    }

    return db.transaction(() => {
        db.query('DELETE FROM topic_maps WHERE scope = ?').run(scope);
        const mapId = Number(
            db
                .query('INSERT INTO topic_maps (scope, issue_count, model, cost_usd, generated_at) VALUES (?, ?, ?, ?, ?)')
                .run(scope, issues.length, run.model, run.costUsd, new Date().toISOString()).lastInsertRowid,
        );
        const insertTopic = db.query(
            'INSERT INTO topics (map_id, parent_id, name, description, position, duplicate_groups) VALUES (?, ?, ?, ?, ?, ?)',
        );
        const insertIssue = db.query('INSERT OR IGNORE INTO topic_issues (topic_id, issue_number) VALUES (?, ?)');
        run.result.topics.forEach((t, ti) => {
            const topicId = Number(insertTopic.run(mapId, null, t.name, t.description, ti, '[]').lastInsertRowid);
            t.subtopics.forEach((s, si) => {
                const subId = Number(insertTopic.run(mapId, topicId, s.name, s.description, si, JSON.stringify(s.duplicate_groups)).lastInsertRowid);
                for (const n of s.issues) {
                    insertIssue.run(subId, n);
                    insertIssue.run(topicId, n); // topic level holds the union, for filtering
                }
            });
        });
        return mapId;
    })();
}

export type TopicIssue = { number: number; title: string; priority: string | null; recommendation: string | null; stale: boolean; closeCandidate: boolean };
export type TopicNode = {
    id: number;
    name: string;
    description: string;
    count: number;
    high: number;
    closeCandidates: number;
    stale: number;
    duplicateGroups: number[][];
    issues: TopicIssue[];
    children: TopicNode[];
};

/** Latest map for a scope with live per-node stats (issues may have changed since it was generated). */
export function getTopicMap(db: Database, scope: string) {
    const map = db
        .query<{ id: number; issue_count: number; model: string; cost_usd: number | null; generated_at: string }, [string]>(
            'SELECT * FROM topic_maps WHERE scope = ? ORDER BY id DESC LIMIT 1',
        )
        .get(scope);
    if (!map) return null;

    const issueRows = db
        .query<Record<string, string | number | null>, [number]>(
            `SELECT ti.topic_id, i.number, i.title, i.state,
                    (SELECT v.value FROM project_items pi JOIN project_item_values v ON v.item_id = pi.item_id
                     WHERE pi.number = i.number AND pi.content_type = 'Issue' AND v.field = 'Priority' LIMIT 1) AS priority,
                    a.recommendation, v.proposed_action,
                    (${SIGNALS.stale.sql}) AS stale
             FROM topic_issues ti JOIN topics t ON t.id = ti.topic_id AND t.parent_id IS NOT NULL
             JOIN issues i ON i.number = ti.issue_number
             LEFT JOIN issue_analysis a ON a.issue_number = i.number
             LEFT JOIN issue_investigations v ON v.issue_number = i.number
             WHERE t.map_id = ?`,
        )
        .all(map.id);
    const bySubtopic = new Map<number, TopicIssue[]>();
    for (const r of issueRows) {
        if (r.state !== 'OPEN') continue; // closed since the map was generated
        const list = bySubtopic.get(Number(r.topic_id)) ?? [];
        list.push({
            number: Number(r.number),
            title: String(r.title),
            priority: r.priority as string | null,
            recommendation: r.recommendation as string | null,
            stale: !!r.stale,
            closeCandidate: String(r.recommendation ?? '').startsWith('close_') || String(r.proposed_action ?? '').startsWith('close_'),
        });
        bySubtopic.set(Number(r.topic_id), list);
    }

    const rows = db
        .query<{ id: number; parent_id: number | null; name: string; description: string; duplicate_groups: string }, [number]>(
            'SELECT id, parent_id, name, description, duplicate_groups FROM topics WHERE map_id = ? ORDER BY position',
        )
        .all(map.id);
    const stats = (issues: TopicIssue[]) => ({
        count: issues.length,
        high: issues.filter(i => i.priority && /high/i.test(i.priority)).length,
        closeCandidates: issues.filter(i => i.closeCandidate).length,
        stale: issues.filter(i => i.stale).length,
    });
    const topics: TopicNode[] = rows
        .filter(r => r.parent_id === null)
        .map(t => {
            const children: TopicNode[] = rows
                .filter(s => s.parent_id === t.id)
                .map(s => {
                    const issues = (bySubtopic.get(s.id) ?? []).sort((a, b) => a.number - b.number);
                    return { id: s.id, name: s.name, description: s.description, ...stats(issues), duplicateGroups: JSON.parse(s.duplicate_groups), issues, children: [] };
                })
                .filter(s => s.count > 0);
            const issues = children.flatMap(c => c.issues);
            return { id: t.id, name: t.name, description: t.description, ...stats(issues), duplicateGroups: [], issues, children };
        })
        .filter(t => t.count > 0)
        .sort((a, b) => b.count - a.count);

    return { scope, issueCount: map.issue_count, model: map.model, costUsd: map.cost_usd, generatedAt: map.generated_at, topics };
}
