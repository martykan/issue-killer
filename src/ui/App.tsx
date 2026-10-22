import { useCallback, useEffect, useMemo, useState } from 'react';
import { IssueDetailPane } from './IssueDetail.tsx';
import { IssueListPane } from './IssueList.tsx';
import { ConfirmHost } from './confirm.tsx';
import { Sidebar } from './Sidebar.tsx';
import { SyncButton } from './SyncButton.tsx';
import { TeamSwitcher, useRememberedTeam } from './TeamSwitcher.tsx';
import { TeamsDashboard } from './TeamsDashboard.tsx';
import type { IssueList, Meta } from './types.ts';
import { useFetch } from './util.tsx';

export type UpdateParams = (mutate: (p: URLSearchParams) => void, opts?: { keepPage?: boolean; push?: boolean }) => void;

function useUrlParams(): [URLSearchParams, UpdateParams] {
    const [params, setParams] = useState(() => new URLSearchParams(location.search));

    useEffect(() => {
        const onPop = () => setParams(new URLSearchParams(location.search));
        addEventListener('popstate', onPop);
        return () => removeEventListener('popstate', onPop);
    }, []);

    const update: UpdateParams = useCallback((mutate, opts = {}) => {
        const next = new URLSearchParams(location.search);
        mutate(next);
        if (!opts.keepPage) next.delete('page');
        const url = `${location.pathname}${next.size ? `?${next}` : ''}`;
        if (opts.push) history.pushState(null, '', url);
        else history.replaceState(null, '', url);
        setParams(next);
    }, []);

    return [params, update];
}

export function App() {
    const [params, update] = useUrlParams();
    const [reloadKey, setReloadKey] = useState(0);
    const onSynced = useCallback(() => setReloadKey(k => k + 1), []);
    const meta = useFetch<Meta>('/api/meta', reloadKey);
    useRememberedTeam(params, update);
    const view = params.get('view') === 'teams' ? 'teams' : 'issues';

    const listQuery = useMemo(() => {
        const p = new URLSearchParams(params);
        p.delete('issue');
        return p.toString();
    }, [params]);
    const list = useFetch<IssueList>(view === 'issues' ? `/api/issues?${listQuery}` : null, reloadKey);

    const selected = params.get('issue') ? Number(params.get('issue')) : null;
    const select = useCallback(
        (n: number | null) =>
            update(p => (n ? p.set('issue', String(n)) : p.delete('issue')), { keepPage: true, push: true }),
        [update],
    );

    // j/k to move through the list, Escape to close the detail, / to search.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.matches('input, textarea, select')) {
                if (e.key === 'Escape') target.blur();
                return;
            }
            const items = list.data?.items ?? [];
            const idx = items.findIndex(i => i.number === selected);
            if (e.key === 'j' || e.key === 'k') {
                const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === 'j' ? 1 : -1)))];
                if (next) {
                    update(p => p.set('issue', String(next.number)), { keepPage: true });
                    document.getElementById(`issue-${next.number}`)?.scrollIntoView({ block: 'nearest' });
                }
            } else if (e.key === 'Escape') {
                select(null);
            } else if (e.key === '/') {
                e.preventDefault();
                document.getElementById('search')?.focus();
            }
        };
        addEventListener('keydown', onKey);
        return () => removeEventListener('keydown', onKey);
    }, [list.data, selected, select, update]);

    return (
        <div className={`app${view === 'teams' ? ' teams-view' : ''}`}>
            <header className="topbar">
                <strong className="app-name">Issue Killer</strong>
                <div className="segmented view-toggle">
                    <button className={view === 'issues' ? 'active' : ''} onClick={() => update(p => p.delete('view'), { push: true })}>
                        Issues
                    </button>
                    <button className={view === 'teams' ? 'active' : ''} onClick={() => update(p => p.set('view', 'teams'), { push: true })}>
                        Teams
                    </button>
                </div>
                <span className="grow" />
                <TeamSwitcher meta={meta.data} params={params} update={update} />
                <SyncButton
                    onSynced={onSynced}
                    lastSyncAt={meta.data?.lastSyncAt ?? null}
                    summary={meta.data ? `${meta.data.repo} · ${meta.data.totals.open} open / ${meta.data.totals.closed} closed` : ''}
                />
            </header>
            {view === 'teams' ? (
                <TeamsDashboard params={params} update={update} reloadKey={reloadKey} />
            ) : (
                <>
            <Sidebar meta={meta.data} params={params} update={update} labelCounts={list.data?.labelCounts ?? []} />
            <IssueListPane
                list={list}
                meta={meta.data}
                params={params}
                update={update}
                selected={selected}
                onSelect={select}
                onAnalyzed={onSynced}
            />
            {selected && <IssueDetailPane number={selected} meta={meta.data} update={update} reloadKey={reloadKey} onClose={() => select(null)} onChanged={onSynced} />}
                </>
            )}
            <ConfirmHost />
        </div>
    );
}
