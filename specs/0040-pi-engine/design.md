# Pi Engine — Design

## Approach

Add `pi` as an opt-in disk engine on Navori's existing shared render spine and ship one Navori-owned, project-local Pi extension. The engine reuses Pi's native project skill discovery, MCP implementation, and ChatGPT Codex OAuth; the extension supplies the missing Navori subagent tool and only those hook/control mappings that Pi's documented event API can actually enforce. The supported baseline is Pi `@earendil-works/pi-coding-agent` 0.87.1+ on Node.js 22.19.0+; the exact baseline is pinned as a CLI dev dependency for credential-free runtime smoke tests. This implements the user-approved proposal B and covers **R1–R10**.

The shared engine contract already separates shared planning, provider placement, and shared backup/write execution (`packages/cli/src/engines/README.md`, “Las 3 capas”; `EngineAdapter`; `commitWrites`). It is sufficient for markdown skills and agent definitions but not for standalone JSON or executable TypeScript: the current marker dialect is `html | shell` (`packages/cli/src/engines/shared/execute-plan.ts`, `PlacementRequest`), and raw bodies go through managed-section injection (`collectRequest`). Therefore the Pi adapter must use a Pi-specific full-file ownership/serialization boundary for its runtime/config outputs and send all accepted changes/removals through the existing `commitWrites` choke point. It must not retrofit invalid comment markers or perform raw writes outside that choke point.

Do not create or alter `.pi/mcp.json`, Pi settings, `builtin:mcp`, or global `~/.pi/agent` state. Pi's MCP builtin is already enabled by default, Pi discovers project extensions under `.pi/extensions/`, and it discovers shared skills under `.agents/skills/`. The extension is active only after Pi's project-trust decision; rendered files alone are not evidence of runtime activation.

Alternative A—configure an upstream/example subagent extension—was viable but not chosen: Pi's subagent implementation is an example, not a built-in stable contract, and an external executable package would introduce a version/supply-chain dependency plus uncertain Navori role/tool semantics. Reuse Pi's native MCP, skill, and auth facilities instead of implementing them. The selected extension remains narrow and Navori-owned; its Pi API coupling is isolated to the `pi` engine and is covered by a supported-runtime smoke test.

## Components

- `packages/cli/src/lib/config/schema.ts` — accept `pi` as an opt-in engine; preserve defaults for all existing engines — **R1**.
- `packages/cli/src/commands/render.ts` — dispatch `pi` through the existing non-Claude engine path without changing other output — **R1**.
- `packages/cli/src/engines/pi/` — adapter, resource serializers, project extension asset, and runtime policy mapping. It consumes the shared resolved agent/skill/hook inventory and produces Pi-specific files — **R1–R8**.
- `packages/cli/package.json` — pin the supported Pi runtime for the credential-free extension/trust smoke test — **R9, R10**.
- `packages/cli/src/engines/shared/harness-plan.ts` — keep inventory/config resolution shared; do not fork planning for Pi — **R1–R3**.
- `packages/cli/src/engines/shared/execute-plan.ts` — use `collectPlan`/`commitWrites` for all accepted writes and removals; add only the minimal safe full-file/marker support needed by Pi if the current contract cannot represent it — **R6**.
- `packages/cli/src/engines/shared/engine-capabilities.ts` — declare every Pi control's state and reason; an enforced state must name runtime evidence — **R3, R8, R9**.
- `packages/cli/src/engines/pi/__tests__/` and existing engine/schema/render test suites — cover serialization, render ownership, extension behavior, child limits, and capability truthfulness — **R1–R4, R6–R9**.
- Pi-engine documentation/CLI help — explain project trust, native MCP behavior, OAuth login and manual smoke flow — **R5, R7, R10**.

## Decisions

1. **Keep authentication in Pi.** Navori documents `/login openai-codex`, selection of ChatGPT Plus/Pro when prompted, and selection of an available `openai-codex` model. It never reads, copies, refreshes, generates, or logs Pi credentials and never falls back to an API key. Authentication errors point users back to Pi's login flow. **R5, R10.**
2. **Reuse native Pi MCP without managing it.** Do not generate `.pi/mcp.json`, do not write user/project MCP settings, and do not force `builtin:mcp`. If the user disabled MCP or has not configured a server, preserve that choice and explain that Navori does not supply one. **R4.**
3. **Use Pi's native skill root.** Keep Navori-managed skills in `.agents/skills/`; do not duplicate them under `.pi/skills/` absent a demonstrated discovery gap. **R1, R6.**
4. **Represent runtime hook behavior in the project extension, not as copied Claude/Codex hook scripts.** Map only documented Pi events and distinguish the control states below. Test the event's effect, not only that a handler registered. **R3, R9.**
5. **Provide the subagent capability as a project-local extension.** The minimum supported core-role set is `scout`, `implementer`, and `reviewer`; every role needs an explicit tool mapping. A missing role definition or empty/unknown tool mapping is a diagnostic and must fail closed, never broaden access to Pi defaults. Agent definitions preserve role instructions, names, descriptions, and configured models where Pi supports them. Unsupported roles/tools are reported, not silently omitted or widened. The child tool allowlist limits tools exposed to that Pi child; it is not an OS/filesystem/network sandbox. **R2, R8.**
6. **Make ownership and syntax safe by format.** Runtime TypeScript is a standalone generated file with a valid `// navori:managed-file` marker whose digest covers the generated payload; Markdown agent files put a YAML-comment ownership marker inside valid frontmatter; `.pi/navori.json` is a Navori-owned runtime manifest serialized deterministically as strict JSON, with a reserved metadata object containing its ownership id and digest of the canonical payload. Validate the complete output generation—including syntax and ownership for every destination—before creating any pending write/removal. Validate marker/digest before replacement or pruning; a colliding or edited file is preserved and reported, not overwritten. Do not add managed-section comments to JSON or TypeScript. Every accepted pending write/removal still goes through `commitWrites`. This shared commit is not a multi-file transaction: on a partial commit failure, report every destination and retain available backups for diagnosis/recovery; never claim the generation loaded. **R6.**
7. **Treat trust as a runtime prerequisite, not a render option.** Navori never sets project trust for the parent or claims render means active. A child can receive Pi's process-scoped `--approve` only when this project extension has loaded in an already-trusted parent; never use explicit `-e` to bypass an untrusted parent's decision. This lets a non-interactive child see the same project resources without persisting or bootstrapping trust. **R7.**
8. **Set conservative explicit child limits.** Permit one child level (depth 0 parent → depth 1 child; no nested subagent tool in children), at most three concurrent children, and a ten-minute per-child timeout. Propagate parent abort; send `SIGTERM`, then `SIGKILL` after a five-second grace period; collect bounded results and settle/terminate all children before the parent tool reports completion. **R8.**
9. **Use explicit fail-closed child tools and trust handoff.** Always pass the complete supported role allowlist via `--tools`; when empty, pass `--no-tools` rather than allowing Pi defaults. Pass `--approve` only from the loaded project extension in a trusted parent, because JSON/print child modes cannot prompt and a saved trust decision is not guaranteed. **R2, R7, R8.**
10. **Pin the supported Pi runtime smoke.** Declare `@earendil-works/pi-coding-agent` 0.87.1 as a CLI dev dependency and Node 22.19.0 as the runtime floor. CI validates extension loading and a real `tool_call`/trust path without OAuth; live account authentication remains a manual smoke. **R9, R10.**

### Pi control mapping

Use the documented `tool_call` event to block a Pi tool call and `before_agent_start` only for context injection. These states are the initial contract; any control not meeting the stated evidence remains advisory or unsupported in the registry.

| Navori control | Pi mapping and initial declaration | Boundary/evidence |
|---|---|---|
| `plan-gate` | **Enforced** on Navori's `subagent` extension tool call only, in the parent runtime | Validate the requested role/task against the current plan before starting a child; deny invalid calls. Test denied/valid tool dispatch and separately document that shell/direct tool calls bypass this gate. The capability declaration/reason must name this exact boundary; no general Pi plan-gate claim. |
| `master-plan` | **Advisory** via `before_agent_start` context injection | Context is appended to the prompt; it is not a Pi startup-event or permission boundary. Test injection and child-safe behavior. |
| `markdown-ownership` | **Advisory** | `tool_call` can block direct Pi `edit`/`write` calls to owned Markdown paths, but cannot reliably prevent equivalent writes through `bash`; do not claim complete enforcement. |
| `handoff-shape` | **Unsupported** unless an implementation can observe/validate the final persisted handoff at a documented boundary | A child result alone does not prove that the canonical file exists and is valid. Reason must name this gap. |
| `handoff-consumer` | **Enforced** on Navori's `subagent` extension tool call for the supported `reviewer` role only | Run the existing `navori handoff check` before child creation and block invalid/missing input. Test reviewer versus scout/implementer; direct shell invocation is outside this gate and the declaration/reason must state the boundary. |
| `analytic-write-tools` | **Advisory** | Pi's tool allowlist limits exposed operations but Bash and extensions retain process permissions; never describe it as a sandbox. |
| `local-skill-discovery` | **Unsupported** for `project.localSkills` | Pi natively discovers trusted `.agents/skills/`, and Pi-only core skills render there. The Pi renderer does not project `project.localSkills` from `.claude/skills/`; the capability registry therefore correctly marks that control unsupported. When Codex is also selected, Codex owns the shared `.agents/skills/` destinations and Pi does not duplicate them. |

If the actual hook inventory or Pi API cannot support any mapping above as written, downgrade it to advisory/unsupported before claiming parity; never keep an “enforced” label on registration evidence alone. **R3, R9.**

## Contracts

### Resource and ownership contract

- Project-local runtime files live only below `.pi/`; Navori never writes to the user's global Pi agent directory. Skills stay in the shared `.agents/skills/` tree.
- The project extension is discovered conventionally at `.pi/extensions/` and owns its complete generated TypeScript file. `.pi/navori.json` carries only Navori runtime policy/agent metadata; it is not Pi settings or MCP configuration. Agent Markdown is complete generated content with valid YAML frontmatter and body.
- Each format has a dedicated serializer and ownership validator: TypeScript line-comment marker; YAML-frontmatter comment marker; JSON-native reserved metadata plus stable serialization. The JSON digest is checked against canonical payload excluding the metadata field. Do not use `injectManagedSection` with HTML/shell comment styles for `.ts`/`.json`. Validate every serialized resource and every existing ownership marker before adding any destination to the pending set. On a missing, invalid, conflicting, or digest-mismatched marker, skip the generation's conflicting write/delete and report a collision. Preserve files outside Navori-owned destinations.
- All successful generated writes, upgrades, and orphan removals are accumulated as pending changes and committed through `commitWrites`, preserving proportional backup and per-file atomic-write behavior. `commitWrites` does not make a multi-file generation transactional; on partial failure, report affected destinations, keep backups for recovery, and do not report overall success. Dry-run must report the same destinations without mutation.
- Do not create `.pi/settings.json` merely to list conventionally discovered resources. Do not create `.pi/mcp.json`, add a server, copy credentials, or force `builtin:mcp`. Pi owns MCP discovery and server connections.

### Subagent contract

- The extension registers the orchestration tool only in a parent process. Spawn children as Pi processes using JSON/print mode and no session persistence; pass the configured model when one exists, the role-specific supported Pi tool allowlist, the project working directory, and a private child marker/depth value. The child inherits the invoking user's process environment and Pi agent directory/authority as normal process state; Navori does not copy credentials into argv/config/output, inspect or log credential values, or claim to isolate ambient environment secrets. Role-specific MCP tools remain available only through Pi's native MCP when configured/enabled by the user; tool mapping must account for Pi's MCP discovery/search or codemode surface when present, and otherwise fail closed rather than expose broad defaults.
- Children may load project resources only after trust is handed off safely. The parent may pass process-scoped `--approve` only if this exact project extension is already loaded in an already-trusted parent; if it is not loaded/trusted, do not spawn a child with `-e` or `--approve`, and return an actionable trust prerequisite. Because trust may not have been persisted by an interactive prompt, this must work without assuming a saved trust decision. Children must not register the subagent tool or parent-only plan/handoff dispatch gates. Child-safe direct-tool protections remain active where supported. This prevents accidental recursion without turning off all controls in children.
- Bounds: depth 1 maximum; 3 concurrent children maximum; 10 minutes per child. On parent cancellation, abort active child processes, terminate, then kill after 5 seconds if still alive. Report each child's bounded success/failure; do not leave orphaned processes or claim completion while children remain active.
- A tool declaration/allowlist limits Pi model-visible tools only. It does not isolate the child process from the filesystem, network, environment, extension code, or shell capabilities. True OS isolation is not promised.

### Capability contract

`ENGINE_CAPABILITIES.pi` must declare every existing `ControlId`, unsupported surface and analytic role. `enforced` requires a test observing the actual denied/allowed/loaded behavior; `advisory` and `unsupported` require a reason. Runtime activation is conditional on Pi trusting the project. Registry declarations describe the feature's semantics when active, not whether an untrusted session loaded it.

## Failure modes

- **Malformed output or extension update:** validate the whole generation first; serializer/typecheck/parse failure prevents all new resources from entering the pending write set. Test generated TypeScript import/compile, JSON parse and Markdown frontmatter parsing before commit. If `commitWrites` later fails partway through, report exact partial state and retain backups; it cannot promise cross-file rollback.
- **Collision or user edit:** ownership/hash mismatch blocks overwrite/removal and reports the path; unrelated `.pi` files remain untouched. This is preferable to attempting a generic JSON merge or deleting an edited extension.
- **Project not trusted / extension not loaded in trusted parent:** files may render but Pi does not activate project resources. Do not auto-approve; a child spawn that depends on the project extension is rejected with a trust prerequisite. Verify trusted parent, interactive untrusted, and non-interactive child invocation paths.
- **MCP disabled/no server:** leave all configuration unchanged; report native Pi MCP must be enabled/configured by the user. Never manufacture empty config or credentials.
- **Child invalid model/tools, spawn error, timeout or abort:** return a bounded actionable child error, stop remaining/active child processes on parent cancellation, and make no success claim until all requested work has settled.
- **Pi extension API drift:** supported Pi runtime smoke fails before release; version/API incompatibility is surfaced as a diagnostic rather than silently treating handlers as active.
- **Missing/expired OAuth:** Pi remains the auth authority; show `/login openai-codex` guidance and do not inspect or log secrets.

## Migration

The engine is opt-in; existing engine configuration and rendered output do not change. Enabling it creates only Navori-owned Pi project resources and shared skills as needed. Disabling it removes only resources with valid Navori ownership metadata; conflicts or edits are preserved. No migration of Claude/Codex MCP servers, settings, secrets, hooks, or global Pi files occurs.

## Testing strategy

- **R1 — registration/non-regression:** schema accepts `pi` and render dispatch selects its adapter; snapshot a project using existing engines only and assert byte-identical outputs.
- **R2 — roles/models/tools:** fixtures for configured agents preserve description/model and map allowed tools; unknown tools produce a diagnostic and do not enlarge the allowlist.
- **R3 — event equivalence:** exercise actual `tool_call` denials and `before_agent_start` injection for supported mappings; verify unrelated events/tools pass through; assert registry status/reason against behavior and mark unsupported mappings honestly.
- **R4 — native MCP preservation:** seed user/project MCP files and `builtin:mcp` disablement; render and assert byte-for-byte unchanged, no `.pi/mcp.json` creation, no token/credential serialization, and explicit diagnostic when unavailable.
- **R5 — credential boundary:** unit tests use fake Pi auth absence/errors and assert Navori never reads/writes auth paths, never logs token-shaped values, and only produces login guidance.
- **R6 — syntax, ownership, backups:** parse generated JSON, TypeScript, YAML frontmatter and Markdown; verify deterministic output, valid marker/digest, preservation of unmanaged files, refusal on modified/colliding managed files, backup creation, dry-run parity, and only managed orphan removal.
- **R7 — trust:** verify docs/status distinguish rendered from active; a pinned Pi integration smoke checks untrusted parent (extension absent), trusted parent with unsaved trust state, and child invocation with process-scoped `--approve`. Confirm Navori does not use `-e` to bypass trust and that the non-interactive child cannot prompt.
- **R8 — child bounds/security:** verify child lacks the `subagent` tool at depth 1, exact role tool allowlist survives child startup (or `--no-tools` for empty), max concurrency is three, depth cannot exceed one, timeout and parent cancellation terminate processes including escalation after grace, and documentation states inherited environment/Pi agent authority and allowlists are not sandboxes.
- **R9 — acceptance matrix:** a stub Pi executable verifies constructed argv, cwd/model/role instructions, JSON protocol parsing and bounded result; unit/integration tests cover registration, deterministic render, ownership, hook mapping, child bounds, MCP preservation and unsupported diagnostics without live user credentials. The pinned runtime smoke verifies extension load, trust paths, and an actual tool/event behavior. Each test links to its `R<n>`.
- **R10 — manual OAuth smoke:** document and perform only as a user/manual release check: in Pi run `/login openai-codex`, choose ChatGPT Plus/Pro when prompted, select an available `openai-codex` model, and send a harmless prompt. Automated tests never capture or use the user's account.

## NOT in scope

- Implementing OAuth, importing tokens, API-key fallback, or changing Pi account state.
- Creating/converting MCP configuration or credentials; managing Pi's `builtin:mcp` setting.
- Claiming Claude/Codex hook parity, full OS sandboxing, or activation before project trust.
- Installing community extensions or writing global `~/.pi/agent` resources.
- Supporting recursive subagent trees, unbounded fan-out, or shell/filesystem isolation beyond Pi's available tool surface.

## Requirement coverage

| Requirement | Design coverage |
|---|---|
| R1 | Approach; Components; Decisions 2–3; R1 test |
| R2 | Decisions 5, 8; Subagent contract; R2 test |
| R3 | Decision 4; Pi control mapping; Capability contract; R3 test |
| R4 | Decision 2; Resource and ownership contract; MCP failure mode; R4 test |
| R5 | Decision 1; OAuth failure mode; R5 test |
| R6 | Decision 6; Resource and ownership contract; syntax/collision failures; R6 test |
| R7 | Decision 7; trust failure mode; R7 test |
| R8 | Decisions 5, 8; Subagent contract; child failure modes; R8 test |
| R9 | Components; Testing strategy acceptance matrix; R9 test |
| R10 | Decision 1; OAuth failure mode; R10 manual smoke |
