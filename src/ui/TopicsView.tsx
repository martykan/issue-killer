import { useEffect, useMemo, useRef, useState } from 'react';
import type { UpdateParams } from './App.tsx';
import { confirmDialog } from './confirm.tsx';
import type { Meta } from './types.ts';
import { runJob, timeAgo, useFetch } from './util.tsx';

type TopicIssue = { number: number; title: string; priority: string | null; recommendation: string | null; stale: boolean; closeCandidate: boolean };
type TopicNode = {
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
type TopicMap = { scope: string; issueCount: number; model: string; costUsd: number | null; generatedAt: string; topics: TopicNode[] };

// Mind-map geometry (px).
const ROW = 48;
const TOPIC_GAP = 22;
const ROOT_W = 170;
const TOPIC_W = 240;
const SUB_W = 250;
const X_TOPIC = 260; // root center → topic center
const X_SUB = 580; // root center → subtopic center
const MARGIN = 24;
// Categorical slots 1–8 (validated palette, fixed order); topics beyond 8 fall back to neutral.
const SLOTS = 8;

type Placed = { node: TopicNode; x: number; y: number; side: -1 | 1; slot: number; parent?: Placed };

function layout(topics: TopicNode[]) {
    const rows = (t: TopicNode) => Math.max(1, t.children.length);
    const sides: { items: TopicNode[]; rows: number }[] = [
        { items: [], rows: 0 },
        { items: [], rows: 0 },
    ];
    // Biggest topics first, each to the side with fewer rows → balanced map.
    for (const t of topics) {
        const side = sides[0]!.rows <= sides[1]!.rows ? sides[0]! : sides[1]!;
        side.items.push(t);
        side.rows += rows(t);
    }
    const sideHeight = (s: { items: TopicNode[]; rows: number }) => s.rows * ROW + Math.max(0, s.items.length - 1) * TOPIC_GAP;
    const height = Math.max(sideHeight(sides[0]!), sideHeight(sides[1]!), ROW) + 2 * MARGIN;
    const width = 2 * (X_SUB + SUB_W / 2) + 2 * MARGIN;
    const cx = width / 2;
    const placed: Placed[] = [];
    sides.forEach((s, si) => {
        const dir = si === 0 ? 1 : -1;
        let y = (height - sideHeight(s)) / 2;
        for (const t of s.items) {
            const block = rows(t) * ROW;
            const slot = topics.indexOf(t);
            const topic: Placed = { node: t, x: cx + dir * X_TOPIC, y: y + block / 2, side: dir as 1 | -1, slot };
            placed.push(topic);
            t.children.forEach((c, j) => placed.push({ node: c, x: cx + dir * X_SUB, y: y + ROW * (j + 0.5), side: dir as 1 | -1, slot, parent: topic }));
            y += block + TOPIC_GAP;
        }
    });
    return { width, height, cx, cy: height / 2, placed };
}

const slotVar = (slot: number) => (slot < SLOTS ? `var(--cat-${slot + 1})` : 'var(--muted)');

export function TopicsView({ meta, params, update, reloadKey }: { meta: Meta | null; params: URLSearchParams; update: UpdateParams; reloadKey: number }) {
    const scopeParam = params.get('scope');
    const [localKey, setLocalKey] = useState(0);
    const { data, error } = useFetch<{ scope: string; map: TopicMap | null }>(
        `/api/topics${scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : ''}`,
        `${reloadKey}-${localKey}`,
    );
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [mode, setMode] = useState<'map' | 'outline'>('map');
    const [generating, setGenerating] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);

    const scope = data?.scope ?? scopeParam ?? 'all';
    const map = data?.map ?? null;
    const projectTeams = meta?.projects.flatMap(p => p.fields.find(f => f.name === 'Team')?.options ?? []) ?? [];
    const scopeSize = scope === 'all' ? (meta?.totals.open ?? 0) : (projectTeams.find(t => `team:${t.value}` === scope)?.count ?? 0);

    const generate = async () => {
        const est = Math.max(0.05, scopeSize * 0.0004).toFixed(2);
        if (map && !(await confirmDialog(`Regenerate the topic map for ${scopeSize} issues? (~$${est}, up to a few minutes)`, { confirmLabel: 'Regenerate' })))
            return;
        setGenerating(true);
        setGenError(null);
        try {
            await runJob(`/api/topics/generate?scope=${encodeURIComponent(scope)}`);
            setSelectedId(null);
            setLocalKey(k => k + 1);
        } catch (err) {
            setGenError(String((err as Error).message ?? err));
        } finally {
            setGenerating(false);
        }
    };

    const geometry = useMemo(() => (map ? layout(map.topics) : null), [map]);
    // Scale the map down to fit the canvas width (never up).
    const canvasRef = useRef<HTMLDivElement>(null);
    const [canvasWidth, setCanvasWidth] = useState(0);
    useEffect(() => {
        const el = canvasRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setCanvasWidth(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
    }, [geometry]);
    const scale = geometry && canvasWidth ? Math.min(1, (canvasWidth - 8) / geometry.width) : 1;
    const selected = useMemo(() => {
        if (!map || selectedId === null) return null;
        for (const t of map.topics) {
            if (t.id === selectedId) return { node: t, parent: null as TopicNode | null, slot: map.topics.indexOf(t) };
            const c = t.children.find(c => c.id === selectedId);
            if (c) return { node: c, parent: t, slot: map.topics.indexOf(t) };
        }
        return null;
    }, [map, selectedId]);

    const openIssue = (n: number) =>
        update(
            p => {
                p.delete('view');
                p.set('issue', String(n));
            },
            { push: true },
        );
    const openInIssues = (topicId: number) =>
        update(
            p => {
                for (const k of [...p.keys()]) p.delete(k);
                p.set('topic', String(topicId));
            },
            { push: true },
        );

    return (
        <div className="topics-view">
            <header className="board-head topics-head">
                <div>
                    <h2>Topics</h2>
                    <div className="muted small">
                        {map
                            ? `${map.topics.length} topics · ${map.issueCount} issues · ${map.model} · ${timeAgo(map.generatedAt)}${map.costUsd != null ? ` · $${map.costUsd.toFixed(2)}` : ''}`
                            : 'Claude groups open issues into topics and flags likely duplicates.'}
                    </div>
                </div>
                <span className="grow" />
                {map && (
                    <div className="segmented small">
                        <button className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}>
                            Map
                        </button>
                        <button className={mode === 'outline' ? 'active' : ''} onClick={() => setMode('outline')}>
                            Outline
                        </button>
                    </div>
                )}
                <button className="small-button" onClick={generate} disabled={generating}>
                    {generating ? (
                        <>
                            <span className="spinner" /> Generating…
                        </>
                    ) : map ? (
                        '✨ Regenerate'
                    ) : (
                        '✨ Generate topics'
                    )}
                </button>
                <select value={scope} onChange={e => update(p => p.set('scope', e.target.value), { keepPage: true })} title="Which open issues to organize">
                    <option value="all">All open issues ({meta?.totals.open ?? '…'})</option>
                    {projectTeams.map(t => (
                        <option key={t.value} value={`team:${t.value}`}>
                            {t.value} ({t.count})
                        </option>
                    ))}
                </select>
            </header>
            {error && <div className="error">{error}</div>}
            {genError && <div className="error">Generating failed: {genError}</div>}
            {data && !map && !generating && (
                <div className="topics-empty muted">
                    No topic map for this scope yet. <b>✨ Generate topics</b> sends the {scopeSize} issue titles, labels and triage summaries to Claude
                    (one call, ~${Math.max(0.05, scopeSize * 0.0004).toFixed(2)}).
                </div>
            )}

            {map && geometry && (
                <div className="topics-body">
                    <div className="topics-canvas" ref={canvasRef}>
                        {mode === 'map' ? (
                            <div className="mindmap-fit" style={{ width: geometry.width * scale, height: geometry.height * scale }}>
                            <div className="mindmap" style={{ width: geometry.width, height: geometry.height, transform: `scale(${scale})` }}>
                                <svg width={geometry.width} height={geometry.height} className="mindmap-links" aria-hidden>
                                    {geometry.placed.map(p => {
                                        const from = p.parent ?? { x: geometry.cx, y: geometry.cy, side: p.side };
                                        const fromW = p.parent ? TOPIC_W : ROOT_W;
                                        const toW = p.parent ? SUB_W : TOPIC_W;
                                        const x1 = from.x + (p.side * fromW) / 2;
                                        const x2 = p.x - (p.side * toW) / 2;
                                        const mid = (x1 + x2) / 2;
                                        return (
                                            <path
                                                key={p.node.id}
                                                d={`M${x1},${from.y} C${mid},${from.y} ${mid},${p.y} ${x2},${p.y}`}
                                                stroke={slotVar(p.slot)}
                                                strokeOpacity={selected && selected.slot !== p.slot ? 0.2 : 0.55}
                                                strokeWidth={p.parent ? 1.5 : 2}
                                                fill="none"
                                            />
                                        );
                                    })}
                                </svg>
                                <div className="mm-node mm-root" style={{ left: geometry.cx - ROOT_W / 2, top: geometry.cy - 22, width: ROOT_W }}>
                                    <div className="mm-name">{scope === 'all' ? 'All open issues' : scope.slice(5)}</div>
                                    <div className="mm-stats">{map.topics.reduce((n, t) => n + t.count, 0)} issues</div>
                                </div>
                                {geometry.placed.map(p => {
                                    const isTopic = !p.parent;
                                    const w = isTopic ? TOPIC_W : SUB_W;
                                    const active = selectedId === p.node.id;
                                    const dimmed = selected !== null && selected.slot !== p.slot;
                                    return (
                                        <button
                                            key={p.node.id}
                                            className={`mm-node ${isTopic ? 'mm-topic' : 'mm-sub'}${active ? ' active' : ''}${dimmed ? ' dimmed' : ''}`}
                                            style={{ left: p.x - w / 2, top: p.y - (isTopic ? 20 : 16), width: w, ['--topic' as string]: slotVar(p.slot) }}
                                            onClick={() => setSelectedId(active ? null : p.node.id)}
                                            title={p.node.description}
                                        >
                                            <span className="mm-name">{p.node.name}</span>
                                            <span className="mm-count">{p.node.count}</span>
                                            <NodeFlags node={p.node} />
                                        </button>
                                    );
                                })}
                            </div>
                            </div>
                        ) : (
                            <Outline topics={map.topics} selectedId={selectedId} onSelect={setSelectedId} />
                        )}
                    </div>
                    <aside className="topics-panel">
                        {selected ? (
                            <TopicPanel node={selected.node} parent={selected.parent} slot={selected.slot} openIssue={openIssue} openInIssues={openInIssues} />
                        ) : (
                            <div className="muted small topics-hint">
                                <p>Select a topic or subtopic to see its issues and likely duplicates.</p>
                                <p>
                                    Badges: <span className="flag flag-high">HIGH</span> high-priority issues, <span className="flag flag-close">close?</span> issues
                                    triage or the agent suggest closing, <span className="flag flag-dup">dup</span> groups of likely duplicates.
                                </p>
                            </div>
                        )}
                    </aside>
                </div>
            )}
        </div>
    );
}

function NodeFlags({ node }: { node: TopicNode }) {
    const dupes = node.children.length ? node.children.reduce((n, c) => n + c.duplicateGroups.length, 0) : node.duplicateGroups.length;
    if (!node.high && !node.closeCandidates && !dupes) return null;
    return (
        <span className="mm-flags">
            {node.high > 0 && <span className="flag flag-high">{node.high} HIGH</span>}
            {node.closeCandidates > 0 && <span className="flag flag-close">{node.closeCandidates} close?</span>}
            {dupes > 0 && <span className="flag flag-dup">{dupes} dup</span>}
        </span>
    );
}

function Outline({ topics, selectedId, onSelect }: { topics: TopicNode[]; selectedId: number | null; onSelect: (id: number) => void }) {
    return (
        <ul className="outline">
            {topics.map((t, i) => (
                <li key={t.id}>
                    <button className={`outline-topic${selectedId === t.id ? ' active' : ''}`} onClick={() => onSelect(t.id)} style={{ ['--topic' as string]: slotVar(i) }}>
                        <span className="swatch" style={{ background: slotVar(i) }} /> {t.name} <span className="muted">{t.count}</span> <NodeFlags node={t} />
                    </button>
                    <ul>
                        {t.children.map(c => (
                            <li key={c.id}>
                                <button className={`outline-sub${selectedId === c.id ? ' active' : ''}`} onClick={() => onSelect(c.id)} title={c.description}>
                                    {c.name} <span className="muted">{c.count}</span> <NodeFlags node={c} />
                                </button>
                            </li>
                        ))}
                    </ul>
                </li>
            ))}
        </ul>
    );
}

function TopicPanel({
    node,
    parent,
    slot,
    openIssue,
    openInIssues,
}: {
    node: TopicNode;
    parent: TopicNode | null;
    slot: number;
    openIssue: (n: number) => void;
    openInIssues: (id: number) => void;
}) {
    const byNumber = new Map(node.issues.map(i => [i.number, i]));
    const groups = node.children.length ? node.children.flatMap(c => c.duplicateGroups) : node.duplicateGroups;
    return (
        <div className="topic-panel" style={{ ['--topic' as string]: slotVar(slot) }}>
            {parent && <div className="muted small">{parent.name} ›</div>}
            <h3>{node.name}</h3>
            <p className="muted">{node.description}</p>
            <div className="row topic-panel-actions">
                <span className="muted small">
                    {node.count} issues · {node.high} HIGH · {node.stale} stale · {node.closeCandidates} close candidates
                </span>
                <span className="grow" />
                <button className="small-button" onClick={() => openInIssues(node.id)} title="Open these issues in the Issues view (filters, analyze, investigate)">
                    Open in Issues →
                </button>
            </div>

            {groups.length > 0 && (
                <>
                    <h4>Likely duplicates</h4>
                    {groups.map((g, i) => (
                        <div key={i} className="dup-group">
                            {g.map(n => (
                                <button key={n} className="link issue-line" onClick={() => openIssue(n)}>
                                    #{n} {byNumber.get(n)?.title ?? ''}
                                </button>
                            ))}
                        </div>
                    ))}
                </>
            )}

            <h4>Issues</h4>
            <ul className="topic-issues">
                {node.issues.map(i => (
                    <li key={i.number}>
                        <button className="link issue-line" onClick={() => openIssue(i.number)}>
                            #{i.number} {i.title}
                        </button>
                        <span className="topic-issue-flags">
                            {i.priority && /high/i.test(i.priority) && <span className="flag flag-high">HIGH</span>}
                            {i.closeCandidate && <span className="flag flag-close">close?</span>}
                            {i.stale && <span className="flag">stale</span>}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
