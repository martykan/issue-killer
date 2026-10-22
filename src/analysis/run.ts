import type { Database } from 'bun:sqlite';
import { runClaude } from '../claude.ts';
import { buildFilter, prepareTempTables } from '../queries.ts';
import { type AnalysisResult, buildIssuePrompt, buildSystemPrompt, promptVersion, RESULT_SCHEMA } from './prompt.ts';

export const DEFAULT_MODEL = 'sonnet';
export type AnalysisOutcome = {
    number: number;
    result: AnalysisResult;
    model: string;
    costUsd: number;
    durationMs: number;
};

export async function analyzeIssue(
    db: Database,
    number: number,
    opts: { model?: string; systemPrompt?: string } = {},
): Promise<AnalysisOutcome> {
    const model = opts.model ?? DEFAULT_MODEL;
    const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(db);
    const { prompt, updatedAt } = buildIssuePrompt(db, number);

    const run = await runClaude<AnalysisResult>({ systemPrompt, prompt, schema: RESULT_SCHEMA, model });

    saveAnalysis(db, number, run.result, {
        model: run.model,
        issueUpdatedAt: updatedAt,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
    });
    return { number, result: run.result, model: run.model, costUsd: run.costUsd, durationMs: run.durationMs };
}

function saveAnalysis(
    db: Database,
    number: number,
    r: AnalysisResult,
    meta: { model: string; issueUpdatedAt: string; costUsd: number; durationMs: number },
) {
    db.query(
        `INSERT OR REPLACE INTO issue_analysis (
            issue_number, summary, kind, area, owner_team, team_relevance, recommendation, confidence,
            severity, effort, result_json, model, prompt_version, issue_updated_at, cost_usd, duration_ms, analyzed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        number,
        r.summary,
        r.kind,
        r.area,
        r.owner_team,
        r.team_relevance,
        r.recommendation,
        r.confidence,
        r.severity,
        r.effort,
        JSON.stringify(r),
        meta.model,
        promptVersion(),
        meta.issueUpdatedAt,
        meta.costUsd,
        meta.durationMs,
        new Date().toISOString(),
    );
}

export type BatchOptions = {
    /** Same query-string filters as the UI, e.g. "team=suite-wallet&signal=stale". */
    filter: string;
    issues: number[];
    limit?: number;
    concurrency: number;
    model: string;
    force: boolean;
    budgetUsd?: number;
    dryRun: boolean;
    log?: (msg: string) => void;
};

/** Issues matching the filter that have no analysis yet, or whose analysis is outdated (issue changed / prompt changed). */
export function selectIssues(db: Database, opts: Pick<BatchOptions, 'filter' | 'issues' | 'limit' | 'force'>): number[] {
    prepareTempTables(db);
    if (opts.issues.length) return opts.issues;

    const { where, args } = buildFilter(new URLSearchParams(opts.filter));
    const pending = opts.force
        ? ''
        : `${where ? 'AND' : 'WHERE'} NOT EXISTS (SELECT 1 FROM issue_analysis a WHERE a.issue_number = i.number
               AND a.prompt_version = ? AND a.issue_updated_at >= i.updated_at)`;
    return db
        .query<{ number: number }, (string | number)[]>(
            `SELECT i.number FROM issues i ${where} ${pending} ORDER BY i.updated_at DESC ${opts.limit ? `LIMIT ${opts.limit}` : ''}`,
        )
        .all(...args, ...(opts.force ? [] : [promptVersion()]))
        .map(r => r.number);
}

export async function analyzeBatch(db: Database, opts: BatchOptions) {
    const log = opts.log ?? console.log;
    const numbers = selectIssues(db, opts);
    log(`${numbers.length} issues to analyze with ${opts.model} (prompt ${promptVersion()})`);
    if (opts.dryRun || !numbers.length) return { done: 0, failed: 0, costUsd: 0 };

    const systemPrompt = buildSystemPrompt(db);
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
                const o = await analyzeIssue(db, number, { model: opts.model, systemPrompt });
                done++;
                costUsd += o.costUsd;
                const r = o.result;
                log(
                    `[${done + failed}/${numbers.length}] #${number} → ${r.recommendation} (${r.confidence}) · ` +
                        `${r.owner_team} · relevance:${r.team_relevance} · $${o.costUsd.toFixed(3)} · ${(o.durationMs / 1000).toFixed(0)}s`,
                );
            } catch (err) {
                failed++;
                log(`[${done + failed}/${numbers.length}] #${number} FAILED: ${(err as Error).message}`);
            }
            if (opts.budgetUsd !== undefined && costUsd >= opts.budgetUsd && !stopped) {
                stopped = true;
                log(`Budget of $${opts.budgetUsd} reached ($${costUsd.toFixed(2)}), stopping after in-flight calls.`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

    log(`Analyzed ${done}, failed ${failed}, total cost $${costUsd.toFixed(2)}`);
    return { done, failed, costUsd };
}
