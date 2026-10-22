import { useEffect } from 'react';
import type { UpdateParams } from './App.tsx';
import type { Meta } from './types.ts';

const TEAM_FIELD = 'Team';
const STORAGE_KEY = 'issue-killer.team';

const currentTeam = (params: URLSearchParams) =>
    params.getAll('pf').find(v => v.startsWith(`${TEAM_FIELD}=`))?.slice(TEAM_FIELD.length + 1) ?? '';

export const rememberedTeam = () => localStorage.getItem(STORAGE_KEY);

/** Opening the app without any filters applies the last team picked in the switcher. */
export function useRememberedTeam(params: URLSearchParams, update: UpdateParams) {
    useEffect(() => {
        const remembered = localStorage.getItem(STORAGE_KEY);
        if (remembered && params.size === 0) update(p => p.append('pf', `${TEAM_FIELD}=${remembered}`));
        // Only on first load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}

/** Quick "my team" scope for the issue list; same as the project Team filter in the sidebar. */
export function TeamSwitcher({ meta, params, update }: { meta: Meta | null; params: URLSearchParams; update: UpdateParams }) {
    const teams = meta?.projects.flatMap(p => p.fields.find(f => f.name === TEAM_FIELD)?.options ?? []) ?? [];
    if (!teams.length || params.get('view') === 'teams') return null;
    const value = currentTeam(params);

    const set = (team: string) => {
        if (team) localStorage.setItem(STORAGE_KEY, team);
        else localStorage.removeItem(STORAGE_KEY);
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
