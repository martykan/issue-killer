import { useEffect, useState } from 'react';
import type { UpdateParams } from './App.tsx';
import { saveSettings } from './settings.ts';
import type { Meta } from './types.ts';

const TEAM_FIELD = 'Team';

const currentTeam = (params: URLSearchParams) =>
    params.getAll('pf').find(v => v.startsWith(`${TEAM_FIELD}=`))?.slice(TEAM_FIELD.length + 1) ?? '';

/** Opening the issue list without any filters scopes it to your project team (Settings). */
export function useRememberedTeam(meta: Meta | null, params: URLSearchParams, update: UpdateParams) {
    const myTeam = meta?.settings.myProjectTeam;
    const [applied, setApplied] = useState(false);
    useEffect(() => {
        if (applied || meta === null) return;
        setApplied(true);
        if (myTeam && params.size === 0) update(p => p.append('pf', `${TEAM_FIELD}=${myTeam}`));
    }, [meta]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Quick "my team" scope for the issue list; same as the project Team filter in the sidebar. */
export function TeamSwitcher({ meta, params, update }: { meta: Meta | null; params: URLSearchParams; update: UpdateParams }) {
    const teams = meta?.projects.flatMap(p => p.fields.find(f => f.name === TEAM_FIELD)?.options ?? []) ?? [];
    // Only scopes the issue list; the Board and Teams views have their own team selection.
    if (!teams.length || params.has('view')) return null;
    const value = currentTeam(params);

    const set = (team: string) => {
        // Remember the choice as your project team.
        void saveSettings({ myProjectTeam: team || null });
        update(p => {
            const others = p.getAll('pf').filter(v => !v.startsWith(`${TEAM_FIELD}=`));
            p.delete('pf');
            for (const v of others) p.append('pf', v);
            if (team) p.append('pf', `${TEAM_FIELD}=${team}`);
        });
    };

    return (
        <select className="team-switcher" value={value} onChange={e => set(e.target.value)} title="Scope the issue list to a team (remembered)">
            <option value="">All teams</option>
            {teams.map(t => (
                <option key={t.value} value={t.value}>
                    {t.value} ({t.count})
                </option>
            ))}
        </select>
    );
}
