import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Inspect navori.config.json and report resolved state",
  },
  args: {
    cwd: {
      type: "string",
      description: "Directory to inspect (default: current working directory)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON (pipeable)",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    const claudeMdPath = `${cwd}/CLAUDE.md`;

    if (!args.json) p.intro("navori-ai doctor");

    if (!existsSync(configPath)) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: "config-missing", configPath }));
      } else {
        p.cancel(`No navori.config.json at ${configPath}. Run 'navori-ai init' first.`);
      }
      process.exit(1);
    }

    let config: NavoriConfig;
    try {
      config = readConfig(configPath);
    } catch (err) {
      if (err instanceof ConfigError) {
        if (args.json) {
          console.log(JSON.stringify({ ok: false, error: "config-invalid", message: err.message, issues: err.issues }));
        } else {
          p.cancel(err.message);
          if (err.issues) {
            for (const issue of err.issues) {
              console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
            }
          }
        }
        process.exit(1);
      }
      throw err;
    }

    const report = {
      ok: true,
      configPath,
      config,
      checks: {
        claudeMdExists: existsSync(claudeMdPath),
        agentsMdExists: existsSync(`${cwd}/AGENTS.md`),
        claudeDirExists: existsSync(`${cwd}/.claude`),
        progressDirExists: existsSync(`${cwd}/${config.progress?.dir ?? "progress"}`),
      },
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    p.log.message(`Config: ${configPath}`);
    p.log.message(`  name      : ${config.name}`);
    p.log.message(`  version   : ${config.version}`);
    p.log.message(`  workspace : ${config.workspace ?? "(none)"}`);
    p.log.message(`  engines   : ${config.engines.join(", ")}`);
    p.log.message(`  preset    : ${config.preset}`);
    p.log.message(`  branchBase: ${config.branchBase}`);
    p.log.message(`  commits   : ${config.commits}`);

    p.log.message("Filesystem checks:");
    p.log.message(`  ${mark(report.checks.claudeMdExists)} CLAUDE.md`);
    p.log.message(`  ${mark(report.checks.agentsMdExists)} AGENTS.md`);
    p.log.message(`  ${mark(report.checks.claudeDirExists)} .claude/`);
    p.log.message(`  ${mark(report.checks.progressDirExists)} ${config.progress?.dir ?? "progress"}/`);

    p.outro("OK");
  },
});

function mark(ok: boolean): string {
  return ok ? "✓" : "○";
}
