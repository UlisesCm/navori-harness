## Session closeout

Before closing the session:

1. **Quality gate**: {{qualityGate.full}} — confirm it passes (or document debt in `progress/current.md`).
2. **History**: add an entry in `progress/history.md` with `## YYYY-MM-DD HH:MM <agent> — <summary>` + changes + gate status.
3. **Clear current**: leave `progress/current.md` at `idle` or with the explicit next step.
4. **No temporaries**: delete scratch files; don't leave `console.log`, `debugger`, or commented-out code.
5. **Conventional commit**: `feat|fix|chore|docs(scope): message`, Spanish MX, atomic. Never commit `.claude/` or `CLAUDE.md`.
