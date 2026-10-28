import type { Database } from 'bun:sqlite';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getState, openDb, setState } from './db.ts';
import { GitHubClient, resolveToken } from './github.ts';
import { analyzeBatch, analyzeIssue, selectIssues } from './analysis/run.ts';
import { type CloseRequest, closeIssue } from './actions.ts';
import { type AskMode, askQuestion, DEFAULT_ASK_MODEL, listQuestions } from './ask.ts';
import { DEFAULT_INVESTIGATE_MODEL, investigateIssue, updateRepo } from './investigate.ts';
import { getAnalysis, getInvestigation, getIssue, getMeta, listIssues, prepareTempTables } from './queries.ts';
import { type SyncResult, syncRepo } from './sync.ts';
import { listProjects } from './projects.ts';
import { getTeamsOverview } from './teams.ts';
import { generateTopicMap, getTopicMap } from './topics.ts';
import { renderTopicsHtml, scopeLabel } from './topics-export.ts';
import { runChecks } from './doctor.ts';
import { buildHandoffPrompt, conductorUrl, openInConductor } from './handoff.ts';
import { getSettings, type Settings, updateSettings } from './settings.ts';
import { getBoard } from './board.ts';
import { getLatestSummary, summarizeBoard } from './board-summary.ts';
import { acceptMoves, applyPlan, suggestPlan } from './plan-actions.ts';
import { defaultProject, discardPlanChanges, getPlan, setPlanChange } from './planning.ts';
import { cloneRepo, inspectFolder, parseGitHubRepo, type Workspace, WorkspaceRegistry } from './workspaces.ts';

export type ServerOptions = {
    /** Holds the workspace registry (workspaces.json) and the data of repositories added in the app. */
    dataDir: string;
    /** DB of the first workspace (data from before workspaces existed). */
    dbPath: string;
    /** Read-only code checkout of the first workspace, used by the investigation agent. */
    repoPath: string;
    port: number;
    hostname?: string;
    /** owner/name of the first workspace; defaults to the repo its DB was synced from. */
    repo?: string;
    /** HTML import (dev, bundled on the fly) or a directory with the pre-built UI (desktop app). */
    ui: { html: Bun.HTMLBundle } | { staticDir: string };
    development?: boolean;
    /** Native folder chooser (desktop app). Without it, macOS gets an AppleScript dialog; elsewhere the path is typed. */
    pickFolder?: () => Promise<string | null>;
};

type SyncStatus = {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    progress: string | null;
    error: string | null;
    result: SyncResult | null;
};

type AnalyzeStatus = {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    costUsd: number;
    lastMessage: string | null;
    error: string | null;
};

/** An open workspace: its DB and the state of its background sync / batch analysis. */
type Ctx = { ws: Workspace; db: Database; syncStatus: SyncStatus; analyzeStatus: AnalyzeStatus };

const WORKSPACE_COOKIE = 'ik-workspace';

/**
 * HTTP API + UI over the local issue DBs. Used by `bun run ui` and the desktop app.
 *
 * Every API request works on one workspace (repository): the one picked in this browser (cookie, so downloads and new
 * tabs follow it too), else the last one picked anywhere.
 */
export function startServer(opts: ServerOptions) {
    const registry = new WorkspaceRegistry(opts.dataDir, { dbPath: opts.dbPath, repoPath: opts.repoPath });
    const contexts = new Map<string, Ctx>();
    const open = (ws: Workspace): Ctx => {
        let ctx = contexts.get(ws.id);
        if (!ctx) {
            const db = openDb(ws.dbPath);
            prepareTempTables(db);
            ctx = {
                ws,
                db,
                syncStatus: { running: false, startedAt: null, finishedAt: null, progress: null, error: null, result: null },
                analyzeStatus: { running: false, total: 0, done: 0, failed: 0, costUsd: 0, lastMessage: null, error: null },
            };
            contexts.set(ws.id, ctx);
            // The first workspace's repo is only known from its DB.
            const repo = getState(db, 'repo');
            if (repo) registry.setRepo(ws.id, repo);
        }
        return ctx;
    };
    const cookieWorkspace = (req: Request) => req.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${WORKSPACE_COOKIE}=([^;]+)`))?.[1];
    const ctxOf = (req: Request): Ctx => open(registry.get(decodeURIComponent(cookieWorkspace(req) ?? '')) ?? registry.active());
    const selectCookie = (id: string) => `${WORKSPACE_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Strict`;
    const isDefaultWorkspace = (ctx: Ctx) => ctx.ws.id === registry.list()[0]?.id;
    const workspaceRepo = (ctx: Ctx) => getState(ctx.db, 'repo') ?? ctx.ws.repo ?? (isDefaultWorkspace(ctx) ? opts.repo : undefined) ?? null;
    // Hand off to Conductor: the configured repo root, else the user's own folder of this repo.
    const conductorPath = (ctx: Ctx) => getSettings(ctx.db).conductorRepoPath ?? (ctx.ws.managed ? null : ctx.ws.checkoutPath);

    const staticDir = 'staticDir' in opts.ui ? resolve(opts.ui.staticDir) : null;
    const DEFAULT_REPO = 'trezor/trezor-suite';
    const topicScope = ({ db }: Ctx, params: URLSearchParams) => {
        const scope = params.get('scope');
        if (scope) return scope;
        const team = getSettings(db).myProjectTeam;
        return team ? `team:${team}` : 'all';
    };
    // Board default: the user's team from Settings, else the first team that has members.
    const defaultBoardTeam = ({ db }: Ctx) =>
        getSettings(db).myTeam ??
        db.query<{ slug: string }, []>('SELECT team_slug AS slug FROM team_members GROUP BY team_slug ORDER BY team_slug LIMIT 1').get()?.slug ??
        null;

    // Runs an incremental sync in-process; the UI polls GET /api/sync for progress.
    async function runSync(ctx: Ctx, request: { repo?: string; projects?: number[] } = {}) {
        const status: SyncStatus = { running: true, startedAt: new Date().toISOString(), finishedAt: null, progress: 'Starting…', error: null, result: null };
        ctx.syncStatus = status;
        try {
            const repo = request.repo ?? workspaceRepo(ctx) ?? DEFAULT_REPO;
            const [owner, name] = repo.split('/');
            if (!owner || !name) throw new Error(`Invalid repo: ${repo}`);
            const gh = new GitHubClient(await resolveToken());
            status.result = await syncRepo(ctx.db, gh, {
                owner,
                name,
                full: false,
                pageSize: 50,
                projects: request.projects,
                log: msg => {
                    console.log(`[${ctx.ws.id}] ${msg}`);
                    status.progress = msg.trim();
                },
            });
            registry.setRepo(ctx.ws.id, repo);
            prepareTempTables(ctx.db);
        } catch (err) {
            console.error(err);
            status.error = (err as Error).message;
        } finally {
            status.running = false;
            status.finishedAt = new Date().toISOString();
        }
    }

    // Batch analysis of the issues matching a UI filter; the UI polls GET /api/analyze for progress.
    async function runAnalyzeBatch(ctx: Ctx, filter: string, limit: number | undefined) {
        const { db } = ctx;
        const total = selectIssues(db, { filter, issues: [], limit, force: false }).length;
        const status: AnalyzeStatus = { running: true, total, done: 0, failed: 0, costUsd: 0, lastMessage: 'Starting…', error: null };
        ctx.analyzeStatus = status;
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
                    status.lastMessage = msg;
                    if (msg.startsWith('[')) {
                        if (msg.includes('FAILED')) status.failed++;
                        else status.done++;
                    }
                },
            });
            status.costUsd = result.costUsd;
        } catch (err) {
            console.error(err);
            status.error = (err as Error).message;
        } finally {
            status.running = false;
        }
    }

    // Claude calls take from seconds to minutes – longer than webviews/proxies keep a request open – so they run as
    // background jobs: POST returns a job id right away and the UI polls GET /api/jobs/:id.
    type Job = { id: string; key: string; status: 'running' | 'done' | 'error'; result?: unknown; error?: string; startedAt: string };
    const jobs = new Map<string, Job>();
    const startJob = (key: string, run: () => Promise<unknown>): Response => {
        // Re-clicking while the same job runs attaches to it instead of starting another Claude call.
        const existing = [...jobs.values()].find(j => j.key === key && j.status === 'running');
        if (existing) return Response.json({ jobId: existing.id }, { status: 202 });
        const job: Job = { id: crypto.randomUUID(), key, status: 'running', startedAt: new Date().toISOString() };
        jobs.set(job.id, job);
        run()
            .then(result => Object.assign(job, { status: 'done', result }))
            .catch(err => {
                console.error(`Job ${key} failed:`, err);
                Object.assign(job, { status: 'error', error: (err as Error).message ?? String(err) });
            })
            // Finished jobs are kept a while for the poller, then dropped.
            .finally(() => setTimeout(() => jobs.delete(job.id), 10 * 60_000));
        return Response.json({ jobId: job.id }, { status: 202 });
    };

    // Folder chooser for "Add repository": the desktop app's native dialog, else AppleScript on macOS.
    const pickFolder =
        opts.pickFolder ??
        (process.platform === 'darwin'
            ? async () => {
                  const proc = Bun.spawn(['osascript', '-e', 'POSIX path of (choose folder with prompt "Choose a local clone of a GitHub repository")'], {
                      stdout: 'pipe',
                      stderr: 'ignore',
                  });
                  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
                  return code === 0 ? out.trim().replace(/\/$/, '') || null : null; // non-zero = cancelled
              }
            : null);

    const listWorkspaces = (current: Ctx) =>
        registry.list().map(ws => {
            const ctx = contexts.get(ws.id);
            return {
                id: ws.id,
                repo: ctx ? workspaceRepo(ctx) : ws.repo,
                checkoutPath: ws.checkoutPath,
                managed: ws.managed,
                active: ws.id === current.ws.id,
                syncing: ctx?.syncStatus.running ?? false,
            };
        });

    /** Registers a workspace, prepares its DB (repo known, so the setup wizard skips asking) and selects it. */
    const addWorkspace = (ws: Workspace) => {
        const db = openDb(ws.dbPath);
        setState(db, 'repo', ws.repo!);
        db.close();
        registry.add(ws);
        registry.setActive(ws.id);
        return ws;
    };

    const server = Bun.serve({
        port: opts.port,
        hostname: opts.hostname ?? '127.0.0.1',
        development: 'html' in opts.ui ? (opts.development ?? false) : false,
        routes: {
            '/': 'html' in opts.ui ? opts.ui.html : () => new Response(Bun.file(join(staticDir!, 'index.html'))),
            '/api/meta': req => {
                const ctx = ctxOf(req);
                // Recompute derived tables so a sync running alongside the server is picked up on reload.
                prepareTempTables(ctx.db);
                return Response.json({ ...getMeta(ctx.db), settings: getSettings(ctx.db), workspace: ctx.ws.id, checkoutPath: ctx.ws.checkoutPath });
            },
            // Workspaces = repositories added to the app, each with its own data.
            '/api/workspaces': {
                GET: req => Response.json({ workspaces: listWorkspaces(ctxOf(req)), canPickFolder: !!pickFolder }),
                // { kind: 'folder', path, repo } adds a local clone; { kind: 'clone', url } clones into the data folder (job).
                POST: async req => {
                    const body = (await req.json()) as { kind: 'folder'; path: string; repo: string } | { kind: 'clone'; url: string };
                    try {
                        if (body.kind === 'folder') {
                            const { path } = inspectFolder(body.path);
                            const ws = addWorkspace(registry.plan(body.repo, { path }));
                            return Response.json(ws, { headers: { 'Set-Cookie': selectCookie(ws.id) } });
                        }
                        const repo = parseGitHubRepo(body.url);
                        if (!repo) return Response.json({ error: 'Not a GitHub repository URL (e.g. https://github.com/owner/name)' }, { status: 400 });
                        const ws = registry.plan(repo, 'clone');
                        // A full URL is cloned as given (ssh or https); owner/name via https.
                        const url = /^[\w.-]+\/[\w.-]+$/.test(body.url.trim()) ? `https://github.com/${repo}.git` : body.url.trim();
                        return startJob(`add-workspace:${repo}`, async () => {
                            try {
                                await cloneRepo(url, ws.checkoutPath);
                            } catch (err) {
                                // The workspace folder was created for this clone (plan() picks an unused one).
                                rmSync(dirname(ws.checkoutPath), { recursive: true, force: true });
                                throw err;
                            }
                            return addWorkspace(ws);
                        });
                    } catch (err) {
                        return Response.json({ error: (err as Error).message }, { status: 400 });
                    }
                },
            },
            '/api/workspaces/select': {
                POST: async req => {
                    const { id } = (await req.json()) as { id: string };
                    if (!registry.get(id)) return Response.json({ error: `Unknown workspace ${id}` }, { status: 404 });
                    registry.setActive(id);
                    return Response.json({ ok: true }, { headers: { 'Set-Cookie': selectCookie(id) } });
                },
            },
            // Native folder dialog → the folder's git root and GitHub remotes.
            '/api/workspaces/pick-folder': {
                POST: async () => {
                    if (!pickFolder) return Response.json({ error: 'No folder dialog here – type the path' }, { status: 501 });
                    const path = await pickFolder();
                    if (!path) return Response.json({ path: null, remotes: [] });
                    try {
                        return Response.json(inspectFolder(path));
                    } catch (err) {
                        return Response.json({ path, remotes: [], error: (err as Error).message });
                    }
                },
            },
            '/api/workspaces/inspect': req => {
                try {
                    return Response.json(inspectFolder(new URL(req.url).searchParams.get('path') ?? ''));
                } catch (err) {
                    return Response.json({ error: (err as Error).message }, { status: 400 });
                }
            },
            // Forgets a repository; its data folder stays on disk.
            '/api/workspaces/:id': {
                DELETE: req => {
                    const ctx = contexts.get(req.params.id);
                    if (ctx?.syncStatus.running) return Response.json({ error: 'A sync is running for this repository' }, { status: 409 });
                    try {
                        registry.remove(req.params.id);
                    } catch (err) {
                        return Response.json({ error: (err as Error).message }, { status: 400 });
                    }
                    contexts.delete(req.params.id);
                    ctx?.db.close();
                    return Response.json({ ok: true });
                },
            },
            '/api/sync': {
                GET: req => Response.json(ctxOf(req).syncStatus),
                POST: async req => {
                    const ctx = ctxOf(req);
                    if (ctx.syncStatus.running) return Response.json(ctx.syncStatus, { status: 409 });
                    // Optional { repo, projects } – used by the setup wizard on first start.
                    const body = (await req.json().catch(() => ({}))) as { repo?: string; projects?: number[] };
                    void runSync(ctx, body);
                    return Response.json(ctx.syncStatus, { status: 202 });
                },
            },
            // Setup wizard: what's configured so far.
            '/api/setup': req => {
                const ctx = ctxOf(req);
                return Response.json({
                    repo: workspaceRepo(ctx),
                    defaultRepo: DEFAULT_REPO,
                    projects: (getState(ctx.db, 'projects') ?? '').split(',').filter(Boolean).map(Number),
                    issues: ctx.db.query<{ n: number }, []>('SELECT COUNT(*) n FROM issues').get()?.n ?? 0,
                    repoPath: ctx.ws.checkoutPath,
                    managedCheckout: ctx.ws.managed,
                    hasCheckout: existsSync(join(ctx.ws.checkoutPath, '.git')),
                });
            },
            // Setup wizard: open org projects to pick from, ?repo=owner/name.
            '/api/setup/projects': async req => {
                const [owner, name] = (new URL(req.url).searchParams.get('repo') ?? '').split('/');
                if (!owner || !name) return Response.json({ error: 'repo must be owner/name' }, { status: 400 });
                try {
                    return Response.json(await listProjects(new GitHubClient(await resolveToken()), owner, name));
                } catch (err) {
                    return Response.json({ error: (err as Error).message }, { status: 502 });
                }
            },
            // Setup wizard: blob-less clone of the repo for Investigate / Ask with code (~800 MB for trezor-suite).
            '/api/setup/checkout': {
                POST: req => {
                    const ctx = ctxOf(req);
                    return startJob(`${ctx.ws.id}:setup-checkout`, async () => {
                        if (existsSync(join(ctx.ws.checkoutPath, '.git'))) return { cloned: false };
                        if (!ctx.ws.managed) throw new Error(`${ctx.ws.checkoutPath} is not a git checkout`);
                        await cloneRepo(`https://github.com/${workspaceRepo(ctx) ?? DEFAULT_REPO}.git`, ctx.ws.checkoutPath);
                        return { cloned: true };
                    });
                },
            },
            '/api/analyze': {
                GET: req => {
                    const ctx = ctxOf(req);
                    // ?preview=1&<filter> returns how many issues a batch would analyze.
                    const params = new URL(req.url).searchParams;
                    if (!params.has('preview')) return Response.json(ctx.analyzeStatus);
                    params.delete('preview');
                    params.delete('issue');
                    params.delete('page');
                    return Response.json({ count: selectIssues(ctx.db, { filter: params.toString(), issues: [], force: false }).length });
                },
                POST: async req => {
                    const ctx = ctxOf(req);
                    if (ctx.analyzeStatus.running) return Response.json(ctx.analyzeStatus, { status: 409 });
                    const { filter = '', limit } = (await req.json()) as { filter?: string; limit?: number };
                    void runAnalyzeBatch(ctx, filter, limit);
                    return Response.json(ctx.analyzeStatus, { status: 202 });
                },
            },
            '/api/settings': {
                GET: req => Response.json(getSettings(ctxOf(req).db)),
                PUT: async req => Response.json(updateSettings(ctxOf(req).db, (await req.json()) as Partial<Settings>)),
            },
            '/api/health': async req => {
                const ctx = ctxOf(req);
                return Response.json(await runChecks(ctx.db, { repoPath: ctx.ws.checkoutPath, repo: workspaceRepo(ctx) }));
            },
            '/api/jobs/:id': req => {
                const job = jobs.get(req.params.id);
                return job ? Response.json(job) : Response.json({ error: 'Job not found (server restarted?)' }, { status: 404 });
            },
            '/api/issues/:number/analyze': {
                POST: req => {
                    const { ws, db } = ctxOf(req);
                    const number = Number(req.params.number);
                    return startJob(`${ws.id}:analyze:${number}`, async () => {
                        prepareTempTables(db);
                        await analyzeIssue(db, number, { model: process.env.ANALYZE_MODEL ?? 'sonnet' });
                        return getAnalysis(db, number);
                    });
                },
            },
            '/api/issues/:number/investigate': {
                POST: req => {
                    const { ws, db } = ctxOf(req);
                    const number = Number(req.params.number);
                    return startJob(`${ws.id}:investigate:${number}`, async () => {
                        const repoSha = await updateRepo(ws.checkoutPath, { managed: ws.managed });
                        await investigateIssue(db, number, {
                            model: process.env.INVESTIGATE_MODEL ?? DEFAULT_INVESTIGATE_MODEL,
                            repoPath: ws.checkoutPath,
                            dbPath: ws.dbPath,
                            repoSha,
                        });
                        return getInvestigation(db, number);
                    });
                },
            },
            // Writes to GitHub: only ever triggered by an explicit click in the UI.
            '/api/issues/:number/close': {
                POST: async req => {
                    const { db } = ctxOf(req);
                    const body = (await req.json()) as CloseRequest;
                    const gh = new GitHubClient(await resolveToken());
                    const result = await closeIssue(db, gh, Number(req.params.number), body);
                    console.log(`Closed #${result.number} as ${result.stateReason} by ${result.performedBy}`);
                    return Response.json(result);
                },
            },
            '/api/teams': req => {
                const { db } = ctxOf(req);
                const params = new URL(req.url).searchParams;
                const project = Number(params.get('project')) || (db.query<{ n: number }, []>('SELECT MIN(number) AS n FROM projects').get()?.n ?? 0);
                prepareTempTables(db);
                const overview = getTeamsOverview(db, project);
                return overview ? Response.json(overview) : Response.json({ error: 'No synced project. Pick one in Settings → Run setup wizard (or: bun run sync --project <n>)' }, { status: 404 });
            },
            '/api/board': req => {
                const ctx = ctxOf(req);
                const team = new URL(req.url).searchParams.get('team') || defaultBoardTeam(ctx);
                const board = team ? getBoard(ctx.db, team) : null;
                return board
                    ? Response.json({ ...board, summary: getLatestSummary(ctx.db, board.team.slug) })
                    : Response.json({ error: team ? `Unknown team ${team}` : 'No org teams synced' }, { status: 404 });
            },
            '/api/board/summary': {
                POST: req => {
                    const ctx = ctxOf(req);
                    const team = new URL(req.url).searchParams.get('team') || defaultBoardTeam(ctx);
                    if (!team) return Response.json({ error: 'No team selected' }, { status: 400 });
                    const slug: string = team;
                    return startJob(`${ctx.ws.id}:board-summary:${slug}`, () => summarizeBoard(ctx.db, slug, process.env.SUMMARY_MODEL));
                },
            },
            // Plan view: ?team=<project Team value>&project=<n>
            '/api/plan': req => {
                const { db } = ctxOf(req);
                const params = new URL(req.url).searchParams;
                const project = Number(params.get('project')) || defaultProject(db);
                const plan = project ? getPlan(db, project, params.get('team') || getSettings(db).myProjectTeam || '') : null;
                return plan ? Response.json(plan) : Response.json({ error: 'No synced project. Pick one in Settings → Run setup wizard (or: bun run sync --project <n>)' }, { status: 404 });
            },
            '/api/plan/changes': {
                POST: async req => {
                    const { db } = ctxOf(req);
                    const body = (await req.json()) as { issue: number; release?: string; assignee?: string } | { accept: { issue: number; release: string; assignee: string | null }[] };
                    if ('accept' in body) acceptMoves(db, body.accept);
                    else setPlanChange(db, body.issue, body);
                    return Response.json({ ok: true });
                },
                DELETE: async req => {
                    const { db } = ctxOf(req);
                    const body = (await req.json().catch(() => ({}))) as { issues?: number[] };
                    discardPlanChanges(db, body.issues);
                    return Response.json({ ok: true });
                },
            },
            '/api/plan/suggest': {
                POST: req => {
                    const { ws, db } = ctxOf(req);
                    const params = new URL(req.url).searchParams;
                    const project = Number(params.get('project')) || defaultProject(db)!;
                    const team = params.get('team') ?? '';
                    return startJob(`${ws.id}:plan-suggest:${team}`, () => suggestPlan(db, project, team, process.env.PLAN_MODEL));
                },
            },
            // Writes to GitHub (project Release field + assignees): only on an explicit click.
            '/api/plan/apply': {
                POST: req => {
                    const { ws, db } = ctxOf(req);
                    const params = new URL(req.url).searchParams;
                    const project = Number(params.get('project')) || defaultProject(db)!;
                    const team = params.get('team') ?? '';
                    return startJob(`${ws.id}:plan-apply:${team}`, async () => applyPlan(db, new GitHubClient(await resolveToken()), project, team));
                },
            },
            // Topics view: ?scope=all | team:<project Team value> (default: your project team)
            '/api/topics': req => {
                const ctx = ctxOf(req);
                const scope = topicScope(ctx, new URL(req.url).searchParams);
                return Response.json({ scope, map: getTopicMap(ctx.db, scope) });
            },
            // Self-contained HTML of the scope's topic map, as a download.
            '/api/topics/export': req => {
                const ctx = ctxOf(req);
                const scope = topicScope(ctx, new URL(req.url).searchParams);
                const map = getTopicMap(ctx.db, scope);
                if (!map) return Response.json({ error: 'No topic map for this scope' }, { status: 404 });
                const slug = scopeLabel(scope).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                return new Response(renderTopicsHtml(map, getState(ctx.db, 'repo') ?? null), {
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Content-Disposition': `attachment; filename="topics-${slug || 'scope'}-${new Date().toISOString().slice(0, 10)}.html"`,
                    },
                });
            },
            '/api/topics/generate': {
                POST: req => {
                    const ctx = ctxOf(req);
                    const scope = topicScope(ctx, new URL(req.url).searchParams);
                    return startJob(`${ctx.ws.id}:topics:${scope}`, async () => {
                        await generateTopicMap(ctx.db, scope, process.env.TOPICS_MODEL);
                        return getTopicMap(ctx.db, scope);
                    });
                },
            },
            '/api/topics/:id': req => {
                const t = ctxOf(req)
                    .db.query<{ name: string; parent: string | null }, [number]>(
                        'SELECT t.name, p.name AS parent FROM topics t LEFT JOIN topics p ON p.id = t.parent_id WHERE t.id = ?',
                    )
                    .get(Number(req.params.id));
                return t ? Response.json(t) : Response.json({ error: 'Topic not found' }, { status: 404 });
            },
            '/api/issues': req => Response.json(listIssues(ctxOf(req).db, new URL(req.url).searchParams)),
            '/api/issues/:number': req => {
                const { db } = ctxOf(req);
                const number = Number(req.params.number);
                const issue = getIssue(db, number);
                return issue
                    ? Response.json({ ...issue, questions: listQuestions(db, number) })
                    : Response.json({ error: 'Not found' }, { status: 404 });
            },
            '/api/issues/:number/handoff': {
                GET: req => {
                    const ctx = ctxOf(req);
                    const prompt = buildHandoffPrompt(ctx.db, Number(req.params.number));
                    const repoPath = conductorPath(ctx);
                    return Response.json({ prompt, url: conductorUrl(prompt, repoPath), repoPath });
                },
                POST: async req => {
                    const ctx = ctxOf(req);
                    const { prompt } = (await req.json()) as { prompt: string };
                    if (!prompt?.trim()) return Response.json({ error: 'Empty prompt' }, { status: 400 });
                    return Response.json({ url: openInConductor(prompt, conductorPath(ctx)) });
                },
            },
            '/api/issues/:number/ask': {
                POST: async req => {
                    const { ws, db } = ctxOf(req);
                    const number = Number(req.params.number);
                    const { question, mode = 'thread' } = (await req.json()) as { question: string; mode?: AskMode };
                    return startJob(`${ws.id}:ask:${number}:${crypto.randomUUID()}`, async () => {
                        const repoSha = mode === 'code' ? await updateRepo(ws.checkoutPath, { managed: ws.managed }) : undefined;
                        return askQuestion(db, number, {
                            question,
                            mode,
                            model: process.env.ASK_MODEL ?? DEFAULT_ASK_MODEL,
                            repoPath: ws.checkoutPath,
                            dbPath: ws.dbPath,
                            repoSha,
                        });
                    });
                },
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
