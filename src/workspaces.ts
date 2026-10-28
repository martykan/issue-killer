import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Workspaces: one per GitHub repository, each with its own SQLite DB (issues, settings, Claude results) and local code
 * checkout for Investigate / Ask with code. The registry is `workspaces.json` in the data folder; the data that
 * predates workspaces (`issues.db` + checkout in the data folder) is the first workspace.
 */
export type Workspace = {
    id: string;
    /** owner/name on GitHub; null only for the first workspace before its first sync. */
    repo: string | null;
    dbPath: string;
    /** Local code the read-only agent looks at. */
    checkoutPath: string;
    /**
     * The checkout belongs to the app (cloned into the data folder) and is fast-forwarded with a hard reset before agent
     * runs. Otherwise it's the user's own folder, which is only ever read.
     */
    managed: boolean;
    addedAt: string;
};

type Registry = { active: string; workspaces: Workspace[] };

export const DEFAULT_DATA_DIR = 'data';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** owner/name from a GitHub URL (https, ssh, scp-like) or an owner/name shorthand. */
export function parseGitHubRepo(input: string): string | null {
    const s = input.trim();
    const m =
        s.match(/^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) ??
        s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}

export type Remote = { name: string; url: string; repo: string };

/** The git repository a folder belongs to, and its GitHub remotes (upstream first: forks keep issues there). */
export function inspectFolder(path: string): { path: string; remotes: Remote[] } {
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', path, ...args], { env: process.env });
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    const top = git('rev-parse', '--show-toplevel');
    if (top.exitCode !== 0) throw new Error(`${path} is not a git repository`);
    const remotes = new Map<string, Remote>();
    for (const line of git('remote', '-v').stdout.toString().split('\n')) {
        const [name, url] = line.split(/\s+/);
        const repo = url && parseGitHubRepo(url);
        if (name && url && repo && !remotes.has(name)) remotes.set(name, { name, url, repo });
    }
    const rank = (r: Remote) => (r.name === 'upstream' ? 0 : r.name === 'origin' ? 1 : 2);
    return { path: top.stdout.toString().trim(), remotes: [...remotes.values()].sort((a, b) => rank(a) - rank(b)) };
}

export class WorkspaceRegistry {
    readonly dataDir: string;
    private readonly file: string;
    private registry: Registry;

    /** `initial`: DB and checkout of the first workspace (the data folder's own `issues.db`). */
    constructor(dataDir: string, initial: { dbPath: string; repoPath: string }) {
        this.dataDir = resolve(dataDir);
        this.file = join(this.dataDir, 'workspaces.json');
        if (existsSync(this.file)) {
            this.registry = JSON.parse(readFileSync(this.file, 'utf8')) as Registry;
        } else {
            const first: Workspace = {
                id: 'default',
                repo: null,
                dbPath: resolve(initial.dbPath),
                checkoutPath: resolve(initial.repoPath),
                managed: true,
                addedAt: new Date().toISOString(),
            };
            this.registry = { active: first.id, workspaces: [first] };
        }
    }

    private save() {
        mkdirSync(this.dataDir, { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.registry, null, 2));
        renameSync(`${this.file}.tmp`, this.file);
    }

    list = () => this.registry.workspaces;
    get = (id: string | null | undefined) => this.registry.workspaces.find(w => w.id === id);
    active = () => this.get(this.registry.active) ?? this.registry.workspaces[0]!;
    findRepo = (repo: string) => this.registry.workspaces.find(w => w.repo?.toLowerCase() === repo.toLowerCase());

    setActive(id: string) {
        if (!this.get(id)) throw new Error(`Unknown workspace ${id}`);
        this.registry.active = id;
        this.save();
    }

    /** The first workspace learns its repo on the first sync. */
    setRepo(id: string, repo: string) {
        const ws = this.get(id);
        if (ws && ws.repo !== repo) {
            ws.repo = repo;
            this.save();
        }
    }

    /** Where a new workspace for `repo` keeps its data; nothing is created yet. */
    plan(repo: string, checkout: { path: string } | 'clone'): Workspace {
        if (!REPO_RE.test(repo)) throw new Error(`Not a GitHub repository: ${repo} (expected owner/name)`);
        const existing = this.findRepo(repo);
        if (existing) throw new Error(`${repo} is already added`);
        const base = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        let id = base;
        for (let i = 2; this.get(id) || existsSync(join(this.dataDir, 'workspaces', id)); i++) id = `${base}-${i}`;
        const dir = join(this.dataDir, 'workspaces', id);
        return {
            id,
            repo,
            dbPath: join(dir, 'issues.db'),
            checkoutPath: checkout === 'clone' ? join(dir, 'checkout') : resolve(checkout.path),
            managed: checkout === 'clone',
            addedAt: new Date().toISOString(),
        };
    }

    add(ws: Workspace) {
        if (this.get(ws.id) || this.findRepo(ws.repo ?? '')) throw new Error(`${ws.repo} is already added`);
        this.registry.workspaces.push(ws);
        this.save();
    }

    /** Forgets a workspace; its data folder stays on disk. */
    remove(id: string) {
        if (this.registry.workspaces.length <= 1) throw new Error('Cannot remove the only repository');
        this.registry.workspaces = this.registry.workspaces.filter(w => w.id !== id);
        if (this.registry.active === id) this.registry.active = this.registry.workspaces[0]!.id;
        this.save();
    }
}

/** Blob-less clone of the default branch (history and files are fetched on demand). */
export async function cloneRepo(url: string, dest: string) {
    mkdirSync(join(dest, '..'), { recursive: true });
    const proc = Bun.spawn(['git', 'clone', '--filter=blob:none', '--single-branch', url, dest], {
        stdout: 'ignore',
        stderr: 'pipe',
        // Fail instead of waiting for a password prompt nobody sees.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`git clone failed: ${stderr.trim().split('\n').at(-1)}`);
}
