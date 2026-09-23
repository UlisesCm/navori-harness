# El scribe es dueño del Markdown — Requirements

## Context

El `implementer` escribe todo el Markdown del ciclo: su reporte `impl_<feature>.md` y la prosa que
entra al diff (skills, agentes, docs, specs, README). El `scribe`, cuyo trabajo es escribir Markdown,
existe en el roster desde la spec 0027 pero no tiene ningún contrato que lo invoque. Esta spec
invierte eso para el `implementer` (issue #985): no escribe ningún `.md`, y todo el Markdown pasa
al `scribe`.

La ampliación del `scribe` pasa por la prueba de admisión de la spec 0031 (R7): sale apagada
detrás de un flag y se sostiene solo si su señal medida la justifica.

## Requirements (EARS)

- **R1** — The `implementer` contract SHALL NOT instruct the agent to create or edit any file whose name ends in `.md` or `.mdx`, and SHALL state that prohibition explicitly.
- **R2** — WHEN the `implementer` finishes (done or blocked), it SHALL write its evidence to `.claude/progress/impl_<feature>.json` with the required keys `feature`, `status` (`DONE` | `BLOCKED`), `worktree`, `branch`, `commits`, `filesTouched`, `verification`, and `markdownRequests`.
- **R3** — IF a Claude Code tool call to `Write`, `Edit` or `NotebookEdit` comes from a subagent whose `agent_type` is `implementer` and targets a path ending in `.md` or `.mdx`, THEN the harness SHALL deny it with a reason that names `markdownRequests` as the route.
- **R4** — IF a `Bash` call from the `implementer` matches one of the listed write forms targeting a `.md`/`.mdx` path — output redirection (`>`, `>>`), `tee`, in-place edit (`sed -i`, `perl -i`), or `cp`/`mv` onto that path — THEN the harness SHALL deny it with the same reason as R3. This detection is best-effort against inertia, not a sandbox against deliberate evasion.
- **R5** — WHEN the `scribe` is dispatched for a feature, it SHALL render `.claude/progress/impl_<feature>.md` from `impl_<feature>.json`, preserving the evidence without adding claims.
- **R6** — IF `impl_<feature>.json` is missing, unparseable, or its `feature` does not match the dispatch, THEN the `scribe` SHALL report `BLOCKED` and SHALL NOT create the Markdown artifact.
- **R7** — WHEN `markdownRequests` is non-empty, the `scribe` SHALL draft the prose for each request from its `intent` and `evidence` — reading the repository as needed for accuracy, without taking design decisions the request does not state — and apply it in the implementer's worktree and branch, touching only the listed paths, in a commit of its own.
- **R8** — WHEN the orchestrator dispatches the `scribe`, it SHALL use the configured scribe model for handoff-only work and `sonnet` when any `markdownRequests` path belongs to the shipped diff.
- **R9** — The orchestrator flow SHALL chain `implementer` → `scribe` → `reviewer` for changes that include Markdown, and `scribe` → `reviewer` for prose-only changes, with the `reviewer` judging the complete diff including the scribe's commit.
- **R10** — WHEN an `Agent` call whose `tool_input.subagent_type` is `implementer` returns, the handoff hook SHALL flag an `impl_<feature>.json` that is missing, unparseable, or lacks a required key; and WHEN one whose `subagent_type` is `scribe` returns, it SHALL flag an `impl_<feature>.md` without its `Status:` line.
- **R11** — The spec 0027 design SHALL carry an amendment that records this spec as superseding its withdrawal of R4/R7 for the `implementer`, with the measured cost that replaces the 2026-09-21 estimate.
- **R12** — The spec SHALL declare, per spec 0031 R1–R3, the guarantee the expanded `scribe` gives (net tokens counting each delegation's cold start, and quality of shipped prose), the signal that measures it, its cost against its output, and a retirement criterion with a deadline.
- **R13** — The behavior of R1–R10 SHALL be gated by `harness.scribeOwnsMarkdown`, default `false`: WHILE it is `false`, the rendered contracts and hooks SHALL behave as before this spec; WHEN it is `true`, R1–R10 apply.
- **R14** — WHEN the retirement criterion of R12 is met, the flag SHALL stay `false` in this repo and the spec 0031 roster table SHALL record the result, so #993 proceeds with evidence.
