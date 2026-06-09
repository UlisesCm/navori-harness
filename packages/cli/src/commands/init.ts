import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { writeConfig } from "../lib/config.ts";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize navori-ai in the current repo",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Skip prompts and use defaults",
    },
    cwd: {
      type: "string",
      description: "Directory to initialize (default: current working directory)",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    p.intro("navori-ai init");

    if (existsSync(configPath)) {
      p.cancel(`navori.config.json already exists at ${configPath}.`);
      process.exit(1);
    }

    const defaultName = basename(cwd);

    if (args.yes) {
      writeConfig(configPath, {
        name: defaultName,
        engines: ["claude"],
        preset: "custom",
        branchBase: "main",
      });
      p.outro(`Wrote ${configPath}`);
      return;
    }

    const name = await p.text({
      message: "Project name",
      placeholder: defaultName,
      defaultValue: defaultName,
    });
    if (p.isCancel(name)) return cancel();

    const workspace = await p.text({
      message: "Workspace (optional)",
      placeholder: "leave empty for none",
    });
    if (p.isCancel(workspace)) return cancel();

    const engines = await p.multiselect<string>({
      message: "Engines to target",
      options: [
        { value: "claude", label: "Claude Code (.claude/)" },
        { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
        { value: "cursor", label: "Cursor (.cursor/rules/)" },
        { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
      ],
      required: true,
      initialValues: ["claude"],
    });
    if (p.isCancel(engines)) return cancel();

    const preset = await p.text({
      message: "Stack preset",
      placeholder: "custom",
      defaultValue: "custom",
    });
    if (p.isCancel(preset)) return cancel();

    const branchBase = await p.text({
      message: "Base branch",
      placeholder: "main",
      defaultValue: "main",
    });
    if (p.isCancel(branchBase)) return cancel();

    const confirm = await p.confirm({
      message: `Write ${configPath}?`,
      initialValue: true,
    });
    if (p.isCancel(confirm) || !confirm) return cancel();

    const workspaceValue = (workspace as string).trim();

    writeConfig(configPath, {
      name: name as string,
      ...(workspaceValue ? { workspace: workspaceValue } : {}),
      engines: engines as string[],
      preset: preset as string,
      branchBase: branchBase as string,
    });

    p.outro(`Wrote ${configPath}`);
  },
});

function cancel(): void {
  p.cancel("Cancelled");
  process.exit(0);
}
