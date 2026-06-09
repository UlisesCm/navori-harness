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

    p.intro(`navori-ai workspace init ${name}`);

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
    p.outro(`Run 'navori-ai workspace show ${name}' to inspect, or add it to a repo with 'navori-ai init --workspace ${name}'.`);
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
    if (names.length === 0) {
      console.log("No workspaces found. Create one with 'navori-ai workspace init <name>'.");
      return;
    }
    for (const name of names) {
      try {
        const ws = loadWorkspace(name);
        if (!ws) continue;
        const desc = ws.description ? ` — ${ws.description}` : "";
        console.log(`  ${name}${desc}  (${ws.repos.length} repo${ws.repos.length === 1 ? "" : "s"})`);
      } catch {
        console.log(`  ${name}  (invalid manifest)`);
      }
    }
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
      console.error(`Workspace '${name}' not found at ${workspacePath(name)}`);
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(workspace, null, 2));
      return;
    }
    console.log(`Workspace: ${workspace.name}`);
    if (workspace.description) console.log(`  description : ${workspace.description}`);
    console.log(`  path        : ${workspacePath(name)}`);
    console.log(`  directory   : ${workspaceDirectory(name)}`);
    console.log(`  ticketsDir  : ${workspace.ticketsDir}`);
    console.log(`  defaults    : ${JSON.stringify(workspace.defaults)}`);
    console.log(`  repos       : ${workspace.repos.length}`);
    for (const repo of workspace.repos) {
      const stack = repo.stack ? ` [${repo.stack}]` : "";
      const desc = repo.description ? ` — ${repo.description}` : "";
      console.log(`    · ${repo.name}${stack}  ${repo.path}${desc}`);
    }
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
    console.log(`Registered '${args.name}' in '${ws.name}' (${written})`);
  },
});

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
  },
});
