# Pi Engine — Requirements

**Status:** T1–T7 implementation/tests are complete, and the reviewed content passed `SPEC_OK` and `QUALITY_OK` on the pre-rebase diff. Post-rebase validation and the `main` receipt/signature remain pending because `origin/main` advanced during review. The manual OAuth/account smoke remains a user action; no PR publication or signed target approval is claimed here.

## Context

Navori currently renders for Claude Code and other supported engines, but not Pi Coding Agent. The user wants Navori's harness workflows—including subagents, hooks, and existing MCP use—to work in Pi, authenticated with a ChatGPT Plus/Pro account.

## Requirements (EARS)

- **R1** — The system SHALL accept `pi` as an opt-in engine and render Pi-compatible project resources without changing the output of other configured engines.
- **R2** — WHEN a trusted project enables the Pi engine, THE system SHALL expose the supported Navori core roles (`scout`, `implementer`, and `reviewer`) as Pi-compatible subagents through a project extension, preserving role instructions, descriptions, and configured models, and mapping only explicitly supported tool names; a missing role definition or an empty/unrecognized tool mapping SHALL fail closed and SHALL NOT enable Pi's default tools.
- **R3** — WHEN a Navori harness control has a documented Pi extension event with equivalent semantics, THE system SHALL map that control to the event and SHALL classify it as enforced only when a test demonstrates the behavior; otherwise the control SHALL be advisory or unsupported with a reason.
- **R4** — WHEN Pi loads MCP servers for a project, THE system SHALL leave user- and project-owned MCP configuration intact and SHALL rely on Pi's native MCP implementation; it SHALL NOT create, overwrite, migrate, or expose MCP credentials without an explicit server configuration requirement.
- **R5** — WHEN a user wants ChatGPT Plus/Pro authentication in Pi, THE system SHALL document Pi's native Codex OAuth login flow and SHALL NOT read, copy, generate, refresh, or log Pi authentication credentials.
- **R6** — WHEN Navori renders Pi resources, THE system SHALL preserve unmanaged project files, use Navori's backup/write and ownership protections for managed writes/removals, and SHALL emit syntactically valid JSON, Markdown, and TypeScript.
- **R7** — WHEN Pi project trust is not granted, THE system SHALL NOT auto-approve the parent project or claim that rendered project resources are active; a child process MAY receive Pi's process-scoped `--approve` only after the Navori project extension has loaded in a trusted parent, and non-interactive trust behavior SHALL be documented and tested.
- **R8** — WHEN the Pi subagent tool starts child agents, THE system SHALL bound recursion to one child level, concurrency to three children, per-child runtime to ten minutes, and cancellation to a five-second termination grace period; child agents SHALL NOT recursively register the parent orchestration tool, SHALL use an explicit Pi tool allowlist (or `--no-tools` when empty), and SHALL NOT be represented as OS-level sandboxes. The child runtime's inherited environment and Pi agent directory SHALL be documented as shared user authority, not credentials isolated by Navori.
- **R9** — The system SHALL provide tests for engine registration, deterministic rendering, ownership/preservation, control-to-event mapping, subagent role instructions/model/tool invocation and result parsing, bounded child execution, MCP preservation, trust behavior, and unsupported capability diagnostics without using live user credentials; tests SHALL verify the constructed child argv and process JSON protocol with a stub executable, and at least one credential-free runtime smoke SHALL run against the pinned supported Pi package version.
- **R10** — The system SHALL support Pi Coding Agent `@earendil-works/pi-coding-agent` version 0.87.1 or later on Node.js 22.19.0 or later, document a manual smoke test for selecting an available `openai-codex` model after Pi's `/login` flow, and keep authentication failures owned by Pi with actionable login guidance.

## Scope boundaries

- The Pi engine is opt-in; existing engine behavior remains unchanged.
- MCP protocol transport and account credentials remain Pi-owned.
- Claude/Codex hook scripts are not executed unchanged in Pi; only tested semantic mappings are supported.
- Pi-specific runtime files must not be installed into the user's global `~/.pi/agent` directory by Navori.
