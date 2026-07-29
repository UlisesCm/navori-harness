## GitHub CLI (gh)

To interact with GitHub (issues, PRs, repos) use **gh**:

- View an issue: `gh issue view <number>` or `gh issue view <number> --comments`
- Search issues: `gh issue list --search "<query>"` or `gh issue list --label bug --state open`
- Create a PR: `gh pr create --title "..." --body "..."`
- View a PR + checks: `gh pr view <number> --checks` or `gh pr checks <number>`
- List PRs: `gh pr list --state open`
- View workflow runs: `gh run list --limit 5` or `gh run view <id> --log-failed`

`gh auth status` shows whether you're authenticated. If it fails, run `gh auth login`.
