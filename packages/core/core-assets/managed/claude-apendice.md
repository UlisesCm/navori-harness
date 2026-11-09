## Claude Code specifics

- Destructive shell commands route to `ask`/`deny` permission rules.
- Native `Glob`/`Grep` are read-only and pre-approved.
- In auto mode, apply the shell-edit check to every `sed -i` and `>`.
- A `deny`/hook block is the answer; a hook `ask` is the user's call.
- Do NOT mirror the spec's task list in `TaskCreate` (ignore its reminder).
- Code discovery here: known file → Read/Edit; filename/path patterns → Glob; textual search with no provider → Grep.
- Skills cited by name live at `.claude/skills/<name>/SKILL.md` (tickets: `.claude/skills/resolve-ticket/SKILL.md`).
- A workspace's or app's own harness is its `CLAUDE.md` + `.claude/`.

**The permission mode decides what you CAN do — read it before planning how.** The host sets it, you never change it. `dontAsk` isn't supported today (`Edit`/`Write` aren't pre-approved, so the implement/review cycle can't run). Reference: https://code.claude.com/docs/en/permission-modes
