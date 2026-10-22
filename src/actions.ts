import type { Database } from 'bun:sqlite';
import type { GitHubClient } from './github.ts';

export const CLOSE_REASONS = { completed: 'COMPLETED', not_planned: 'NOT_PLANNED', duplicate: 'DUPLICATE' } as const;
export type CloseReason = keyof typeof CLOSE_REASONS;

export type CloseRequest = { reason: CloseReason; comment: string; duplicateOf?: number | null };

const ADD_COMMENT = `
mutation($id: ID!, $body: String!) {
    addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { url } } }
}`;

const CLOSE_ISSUE = `
mutation($id: ID!, $reason: IssueClosedStateReason!, $duplicateId: ID) {
    closeIssue(input: { issueId: $id, stateReason: $reason, duplicateIssueId: $duplicateId }) {
        issue { state stateReason closedAt updatedAt }
    }
}`;

let viewerLogin: string | undefined;

/**
 * Posts the comment (if any) and closes the issue on GitHub, then mirrors the change locally and records it in
 * issue_actions. Mutations are not retried to avoid double comments.
 */
export async function closeIssue(db: Database, gh: GitHubClient, number: number, req: CloseRequest) {
    const reason = CLOSE_REASONS[req.reason];
    if (!reason) throw new Error(`Invalid reason: ${req.reason}`);

    const issue = db
        .query<{ node_id: string; state: string }, [number]>('SELECT node_id, state FROM issues WHERE number = ?')
        .get(number);
    if (!issue) throw new Error(`Issue #${number} not in DB`);
    if (issue.state !== 'OPEN') throw new Error(`Issue #${number} is already closed`);

    let duplicateId: string | null = null;
    if (req.reason === 'duplicate') {
        if (!req.duplicateOf) throw new Error('duplicateOf is required for duplicates');
        const dup = db
            .query<{ node_id: string }, [number]>('SELECT node_id FROM issues WHERE number = ?')
            .get(req.duplicateOf);
        if (!dup) throw new Error(`Duplicate target #${req.duplicateOf} not in DB`);
        duplicateId = dup.node_id;
    }

    viewerLogin ??= (await gh.query<{ viewer: { login: string } }>('query { viewer { login } }', {})).viewer.login;

    let commentUrl: string | null = null;
    const comment = req.comment.trim();
    if (comment) {
        const res = await gh.query<{ addComment: { commentEdge: { node: { url: string } } } }>(
            ADD_COMMENT,
            { id: issue.node_id, body: comment },
            1,
        );
        commentUrl = res.addComment.commentEdge.node.url;
    }
    const closed = await gh.query<{ closeIssue: { issue: { stateReason: string; closedAt: string; updatedAt: string } } }>(
        CLOSE_ISSUE,
        { id: issue.node_id, reason, duplicateId },
        1,
    );
    const c = closed.closeIssue.issue;

    db.transaction(() => {
        db.query(
            `UPDATE issues SET state = 'CLOSED', state_reason = ?, closed_at = ?, updated_at = ?,
                    comments_count = comments_count + ? WHERE number = ?`,
        ).run(c.stateReason, c.closedAt, c.updatedAt, commentUrl ? 1 : 0, number);
        db.query(
            `INSERT INTO issue_actions (issue_number, action, state_reason, duplicate_of, comment, comment_url, performed_by, performed_at)
             VALUES (?, 'close', ?, ?, ?, ?, ?, ?)`,
        ).run(number, c.stateReason, req.duplicateOf ?? null, comment || null, commentUrl, viewerLogin ?? null, new Date().toISOString());
    })();

    return { number, stateReason: c.stateReason, closedAt: c.closedAt, commentUrl, performedBy: viewerLogin };
}

/** Maps an investigation's proposed action to a close request. */
export function closeRequestFromInvestigation(inv: {
    proposed_action: string;
    close_comment: string;
    duplicate_of: number | null;
}): CloseRequest | null {
    const reason = (
        { close_completed: 'completed', close_not_planned: 'not_planned', close_duplicate: 'duplicate' } as Record<string, CloseReason>
    )[inv.proposed_action];
    return reason ? { reason, comment: inv.close_comment, duplicateOf: inv.duplicate_of } : null;
}
