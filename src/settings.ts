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

// Each workspace (repository) has its own DB and settings; cached per DB handle, refreshed on every update.
const cache = new WeakMap<Database, Settings>();

export function loadSettings(db: Database): Settings {
    const rows = db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings').all();
    const settings = { ...DEFAULTS };
    for (const r of rows) if ((KEYS as string[]).includes(r.key)) (settings as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    cache.set(db, settings);
    return settings;
}

export const getSettings = (db: Database): Settings => cache.get(db) ?? loadSettings(db);

export function updateSettings(db: Database, patch: Partial<Settings>): Settings {
    const upsert = db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    db.transaction(() => {
        for (const key of KEYS) if (key in patch) upsert.run(key, JSON.stringify(patch[key] ?? null));
    })();
    return loadSettings(db);
}
