import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import {
  codexHookCommand,
  resolveCodexHooks,
  resolvePluginCodexHooks,
} from "./hook-registrations.ts";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Codex's own default (`core/src/agents_md.rs`); the threshold D8's bump
 *  compares against. */
const DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;
/** Slack for nested `AGENTS.md` files Codex chains onto the project one (D8). */
const PROJECT_DOC_MAX_BYTES_SLACK = 8192;

/** The next power of two that is `>= n` — D8's growth rule for
 *  `project_doc_max_bytes`, so the cap moves in coarse, predictable steps
 *  instead of tracking the exact byte count on every render. */
function nextPowerOfTwoAtLeast(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export function buildCodexConfigToml(
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[],
  wsSubpath = "",
  /** Byte size of the AGENTS.md this SAME render plans to write (D8) — not the
   *  one on disk, since `AGENTS.md` and `config.toml` are written together. */
  agentsMdBytes = 0,
): { body: string; warnings: string[] } {
  // Codex currently defaults both features on, but a full navori adapter must
  // stay deterministic when a user's global config disables either one.
  const lines: string[] = [
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "on-request"',
    'approvals_reviewer = "user"',
  ];
  // R12/D8: only written above Codex's own default — a render that stays under
  // it must not pin a value that would silently diverge from a future Codex
  // default.
  if (agentsMdBytes > DEFAULT_PROJECT_DOC_MAX_BYTES) {
    lines.push(
      `project_doc_max_bytes = ${nextPowerOfTwoAtLeast(agentsMdBytes + PROJECT_DOC_MAX_BYTES_SLACK)}`,
    );
  }
  lines.push("", "[features]", "hooks = true", "multi_agent = true");

  // The hooks are written relative to `cwd` (each workspace gets its own
  // `.codex/hooks/`), so `codexHookCommand` interpolates the workspace subpath
  // to target the hook next to this config.toml — #279. Correct under nested
  // config discovery, inert under root-only discovery.

  // Spec 0035 D1/T1: `resolveCodexHooks` is the single source of what gets
  // registered and in what order — see hook-registrations.ts's module doc for
  // WHY the order (and therefore each block's `trusted_hash` index) must stay
  // stable across re-renders. Each row becomes exactly one
  // `[[hooks.<Event>]]` block with exactly one nested `.hooks[]` entry — the
  // shape Codex's own `hooks/list` and `trusted_hash` keying assume.
  for (const hook of resolveCodexHooks(config, plugins)) {
    const command = codexHookCommand(hook, wsSubpath);
    lines.push("", `[[hooks.${hook.event}]]`);
    if (hook.matcher !== undefined) lines.push(`matcher = ${tomlString(hook.matcher)}`);
    lines.push(
      "",
      `[[hooks.${hook.event}.hooks]]`,
      'type = "command"',
      `command = ${tomlString(command)}`,
      `timeout = ${hook.timeout}`,
    );
    if (hook.statusMessage !== undefined) {
      lines.push(`statusMessage = ${tomlString(hook.statusMessage)}`);
    }
  }

  const warnings = [
    ...resolvePluginCodexHooks(plugins).warnings,
    // Spec 0035 D5/T6 (R9): terminal (Bash) permissions now translate into
    // `.codex/rules/navori.rules` (see build-rules.ts); only NON-terminal
    // permissions (path read/write) have no equivalent. Full access removes
    // filesystem/network isolation; rules and hooks cover only their matchers.
    "Codex usa danger-full-access por defecto: sin aislamiento de archivos ni red. " +
      "on-request/user no exige aprobación para toda acción; verifica la política efectiva " +
      "de la sesión (confianza del proyecto y overrides de CLI/host).",
    "Permisos por ruta de Claude no tienen equivalente 1:1 en Codex: reglas ask/deny y hooks " +
      "solo cubren sus matchers; guard-destructive intercepta únicamente Bash, no apply_patch " +
      "ni escrituras por MCP/app.",
  ];
  for (const plugin of plugins) {
    const server = plugin.manifest.mcpServer;
    if (!server) {
      // CLI-only plugins are available through their externalTool binary;
      // config.toml is only for MCP servers, not a plugin inventory.
      if (!plugin.manifest.externalTool) {
        warnings.push(
          `Plugin '${plugin.manifest.id}' no declara mcpServer ni externalTool; se omitió de .codex/config.toml.`,
        );
      }
      continue;
    }
    lines.push(
      "",
      `[mcp_servers.${tomlString(plugin.manifest.id)}]`,
      `command = ${tomlString(server.command)}`,
      `args = [${server.args.map(tomlString).join(", ")}]`,
    );
    if (server.env && Object.keys(server.env).length > 0) {
      const env = Object.entries(server.env)
        .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
        .join(", ");
      lines.push(`env = { ${env} }`);
    }
  }

  return { body: lines.join("\n").trim() + "\n", warnings };
}
