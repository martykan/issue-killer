import { useCallback, useEffect, useMemo, useState } from 'react';
import { IssueDetailPane } from './IssueDetail.tsx';
import { IssueListPane } from './IssueList.tsx';
import { BoardView } from './Board.tsx';
import { PlanView } from './PlanView.tsx';
import { TopicsView } from './TopicsView.tsx';
import { ConfirmHost } from './confirm.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { SetupWizard } from './SetupWizard.tsx';
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
    useRememberedTeam(meta.data, params, update);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [wizardOpen, setWizardOpen] = useState(false);
    // First start (or setup never finished): show the wizard once the server answered.
    useEffect(() => {
        if (meta.data && !meta.data.settings.setupDone) setWizardOpen(true);
    }, [meta.data?.settings.setupDone]); // eslint-disable-line react-hooks/exhaustive-deps
    const viewParam = params.get('view');
    const view = viewParam === 'teams' || viewParam === 'board' || viewParam === 'plan' || viewParam === 'topics' ? viewParam : 'issues';

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
        <div className={`app${view !== 'issues' ? ' teams-view' : ''}`}>
            <header className="topbar">
                <strong className="app-name">Issue Killer</strong>
                <div className="segmented view-toggle">
                    <button className={view === 'issues' ? 'active' : ''} onClick={() => update(p => p.delete('view'), { push: true })}>
                        Issues
                    </button>
                    <button className={view === 'board' ? 'active' : ''} onClick={() => update(p => p.set('view', 'board'), { push: true })}>
                        Board
                    </button>
                    <button className={view === 'plan' ? 'active' : ''} onClick={() => update(p => p.set('view', 'plan'), { push: true })}>
                        Plan
                    </button>
                    <button className={view === 'topics' ? 'active' : ''} onClick={() => update(p => p.set('view', 'topics'), { push: true })}>
                        Topics
                    </button>
                    <button className={view === 'teams' ? 'active' : ''} onClick={() => update(p => p.set('view', 'teams'), { push: true })}>
                        Teams
                    </button>
                </div>
                <span className="grow" />
                <TeamSwitcher meta={meta.data} params={params} update={update} />
                <button className="small-button settings-button" onClick={() => setSettingsOpen(true)} title="Settings & setup check">
                    ⚙
                </button>
                <SyncButton
                    onSynced={onSynced}
                    lastSyncAt={meta.data?.lastSyncAt ?? null}
                    summary={meta.data ? `${meta.data.repo} · ${meta.data.totals.open} open / ${meta.data.totals.closed} closed` : ''}
                />
            </header>
            {view === 'topics' ? (
                <TopicsView meta={meta.data} params={params} update={update} reloadKey={reloadKey} />
            ) : view === 'plan' ? (
                <PlanView meta={meta.data} params={params} update={update} reloadKey={reloadKey} />
            ) : view === 'board' ? (
                <BoardView meta={meta.data} params={params} update={update} reloadKey={reloadKey} />
            ) : view === 'teams' ? (
                <TeamsDashboard meta={meta.data} params={params} update={update} reloadKey={reloadKey} />
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
            {selected && <IssueDetailPane number={selected} meta={meta.data} update={update} reloadKey={reloadKey} onClose={() => select(null)} onChanged={onSynced} onOpenSettings={() => setSettingsOpen(true)} />}
                </>
            )}
            <ConfirmHost />
            {settingsOpen && meta.data && (
                <SettingsDialog
                    meta={meta.data}
                    onClose={() => setSettingsOpen(false)}
                    onSaved={onSynced}
                    onOpenWizard={() => {
                        setSettingsOpen(false);
                        setWizardOpen(true);
                    }}
                />
            )}
            {wizardOpen && <SetupWizard meta={meta.data} onDataChanged={onSynced} onClose={() => setWizardOpen(false)} />}
        </div>
    );
}
