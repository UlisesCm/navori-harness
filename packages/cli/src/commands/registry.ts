import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  listRegistryRepos,
  registerRepo,
  unregisterRepo,
  pruneRegistry,
  scanForRepos,
  registryPath,
} from "../lib/registry.ts";
import { readConfig } from "../lib/config.ts";
import { brand, dim, color, accent, sym } from "../lib/style.ts";
import { tc, resolveLang, type Lang } from "../lib/i18n.ts";
import { readGlobalConfig } from "../lib/global-config.ts";

/** Language for the machine-global registry commands: global config, else default. */
function globalLang(): Lang {
  return resolveLang(readGlobalConfig()?.language);
}

/** Best-effort read of a repo's config.name for display / caching. */
function repoName(repoPath: string): string | undefined {
  const cfgPath = join(repoPath, "navori.config.json");
  if (!existsSync(cfgPath)) return undefined;
  try {
    return readConfig(cfgPath).name;
  } catch {
    return undefined;
  }
}

const lsSubCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List every repo in the global registry",
  },
  run() {
    const tr = tc(globalLang()).registry;
    p.intro(brand("registry ls"));
    const repos = listRegistryRepos();
    if (repos.length === 0) {
      p.log.info(tr.lsEmpty);
      p.outro(dim(registryPath()));
      return;
    }
    const lines = repos.map((r) => {
      const present = existsSync(join(r.path, "navori.config.json"));
      const marker = present ? color.green(sym.ok) : color.red(sym.fail);
      const name = r.name ?? tr.unknownName;
      const tag = present ? "" : dim(tr.missingTag);
      return `  ${marker} ${accent(name)}${tag}\n      ${dim(r.path)}`;
    });
    p.log.message(lines.join("\n"));
    const missing = repos.filter((r) => !existsSync(join(r.path, "navori.config.json"))).length;
    p.outro(dim(tr.lsSummary(repos.length, missing)));
  },
});

const scanSubCommand = defineCommand({
  meta: {
    name: "scan",
    description: "Walk one or more directories and register every navori repo found",
  },
  args: {
    dirs: { type: "positional", description: "Directory(ies) to scan", required: true },
    depth: { type: "string", description: "Max directory depth to descend (default 4)" },
  },
  run({ args, rawArgs }) {
    const tr = tc(globalLang()).registry;
    p.intro(brand("registry scan"));
    // citty gives a single positional in `args.dirs`; grab the rest from rawArgs
    // so `navori registry scan ~/a ~/b` scans both.
    const positionals = (rawArgs ?? []).filter((a) => !a.startsWith("-"));
    const dirs = [...new Set(positionals.length > 0 ? positionals : [String(args.dirs)])];
    const maxDepth = args.depth ? Number(args.depth) : undefined;

    let added = 0;
    let unchanged = 0;
    const rows: string[] = [];
    for (const dir of dirs) {
      const root = resolve(dir);
      if (!existsSync(root)) {
        rows.push(`  ${color.red(sym.fail)} ${dir} ${dim(tr.dirNotFound)}`);
        continue;
      }
      const found = scanForRepos(root, maxDepth ? { maxDepth } : {});
      for (const repoPath of found) {
        const result = registerRepo(repoPath, repoName(repoPath));
        if (result === "added") added += 1;
        else unchanged += 1;
        const badge = result === "added" ? color.green(tr.addedBadge) : dim(tr.knownBadge);
        rows.push(`  ${badge}  ${accent(repoName(repoPath) ?? repoPath)}  ${dim(repoPath)}`);
      }
    }
    if (rows.length > 0) p.log.message(rows.join("\n"));
    p.outro(`${color.green(tr.doneWord)} ${dim(tr.scanSummary(added, unchanged))}`);
  },
});

const addSubCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register a single repo by path",
  },
  args: {
    path: { type: "positional", description: "Path to the repo root", required: true },
  },
  run({ args }) {
    const tr = tc(globalLang()).registry;
    p.intro(brand("registry add"));
    const repoPath = resolve(String(args.path));
    if (!existsSync(join(repoPath, "navori.config.json"))) {
      p.cancel(tr.notNavoriRepo(repoPath));
      process.exit(1);
    }
    const result = registerRepo(repoPath, repoName(repoPath));
    const verb =
      result === "added" ? color.green(tr.registeredVerb) : dim(tr.alreadyRegisteredVerb);
    p.outro(`${verb} ${accent(repoName(repoPath) ?? repoPath)} ${dim(repoPath)}`);
  },
});

const removeSubCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Unregister a repo by path (leaves its files untouched)",
  },
  args: {
    path: { type: "positional", description: "Path to the repo root", required: true },
  },
  run({ args }) {
    const tr = tc(globalLang()).registry;
    p.intro(brand("registry remove"));
    const repoPath = resolve(String(args.path));
    const removed = unregisterRepo(repoPath);
    if (removed) p.outro(`${color.green(tr.removedVerb)} ${dim(repoPath)}`);
    else p.outro(dim(tr.notInRegistry(repoPath)));
  },
});

const pruneSubCommand = defineCommand({
  meta: {
    name: "prune",
    description: "Drop registry entries whose repo no longer exists",
  },
  run() {
    const tr = tc(globalLang()).registry;
    p.intro(brand("registry prune"));
    const { removed, kept } = pruneRegistry();
    if (removed.length === 0) {
      p.outro(dim(tr.nothingToPrune(kept.length)));
      return;
    }
    const lines = removed.map((r) => `  ${color.red(sym.fail)} ${dim(r.path)}`);
    p.log.message(lines.join("\n"));
    p.outro(`${color.green(tr.prunedVerb)} ${dim(tr.pruneSummary(removed.length, kept.length))}`);
  },
});

export const registryCommand = defineCommand({
  meta: {
    name: "registry",
    description: "Global registry of every navori repo on this machine (for 'render --all')",
  },
  subCommands: {
    ls: lsSubCommand,
    scan: scanSubCommand,
    add: addSubCommand,
    remove: removeSubCommand,
    prune: pruneSubCommand,
  },
});
