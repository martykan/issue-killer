import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getState, openDb } from './db.ts';
import { GitHubClient, resolveToken } from './github.ts';
import { analyzeBatch, analyzeIssue, selectIssues } from './analysis/run.ts';
import { type CloseRequest, closeIssue } from './actions.ts';
import { type AskMode, askQuestion, DEFAULT_ASK_MODEL, listQuestions } from './ask.ts';
import { DEFAULT_INVESTIGATE_MODEL, investigateIssue, updateRepo } from './investigate.ts';
import { getAnalysis, getInvestigation, getIssue, getMeta, listIssues, prepareTempTables } from './queries.ts';
import { type SyncResult, syncRepo } from './sync.ts';
import { getTeamsOverview } from './teams.ts';
import { generateTopicMap, getTopicMap } from './topics.ts';
import { runChecks } from './doctor.ts';
import { buildHandoffPrompt, conductorUrl, openInConductor } from './handoff.ts';
import { getSettings, type Settings, updateSettings } from './settings.ts';
import { getBoard } from './board.ts';
import { getLatestSummary, summarizeBoard } from './board-summary.ts';
import { acceptMoves, applyPlan, suggestPlan } from './plan-actions.ts';
import { defaultProject, discardPlanChanges, getPlan, setPlanChange } from './planning.ts';


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
    const DEFAULT_REPO = 'trezor/trezor-suite';
    const topicScope = (params: URLSearchParams) => {
        const scope = params.get('scope');
        if (scope) return scope;
        const team = getSettings().myProjectTeam;
        return team ? `team:${team}` : 'all';
    };
    // Board default: the user's team from Settings, else the first team that has members.
    const defaultBoardTeam = () =>
        getSettings().myTeam ??
        db.query<{ slug: string }, []>('SELECT team_slug AS slug FROM team_members GROUP BY team_slug ORDER BY team_slug LIMIT 1').get()?.slug ??
        null;

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
    async function runSync(request: { repo?: string; projects?: number[] } = {}) {
        syncStatus = { running: true, startedAt: new Date().toISOString(), finishedAt: null, progress: 'Starting…', error: null, result: null };
        try {
            const repo = request.repo ?? opts.repo ?? getState(db, 'repo') ?? DEFAULT_REPO;
            const [owner, name] = repo.split('/');
            if (!owner || !name) throw new Error(`Invalid repo: ${repo}`);
            const gh = new GitHubClient(await resolveToken());
            syncStatus.result = await syncRepo(db, gh, {
                owner,
                name,
                full: false,
                pageSize: 50,
                projects: request.projects,
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

    const server = Bun.serve({
        port: opts.port,
        hostname: opts.hostname ?? '127.0.0.1',
        development: 'html' in opts.ui ? (opts.development ?? false) : false,
        routes: {
            '/': 'html' in opts.ui ? opts.ui.html : () => new Response(Bun.file(join(staticDir!, 'index.html'))),
            '/api/meta': () => {
                // Recompute derived tables so a sync running alongside the server is picked up on reload.
                prepareTempTables(db);
                return Response.json({ ...getMeta(db), settings: getSettings() });
            },
            '/api/sync': {
                GET: () => Response.json(syncStatus),
                POST: async req => {
                    if (syncStatus.running) return Response.json(syncStatus, { status: 409 });
                    // Optional { repo, projects } – used by the setup wizard on first start.
                    const body = (await req.json().catch(() => ({}))) as { repo?: string; projects?: number[] };
                    void runSync(body);
                    return Response.json(syncStatus, { status: 202 });
                },
            },
            // Setup wizard: what's configured so far.
            '/api/setup': () =>
                Response.json({
                    repo: getState(db, 'repo') ?? opts.repo ?? null,
                    defaultRepo: DEFAULT_REPO,
                    projects: (getState(db, 'projects') ?? '').split(',').filter(Boolean).map(Number),
                    issues: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM issues').get()?.n ?? 0,
                    repoPath: opts.repoPath,
                    hasCheckout: existsSync(join(opts.repoPath, '.git')),
                }),
            // Setup wizard: blob-less clone of the repo for Investigate / Ask with code (~800 MB).
            '/api/setup/checkout': {
                POST: () =>
                    startJob('setup-checkout', async () => {
                        if (existsSync(join(opts.repoPath, '.git'))) return { cloned: false };
                        const repo = getState(db, 'repo') ?? opts.repo ?? DEFAULT_REPO;
                        const proc = Bun.spawn(
                            ['git', 'clone', '--filter=blob:none', '--single-branch', '--branch', 'develop', `https://github.com/${repo}.git`, opts.repoPath],
                            { stdout: 'ignore', stderr: 'pipe' },
                        );
                        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
                        if (code !== 0) throw new Error(`git clone failed: ${stderr.trim().split('\n').at(-1)}`);
                        return { cloned: true };
                    }),
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
            '/api/settings': {
                GET: () => Response.json(getSettings()),
                PUT: async req => Response.json(updateSettings(db, (await req.json()) as Partial<Settings>)),
            },
            '/api/health': async () => Response.json(await runChecks(db, { repoPath: opts.repoPath })),
            '/api/jobs/:id': req => {
                const job = jobs.get(req.params.id);
                return job ? Response.json(job) : Response.json({ error: 'Job not found (server restarted?)' }, { status: 404 });
            },
            '/api/issues/:number/analyze': {
                POST: req => {
                    const number = Number(req.params.number);
                    return startJob(`analyze:${number}`, async () => {
                        prepareTempTables(db);
                        await analyzeIssue(db, number, { model: process.env.ANALYZE_MODEL ?? 'sonnet' });
                        return getAnalysis(db, number);
                    });
                },
            },
            '/api/issues/:number/investigate': {
                POST: req => {
                    const number = Number(req.params.number);
                    return startJob(`investigate:${number}`, async () => {
                        const repoSha = await updateRepo(opts.repoPath);
                        await investigateIssue(db, number, {
                            model: process.env.INVESTIGATE_MODEL ?? DEFAULT_INVESTIGATE_MODEL,
                            repoPath: opts.repoPath,
                            dbPath: opts.dbPath,
                            repoSha,
                        });
                        return getInvestigation(db, number);
                    });
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
            '/api/board': req => {
                const team = new URL(req.url).searchParams.get('team') || defaultBoardTeam();
                const board = team ? getBoard(db, team) : null;
                return board
                    ? Response.json({ ...board, summary: getLatestSummary(db, board.team.slug) })
                    : Response.json({ error: `Unknown team ${team}` }, { status: 404 });
            },
            '/api/board/summary': {
                POST: req => {
                    const team = new URL(req.url).searchParams.get('team') || defaultBoardTeam();
                    if (!team) return Response.json({ error: 'No team selected' }, { status: 400 });
                    const slug: string = team;
                    return startJob(`board-summary:${slug}`, () => summarizeBoard(db, slug, process.env.SUMMARY_MODEL));
                },
            },
            // Plan view: ?team=<project Team value>&project=<n>
            '/api/plan': req => {
                const params = new URL(req.url).searchParams;
                const project = Number(params.get('project')) || defaultProject(db);
                const plan = project ? getPlan(db, project, params.get('team') || getSettings().myProjectTeam || '') : null;
                return plan ? Response.json(plan) : Response.json({ error: 'No synced project. Run: bun run sync --project <n>' }, { status: 404 });
            },
            '/api/plan/changes': {
                POST: async req => {
                    const body = (await req.json()) as { issue: number; release?: string; assignee?: string } | { accept: { issue: number; release: string; assignee: string | null }[] };
                    if ('accept' in body) acceptMoves(db, body.accept);
                    else setPlanChange(db, body.issue, body);
                    return Response.json({ ok: true });
                },
                DELETE: async req => {
                    const body = (await req.json().catch(() => ({}))) as { issues?: number[] };
                    discardPlanChanges(db, body.issues);
                    return Response.json({ ok: true });
                },
            },
            '/api/plan/suggest': {
                POST: req => {
                    const params = new URL(req.url).searchParams;
                    const project = Number(params.get('project')) || defaultProject(db)!;
                    const team = params.get('team') ?? '';
                    return startJob(`plan-suggest:${team}`, () => suggestPlan(db, project, team, process.env.PLAN_MODEL));
                },
            },
            // Writes to GitHub (project Release field + assignees): only on an explicit click.
            '/api/plan/apply': {
                POST: req => {
                    const params = new URL(req.url).searchParams;
                    const project = Number(params.get('project')) || defaultProject(db)!;
                    const team = params.get('team') ?? '';
                    return startJob(`plan-apply:${team}`, async () => applyPlan(db, new GitHubClient(await resolveToken()), project, team));
                },
            },
            // Topics view: ?scope=all | team:<project Team value> (default: your project team)
            '/api/topics': req => {
                const scope = topicScope(new URL(req.url).searchParams);
                return Response.json({ scope, map: getTopicMap(db, scope) });
            },
            '/api/topics/generate': {
                POST: req => {
                    const scope = topicScope(new URL(req.url).searchParams);
                    return startJob(`topics:${scope}`, async () => {
                        await generateTopicMap(db, scope, process.env.TOPICS_MODEL);
                        return getTopicMap(db, scope);
                    });
                },
            },
            '/api/topics/:id': req => {
                const t = db.query<{ name: string; parent: string | null }, [number]>(
                    'SELECT t.name, p.name AS parent FROM topics t LEFT JOIN topics p ON p.id = t.parent_id WHERE t.id = ?',
                ).get(Number(req.params.id));
                return t ? Response.json(t) : Response.json({ error: 'Topic not found' }, { status: 404 });
            },
            '/api/issues': req => Response.json(listIssues(db, new URL(req.url).searchParams)),
            '/api/issues/:number': req => {
                const number = Number(req.params.number);
                const issue = getIssue(db, number);
                return issue
                    ? Response.json({ ...issue, questions: listQuestions(db, number) })
                    : Response.json({ error: 'Not found' }, { status: 404 });
            },
            '/api/issues/:number/handoff': {
                GET: req => {
                    const prompt = buildHandoffPrompt(db, Number(req.params.number));
                    return Response.json({ prompt, url: conductorUrl(prompt), repoPath: getSettings().conductorRepoPath });
                },
                POST: async req => {
                    const { prompt } = (await req.json()) as { prompt: string };
                    if (!prompt?.trim()) return Response.json({ error: 'Empty prompt' }, { status: 400 });
                    return Response.json({ url: openInConductor(prompt) });
                },
            },
            '/api/issues/:number/ask': {
                POST: async req => {
                    const number = Number(req.params.number);
                    const { question, mode = 'thread' } = (await req.json()) as { question: string; mode?: AskMode };
                    return startJob(`ask:${number}:${crypto.randomUUID()}`, async () => {
                        const repoSha = mode === 'code' ? await updateRepo(opts.repoPath) : undefined;
                        return askQuestion(db, number, {
                            question,
                            mode,
                            model: process.env.ASK_MODEL ?? DEFAULT_ASK_MODEL,
                            repoPath: opts.repoPath,
                            dbPath: opts.dbPath,
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
