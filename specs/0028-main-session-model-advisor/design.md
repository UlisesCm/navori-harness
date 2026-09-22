# Main-session model advisor — Design

## Approach
Use engine-specific lifecycle hooks, not `models` or `effort` config. Claude stores the SessionStart/PostModelSwitch model in session scratch state and evaluates authoritative effort at its first main-thread PreToolUse event. Codex evaluates its documented SessionStart `model` field. Both emit an advisory only; `/model` remains the user-controlled selector. Covers R1–R7.

## Components
- `host-contracts.ts` — records each host payload and output behavior — R1–R5.
- Claude hook asset and settings renderer — tracks session-local model state and emits R1/R2 — R1–R6.
- Codex hook asset and config renderer — emits R3 — R3–R6.
- Shared classifier — maps verified model/effort tuples to copy — R1–R5, R7.
- i18n catalog — localized advisory copy — R4.

## Decisions
- The first release has no buttons or automatic switch: official hook outputs support advisory context/system messages, not an arbitrary model-switch UI. `/model` is the verified user-controlled path. Covers R4/R6.
- Claude state is session-scoped and only written after a valid model is received; no state means no advisory. This avoids guesses after recovery/clear. Covers R1/R5.
- Codex only covers Astra because its documented hook payload includes `model`, not effort. Covers R3/R7.

## Failure modes
- Missing Claude model or effort: no message.
- A subagent hook event: no message, and no subprocess — the shell guard exits before the `node` block, so the only cost is the hook's own `bash`. Covers R8.
- Repeated lifecycle/tool events: session state suppresses duplicate output.
- Unsupported model: no message.

## Testing strategy
- Classifier tests cover every supported and excluded tuple. // Covers: R1, R2, R3, R5, R7
- Claude and Codex renderer/hook tests cover delivery, duplicate suppression, missing metadata, and subagent exclusion, including a decoy `node` on the PATH that proves no spawn happens for a subagent firing. // Covers: R1–R6, R8
- Config/render tests prove agent model and effort profiles do not change. // Covers: R6

## NOT in scope
- Automatic model/effort changes, arbitrary interactive buttons, or persistent opt-out.
- Codex Sol high-effort recommendation until official host metadata exists.
