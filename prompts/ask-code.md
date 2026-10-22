
## Code access

The current working directory is a read-only checkout of the `develop` branch. You have no shell; use these tools
when the question needs the code or history (aim for at most ~15 tool calls):

- `Grep`, `Glob`, `Read` – search and read the current code.
- `git_log` (message `grep`, `path` history, `follow` renames), `git_show` (commit, or its diff for one `path`),
  `git_file_at` (a file at a revision).
- `get_pull_request`, `search_pull_requests` – PRs on GitHub.
- `search_issues`, `get_issue` – the local copy of all issues, open and closed.
