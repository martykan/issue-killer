import { useEffect, useState } from 'react';

/** Review/edit the handoff prompt, then open it as a new Conductor workspace (or copy it). */
export function HandoffDialog({ number, onClose, onOpenSettings }: { number: number; onClose: () => void; onOpenSettings: () => void }) {
    const [prompt, setPrompt] = useState('');
    const [repoPath, setRepoPath] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(`/api/issues/${number}/handoff`)
            .then(r => r.json() as Promise<{ prompt: string; repoPath: string | null; error?: string }>)
            .then(r => {
                if (r.error) throw new Error(r.error);
                setPrompt(r.prompt);
                setRepoPath(r.repoPath);
            })
            .catch(err => setError(String(err.message ?? err)));
    }, [number]);

    const open = async () => {
        setError(null);
        const res = await fetch(`/api/issues/${number}/handoff`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? `HTTP ${res.status}`);
        else setStatus('Opened in Conductor – review the new workspace there.');
    };
    const copy = async () => {
        await navigator.clipboard?.writeText(prompt);
        setStatus('Prompt copied.');
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal handoff-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                <h2>Hand off #{number} to Conductor</h2>
                <p className="muted small">
                    Creates a new Conductor workspace with this prompt in{' '}
                    {repoPath ? <code>{repoPath}</code> : <>your first repository</>}
                    {' · '}
                    <button className="link small" onClick={onOpenSettings}>
                        {repoPath ? 'change' : 'set the repository path in Settings'}
                    </button>
                </p>
                <textarea className="ask-input handoff-prompt" rows={16} value={prompt} onChange={e => setPrompt(e.target.value)} />
                {status && <div className="ok-line small">{status}</div>}
                {error && <div className="error">{error}</div>}
                <div className="modal-actions">
                    <button className="small-button" onClick={copy} disabled={!prompt}>
                        Copy prompt
                    </button>
                    <span className="grow" />
                    <button className="small-button" onClick={onClose}>
                        Close
                    </button>
                    <button className="primary-button" onClick={open} disabled={!prompt.trim()}>
                        Open in Conductor
                    </button>
                </div>
            </div>
        </div>
    );
}
