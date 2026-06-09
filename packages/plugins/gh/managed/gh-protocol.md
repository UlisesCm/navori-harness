## GitHub CLI (gh)

Para interactuar con GitHub (issues, PRs, repos) usá **gh**:

- Ver issue: `gh issue view <number>` o `gh issue view <number> --comments`
- Buscar issues: `gh issue list --search "<query>"` o `gh issue list --label bug --state open`
- Crear PR: `gh pr create --title "..." --body "..."`
- Ver PR + checks: `gh pr view <number> --checks` o `gh pr checks <number>`
- Listar PRs: `gh pr list --state open`
- Ver workflow runs: `gh run list --limit 5` o `gh run view <id> --log-failed`

`gh auth status` muestra si está autenticado. Si falla, correr `gh auth login`.
