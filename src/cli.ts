import { parseArgs } from 'node:util';
import { closeIssue, closeRequestFromInvestigation } from './actions.ts';
import { analyzeBatch, DEFAULT_MODEL } from './analysis/run.ts';
import { DEFAULT_DB_PATH, getState, openDb } from './db.ts';
import { DEFAULT_INVESTIGATE_MODEL, DEFAULT_REPO_PATH, investigateBatch } from './investigate.ts';
import { GitHubClient, resolveToken } from './github.ts';
import { syncRepo } from './sync.ts';

const USAGE = `Usage: bun src/cli.ts <command> [options]

Commands:
  sync      Sync issues from GitHub into the local DB (incremental by default)
  analyze   Analyze issues with Claude (via the \`claude\` CLI); skips up-to-date analyses
  investigate  Let a Claude agent check code & history whether issues are resolved/obsolete/duplicate.
            Read-only: it proposes closing (with a draft comment); you close from the UI.
  close-proposed  List issues the agent proposes to close (dry run); with --execute, close them on GitHub
  status    Show what's in the local DB

Options:
  --repo <owner/name>   Repository (default: trezor/trezor-suite)
  --db <path>           SQLite file (default: ${DEFAULT_DB_PATH})

sync:
  --full                Re-sync everything and drop issues gone from GitHub
  --page-size <n>       Issues per GraphQL request (default: 50)
  --project <n>         Org project (v2) number to sync, repeatable; remembered for later syncs (needs read:project)

analyze:
  --filter <query>      UI-style filter, e.g. "team=suite-connect&signal=stale" (default: all open issues)
  --issue <n>           Analyze specific issue(s), repeatable; ignores --filter
  --limit <n>           Analyze at most n issues
  --concurrency <n>     Parallel claude processes (default: 4)
  --model <model>       Model alias or id (default: ${DEFAULT_MODEL})
  --budget <usd>        Stop once this much has been spent
  --force               Re-analyze even if up to date
  --dry-run             Only print how many issues would be analyzed

investigate (same --filter/--issue/--limit/--model/--budget/--force/--dry-run as analyze):
                        Default selection: open issues Claude triage recommends closing, or with a merged closing PR
  --concurrency <n>     Parallel agents (default for investigate: 2)
  --repo-path <path>    Read-only trezor-suite checkout (default: ${DEFAULT_REPO_PATH})

close-proposed:
  --min-confidence <c>  high (default) | medium | low
  --issue <n>           Only these issues
  --execute             Actually close (posts the drafted comment). Without it, only prints what would happen.
`;

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        repo: { type: 'string', default: 'trezor/trezor-suite' },
        db: { type: 'string', default: DEFAULT_DB_PATH },
        full: { type: 'boolean', default: false },
        'page-size': { type: 'string', default: '50' },
        project: { type: 'string', multiple: true },
        filter: { type: 'string', default: '' },
        issue: { type: 'string', multiple: true, default: [] },
        limit: { type: 'string' },
        concurrency: { type: 'string' },
        model: { type: 'string' },
        'repo-path': { type: 'string', default: DEFAULT_REPO_PATH },
        budget: { type: 'string' },
        force: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'min-confidence': { type: 'string', default: 'high' },
        execute: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

const command = positionals[0];

if (values.help || !command) {
    console.log(USAGE);
    process.exit(command || values.help ? 0 : 1);
}

const db = openDb(values.db);

switch (command) {
    case 'sync': {
        const [owner, name] = values.repo.split('/');
        if (!owner || !name) throw new Error(`Invalid --repo: ${values.repo}`);
        const gh = new GitHubClient(await resolveToken());
        const result = await syncRepo(db, gh, {
            owner,
            name,
            full: values.full,
            pageSize: Number(values['page-size']),
            projects: values.project?.map(Number),
        });
        console.log(
            `Done in ${(result.durationMs / 1000).toFixed(1)}s: ${result.issues} issues, ${result.comments} comments synced` +
                (result.removed ? `, ${result.removed} removed` : ''),
        );
        printStatus();
        break;
    }
    case 'analyze': {
        await analyzeBatch(db, {
            filter: values.filter,
            issues: values.issue.map(n => Number(n.replace('#', ''))),
            limit: values.limit ? Number(values.limit) : undefined,
            concurrency: Number(values.concurrency ?? 4),
            model: values.model ?? DEFAULT_MODEL,
            budgetUsd: values.budget ? Number(values.budget) : undefined,
            force: values.force,
            dryRun: values['dry-run'],
        });
        break;
    }
    case 'investigate': {
        await investigateBatch(db, {
            filter: values.filter,
            issues: values.issue.map(n => Number(n.replace('#', ''))),
            limit: values.limit ? Number(values.limit) : undefined,
            concurrency: Number(values.concurrency ?? 2),
            model: values.model ?? DEFAULT_INVESTIGATE_MODEL,
            repoPath: values['repo-path'],
            dbPath: values.db,
            budgetUsd: values.budget ? Number(values.budget) : undefined,
            force: values.force,
            dryRun: values['dry-run'],
        });
        break;
    }
    case 'close-proposed': {
        const levels = ['high', 'medium', 'low'];
        const allowed = levels.slice(0, levels.indexOf(values['min-confidence']) + 1);
        if (!allowed.length) throw new Error(`Invalid --min-confidence: ${values['min-confidence']}`);
        const only = values.issue.map(n => Number(n.replace('#', '')));
        const rows = db
            .query<{ number: number; title: string; confidence: string; proposed_action: string; close_comment: string; duplicate_of: number | null }, []>(
                `SELECT i.number, i.title, v.confidence, v.proposed_action, v.close_comment, v.duplicate_of
                 FROM issue_investigations v JOIN issues i ON i.number = v.issue_number
                 WHERE i.state = 'OPEN' AND v.proposed_action LIKE 'close_%' AND v.issue_updated_at >= i.updated_at
                   AND v.confidence IN (${allowed.map(l => `'${l}'`).join(',')})
                 ORDER BY i.number`,
            )
            .all()
            .filter(r => !only.length || only.includes(r.number));
        console.log(`${rows.length} issues proposed for closing (confidence: ${allowed.join('/')})${values.execute ? '' : ' – dry run'}\n`);
        const gh = values.execute ? new GitHubClient(await resolveToken()) : null;
        for (const r of rows) {
            const req = closeRequestFromInvestigation(r)!;
            console.log(`#${r.number} ${r.title}\n  → ${req.reason}${req.duplicateOf ? ` of #${req.duplicateOf}` : ''} (${r.confidence})\n  comment: ${req.comment.replace(/\n/g, ' ')}`);
            if (gh) {
                try {
                    const res = await closeIssue(db, gh, r.number, req);
                    console.log(`  ✓ closed${res.commentUrl ? `, ${res.commentUrl}` : ''}`);
                } catch (err) {
                    console.log(`  ✗ ${(err as Error).message}`);
                }
            }
            console.log();
        }
        break;
    }
    case 'status':
        printStatus();
        break;
    default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        process.exit(1);
}

function printStatus() {
    const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    console.log(`
Repo:          ${getState(db, 'repo') ?? '-'}
Last sync:     ${getState(db, 'last_sync_at') ?? 'never'}
Issues:        ${count('SELECT COUNT(*) n FROM issues')} (open: ${count("SELECT COUNT(*) n FROM issues WHERE state = 'OPEN'")})
Comments:      ${count('SELECT COUNT(*) n FROM comments')}
References:    ${count('SELECT COUNT(*) n FROM issue_references')}
Labels:        ${count('SELECT COUNT(*) n FROM labels')}
Analyzed:      ${count("SELECT COUNT(*) n FROM issue_analysis a JOIN issues i ON i.number = a.issue_number WHERE i.state = 'OPEN'")} open issues`);
}
