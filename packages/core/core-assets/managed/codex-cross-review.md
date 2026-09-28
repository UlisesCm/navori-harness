## Cross-model review (Codex second opinion)

For a second opinion from a **different provider**, after `reviewer` approves a non-trivial diff—or for a critical-area change—you MAY ask Codex to review it against `AGENTS.md`:

```bash
codex exec "revisa el diff origin/{{prTarget}}...HEAD según los estándares del repo; inspecciona sin editar archivos ni hacer commits"
```

- Plain root `codex exec` does not select `.codex/agents/reviewer.toml`; its prompt is not a read-only boundary. Effective permissions and approvals depend on Codex configuration and host policy. Full Access can modify files and use the network; do not assume isolation or approvals.
- Authentication uses normal (possibly custom) `CODEX_HOME`, `CODEX_API_KEY`, or prior `codex login`; no credentials are copied. Do not pin `--model`.
- **Advisory, not a gate:** weigh findings against `reviewer`; they do not block the PR.

Use for `criticalAreas`, high-blast-radius changes, or user-requested cross-checks—not trivial diffs.
