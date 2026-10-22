import { useMemo, useState } from 'react';
import type { UpdateParams } from './App.tsx';
import { confirmDialog } from './confirm.tsx';
import { saveSettings } from './settings.ts';
import type { Meta } from './types.ts';
import { Markdown, runJob, timeAgo, useFetch } from './util.tsx';

type PlanCard = {
    number: number;
    title: string;
    url: string;
    priority: string | null;
    status: string | null;
    assignees: string[];
    release: string;
    assignee: string;
    githubRelease: string;
    githubAssignee: string;
    effort: string | null;
    severity: string | null;
    recommendation: string | null;
    summary: string | null;
};
type Release = { title: string; startDate: string; endDate: string; state: 'past' | 'current' | 'upcoming' };
type Move = { issue: number; release: string; assignee: string | null; reason: string };
type Plan = {
    team: string;
    teams: string[];
    releases: Release[];
    cards: PlanCard[];
    pendingChanges: number;
    suggestion: { summary: string; releases: { release: string; focus: string }[]; moves: Move[]; model: string; costUsd: number | null; generatedAt: string } | null;
};
type ApplyResult = { applied: number; failed: { number: number; error: string }[] };

const OVERDUE = '__overdue';
const UNPLANNED = '';
const EFFORT: Record<string, { label: string; points: number }> = {
    small: { label: 'S', points: 1 },
    medium: { label: 'M', points: 3 },
    large: { label: 'L', points: 8 },
};
const CELL_CARDS = 8;
const rank = (p: string | null) => (p ? (/high/i.test(p) ? 0 : /medium/i.test(p) ? 1 : 2) : 3);
const fmtDate = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function PlanView({ meta, params, update, reloadKey }: { meta: Meta | null; params: URLSearchParams; update: UpdateParams; reloadKey: number }) {
    const team = params.get('pteam') ?? meta?.settings.myProjectTeam ?? '';
    const [localKey, setLocalKey] = useState(0);
    const refresh = () => setLocalKey(k => k + 1);
    const { data, error } = useFetch<Plan>(`/api/plan?team=${encodeURIComponent(team)}`, `${reloadKey}-${localKey}`);
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const setTeam = (t: string) => {
        void saveSettings({ myProjectTeam: t || null });
        update(p => p.set('pteam', t), { keepPage: true });
    };
    const openIssue = (n: number) =>
        update(
            p => {
                p.delete('view');
                p.set('issue', String(n));
            },
            { push: true },
        );

    const post = async (body: unknown) => {
        await fetch('/api/plan/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        refresh();
    };
    const move = (issue: number, release: string, assignee: string) => post({ issue, release, assignee });
    const discard = async (issues?: number[]) => {
        await fetch('/api/plan/changes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issues }) });
        refresh();
    };
    const job = async (label: string, url: string, after?: (result: unknown) => void) => {
        setBusy(label);
        setMessage(null);
        try {
            const result = await runJob(url);
            after?.(result);
            refresh();
        } catch (err) {
            setMessage(`${label} failed: ${(err as Error).message}`);
        } finally {
            setBusy(null);
        }
    };
    const apply = async () => {
        if (!data) return;
        const ok = await confirmDialog(
            `Apply ${data.pendingChanges} planned change(s) to GitHub? This updates the Release field in the project and issue assignees.`,
            { confirmLabel: 'Apply to GitHub', danger: true },
        );
        if (!ok) return;
        await job('Apply', `/api/plan/apply?team=${encodeURIComponent(data.team)}`, r => {
            const res = r as ApplyResult;
            setMessage(
                `Applied ${res.applied} change(s).` +
                    (res.failed.length ? ` ${res.failed.length} failed: ${res.failed.map(f => `#${f.number} ${f.error}`).join('; ')}` : ''),
            );
        });
    };

    const layout = useMemo(() => {
        if (!data) return null;
        const past = new Set(data.releases.filter(r => r.state === 'past').map(r => r.title));
        const active = data.releases.filter(r => r.state !== 'past');
        const columnOf = (c: PlanCard) => (c.release && past.has(c.release) ? OVERDUE : c.release);
        const columns = [
            ...(data.cards.some(c => columnOf(c) === OVERDUE) ? [{ key: OVERDUE, title: 'Overdue', release: null as Release | null }] : []),
            ...active.map(r => ({ key: r.title, title: r.title, release: r as Release | null })),
            { key: UNPLANNED, title: 'Unplanned', release: null as Release | null },
        ];
        const load = new Map<string, number>();
        for (const c of data.cards) if (c.assignee && columnOf(c) !== UNPLANNED) load.set(c.assignee, (load.get(c.assignee) ?? 0) + 1);
        const people = [...new Set(data.cards.map(c => c.assignee).filter(Boolean))].sort((a, b) => (load.get(b) ?? 0) - (load.get(a) ?? 0) || a.localeCompare(b));
        const cell = (person: string, column: string) =>
            data.cards.filter(c => c.assignee === person && columnOf(c) === column).sort((a, b) => rank(a.priority) - rank(b.priority) || a.number - b.number);
        return { columns, people: [...people, ''], cell, columnOf };
    }, [data]);

    const teams = data?.teams ?? meta?.projects.flatMap(p => p.fields.find(f => f.name === 'Team')?.options.map(o => o.value) ?? []) ?? [];

    return (
        <div className="board plan">
            <header className="board-head">
                <div>
                    <h2>Plan</h2>
                    <div className="muted small">Drag issues between releases and people; changes stay a local draft until you apply them.</div>
                </div>
                <span className="grow" />
                <button
                    className="small-button"
                    disabled={!!busy || !data?.team}
                    onClick={() => job('Suggest', `/api/plan/suggest?team=${encodeURIComponent(data!.team)}`)}
                    title="Claude proposes what to schedule into which release (~30s)"
                >
                    {busy === 'Suggest' ? (
                        <>
                            <span className="spinner" /> Thinking…
                        </>
                    ) : (
                        '✨ Suggest plan'
                    )}
                </button>
                <select value={data?.team ?? team} onChange={e => setTeam(e.target.value)} title="Team field in the project (remembered)">
                    <option value="">Pick a team…</option>
                    {teams.map(t => (
                        <option key={t} value={t}>
                            {t}
                        </option>
                    ))}
                </select>
            </header>
            {error && <div className="error">{error}</div>}
            {message && <div className={message.includes('failed') ? 'error' : 'ok-line'}>{message}</div>}
            {data && !data.team && <p className="muted">Pick a project team to plan.</p>}

            {data && data.pendingChanges > 0 && (
                <div className="pending-bar">
                    <strong>{data.pendingChanges} planned change(s)</strong>
                    <span className="muted small">not on GitHub yet</span>
                    <span className="grow" />
                    <button className="link small" onClick={() => void discard()}>
                        Discard all
                    </button>
                    <button className="danger-button" onClick={apply} disabled={!!busy}>
                        {busy === 'Apply' ? 'Applying…' : 'Apply to GitHub'}
                    </button>
                </div>
            )}

            {data?.suggestion && layout && (
                <Suggestions suggestion={data.suggestion} cards={data.cards} onAccept={moves => post({ accept: moves })} openIssue={openIssue} />
            )}

            {data && layout && data.team && (
                <div className="plan-grid" style={{ gridTemplateColumns: `180px repeat(${layout.columns.length}, minmax(200px, 1fr))` }}>
                    <div className="board-colhead" />
                    {layout.columns.map(col => {
                        const cards = data.cards.filter(c => layout.columnOf(c) === col.key);
                        const points = cards.reduce((n, c) => n + (EFFORT[c.effort ?? '']?.points ?? 0), 0);
                        const unestimated = cards.filter(c => !EFFORT[c.effort ?? '']).length;
                        const high = cards.filter(c => rank(c.priority) === 0).length;
                        return (
                            <div key={col.key} className={`board-colhead plan-colhead${col.release?.state === 'current' ? ' current' : ''}`}>
                                <div>
                                    {col.title} {col.release?.state === 'current' && <span className="current-badge">current</span>}
                                </div>
                                {col.release && (
                                    <div className="muted plan-dates">
                                        {fmtDate(col.release.startDate)} – {fmtDate(col.release.endDate)}
                                    </div>
                                )}
                                <div className="plan-stats" title={`${unestimated} without an effort estimate (analyze issues to estimate)`}>
                                    {cards.length} issues · {points} pts{unestimated ? ` +${unestimated}?` : ''}
                                    {high > 0 && <span className="high"> · {high} HIGH</span>}
                                </div>
                            </div>
                        );
                    })}
                    {layout.people.map(person => (
                        <PlanRow
                            key={person || '(unassigned)'}
                            person={person}
                            columns={layout.columns.map(c => c.key)}
                            cell={layout.cell}
                            onDrop={(issue, column) => column !== OVERDUE && void move(issue, column, person)}
                            onRevert={n => void discard([n])}
                            openIssue={openIssue}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function PlanRow({
    person,
    columns,
    cell,
    onDrop,
    onRevert,
    openIssue,
}: {
    person: string;
    columns: string[];
    cell: (person: string, column: string) => PlanCard[];
    onDrop: (issue: number, column: string) => void;
    onRevert: (issue: number) => void;
    openIssue: (n: number) => void;
}) {
    const planned = columns.filter(c => c !== UNPLANNED && c !== OVERDUE).flatMap(c => cell(person, c));
    const points = planned.reduce((n, c) => n + (EFFORT[c.effort ?? '']?.points ?? 0), 0);
    return (
        <>
            <div className="board-member">
                {person ? (
                    <div className="member-id">
                        <img className="avatar" src={`https://github.com/${person}.png?size=64`} alt="" />
                        <span className="member-login">{person}</span>
                    </div>
                ) : (
                    <span className="member-login muted">Unassigned</span>
                )}
                <div className="muted small">
                    {planned.length} planned · {points} pts
                </div>
            </div>
            {columns.map(column => (
                <PlanCell key={column} cards={cell(person, column)} droppable={column !== OVERDUE} onDrop={n => onDrop(n, column)} onRevert={onRevert} openIssue={openIssue} />
            ))}
        </>
    );
}

function PlanCell({
    cards,
    droppable,
    onDrop,
    onRevert,
    openIssue,
}: {
    cards: PlanCard[];
    droppable: boolean;
    onDrop: (issue: number) => void;
    onRevert: (issue: number) => void;
    openIssue: (n: number) => void;
}) {
    const [over, setOver] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? cards : cards.slice(0, CELL_CARDS);
    return (
        <div
            className={`board-cell plan-cell${over ? ' drop-over' : ''}${droppable ? '' : ' no-drop'}`}
            onDragOver={e => {
                if (!droppable) return;
                e.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={e => {
                setOver(false);
                const n = Number(e.dataTransfer.getData('text/plain'));
                if (droppable && n) onDrop(n);
            }}
        >
            {shown.map(c => (
                <PlanCardView key={c.number} card={c} onRevert={onRevert} openIssue={openIssue} />
            ))}
            {cards.length > CELL_CARDS && (
                <button className="link small" onClick={() => setExpanded(e => !e)}>
                    {expanded ? 'Show less' : `+ ${cards.length - CELL_CARDS} more`}
                </button>
            )}
        </div>
    );
}

function PlanCardView({ card, onRevert, openIssue }: { card: PlanCard; onRevert: (issue: number) => void; openIssue: (n: number) => void }) {
    const releaseChanged = card.release !== card.githubRelease;
    const assigneeChanged = card.assignee !== card.githubAssignee;
    const effort = EFFORT[card.effort ?? ''];
    return (
        <div
            className={`bcard plan-card${releaseChanged || assigneeChanged ? ' changed' : ''}`}
            draggable
            onDragStart={e => {
                e.dataTransfer.setData('text/plain', String(card.number));
                e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => openIssue(card.number)}
            title={card.summary ?? card.title}
        >
            <div className="bcard-title">
                <span className="muted">#{card.number}</span> {card.title}
            </div>
            <div className="bcard-meta">
                {card.priority && <span className="tag">{card.priority}</span>}
                {effort && (
                    <span className="tag" title={`Effort (Claude): ${card.effort}`}>
                        {effort.label}
                    </span>
                )}
                {card.recommendation?.startsWith('close_') && <span className="tag tag-bad">triage: close?</span>}
                {card.status && /blocked/i.test(card.status) && <span className="tag tag-bad">Blocked</span>}
            </div>
            {(releaseChanged || assigneeChanged) && (
                <div className="plan-change">
                    {releaseChanged && <span>was {card.githubRelease || 'unplanned'}</span>}
                    {assigneeChanged && <span>was {card.githubAssignee || 'unassigned'}</span>}
                    <button
                        className="link small"
                        onClick={e => {
                            e.stopPropagation();
                            onRevert(card.number);
                        }}
                    >
                        undo
                    </button>
                </div>
            )}
        </div>
    );
}

function Suggestions({
    suggestion,
    cards,
    onAccept,
    openIssue,
}: {
    suggestion: NonNullable<Plan['suggestion']>;
    cards: PlanCard[];
    onAccept: (moves: Move[]) => void;
    openIssue: (n: number) => void;
}) {
    const [open, setOpen] = useState(true);
    const [allMoves, setAllMoves] = useState(false);
    const byNumber = new Map(cards.map(c => [c.number, c]));
    const done = (m: Move) => {
        const c = byNumber.get(m.issue);
        return !!c && c.release === m.release && (m.assignee === null || c.assignee === m.assignee);
    };
    const pending = suggestion.moves.filter(m => !done(m));
    return (
        <section className="exec-summary plan-suggestions">
            <div className="exec-head">
                <strong className="exec-headline">✨ Suggested plan</strong>
                <span className="muted small">
                    {suggestion.model} · {timeAgo(suggestion.generatedAt)}
                    {suggestion.costUsd != null && ` · $${suggestion.costUsd.toFixed(2)}`}
                </span>
                <span className="grow" />
                {pending.length > 0 && (
                    <button className="small-button" onClick={() => onAccept(pending)}>
                        Accept all {pending.length}
                    </button>
                )}
                <button className="link small" onClick={() => setOpen(o => !o)}>
                    {open ? 'Hide' : 'Show'}
                </button>
            </div>
            {open && (
                <>
                    <Markdown source={suggestion.summary} />
                    <div className="release-focus">
                        {suggestion.releases.map(r => (
                            <div key={r.release}>
                                <strong>{r.release}</strong> <span className="muted">{r.focus}</span>
                            </div>
                        ))}
                    </div>
                    <ul className="moves">
                        {(allMoves ? suggestion.moves : suggestion.moves.slice(0, 8)).map(m => {
                            const c = byNumber.get(m.issue);
                            const accepted = done(m);
                            return (
                                <li key={m.issue} className={accepted ? 'accepted' : ''}>
                                    <button className="link" onClick={() => openIssue(m.issue)}>
                                        #{m.issue}
                                    </button>{' '}
                                    <span className="move-title">{c?.title}</span> →{' '}
                                    <strong>{m.release || 'unplanned'}</strong>
                                    {m.assignee && <> · {m.assignee}</>} <span className="muted">— {m.reason}</span>{' '}
                                    {accepted ? (
                                        <span className="ok-line small">✓ in draft</span>
                                    ) : (
                                        <button className="link small" onClick={() => onAccept([m])}>
                                            accept
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    {suggestion.moves.length > 8 && (
                        <button className="link small" onClick={() => setAllMoves(a => !a)}>
                            {allMoves ? 'Show fewer' : `Show all ${suggestion.moves.length} suggestions`}
                        </button>
                    )}
                </>
            )}
        </section>
    );
}
