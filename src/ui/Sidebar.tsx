import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { AnalysisFilters, REC_LABELS } from './Analysis.tsx';
import type { UpdateParams } from './App.tsx';
import { NO_VALUE, ProjectFilters } from './ProjectFilters.tsx';
import type { Meta } from './types.ts';

type Props = {
    meta: Meta | null;
    params: URLSearchParams;
    update: UpdateParams;
    labelCounts: { label: string; n: number }[];
};


// Signals grouped by what you'd do about them; unknown keys land in "Other".
const SIGNAL_GROUPS: { title: string; keys: string[] }[] = [
    { title: 'Needs attention', keys: ['awaiting_team', 'stale', 'reporter_left', 'assignee_left'] },
    { title: 'Maybe done', keys: ['fixed_by_pr', 'merged_pr_ref'] },
    { title: 'Ownership', keys: ['no_team', 'team_mismatch'] },
    { title: 'Missing info', keys: ['unlabeled', 'unassigned', 'untyped'] },
];

// Params that aren't filters (view state) – never shown as chips.
const NON_FILTER_PARAMS = new Set(['state', 'sort', 'page', 'issue', 'view', 'tview', 'bteam', 'pteam', 'team_role']);

export function Sidebar({ meta, params, update, labelCounts }: Props) {
    const urlQuery = params.get('q') ?? '';
    const [search, setSearch] = useState(urlQuery);

    // Keep the input in sync with back/forward navigation.
    useEffect(() => {
        setSearch(urlQuery);
    }, [urlQuery]);

    useEffect(() => {
        if (search === urlQuery) return;
        const t = setTimeout(() => update(p => (search ? p.set('q', search) : p.delete('q'))), 250);
        return () => clearTimeout(t);
    }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

    const state = params.get('state') ?? 'open';

    const toggleMulti = (key: string, value: string) =>
        update(p => {
            const values = p.getAll(key);
            p.delete(key);
            for (const v of values.includes(value) ? values.filter(x => x !== value) : [...values, value]) p.append(key, v);
        });
    const setSingle = (key: string, value: string) => update(p => (value ? p.set(key, value) : p.delete(key)));

    const count = (...keys: string[]) => keys.reduce((n, k) => n + params.getAll(k).length, 0);
    const projectFilterCount = params.getAll('pf').filter(v => !v.startsWith('Team=')).length;

    return (
        <aside className="sidebar">
            <div className="search-box">
                <input id="search" className="search" placeholder="Search or #number" title="Press / to search · j/k to move · Esc to close" value={search} onChange={e => setSearch(e.target.value)} />
                <label className="search-option" title="Also match comment text (slower)">
                    <input type="checkbox" checked={params.get('in') === 'all'} onChange={e => setSingle('in', e.target.checked ? 'all' : '')} />
                    comments
                </label>
            </div>

            <div className="segmented">
                {['open', 'closed', 'all'].map(s => (
                    <button key={s} className={state === s ? 'active' : ''} onClick={() => setSingle('state', s === 'open' ? '' : s)}>
                        {s}
                    </button>
                ))}
            </div>

            <ActiveFilters meta={meta} params={params} update={update} />

            <Section id="signals" title="Signals" defaultOpen active={count('signal')}>
                <SignalFilters meta={meta} params={params} toggle={v => toggleMulti('signal', v)} />
            </Section>

            {meta?.projects.length ? (
                <Section id="project" title={`Project: ${meta.projects[0]!.title}`} defaultOpen active={projectFilterCount}>
                    <ProjectFilters meta={meta} params={params} update={update} exclude={['Team']} />
                </Section>
            ) : null}

            <Section
                id="claude"
                title="Claude"
                active={count('ai', 'inv', 'rec', 'owner', 'rel', 'kind', 'severity', 'confidence', 'cand')}
                aside={meta ? `${meta.analysis.analyzedOpen} analyzed` : undefined}
            >
                <AnalysisFilters meta={meta} params={params} update={update} toggleMulti={toggleMulti} />
            </Section>

            <Section id="people" title="People & type" active={count('type', 'assignee', 'author', 'team')}>
                <PeopleFilters meta={meta} params={params} setSingle={setSingle} />
            </Section>

            <Section id="labels" title="Labels" active={count('label', 'nolabel')}>
                <LabelFilters meta={meta} params={params} update={update} labelCounts={labelCounts} toggle={v => toggleMulti('label', v)} />
            </Section>
        </aside>
    );
}

/** Collapsible sidebar section; remembers open state and stays open while it holds an active filter. */
function Section({
    id,
    title,
    defaultOpen = false,
    active,
    aside,
    children,
}: {
    id: string;
    title: string;
    defaultOpen?: boolean;
    active: number;
    aside?: string;
    children: ReactNode;
}) {
    const storageKey = `issue-killer.sidebar.${id}`;
    const [open, setOpen] = useState(() => {
        const stored = localStorage.getItem(storageKey);
        return stored === null ? defaultOpen : stored === '1';
    });
    const isOpen = open || active > 0;
    const toggle = () => {
        const next = !isOpen;
        setOpen(next);
        localStorage.setItem(storageKey, next ? '1' : '0');
    };
    return (
        <section className={`side-section${isOpen ? ' open' : ''}`}>
            <button className="section-head" onClick={toggle} aria-expanded={isOpen} disabled={active > 0} title={active > 0 ? 'Has active filters' : undefined}>
                <span className="chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="section-title">{title}</span>
                {active > 0 && <span className="active-count">{active}</span>}
                <span className="grow" />
                {aside && <span className="section-aside">{aside}</span>}
            </button>
            {isOpen && <div className="section-body">{children}</div>}
        </section>
    );
}

function ActiveFilters({ meta, params, update }: { meta: Meta | null; params: URLSearchParams; update: UpdateParams }) {
    const chips = useMemo(() => describeFilters(params, meta), [params, meta]);
    if (!chips.length) return null;
    const remove = (key: string, value: string) =>
        update(p => {
            const rest = p.getAll(key).filter(v => v !== value);
            p.delete(key);
            for (const v of rest) p.append(key, v);
            if (key === 'team') p.delete('team_role');
        });
    const clearAll = () =>
        update(p => {
            for (const k of [...p.keys()]) if (!NON_FILTER_PARAMS.has(k)) p.delete(k);
            p.delete('team_role');
        });
    return (
        <div className="active-filters">
            {chips.map(c => (
                <span key={`${c.key}=${c.value}`} className="filter-chip" title={c.label}>
                    <span className="filter-chip-label">{c.label}</span>
                    <button onClick={() => remove(c.key, c.value)} aria-label={`Remove ${c.label}`}>
                        ×
                    </button>
                </span>
            ))}
            {chips.length > 1 && (
                <button className="link small" onClick={clearAll}>
                    Clear all
                </button>
            )}
        </div>
    );
}

function describeFilters(params: URLSearchParams, meta: Meta | null): { key: string; value: string; label: string }[] {
    const signalLabel = new Map(meta?.signals.map(s => [s.key, s.label]));
    const human = (v: string) => v.replace(/_/g, ' ');
    const out: { key: string; value: string; label: string }[] = [];
    for (const [key, value] of params) {
        if (NON_FILTER_PARAMS.has(key)) continue;
        let label: string;
        switch (key) {
            case 'q':
                label = `“${value}”`;
                break;
            case 'in':
                label = 'incl. comments';
                break;
            case 'signal':
                label = signalLabel.get(value) ?? value;
                break;
            case 'label':
                label = `label: ${value}`;
                break;
            case 'nolabel':
                label = `not label: ${value}`;
                break;
            case 'type':
                label = value === 'none' ? 'no type' : `type: ${value}`;
                break;
            case 'team': {
                const role = params.get('team_role');
                label = `GitHub team: ${value}${role ? ` (${role === 'author' ? 'reported' : 'assigned'})` : ''}`;
                break;
            }
            case 'pf': {
                const [field, ...rest] = value.split('=');
                const v = rest.join('=');
                label = v === NO_VALUE ? `no ${field!.toLowerCase()}` : `${field}: ${v}`;
                break;
            }
            case 'ai':
                label = ({ done: 'analyzed', none: 'not analyzed', outdated: 'analysis outdated' } as Record<string, string>)[value] ?? value;
                break;
            case 'inv':
                label = ({ close: 'agent: proposes close', done: 'investigated', none: 'not investigated' } as Record<string, string>)[value] ?? value;
                break;
            case 'rec':
                label = REC_LABELS[value] ?? value;
                break;
            case 'cand':
                label = 'close candidates';
                break;
            case 'owner':
                label = `Claude owner: ${value}`;
                break;
            case 'rel':
                label = `my team relevance: ${value}`;
                break;
            default:
                label = `${human(key)}: ${human(value)}`;
        }
        out.push({ key, value, label });
    }
    return out;
}

function SignalFilters({ meta, params, toggle }: { meta: Meta | null; params: URLSearchParams; toggle: (key: string) => void }) {
    const selected = params.getAll('signal');
    const byKey = new Map(meta?.signals.map(s => [s.key, s]));
    const known = new Set(SIGNAL_GROUPS.flatMap(g => g.keys));
    const groups = [...SIGNAL_GROUPS, { title: 'Other', keys: (meta?.signals ?? []).map(s => s.key).filter(k => !known.has(k)) }];

    return (
        <>
            {groups.map(g => {
                const signals = g.keys.map(k => byKey.get(k)).filter(s => s !== undefined);
                if (!signals.length) return null;
                return (
                    <div key={g.title} className="signal-group">
                        <div className="group-title">{g.title}</div>
                        {signals.map(s => (
                            <label key={s.key} className="check" title={s.description}>
                                <input type="checkbox" checked={selected.includes(s.key)} onChange={() => toggle(s.key)} />
                                <span className={`signal-dot sig-${s.key}`} />
                                <span className="grow">{s.label}</span>
                                <span className="count">{s.count}</span>
                            </label>
                        ))}
                    </div>
                );
            })}
        </>
    );
}

function PeopleFilters({ meta, params, setSingle }: { meta: Meta | null; params: URLSearchParams; setSingle: (key: string, value: string) => void }) {
    return (
        <div className="select-grid">
            <select value={params.get('type') ?? ''} onChange={e => setSingle('type', e.target.value)}>
                <option value="">Any type</option>
                {meta?.types.map(t => (
                    <option key={t}>{t}</option>
                ))}
                <option value="none">No type</option>
            </select>
            <select value={params.get('assignee') ?? ''} onChange={e => setSingle('assignee', e.target.value)}>
                <option value="">Any assignee</option>
                {meta?.assignees.map(a => (
                    <option key={a}>{a}</option>
                ))}
            </select>
            <select
                className="span-2"
                value={params.get('team') ?? ''}
                onChange={e => setSingle('team', e.target.value)}
                title="GitHub org team: issues assigned to / reported by its members"
            >
                <option value="">{meta?.hasOrgData === false ? 'No org data (read:org)' : 'Any GitHub team'}</option>
                {meta?.teams.map(t => (
                    <option key={t.slug} value={t.slug}>
                        {t.name} ({t.members})
                    </option>
                ))}
            </select>
            {params.get('team') && (
                <select className="span-2" value={params.get('team_role') ?? ''} onChange={e => setSingle('team_role', e.target.value)}>
                    <option value="">assigned or reported</option>
                    <option value="assignee">assigned</option>
                    <option value="author">reported</option>
                </select>
            )}
        </div>
    );
}

const LABELS_COLLAPSED = 12;

function LabelFilters({
    meta,
    params,
    update,
    labelCounts,
    toggle,
}: {
    meta: Meta | null;
    params: URLSearchParams;
    update: UpdateParams;
    labelCounts: { label: string; n: number }[];
    toggle: (label: string) => void;
}) {
    const [filter, setFilter] = useState('');
    const [showAll, setShowAll] = useState(false);
    const selected = params.getAll('label');
    // Shortcut: labels named after your team (e.g. suite-wallet → "wallet*"), if any.
    const teamKeyword = meta?.settings.myTeam?.replace(/^suite-/, '').toLowerCase() ?? '';
    const teamLabels = useMemo(
        () => (teamKeyword ? (meta?.labels.map(l => l.name).filter(n => n.toLowerCase().startsWith(teamKeyword)) ?? []) : []),
        [meta, teamKeyword],
    );

    const rows = useMemo(() => {
        const counts = new Map(labelCounts.map(c => [c.label, c.n]));
        return (meta?.labels ?? [])
            .map(l => ({ ...l, n: counts.get(l.name) ?? 0 }))
            .filter(l => l.n > 0 || selected.includes(l.name))
            .filter(l => !filter || l.name.toLowerCase().includes(filter.toLowerCase()))
            .sort((a, b) => Number(selected.includes(b.name)) - Number(selected.includes(a.name)) || b.n - a.n);
    }, [meta, labelCounts, filter, selected]);
    const visible = showAll || filter ? rows : rows.slice(0, Math.max(LABELS_COLLAPSED, selected.length));

    return (
        <>
            <div className="label-tools">
                <input className="search small" placeholder="Filter labels" value={filter} onChange={e => setFilter(e.target.value)} />
                {teamLabels.length > 0 && (
                    <button
                        className="link small"
                        onClick={() =>
                            update(p => {
                                p.delete('label');
                                for (const l of teamLabels) p.append('label', l);
                            })
                        }
                        title={`Any of: ${teamLabels.join(', ')}`}
                    >
                        {teamKeyword}*
                    </button>
                )}
            </div>
            <div className="label-list">
                {visible.map(l => (
                    <label key={l.name} className="check" title={l.description ?? undefined}>
                        <input type="checkbox" checked={selected.includes(l.name)} onChange={() => toggle(l.name)} />
                        <span className="swatch" style={{ background: `#${l.color ?? '888'}` }} />
                        <span className="grow">{l.name}</span>
                        <span className="count">{l.n}</span>
                    </label>
                ))}
            </div>
            {!filter && rows.length > visible.length && (
                <button className="link small show-more" onClick={() => setShowAll(true)}>
                    Show all {rows.length} labels
                </button>
            )}
            <div className="muted small hint-line">Matches issues with any of the selected labels.</div>
        </>
    );
}
