import { useEffect, useState } from 'react';
import type { SyncStatus } from './types.ts';
import { timeAgo } from './util.tsx';

const POLL_MS = 1000;

export function SyncButton({ onSynced, lastSyncAt, summary }: { onSynced: () => void; lastSyncAt: string | null; summary: string }) {
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [requestError, setRequestError] = useState<string | null>(null);

    // Pick up a sync already running (e.g. started from another tab) on load.
    useEffect(() => {
        fetch('/api/sync')
            .then(r => r.json() as Promise<SyncStatus>)
            .then(setStatus)
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (!status?.running) return;
        const t = setTimeout(async () => {
            try {
                const next = (await (await fetch('/api/sync')).json()) as SyncStatus;
                setStatus(next);
                if (!next.running) onSynced();
            } catch (err) {
                setRequestError(String((err as Error).message ?? err));
                setStatus(s => s && { ...s, running: false });
            }
        }, POLL_MS);
        return () => clearTimeout(t);
    }, [status, onSynced]);

    const start = async () => {
        setRequestError(null);
        try {
            const res = await fetch('/api/sync', { method: 'POST' });
            setStatus((await res.json()) as SyncStatus);
        } catch (err) {
            setRequestError(String((err as Error).message ?? err));
        }
    };

    const error = requestError ?? status?.error;
    const lastResult = status?.result
        ? `Last sync: ${status.result.issues} issues updated in ${(status.result.durationMs / 1000).toFixed(0)}s`
        : null;
    const tooltip = [summary, lastSyncAt && `Synced ${new Date(lastSyncAt).toLocaleString()}`, lastResult, 'Click to fetch changes from GitHub']
        .filter(Boolean)
        .join('\n');
    return (
        <span className="sync">
            {status?.running ? (
                <span className="muted small sync-status" title={status.progress ?? ''}>
                    Syncing…
                </span>
            ) : error ? (
                <span className="error small sync-status" title={error}>
                    Sync failed
                </span>
            ) : (
                lastSyncAt && <span className="muted small sync-status">{timeAgo(lastSyncAt)}</span>
            )}
            <button onClick={start} disabled={status?.running} title={tooltip}>
                {status?.running ? <span className="spinner" aria-label="Syncing" /> : '↻'} Sync
            </button>
        </span>
    );
}
