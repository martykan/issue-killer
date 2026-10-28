import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSettings } from './settings.ts';

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

-- User preferences (see src/settings.ts); values are JSON.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
    team_relevance    TEXT NOT NULL,              -- relevance to the user's team (settings.myTeam)
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
    repo_sha         TEXT NOT NULL,               -- checkout commit the agent looked at
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

-- Open pull requests (full refresh on every sync; merged/closed ones are dropped). List-ish fields are JSON.
CREATE TABLE IF NOT EXISTS pull_requests (
    number          INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    url             TEXT NOT NULL,
    author          TEXT,
    is_draft        INTEGER NOT NULL,
    review_decision TEXT,                         -- APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    ci_state        TEXT,                         -- SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null
    mergeable       TEXT,                         -- MERGEABLE | CONFLICTING | UNKNOWN
    additions       INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    comments_count  INTEGER NOT NULL DEFAULT 0,
    labels          TEXT NOT NULL DEFAULT '[]',   -- ["label", …]
    assignees       TEXT NOT NULL DEFAULT '[]',   -- ["login", …]
    review_requests TEXT NOT NULL DEFAULT '[]',   -- ["login" | "team:slug", …]
    reviews         TEXT NOT NULL DEFAULT '[]',   -- [{ author, state, submittedAt }] latest per reviewer
    closing_issues  TEXT NOT NULL DEFAULT '[]',   -- [issue number, …] (same repo)
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Claude-written executive summaries of a team's board (history kept; the UI shows the latest).
CREATE TABLE IF NOT EXISTS board_summaries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    team_slug    TEXT NOT NULL,
    result_json  TEXT NOT NULL,
    model        TEXT NOT NULL,
    cost_usd     REAL,
    duration_ms  INTEGER,
    generated_at TEXT NOT NULL
);

-- Draft release plan (Plan view): pending edits not yet applied to GitHub. NULL = unchanged, '' = cleared.
CREATE TABLE IF NOT EXISTS plan_changes (
    issue_number INTEGER PRIMARY KEY REFERENCES issues(number) ON DELETE CASCADE,
    release      TEXT,                            -- iteration title of the Release field
    assignee     TEXT,                            -- login that should own the issue
    changed_at   TEXT NOT NULL
);

-- Claude's release-plan suggestions per project team (latest shown).
CREATE TABLE IF NOT EXISTS plan_suggestions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    team         TEXT NOT NULL,
    result_json  TEXT NOT NULL,
    model        TEXT NOT NULL,
    cost_usd     REAL,
    generated_at TEXT NOT NULL
);

-- Claude-generated topic maps (Topics view). One map per scope; regenerating replaces the latest.
CREATE TABLE IF NOT EXISTS topic_maps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope        TEXT NOT NULL,                   -- "all" | "team:<project Team value>"
    issue_count  INTEGER NOT NULL,
    model        TEXT NOT NULL,
    cost_usd     REAL,
    generated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id      INTEGER NOT NULL REFERENCES topic_maps(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    position    INTEGER NOT NULL,
    duplicate_groups TEXT NOT NULL DEFAULT '[]' -- [[issue, issue, …], …] (subtopics only)
);
CREATE TABLE IF NOT EXISTS topic_issues (
    topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    issue_number INTEGER NOT NULL,
    PRIMARY KEY (topic_id, issue_number)
);
CREATE INDEX IF NOT EXISTS topic_issues_issue_idx ON topic_issues(issue_number);

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
    migrate(db);
    db.exec(SCHEMA);
    loadSettings(db);
    return db;
}

/** In-place upgrades of DBs created by older versions. */
function migrate(db: Database) {
    const columns = (table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (columns('issue_analysis').includes('connect_relevance')) {
        db.exec('ALTER TABLE issue_analysis RENAME COLUMN connect_relevance TO team_relevance');
    }
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
