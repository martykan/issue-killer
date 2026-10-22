import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveToken } from './github.ts';
import { getSettings } from './settings.ts';

/**
 * Setup check: are the tools this app shells out to installed and authenticated, and is there data?
 * Used by `bun run doctor` and the Settings dialog. Never prints secrets.
 */

export type CheckStatus = 'ok' | 'warn' | 'error';
export type Check = { id: string; label: string; status: CheckStatus; detail: string; fix?: string; needed: string };

const REQUIRED_SCOPES = ['repo', 'read:org', 'read:project'];

function run(cmd: string[]): { ok: boolean; out: string } {
    try {
        const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
        return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
    } catch {
        return { ok: false, out: 'not found' };
    }
}

async function githubCheck(): Promise<Check[]> {
    const checks: Check[] = [];
    const gh = run(['gh', '--version']);
    const usesEnvToken = !!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
    checks.push({
        id: 'gh',
        label: 'GitHub CLI',
        needed: 'Sync, closing issues (token source unless GITHUB_TOKEN is set)',
        status: gh.ok ? 'ok' : usesEnvToken ? 'warn' : 'error',
        detail: gh.ok ? gh.out.split('\n')[0]! : usesEnvToken ? 'not installed (using GITHUB_TOKEN instead)' : 'not installed',
        fix: gh.ok ? undefined : 'brew install gh && gh auth login',
    });

    let token: string;
    try {
        token = await resolveToken();
    } catch {
        checks.push({
            id: 'github-auth',
            label: 'GitHub authentication',
            needed: 'Everything that talks to GitHub',
            status: 'error',
            detail: 'No token: not logged in to gh and GITHUB_TOKEN not set',
            fix: `gh auth login --scopes ${REQUIRED_SCOPES.join(',')}`,
        });
        return checks;
    }

    try {
        const res = await fetch('https://api.github.com/user', { headers: { Authorization: `bearer ${token}`, 'User-Agent': 'issue-killer' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const user = (await res.json()) as { login: string };
        const scopesHeader = res.headers.get('x-oauth-scopes');
        if (scopesHeader === null) {
            checks.push({
                id: 'github-auth',
                label: 'GitHub authentication',
                needed: 'Everything that talks to GitHub',
                status: 'warn',
                detail: `Logged in as ${user.login} with a fine-grained token; scopes can't be verified (needs Issues/Projects read, Members read)`,
            });
        } else {
            const scopes = scopesHeader.split(',').map(s => s.trim());
            const missing = REQUIRED_SCOPES.filter(s => !scopes.includes(s) && !(s === 'read:project' && scopes.includes('project')) && !(s === 'read:org' && scopes.includes('admin:org')));
            checks.push({
                id: 'github-auth',
                label: 'GitHub authentication',
                needed: 'Sync (issues, org teams, projects)',
                status: missing.length ? 'error' : 'ok',
                detail: `Logged in as ${user.login}; scopes: ${scopes.join(', ') || 'none'}${missing.length ? ` – missing ${missing.join(', ')}` : ''}`,
                fix: missing.length ? `gh auth refresh -s ${missing.join(',')}` : undefined,
            });
            checks.push({
                id: 'github-project-write',
                label: 'GitHub project write access',
                needed: 'Optional: "Apply to GitHub" in the Plan view',
                status: scopes.includes('project') ? 'ok' : 'warn',
                detail: scopes.includes('project') ? 'project scope granted' : 'read-only (project scope not granted)',
                fix: scopes.includes('project') ? undefined : 'gh auth refresh -s project',
            });
        }
    } catch (err) {
        checks.push({
            id: 'github-auth',
            label: 'GitHub authentication',
            needed: 'Everything that talks to GitHub',
            status: 'error',
            detail: `Token rejected or GitHub unreachable (${(err as Error).message})`,
            fix: 'gh auth login',
        });
    }
    return checks;
}

function claudeCheck(): Check {
    const version = run(['claude', '--version']);
    if (!version.ok) {
        return {
            id: 'claude',
            label: 'Claude Code CLI',
            needed: 'Analyze, Investigate, Ask, summaries, plan suggestions',
            status: 'error',
            detail: 'claude not found on PATH',
            fix: 'Install Claude Code (https://docs.claude.com/en/docs/claude-code) and run `claude auth login`',
        };
    }
    const status = run(['claude', 'auth', 'status', '--json']);
    let loggedIn = false;
    let method = '';
    try {
        const parsed = JSON.parse(status.out) as { loggedIn?: boolean; authMethod?: string };
        loggedIn = !!parsed.loggedIn;
        method = parsed.authMethod ?? '';
    } catch {
        // older CLI without --json: fall back to exit code
        loggedIn = status.ok;
    }
    return {
        id: 'claude',
        label: 'Claude Code CLI',
        needed: 'Analyze, Investigate, Ask, summaries, plan suggestions',
        status: loggedIn ? 'ok' : 'error',
        detail: `${version.out.split('\n')[0]}${loggedIn ? ` · logged in${method ? ` (${method})` : ''}` : ' · not logged in'}`,
        fix: loggedIn ? undefined : 'claude auth login',
    };
}

function dataChecks(db: Database, repoPath: string): Check[] {
    const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    const issues = count('SELECT COUNT(*) n FROM issues');
    const lastSync = db.query<{ value: string }, []>("SELECT value FROM sync_state WHERE key = 'last_sync_at'").get()?.value;
    const projects = count('SELECT COUNT(*) n FROM projects');
    const members = count('SELECT COUNT(*) n FROM org_members');
    const settings = getSettings();
    const git = run(['git', '--version']);
    return [
        {
            id: 'git',
            label: 'git',
            needed: 'Investigate / Ask with code (read-only checkout)',
            status: git.ok ? 'ok' : 'error',
            detail: git.ok ? git.out : 'not found',
            fix: git.ok ? undefined : 'xcode-select --install',
        },
        {
            id: 'data',
            label: 'Synced issues',
            needed: 'Everything',
            status: issues ? 'ok' : 'error',
            detail: issues ? `${issues} issues, last sync ${lastSync ?? 'unknown'}` : 'database is empty',
            fix: issues ? undefined : 'Click Sync, or run: bun run sync --project <number>  (first sync ~15 min)',
        },
        {
            id: 'org',
            label: 'Org members & teams',
            needed: 'Team views, people classification',
            status: members ? 'ok' : 'warn',
            detail: members ? `${members} members synced` : 'not synced (token needs read:org)',
            fix: members ? undefined : 'gh auth refresh -s read:org, then Sync',
        },
        {
            id: 'project',
            label: 'GitHub Project',
            needed: 'Team/Status/Priority/Release fields, Teams & Plan views',
            status: projects ? 'ok' : 'warn',
            detail: projects ? `${projects} project(s) synced` : 'no project synced',
            fix: projects ? undefined : 'bun run sync --project <number>  (e.g. 58 for the Suite project)',
        },
        {
            id: 'checkout',
            label: 'Code checkout',
            needed: 'Investigate, Ask with code',
            status: existsSync(join(repoPath, '.git')) ? 'ok' : 'warn',
            detail: existsSync(join(repoPath, '.git')) ? repoPath : `missing at ${repoPath}`,
            fix: existsSync(join(repoPath, '.git'))
                ? undefined
                : `git clone --filter=blob:none --single-branch --branch develop https://github.com/trezor/trezor-suite.git "${repoPath}"`,
        },
        {
            id: 'settings',
            label: 'Your team',
            needed: 'Defaults for Board / Plan / Issues, "relevance to my team" in triage',
            status: settings.myTeam && settings.myProjectTeam ? 'ok' : 'warn',
            detail: `GitHub team: ${settings.myTeam ?? 'not set'} · project team: ${settings.myProjectTeam ?? 'not set'}`,
            fix: settings.myTeam && settings.myProjectTeam ? undefined : 'Open Settings (⚙) in the app',
        },
    ];
}

export async function runChecks(db: Database, opts: { repoPath: string }): Promise<Check[]> {
    const bunVersion = Bun.version;
    const bunOk = Number(bunVersion.split('.')[0]) > 1 || Number(bunVersion.split('.')[1]) >= 3;
    return [
        {
            id: 'bun',
            label: 'Bun',
            needed: 'Runtime',
            status: bunOk ? 'ok' : 'error',
            detail: `v${bunVersion}`,
            fix: bunOk ? undefined : 'bun upgrade',
        },
        ...(await githubCheck()),
        claudeCheck(),
        ...dataChecks(db, opts.repoPath),
    ];
}
