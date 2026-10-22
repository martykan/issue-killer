import type { Database } from 'bun:sqlite';
import { listQuestions } from './ask.ts';
import { getAnalysis, getInvestigation } from './queries.ts';
import { getSettings } from './settings.ts';

// "Hand off to Conductor": a prompt with everything we know about an issue, opened as a new Conductor workspace
// via its deep link (https://docs.conductor.build/core/deep-links): conductor://prompt=…&path=…

const MAX_PROMPT = 4000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildHandoffPrompt(db: Database, number: number): string {
    const issue = db
        .query<{ title: string; url: string; state: string }, [number]>('SELECT title, url, state FROM issues WHERE number = ?')
        .get(number);
    if (!issue) throw new Error(`Issue #${number} not in DB`);
    const repo = db.query<{ value: string }, []>("SELECT value FROM sync_state WHERE key = 'repo'").get()?.value ?? '';
    const labels = db
        .query<{ label: string }, [number]>('SELECT label FROM issue_labels WHERE issue_number = ? ORDER BY label')
        .all(number)
        .map(l => l.label);
    const project = db
        .query<{ field: string; value: string }, [number]>(
            `SELECT v.field, v.value FROM project_items pi JOIN project_item_values v ON v.item_id = pi.item_id
             WHERE pi.number = ? AND pi.content_type = 'Issue' AND pi.archived = 0
               AND pi.repo = (SELECT value FROM sync_state WHERE key = 'repo')`,
        )
        .all(number);
    const refs = db
        .query<{ source_type: string; source_number: number; source_state: string | null; source_title: string | null; will_close: number }, [number]>(
            `SELECT source_type, source_number, source_state, source_title, will_close FROM issue_references
             WHERE issue_number = ? AND source_type = 'PullRequest' AND source_repo = (SELECT value FROM sync_state WHERE key = 'repo')
             ORDER BY referenced_at DESC LIMIT 6`,
        )
        .all(number);
    const analysis = getAnalysis(db, number);
    const investigation = getInvestigation(db, number);
    const questions = listQuestions(db, number).slice(-2);

    const lines = [
        `Work on GitHub issue ${repo}#${number}: "${issue.title}"`,
        issue.url,
        '',
        // Note: non-interactive `gh issue view --comments` prints only the comments; JSON gives body + comments.
        `Start by reading the full issue (body and all comments): \`gh issue view ${number} --repo ${repo} --json title,body,comments\``,
        '',
        'Context from triage (gathered by an assistant, may be incomplete or wrong – verify against the code):',
    ];
    if (labels.length) lines.push(`- Labels: ${labels.join(', ')}`);
    if (project.length) lines.push(`- Project: ${project.map(p => `${p.field}: ${p.value}`).join(' · ')}`);
    for (const r of refs) {
        lines.push(`- Linked PR #${r.source_number} [${(r.source_state ?? '').toLowerCase()}]${r.will_close ? ' (linked as closing)' : ''}: ${r.source_title ?? ''}`);
    }
    if (analysis) {
        lines.push(`- Triage summary: ${clip(analysis.summary, 400)}`);
        lines.push(`- Triage recommendation: ${analysis.recommendation} (${analysis.confidence}) – ${clip(analysis.reasoning, 400)}`);
        lines.push(`- Suggested next step: ${clip(analysis.next_step, 300)}`);
    }
    if (investigation) {
        lines.push(`- Code investigation: ${investigation.verdict} (${investigation.confidence}) – ${clip(investigation.explanation, 500)}`);
        const evidence = (investigation.evidence as { ref: string; note: string }[]).slice(0, 4);
        for (const e of evidence) lines.push(`  - ${e.ref}: ${clip(e.note, 160)}`);
    }
    for (const q of questions) lines.push(`- Q: ${clip(q.question, 160)}\n  A: ${clip(q.answer.replace(/\s+/g, ' '), 400)}`);
    lines.push(
        '',
        'Task: find the root cause and fix it, with tests where reasonable, then open a draft PR that references ' +
            `#${number}. If it turns out to be already fixed, obsolete or not reproducible, don't change code – explain your findings instead.`,
    );
    return clip(lines.join('\n'), MAX_PROMPT);
}

export function conductorUrl(prompt: string): string {
    const params = [`prompt=${encodeURIComponent(prompt)}`];
    const path = getSettings().conductorRepoPath;
    if (path) params.push(`path=${encodeURIComponent(path)}`);
    return `conductor://${params.join('&')}`;
}

/** Opens the deep link in Conductor (macOS `open`). Only ever opens conductor:// URLs built here. */
export function openInConductor(prompt: string) {
    const url = conductorUrl(prompt);
    const proc = Bun.spawnSync(['open', url]);
    if (proc.exitCode !== 0) throw new Error(`Could not open Conductor: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}`);
    return url;
}
