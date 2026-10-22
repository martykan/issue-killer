import { useEffect, useRef, useState } from 'react';
import type { Investigation, IssueAction } from './types.ts';
import { confirmDialog } from './confirm.tsx';
import { runJob, timeAgo } from './util.tsx';

const VERDICT_LABELS: Record<string, string> = {
    resolved: 'Resolved',
    partially_resolved: 'Partially resolved',
    not_resolved: 'Not resolved',
    obsolete: 'Obsolete',
    duplicate: 'Duplicate',
    unclear: 'Unclear',
};

const ACTION_TO_REASON: Record<string, string> = {
    close_completed: 'completed',
    close_not_planned: 'not_planned',
    close_duplicate: 'duplicate',
};

export function VerdictBadge({ verdict, proposedAction, confidence }: { verdict: string; proposedAction: string; confidence: string }) {
    const closing = proposedAction.startsWith('close_');
    return (
        <span
            className={`verdict ${closing ? 'verdict-close' : 'verdict-keep'}${confidence === 'low' ? ' low-confidence' : ''}`}
            title={`Agent verdict: ${VERDICT_LABELS[verdict] ?? verdict} (${confidence}) → ${proposedAction.replace('_', ' ')}`}
        >
            🔎 {closing ? `close: ${ACTION_TO_REASON[proposedAction]?.replace('_', ' ')}` : (VERDICT_LABELS[verdict] ?? verdict)}
        </span>
    );
}

type Props = {
    number: number;
    isOpen: boolean;
    initial: Investigation | null;
    actions: IssueAction[];
    onOpenIssue: (n: number) => void;
    onClosed: () => void;
};

export function InvestigationPanel({ number, isOpen, initial, actions, onOpenIssue, onClosed }: Props) {
    const [inv, setInv] = useState(initial);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The detail pane may have moved to another issue by the time a job finishes.
    const shownIssue = useRef(number);
    shownIssue.current = number;

    useEffect(() => {
        setRunning(false);
        setInv(initial);
        setError(null);
    }, [initial, number]);

    const investigate = async () => {
        setRunning(true);
        setError(null);
        try {
            const result = await runJob<Investigation>(`/api/issues/${number}/investigate`);
            if (shownIssue.current === number) setInv(result);
        } catch (err) {
            setError(String((err as Error).message ?? err));
        } finally {
            setRunning(false);
        }
    };

    const button = (
        <button className="small-button" onClick={investigate} disabled={running} title="Agent checks code, git history, PRs and similar issues (read-only), ~15–60s">
            {running ? 'Investigating…' : inv ? 'Re-investigate' : 'Investigate if resolved'}
        </button>
    );

    return (
        <div className={`investigation${running ? ' dim' : ''}${!inv && !actions.length ? ' empty-panel' : ''}`}>
            {actions.map((a, i) => (
                <div key={i} className="action-log">
                    ✅ Closed as {a.stateReason?.toLowerCase().replace('_', ' ')}
                    {a.duplicateOf ? ` of #${a.duplicateOf}` : ''} by {a.performedBy} {timeAgo(a.performedAt)}
                    {a.commentUrl && (
                        <>
                            {' · '}
                            <a href={a.commentUrl} target="_blank" rel="noreferrer">
                                comment
                            </a>
                        </>
                    )}
                </div>
            ))}
            {!inv ? (
                <div className="analysis-head">
                    <span className="muted">Not investigated yet.</span>
                    <span className="grow" />
                    {isOpen && button}
                </div>
            ) : (
                <>
                    <div className="analysis-head">
                        <VerdictBadge verdict={inv.verdict} proposedAction={inv.proposed_action} confidence={inv.confidence} />
                        <span className="muted small">{inv.confidence} confidence</span>
                        <span className="grow" />
                        {isOpen && button}
                    </div>
                    <p>{inv.explanation}</p>
                    {inv.evidence.length > 0 && (
                        <ul className="evidence">
                            {inv.evidence.map((e, i) => (
                                <li key={i}>
                                    <span className="evidence-kind">{e.kind}</span>{' '}
                                    {e.url ? (
                                        <a href={e.url} target="_blank" rel="noreferrer">
                                            <code>{e.ref}</code>
                                        </a>
                                    ) : (
                                        <code>{e.ref}</code>
                                    )}{' '}
                                    – {e.note}
                                </li>
                            ))}
                        </ul>
                    )}
                    {isOpen && inv.proposed_action !== 'keep_open' && (
                        <CloseForm number={number} inv={inv} onOpenIssue={onOpenIssue} onClosed={onClosed} />
                    )}
                    <div className="muted small">
                        {inv.model} · develop@{inv.repoSha} · {inv.numTurns} turns · {timeAgo(inv.investigatedAt)}
                        {inv.costUsd != null && ` · $${inv.costUsd.toFixed(2)}`}
                        {inv.sessionId && (
                            <span title="Inspect the agent's full transcript">
                                {' · '}
                                <code>cd data/trezor-suite && claude --resume {inv.sessionId}</code>
                            </span>
                        )}
                        {inv.outdated && <span className="outdated"> · outdated (issue changed since)</span>}
                    </div>
                </>
            )}
            {error && <div className="error">{error}</div>}
        </div>
    );
}

function CloseForm({
    number,
    inv,
    onOpenIssue,
    onClosed,
}: {
    number: number;
    inv: Investigation;
    onOpenIssue: (n: number) => void;
    onClosed: () => void;
}) {
    const [reason, setReason] = useState(ACTION_TO_REASON[inv.proposed_action] ?? 'completed');
    const [duplicateOf, setDuplicateOf] = useState(inv.duplicate_of ? String(inv.duplicate_of) : '');
    const [comment, setComment] = useState(inv.close_comment);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = async () => {
        const label = reason === 'duplicate' ? `duplicate of #${duplicateOf}` : reason.replace('_', ' ');
        const message = `Close #${number} on GitHub as ${label}${comment.trim() ? ' and post the comment' : ''}?`;
        if (!(await confirmDialog(message, { confirmLabel: 'Close on GitHub', danger: true }))) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/issues/${number}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, comment, duplicateOf: duplicateOf ? Number(duplicateOf) : null }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
            onClosed();
        } catch (err) {
            setError(String((err as Error).message ?? err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="close-form">
            <div className="row">
                <select value={reason} onChange={e => setReason(e.target.value)}>
                    <option value="completed">Close as completed</option>
                    <option value="not_planned">Close as not planned</option>
                    <option value="duplicate">Close as duplicate</option>
                </select>
                {reason === 'duplicate' && (
                    <>
                        <input
                            className="search dup-input"
                            placeholder="of #"
                            value={duplicateOf}
                            onChange={e => setDuplicateOf(e.target.value.replace(/\D/g, ''))}
                        />
                        {duplicateOf && (
                            <button className="link" onClick={() => onOpenIssue(Number(duplicateOf))}>
                                view #{duplicateOf}
                            </button>
                        )}
                    </>
                )}
            </div>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={4} placeholder="Closing comment (optional)" />
            <div className="row">
                <span className="muted small grow">Review the evidence and edit the comment before closing. This posts to GitHub.</span>
                <button className="danger-button" onClick={close} disabled={busy || (reason === 'duplicate' && !duplicateOf)}>
                    {busy ? 'Closing…' : 'Close on GitHub'}
                </button>
            </div>
            {error && <div className="error">{error}</div>}
        </div>
    );
}
