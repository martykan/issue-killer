import { useMemo } from 'react';
import { AnalyzeBatchButton, RecBadge } from './Analysis.tsx';
import { VerdictBadge } from './Investigation.tsx';
import type { UpdateParams } from './App.tsx';
import type { IssueList, Meta } from './types.ts';
import { LabelChip, timeAgo } from './util.tsx';

type Props = {
    list: { data: IssueList | null; loading: boolean; error: string | null };
    meta: Meta | null;
    params: URLSearchParams;
    update: UpdateParams;
    selected: number | null;
    onSelect: (n: number) => void;
    onAnalyzed: () => void;
};

const SORT_OPTIONS: [string, string][] = [
    ['updated', 'Recently updated'],
    ['updated_asc', 'Least recently updated'],
    ['created', 'Newest'],
    ['created_asc', 'Oldest'],
    ['comments', 'Most comments'],
    ['reactions', 'Most reactions'],
    ['severity', 'Severity (Claude)'],
];

export function IssueListPane({ list, meta, params, update, selected, onSelect, onAnalyzed }: Props) {
    const batchFilter = useMemo(() => {
        const p = new URLSearchParams(params);
        for (const k of ['issue', 'page', 'sort']) p.delete(k);
        return p.toString();
    }, [params]);
    const labelColors = useMemo(() => new Map(meta?.labels.map(l => [l.name, l.color])), [meta]);
    const signalLabels = useMemo(() => new Map(meta?.signals.map(s => [s.key, s])), [meta]);
    const { data, loading, error } = list;
    const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

    const goToPage = (page: number) => {
        update(p => (page > 1 ? p.set('page', String(page)) : p.delete('page')), { keepPage: true });
        document.querySelector('.list-body')?.scrollTo(0, 0);
    };

    return (
        <main className="list">
            <div className="list-header">
                <span>
                    {data ? <strong>{data.total.toLocaleString()}</strong> : '…'} {data?.total === 1 ? 'issue' : 'issues'}
                    {loading && <span className="muted"> · loading</span>}
                </span>
                <span className="grow" />
                <AnalyzeBatchButton filter={batchFilter} onProgress={onAnalyzed} />
                <select
                    value={params.get('sort') ?? 'updated'}
                    onChange={e => update(p => (e.target.value === 'updated' ? p.delete('sort') : p.set('sort', e.target.value)))}
                >
                    {SORT_OPTIONS.map(([v, l]) => (
                        <option key={v} value={v}>
                            {l}
                        </option>
                    ))}
                </select>
            </div>
            {error && <div className="error">{error}</div>}
            <div className={`list-body${loading ? ' dim' : ''}`}>
                {data?.items.map(issue => (
                    <div
                        key={issue.number}
                        id={`issue-${issue.number}`}
                        className={`issue-row${issue.number === selected ? ' selected' : ''}`}
                        onClick={() => onSelect(issue.number)}
                    >
                        <div className="issue-row-title">
                            <span className={`state-icon ${issue.state.toLowerCase()}`} title={issue.stateReason ?? issue.state} />
                            <span className="title">{issue.title}</span>
                        </div>
                        <div className="issue-row-meta">
                            <span className="muted">
                                #{issue.number} · {issue.issueType ?? 'untyped'} · by {issue.author ?? 'ghost'} · updated{' '}
                                {timeAgo(issue.updatedAt)}
                                {issue.commentsCount > 0 && ` · 💬 ${issue.commentsCount}`}
                                {issue.reactionsCount > 0 && ` · 👍 ${issue.reactionsCount}`}
                                {issue.assignees.length > 0 && ` · → ${issue.assignees.join(', ')}`}
                            </span>
                        </div>
                        {issue.analysis && <div className="issue-row-summary">{issue.analysis.summary}</div>}
                        <div className="issue-row-tags">
                            {(issue.project.Team || issue.project.Status) && (
                                <span className="project-chip" title={Object.entries(issue.project).map(([k, v]) => `${k}: ${v}`).join('\n')}>
                                    {[issue.project.Team, issue.project.Status, issue.project.Priority].filter(Boolean).join(' · ')}
                                </span>
                            )}
                            {issue.investigation && (
                                <VerdictBadge
                                    verdict={issue.investigation.verdict}
                                    proposedAction={issue.investigation.proposedAction}
                                    confidence={issue.investigation.confidence}
                                />
                            )}
                            {issue.analysis && (
                                <>
                                    <RecBadge rec={issue.analysis.recommendation} confidence={issue.analysis.confidence} />
                                    <span className="owner-chip" title="Owner team suggested by Claude">
                                        {issue.analysis.ownerTeam}
                                    </span>
                                </>
                            )}
                            {issue.signals
                                .filter(s => !signalLabels.get(s)?.weak)
                                .map(s => (
                                    <span key={s} className={`signal sig-${s}`} title={signalLabels.get(s)?.description}>
                                        {signalLabels.get(s)?.label ?? s}
                                    </span>
                                ))}
                            {issue.labels.map(l => (
                                <LabelChip key={l} name={l} color={labelColors.get(l)} />
                            ))}
                        </div>
                    </div>
                ))}
                {data && data.items.length === 0 && <div className="empty muted">No issues match these filters.</div>}
            </div>
            {data && pages > 1 && (
                <div className="pager">
                    <button disabled={data.page <= 1} onClick={() => goToPage(data.page - 1)}>
                        ← Prev
                    </button>
                    <span className="muted">
                        Page {data.page} / {pages}
                    </span>
                    <button disabled={data.page >= pages} onClick={() => goToPage(data.page + 1)}>
                        Next →
                    </button>
                </div>
            )}
        </main>
    );
}
