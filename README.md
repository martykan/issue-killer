# Issue Killer

Triage and clean up the [trezor-suite](https://github.com/trezor/trezor-suite) issue backlog (12k issues, ~1.3k open)
from a local copy of GitHub data, with Claude doing the reading.

- **Sync** issues, comments, linked PRs, labels, org teams and GitHub Project fields into SQLite, incrementally.
- **Browse** in a fast web UI (or native macOS app): filters, triage signals (stale, fixed-but-open, awaiting reply,
  reporter left, ownership gaps…), team dashboard with drill-down.
- **Analyze** issues with Claude: summary, recommendation (keep / prioritize / needs info / close …), owner team,
  severity, next step.
- **Investigate** with a sandboxed Claude agent that checks code, git history and PRs whether an issue is already
  resolved, obsolete or a duplicate, and drafts a closing comment you can post with one click.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- GitHub access: a logged-in [`gh`](https://cli.github.com) CLI (or `GITHUB_TOKEN`) with scopes `repo`, `read:org`
  (team membership) and `read:project` (GitHub Projects): `gh auth refresh -s read:org,read:project`
- For Claude features: a logged-in [`claude`](https://docs.claude.com/en/docs/claude-code) CLI
- For the desktop app: macOS and Electrobun's Hutch toolchain (see [Desktop app](#desktop-app))

## Quick start

```sh
bun install
bun run sync --project 58     # first run ~15 min; later runs only fetch changes
bun run ui                    # http://localhost:3000
```

## Sync

```sh
bun install
bun run sync            # incremental: only issues updated since the last run
bun run sync --full     # re-fetch everything, drop issues deleted/transferred on GitHub
bun run status          # quick summary of the local DB
```

Data lands in `data/issues.db` (SQLite). The first sync fetches all open and closed issues (~12k, ~15 min);
later runs only fetch what changed. An interrupted sync resumes where it stopped.

Options: `--repo owner/name`, `--db path`, `--page-size n` (lower it if GitHub returns 502s).

GitHub Projects: `bun run sync --project 58` also syncs the org project's items and custom fields (Team, Status,
Priority, Release, Platform); the project list is remembered for later syncs. Needs `gh auth refresh -s read:project`.
Project fields are the source of truth for team ownership (e.g. `Team = Connect devs 🔌`), and are available as UI
filters (`pf=Team=Connect devs 🔌`) and in the Claude prompts.

## Browse

```sh
bun run ui              # http://localhost:3000 (PORT=xxxx to change)
```

Filter by state, text (optionally incl. comments), labels (with live counts; "Connect" selects all `connect*` labels),
type, assignee, and triage signals. Filters live in the URL, so views can be bookmarked/shared.
Keys: `/` search, `j`/`k` move, `Esc` close. The **Sync** button in the top bar runs an incremental sync in the
server process and reloads the view when it finishes.

**Teams view** (top bar → Teams): open issues per project Team × Status, unassigned, priority, stale, awaiting reply
and Claude results; every number links to the matching issue list. Clicking a team shows its workload per assignee,
releases and a priority × status matrix. The team switcher in the top bar scopes the issue list to one team and is
remembered. Signals "No project team" and "Claude: other team" (Claude's owner differs from the project Team) help
fix ownership.

Triage signals are computed in SQL (`src/queries.ts`): closing PR merged, mentioned by a merged PR, stale >1y,
awaiting team reply, reporter left, no active assignee, no labels / assignee / type.

People are classified as member / former / bot / external. Sync stores current org members and teams
(needs `read:org`); GitHub doesn't know past membership, so non-members with 30+ issues/comments are assumed
to be former staff. The team filter matches issues assigned to and/or reported by a team's members.

## Desktop app

A native macOS app built with [Electrobun](https://electrobun.dev): the same Bun server runs in-process and the UI
is shown in a system WebView with native menus (copy/paste work), a unified title bar and macOS system colors.
Links to GitHub open in the default browser.

```sh
# one-time: Electrobun 2 builds through Hutch (installs into ~/.hutch)
npx electrobun@2.0.4 --help

bun run desktop:install                   # build + install into ~/Applications + launch
bun run desktop:build                     # only build → build/stable-macos-arm64/Issue Killer.app
bun run desktop                           # dev build + launch
```

The stable build is a compressed self-extracting stub: the first launch unpacks it in place (the "installer"
window), later launches start directly. Electrobun also keeps an uninstaller and cached archive in
`~/Library/Application Support/com.satoshilabs.issue-killer/`.

- Data lives in `~/Library/Application Support/Issue Killer` (`issues.db`, and `trezor-suite/` for Investigate).
  Point it elsewhere with `ISSUE_KILLER_DATA`, or share the CLI's data by symlinking that folder to `data/`.
- The app uses your login shell's `PATH`, so `gh`, `git` and `claude` work as in the terminal.
- `scripts/prepare-desktop.ts` (pre-build hook) bundles the UI, the investigation MCP server and the prompts into the app.

## Analyze with Claude

Each issue (body, comments, linked PRs, labels, people) is sent to a headless `claude -p` call with a JSON
schema and no tools. The result (summary, recommendation, owner team, Connect relevance, severity, effort,
reasoning, next step, suggested labels) is stored in `issue_analysis`.

```sh
bun run analyze --dry-run                                  # how many open issues need analysis
bun run analyze --filter "team=suite-connect" --budget 5   # UI-style filter, stop after $5
bun run analyze --issue 33570 --force                      # (re-)analyze specific issues
```

Analyses become *outdated* when the issue changes on GitHub or when the prompt (`prompts/analyze.md`) or schema
(`src/analysis/prompt.ts`) changes; re-running `analyze` only picks up missing/outdated ones. Default model is
`sonnet` (~$0.03/issue); override with `--model` (CLI) or `ANALYZE_MODEL` (server). In the UI you can filter by
recommendation, owner, relevance etc., analyze a single issue, or analyze everything in the current view.

Requires a logged-in `claude` CLI.

## Investigate & close

`analyze` only reads the issue thread. `investigate` runs a Claude agent that checks whether an issue is actually
resolved, obsolete or a duplicate by looking at the code, git history, PRs and other issues. It returns a verdict,
evidence and a drafted closing comment. **It never writes anything**; closing is a separate, explicit step.

```sh
# one-time: read-only checkout the agent works in (blob-less, ~800 MB)
git clone --filter=blob:none --single-branch --branch develop https://github.com/trezor/trezor-suite.git data/trezor-suite

bun run investigate --dry-run            # default: open issues triage wants to close or with a merged closing PR
bun run investigate --filter "team=suite-connect&rec=close_obsolete" --budget 5
bun run investigate --issue 8061

bun run close-proposed                   # dry run: what the agent proposes to close (high confidence only)
bun run close-proposed --min-confidence medium --execute   # close them on GitHub with the drafted comments
```

In the UI the issue detail has an **Investigate** button, the evidence, and a review form (reason, editable comment,
**Close on GitHub**). The sidebar filter "proposes close" builds a review queue. Every close is logged in `issue_actions`.
Each investigation keeps its transcript: `cd data/trezor-suite && claude --resume <session id>`.

**Isolation.** Issue text is untrusted, so the agent runs `claude --restricted` with only `Read`/`Grep`/`Glob`
(confined to the checkout) plus our MCP server (`src/mcp/investigate-tools.ts`): `git_log`, `git_show`,
`git_file_at`, `get_pull_request`, `search_pull_requests`, `search_issues`, `get_issue`. These run fixed git commands
or read-only DB/GitHub GET requests with validated arguments; the GitHub token stays in the MCP server process.
Don't give the agent `Bash` with a permission allowlist instead: in testing the CLI still let commands like
`python3 -c …` and `gh auth token` through.

## Project layout

```
src/
  cli.ts              CLI: sync, status, analyze, investigate, close-proposed
  sync.ts, projects.ts, github.ts   GitHub GraphQL sync (issues, org/teams, projects)
  db.ts               SQLite schema
  queries.ts, teams.ts             filters, signals, aggregations for the UI
  app-server.ts       HTTP API + UI server (used by `bun run ui` and the desktop app)
  analysis/           Claude triage: prompt building, runner
  investigate.ts      agentic investigation; mcp/investigate-tools.ts = its read-only tools
  actions.ts          closing issues on GitHub (+ audit log)
  claude.ts           headless `claude -p` wrapper (restricted mode, JSON schema)
  ui/                 React UI
  desktop/main.ts     Electrobun main process
prompts/              Claude prompts (edit to tune triage)
scripts/              desktop pre-build + install
```

## Tables

| table              | contents                                                                         |
| ------------------ | -------------------------------------------------------------------------------- |
| `issues`           | one row per issue: title, body, state, type, author, milestone, counts, dates    |
| `issue_labels`     | issue ↔ label                                                                    |
| `issue_assignees`  | issue ↔ assignee login                                                           |
| `comments`         | all issue comments                                                               |
| `issue_references` | PRs/issues that mention an issue; `will_close = 1` for linked closing PRs        |
| `labels`           | repo labels with color and description                                           |
| `org_members`      | current org members                                                              |
| `teams`, `team_members` | org teams and their members (incl. child teams)                             |
| `projects`, `project_items`, `project_item_values` | GitHub Projects, their items and custom field values |
| `sync_state`       | sync cursor and last sync timestamp                                              |
| `issue_analysis`   | latest Claude analysis per issue (+ model, prompt version, cost)                 |
| `issue_investigations` | latest agent investigation: verdict, evidence, proposed action, draft comment, session id |
| `issue_actions`    | audit log of issues closed from this tool                                        |

Example:

```sh
sqlite3 data/issues.db "
  SELECT i.number, i.title, r.source_number AS pr
  FROM issues i JOIN issue_labels l ON l.issue_number = i.number AND l.label = 'connect'
  JOIN issue_references r ON r.issue_number = i.number
  WHERE i.state = 'OPEN' AND r.source_state = 'MERGED'"
```
