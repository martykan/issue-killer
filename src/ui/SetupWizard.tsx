import { useCallback, useEffect, useState } from 'react';
import { saveSettings } from './settings.ts';
import type { HealthCheck, Meta, SyncStatus } from './types.ts';
import { runJob } from './util.tsx';

type ProjectChoice = { number: number; title: string };
type SetupInfo = { repo: string | null; defaultRepo: string; projects: number[]; issues: number; repoPath: string; hasCheckout: boolean };

const STEPS = ['Tools', 'Data', 'Your team', 'Code checkout'] as const;
const TOOL_CHECKS = ['bun', 'gh', 'github-auth', 'github-project-write', 'claude', 'git'];
const ICON = { ok: '✓', warn: '!', error: '✗' } as const;

/** First-start walkthrough: tools & auth → first sync → team → optional code checkout. */
export function SetupWizard({ meta, onDataChanged, onClose }: { meta: Meta | null; onDataChanged: () => void; onClose: () => void }) {
    const [step, setStep] = useState(0);
    const [info, setInfo] = useState<SetupInfo | null>(null);
    const loadInfo = useCallback(async () => setInfo((await (await fetch('/api/setup')).json()) as SetupInfo), []);
    useEffect(() => {
        void loadInfo();
    }, [loadInfo]);

    const finish = async () => {
        await saveSettings({ setupDone: true });
        onDataChanged();
        onClose();
    };

    return (
        <div className="modal-backdrop">
            <div className="modal wizard" role="dialog" aria-modal="true">
                <div className="wizard-head">
                    <h2>Welcome to Issue Killer</h2>
                    <button className="link small" onClick={finish} title="You can rerun setup from Settings">
                        Skip setup
                    </button>
                </div>
                <ol className="wizard-steps">
                    {STEPS.map((s, i) => (
                        <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
                            <button className="link" onClick={() => setStep(i)}>
                                {i < step ? '✓' : i + 1}. {s}
                            </button>
                        </li>
                    ))}
                </ol>
                <div className="wizard-body">
                    {step === 0 && <ToolsStep onNext={() => setStep(1)} />}
                    {step === 1 && info && (
                        <DataStep
                            info={info}
                            onSynced={() => {
                                void loadInfo();
                                onDataChanged();
                            }}
                            onNext={() => setStep(2)}
                        />
                    )}
                    {step === 2 && <TeamStep meta={meta} onNext={() => setStep(3)} onSaved={onDataChanged} />}
                    {step === 3 && info && <CheckoutStep info={info} onDone={finish} onCloned={loadInfo} />}
                </div>
            </div>
        </div>
    );
}

function ToolsStep({ onNext }: { onNext: () => void }) {
    const [checks, setChecks] = useState<HealthCheck[] | null>(null);
    const [checking, setChecking] = useState(false);
    const check = async () => {
        setChecking(true);
        try {
            const all = (await (await fetch('/api/health')).json()) as HealthCheck[];
            setChecks(all.filter(c => TOOL_CHECKS.includes(c.id)));
        } finally {
            setChecking(false);
        }
    };
    useEffect(() => {
        void check();
    }, []);
    const blocking = checks?.filter(c => c.status === 'error') ?? [];
    return (
        <>
            <p>
                Issue Killer runs locally and uses your own tools: the <b>GitHub CLI</b> (or a <code>GITHUB_TOKEN</code>) to read
                issues, and the <b>Claude Code CLI</b> for analysis. No credentials are stored by the app.
            </p>
            {!checks && <p className="muted">Checking…</p>}
            {checks && <CheckList checks={checks} />}
            <div className="modal-actions">
                <button className="small-button" onClick={check} disabled={checking}>
                    {checking ? 'Checking…' : 'Re-check'}
                </button>
                <button className="primary-button" onClick={onNext} disabled={!checks || blocking.length > 0} title={blocking.length ? 'Fix the ✗ items first' : undefined}>
                    Continue
                </button>
            </div>
        </>
    );
}

export function CheckList({ checks }: { checks: HealthCheck[] }) {
    return (
        <ul className="checks">
            {checks.map(c => (
                <li key={c.id} className={`check-${c.status}`} title={`Needed for: ${c.needed}`}>
                    <span className="check-icon">{ICON[c.status]}</span>
                    <span className="check-label">{c.label}</span>
                    <span className="check-detail">{c.detail}</span>
                    {c.fix && (
                        <code className="check-fix" onClick={() => void navigator.clipboard?.writeText(c.fix!)} title="Click to copy">
                            {c.fix}
                        </code>
                    )}
                </li>
            ))}
        </ul>
    );
}

function DataStep({ info, onSynced, onNext }: { info: SetupInfo; onSynced: () => void; onNext: () => void }) {
    const [repo, setRepo] = useState(info.repo ?? info.defaultRepo);
    const [project, setProject] = useState(info.projects[0] ? String(info.projects[0]) : '');
    const [choices, setChoices] = useState<ProjectChoice[]>([]);
    const [choicesError, setChoicesError] = useState<string | null>(null);
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [continueAfterSync, setContinueAfterSync] = useState(false);

    // Projects linked to the repo; preselect the biggest one unless the configured project is among them.
    useEffect(() => {
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo.trim())) return;
        const t = setTimeout(async () => {
            const body = (await (await fetch(`/api/setup/projects?repo=${encodeURIComponent(repo.trim())}`)).json()) as ProjectChoice[] | { error: string };
            setChoices(Array.isArray(body) ? body : []);
            setChoicesError(Array.isArray(body) ? null : body.error);
            if (Array.isArray(body) && body[0] && !body.some(p => info.projects.includes(p.number))) setProject(String(body[0].number));
        }, 400);
        return () => clearTimeout(t);
    }, [repo, info.projects]);

    useEffect(() => {
        if (!status?.running) return;
        const t = setTimeout(async () => {
            const next = (await (await fetch('/api/sync')).json()) as SyncStatus;
            setStatus(next);
            if (!next.running) {
                if (next.error) setError(next.error);
                else {
                    onSynced();
                    if (continueAfterSync) onNext();
                }
            }
        }, 1500);
        return () => clearTimeout(t);
    }, [status, onSynced, onNext, continueAfterSync]);

    // The project is saved by syncing it; the team step needs its fields.
    const projects = project ? [Number(project)] : [];
    const projectChanged = projects.join() !== info.projects.join();
    const start = async (thenContinue = false) => {
        setError(null);
        setContinueAfterSync(thenContinue);
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: repo.trim(), projects }),
        });
        setStatus((await res.json()) as SyncStatus);
    };

    const synced = info.issues > 0;
    return (
        <>
            <p>
                Issues, comments, linked PRs, org teams and GitHub Project fields are copied into a local SQLite database. The first
                sync of a big repo takes ~15 minutes; later syncs only fetch changes.
            </p>
            <div className="settings-grid">
                <label className="field-select">
                    <span className="field-label">Repository</span>
                    <input className="search" value={repo} onChange={e => setRepo(e.target.value)} disabled={!!info.repo} />
                </label>
                <label className="field-select">
                    <span className="field-label">GitHub Project (Team/Status/Priority fields)</span>
                    <select value={project} onChange={e => setProject(e.target.value)}>
                        <option value="">None</option>
                        {choices.map(p => (
                            <option key={p.number} value={p.number}>
                                {p.title} (#{p.number})
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {choicesError && <p className="muted small">Couldn't list the repo's projects: {choicesError}</p>}
            {synced && !status?.running && <p className="ok-line">✓ {info.issues.toLocaleString()} issues synced.</p>}
            {status?.running && (
                <p className="muted">
                    <span className="spinner" /> {status.progress ?? 'Syncing…'}
                </p>
            )}
            {error && <p className="error">Sync failed: {error}</p>}
            <div className="modal-actions">
                <button className={synced ? 'small-button' : 'primary-button'} onClick={() => start()} disabled={!!status?.running || !repo.includes('/')}>
                    {synced ? 'Sync again' : 'Start first sync'}
                </button>
                <button
                    className={synced ? 'primary-button' : 'small-button'}
                    onClick={synced && projectChanged ? () => start(true) : onNext}
                    disabled={!!status?.running}
                >
                    {!synced ? 'Continue without data' : projectChanged ? 'Sync & continue' : 'Continue'}
                </button>
            </div>
        </>
    );
}

function TeamStep({ meta, onNext, onSaved }: { meta: Meta | null; onNext: () => void; onSaved: () => void }) {
    const [myTeam, setMyTeam] = useState(meta?.settings.myTeam ?? '');
    const [myProjectTeam, setMyProjectTeam] = useState(meta?.settings.myProjectTeam ?? '');
    const projectTeams = meta?.projects.flatMap(p => p.fields.find(f => f.name === 'Team')?.options ?? []) ?? [];
    const save = async () => {
        await saveSettings({ myTeam: myTeam || null, myProjectTeam: myProjectTeam || null });
        onSaved();
        onNext();
    };
    return (
        <>
            <p>Pick your team. It sets the defaults for the Board, Plan and Issues views and what “relevant to my team” means in Claude's triage. You can change it any time in Settings.</p>
            <div className="settings-grid">
                <label className="field-select">
                    <span className="field-label">GitHub team</span>
                    <select value={myTeam} onChange={e => setMyTeam(e.target.value)}>
                        <option value="">{meta?.teams.length ? 'Not set' : 'No org teams synced'}</option>
                        {meta?.teams.map(t => (
                            <option key={t.slug} value={t.slug}>
                                {t.name} ({t.members})
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field-select">
                    <span className="field-label">Team in the GitHub Project</span>
                    <select value={myProjectTeam} onChange={e => setMyProjectTeam(e.target.value)}>
                        <option value="">{projectTeams.length ? 'Not set' : 'No project synced'}</option>
                        {projectTeams.map(t => (
                            <option key={t.value} value={t.value}>
                                {t.value} ({t.count} open)
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="modal-actions">
                <button className="primary-button" onClick={save}>
                    Continue
                </button>
            </div>
        </>
    );
}

function CheckoutStep({ info, onDone, onCloned }: { info: SetupInfo; onDone: () => void; onCloned: () => void }) {
    const [cloning, setCloning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const clone = async () => {
        setCloning(true);
        setError(null);
        try {
            await runJob('/api/setup/checkout');
            onCloned();
        } catch (err) {
            setError(String((err as Error).message ?? err));
        } finally {
            setCloning(false);
        }
    };
    return (
        <>
            <p>
                <b>Investigate</b> and <b>Ask with code</b> let a sandboxed, read-only Claude agent look at the code and git history. They
                need a local checkout of the repo (blob-less clone, ~800 MB). Optional – everything else works without it.
            </p>
            <p className="muted small">Location: {info.repoPath}</p>
            {info.hasCheckout && <p className="ok-line">✓ Checkout present.</p>}
            {cloning && (
                <p className="muted">
                    <span className="spinner" /> Cloning… (a minute or two)
                </p>
            )}
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
                {!info.hasCheckout && (
                    <button className="small-button" onClick={clone} disabled={cloning}>
                        Clone now
                    </button>
                )}
                <button className="primary-button" onClick={onDone} disabled={cloning}>
                    {info.hasCheckout ? 'Finish' : 'Skip & finish'}
                </button>
            </div>
        </>
    );
}
