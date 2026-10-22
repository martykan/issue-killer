import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildIssuePrompt } from './analysis/prompt.ts';
import { runClaude } from './claude.ts';
import { readOnlyAgentTools } from './investigate.ts';
import { promptPath } from './paths.ts';
import { getAnalysis, getInvestigation, prepareTempTables } from './queries.ts';

export type AskMode = 'thread' | 'code';
export const DEFAULT_ASK_MODEL = 'sonnet';

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string', description: 'The answer, GitHub-flavored markdown' } },
};

// Earlier Q&A on the same issue included as context for follow-ups.
const HISTORY_LIMIT = 6;

export type QuestionRow = {
    id: number;
    question: string;
    answer: string;
    mode: AskMode;
    model: string;
    sessionId: string | null;
    costUsd: number | null;
    durationMs: number | null;
    askedAt: string;
};

export function listQuestions(db: Database, number: number): QuestionRow[] {
    return db
        .query<QuestionRow, [number]>(
            `SELECT id, question, answer, mode, model, session_id AS sessionId, cost_usd AS costUsd,
                    duration_ms AS durationMs, asked_at AS askedAt
             FROM issue_questions WHERE issue_number = ? ORDER BY id`,
        )
        .all(number);
}

/**
 * Answers a free-form question about an issue. `thread` mode only sees the issue context; `code` mode runs the
 * same sandboxed read-only agent as investigations (needs `repoPath`, updated by the caller).
 */
export async function askQuestion(
    db: Database,
    number: number,
    opts: { question: string; mode: AskMode; model?: string; repoPath: string; dbPath: string; repoSha?: string },
): Promise<QuestionRow> {
    const question = opts.question.trim();
    if (!question) throw new Error('Empty question');
    const model = opts.model ?? DEFAULT_ASK_MODEL;
    prepareTempTables(db);

    const { prompt: issuePrompt } = buildIssuePrompt(db, number);
    const analysis = getAnalysis(db, number);
    const investigation = getInvestigation(db, number);
    const history = listQuestions(db, number).slice(-HISTORY_LIMIT);

    const prompt = [
        issuePrompt,
        analysis
            ? `\n## Earlier Claude triage (thread-only)\n\n${analysis.summary}\nRecommendation: ${analysis.recommendation} (${analysis.confidence}) – ${analysis.reasoning}\nNext step: ${analysis.next_step}`
            : '',
        investigation
            ? `\n## Earlier agent investigation\n\nVerdict: ${investigation.verdict} (${investigation.confidence}) – ${investigation.explanation}`
            : '',
        ...(history.length
            ? ['\n## Earlier questions about this issue', ...history.map(h => `\n**Q:** ${h.question}\n\n**A:** ${h.answer}`)]
            : []),
        opts.mode === 'code' && opts.repoSha ? `\n---\nThe checkout is at develop ${opts.repoSha}.` : '',
        `\n---\n## Question\n\n${question}`,
    ].join('\n');

    const systemPrompt =
        readFileSync(promptPath('ask.md'), 'utf8') + (opts.mode === 'code' ? readFileSync(promptPath('ask-code.md'), 'utf8') : '');

    const run = await runClaude<{ answer: string }>({
        systemPrompt,
        prompt,
        schema: SCHEMA,
        model,
        ...(opts.mode === 'code'
            ? { ...readOnlyAgentTools(resolve(opts.repoPath), opts.dbPath), persistSession: true, maxBudgetUsd: 2, timeoutMs: 10 * 60_000 }
            : {}),
    });

    const askedAt = new Date().toISOString();
    const id = Number(
        db
            .query(
                `INSERT INTO issue_questions (issue_number, question, answer, mode, model, session_id, cost_usd, duration_ms, asked_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(number, question, run.result.answer, opts.mode, run.model, run.sessionId, run.costUsd, run.durationMs, askedAt)
            .lastInsertRowid,
    );
    return {
        id,
        question,
        answer: run.result.answer,
        mode: opts.mode,
        model: run.model,
        sessionId: run.sessionId,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
        askedAt,
    };
}
