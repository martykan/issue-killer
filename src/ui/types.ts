export type Label = { name: string; color: string | null; description?: string | null };

export type Signal = { key: string; label: string; description: string; weak: boolean; count: number };

export type Meta = {
    repo: string | null;
    lastSyncAt: string | null;
    totals: { open: number; closed: number };
    signals: Signal[];
    labels: Label[];
    teams: { slug: string; name: string; members: number }[];
    hasOrgData: boolean;
    types: string[];
    assignees: string[];
    analysis: AnalysisStats;
    investigations: { total: number; proposedClose: number | null; cost: number | null };
    projects: ProjectStats[];
    settings: Settings;
    /** Current workspace (repository added to the app) and its code checkout. */
    workspace: string;
    checkoutPath: string;
};

export type Settings = { myTeam: string | null; myProjectTeam: string | null; setupDone: boolean; conductorRepoPath: string | null };

export type HealthCheck = { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string; needed: string };

export type ProjectStats = {
    number: number;
    title: string;
    url: string;
    fields: { name: string; options: { value: string; count: number }[] }[];
};

export type Investigation = {
    verdict: 'resolved' | 'partially_resolved' | 'not_resolved' | 'obsolete' | 'duplicate' | 'unclear';
    confidence: 'high' | 'medium' | 'low';
    proposed_action: 'close_completed' | 'close_not_planned' | 'close_duplicate' | 'keep_open';
    duplicate_of: number | null;
    explanation: string;
    evidence: { kind: string; ref: string; url: string; note: string }[];
    close_comment: string;
    model: string;
    repoSha: string;
    sessionId: string | null;
    costUsd: number | null;
    durationMs: number | null;
    numTurns: number | null;
    investigatedAt: string;
    outdated: boolean;
};

export type IssueAction = {
    action: string;
    stateReason: string | null;
    duplicateOf: number | null;
    comment: string | null;
    commentUrl: string | null;
    performedBy: string | null;
    performedAt: string;
};

export type AnalysisFilterKey = 'rec' | 'owner' | 'rel' | 'kind' | 'severity' | 'confidence';

export type AnalysisStats = {
    promptVersion: string;
    enums: {
        kind: string[];
        owner_team: string[];
        team_relevance: string[];
        recommendation: string[];
        confidence: string[];
        severity: string[];
        effort: string[];
    };
    analyzedOpen: number;
    outdatedOpen: number;
    totalCostUsd: number;
    counts: Record<AnalysisFilterKey, Record<string, number>>;
};

export type AnalysisSummary = {
    summary: string;
    recommendation: string;
    confidence: string;
    ownerTeam: string;
    teamRelevance: string;
    severity: string;
};

export type Analysis = {
    summary: string;
    kind: string;
    area: string;
    owner_team: string;
    team_relevance: string;
    recommendation: string;
    confidence: string;
    reasoning: string;
    next_step: string;
    severity: string;
    effort: string;
    suggested_labels: string[];
    model: string;
    promptVersion: string;
    costUsd: number | null;
    durationMs: number | null;
    analyzedAt: string;
    outdated: boolean;
};

export type AnalyzeStatus = {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    costUsd: number;
    lastMessage: string | null;
    error: string | null;
};

export type IssueSummary = {
    number: number;
    title: string;
    state: 'OPEN' | 'CLOSED';
    stateReason: string | null;
    issueType: string | null;
    author: string | null;
    commentsCount: number;
    reactionsCount: number;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    labels: string[];
    assignees: string[];
    signals: string[];
    analysis: AnalysisSummary | null;
    investigation: { verdict: string; confidence: string; proposedAction: string } | null;
    /** Custom project field values (Team, Status, …). */
    project: Record<string, string>;
};

export type IssueList = {
    total: number;
    page: number;
    pageSize: number;
    labelCounts: { label: string; n: number }[];
    items: IssueSummary[];
};

export type PersonStatus = 'member' | 'former' | 'bot' | 'external';

export type Comment = {
    id: string;
    author: string | null;
    authorAssociation: string;
    body: string;
    url: string;
    reactionsCount: number;
    createdAt: string;
    updatedAt: string;
    authorStatus: PersonStatus | null;
};

export type Reference = {
    type: 'PullRequest' | 'Issue';
    repo: string;
    number: number;
    title: string | null;
    state: string | null;
    url: string | null;
    willClose: number;
    referencedAt: string | null;
};

export type IssueRef = { number: number; title: string; state: string };

export type IssueDetail = Omit<IssueSummary, 'labels' | 'assignees' | 'analysis' | 'investigation' | 'project'> & {
    body: string;
    url: string;
    authorAssociation: string;
    authorStatus: PersonStatus | null;
    milestone: string | null;
    thumbsUpCount: number;
    syncedAt: string;
    labels: Label[];
    assignees: { login: string; status: PersonStatus | null }[];
    comments: Comment[];
    references: Reference[];
    parent: IssueRef | null;
    children: IssueRef[];
    analysis: Analysis | null;
    investigation: Investigation | null;
    actions: IssueAction[];
    projects: { title: string; url: string; fields: Record<string, string> }[];
    questions: Question[];
};

export type Question = {
    id: number;
    question: string;
    answer: string;
    mode: 'thread' | 'code';
    model: string;
    sessionId: string | null;
    costUsd: number | null;
    durationMs: number | null;
    askedAt: string;
};

export type SyncStatus = {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    progress: string | null;
    error: string | null;
    result: { issues: number; comments: number; removed: number; durationMs: number } | null;
};
