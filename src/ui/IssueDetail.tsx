import { Fragment, useEffect, useRef, useState } from 'react';
import { HandoffDialog } from './HandoffDialog.tsx';
import { AnalysisPanel } from './Analysis.tsx';
import { AskPanel } from './AskPanel.tsx';
import { InvestigationPanel } from './Investigation.tsx';
import type { UpdateParams } from './App.tsx';
import type { IssueDetail, Meta, PersonStatus } from './types.ts';
import { formatDate, LabelChip, Markdown, timeAgo, useFetch } from './util.tsx';

type Props = {
    number: number;
    meta: Meta | null;
    update: UpdateParams;
    reloadKey?: number;
    onClose: () => void;
    /** Called after the issue was changed on GitHub (e.g. closed) so lists can refresh. */
    onChanged?: () => void;
    onOpenSettings?: () => void;
};

export function IssueDetailPane({ number, meta, update, onClose, reloadKey, onChanged, onOpenSettings }: Props) {
    const [handoff, setHandoff] = useState(false);
    const { data: issue, loading, error } = useFetch<IssueDetail>(`/api/issues/${number}`, reloadKey);
    const scrollRef = useRef<HTMLDivElement>(null);
    const signals = new Map(meta?.signals.map(s => [s.key, s]));

    useEffect(() => {
        scrollRef.current?.scrollTo(0, 0);
    }, [number]);

    const openIssue = (n: number) => update(p => p.set('issue', String(n)), { keepPage: true, push: true });
    const filterBy = (key: string, value: string) =>
        update(p => {
            p.delete(key);
            p.append(key, value);
        });

    return (
        <section className="detail" ref={scrollRef}>
            {handoff && (
                <HandoffDialog
                    number={number}
                    onClose={() => setHandoff(false)}
                    onOpenSettings={() => {
                        setHandoff(false);
                        onOpenSettings?.();
                    }}
                />
            )}
            <div className="detail-toolbar">
                <span className="muted">#{number}</span>
                {loading && <span className="muted">loading…</span>}
                <span className="grow" />
                {issue && (
                    <button className="small-button" onClick={() => setHandoff(true)} title="Start a Conductor workspace for this issue">
                        → Conductor
                    </button>
                )}
                {issue && (
                    <a href={issue.url} target="_blank" rel="noreferrer">
                        Open on GitHub ↗
                    </a>
                )}
                <button className="link" onClick={onClose} title="Close (Esc)">
                    ✕
                </button>
            </div>
            {error && <div className="error">{error}</div>}
            {issue && (
                <div className="detail-body">
                    <h1>
                        {issue.title} <span className="muted">#{issue.number}</span>
                    </h1>
                    <div className="detail-meta">
                        <span className={`state-pill ${issue.state.toLowerCase()}`}>
                            {issue.state === 'OPEN' ? 'Open' : `Closed${issue.stateReason ? ` (${issue.stateReason.toLowerCase().replace('_', ' ')})` : ''}`}
                        </span>
                        <span>
                            <button className="link" onClick={() => filterBy('author', issue.author ?? '')}>
                                {issue.author ?? 'ghost'}
                            </button>{' '}
                            <StatusBadge status={issue.authorStatus} />{' '}
                            <span className="muted">opened {timeAgo(issue.createdAt)}</span>
                        </span>
                    </div>

                    <AnalysisPanel
                        number={issue.number}
                        initial={issue.analysis}
                        labels={meta?.labels}
                        currentLabels={issue.labels.map(l => l.name)}
                        onFilter={filterBy}
                    />
                    <InvestigationPanel
                        number={issue.number}
                        isOpen={issue.state === 'OPEN'}
                        initial={issue.investigation}
                        actions={issue.actions}
                        onOpenIssue={openIssue}
                        onClosed={() => onChanged?.()}
                        checkoutPath={meta?.checkoutPath}
                    />
                    <AskPanel number={issue.number} initial={issue.questions} />

                    <dl className="facts">
                        <dt>Type</dt>
                        <dd>{issue.issueType ?? <span className="muted">—</span>}</dd>
                        <dt>Assignees</dt>
                        <dd>
                            {issue.assignees.length ? (
                                issue.assignees.map(a => (
                                    <span key={a.login} className="assignee">
                                        {a.login}
                                        {a.status !== 'member' && <StatusBadge status={a.status} />}
                                    </span>
                                ))
                            ) : (
                                <span className="muted">—</span>
                            )}
                        </dd>
                        {issue.projects.map(p => (
                            <Fragment key={p.url}>
                                <dt>
                                    <a href={p.url} target="_blank" rel="noreferrer">
                                        {p.title}
                                    </a>
                                </dt>
                                <dd>
                                    {Object.entries(p.fields)
                                        .map(([k, v]) => `${k}: ${v}`)
                                        .join(' · ') || <span className="muted">no fields set</span>}
                                </dd>
                            </Fragment>
                        ))}
                        <dt>Milestone</dt>
                        <dd>{issue.milestone ?? <span className="muted">—</span>}</dd>
                        <dt>Updated</dt>
                        <dd title={formatDate(issue.updatedAt)}>{timeAgo(issue.updatedAt)}</dd>
                        {issue.closedAt && (
                            <>
                                <dt>Closed</dt>
                                <dd title={formatDate(issue.closedAt)}>{timeAgo(issue.closedAt)}</dd>
                            </>
                        )}
                        <dt>Reactions</dt>
                        <dd>
                            {issue.reactionsCount
                                ? `${issue.reactionsCount} total, ${issue.thumbsUpCount} 👍`
                                : <span className="muted">—</span>}
                        </dd>
                        <dt>Labels</dt>
                        <dd className="tags">
                            {issue.labels.length ? (
                                issue.labels.map(l => (
                                    <LabelChip key={l.name} name={l.name} color={l.color} onClick={() => filterBy('label', l.name)} />
                                ))
                            ) : (
                                <span className="muted">—</span>
                            )}
                        </dd>
                        {issue.parent && (
                            <>
                                <dt>Parent</dt>
                                <dd>
                                    <IssueLink issue={issue.parent} onOpen={openIssue} />
                                </dd>
                            </>
                        )}
                    </dl>

                    {issue.signals.length > 0 && (
                        <div className="signals-box">
                            {issue.signals.map(s => (
                                <div key={s}>
                                    <span className={`signal sig-${s}`}>{signals.get(s)?.label ?? s}</span>{' '}
                                    <span className="muted">{signals.get(s)?.description}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {issue.children.length > 0 && (
                        <div className="block">
                            <h3>Sub-issues ({issue.children.length})</h3>
                            {issue.children.map(c => (
                                <div key={c.number}>
                                    <IssueLink issue={c} onOpen={openIssue} />
                                </div>
                            ))}
                        </div>
                    )}

                    {issue.references.length > 0 && (
                        <div className="block">
                            <h3>Referenced by ({issue.references.length})</h3>
                            {issue.references.map(r => (
                                <div key={`${r.repo}#${r.number}`} className="ref">
                                    <span className={`ref-state ${(r.state ?? '').toLowerCase()}`}>{r.state?.toLowerCase()}</span>
                                    <span className="muted">{r.type === 'PullRequest' ? 'PR' : 'Issue'}</span>
                                    {r.url ? (
                                        <a href={r.url} target="_blank" rel="noreferrer">
                                            {r.repo === meta?.repo ? '' : r.repo}#{r.number} {r.title}
                                        </a>
                                    ) : (
                                        `${r.repo}#${r.number}`
                                    )}
                                    {r.willClose ? <span className="closes">closes</span> : null}
                                    {r.referencedAt && <span className="muted"> · {timeAgo(r.referencedAt)}</span>}
                                </div>
                            ))}
                        </div>
                    )}

                    <article className="comment">
                        <header>
                            <strong>{issue.author ?? 'ghost'}</strong>
                            <StatusBadge status={issue.authorStatus} />{' '}
                            <span className="muted" title={formatDate(issue.createdAt)}>
                                {timeAgo(issue.createdAt)}
                            </span>
                        </header>
                        <Markdown source={issue.body} />
                    </article>

                    {issue.comments.map(c => (
                        <article key={c.id} className={`comment${c.authorStatus === 'member' ? ' team' : ''}`}>
                            <header>
                                <strong>{c.author ?? 'ghost'}</strong>
                                <StatusBadge status={c.authorStatus} />{' '}
                                <a className="muted" href={c.url} target="_blank" rel="noreferrer" title={formatDate(c.createdAt)}>
                                    {timeAgo(c.createdAt)}
                                </a>
                                {c.reactionsCount > 0 && <span className="muted"> · {c.reactionsCount} reactions</span>}
                            </header>
                            <Markdown source={c.body} />
                        </article>
                    ))}
                    <p className="muted small">Synced {timeAgo(issue.syncedAt)}</p>
                </div>
            )}
        </section>
    );
}

function IssueLink({ issue, onOpen }: { issue: { number: number; title: string; state: string }; onOpen: (n: number) => void }) {
    return (
        <button className="link issue-link" onClick={() => onOpen(issue.number)}>
            <span className={`state-icon ${issue.state.toLowerCase()}`} /> #{issue.number} {issue.title}
        </button>
    );
}

const STATUS_LABELS: Record<PersonStatus, string> = {
    member: 'member',
    former: 'former member',
    bot: 'bot',
    external: 'external',
};

function StatusBadge({ status }: { status: PersonStatus | null }) {
    if (!status) return null;
    return <span className={`badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}
