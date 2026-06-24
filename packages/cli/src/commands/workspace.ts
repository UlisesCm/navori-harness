import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import {
  listWorkspaces,
  loadWorkspace,
  writeWorkspace,
  workspacePath,
  workspaceDirectory,
  WorkspaceError,
  type WorkspaceConfig,
} from "../lib/workspace.ts";
import { applyDefault, VALID_DEFAULT_KEYS } from "../lib/workspace-defaults.ts";
import { runRender } from "./render.ts";
import { brand, dim, kv, color, sym, accent } from "../lib/style.ts";

const initSubCommand = defineCommand({
  meta: {
    name: "init",
    description: "Create a new workspace at ~/.navori/workspaces/<name>.json",
  },
  args: {
    name: { type: "positional", description: "Workspace name (kebab-case)", required: true },
    description: { type: "string", description: "Workspace description" },
    yes: { type: "boolean", description: "Accept defaults without prompting" },
  },
  async run({ args }) {
    const name = args.name as string;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      console.error(`Workspace name must be kebab-case: ${name}`);
      process.exit(1);
    }

    const path = workspacePath(name);
    if (existsSync(path)) {
      console.error(`Workspace '${name}' already exists at ${path}`);
      process.exit(1);
    }

    p.intro(brand(`workspace init ${accent(name)}`));

    let description = args.description ?? "";
    if (!args.yes && !description) {
      const value = await p.text({
        message: "Workspace description (optional)",
        placeholder: "e.g. Bonum coaching platform — multi-repo",
      });
      if (p.isCancel(value)) {
        p.cancel("Cancelled");
        process.exit(0);
      }
      description = (value as string).trim();
    }

    const workspace: WorkspaceConfig = {
      name,
      ...(description ? { description } : {}),
      ticketsDir: "tickets",
      defaults: {},
      repos: [],
    };

    const written = writeWorkspace(workspace);
    p.log.success(`Wrote ${written}`);
    p.log.message(`Tickets directory: ${workspaceDirectory(name)}/tickets/`);
    p.outro(`Run 'navori workspace show ${name}' to inspect, or add it to a repo with 'navori init --workspace ${name}'.`);
  },
});

const lsSubCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List all known workspaces",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
  },
  run({ args }) {
    const names = listWorkspaces();
    if (args.json) {
      console.log(JSON.stringify(names, null, 2));
      return;
    }
    p.intro(brand("workspace ls"));
    if (names.length === 0) {
      p.log.info("No workspaces found. Create one with 'navori workspace init <name>'.");
      p.outro(dim("Done"));
      return;
    }
    const lines: string[] = [];
    for (const name of names) {
      try {
        const ws = loadWorkspace(name);
        if (!ws) continue;
        const desc = ws.description ? dim(` — ${ws.description}`) : "";
        const count = ws.repos.length;
        const repoLabel = `${count} repo${count === 1 ? "" : "s"}`;
        lines.push(`  ${color.cyan(sym.bullet)} ${accent(name)}${desc}  ${dim(`(${repoLabel})`)}`);
      } catch {
        lines.push(`  ${color.red(sym.fail)} ${name}  ${dim("(invalid manifest)")}`);
      }
    }
    p.log.message(lines.join("\n"));
    p.outro(dim(`${names.length} workspace${names.length === 1 ? "" : "s"}`));
  },
});

const showSubCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show details of a workspace",
  },
  args: {
    name: { type: "positional", description: "Workspace name", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run({ args }) {
    const name = args.name as string;
    let workspace: WorkspaceConfig | null;
    try {
      workspace = loadWorkspace(name);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        console.error(err.message);
        for (const issue of err.issues ?? []) {
          console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
        process.exit(1);
      }
      throw err;
    }
    if (!workspace) {
      process.stderr.write(
        `Workspace '${name}' not found at ${workspacePath(name)}.\n` +
          `Create it with: navori workspace init ${name}\n` +
          `Or list known workspaces: navori workspace ls\n`,
      );
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(workspace, null, 2));
      return;
    }
    p.intro(brand(`workspace show ${accent(workspace.name)}`));

    const rows: Array<[string, string]> = [];
    if (workspace.description) rows.push(["description", workspace.description]);
    rows.push(["path", workspacePath(name)]);
    rows.push(["directory", workspaceDirectory(name)]);
    rows.push(["ticketsDir", workspace.ticketsDir]);
    rows.push(["defaults", JSON.stringify(workspace.defaults)]);
    rows.push(["repos", String(workspace.repos.length)]);
    p.log.message(kv(rows));

    if (workspace.repos.length > 0) {
      const repoLines = workspace.repos.map((repo) => {
        const stack = repo.stack ? dim(` [${repo.stack}]`) : "";
        const desc = repo.description ? dim(` — ${repo.description}`) : "";
        return `    ${color.cyan(sym.bullet)} ${accent(repo.name)}${stack}  ${dim(repo.path)}${desc}`;
      });
      p.log.message(`Repos:\n${repoLines.join("\n")}`);
    }
    p.outro(dim("Done"));
  },
});

const renameSubCommand = defineCommand({
  meta: {
    name: "rename",
    description: "Rename a workspace (preserves tickets, repos, defaults)",
  },
  args: {
    from: { type: "positional", description: "Current workspace name", required: true },
    to: { type: "positional", description: "New workspace name (kebab-case)", required: true },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const from = args.from as string;
    const to = args.to as string;

    if (!/^[a-z0-9][a-z0-9-]*$/.test(to)) {
      console.error(`Workspace name must be kebab-case: ${to}`);
      process.exit(1);
    }
    if (from === to) {
      console.error("Source and destination names are the same");
      process.exit(1);
    }

    const ws = loadWorkspace(from);
    if (!ws) {
      console.error(`Workspace '${from}' not found`);
      process.exit(1);
    }
    if (loadWorkspace(to)) {
      console.error(`Workspace '${to}' already exists. Choose a different name or delete it first.`);
      process.exit(1);
    }

    p.intro(brand(`workspace rename ${accent(from)} ${dim("→")} ${accent(to)}`));
    p.log.message(
      `Will rename the workspace directory and update the manifest's 'name' field. ` +
        `${ws.repos.length} repo registration(s) and any tickets will be preserved.`,
    );
    p.log.warn(
      `Repos that have 'workspace: ${from}' in their navori.config.json must be updated ` +
        `manually: cd to each repo and run 'navori configure workspace ${to}'.`,
    );

    if (!args.yes) {
      const ok = await p.confirm({
        message: `Rename workspace '${from}' to '${to}'?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    const { renameSync } = await import("node:fs");
    const oldDir = workspaceDirectory(from);
    const newDir = workspaceDirectory(to);
    renameSync(oldDir, newDir);
    // Update the manifest's name field in place
    const renamed = { ...ws, name: to };
    writeWorkspace(renamed);
    p.outro(`Renamed. New path: ${newDir}`);
  },
});

const deleteSubCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a workspace (move to ~/.navori/.trash for safety)",
  },
  args: {
    name: { type: "positional", description: "Workspace name", required: true },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const name = args.name as string;
    const ws = loadWorkspace(name);
    if (!ws) {
      console.error(`Workspace '${name}' not found`);
      process.exit(1);
    }
    const dir = workspaceDirectory(name);

    p.intro(brand(`workspace delete ${accent(name)}`));
    p.log.warn(
      `Will move ${dir} to ~/.navori/.trash/. Includes ${ws.repos.length} repo registration(s) and any tickets in that workspace.`,
    );

    if (!args.yes) {
      const ok = await p.confirm({
        message: `Delete workspace '${name}'?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    const { renameSync, existsSync, mkdirSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { homedir } = await import("node:os");
    const trashRoot = joinPath(homedir(), ".navori", ".trash");
    mkdirSync(trashRoot, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = joinPath(trashRoot, `${name}-${ts}`);
    if (existsSync(dir)) renameSync(dir, dest);
    p.outro(`Moved to ${dest}. Restore manually if needed.`);
  },
});

const addRepoSubCommand = defineCommand({
  meta: {
    name: "add-repo",
    description: "Register a repo inside a workspace",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    name: { type: "string", description: "Repo name (kebab-case)", required: true },
    path: { type: "string", description: "Absolute path to the repo", required: true },
    stack: { type: "string", description: "Stack tag (optional)" },
    description: { type: "string", description: "Repo description (optional)" },
  },
  run({ args }) {
    const ws = loadWorkspace(args.workspace as string);
    if (!ws) {
      console.error(`Workspace '${args.workspace}' not found`);
      process.exit(1);
    }
    if (ws.repos.some((r) => r.name === args.name)) {
      console.error(`Repo '${args.name}' already registered in workspace '${ws.name}'`);
      process.exit(1);
    }
    ws.repos.push({
      name: args.name as string,
      path: args.path as string,
      ...(args.stack ? { stack: args.stack as string } : {}),
      ...(args.description ? { description: args.description as string } : {}),
    });
    const written = writeWorkspace(ws);
    p.intro(brand(`workspace add-repo ${accent(ws.name)}`));
    p.log.success(`Registered '${accent(args.name as string)}' (${dim(written)})`);
    p.outro(dim("Done"));
  },
});

const setDefaultSubCommand = defineCommand({
  meta: {
    name: "set-default",
    description: "Set a default applied to every repo in a workspace",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    key: {
      type: "positional",
      description: `Default key (${VALID_DEFAULT_KEYS})`,
      required: true,
    },
    value: {
      type: "positional",
      description: "Value (engines: comma-separated; plugins enabled: true|false)",
      required: true,
    },
  },
  run({ args }) {
    const ws = loadWorkspace(args.workspace as string);
    if (!ws) {
      console.error(`Workspace '${args.workspace}' not found`);
      process.exit(1);
    }
    const result = applyDefault(ws.defaults, args.key as string, args.value as string);
    if (!result.ok || !result.defaults) {
      console.error(result.error ?? "Could not apply default");
      process.exit(1);
    }
    ws.defaults = result.defaults;
    const written = writeWorkspace(ws);
    p.intro(brand(`workspace set-default ${accent(ws.name)}`));
    p.log.success(`Set ${accent(args.key as string)} ${dim(`(${written})`)}`);
    p.log.message(kv([["defaults", JSON.stringify(ws.defaults)]]));
    p.outro(dim("Done"));
  },
});

const renderSubCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render every repo registered in a workspace",
  },
  args: {
    name: { type: "positional", description: "Workspace name", required: true },
    apply: {
      type: "boolean",
      description: "Write changes to disk. Without it, every repo is previewed (no files touched).",
    },
    force: {
      type: "boolean",
      description: "Regenerate settings.json even if corrupted or missing the $navori marker.",
    },
  },
  run({ args }) {
    const ws = loadWorkspace(args.name as string);
    if (!ws) {
      console.error(`Workspace '${args.name}' not found`);
      process.exit(1);
    }

    const apply = Boolean(args.apply);
    const preview = !apply;
    const force = Boolean(args.force);

    p.intro(brand(`workspace render ${accent(ws.name)}`));
    if (ws.repos.length === 0) {
      p.log.info("No repos registered. Add one with 'navori workspace add-repo'.");
      p.outro(dim("Done"));
      return;
    }

    type RepoStatus = "written" | "would-write" | "up-to-date" | "missing" | "error";
    const rows: Array<{ name: string; status: RepoStatus; detail: string }> = [];

    for (const repo of ws.repos) {
      if (!existsSync(repo.path)) {
        rows.push({ name: repo.name, status: "missing", detail: repo.path });
        continue;
      }
      try {
        const result = runRender(repo.path, { dryRun: preview, force });
        if (!result.ok) {
          rows.push({ name: repo.name, status: "error", detail: result.reason ?? "render failed" });
          continue;
        }
        const allEntries = result.entries.concat(...result.workspaces.map((w) => w.entries));
        const anyPending = result.written || result.workspaces.some((w) => w.written);
        const status: RepoStatus = anyPending ? (preview ? "would-write" : "written") : "up-to-date";
        rows.push({ name: repo.name, status, detail: summarizeEntries(allEntries) });
      } catch (err) {
        rows.push({ name: repo.name, status: "error", detail: (err as Error).message });
      }
    }

    const marker: Record<RepoStatus, string> = {
      written: color.green(sym.ok),
      "would-write": color.yellow(sym.bullet),
      "up-to-date": dim(sym.bullet),
      missing: color.red(sym.fail),
      error: color.red(sym.fail),
    };
    const lines = rows.map((r) => {
      const detail = r.detail ? dim(`  ${r.detail}`) : "";
      return `  ${marker[r.status]} ${accent(r.name)}  ${dim(r.status)}${detail}`;
    });
    p.log.message(lines.join("\n"));

    const failed = rows.filter((r) => r.status === "error" || r.status === "missing").length;
    const pending = rows.filter((r) => r.status === "written" || r.status === "would-write").length;
    const ok = rows.length - failed;
    const summary = `${ok}/${rows.length} ok · ${pending} ${preview ? "would change" : "changed"} · ${failed} failed`;
    if (failed > 0) {
      p.outro(`${color.yellow("Done with errors")} ${dim(summary)}`);
      process.exit(1);
    }
    p.outro(`${preview ? color.yellow("Preview") : color.green("Done")} ${dim(summary)}`);
  },
});

/** Compact per-repo counts for the workspace render table. */
function summarizeEntries(entries: Array<{ status: string }>): string {
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts["user-modified-skipped"]) parts.push(`${counts["user-modified-skipped"]} conflict`);
  if (counts["removed-condition-false"]) parts.push(`${counts["removed-condition-false"]} removed`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  return parts.join(", ");
}

export const workspaceCommand = defineCommand({
  meta: {
    name: "workspace",
    description: "Manage navori workspaces (cross-repo config + tickets)",
  },
  subCommands: {
    init: initSubCommand,
    ls: lsSubCommand,
    show: showSubCommand,
    "add-repo": addRepoSubCommand,
    "set-default": setDefaultSubCommand,
    render: renderSubCommand,
    rename: renameSubCommand,
    delete: deleteSubCommand,
  },
});
