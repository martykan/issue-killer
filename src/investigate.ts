import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildIssuePrompt } from './analysis/prompt.ts';
import { investigateMcpScript, promptPath } from './paths.ts';
import { runClaude } from './claude.ts';
import { buildFilter, getAnalysis, prepareTempTables } from './queries.ts';

export const DEFAULT_REPO_PATH = 'data/trezor-suite';
export const DEFAULT_INVESTIGATE_MODEL = 'sonnet';

export const VERDICTS = ['resolved', 'partially_resolved', 'not_resolved', 'obsolete', 'duplicate', 'unclear'] as const;
export const ACTIONS = ['close_completed', 'close_not_planned', 'close_duplicate', 'keep_open'] as const;

export type InvestigationResult = {
    verdict: (typeof VERDICTS)[number];
    confidence: 'high' | 'medium' | 'low';
    proposed_action: (typeof ACTIONS)[number];
    duplicate_of: number | null;
    explanation: string;
    evidence: { kind: string; ref: string; url: string; note: string }[];
    close_comment: string;
};

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'confidence', 'proposed_action', 'duplicate_of', 'explanation', 'evidence', 'close_comment'],
    properties: {
        verdict: { type: 'string', enum: VERDICTS },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        proposed_action: { type: 'string', enum: ACTIONS },
        duplicate_of: { type: ['integer', 'null'] },
        explanation: { type: 'string' },
        evidence: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'ref', 'url', 'note'],
                properties: {
                    kind: { type: 'string', enum: ['pr', 'commit', 'code', 'issue', 'release', 'comment'] },
                    ref: { type: 'string' },
                    url: { type: 'string' },
                    note: { type: 'string' },
                },
            },
        },
        close_comment: { type: 'string' },
    },
};

// The agent gets no shell: only file tools confined to the checkout (restricted mode) and our read-only MCP tools.
const MCP_SERVER = 'ik';
const MCP_TOOLS = ['git_log', 'git_show', 'git_file_at', 'search_issues', 'get_issue', 'get_pull_request', 'search_pull_requests'];
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', ...MCP_TOOLS.map(t => `mcp__${MCP_SERVER}__${t}`)];

/**
 * Sandboxed, read-only toolbox for agents working on the trezor-suite checkout (investigation, code questions):
 * file tools confined to the checkout + our MCP server for git, PRs and the issue DB. No shell.
 */
export function readOnlyAgentTools(repoPath: string, dbPath: string) {
    return {
        cwd: repoPath,
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ALLOWED_TOOLS,
        mcpServers: {
            [MCP_SERVER]: {
                command: process.execPath,
                args: [investigateMcpScript(), '--repo', repoPath, '--db', resolve(dbPath)],
            },
        },
    };
}

export function investigationPromptVersion() {
    return createHash('sha256')
        .update(readFileSync(promptPath('investigate.md'), 'utf8'))
        .update(JSON.stringify(SCHEMA))
        .digest('hex')
        .slice(0, 10);
}

/** Fast-forwards the dedicated read-only checkout to the latest develop. Returns the HEAD sha. */
export async function updateRepo(repoPath: string): Promise<string> {
    if (!existsSync(join(repoPath, '.git'))) {
        throw new Error(
            `No checkout at ${repoPath}. Create it with:\n  git clone --filter=blob:none --single-branch --branch develop https://github.com/trezor/trezor-suite.git ${repoPath}`,
        );
    }
    const git = (...args: string[]) => {
        const p = Bun.spawnSync(['git', '-C', repoPath, ...args]);
        if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim()}`);
        return p.stdout.toString().trim();
    };
    git('fetch', '--quiet', 'origin', 'develop');
    git('reset', '--quiet', '--hard', 'origin/develop');
    return git('rev-parse', '--short', 'HEAD');
}

export type InvestigationOutcome = { number: number; result: InvestigationResult; costUsd: number; durationMs: number; numTurns: number };

export async function investigateIssue(
    db: Database,
    number: number,
    opts: { model?: string; repoPath?: string; dbPath: string; repoSha: string },
): Promise<InvestigationOutcome> {
    const model = opts.model ?? DEFAULT_INVESTIGATE_MODEL;
    const repoPath = resolve(opts.repoPath ?? DEFAULT_REPO_PATH);
    prepareTempTables(db);

    const systemPrompt = readFileSync(promptPath('investigate.md'), 'utf8');
    const { prompt: issuePrompt, updatedAt } = buildIssuePrompt(db, number);
    const analysis = getAnalysis(db, number);
    const prompt = [
        issuePrompt,
        analysis
            ? `\n## Earlier triage note (thread-only, unverified)\n\n${analysis.summary}\nRecommendation: ${analysis.recommendation} – ${analysis.reasoning}`
            : '',
        `\n---\nThe checkout is at develop ${opts.repoSha}. Investigate issue #${number} and return your verdict.`,
    ].join('\n');

    const run = await runClaude<InvestigationResult>({
        systemPrompt,
        prompt,
        schema: SCHEMA,
        model,
        ...readOnlyAgentTools(repoPath, opts.dbPath),
        persistSession: true,
        maxBudgetUsd: 3,
        timeoutMs: 15 * 60_000,
    });
    const r = run.result;
    if (r.proposed_action !== 'close_duplicate') r.duplicate_of = null;

    db.query(
        `INSERT OR REPLACE INTO issue_investigations (
            issue_number, verdict, confidence, proposed_action, duplicate_of, explanation, close_comment, result_json,
            model, prompt_version, repo_sha, session_id, issue_updated_at, cost_usd, duration_ms, num_turns, investigated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        number,
        r.verdict,
        r.confidence,
        r.proposed_action,
        r.duplicate_of,
        r.explanation,
        r.close_comment,
        JSON.stringify(r),
        run.model,
        investigationPromptVersion(),
        opts.repoSha,
        run.sessionId,
        updatedAt,
        run.costUsd,
        run.durationMs,
        run.numTurns,
        new Date().toISOString(),
    );
    return { number, result: r, costUsd: run.costUsd, durationMs: run.durationMs, numTurns: run.numTurns };
}

export type InvestigateBatchOptions = {
    filter: string;
    issues: number[];
    limit?: number;
    concurrency: number;
    model: string;
    repoPath: string;
    dbPath: string;
    force: boolean;
    budgetUsd?: number;
    dryRun: boolean;
    log?: (msg: string) => void;
};

/**
 * By default picks open issues that look closable – Claude triage recommends closing, or a closing PR was
 * merged – and haven't been investigated since they last changed.
 */
export function selectForInvestigation(db: Database, opts: Pick<InvestigateBatchOptions, 'filter' | 'issues' | 'limit' | 'force'>) {
    prepareTempTables(db);
    if (opts.issues.length) return opts.issues;
    const params = new URLSearchParams(opts.filter);
    const { where, args } = buildFilter(params);
    const conditions = [where ? where.replace(/^WHERE /, '') : '1'];
    if (!params.has('rec') && !params.has('signal')) {
        conditions.push(`(EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number AND a.recommendation LIKE 'close_%')
            OR EXISTS (SELECT 1 FROM issue_references r WHERE r.issue_number = i.number AND r.will_close = 1 AND r.source_state = 'MERGED'))`);
    }
    if (!opts.force) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM issue_investigations v WHERE v.issue_number = i.number AND v.issue_updated_at >= i.updated_at)`);
    }
    return db
        .query<{ number: number }, (string | number)[]>(
            `SELECT i.number FROM issues i WHERE ${conditions.join(' AND ')} ORDER BY i.updated_at DESC ${opts.limit ? `LIMIT ${opts.limit}` : ''}`,
        )
        .all(...args)
        .map(r => r.number);
}

export async function investigateBatch(db: Database, opts: InvestigateBatchOptions) {
    const log = opts.log ?? console.log;
    const numbers = selectForInvestigation(db, opts);
    log(`${numbers.length} issues to investigate with ${opts.model}`);
    if (opts.dryRun || !numbers.length) return { done: 0, failed: 0, costUsd: 0 };

    const repoSha = await updateRepo(opts.repoPath);
    log(`Checkout ${opts.repoPath} at develop ${repoSha}`);

    const queue = [...numbers];
    let done = 0;
    let failed = 0;
    let costUsd = 0;
    let stopped = false;
    const worker = async () => {
        while (!stopped) {
            const number = queue.shift();
            if (number === undefined) return;
            try {
                const o = await investigateIssue(db, number, { ...opts, repoSha });
                done++;
                costUsd += o.costUsd;
                const r = o.result;
                log(
                    `[${done + failed}/${numbers.length}] #${number} → ${r.verdict} (${r.confidence}) → ${r.proposed_action}` +
                        `${r.duplicate_of ? ` #${r.duplicate_of}` : ''} · ${o.numTurns} turns · $${o.costUsd.toFixed(2)} · ${(o.durationMs / 1000).toFixed(0)}s`,
                );
            } catch (err) {
                failed++;
                log(`[${done + failed}/${numbers.length}] #${number} FAILED: ${(err as Error).message}`);
            }
            if (opts.budgetUsd !== undefined && costUsd >= opts.budgetUsd && !stopped) {
                stopped = true;
                log(`Budget of $${opts.budgetUsd} reached ($${costUsd.toFixed(2)}), stopping after in-flight runs.`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
    log(`Investigated ${done}, failed ${failed}, total cost $${costUsd.toFixed(2)}`);
    return { done, failed, costUsd };
}
