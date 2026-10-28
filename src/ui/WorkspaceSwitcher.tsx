import { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from './confirm.tsx';
import type { Meta } from './types.ts';
import { runJob } from './util.tsx';

type WorkspaceInfo = { id: string; repo: string | null; checkoutPath: string; managed: boolean; active: boolean; syncing: boolean };
type WorkspaceList = { workspaces: WorkspaceInfo[]; canPickFolder: boolean };
type Remote = { name: string; url: string; repo: string };
type Inspected = { path: string | null; remotes: Remote[]; error?: string };

const ADD = '__add__';

async function request<T>(url: string, init?: { method: string; body?: unknown }): Promise<T> {
    const res = await fetch(url, {
        method: init?.method ?? 'GET',
        ...(init?.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body as T;
}

/** Switching starts the app fresh: filters, open issue and views belong to the previous repository. */
async function selectWorkspace(id: string) {
    await request('/api/workspaces/select', { method: 'POST', body: { id } });
    location.assign('/');
}

/** Top-bar repository switcher; each repository (workspace) has its own data, settings and code checkout. */
export function WorkspaceSwitcher({ meta }: { meta: Meta | null }) {
    const [list, setList] = useState<WorkspaceList | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const load = useCallback(() => request<WorkspaceList>('/api/workspaces').then(setList, () => {}), []);
    useEffect(() => {
        void load();
    }, [load, meta?.repo]);

    if (!list) return null;
    const current = list.workspaces.find(w => w.active);
    return (
        <>
            <select
                className="workspace-switcher"
                value={current?.id ?? ''}
                title={current ? `${current.repo ?? 'Repository not set up yet'}\nCode: ${current.checkoutPath}` : undefined}
                onChange={e => {
                    if (e.target.value === ADD) setDialogOpen(true);
                    else void selectWorkspace(e.target.value);
                }}
            >
                {list.workspaces.map(w => (
                    <option key={w.id} value={w.id}>
                        {w.repo ?? 'New repository'}
                        {w.syncing ? ' (syncing)' : ''}
                    </option>
                ))}
                <option disabled>──────────</option>
                <option value={ADD}>Add or remove repositories…</option>
            </select>
            {dialogOpen && (
                <RepositoriesDialog
                    list={list}
                    onChanged={load}
                    onClose={() => setDialogOpen(false)}
                />
            )}
        </>
    );
}

function RepositoriesDialog({ list, onChanged, onClose }: { list: WorkspaceList; onChanged: () => void; onClose: () => void }) {
    const [tab, setTab] = useState<'folder' | 'clone'>('folder');
    const [error, setError] = useState<string | null>(null);

    const remove = async (w: WorkspaceInfo) => {
        const ok = await confirmDialog(
            `Remove ${w.repo ?? w.id}? Its data stays on disk.`,
            { confirmLabel: 'Remove', danger: true },
        );
        if (!ok) return;
        setError(null);
        try {
            await request(`/api/workspaces/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
            onChanged();
        } catch (err) {
            setError(String((err as Error).message ?? err));
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal repos-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                <h2>Repositories</h2>
                <p className="muted small">Each repository has its own issues, settings and Claude results.</p>
                <ul className="repo-list">
                    {list.workspaces.map(w => (
                        <li key={w.id} className={w.active ? 'active' : ''}>
                            <div className="repo-list-main">
                                <b>{w.repo ?? 'New repository'}</b>
                                <span className="muted small" title={w.checkoutPath}>
                                    {w.managed ? 'Cloned by the app' : w.checkoutPath}
                                </span>
                            </div>
                            {w.active ? (
                                <span className="muted small">current</span>
                            ) : (
                                <>
                                    <button className="small-button" onClick={() => void selectWorkspace(w.id)}>
                                        Open
                                    </button>
                                    <button className="link small" onClick={() => void remove(w)} disabled={list.workspaces.length <= 1}>
                                        Remove
                                    </button>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
                {error && <p className="error">{error}</p>}

                <h3>Add repository</h3>
                <div className="segmented small repo-tabs">
                    <button className={tab === 'folder' ? 'active' : ''} onClick={() => setTab('folder')}>
                        Local folder
                    </button>
                    <button className={tab === 'clone' ? 'active' : ''} onClick={() => setTab('clone')}>
                        Clone from URL
                    </button>
                </div>
                {tab === 'folder' ? <AddFolder canPick={list.canPickFolder} /> : <AddClone />}
                <div className="modal-actions repo-dialog-actions">
                    <button className="small-button" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

/** A clone the user already has: its GitHub remote says which repository's issues to sync. */
function AddFolder({ canPick }: { canPick: boolean }) {
    const [path, setPath] = useState('');
    const [inspected, setInspected] = useState<Inspected | null>(null);
    const [repo, setRepo] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const show = (r: Inspected) => {
        setInspected(r);
        if (r.path) setPath(r.path);
        setRepo(r.remotes[0]?.repo ?? '');
        setError(r.error ?? (r.path && !r.remotes.length ? 'No GitHub remote found – enter owner/name.' : null));
    };
    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (err) {
            setInspected(null);
            setError(String((err as Error).message ?? err));
        } finally {
            setBusy(false);
        }
    };
    const pick = () =>
        run(async () => {
            const r = await request<Inspected>('/api/workspaces/pick-folder', { method: 'POST' });
            if (r.path) show(r);
        });
    const check = () => run(async () => show(await request<Inspected>(`/api/workspaces/inspect?path=${encodeURIComponent(path.trim())}`)));
    const add = () =>
        run(async () => {
            const ws = await request<{ id: string }>('/api/workspaces', { method: 'POST', body: { kind: 'folder', path: inspected!.path, repo: repo.trim() } });
            await selectWorkspace(ws.id);
        });

    const checked = !!inspected?.path && inspected.path === path;
    return (
        <>
            <p className="muted small">
                Issues are synced from the folder's GitHub remote. The folder is only read, never changed.
            </p>
            <div className="repo-path-row">
                <input
                    className="search"
                    value={path}
                    placeholder="/Users/you/code/my-repo"
                    onChange={e => setPath(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && path.trim() && void check()}
                />
                {canPick && (
                    <button className="small-button" onClick={pick} disabled={busy}>
                        Choose folder…
                    </button>
                )}
                {!checked && (
                    <button className="small-button" onClick={check} disabled={busy || !path.trim()}>
                        Check
                    </button>
                )}
            </div>
            {checked && (
                <label className="field-select repo-detected">
                    <span className="field-label">GitHub repository</span>
                    {inspected.remotes.length > 0 ? (
                        <select value={repo} onChange={e => setRepo(e.target.value)}>
                            {[...new Set(inspected.remotes.map(r => r.repo))].map(r => (
                                <option key={r} value={r}>
                                    {r} ({inspected.remotes.filter(x => x.repo === r).map(x => x.name).join(', ')})
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input className="search" value={repo} placeholder="owner/name" onChange={e => setRepo(e.target.value)} />
                    )}
                </label>
            )}
            {error && <p className="error small">{error}</p>}
            <div className="modal-actions repo-add-actions">
                <button className="primary-button" onClick={add} disabled={busy || !checked || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim())}>
                    {busy ? 'Adding…' : 'Add repository'}
                </button>
            </div>
        </>
    );
}

/** Clones into the app's data folder (blob-less); the app keeps that checkout in sync with origin. */
function AddClone() {
    const [url, setUrl] = useState('');
    const [cloning, setCloning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const clone = async () => {
        setCloning(true);
        setError(null);
        try {
            const ws = await runJob<{ id: string }>('/api/workspaces', { kind: 'clone', url: url.trim() });
            await selectWorkspace(ws.id);
        } catch (err) {
            setError(String((err as Error).message ?? err));
            setCloning(false);
        }
    };
    return (
        <>
            <p className="muted small">
                Cloned into the app's data folder and kept up to date by the app.
            </p>
            <input
                className="search repo-url"
                value={url}
                placeholder="https://github.com/owner/name or git@github.com:owner/name.git"
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && url.trim() && !cloning && void clone()}
                disabled={cloning}
            />
            {cloning && (
                <p className="muted small">
                    <span className="spinner" /> Cloning…
                </p>
            )}
            {error && <p className="error small">{error}</p>}
            <div className="modal-actions repo-add-actions">
                <button className="primary-button" onClick={clone} disabled={cloning || !url.trim()}>
                    {cloning ? 'Cloning…' : 'Clone & add'}
                </button>
            </div>
        </>
    );
}
