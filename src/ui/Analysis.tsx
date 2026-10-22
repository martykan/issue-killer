import { useEffect, useRef, useState } from 'react';
import type { UpdateParams } from './App.tsx';
import type { Analysis, AnalysisFilterKey, AnalyzeStatus, Meta } from './types.ts';
import { confirmDialog } from './confirm.tsx';
import { LabelChip, runJob, timeAgo } from './util.tsx';

export const REC_LABELS: Record<string, string> = {
    prioritize: 'Prioritize',
    keep: 'Keep',
    needs_info: 'Needs info',
    close_fixed: 'Close: fixed',
    close_duplicate: 'Close: duplicate',
    close_obsolete: 'Close: obsolete',
    close_wont_fix: "Close: won't fix",
    close_stale: 'Close: stale',
};

const humanize = (v: string) => REC_LABELS[v] ?? v.replace(/_/g, ' ');

export function RecBadge({ rec, confidence, title }: { rec: string; confidence?: string; title?: string }) {
    const group = rec.startsWith('close_') ? 'close' : rec;
    return (
        <span className={`rec rec-${group}${confidence === 'low' ? ' low-confidence' : ''}`} title={title}>
            {humanize(rec)}
            {confidence && confidence !== 'high' && <span className="rec-confidence"> · {confidence}</span>}
        </span>
    );
}

// ---------- Detail panel ----------

type PanelProps = {
    number: number;
    initial: Analysis | null;
    labels: Meta['labels'] | undefined;
    currentLabels: string[];
    onFilter: (key: string, value: string) => void;
};

export function AnalysisPanel({ number, initial, labels, currentLabels, onFilter }: PanelProps) {
    const [analysis, setAnalysis] = useState(initial);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The detail pane may have moved to another issue by the time a job finishes.
    const shownIssue = useRef(number);
    shownIssue.current = number;

    useEffect(() => {
        setRunning(false);
        setAnalysis(initial);
        setError(null);
    }, [initial, number]);

    const run = async () => {
        setRunning(true);
        setError(null);
        try {
            const result = await runJob<Analysis>(`/api/issues/${number}/analyze`);
            if (shownIssue.current === number) setAnalysis(result);
        } catch (err) {
            setError(String((err as Error).message ?? err));
        } finally {
            setRunning(false);
        }
    };

    const button = (
        <button className="small-button" onClick={run} disabled={running}>
            {running ? 'Analyzing…' : analysis ? 'Re-analyze' : 'Analyze with Claude'}
        </button>
    );

    if (!analysis) {
        return (
            <div className="analysis empty-panel">
                <div className="analysis-head">
                    <span className="muted">Not analyzed yet.</span>
                    <span className="grow" />
                    {button}
                </div>
                {error && <div className="error">{error}</div>}
            </div>
        );
    }

    const labelColors = new Map(labels?.map(l => [l.name, l.color]));
    const newLabels = analysis.suggested_labels.filter(l => !currentLabels.includes(l));
    const a = analysis;

    return (
        <div className={`analysis${running ? ' dim' : ''}`}>
            <div className="analysis-head">
                <RecBadge rec={a.recommendation} confidence={a.confidence} />
                <span className="muted small">{a.confidence} confidence</span>
                <span className="grow" />
                {button}
            </div>
            <p className="analysis-summary">{a.summary}</p>
            <p>
                <strong>Why: </strong>
                {a.reasoning}
            </p>
            <p>
                <strong>Next step: </strong>
                {a.next_step}
            </p>
            <dl className="facts compact">
                <dt>Owner</dt>
                <dd>
                    <button className="link" onClick={() => onFilter('owner', a.owner_team)}>
                        {a.owner_team}
                    </button>
                </dd>
                <dt>Connect</dt>
                <dd>
                    <button className="link" onClick={() => onFilter('rel', a.connect_relevance)}>
                        {a.connect_relevance}
                    </button>
                </dd>
                <dt>Kind / area</dt>
                <dd>
                    {humanize(a.kind)} · <code>{a.area}</code>
                </dd>
                <dt>Severity</dt>
                <dd>
                    {a.severity} · effort {a.effort}
                </dd>
                {newLabels.length > 0 && (
                    <>
                        <dt>Add labels</dt>
                        <dd className="tags">
                            {newLabels.map(l => (
                                <LabelChip key={l} name={l} color={labelColors.get(l)} />
                            ))}
                        </dd>
                    </>
                )}
            </dl>
            <div className="muted small">
                {a.model} · {timeAgo(a.analyzedAt)}
                {a.costUsd != null && ` · $${a.costUsd.toFixed(3)}`}
                {a.outdated && <span className="outdated"> · outdated (issue or prompt changed since)</span>}
            </div>
            {error && <div className="error">{error}</div>}
        </div>
    );
}

// ---------- Sidebar filters ----------

const FILTER_SELECTS: { key: AnalysisFilterKey; enumKey: keyof Meta['analysis']['enums']; title: string }[] = [
    { key: 'owner', enumKey: 'owner_team', title: 'Owner team' },
    { key: 'rel', enumKey: 'connect_relevance', title: 'Connect relevance' },
    { key: 'kind', enumKey: 'kind', title: 'Kind' },
    { key: 'severity', enumKey: 'severity', title: 'Severity' },
    { key: 'confidence', enumKey: 'confidence', title: 'Confidence' },
];

type FilterProps = {
    meta: Meta | null;
    params: URLSearchParams;
    update: UpdateParams;
    toggleMulti: (key: string, value: string) => void;
};

export function AnalysisFilters({ meta, params, update, toggleMulti }: FilterProps) {
    const stats = meta?.analysis;
    if (!stats) return null;
    const setSingle = (key: string, value: string) => update(p => (value ? p.set(key, value) : p.delete(key)));
    const selectedRecs = params.getAll('rec');

    return (
        <>
            <div className="select-grid">
                <label className="field-select">
                    <span className="field-label">Triage</span>
                    <select value={params.get('ai') ?? ''} onChange={e => setSingle('ai', e.target.value)}>
                        <option value="">Any</option>
                        <option value="done">Analyzed ({stats.analyzedOpen})</option>
                        <option value="none">Not analyzed</option>
                        <option value="outdated">Outdated ({stats.outdatedOpen})</option>
                    </select>
                </label>
                <label className="field-select">
                    <span className="field-label">Agent</span>
                    <select value={params.get('inv') ?? ''} onChange={e => setSingle('inv', e.target.value)}>
                        <option value="">Any</option>
                        <option value="close">Proposes close ({meta.investigations.proposedClose ?? 0})</option>
                        <option value="done">Investigated ({meta.investigations.total})</option>
                        <option value="none">Not investigated</option>
                    </select>
                </label>
            </div>

            <div className="group-title">Recommendation</div>
            <div className="pills">
                {stats.enums.recommendation.map(rec => {
                    const n = stats.counts.rec[rec] ?? 0;
                    const on = selectedRecs.includes(rec);
                    if (!n && !on) return null;
                    return (
                        <button
                            key={rec}
                            className={`pill${on ? ' on' : ''}`}
                            onClick={() => toggleMulti('rec', rec)}
                            title={`${humanize(rec)}: ${n} open issues`}
                        >
                            <span className={`pill-dot rec-${rec.startsWith('close_') ? 'close' : rec}`} />
                            {humanize(rec)}
                            <span className="pill-count">{n}</span>
                        </button>
                    );
                })}
            </div>

            <div className="select-grid">
                {FILTER_SELECTS.map(f => (
                    <label key={f.key} className="field-select">
                        <span className="field-label">{f.title}</span>
                        <select value={params.get(f.key) ?? ''} onChange={e => setSingle(f.key, e.target.value)}>
                            <option value="">Any</option>
                            {stats.enums[f.enumKey].map(v => (
                                <option key={v} value={v}>
                                    {humanize(v)} ({stats.counts[f.key][v] ?? 0})
                                </option>
                            ))}
                        </select>
                    </label>
                ))}
            </div>
            <div className="muted small hint-line" title={`Prompt version ${stats.promptVersion}`}>
                {stats.analyzedOpen} of {meta.totals.open} open issues analyzed · ${stats.totalCostUsd.toFixed(2)} spent
            </div>
        </>
    );
}

// ---------- Batch analysis of the current filter ----------

const EST_COST_PER_ISSUE = 0.03;

export function AnalyzeBatchButton({ filter, onProgress }: { filter: string; onProgress: () => void }) {
    const [status, setStatus] = useState<AnalyzeStatus | null>(null);
    const [pending, setPending] = useState<number | null>(null);

    useEffect(() => {
        fetch('/api/analyze')
            .then(r => r.json() as Promise<AnalyzeStatus>)
            .then(setStatus)
            .catch(() => {});
    }, []);

    // How many issues in the current filter still need analysis.
    useEffect(() => {
        if (status?.running) return;
        const ctrl = new AbortController();
        fetch(`/api/analyze?preview=1&${filter}`, { signal: ctrl.signal })
            .then(r => r.json() as Promise<{ count: number }>)
            .then(r => setPending(r.count))
            .catch(() => {});
        return () => ctrl.abort();
    }, [filter, status?.running]);

    useEffect(() => {
        if (!status?.running) return;
        const t = setTimeout(async () => {
            const next = (await (await fetch('/api/analyze')).json()) as AnalyzeStatus;
            if (next.done + next.failed !== status.done + status.failed || !next.running) onProgress();
            setStatus(next);
        }, 2000);
        return () => clearTimeout(t);
    }, [status, onProgress]);

    const start = async () => {
        if (!pending) return;
        const est = (pending * EST_COST_PER_ISSUE).toFixed(2);
        if (!(await confirmDialog(`Analyze ${pending} issues with Claude? Estimated cost ~$${est}.`, { confirmLabel: 'Analyze' }))) return;
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filter }),
        });
        setStatus((await res.json()) as AnalyzeStatus);
    };

    if (status?.running) {
        return (
            <span className="muted small" title={status.lastMessage ?? ''}>
                Analyzing {status.done + status.failed}/{status.total}
                {status.failed > 0 && `, ${status.failed} failed`}…
            </span>
        );
    }
    return (
        <button
            className="small-button"
            disabled={!pending}
            onClick={start}
            title="Analyze issues in this view that have no up-to-date analysis"
        >
            {pending ? `Analyze ${pending}` : 'All analyzed'}
        </button>
    );
}
