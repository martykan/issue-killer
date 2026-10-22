import { useEffect, useRef, useState } from 'react';
import type { Question } from './types.ts';
import { Markdown, runJob, timeAgo } from './util.tsx';

const SUGGESTIONS = [
    'Is this still relevant for the current Connect architecture?',
    'What would a minimal fix look like?',
    'Which part of the codebase is most likely involved?',
    'Summarize the discussion and open questions.',
];

/** Free-form questions about the issue, answered by Claude with the issue (and optionally the code) as context. */
export function AskPanel({ number, initial }: { number: number; initial: Question[] }) {
    const [questions, setQuestions] = useState(initial);
    const [draft, setDraft] = useState('');
    const [mode, setMode] = useState<'thread' | 'code'>('thread');
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // The detail pane may have moved to another issue by the time a job finishes.
    const shownIssue = useRef(number);
    shownIssue.current = number;

    useEffect(() => {
        setPending(null);
        setQuestions(initial);
        setError(null);
    }, [initial, number]);

    const ask = async (question = draft) => {
        const q = question.trim();
        if (!q || pending) return;
        setPending(q);
        setError(null);
        try {
            const answer = await runJob<Question>(`/api/issues/${number}/ask`, { question: q, mode });
            if (shownIssue.current !== number) return;
            setQuestions(qs => [...qs, answer]);
            setDraft('');
        } catch (err) {
            setError(String((err as Error).message ?? err));
        } finally {
            setPending(null);
        }
    };

    return (
        <div className="ask">
            <div className="analysis-head">
                <strong>Ask Claude</strong>
                <span className="muted small">about this issue{questions.length > 0 && ' · follow-ups include earlier answers'}</span>
            </div>

            {questions.map(q => (
                <div key={q.id} className="qa">
                    <div className="qa-question">{q.question}</div>
                    <Markdown source={q.answer} />
                    <div className="muted small qa-meta">
                        {q.mode === 'code' ? 'with code' : 'thread only'} · {q.model} · {timeAgo(q.askedAt)}
                        {q.costUsd != null && ` · $${q.costUsd.toFixed(3)}`}
                        {q.sessionId && (
                            <span title="Inspect the agent's transcript">
                                {' · '}
                                <code>claude --resume {q.sessionId}</code>
                            </span>
                        )}
                    </div>
                </div>
            ))}

            {pending && (
                <div className="qa pending">
                    <div className="qa-question">{pending}</div>
                    <div className="muted small">
                        <span className="spinner" /> {mode === 'code' ? 'Looking at the code… (up to a minute)' : 'Thinking…'}
                    </div>
                </div>
            )}

            {questions.length === 0 && !pending && (
                <div className="pills">
                    {SUGGESTIONS.map(s => (
                        <button key={s} className="pill" onClick={() => (setDraft(s), inputRef.current?.focus())}>
                            {s}
                        </button>
                    ))}
                </div>
            )}

            <textarea
                ref={inputRef}
                className="ask-input"
                rows={2}
                placeholder={questions.length ? 'Ask a follow-up…' : 'Ask anything about this issue…'}
                value={draft}
                disabled={!!pending}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void ask();
                    }
                }}
            />
            <div className="row ask-actions">
                <div className="segmented small" title="Code: the agent may read the trezor-suite checkout, git history and PRs (slower)">
                    <button className={mode === 'thread' ? 'active' : ''} onClick={() => setMode('thread')}>
                        Issue only
                    </button>
                    <button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}>
                        + Code & history
                    </button>
                </div>
                <span className="grow" />
                <span className="muted small">⌘↵</span>
                <button className="primary-button" onClick={() => void ask()} disabled={!draft.trim() || !!pending}>
                    Ask
                </button>
            </div>
            {error && <div className="error">{error}</div>}
        </div>
    );
}
