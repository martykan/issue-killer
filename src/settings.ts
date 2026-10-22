import type { Database } from 'bun:sqlite';

/**
 * User preferences, stored in the DB so the CLI, the web UI and the desktop app share them. Nothing team-specific
 * is hardcoded: the "my team" choices drive defaults (Board, Plan, Issues scope) and the relevance question in triage.
 */
export type Settings = {
    /** GitHub org team slug the user belongs to / leads (e.g. "suite-wallet"). Board rows, triage relevance. */
    myTeam: string | null;
    /** Value of the project's Team field for that team (e.g. "Suite-Wallet 👛"). Issues scope, Plan view. */
    myProjectTeam: string | null;
    /** The first-start setup wizard was completed (or skipped). */
    setupDone: boolean;
    /** Root path of the repo as added in Conductor; targets "Hand off to Conductor" deep links. */
    conductorRepoPath: string | null;
};

const DEFAULTS: Settings = { myTeam: null, myProjectTeam: null, setupDone: false, conductorRepoPath: null };
const KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

// Loaded once per process (openDb) and on every update, so code without a DB handle can read it.
let cache: Settings = { ...DEFAULTS };

export function loadSettings(db: Database): Settings {
    const rows = db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings').all();
    cache = { ...DEFAULTS };
    for (const r of rows) if ((KEYS as string[]).includes(r.key)) (cache as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    return cache;
}

export const getSettings = (): Settings => cache;

export function updateSettings(db: Database, patch: Partial<Settings>): Settings {
    const upsert = db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    db.transaction(() => {
        for (const key of KEYS) if (key in patch) upsert.run(key, JSON.stringify(patch[key] ?? null));
    })();
    return loadSettings(db);
}
