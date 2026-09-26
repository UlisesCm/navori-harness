import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { resolveCodexHooks } from "./hook-registrations.ts";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexConfigToml(
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[],
  wsSubpath = "",
): { body: string; warnings: string[] } {
  // Codex currently defaults both features on, but a full navori adapter must
  // stay deterministic when a user's global config disables either one.
  const lines: string[] = [
    'sandbox_mode = "workspace-write"',
    'approval_policy = "on-request"',
    "",
    "[features]",
    "hooks = true",
    "multi_agent = true",
  ];

  // The hooks are written relative to `cwd` (each workspace gets its own
  // `.codex/hooks/`), but `git rev-parse --show-toplevel` always resolves to the
  // repo root. In a monorepo workspace that mismatch pointed the command at the
  // ROOT's hook, not the workspace's co-located one — running the wrong quality
  // gate (or none). Interpolate the workspace subpath so the command targets the
  // hook next to this config.toml. `wsSubpath` is "" at the root (unchanged) and
  // e.g. "apps/backend" in a workspace. It's normalized to POSIX separators since
  // this is a bash command. Correct under nested config discovery, inert under
  // root-only discovery (the nested config.toml just isn't loaded) — #279.
  const hookBase = `$(git rev-parse --show-toplevel)${wsSubpath ? `/${wsSubpath}` : ""}/.codex/hooks`;

  // Spec 0035 D1/T1: `resolveCodexHooks` is the single source of what gets
  // registered and in what order — see hook-registrations.ts's module doc for
  // WHY the order (and therefore each block's `trusted_hash` index) must stay
  // stable across re-renders. Each row becomes exactly one
  // `[[hooks.<Event>]]` block with exactly one nested `.hooks[]` entry — the
  // shape Codex's own `hooks/list` and `trusted_hash` keying assume.
  for (const hook of resolveCodexHooks(config)) {
    const command = `bash "${hookBase}/${hook.script}.sh"${hook.args ? ` ${hook.args}` : ""}`;
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
    "Permisos Codex son aproximados: sandbox_mode/approval_policy no tienen " +
      "paridad 1:1 con allow/ask/deny de Claude. guard-destructive conserva la defensa crítica.",
  ];
  for (const plugin of plugins) {
    const server = plugin.manifest.mcpServer;
    if (!server) {
      warnings.push(
        `Plugin '${plugin.manifest.id}' no declara mcpServer; se omitió de .codex/config.toml.`,
      );
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
