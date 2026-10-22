import { tmpdir } from 'node:os';

export type ClaudeRun<T> = {
    result: T;
    /** Concrete model id that did the main work (e.g. claude-sonnet-5-5). */
    model: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
    sessionId: string | null;
};

type ClaudeOptions = {
    systemPrompt: string;
    prompt: string;
    schema: object;
    model: string;
    /** Defaults to a temp dir so no CLAUDE.md / project settings leak in. */
    cwd?: string;
    /** Built-in tools to enable; none by default. Must be non-code-running ones (Read, Grep, Glob, …). */
    tools?: string[];
    /** MCP servers ({ name: { command, args, env } }); the only ones loaded. */
    mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    /** Tools that may run without approval; anything else that needs approval is denied. */
    allowedTools?: string[];
    /** Keep the transcript so it can be inspected later with `claude --resume <sessionId>`. */
    persistSession?: boolean;
    maxBudgetUsd?: number;
    timeoutMs?: number;
};

type ClaudeJsonOutput = {
    is_error: boolean;
    subtype: string;
    result?: string;
    structured_output?: unknown;
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    session_id?: string;
    modelUsage?: Record<string, { costUSD?: number }>;
};

/**
 * Runs headless `claude -p` with a JSON schema and returns the structured output.
 *
 * Always uses `--restricted` (no Bash/code-running tools, file tools confined to cwd, no settings files) because
 * the model reads untrusted issue text. Permission allowlists alone are not a sandbox: in dontAsk mode the CLI
 * still let e.g. `python3 -c` / `gh auth token` through, while ignoring allow rules for MCP tools.
 */
export async function runClaude<T>(opts: ClaudeOptions): Promise<ClaudeRun<T>> {
    const args = [
        'claude',
        '-p',
        '--model',
        opts.model,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(opts.schema),
        '--system-prompt',
        opts.systemPrompt,
        '--tools',
        (opts.tools ?? []).join(','),
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--restricted',
        // Nobody answers permission prompts: anything not allowed below is denied.
        '--permission-prompts',
        'none',
    ];
    if (opts.mcpServers) args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools);
    if (!opts.persistSession) args.push('--no-session-persistence');
    if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd));

    const proc = Bun.spawn(args, {
        cwd: opts.cwd ?? tmpdir(),
        stdin: new TextEncoder().encode(opts.prompt),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 5 * 60_000);
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timer);

    let out: ClaudeJsonOutput;
    try {
        out = JSON.parse(stdout) as ClaudeJsonOutput;
    } catch {
        throw new Error(`claude exited with ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
    }
    if (out.is_error || !out.structured_output) {
        throw new Error(`claude failed (${out.subtype}): ${(out.result ?? stderr).slice(0, 300)}`);
    }

    // The CLI may also use a small model for housekeeping; report the one that cost the most.
    const model =
        Object.entries(out.modelUsage ?? {}).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))[0]?.[0] ??
        opts.model;
    return {
        result: out.structured_output as T,
        model,
        costUsd: out.total_cost_usd ?? 0,
        durationMs: out.duration_ms ?? 0,
        numTurns: out.num_turns ?? 0,
        sessionId: opts.persistSession ? (out.session_id ?? null) : null,
    };
}
