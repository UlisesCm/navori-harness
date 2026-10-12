# Pi Coding Agent

Pi is an opt-in Navori engine. It renders Navori-owned project resources for Pi and adds the
`navori_subagent` extension tool for the admitted roles. Pi remains the owner of project trust, MCP,
provider authentication, and its user-level agent resources.

This guide documents the verified state only. The machine-checked contract (versions, support matrix,
runtime admissions) is parsed by `packages/cli/src/engines/pi/__tests__/first-class-e2e.test.ts`.

## Requirements and setup

- Minimum supported Pi version: **1.1.0**
- Tested Pi version: **1.1.0**

The floor is `MIN_PI_VERSION` (`packages/cli/src/engines/pi/runtime-version.ts`). The tested version is
the pinned `@earendil-works/pi-coding-agent` devDependency of `packages/cli`. The floor also covers
acceptance evidence, which reads Pi's built-in bash `structuredContent.exit_code`, and the admitted child
runtime capabilities (see [Runtime admissions](#runtime-admissions)), which are verified only on 1.1.0.

A Pi is **unverified** when it is below the floor, is a prerelease (for example `1.2.0-rc.1`), or reports a
version that cannot be parsed. An unverified Pi loads the extension in write-block mode only: `bash`,
`edit`, `write` and `powershell` are blocked, `read`, `grep`, `find` and `ls` stay intact, the first blocked
call shows one notice per process, and `navori_subagent` is not registered. Stable releases above the floor
stay admitted; there is no declared upper bound yet, so a later incompatibility is handled by publishing one.

Node.js **22.19.0 or later** is the Pi runtime floor. This Navori repository currently requires Node.js
**24 or later**, so use the higher repository requirement when running its CLI. See the
[Pi quickstart](https://pi.dev/docs/latest/quickstart).

Enable Pi in the project configuration:

```json
{
  "engines": ["pi"]
}
```

Then render the project resources and review the proposed changes before applying them:

```sh
navori render
navori render --apply
```

Start Pi in the project and review/accept Pi's project-trust prompt. Rendering files does not make
untrusted project resources active. The extension checks Node.js and the imported Pi package's
`VERSION` when it loads; an unverified Pi gets the write-block mode described above. This is not a universal
host-side `pi --version` handshake; the runtime tests exercise the pinned Pi package.

## Support matrix

Each row is one Pi control from `ENGINE_CAPABILITIES.pi.controls`. `enforced` means the trusted Pi
project extension checks the boundary; `advisory` means the signal is context or a warning and never a
permission boundary; `unsupported` means Navori does not provide the control on Pi.

| Control | State | Boundary |
| --- | --- | --- |
| `plan-gate` | enforced | When `harness.planTiers` is on, the extension gates only `navori_subagent` implementer calls. Direct Pi shell and tool calls bypass it. |
| `master-plan` | advisory | When `harness.masterPlan` is on, a bounded status line is appended before each agent start. Context only, not a permission boundary. |
| `markdown-ownership` | advisory | When `harness.scribeOwnsMarkdown` is on, direct Pi `edit`/`write` of Markdown in implementer children is blocked. Bash and ambient process writes bypass it. |
| `handoff-shape` | enforced | When an `implementer` or `reviewer` `navori_subagent` child ends, the trusted extension validates its canonical handoff (fresh against the dispatch snapshot). A missing, stale or invalid handoff returns `isError`. Direct shell/tool calls and other roles bypass it. |
| `handoff-consumer` | enforced | Reviewer `navori_subagent` calls with an explicit feature are checked. Direct shell and tool calls bypass it. |
| `analytic-write-tools` | advisory | Role tool allowlists are model-visible capabilities, not OS, filesystem, or network sandboxes. Scout and reviewer retain `write`. |
| `local-skill-discovery` | enforced | `project.localSkills` are projected as pointers under `.agents/skills/<id>`, written only when Codex is not enabled. |
| `acceptance-evidence` | enforced | The extension records host-observed exits of Pi's built-in bash (parent, child, and nested calls, Pi 1.1.0+) as workplan evidence. `plan update` refuses `cumplido` without it when `PI_SESSION_ID` is set. Fails closed: a replaced bash tool or a missing `exit_code` records nothing. |
| `repeat-failure-advice` | advisory | After three identical built-in bash failures, one advisory is appended. It never blocks, never alters the result, and is silent when `exit_code` is absent. |
| `compact-advice` | unsupported | Pi runs no Navori hook scripts, so no context-size advice is injected after a publisher dispatch. |
| `general-purpose-confirm` | unsupported | Pi runs no Claude hook scripts and its `navori_subagent` roster has no general-purpose role to confirm. |

Pi also natively discovers trusted project skills in `.agents/skills/`. When Pi and Codex are both
selected, Codex owns the shared destinations and Pi does not duplicate them. Claude and Codex hook
scripts are not copied or run by Pi.

## Runtime admissions

Each row is one child runtime capability from `ENGINE_CAPABILITIES.pi.runtimeAdmissions`. `admitted`
capabilities are verified on Pi 1.1.0; `deferred` capabilities are not available.

| Capability | Decision | Boundary |
| --- | --- | --- |
| `child-mcp-off` | admitted | `--no-mcp` disables Pi built-in MCP in the child only. Not an OS sandbox; the parent keeps its MCP. |
| `child-model-selection` | admitted | `--model <provider/id>` selects the child's model. Effort and thinking are not redefined. |
| `child-tool-allowlist` | admitted | `--tools` is a model-visible allowlist, not isolation. Indirect MCP exposure is closed by `--no-mcp`. |
| `child-ipc-relay` | admitted | Node IPC (`stdio` `ipc`) from the child to the parent reports the exact refused command. It never approves anything; see [Approval relay](#approval-relay). |
| `child-mcp-grants` | deferred | Children run with `--no-mcp`. Pi 1.1.0 connects every enabled MCP server and lists all of them in the child prompt, so per-role MCP grants are not verifiable. Roles that need MCP stay unavailable in children. |
| `session-end-event` | admitted | `session_shutdown` runs on a clean quit or `/new` only, in the parent. A SIGKILL fires nothing, so the next close sweeps. Reload, resume and fork do not end the session. |
| `settle-boundary-entries` | admitted | `agent_before_settle` appends a visible entry at the end of the agent run. It never sets `continue`, so it cannot force another model request. |

## Session lifecycle

These run only in the parent session; children do nothing. All failures are silent and never fail the session.

- **Quit or `/new`** (`session_shutdown` with reason `quit` or `new`):
  1. `worktree-reclaim` runs with a 12 s deadline, only if `.claude/worktrees` exists. The Pi arm keeps any worktree that has unpublished work or ignored files under `.navori/state/`.
  2. `audit-mode-close` runs with a 3 s deadline and seals only an existing audit log.
- **Reload, resume and fork**: nothing runs.
- **Verification reminder** (`agent_before_settle`, only when `hooks.verifyOnStop` is set): if the tree has uncommitted changes, a fixed Spanish reminder to run the quality gate and commit is appended as a visible `custom_message`. It never triggers another model request.

## Hook bridge

The trusted extension runs the shared Navori hook scripts through a bridge. The contract:

- **Payload.** The bridge sends a Claude-shaped payload: `hook_event_name`, `tool_name` (`Bash`, `Edit` or
  `Write`), `tool_input`, `cwd`, `session_id`, `permission_mode`, and `agent_id`/`agent_type` in children.
  The script copy identifies itself as Pi by its path under `/.pi/navori/`, not by the payload.
- **Location.** Scripts are copied to `.pi/navori/hooks/<id>.sh`, and the set comes from `PI_HOOK_BINDINGS`.
  That table is empty in this milestone, so no script runs in a project yet; rows land with the guards that
  wire them.
- **Shell.** Scripts run under bash from Pi's shell configuration. The project's `shellPath` is never used.
  A missing bash, or only the `sh` fallback, blocks every `enforced` script and names the action to take.
- **Execution.** Non-interactive scripts run concurrently, each with its own timeout. The first block wins.
- **Verdict.** Only a stdout JSON object with `hookSpecificOutput`, `systemMessage` or `continue` is a verdict.
  Other stdout is noise and nothing beyond 64 KiB of it is kept. Stderr is kept as head and tail.

| Script outcome | `enforced` (tool_call) | `advisory` (tool_result) | `lifecycle` |
| --- | --- | --- | --- |
| exit 0, no verdict JSON | allow | nothing | nothing |
| exit 2 | block, reason = stderr | warning = stderr | nothing |
| JSON `permissionDecision` deny | block | nothing | nothing |
| JSON `permissionDecision` ask | ask | nothing | nothing |
| JSON `permissionDecision` allow, context or message | allow | warning = context | nothing |
| JSON unknown decision, `updatedInput`, or `continue` false | block | nothing | nothing |
| exit other than 0 or 2, signal, timeout, no spawn, no bash | block | nothing | nothing |

Failures of `advisory` and `lifecycle` scripts are silent. Fail-closed applies only to `enforced` scripts.

**Manifest v2.** `.pi/navori.json` has `schemaVersion: 2` with `hooks` (the bridge bindings), `ownedPaths`
(Navori-owned paths) and `permissionRules` (`ask` and `deny`). Anti-downgrade: a v1-only Navori reads v2 as
foreign and refuses to write Pi resources, and this CLI refuses to write over a newer schema. A v1 manifest
is still recognized, and a render upgrades it. When the manifest is unreadable, malformed or not v2, the
extension blocks `bash`, `edit` and `write` because it cannot evaluate them; reads stay available.

**Powershell (D-U3).** Pi's `powershell` tool would run commands outside the shared shell policy, so Navori
removes it from the active tools at `session_start` with `setActiveTools`, and blocks any `powershell` call at
`tool_call`. On Windows, use the `bash` tool; it requires Git for Windows (Git Bash).

## Plugins

An enabled plugin reaches Pi through `renderPiEngine` (`packages/cli/src/engines/pi/index.ts`) and
`plugin-projection.ts`. A plugin the overlap matrix marks native on Pi is skipped. What an enabled plugin
projects:

- **Skills on skills.** A plugin skill with `injectInto: .claude/skills/<id>/SKILL.md` becomes a managed
  sub-block of `.agents/skills/<id>/SKILL.md`. Pi writes it only when Codex is not in `engines`; with Codex
  active, Codex writes that skill and Pi never duplicates it.
- **Role prose.** A plugin skill with `injectInto: .claude/agents/<role>.md` is appended to
  `.pi/agents/<role>.md`, interpolated and conditioned for Pi. A plugin that declares an `mcpServer`
  contributes no role prose at all: Pi children run with `--no-mcp`.
- **Orchestrator and AGENTS.md blocks.** A skill injected into `.claude/agents/orchestrator.md` and the
  plugin `managed` blocks become sub-blocks of the shared `AGENTS.md`. Pi writes them only when no other
  enabled engine owns that file (`ownsAgentsMd`); otherwise that owner's output stands.
- **Scripts.** Plugin scripts are copied to `.pi/navori/scripts/<dest>` as Pi's own executable copies, even
  when Codex is active. A script is installed only when a bridge row runs it, or when its plugin's hook
  extension rides inside an installed Pi hook copy. Colliding destinations are skipped.
- **Hooks.** Plugin `PreToolUse`/`Bash` hooks use the grammar Codex translates. They become manifest v2
  rows in `.pi/navori.json` that point at `.pi/navori/scripts/<dest>`: `tool_call`, `bash`, scope `all`,
  `enforced`, non-interactive, with the manifest timeout. A hook that does not translate is reported as a
  warning and is not installed.
- **Hook extensions.** A plugin `hookExtensions` entry targeting a core Claude hook becomes a managed
  sub-block of Pi's copy, `.pi/navori/hooks/<hook>`, and is stripped again when the plugin is disabled.

Ownership, backup and prune use the shared render plan, the same as the other engines: the plugin outputs
are Navori-owned paths, the plan reports its backup path, and a script in `.pi/navori/scripts/` with no
remaining binding is pruned. Disabling a plugin strips its sub-blocks from `.agents/skills/<id>/SKILL.md`
and prunes its Pi outputs.

Per unit, the states in [Parity inventory](#parity-inventory) are:

| Plugin unit | Pi state | What it means on Pi |
| --- | --- | --- |
| Skill sub-block (`.agents/skills`, `AGENTS.md`) | `advisory` | Text the model reads; nothing enforces it. |
| Plugin script run by a hook | `enforced` | Seatbelt on `bash` tool calls only, not a sandbox. |
| Plugin hook | `enforced` | Same limits as the shared guard; enforced only while the extension is loaded. |
| `settingsFragment` | `n/a` | Only `allow` rules, which Pi does not translate (as Codex). |
| MCP server | `advisory` | Render warns when the server is missing or disabled in Pi's MCP config. |
| MCP plugin skill on a child role | `unsupported` | Children run `--no-mcp`, so the prose is not injected. |
| Skill on a role Pi does not render (for example `publisher`) | `unsupported` | Pending the role work in spec 0048 R14 and M11. |
| tgrep guard script and `tgrep-search-lane` hook extension | `unsupported` | They ride the Pi guard copy, which lands with spec 0048 M3. |

Render warns when a plugin's MCP server is missing or disabled in Pi's native MCP config. Navori never writes
Pi's MCP config.

## Doctor findings

When the engine is enabled, `navori doctor` reports these Pi findings. All are advisory: none changes doctor's
`ok`, and the extension already fails closed on each. An absent `pi` binary or an unreadable settings file is
nothing to check, not an error.

- **Unverified version**: the installed Pi is below the floor, a prerelease, or unparseable.
- **Powershell default**: the effective `defaultTools` (project `.pi/settings.json`, else user settings)
  selects `powershell`.
- **Foreign extensions**: project extension entries other than Navori's own, from `.pi/extensions/` and the
  project `extensions` setting.

## Navori subagents

Once the trusted project extension is loaded, Pi exposes the `navori_subagent` tool. Admitted roles and
their Pi tool lists (from `packages/cli/src/engines/pi/role-tools.ts`):

- `scout`: `read, grep, find, ls, write`
- `implementer`: `read, grep, find, ls, bash, edit, write`
- `reviewer`: `read, grep, find, ls, bash, write`
- `scribe`: `read, grep, find, ls, bash, edit, write`; admitted only when `harness.scribeOwnsMarkdown` is on, and then the implementer requires the `scribe` role to be enabled
- `auditor`: `read, grep, find, ls, bash, write`
- `architect`: `read, grep, find, ls, bash, write`; cannot dispatch nested subagents on Pi (`navori:if-not onPi`)
- `publisher`: `read, grep, find, ls, bash`; rendered for Pi but refused at dispatch until the M6 publishing gates (R4–R6) land, so publish from the parent session

The tool requires `role` and a non-empty `task`; `feature` is optional except for `reviewer`, which
requires an explicit Navori feature slug for its handoff check; `implementer`, `reviewer` and `scribe` all require `feature`. Role instructions and descriptions are
preserved. A configured model is used when it maps to a concrete `codexMap` model; otherwise the child
inherits the selected Pi model. Each role has an explicit Pi tool list; missing or unknown mappings fail
closed rather than enabling default tools. Children never receive MCP grants (see `child-mcp-grants`).

### Approval relay

A headless child cannot approve an operation. When a child's Bash command claims human approval
(`--approved-by`) and is refused, the child sends the exact refused command to the parent over the Node
IPC channel. The parent validates each message: it must match the expected schema, be at most 8 KiB, and
the parent accepts at most 5 per child. Accepted requests are reported in `details.parentApprovals` of the
`navori_subagent` result, with a line in its content. The relay only reports; the refusal still stands.

Without IPC, the parent recovers the command from the `tool_execution_start` args of the same
`toolCallId`, and the call ends as an error, never as success. The model's Bash does not inherit the
channel.

### Child-end handoff validation

At dispatch the extension snapshots the child's canonical handoff: `impl_<feature>.json` for `implementer`, `review_<feature>.json` for `reviewer`. When the child ends, a handoff that is missing, or unchanged since the snapshot (same content and mtime), fails as stale.

- `implementer` runs `navori handoff check <feature> --for orchestrator`. A `head` warning also fails.
- `reviewer` runs `navori handoff check <feature> --produced-by reviewer --since <dispatch time>`. The sidecar and verdict must be valid, and the sealed evidence must check with the review begun at or after dispatch.

Any failure, including an unreadable check, returns `isError` with the reason and the child output (fail-closed). `scribe` is not validated at child end; only its `feature` requirement applies.

## Limits and headless runs

- Children are limited to one level, three concurrent processes, and ten minutes each.
- Child output is truncated to 64 KiB; the truncation is reported, not treated as cancellation.
- Cancellation sends `SIGTERM` and escalates to `SIGKILL` after five seconds. Descendants that outlive
  the leader are also escalated.
- The child does not register another `navori_subagent` tool.
- Headless children cannot approve operations. The extension refuses approval requests from a child and
  returns the command to the parent session so the user can approve it there. Trust is not approval: a
  child receives process-scoped `--approve` only after the trusted parent has loaded the extension.
- These limits, tool lists, and `--no-mcp` do not create an OS sandbox. Child processes inherit the
  user's environment, filesystem and network authority, and Pi agent directory.

## Parity inventory

`PI_PARITY` (`packages/cli/src/engines/shared/pi-parity.ts`) lists every unit Navori emits for other
engines (core hooks, shared permission rules, plugin manifest pieces) and what Pi gives for it today.
Each row has one state:

- `enforced`: blocks or requires something Pi cannot skip by itself. A textual-policy row that blocks
  is a seatbelt, not a sandbox (Pi has no permission system), and must list its bypass classes.
- `advisory`: informs without blocking, or covers only part of the shape.
- `unsupported`: a gap, with its reason.
- `n/a`: the unit does not apply to Pi, with the reason.

A unit without a row fails the inventory test (`pi-parity.test.ts`), which names it. A row stays
`unsupported` until the change that implements it flips it together with its code and tests.

- `routing-watch` is `unsupported`: the signal exists in Pi's `tool_result`, but the script keys on
  Claude tool names. A probe (not a live Pi run) shows the Pi name `edit` emits nothing. It can become
  `advisory` only once the M2 bridge maps Pi tool names.
- `model-advisor` is `unsupported`: Pi has no per-turn model-change payload to advise on.

## Cycle commands

The verified cycle, in order:

1. `navori render` then `navori render --apply` to install the Pi resources.
2. Start Pi in the trusted project. Navori context (AGENTS.md and the operational snapshot) loads at startup.
3. `navori plan update <feature> --decision approved --date <YYYY-MM-DD>` approves the workplan and refreshes
   the acceptance index the extension reads.
4. Dispatch roles with `navori_subagent` (`role`, `task`, and `feature` where required).
5. Acceptance commands run through Pi's built-in bash. When `PI_SESSION_ID` is set, the host records each
   observed exit as evidence.
6. `navori plan update <feature> --progress <ID>=cumplido --json` closes a criterion only with recorded
   evidence. Without it the command exits non-zero and names the criterion.
7. Disable with `navori render --apply --prune` after changing `engines`. Only Navori-owned resources are
   pruned; foreign files and work product survive.

## Credential-free e2e result

Executed by automation with `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-e2e.test.ts`
on the pinned Pi 1.1.0 runtime. The test runs the compiled CLI (render, approved plan, `plan update`), the
real Pi SDK agent loop and tool pipeline in process, real `pi` child processes spawned by the rendered
extension, Pi's built-in bash and write tools, git, and the filesystem. It covers install, approval
without UI, denial, a >256 KiB child stream, implementer/scribe/reviewer dispatch on the parent's model,
evidence recording, the receipt, upgrade, and disable.

Limits, stated rather than hidden:

- No live model. The faux provider proves the pipeline, never model compliance.
- No TUI or RPC process. The parent runs in process, approval is driven through Pi's real extension runner
  with a stub `ui.confirm`, so dialog rendering is not exercised.
- "Receipt" is the shared `plan update ... cumplido` closure over the host-recorded evidence.
- No live OAuth. No real credentials are read, stored, or used.

## Not executed by automation

- **Always-on context comparison (RED/GREEN, live model)**: not executed. Design requires it
  (see [design.md](../specs/0047-pi-first/design.md)); it is pending.
- **Live-model smoke**: partial, see [evals.md](../specs/0047-pi-first/evals.md). The manual smoke has
  confirmed startup context loaded from `AGENTS.md` and an implementer dispatch via `navori_subagent`. It
  has not yet covered anything beyond that.
- **Closure in a live Pi session**: not executed.

## Native MCP and project trust

Pi provides native MCP support, including user-level servers in `~/.pi/agent/mcp.json` and
project-level servers in `.pi/mcp.json`. Project resources are trust-gated by Pi. Review the
project before granting trust; see Pi's [MCP configuration](https://pi.dev/docs/latest/mcp),
[settings](https://pi.dev/docs/latest/settings), and [security and trust](https://pi.dev/docs/latest/security)
guides.

Navori preserves both user- and project-owned MCP configuration. It does not create or migrate
either file, add an MCP server, change Pi's `builtin:mcp` setting, or install a separate MCP
extension. Configure servers through Pi's native mechanism and keep credentials out of project
configuration.

Trust is an explicit Pi decision. Navori does not auto-approve the parent project or use `-e` to bypass
trust.

### MCP diagnosis for plugins

A plugin that declares an MCP server is checked against Pi's native MCP config. The check is read-only
and advisory: it reads `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json` and `.pi/mcp.json`, and records only
server names, `enabled`, and whether an entry defines a transport (`command`, `url`, or `type`). It never
copies values such as env or tokens, and it never writes either file. Server names match with `-` and `_`
treated as equivalent. A project entry that defines a transport replaces the global entry of the same name;
an entry that only sets `enabled` toggles the global one.

At render time, a server that is not configured or is disabled produces a warning with the action
`pi mcp add <id> -- <command> <args...>`. A server enabled only in `.pi/mcp.json` also produces a warning,
which says it takes effect only if the project is trusted. If the file is not valid JSON, the warning is a fixed message
that names the path and never the parser's text.

At session start, the parent Pi extension repeats the check. If a server is enabled only in
`.pi/mcp.json` and the project is not trusted (`ctx.isProjectTrusted()`), it shows one notice for that
session start that the server is not effective until the project is trusted (`/trust`). The check is
silent on failure and does not run in child sessions.

The diagnosis reports a server as configured, not connected. It cannot detect `--no-mcp` or an MCP
extension that replaces Pi's MCP support.

## ChatGPT Plus/Pro OAuth

Pi owns the ChatGPT subscription OAuth flow and credentials. Start Pi interactively in the trusted
project, run `/login openai-codex` (or `/login` and choose the OpenAI ChatGPT Plus/Pro subscription
option), then use `/model` to select an available `openai-codex` model and send a harmless prompt.
See Pi's [provider authentication guide](https://pi.dev/docs/latest/providers) and
[model guide](https://pi.dev/docs/latest/models).

Navori does not read, copy, generate, refresh, or log Pi's `auth.json` and does not silently fall
back to an OpenAI API key. If authentication fails, use Pi's `/login` flow; do not provide
credentials to Navori. Automated runtime tests are credential-free; account authentication is a
manual user smoke test.

## Manual smoke

1. Check `pi --version` and confirm it meets the supported baseline above.
2. Start Pi interactively in a project whose resources you trust.
3. Run `/login` and select the `openai-codex` ChatGPT Plus/Pro subscription login.
4. Run `/model`, select an available `openai-codex` model, and send a harmless prompt.
5. If login fails, troubleshoot through Pi's `/login`; Navori does not inspect credential files.

Current status: **manual smoke partial**. See [evals.md](../specs/0047-pi-first/evals.md).

See the [Pi engine specification](../specs/0040-pi-engine/requirements.md) and the
[Pi first specification](../specs/0047-pi-first/requirements.md) for requirements and
implementation/review status.
