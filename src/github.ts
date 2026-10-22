const GRAPHQL_URL = 'https://api.github.com/graphql';

export async function resolveToken(): Promise<string> {
    const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (fromEnv) return fromEnv;
    const proc = Bun.spawnSync(['gh', 'auth', 'token']);
    const token = proc.stdout.toString().trim();
    if (proc.exitCode !== 0 || !token) {
        throw new Error('No GitHub token. Set GITHUB_TOKEN or log in with `gh auth login`.');
    }
    return token;
}

type GraphQLResponse<T> = {
    data?: T;
    errors?: { type?: string; message: string }[];
};

export type RateLimit = { remaining: number; resetAt: string; cost: number };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class GitHubClient {
    constructor(private token: string) {}

    async query<T>(
        query: string,
        variables: Record<string, unknown>,
        attempts = 5,
    ): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            let retryAfterMs = 2 ** attempt * 1000;
            try {
                const res = await fetch(GRAPHQL_URL, {
                    method: 'POST',
                    headers: {
                        Authorization: `bearer ${this.token}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'issue-killer',
                    },
                    body: JSON.stringify({ query, variables }),
                });

                if (res.status === 403 || res.status === 429) {
                    // Secondary rate limit / abuse detection.
                    const retryAfter = Number(res.headers.get('retry-after'));
                    retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
                    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                }
                if (!res.ok) {
                    // 502/504 usually means the query was too heavy or GitHub hiccuped; retry.
                    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
                }

                const json = (await res.json()) as GraphQLResponse<T>;
                if (json.errors?.length) {
                    const msg = json.errors.map(e => e.message).join('; ');
                    if (json.errors.some(e => e.type === 'RATE_LIMITED')) {
                        retryAfterMs = 60_000;
                        throw new Error(msg);
                    }
                    // Non-transient (bad query, missing scope, ...) – fail fast.
                    throw Object.assign(new Error(`GraphQL error: ${msg}`), { fatal: true });
                }
                if (!json.data) throw new Error('Empty GraphQL response');

                await this.respectRateLimit((json.data as { rateLimit?: RateLimit }).rateLimit);
                return json.data;
            } catch (err) {
                if ((err as { fatal?: boolean }).fatal || attempt >= attempts) throw err;
                console.warn(
                    `  request failed (attempt ${attempt}/${attempts}): ${(err as Error).message}; retrying in ${Math.round(retryAfterMs / 1000)}s`,
                );
                await sleep(retryAfterMs);
            }
        }
    }

    private async respectRateLimit(rl: RateLimit | undefined) {
        if (!rl || rl.remaining > 100) return;
        const waitMs = new Date(rl.resetAt).getTime() - Date.now() + 1000;
        if (waitMs > 0) {
            console.warn(`  rate limit low (${rl.remaining} left), sleeping ${Math.round(waitMs / 1000)}s until reset`);
            await sleep(waitMs);
        }
    }
}
