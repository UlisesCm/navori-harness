# Main-session model advisor — Requirements

## Context
The harness already assigns cost-aware profiles to subagents. This feature advises only the user's active main session when verified host metadata identifies an expensive model/effort combination; it never changes subagent configuration.

## Requirements (EARS)
- **R1** — WHEN Claude reports an Opus model and `high`, `xhigh`, or `max` effort at the first main-thread tool-use event, the system SHALL show the approved recommendation once for that session.
- **R2** — WHEN Claude reports `claude-fable-5` for the main session, the system SHALL show the approved recommendation once for that session regardless of effort.
- **R3** — WHEN Codex SessionStart reports `gpt-6-astra`, the system SHALL show the approved recommendation once for that session.
- **R4** — The recommendation SHALL explain token efficiency and the harness safeguards, and SHALL tell the user how to open the native `/model` selector to change to medium effort.
- **R5** — IF the host metadata is absent, malformed, unsupported, or belongs to a subagent THEN the system SHALL not emit a recommendation.
- **R6** — The system SHALL not change the main-session model, effort, `navori.config.json`, or any subagent profile.
- **R7** — The system SHALL not implement the `gpt-5.6-sol/high+` condition until Codex exposes active reasoning effort in a verified host contract.
- **R8** — WHEN the host fires a tool event inside a subagent, the system SHALL discard it before spawning any subprocess.
