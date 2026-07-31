## Cross-model review (Codex second opinion)

This repo renders the `codex` engine, so a second opinion from a **different provider** is one command away. After your `reviewer` approves a non-trivial diff — or on any change touching a critical area — you MAY have Codex review the SAME diff against this repo's own standards (already rendered in `AGENTS.md` + `.codex/agents/reviewer.toml`):

```bash
CODEX_HOME=$(pwd)/.codex codex exec --sandbox read-only "revisa el diff origin/{{prTarget}}...HEAD según los estándares del repo"
```

- **Read-only:** Codex inspects, never edits or commits, and needs no approvals.
- The verdict lands on **stdout**; progress noise goes to stderr.
- Auth via `CODEX_API_KEY` or a prior `codex login`. Don't pass `--model` — Codex's default is correct.
- **Advisory, not a gate:** a second lens on the diff. Weigh its findings against your `reviewer`'s and decide; it doesn't block the PR on its own.

Reach for it in `criticalAreas`, on high-blast-radius changes, or when the user asks for a cross-check — not on every trivial diff.
