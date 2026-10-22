import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_DB_PATH = 'data/issues.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
    number            INTEGER PRIMARY KEY,
    node_id           TEXT NOT NULL UNIQUE,
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    url               TEXT NOT NULL,
    state             TEXT NOT NULL,              -- OPEN | CLOSED
    state_reason      TEXT,                       -- COMPLETED | NOT_PLANNED | DUPLICATE | REOPENED
    issue_type        TEXT,                       -- Bug | Feature | Task
    author            TEXT,
    author_association TEXT,
    milestone         TEXT,
    parent_number     INTEGER,
    sub_issues_total  INTEGER NOT NULL DEFAULT 0,
    sub_issues_completed INTEGER NOT NULL DEFAULT 0,
    comments_count    INTEGER NOT NULL DEFAULT 0,
    reactions_count   INTEGER NOT NULL DEFAULT 0,
    thumbs_up_count   INTEGER NOT NULL DEFAULT 0,
    locked            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    closed_at         TEXT,
    synced_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issues_state_idx ON issues(state);
CREATE INDEX IF NOT EXISTS issues_updated_idx ON issues(updated_at);

CREATE TABLE IF NOT EXISTS labels (
    name        TEXT PRIMARY KEY,
    color       TEXT,
    description TEXT
);

CREATE TABLE IF NOT EXISTS issue_labels (
    issue_number INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    PRIMARY KEY (issue_number, label)
);
CREATE INDEX IF NOT EXISTS issue_labels_label_idx ON issue_labels(label);

CREATE TABLE IF NOT EXISTS issue_assignees (
    issue_number INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
    login        TEXT NOT NULL,
    PRIMARY KEY (issue_number, login)
);

CREATE TABLE IF NOT EXISTS comments (
    node_id      TEXT PRIMARY KEY,
    issue_number INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
    author       TEXT,
    author_association TEXT,
    body         TEXT NOT NULL,
    url          TEXT NOT NULL,
    reactions_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments(issue_number, created_at);

-- PRs/issues that reference an issue (cross-references + "closes #x" links).
CREATE TABLE IF NOT EXISTS issue_references (
    issue_number  INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
    source_type   TEXT NOT NULL,                  -- PullRequest | Issue
    source_repo   TEXT NOT NULL,
    source_number INTEGER NOT NULL,
    source_title  TEXT,
    source_state  TEXT,                           -- OPEN | CLOSED | MERGED
    source_url    TEXT,
    will_close    INTEGER NOT NULL DEFAULT 0,     -- PR is linked as closing this issue
    referenced_at TEXT,
    PRIMARY KEY (issue_number, source_repo, source_number)
);

-- Current org membership (needs read:org). GitHub only knows *current* membership, so people who left
-- show up as plain contributors everywhere.
CREATE TABLE IF NOT EXISTS org_members (
    login TEXT PRIMARY KEY,
    role  TEXT NOT NULL                           -- MEMBER | ADMIN
);

CREATE TABLE IF NOT EXISTS teams (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_slug TEXT
);

-- Includes members of child teams (e.g. suite ⊇ suite-connect).
CREATE TABLE IF NOT EXISTS team_members (
    team_slug TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
    login     TEXT NOT NULL,
    PRIMARY KEY (team_slug, login)
);

CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Latest LLM analysis per issue (see src/analysis). Enum-like columns are denormalized from result_json for filtering.
CREATE TABLE IF NOT EXISTS issue_analysis (
    issue_number      INTEGER PRIMARY KEY REFERENCES issues(number) ON DELETE CASCADE,
    summary           TEXT NOT NULL,
    kind              TEXT NOT NULL,
    area              TEXT,
    owner_team        TEXT NOT NULL,
    connect_relevance TEXT NOT NULL,
    recommendation    TEXT NOT NULL,
    confidence        TEXT NOT NULL,
    severity          TEXT NOT NULL,
    effort            TEXT NOT NULL,
    result_json       TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_version    TEXT NOT NULL,              -- hash of prompt + schema; differs => outdated
    issue_updated_at  TEXT NOT NULL,              -- issues.updated_at when analyzed; older => outdated
    cost_usd          REAL,
    duration_ms       INTEGER,
    analyzed_at       TEXT NOT NULL
);

-- Latest agentic investigation per issue (see src/investigate.ts): verdict + evidence from code/history.
CREATE TABLE IF NOT EXISTS issue_investigations (
    issue_number     INTEGER PRIMARY KEY REFERENCES issues(number) ON DELETE CASCADE,
    verdict          TEXT NOT NULL,               -- resolved | partially_resolved | not_resolved | obsolete | duplicate | unclear
    confidence       TEXT NOT NULL,
    proposed_action  TEXT NOT NULL,               -- close_completed | close_not_planned | close_duplicate | keep_open
    duplicate_of     INTEGER,
    explanation      TEXT NOT NULL,
    close_comment    TEXT NOT NULL,
    result_json      TEXT NOT NULL,
    model            TEXT NOT NULL,
    prompt_version   TEXT NOT NULL,
    repo_sha         TEXT NOT NULL,               -- develop commit the agent looked at
    session_id       TEXT,                        -- resume the transcript: cd data/trezor-suite && claude --resume <id>
    issue_updated_at TEXT NOT NULL,
    cost_usd         REAL,
    duration_ms      INTEGER,
    num_turns        INTEGER,
    investigated_at  TEXT NOT NULL
);

-- Audit log of actions performed on GitHub from this tool.
CREATE TABLE IF NOT EXISTS issue_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number INTEGER NOT NULL,
    action       TEXT NOT NULL,                   -- close
    state_reason TEXT,                            -- COMPLETED | NOT_PLANNED | DUPLICATE
    duplicate_of INTEGER,
    comment      TEXT,
    comment_url  TEXT,
    performed_by TEXT,
    performed_at TEXT NOT NULL
);

-- Free-form questions asked about an issue ("Ask Claude"), with answers. Earlier Q&A feeds follow-ups.
CREATE TABLE IF NOT EXISTS issue_questions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
    question     TEXT NOT NULL,
    answer       TEXT NOT NULL,
    mode         TEXT NOT NULL,                   -- thread | code
    model        TEXT NOT NULL,
    session_id   TEXT,                            -- code mode: claude --resume <id> (in the checkout)
    cost_usd     REAL,
    duration_ms  INTEGER,
    asked_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_questions_issue_idx ON issue_questions(issue_number, id);

-- GitHub Projects (v2) the team plans in (needs read:project).
CREATE TABLE IF NOT EXISTS projects (
    number      INTEGER PRIMARY KEY,
    node_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    fields_json TEXT NOT NULL,                    -- [{ name, type, options }] for custom fields
    synced_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_items (
    item_id        TEXT PRIMARY KEY,
    project_number INTEGER NOT NULL REFERENCES projects(number) ON DELETE CASCADE,
    content_type   TEXT NOT NULL,                 -- Issue | PullRequest | DraftIssue
    repo           TEXT,
    number         INTEGER,                       -- issue/PR number in repo
    archived       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS project_items_number_idx ON project_items(repo, number);

-- Custom field values per item (Team, Status, Priority, Release, …).
CREATE TABLE IF NOT EXISTS project_item_values (
    item_id TEXT NOT NULL REFERENCES project_items(item_id) ON DELETE CASCADE,
    field   TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (item_id, field)
);
CREATE INDEX IF NOT EXISTS project_item_values_field_idx ON project_item_values(field, value);
`;

export function openDb(path = DEFAULT_DB_PATH): Database {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    return db;
}

export function getState(db: Database, key: string): string | undefined {
    const row = db.query<{ value: string }, [string]>('SELECT value FROM sync_state WHERE key = ?').get(key);
    return row?.value;
}

export function setState(db: Database, key: string, value: string) {
    db.query('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        value,
    );
}
