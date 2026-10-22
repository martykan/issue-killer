import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useState } from 'react';

DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
});

export function Markdown({ source }: { source: string }) {
    if (!source.trim()) return <p className="muted">No description.</p>;
    const html = DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: true, async: false }));
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function timeAgo(iso: string | null): string {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    const units: [number, string][] = [
        [365 * 86400, 'y'],
        [30 * 86400, 'mo'],
        [86400, 'd'],
        [3600, 'h'],
        [60, 'm'],
    ];
    for (const [secs, unit] of units) if (s >= secs) return `${Math.floor(s / secs)}${unit} ago`;
    return 'just now';
}

export function formatDate(iso: string | null) {
    return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

export function LabelChip({ name, color, onClick }: { name: string; color?: string | null; onClick?: () => void }) {
    const bg = `#${color ?? '888888'}`;
    return (
        <span
            className={`label${onClick ? ' clickable' : ''}`}
            style={{ backgroundColor: bg, color: textColorFor(color ?? '888888') }}
            onClick={onClick}
            title={onClick ? `Filter by ${name}` : undefined}
        >
            {name}
        </span>
    );
}

function textColorFor(hex: string) {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r! + 0.587 * g! + 0.114 * b! > 150 ? '#1f2328' : '#ffffff';
}

// `reloadKey` refetches the same URL when it changes (e.g. after a sync).
export function useFetch<T>(url: string | null, reloadKey?: unknown): { data: T | null; loading: boolean; error: string | null } {
    const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
        data: null,
        loading: !!url,
        error: null,
    });
    useEffect(() => {
        if (!url) {
            setState({ data: null, loading: false, error: null });
            return;
        }
        const ctrl = new AbortController();
        setState(s => ({ ...s, loading: true, error: null }));
        fetch(url, { signal: ctrl.signal })
            .then(async r => {
                if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
                return r.json() as Promise<T>;
            })
            .then(data => setState({ data, loading: false, error: null }))
            .catch(err => {
                if (!ctrl.signal.aborted) setState(s => ({ ...s, loading: false, error: String(err.message ?? err) }));
            });
        return () => ctrl.abort();
    }, [url, reloadKey]);
    return state;
}

/**
 * Starts a server-side background job (POST → { jobId }) and polls until it finishes; resolves with its result.
 * Used for Claude calls, which can outlast what the webview keeps a request open for.
 */
export async function runJob<T>(url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const started = await res.json();
    if (!res.ok) throw new Error(started.error ?? `HTTP ${res.status}`);
    for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(`/api/jobs/${started.jobId}`);
        const job = await poll.json();
        if (!poll.ok) throw new Error(job.error ?? `HTTP ${poll.status}`);
        if (job.status === 'done') return job.result as T;
        if (job.status === 'error') throw new Error(job.error);
    }
}
