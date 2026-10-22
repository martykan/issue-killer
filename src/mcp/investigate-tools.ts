/**
 * Read-only tools for the investigation agent, served over MCP (stdio).
 *
 * The agent runs in `claude --restricted` mode without any shell, so these tools are its only way to reach git,
 * GitHub and the issue DB. Every tool runs a fixed command / query with validated arguments; GitHub is only
 * queried with GETs from this process, so the token never reaches the agent.
 *
 * Usage: bun src/mcp/investigate-tools.ts --repo <checkout> --db <issues.db> --github owner/name
 */
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { values } = parseArgs({
    options: { repo: { type: 'string' }, db: { type: 'string' }, github: { type: 'string', default: 'trezor/trezor-suite' } },
});
if (!values.repo || !values.db) throw new Error('--repo and --db are required');
const repoPath = values.repo;
const [owner, name] = values.github.split('/') as [string, string];
const db = new Database(values.db, { readonly: true });
const token = process.env.GITHUB_TOKEN ?? Bun.spawnSync(['gh', 'auth', 'token']).stdout.toString().trim();

const MAX_OUTPUT = 20_000;
const clip = (s: string, n = MAX_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n[… truncated ${s.length - n} chars …]` : s);
const text = (s: string) => ({ content: [{ type: 'text' as const, text: clip(s) || '(no output)' }] });

function git(args: string[]): string {
    const p = Bun.spawnSync(['git', '-C', repoPath, '--no-pager', ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (p.exitCode !== 0) return `git error: ${p.stderr.toString().trim()}`;
    return p.stdout.toString();
}

// Revisions/paths come from the model: forbid anything that git could parse as an option.
const rev = z.string().regex(/^[\w./^~@-]{1,100}$/).refine(s => !s.startsWith('-'), 'must not start with -');
const path = z.string().max(300).refine(s => !s.startsWith('-') && !s.includes('..'), 'invalid path');

async function github(path: string): Promise<unknown> {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'issue-killer' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

const server = new McpServer({ name: 'issue-killer-investigate', version: '1.0.0' });

server.registerTool(
    'git_log',
    {
        description:
            'Search commit history of the develop checkout. All filters optional; `grep` patterns match commit messages (OR, case-insensitive). Returns "sha date subject" lines.',
        inputSchema: {
            grep: z.array(z.string().max(200)).max(10).optional(),
            path: path.optional(),
            since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            max: z.number().int().min(1).max(100).optional(),
            follow: z.boolean().optional().describe('Follow renames (requires path)'),
        },
    },
    ({ grep, path: p, since, max, follow }) => {
        const args = ['log', '--format=%h %ad %s', '--date=short', '-n', String(max ?? 30)];
        if (grep?.length) args.push('-i', ...grep.map(g => `--grep=${g}`));
        if (since) args.push(`--since=${since}`);
        if (follow && p) args.push('--follow');
        if (p) args.push('--', p);
        return text(git(args));
    },
);

server.registerTool(
    'git_show',
    {
        description:
            'Show a commit: message and changed files (stat). Pass `path` to include the diff for that file only, or `patch: true` for the full diff (truncated).',
        inputSchema: { rev, path: path.optional(), patch: z.boolean().optional() },
    },
    ({ rev: r, path: p, patch }) => {
        const args = ['show', '--format=%H%n%an %ad%n%n%B', '--date=short', '-M'];
        if (p) args.push(r, '--', p);
        else args.push(patch ? '--patch' : '--stat', r);
        return text(git(args));
    },
);

server.registerTool(
    'git_file_at',
    {
        description: 'Print a file as it was at a given revision (e.g. to compare with the current version).',
        inputSchema: { rev, path },
    },
    ({ rev: r, path: p }) => text(git(['show', `${r}:${p}`])),
);

server.registerTool(
    'search_issues',
    {
        description:
            'Search the local copy of all trezor-suite issues (open and closed) by words in title/body. Use to find duplicates or related issues.',
        inputSchema: {
            words: z.array(z.string().min(2).max(60)).min(1).max(6).describe('All words must match (title or body)'),
            state: z.enum(['open', 'closed', 'all']).optional(),
            limit: z.number().int().min(1).max(50).optional(),
        },
    },
    ({ words, state, limit }) => {
        const where = words.map(() => '(title LIKE ? OR body LIKE ?)');
        const args: (string | number)[] = words.flatMap(w => [`%${w}%`, `%${w}%`]);
        if (state && state !== 'all') {
            where.push('state = ?');
            args.push(state.toUpperCase());
        }
        const rows = db
            .query<{ number: number; state: string; state_reason: string | null; title: string; updated_at: string }, (string | number)[]>(
                `SELECT number, state, state_reason, title, updated_at FROM issues WHERE ${where.join(' AND ')}
                 ORDER BY updated_at DESC LIMIT ${limit ?? 20}`,
            )
            .all(...args);
        return text(rows.map(r => `#${r.number} [${r.state}${r.state_reason ? `/${r.state_reason}` : ''}] ${r.title} (updated ${r.updated_at.slice(0, 10)})`).join('\n'));
    },
);

server.registerTool(
    'get_issue',
    {
        description: 'Get another issue from the local copy: metadata, body and comments.',
        inputSchema: { number: z.number().int().positive() },
    },
    ({ number }) => {
        const i = db
            .query<Record<string, string | number | null>, [number]>('SELECT * FROM issues WHERE number = ?')
            .get(number);
        if (!i) return text(`Issue #${number} not found locally (may be a PR).`);
        const comments = db
            .query<{ author: string | null; created_at: string; body: string }, [number]>(
                'SELECT author, created_at, body FROM comments WHERE issue_number = ? ORDER BY created_at',
            )
            .all(number);
        return text(
            [
                `#${i.number} ${i.title} [${i.state}${i.state_reason ? `/${i.state_reason}` : ''}] by ${i.author}, created ${String(i.created_at).slice(0, 10)}`,
                '',
                clip(String(i.body), 6000),
                ...comments.map(c => `\n--- ${c.author} ${c.created_at.slice(0, 10)}\n${clip(c.body, 2000)}`),
            ].join('\n'),
        );
    },
);

server.registerTool(
    'get_pull_request',
    {
        description: 'Get a trezor-suite pull request from GitHub: state, merge date, description and changed files.',
        inputSchema: { number: z.number().int().positive() },
    },
    async ({ number }) => {
        const pr = (await github(`/repos/${owner}/${name}/pulls/${number}`)) as Record<string, unknown>;
        const files = (await github(`/repos/${owner}/${name}/pulls/${number}/files?per_page=100`)) as { filename: string; status: string }[];
        return text(
            [
                `PR #${number}: ${pr.title}`,
                `state: ${pr.state}, merged: ${pr.merged_at ?? 'no'}, base: ${(pr.base as { ref: string }).ref}, author: ${(pr.user as { login: string }).login}`,
                '',
                clip(String(pr.body ?? ''), 4000),
                '',
                `Files (${files.length}):`,
                ...files.map(f => `${f.status} ${f.filename}`),
            ].join('\n'),
        );
    },
);

server.registerTool(
    'search_pull_requests',
    {
        description: 'Search trezor-suite pull requests on GitHub by keywords (title/body). Returns number, state, merge date, title.',
        inputSchema: {
            query: z.string().min(2).max(200),
            merged_only: z.boolean().optional(),
        },
    },
    async ({ query, merged_only }) => {
        // Keep the agent's query to plain search terms: no qualifiers that could point outside this repo.
        const terms = query.replace(/[^\p{L}\p{N}\s._#-]/gu, ' ').replace(/\b\w+:/g, ' ');
        const q = `repo:${owner}/${name} is:pr ${merged_only ? 'is:merged ' : ''}${terms}`;
        const res = (await github(`/search/issues?per_page=20&q=${encodeURIComponent(q)}`)) as {
            items: { number: number; state: string; title: string; pull_request?: { merged_at: string | null } }[];
        };
        return text(
            res.items
                .map(i => `#${i.number} [${i.pull_request?.merged_at ? `merged ${i.pull_request.merged_at.slice(0, 10)}` : i.state}] ${i.title}`)
                .join('\n'),
        );
    },
);

await server.connect(new StdioServerTransport());
