import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getState, openDb } from './db.ts';
import { GitHubClient, resolveToken } from './github.ts';
import { analyzeBatch, analyzeIssue, selectIssues } from './analysis/run.ts';
import { type CloseRequest, closeIssue } from './actions.ts';
import { DEFAULT_INVESTIGATE_MODEL, investigateIssue, updateRepo } from './investigate.ts';
import { getAnalysis, getInvestigation, getIssue, getMeta, listIssues, prepareTempTables } from './queries.ts';
import { type SyncResult, syncRepo } from './sync.ts';
import { getTeamsOverview } from './teams.ts';


export type ServerOptions = {
    dbPath: string;
    /** Read-only trezor-suite checkout used by the investigation agent. */
    repoPath: string;
    port: number;
    hostname?: string;
    /** owner/name; defaults to the repo the DB was synced from. */
    repo?: string;
    /** HTML import (dev, bundled on the fly) or a directory with the pre-built UI (desktop app). */
    ui: { html: Bun.HTMLBundle } | { staticDir: string };
    development?: boolean;
};

/** HTTP API + UI over the local issue DB. Used by `bun run ui` and the desktop app. */
export function startServer(opts: ServerOptions) {
    const db = openDb(opts.dbPath);
    prepareTempTables(db);
    const staticDir = 'staticDir' in opts.ui ? resolve(opts.ui.staticDir) : null;

    type SyncStatus = {
        running: boolean;
        startedAt: string | null;
        finishedAt: string | null;
        progress: string | null;
        error: string | null;
        result: SyncResult | null;
    };

    let syncStatus: SyncStatus = { running: false, startedAt: null, finishedAt: null, progress: null, error: null, result: null };

    // Runs an incremental sync in-process; the UI polls GET /api/sync for progress.
    async function runSync() {
        syncStatus = { running: true, startedAt: new Date().toISOString(), finishedAt: null, progress: 'Starting…', error: null, result: null };
        try {
            const repo = opts.repo ?? getState(db, 'repo') ?? 'trezor/trezor-suite';
            const [owner, name] = repo.split('/');
            if (!owner || !name) throw new Error(`Invalid repo: ${repo}`);
            const gh = new GitHubClient(await resolveToken());
            syncStatus.result = await syncRepo(db, gh, {
                owner,
                name,
                full: false,
                pageSize: 50,
                log: msg => {
                    console.log(msg);
                    syncStatus.progress = msg.trim();
                },
            });
            prepareTempTables(db);
        } catch (err) {
            console.error(err);
            syncStatus.error = (err as Error).message;
        } finally {
            syncStatus.running = false;
            syncStatus.finishedAt = new Date().toISOString();
        }
    }

    type AnalyzeStatus = {
        running: boolean;
        total: number;
        done: number;
        failed: number;
        costUsd: number;
        lastMessage: string | null;
        error: string | null;
    };

    let analyzeStatus: AnalyzeStatus = { running: false, total: 0, done: 0, failed: 0, costUsd: 0, lastMessage: null, error: null };

    // Batch analysis of the issues matching a UI filter; the UI polls GET /api/analyze for progress.
    async function runAnalyzeBatch(filter: string, limit: number | undefined) {
        const total = selectIssues(db, { filter, issues: [], limit, force: false }).length;
        analyzeStatus = { running: true, total, done: 0, failed: 0, costUsd: 0, lastMessage: 'Starting…', error: null };
        try {
            const result = await analyzeBatch(db, {
                filter,
                issues: [],
                limit,
                concurrency: 4,
                model: process.env.ANALYZE_MODEL ?? 'sonnet',
                force: false,
                dryRun: false,
                log: msg => {
                    console.log(msg);
                    analyzeStatus.lastMessage = msg;
                    if (msg.startsWith('[')) {
                        if (msg.includes('FAILED')) analyzeStatus.failed++;
                        else analyzeStatus.done++;
                    }
                },
            });
            analyzeStatus.costUsd = result.costUsd;
        } catch (err) {
            console.error(err);
            analyzeStatus.error = (err as Error).message;
        } finally {
            analyzeStatus.running = false;
        }
    }

    const server = Bun.serve({
        port: opts.port,
        hostname: opts.hostname ?? '127.0.0.1',
        development: 'html' in opts.ui ? (opts.development ?? false) : false,
        routes: {
            '/': 'html' in opts.ui ? opts.ui.html : () => new Response(Bun.file(join(staticDir!, 'index.html'))),
            '/api/meta': () => {
                // Recompute derived tables so a sync running alongside the server is picked up on reload.
                prepareTempTables(db);
                return Response.json(getMeta(db));
            },
            '/api/sync': {
                GET: () => Response.json(syncStatus),
                POST: () => {
                    if (syncStatus.running) return Response.json(syncStatus, { status: 409 });
                    void runSync();
                    return Response.json(syncStatus, { status: 202 });
                },
            },
            '/api/analyze': {
                GET: req => {
                    // ?preview=1&<filter> returns how many issues a batch would analyze.
                    const params = new URL(req.url).searchParams;
                    if (!params.has('preview')) return Response.json(analyzeStatus);
                    params.delete('preview');
                    params.delete('issue');
                    params.delete('page');
                    return Response.json({ count: selectIssues(db, { filter: params.toString(), issues: [], force: false }).length });
                },
                POST: async req => {
                    if (analyzeStatus.running) return Response.json(analyzeStatus, { status: 409 });
                    const { filter = '', limit } = (await req.json()) as { filter?: string; limit?: number };
                    void runAnalyzeBatch(filter, limit);
                    return Response.json(analyzeStatus, { status: 202 });
                },
            },
            '/api/issues/:number/analyze': {
                POST: async req => {
                    const number = Number(req.params.number);
                    prepareTempTables(db);
                    await analyzeIssue(db, number, { model: process.env.ANALYZE_MODEL ?? 'sonnet' });
                    return Response.json(getAnalysis(db, number));
                },
            },
            '/api/issues/:number/investigate': {
                POST: async req => {
                    const number = Number(req.params.number);
                    const repoSha = await updateRepo(opts.repoPath);
                    await investigateIssue(db, number, {
                        model: process.env.INVESTIGATE_MODEL ?? DEFAULT_INVESTIGATE_MODEL,
                        repoPath: opts.repoPath,
                        dbPath: opts.dbPath,
                        repoSha,
                    });
                    return Response.json(getInvestigation(db, number));
                },
            },
            // Writes to GitHub: only ever triggered by an explicit click in the UI.
            '/api/issues/:number/close': {
                POST: async req => {
                    const body = (await req.json()) as CloseRequest;
                    const gh = new GitHubClient(await resolveToken());
                    const result = await closeIssue(db, gh, Number(req.params.number), body);
                    console.log(`Closed #${result.number} as ${result.stateReason} by ${result.performedBy}`);
                    return Response.json(result);
                },
            },
            '/api/teams': req => {
                const params = new URL(req.url).searchParams;
                const project = Number(params.get('project')) || (db.query<{ n: number }, []>('SELECT MIN(number) AS n FROM projects').get()?.n ?? 0);
                prepareTempTables(db);
                const overview = getTeamsOverview(db, project);
                return overview ? Response.json(overview) : Response.json({ error: 'No synced project. Run: bun run sync --project <n>' }, { status: 404 });
            },
            '/api/issues': req => Response.json(listIssues(db, new URL(req.url).searchParams)),
            '/api/issues/:number': req => {
                const issue = getIssue(db, Number(req.params.number));
                return issue ? Response.json(issue) : Response.json({ error: 'Not found' }, { status: 404 });
            },
        },
        // Pre-built UI assets (desktop app); the HTML import serves its own assets.
        fetch(req) {
            if (staticDir) {
                const file = resolve(staticDir, `.${decodeURIComponent(new URL(req.url).pathname)}`);
                if (file.startsWith(staticDir + sep) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
            }
            return new Response('Not found', { status: 404 });
        },
        error(err) {
            console.error(err);
            return Response.json({ error: err.message }, { status: 500 });
        },
    });

    return server;
}
