# Pi Coding Agent

Pi is an opt-in Navori engine. It renders Navori-owned project resources for Pi and adds the
`navori_subagent` extension tool for the supported core roles. Pi remains the owner of project
trust, MCP, provider authentication, and its user-level agent resources.

## Requirements and setup

The supported baseline is `@earendil-works/pi-coding-agent` **0.87.1 or later** and Node.js
**22.19.0 or later**. This Navori repository currently requires Node.js **24 or later**, so use
the higher repository requirement when running its CLI. See the [Pi quickstart](https://pi.dev/docs/latest/quickstart).

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
`VERSION` when it loads and reports an actionable minimum-version error. This is not a universal
host-side `pi --version` handshake; the runtime smoke tests exercise the pinned Pi package.

## Navori subagents

Once the trusted project extension is loaded, Pi exposes the `navori_subagent` tool for `scout`,
`implementer`, and `reviewer`. The tool requires `role` and a non-empty `task`; `feature` is
optional except for `reviewer`, which requires an explicit Navori feature slug for its handoff
check. Role instructions and descriptions are preserved. A configured model is used when it maps
to a concrete `codexMap` model; otherwise the child inherits the selected Pi model. Each role has
an explicit Pi tool list; missing or unknown mappings fail closed rather than enabling default
tools.

Children are limited to one level, three concurrent processes, and ten minutes each. Cancellation
sends `SIGTERM` and escalates to `SIGKILL` after five seconds. The child does not register another
`navori_subagent` tool. These limits and tool lists do not create an OS sandbox: child processes
inherit the user's environment, filesystem/network authority, and Pi agent directory.

The extension's enforcement is scoped, not full feature parity:

| Navori control | Pi behavior and boundary |
|---|---|
| `plan-gate` | Enforced only on `navori_subagent` implementer dispatch when plan tiers are enabled. Direct Pi tools and shell bypass it. |
| `handoff-consumer` | Enforced only on reviewer `navori_subagent` dispatch with an explicit feature. Direct shell/tool calls bypass it. |
| `acceptance-evidence` | Unsupported: Pi has no verified child Bash-result recorder, so Navori cannot require host-execution evidence when a plan criterion is marked complete. |
| `master-plan` | Advisory status-line context via `before_agent_start`; not a permission boundary. |
| `markdown-ownership` | Advisory: blocks direct Pi `edit`/`write` of Markdown in implementer children when enabled; Bash can bypass it. |
| `handoff-shape` | Unsupported: child output does not validate the persisted canonical handoff. |
| `analytic-write-tools` | Advisory: model-visible tool allowlists are not OS/filesystem/network sandboxes. |
| `local-skill-discovery` | Unsupported for `project.localSkills`; those ids are not projected from `.claude/skills/`. |

Pi natively discovers trusted project skills in `.agents/skills/`; Navori-rendered core skills use
that shared root. When Pi and Codex are both selected, Codex owns the shared destinations and Pi
does not duplicate them. The unsupported capability above specifically concerns migration of
`project.localSkills`, not Pi's native discovery of the shared root. Claude/Codex hook scripts are
not copied or run unchanged by Pi. Additional Navori roles such as `architect`, `auditor`,
`scribe`, and `publisher` are not currently supported by this extension.

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

Trust is an explicit Pi decision. A child can receive process-scoped `--approve` only after the
Navori project extension has loaded in an already-trusted parent. Navori does not auto-approve the
parent project or use `-e` to bypass trust.

## Manual OAuth smoke

1. Check `pi --version` and confirm it meets the supported baseline above.
2. Start Pi interactively in a project whose resources you trust.
3. Run `/login` and select the `openai-codex` ChatGPT Plus/Pro subscription login.
4. Run `/model`, select an available `openai-codex` model, and send a harmless prompt.
5. If login fails, troubleshoot through Pi's `/login`; Navori does not inspect credential files.

See the [Pi engine specification](../specs/0040-pi-engine/requirements.md) for requirements and
implementation/review status.
