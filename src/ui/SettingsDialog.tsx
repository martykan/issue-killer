import { useEffect, useState } from 'react';
import { saveSettings } from './settings.ts';
import { CheckList } from './SetupWizard.tsx';
import type { HealthCheck, Meta } from './types.ts';

export function SettingsDialog({ meta, onClose, onSaved, onOpenWizard }: { meta: Meta; onClose: () => void; onSaved: () => void; onOpenWizard: () => void }) {
    const [myTeam, setMyTeam] = useState(meta.settings.myTeam ?? '');
    const [myProjectTeam, setMyProjectTeam] = useState(meta.settings.myProjectTeam ?? '');
    const [conductorRepoPath, setConductorRepoPath] = useState(meta.settings.conductorRepoPath ?? '');
    const [checks, setChecks] = useState<HealthCheck[] | null>(null);
    const [checking, setChecking] = useState(false);
    const [saving, setSaving] = useState(false);
    const projectTeams = meta.projects.flatMap(p => p.fields.find(f => f.name === 'Team')?.options ?? []);

    const check = async () => {
        setChecking(true);
        try {
            setChecks((await (await fetch('/api/health')).json()) as HealthCheck[]);
        } finally {
            setChecking(false);
        }
    };
    useEffect(() => {
        void check();
    }, []);

    const save = async () => {
        setSaving(true);
        try {
            await saveSettings({ myTeam: myTeam || null, myProjectTeam: myProjectTeam || null, conductorRepoPath: conductorRepoPath.trim() || null });
            onSaved();
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal settings-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                <h2>Settings</h2>
                <p className="muted small">
                    Settings of {meta.repo ?? 'this repository'} – shared by the app, the browser UI and the CLI.
                </p>

                <h3>Your team</h3>
                <div className="settings-grid">
                    <label className="field-select">
                        <span className="field-label">GitHub team (Board rows, "relevance to my team" in triage)</span>
                        <select value={myTeam} onChange={e => setMyTeam(e.target.value)}>
                            <option value="">Not set</option>
                            {meta.teams.map(t => (
                                <option key={t.slug} value={t.slug}>
                                    {t.name} ({t.members})
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field-select">
                        <span className="field-label">Project team (Issues scope, Plan view)</span>
                        <select value={myProjectTeam} onChange={e => setMyProjectTeam(e.target.value)}>
                            <option value="">Not set</option>
                            {projectTeams.map(t => (
                                <option key={t.value} value={t.value}>
                                    {t.value} ({t.count} open)
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                {myTeam !== (meta.settings.myTeam ?? '') && meta.analysis.analyzedOpen > 0 && (
                    <p className="muted small">Changing the GitHub team marks existing Claude analyses as outdated (relevance is judged for your team).</p>
                )}

                <h3>Conductor handoff</h3>
                <label className="field-select">
                    <span className="field-label">Root path of {meta.repo ?? 'the repository'} as added in Conductor (Settings → Repositories there)</span>
                    <input
                        className="search"
                        value={conductorRepoPath}
                        onChange={e => setConductorRepoPath(e.target.value)}
                        placeholder="empty = the repository's local folder, else Conductor's first repository"
                    />
                </label>

                <h3>
                    Setup check
                    <button className="link small" onClick={check} disabled={checking}>
                        {checking ? 'checking…' : 're-check'}
                    </button>
                </h3>
                {!checks && <p className="muted small">Checking tools and data…</p>}
                {checks && <CheckList checks={checks} />}

                <div className="modal-actions">
                    <button className="link small" onClick={onOpenWizard}>
                        Run setup wizard
                    </button>
                    <span className="grow" />
                    <button className="small-button" onClick={onClose}>
                        Cancel
                    </button>
                    <button className="primary-button" onClick={save} disabled={saving}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
