import { useMemo, useState } from 'react';
import type { UpdateParams } from './App.tsx';
import { NO_VALUE } from './ProjectFilters.tsx';
import { rememberedTeam } from './TeamSwitcher.tsx';
import { useFetch } from './util.tsx';

type TeamSummary = {
    team: string | null;
    open: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    unassigned: number;
    stale: number;
    awaitingTeam: number;
    analyzed: number;
    claudeClose: number;
    agentClose: number;
    closeCandidates: number;
    otherTeam: number;
};

type TeamDetail = {
    assignees: { login: string; open: number; inProgress: number }[];
    releases: { release: string; open: number }[];
    priorityStatus: Record<string, Record<string, number>>;
};

type Overview = {
    project: { number: number; title: string; url: string };
    teamField: string;
    statuses: string[];
    priorities: string[];
    teams: TeamSummary[];
    details: Record<string, TeamDetail>;
    notInProject: number;
};

type Filter = [string, string];

const NONE = '(none)';

// Project statuses grouped into a few workflow stages, in a fixed order (= fixed categorical slots, see styles.css).
const STAGES = [
    { key: 'todo', label: 'To do', match: (s: string) => /to ?do/i.test(s) },
    { key: 'progress', label: 'In progress', match: (s: string) => !/qa/i.test(s) && /progress|review/i.test(s) },
    { key: 'qa', label: 'QA', match: (s: string) => /qa/i.test(s) },
    { key: 'blocked', label: 'Blocked', match: (s: string) => /blocked/i.test(s) },
    { key: 'none', label: 'No status', match: (s: string) => s === NONE },
] as const;
const DONE = (s: string) => /approved|done/i.test(s);

const statusFilter = (s: string): Filter => ['pf', `Status=${s === NONE ? NO_VALUE : s}`];

function stagesOf(t: TeamSummary, statuses: string[]) {
    return STAGES.map(stage => {
        const members = statuses.filter(s => !DONE(s) && stage.match(s));
        return { ...stage, statuses: members, count: members.reduce((n, s) => n + (t.byStatus[s] ?? 0), 0) };
    });
}

const share = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);

export function TeamsDashboard({ params, update, reloadKey }: { params: URLSearchParams; update: UpdateParams; reloadKey: number }) {
    const { data, error, loading } = useFetch<Overview>('/api/teams', reloadKey);
    const [numbers, setNumbers] = useState(false);
    const myTeam = rememberedTeam();

    const go = (filters: Filter[]) =>
        update(
            p => {
                for (const k of [...p.keys()]) p.delete(k);
                for (const [k, v] of filters) p.append(k, v);
            },
            { push: true },
        );

    const teams = useMemo(() => {
        if (!data) return [];
        const withIssues = data.teams.filter(t => t.open > 0);
        // Biggest first; "no team" last since it's a triage bucket, not a team.
        return withIssues.sort((a, b) => (a.team === null ? 1 : b.team === null ? -1 : b.open - a.open));
    }, [data]);

    if (error) return <div className="dashboard error">{error}</div>;
    if (!data) return <div className="dashboard muted">{loading ? 'Loading…' : ''}</div>;

    const keyOf = (t: TeamSummary) => t.team ?? NO_VALUE;
    const selectedKey = params.get('tview') ?? (myTeam && teams.some(t => t.team === myTeam) ? myTeam : null);
    const selected = teams.find(t => keyOf(t) === selectedKey);
    const selectTeam = (key: string) => update(p => p.set('tview', key), { keepPage: true });

    const field = data.teamField;
    const teamFilter = (t: TeamSummary): Filter => ['pf', `${field}=${t.team ?? NO_VALUE}`];
    const high = data.priorities[0]!;
    const maxOpen = Math.max(1, ...teams.map(t => t.open));
    const totalOpen = teams.reduce((n, t) => n + t.open, 0);
    const anyAnalyzed = teams.some(t => t.analyzed > 0);
    const hiddenTeams = data.teams.filter(t => t.open === 0).length;
    const visibleStatuses = data.statuses.filter(s => !DONE(s));

    const Count = ({ value, of, filters, title }: { value: number; of?: number; filters: Filter[]; title: string }) =>
        value ? (
            <button className="count-link" onClick={() => go(filters)} title={`${title}: ${value}${of ? ` of ${of}` : ''} – click to list`}>
                {value}
                {of !== undefined && <span className="share">{share(value, of)}%</span>}
            </button>
        ) : (
            <span className="zero">–</span>
        );

    return (
        <div className="dashboard">
            <header className="dashboard-head">
                <div>
                    <h2>Teams</h2>
                    <div className="muted small">
                        {totalOpen} open issues in{' '}
                        <a href={data.project.url} target="_blank" rel="noreferrer">
                            {data.project.title}
                        </a>{' '}
                        by {field.toLowerCase()}
                        {data.notInProject > 0 && ` · ${data.notInProject} not in the project`}
                        {hiddenTeams > 0 && ` · ${hiddenTeams} teams without open issues hidden`}
                    </div>
                </div>
                <div className="segmented small">
                    <button className={numbers ? '' : 'active'} onClick={() => setNumbers(false)}>
                        Bars
                    </button>
                    <button className={numbers ? 'active' : ''} onClick={() => setNumbers(true)} title="Exact counts per status">
                        Numbers
                    </button>
                </div>
            </header>

            {!numbers && (
                <div className="legend">
                    {STAGES.map(s => (
                        <span key={s.key}>
                            <span className={`swatch stage-${s.key}`} /> {s.label}
                        </span>
                    ))}
                </div>
            )}

            <table className="teams-table">
                <thead>
                    <tr>
                        <th className="left">{field}</th>
                        <th className="left open-col">Open</th>
                        {numbers ? (
                            visibleStatuses.map(s => <th key={s}>{s === NONE ? 'No status' : s}</th>)
                        ) : (
                            <th className="left status-col">Status</th>
                        )}
                        <th title="Nobody assigned">Unassigned</th>
                        <th title="Priority not set in the project">No priority</th>
                        <th>{high}</th>
                        <th title="No activity for over a year">Stale</th>
                        <th title="Last word is from an outside contributor">Awaiting reply</th>
                        {anyAnalyzed && <th title="Claude triage or the agent suggests closing">Close?</th>}
                        {anyAnalyzed && <th title={`Claude thinks another team owns it than the project ${field.toLowerCase()}`}>Other team?</th>}
                    </tr>
                </thead>
                <tbody>
                    {teams.map(t => {
                        const tf = teamFilter(t);
                        const stages = stagesOf(t, data.statuses);
                        const active = stages.reduce((n, s) => n + s.count, 0);
                        return (
                            <tr key={keyOf(t)} className={`${selected === t ? 'selected' : ''}${t.team === null ? ' no-team' : ''}`} onClick={() => selectTeam(keyOf(t))}>
                                <th className="left team-name">
                                    {t.team ?? `No ${field.toLowerCase()}`}
                                    {myTeam && t.team === myTeam && <span className="mine">your team</span>}
                                </th>
                                <td className="open-col">
                                    <button className="count-link open-count" onClick={e => (e.stopPropagation(), go([tf]))} title={`${t.open} open – click to list`}>
                                        <span className="open-bar" style={{ width: `${(100 * t.open) / maxOpen}%` }} />
                                        <span>{t.open}</span>
                                    </button>
                                </td>
                                {numbers ? (
                                    visibleStatuses.map(s => (
                                        <td key={s} onClick={e => e.stopPropagation()}>
                                            <Count value={t.byStatus[s] ?? 0} filters={[tf, statusFilter(s)]} title={s} />
                                        </td>
                                    ))
                                ) : (
                                    <td className="status-col" onClick={e => e.stopPropagation()}>
                                        <div className="stack" title={stages.map(s => `${s.label}: ${s.count}`).join('\n')}>
                                            {stages
                                                .filter(s => s.count > 0)
                                                .map(s => (
                                                    <button
                                                        key={s.key}
                                                        className={`seg stage-${s.key}`}
                                                        style={{ flexGrow: s.count }}
                                                        onClick={() => go([tf, ...s.statuses.map(statusFilter)])}
                                                        title={`${s.label}: ${s.count} (${share(s.count, active)}%) – click to list`}
                                                    />
                                                ))}
                                        </div>
                                    </td>
                                )}
                                <td onClick={e => e.stopPropagation()}>
                                    <Count value={t.unassigned} of={t.open} filters={[tf, ['signal', 'unassigned']]} title="Unassigned" />
                                </td>
                                <td onClick={e => e.stopPropagation()}>
                                    <Count value={t.byPriority[NONE] ?? 0} of={t.open} filters={[tf, ['pf', `Priority=${NO_VALUE}`]]} title="No priority" />
                                </td>
                                <td onClick={e => e.stopPropagation()}>
                                    <Count value={t.byPriority[high] ?? 0} filters={[tf, ['pf', `Priority=${high}`]]} title={high} />
                                </td>
                                <td onClick={e => e.stopPropagation()}>
                                    <Count value={t.stale} of={t.open} filters={[tf, ['signal', 'stale']]} title="Stale" />
                                </td>
                                <td onClick={e => e.stopPropagation()}>
                                    <Count value={t.awaitingTeam} filters={[tf, ['signal', 'awaiting_team']]} title="Awaiting reply" />
                                </td>
                                {anyAnalyzed && (
                                    <td onClick={e => e.stopPropagation()}>
                                        <Count value={t.closeCandidates} filters={[tf, ['cand', 'close']]} title="Close candidates" />
                                    </td>
                                )}
                                {anyAnalyzed && (
                                    <td onClick={e => e.stopPropagation()}>
                                        <Count value={t.otherTeam} filters={[tf, ['signal', 'team_mismatch']]} title="Claude suggests another team" />
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <p className="muted small footnote">
                Click a row for the team breakdown, a number or bar segment to list those issues. Percentages are of the team's
                open issues.{anyAnalyzed && ' Claude columns only cover analyzed issues.'}
            </p>

            {selected && data.details[selected.team ?? ''] && (
                <TeamBreakdown team={selected} detail={data.details[selected.team ?? '']!} data={data} teamFilter={teamFilter(selected)} go={go} />
            )}
        </div>
    );
}

function TeamBreakdown({
    team,
    detail,
    data,
    teamFilter,
    go,
}: {
    team: TeamSummary;
    detail: TeamDetail;
    data: Overview;
    teamFilter: Filter;
    go: (f: Filter[]) => void;
}) {
    const high = data.priorities[0]!;
    const maxAssignee = Math.max(1, ...detail.assignees.map(a => a.open));
    const maxRelease = Math.max(1, ...detail.releases.map(r => r.open));
    const statuses = data.statuses.filter(s => !DONE(s) && Object.values(detail.priorityStatus).some(r => r[s]));
    const priorities = data.priorities.filter(p => detail.priorityStatus[p]);
    const matrixMax = Math.max(1, ...Object.values(detail.priorityStatus).flatMap(r => Object.values(r)));
    const name = team.team ?? `No ${data.teamField.toLowerCase()}`;

    return (
        <section className="breakdown">
            <h2>{name}</h2>
            <div className="tiles">
                <Tile label="Open" value={String(team.open)} onClick={() => go([teamFilter])} />
                <Tile label="Unassigned" value={`${share(team.unassigned, team.open)}%`} sub={`${team.unassigned} issues`} onClick={() => go([teamFilter, ['signal', 'unassigned']])} />
                <Tile label={`${high} priority`} value={String(team.byPriority[high] ?? 0)} onClick={() => go([teamFilter, ['pf', `Priority=${high}`]])} />
                <Tile label="Stale >1y" value={`${share(team.stale, team.open)}%`} sub={`${team.stale} issues`} onClick={() => go([teamFilter, ['signal', 'stale']])} />
                <Tile label="Analyzed by Claude" value={`${share(team.analyzed, team.open)}%`} sub={`${team.analyzed} of ${team.open}`} onClick={() => go([teamFilter, ['ai', 'none']])} title="Click to list the ones not analyzed yet" />
            </div>

            <div className="breakdown-grid">
                <div className="card">
                    <h3>Workload</h3>
                    <p className="muted small">Open issues per assignee; “active” = in progress or review.</p>
                    {detail.assignees.length === 0 && <p className="muted">Nobody assigned.</p>}
                    {detail.assignees.map(a => (
                        <button key={a.login} className="bar-row" onClick={() => go([teamFilter, ['assignee', a.login]])}>
                            <span className="bar-label">{a.login}</span>
                            <span className="bar-track">
                                <span className="bar" style={{ width: `${(100 * a.open) / maxAssignee}%` }} />
                            </span>
                            <span className="bar-value">
                                {a.open}
                                {a.inProgress > 0 && <span className="muted"> · {a.inProgress} active</span>}
                            </span>
                        </button>
                    ))}
                    {team.unassigned > 0 && (
                        <button className="link unassigned-link" onClick={() => go([teamFilter, ['signal', 'unassigned']])}>
                            + {team.unassigned} unassigned
                        </button>
                    )}
                </div>

                <div className="card">
                    <h3>Priority × status</h3>
                    <table className="matrix">
                        <thead>
                            <tr>
                                <th />
                                {statuses.map(s => (
                                    <th key={s}>{s === NONE ? 'No status' : s}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {priorities.map(p => (
                                <tr key={p}>
                                    <th className="left">{p === NONE ? 'No priority' : p}</th>
                                    {statuses.map(s => {
                                        const v = detail.priorityStatus[p]?.[s] ?? 0;
                                        const pct = v ? Math.round(12 + 50 * (v / matrixMax)) : 0;
                                        return (
                                            <td
                                                key={s}
                                                className={v ? 'clickable' : ''}
                                                style={pct ? { background: `color-mix(in oklab, var(--seq) ${pct}%, transparent)` } : undefined}
                                                onClick={v ? () => go([teamFilter, ['pf', `Priority=${p === NONE ? NO_VALUE : p}`], statusFilter(s)]) : undefined}
                                                title={v ? `${p} / ${s}: ${v}` : undefined}
                                            >
                                                {v || <span className="zero">–</span>}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <h3>Releases</h3>
                    {detail.releases.length === 0 && <p className="muted small">No open issues planned for a release.</p>}
                    {detail.releases.map(r => (
                        <button key={r.release} className="bar-row" onClick={() => go([teamFilter, ['pf', `Release=${r.release}`]])}>
                            <span className="bar-label">{r.release}</span>
                            <span className="bar-track">
                                <span className="bar" style={{ width: `${(100 * r.open) / maxRelease}%` }} />
                            </span>
                            <span className="bar-value">{r.open}</span>
                        </button>
                    ))}
                </div>
            </div>
        </section>
    );
}

function Tile({ label, value, sub, onClick, title }: { label: string; value: string; sub?: string; onClick: () => void; title?: string }) {
    return (
        <button className="tile" onClick={onClick} title={title}>
            <span className="tile-label">{label}</span>
            <span className="tile-value">{value}</span>
            {sub && <span className="tile-sub">{sub}</span>}
        </button>
    );
}
