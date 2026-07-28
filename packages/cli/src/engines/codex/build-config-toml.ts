import type { NavoriConfig } from "../../lib/config.ts";
import type { LoadedPlugin } from "../../lib/plugins.ts";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexConfigToml(
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[],
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

  lines.push(
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Bash$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${tomlString(
      'bash "$(git rev-parse --show-toplevel)/.codex/hooks/guard-destructive.sh"',
    )}`,
    "timeout = 30",
    'statusMessage = "Checking destructive command policy"',
  );

  if (config.qualityGate?.fast) {
    lines.push(
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^Bash$"',
      "",
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      `command = ${tomlString(
        'bash "$(git rev-parse --show-toplevel)/.codex/hooks/quality-gate-pre-commit.sh"',
      )}`,
      "timeout = 600",
      'statusMessage = "Running pre-commit quality gate"',
    );
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
