# Solapamiento con capacidades nativas

<!-- Generado desde `OVERLAP_ROWS` (`packages/cli/src/engines/shared/native-overlap.ts`). No editar a mano: lo fija `native-overlap.test.ts`. -->

Una fila por unidad que navori distribuye. `complementa` significa que ninguna capacidad nativa verificada la reemplaza; solo una fila con URL y fecha puede salir de ahí (`OverlapRowSchema`).

| Tipo | Unidad | Veredicto | Claude | Codex | URL | Verificada |
|---|---|---|---|---|---|---|
| agent | `orchestrator` | complementa | emit | emit | — | — |
| agent | `implementer` | complementa | emit | emit | — | — |
| agent | `reviewer` | complementa | emit | emit | — | — |
| agent | `scout` | complementa | emit | emit | — | — |
| agent | `auditor` | complementa | emit | emit | — | — |
| agent | `publisher` | complementa | emit | emit | — | — |
| agent | `scribe` | complementa | emit | emit | — | — |
| agent | `architect` | complementa | emit | emit | — | — |
| skill | `verify-before-done` | complementa | emit | emit | — | — |
| skill | `debug-failure` | complementa | emit | emit | — | — |
| skill | `review-diff` | complementa | emit | emit | — | — |
| skill | `security-invariants` | complementa | emit | emit | — | — |
| skill | `secure-by-design` | complementa | emit | emit | — | — |
| skill | `locate-code` | complementa | emit | emit | — | — |
| skill | `scoped-gate` | complementa | emit | emit | — | — |
| skill | `resolve-ticket` | complementa | emit | emit | — | — |
| skill | `solution-design` | complementa | emit | emit | — | — |
| skill | `spec-bootstrap` | complementa | emit | emit | — | — |
| skill | `dominio` | complementa | emit | emit | — | — |
| skill | `follow-up-prs` | complementa | emit | emit | — | — |
| skill | `quality-attributes` | complementa | emit | emit | — | — |
| skill | `author-skill` | complementa | emit | emit | — | — |
| skill | `plan-simple` | complementa | emit | emit | — | — |
| skill | `plan-advanced` | complementa | emit | emit | — | — |
| skill | `master-plan` | complementa | emit | unsupported | — | — |
| skill | `context-intake` | complementa | emit | unsupported | — | — |
| hook | `guard-destructive` | complementa | emit | emit | — | — |
| hook | `implementer-no-markdown` | complementa | emit | emit | — | — |
| hook | `subagent-no-background` | complementa | emit | unsupported | — | — |
| hook | `session-start-context` | complementa | emit | emit | — | — |
| hook | `model-advisor` | complementa | emit | emit | — | — |
| hook | `subagent-stop-handoff` | complementa | emit | emit | — | — |
| hook | `managed-drift-watch` | complementa | emit | emit | — | — |
| hook | `routing-watch` | complementa | emit | emit | — | — |
| hook | `worktree-reclaim` | complementa | emit | emit | — | — |
| hook | `audit-mode-trigger` | complementa | emit | emit | — | — |
| hook | `audit-mode-close` | complementa | emit | emit | — | — |
| hook | `master-plan-context` | complementa | emit | unsupported | — | — |
| hook | `master-accept-confirm` | complementa | emit | unsupported | — | — |
| hook | `comment-draft-confirm` | complementa | emit | emit | — | — |
| hook | `pr-publisher-confirm` | complementa | emit | unsupported | — | — |
| hook | `quality-gate-pre-commit` | complementa | emit | emit | — | — |
| hook | `plan-gate` | complementa | emit | unsupported | — | — |
| hook | `stop-verify-reminder` | complementa | emit | emit | — | — |
| managed-block | `arranque-sesion` | complementa | emit | emit | — | — |
| managed-block | `cierre-sesion` | complementa | emit | emit | — | — |
| managed-block | `code-discovery-routing` | complementa | emit | emit | — | — |
| managed-block | `codex-cross-review` | complementa | emit | emit | — | — |
| managed-block | `formato-respuesta` | complementa | emit | emit | — | — |
| managed-block | `idioma-rol` | complementa | emit | emit | — | — |
| managed-block | `intake-tickets` | complementa | emit | emit | — | — |
| managed-block | `operaciones-seguras` | complementa | emit | emit | — | — |
| managed-block | `orquestacion` | complementa | emit | emit | — | — |
| managed-block | `plan-maestro` | complementa | emit | emit | — | — |
| managed-block | `planificacion` | complementa | emit | emit | — | — |
| managed-block | `sdd` | complementa | emit | emit | — | — |
| managed-block | `tipado-fuerte` | complementa | emit | emit | — | — |
| plugin | `acli` | complementa | emit | emit | — | — |
| plugin | `codegraph` | complementa | emit | emit | — | — |
| plugin | `engram` | complementa | emit | emit | — | — |
| plugin | `gh` | complementa | emit | emit | — | — |
| plugin | `jscpd` | complementa | emit | emit | — | — |
| plugin | `semgrep` | complementa | emit | emit | — | — |
| plugin | `tgrep` | complementa | emit | emit | — | — |
| flow | `master-plan-vs-plan-mode` | complementa | emit | unsupported | — | — |
| flow | `native-task-list` | complementa | emit | n/a | — | — |
| flow | `native-workflows` | complementa | emit | n/a | — | — |
