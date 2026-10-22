import type { Settings } from './types.ts';

/** Saves preferences server-side (shared by the browser UI, desktop app and CLI). */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(`Saving settings failed (HTTP ${res.status})`);
    return res.json() as Promise<Settings>;
}
