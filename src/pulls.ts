import type { Database } from 'bun:sqlite';
import type { GitHubClient, RateLimit } from './github.ts';

// Open pull requests for the Board view. There are only a few hundred, so every sync replaces them wholesale.

const PULLS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes {
                number title url isDraft createdAt updatedAt additions deletions reviewDecision mergeable
                author { login }
                comments { totalCount }
                labels(first: 20) { nodes { name } }
                assignees(first: 10) { nodes { login } }
                reviewRequests(first: 15) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
                latestReviews(first: 15) { nodes { author { login } state submittedAt } }
                closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
                commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
            }
        }
    }
    rateLimit { remaining resetAt cost }
}`;

type PullNode = {
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
    createdAt: string;
    updatedAt: string;
    additions: number;
    deletions: number;
    reviewDecision: string | null;
    mergeable: string;
    author: { login: string } | null;
    comments: { totalCount: number };
    labels: { nodes: { name: string }[] };
    assignees: { nodes: { login: string }[] };
    reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
    latestReviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string | null }[] };
    closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};

export async function syncPullRequests(db: Database, gh: GitHubClient, owner: string, name: string, log: (msg: string) => void) {
    const repo = `${owner}/${name}`;
    const pulls: PullNode[] = [];
    let after: string | null = null;
    do {
        const data: {
            repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PullNode[] } };
            rateLimit: RateLimit;
        } = await gh.query(PULLS_QUERY, { owner, name, after });
        pulls.push(...data.repository.pullRequests.nodes);
        const { pageInfo } = data.repository.pullRequests;
        after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);

    db.transaction(() => {
        db.exec('DELETE FROM pull_requests');
        const insert = db.query(`
            INSERT INTO pull_requests (number, title, url, author, is_draft, review_decision, ci_state, mergeable, additions,
                deletions, comments_count, labels, assignees, review_requests, reviews, closing_issues, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const p of pulls) {
            const requests = p.reviewRequests.nodes
                .map(r => r.requestedReviewer)
                .filter(r => r !== null)
                .map(r => (r.__typename === 'Team' ? `team:${r.slug}` : r.login!));
            insert.run(
                p.number,
                p.title,
                p.url,
                p.author?.login ?? null,
                p.isDraft ? 1 : 0,
                p.reviewDecision,
                p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
                p.mergeable,
                p.additions,
                p.deletions,
                p.comments.totalCount,
                JSON.stringify(p.labels.nodes.map(l => l.name)),
                JSON.stringify(p.assignees.nodes.map(a => a.login)),
                JSON.stringify(requests),
                JSON.stringify(p.latestReviews.nodes.map(r => ({ author: r.author?.login ?? null, state: r.state, submittedAt: r.submittedAt }))),
                JSON.stringify(p.closingIssuesReferences.nodes.filter(i => i.repository.nameWithOwner === repo).map(i => i.number)),
                p.createdAt,
                p.updatedAt,
            );
        }
    })();
    log(`  ${pulls.length} open pull requests`);
}
