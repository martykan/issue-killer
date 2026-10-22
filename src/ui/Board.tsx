import { useMemo, useState } from 'react';
import type { UpdateParams } from './App.tsx';
import type { Meta } from './types.ts';
import { saveSettings } from './settings.ts';
import { Markdown, runJob, timeAgo, useFetch } from './util.tsx';

type IssueCard = {
    kind: 'issue';
    number: number;
    title: string;
    url: string;
    status: string | null;
    priority: string | null;
    release: string | null;
    labels: string[];
    updatedAt: string;
};

type PullCard = {
    kind: 'pr';
    number: number;
    title: string;
    url: string;
    draft: boolean;
    reviewDecision: string | null;
    ci: string | null;
    conflicting: boolean;
    approvedBy: string[];
    changesRequestedBy: string[];
    requested: string[];
    additions: number;
    deletions: number;
    createdAt: string;
    updatedAt: string;
    issues: { number: number; title: string }[];
};

type Card = IssueCard | PullCard;
type Column = 'todo' | 'wip' | 'review';

type Board = {
    team: { slug: string; name: string };
    members: {
        login: string;
        columns: Record<Column, Card[]>;
        reviewing: { number: number; title: string; url: string; author: string | null; updatedAt: string }[];
    }[];
    lastSyncAt: string | null;
    summary: Summary | null;
};

type Summary = {
    team: { headline: string; summary: string; highlights: string[]; risks: string[]; next_steps: { action: string; owner: string | null }[] };
    members: { login: string; status: string; next_steps: string[] }[];
    model: string;
    costUsd: number | null;
    generatedAt: string;
};

const REPO_URL = 'https://github.com/trezor/trezor-suite';
/** Makes #1234 references clickable (GitHub redirects /issues/N to the PR when N is a PR). */
const linkRefs = (text: string) => text.replace(/(^|[^\w[/])#(\d{2,6})\b/g, (_, pre, n) => `${pre}[#${n}](${REPO_URL}/issues/${n})`);
const Md = ({ text }: { text: string }) => <Markdown source={linkRefs(text)} />;

const COLUMNS: { key: Column; label: string; hint: string }[] = [
    { key: 'todo', label: 'To do', hint: 'Assigned issues with project status To do / Blocked / not set, and no open PR' },
    { key: 'wip', label: 'In progress', hint: 'Draft PRs, and assigned issues "In progress" without a PR' },
    { key: 'review', label: 'In review', hint: 'PRs ready for review, and assigned issues in review / QA without a PR' },
];

const CARDS_SHOWN = 5;
const STALE_DAYS = 14;

const daysSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86_400_000;

export function BoardView({ meta, params, update, reloadKey }: { meta: Meta | null; params: URLSearchParams; update: UpdateParams; reloadKey: number }) {
    // URL > your GitHub team (Settings) > server default.
    const team = params.get('bteam') ?? meta?.settings.myTeam ?? '';
    const [summaryKey, setSummaryKey] = useState(0);
    const { data, error, loading } = useFetch<Board>(`/api/board?team=${encodeURIComponent(team)}`, `${reloadKey}-${summaryKey}`);
    const [summarizing, setSummarizing] = useState(false);
    const [summaryError, setSummaryError] = useState<string | null>(null);
    const summarize = async () => {
        setSummarizing(true);
        setSummaryError(null);
        try {
            await runJob(`/api/board/summary?team=${encodeURIComponent(data?.team.slug ?? team)}`);
            setSummaryKey(k => k + 1);
        } catch (err) {
            setSummaryError(String((err as Error).message ?? err));
        } finally {
            setSummarizing(false);
        }
    };

    const setTeam = (slug: string) => {
        void saveSettings({ myTeam: slug });
        update(p => p.set('bteam', slug), { keepPage: true });
    };
    const openIssue = (n: number) =>
        update(
            p => {
                p.delete('view');
                p.set('issue', String(n));
            },
            { push: true },
        );

    const totals = useMemo(() => {
        const t = { todo: 0, wip: 0, review: 0 };
        for (const m of data?.members ?? []) for (const c of COLUMNS) t[c.key] += m.columns[c.key].length;
        return t;
    }, [data]);

    return (
        <div className="board">
            <header className="board-head">
                <div>
                    <h2>Board</h2>
                    <div className="muted small">
                        Assigned issues and open PRs per person{data?.lastSyncAt && ` · synced ${timeAgo(data.lastSyncAt)}`}
                    </div>
                </div>
                <span className="grow" />
                <button className="small-button" onClick={summarize} disabled={summarizing || !data} title="Claude writes a team summary and next steps per person (~30s)">
                    {summarizing ? (
                        <>
                            <span className="spinner" /> Summarizing…
                        </>
                    ) : data?.summary ? (
                        '✨ Refresh summary'
                    ) : (
                        '✨ Summarize'
                    )}
                </button>
                <select value={data?.team.slug ?? team} onChange={e => setTeam(e.target.value)} title="GitHub team whose members are shown (remembered as your team)">
                    {meta?.teams.map(t => (
                        <option key={t.slug} value={t.slug}>
                            {t.name} ({t.members})
                        </option>
                    ))}
                </select>
            </header>
            {error && <div className="error">{error}</div>}
            {summaryError && <div className="error">Summary failed: {summaryError}</div>}
            {loading && !data && <div className="muted">Loading…</div>}
            {data?.summary && <TeamSummary summary={data.summary} />}
            {data && (
                <div className="board-grid">
                    <div className="board-colhead" />
                    {COLUMNS.map(c => (
                        <div key={c.key} className="board-colhead" title={c.hint}>
                            {c.label} <span className="muted">{totals[c.key]}</span>
                        </div>
                    ))}
                    {data.members.map(m => (
                        <MemberRow key={m.login} member={m} openIssue={openIssue} note={data.summary?.members.find(s => s.login === m.login)} />
                    ))}
                </div>
            )}
        </div>
    );
}

function TeamSummary({ summary }: { summary: Summary }) {
    return (
        <section className="exec-summary">
            <div className="exec-head">
                <strong className="exec-headline">{summary.team.headline}</strong>
                <span className="grow" />
                <span className="muted small">
                    ✨ {summary.model} · {timeAgo(summary.generatedAt)}
                    {summary.costUsd != null && ` · $${summary.costUsd.toFixed(2)}`}
                </span>
            </div>
            <Md text={summary.team.summary} />
            <div className="exec-grid">
                <div>
                    <h3>Next steps</h3>
                    <ol>
                        {summary.team.next_steps.map((s, i) => (
                            <li key={i}>
                                {s.owner && <span className="owner">{s.owner}</span>}
                                <Md text={s.action} />
                            </li>
                        ))}
                    </ol>
                </div>
                <div>
                    {summary.team.risks.length > 0 && (
                        <>
                            <h3>Risks & bottlenecks</h3>
                            <ul>
                                {summary.team.risks.map((r, i) => (
                                    <li key={i}>
                                        <Md text={r} />
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {summary.team.highlights.length > 0 && (
                        <>
                            <h3>Highlights</h3>
                            <ul>
                                {summary.team.highlights.map((h, i) => (
                                    <li key={i}>
                                        <Md text={h} />
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            </div>
        </section>
    );
}

function MemberRow({
    member,
    openIssue,
    note,
}: {
    member: Board['members'][number];
    openIssue: (n: number) => void;
    note?: Summary['members'][number];
}) {
    const [showReviews, setShowReviews] = useState(false);
    const prs = COLUMNS.reduce((n, c) => n + member.columns[c.key].filter(x => x.kind === 'pr').length, 0);
    const issues = COLUMNS.reduce((n, c) => n + member.columns[c.key].filter(x => x.kind === 'issue').length, 0);
    return (
        <>
            {note && (
                <div className="member-note">
                    <span className="member-note-login">✨ {member.login}</span>
                    <Md text={note.status} />
                    {note.next_steps.length > 0 && (
                        <ul>
                            {note.next_steps.map((s, i) => (
                                <li key={i}>
                                    <Md text={s} />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
            <div className="board-member">
                <div className="member-id">
                    <img className="avatar" src={`https://github.com/${member.login}.png?size=64`} alt="" />
                    <a href={`https://github.com/${member.login}`} target="_blank" rel="noreferrer" className="member-login">
                        {member.login}
                    </a>
                </div>
                <div className="muted small">
                    {issues} issues · {prs} PRs
                </div>
                {member.reviewing.length > 0 && (
                    <button className="link small" onClick={() => setShowReviews(s => !s)} title="Ready-for-review PRs where this person is a requested reviewer">
                        👀 {member.reviewing.length} reviews requested {showReviews ? '▾' : '▸'}
                    </button>
                )}
                {showReviews && (
                    <ul className="review-list">
                        {member.reviewing.map(r => (
                            <li key={r.number}>
                                <a href={r.url} target="_blank" rel="noreferrer">
                                    #{r.number} {r.title}
                                </a>{' '}
                                <span className="muted">by {r.author} · {timeAgo(r.updatedAt)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            {COLUMNS.map(c => (
                <Cell key={c.key} cards={member.columns[c.key]} openIssue={openIssue} />
            ))}
        </>
    );
}

function Cell({ cards, openIssue }: { cards: Card[]; openIssue: (n: number) => void }) {
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? cards : cards.slice(0, CARDS_SHOWN);
    return (
        <div className="board-cell">
            {shown.map(c => (c.kind === 'pr' ? <PrCard key={`pr${c.number}`} pr={c} openIssue={openIssue} /> : <IssueCardView key={`i${c.number}`} issue={c} openIssue={openIssue} />))}
            {cards.length > CARDS_SHOWN && (
                <button className="link small" onClick={() => setExpanded(e => !e)}>
                    {expanded ? 'Show less' : `+ ${cards.length - CARDS_SHOWN} more`}
                </button>
            )}
        </div>
    );
}

function IssueCardView({ issue, openIssue }: { issue: IssueCard; openIssue: (n: number) => void }) {
    return (
        <div className="bcard" onClick={() => openIssue(issue.number)} title="Open in Issues">
            <div className="bcard-title">
                <span className="kind-icon issue" />
                <span>
                    <span className="muted">#{issue.number}</span> {issue.title}
                </span>
            </div>
            <div className="bcard-meta">
                {issue.priority && <span className="tag">{issue.priority}</span>}
                {issue.status && /blocked/i.test(issue.status) && <span className="tag tag-bad">{issue.status}</span>}
                {issue.release && <span className="tag">{issue.release}</span>}
                <span className="muted">{timeAgo(issue.updatedAt)}</span>
            </div>
        </div>
    );
}

function PrCard({ pr, openIssue }: { pr: PullCard; openIssue: (n: number) => void }) {
    const stale = daysSince(pr.updatedAt) > STALE_DAYS;
    const review = pr.draft
        ? null
        : pr.changesRequestedBy.length
          ? { cls: 'tag-bad', text: `Changes requested · ${pr.changesRequestedBy.join(', ')}` }
          : pr.reviewDecision === 'APPROVED'
            ? { cls: 'tag-good', text: `Approved · ${pr.approvedBy.join(', ')}` }
            : pr.requested.length
              ? { cls: 'tag-wait', text: `Waiting on ${pr.requested.map(r => r.replace('team:', '@')).join(', ')}` }
              : { cls: 'tag-wait', text: 'No reviewer' };
    const ci = pr.ci === 'SUCCESS' ? ['ci-ok', 'CI passing'] : pr.ci === 'FAILURE' || pr.ci === 'ERROR' ? ['ci-bad', 'CI failing'] : pr.ci ? ['ci-wait', 'CI running'] : null;
    return (
        <div className={`bcard pr${stale ? ' stale' : ''}`}>
            <div className="bcard-title">
                <span className={`kind-icon ${pr.draft ? 'pr-draft' : 'pr-open'}`} title={pr.draft ? 'Draft PR' : 'Open PR'} />
                <a href={pr.url} target="_blank" rel="noreferrer">
                    <span className="muted">#{pr.number}</span> {pr.title}
                </a>
            </div>
            <div className="bcard-meta">
                {review && <span className={`tag ${review.cls}`}>{review.text}</span>}
                {ci && (
                    <span className={`ci ${ci[0]}`} title={ci[1]}>
                        ● {ci[1]}
                    </span>
                )}
                {pr.conflicting && <span className="tag tag-bad">Conflicts</span>}
                <span className="muted diffstat">
                    <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>
                </span>
                <span className="muted" title={`Opened ${new Date(pr.createdAt).toLocaleDateString()}`}>
                    {stale ? `stale · ${timeAgo(pr.updatedAt)}` : timeAgo(pr.updatedAt)}
                </span>
            </div>
            {pr.issues.length > 0 && (
                <div className="bcard-issues">
                    {pr.issues.map(i => (
                        <button key={i.number} className="link small" onClick={() => openIssue(i.number)} title={i.title}>
                            closes #{i.number} {i.title}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
