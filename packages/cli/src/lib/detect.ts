import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { presetExists } from "./presets.ts";
import { collectWorkspacePatterns } from "./workspace-patterns.ts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type MonorepoTool = "pnpm" | "turbo" | "nx" | "rush" | "lerna";

export interface MonorepoInfo {
  tool: MonorepoTool;
  source: string;
}

export interface StackInfo {
  language: "ts" | "js" | "python" | "rust" | "go" | "unknown";
  framework: string | null;
  ui: string | null;
  forms: string | null;
  state: string | null;
  test: string | null;
  /** Input-validation library detected in deps. Drives preset skill
   * conditions (e.g. zod-validation vs joi-validation). null = none found. */
  validator: "zod" | "joi" | null;
  /** Job scheduler / message-queue dep detected (agenda, bullmq, amqplib, …).
   * Signals a background worker — a repo whose job is to process jobs/messages,
   * not serve HTTP. null = none found. */
  worker: string | null;
  deps: ReadonlyArray<string>;
}

export interface QualityGateGuess {
  fast: string;
  full: string;
}

// Claude infra detection lives in its own module; re-export to keep the
// public surface of detect.ts stable for callers.
export { detectClaudeInfra, type ClaudeInfraInventory } from "./claude-infra.ts";
import { detectClaudeInfra, type ClaudeInfraInventory } from "./claude-infra.ts";

export interface DetectedProject {
  name: string | null;
  branchBase: string | null;
  existingEngines: string[];
  packageManager: PackageManager | null;
  monorepo: MonorepoInfo | null;
  stack: StackInfo;
  suggestedPreset: string;
  /**
   * A recognized stack candidate that has NO preset on disk yet. Null when the
   * suggested preset exists (the common case) or when the stack is genuinely
   * unknown. When set, `suggestedPreset` is "custom" (baseline render) but init
   * names this gap honestly instead of falling back silently.
   */
  suggestedPresetGap: string | null;
  qualityGate: QualityGateGuess | null;
  claudeInfra: ClaudeInfraInventory;
  sources: {
    name: string | null;
    branchBase: string | null;
    packageManager: string | null;
  };
}

/**
 * Best-effort detection of everything we can infer about the repo at `cwd`.
 * All sub-detections fail gracefully (return null/[]) without throwing.
 */
export function detectProject(cwd: string): DetectedProject {
  const pkg = readPackageJson(cwd);
  const pyproject = readPyproject(cwd);
  const cargo = readCargoToml(cwd);

  // Only accept string names — manifest readers may surface non-string values
  // (e.g. pkg.name: { value: "..." } from malformed package.json). Falling
  // back to null here lets the `??` chain continue to git/basename detection.
  const fromPackageJson = typeof pkg?.name === "string" ? pkg.name : null;
  const fromPyproject = typeof pyproject?.name === "string" ? pyproject.name : null;
  const fromCargo = typeof cargo?.name === "string" ? cargo.name : null;
  const fromGit = detectGitRepoName(cwd);
  const fromBasename = basename(cwd);

  const nameSource = fromPackageJson
    ? "package.json"
    : fromPyproject
      ? "pyproject.toml"
      : fromCargo
        ? "Cargo.toml"
        : fromGit
          ? "git remote"
          : "directory name";

  const name = normalizeName(
    fromPackageJson ?? fromPyproject ?? fromCargo ?? fromGit ?? fromBasename,
  );

  const branchBase = detectBranchBase(cwd);
  const existingEngines = detectExistingEngines(cwd);
  const packageManager = detectPackageManager(cwd);
  const monorepo = detectMonorepo(cwd);
  const stack = detectStack(cwd, pkg, pyproject, cargo);
  const { preset: suggestedPreset, gap: suggestedPresetGap } = suggestPreset(stack, monorepo);
  const qualityGate = guessQualityGate(pkg, packageManager, stack);
  const claudeInfra = detectClaudeInfra(cwd);

  return {
    name,
    branchBase,
    existingEngines,
    packageManager,
    monorepo,
    stack,
    suggestedPreset,
    suggestedPresetGap,
    qualityGate,
    claudeInfra,
    sources: {
      name: name ? nameSource : null,
      branchBase: branchBase ? "git" : null,
      packageManager: packageManager ? detectPackageManagerSource(cwd) : null,
    },
  };
}

// ============================================================
// Name normalization
// ============================================================

/**
 * Names that are almost certainly scaffolding leftovers, not a real project
 * name. Conservative on purpose — a repo legitimately called "app" or "demo"
 * shouldn't trip the warning, so only obvious placeholders are listed. Surfaced
 * by `doctor` and `workspace show` (a fork left with the template's name, or
 * `temp-app` from a never-renamed package.json, is a config smell worth a nudge).
 */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([
  "temp-app",
  "temp",
  "tmp",
  "my-app",
  "myapp",
  "my-project",
  "your-app",
  "your-project",
  "your-app-name",
  "app-name",
  "project-name",
  "changeme",
  "change-me",
  "example-app",
  "sample-app",
  "new-project",
  "untitled",
  "placeholder",
]);

/** True when `name` looks like an un-renamed scaffold placeholder. */
export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

function normalizeName(raw: unknown): string | null {
  // Defensive: package.json / pyproject.toml / Cargo.toml are user-controlled
  // and may have non-string values in fields we expected to be strings.
  if (typeof raw !== "string" || !raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return null;
  return /^[a-z0-9]/.test(cleaned) ? cleaned : null;
}

// ============================================================
// Manifest readers
// ============================================================

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
}

function readPackageJson(cwd: string): PackageJson | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    // Strip BOM (Windows editors sometimes prepend U+FEFF to UTF-8 files).
    const raw = readFileSync(path, "utf-8").replace(/^﻿/, "");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function readPyproject(cwd: string): { name: string | null; deps: string[] } | null {
  const path = join(cwd, "pyproject.toml");
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const deps: string[] = [];
    // Naive: list dependency names from [tool.poetry.dependencies] or [project.dependencies]
    const depBlock = content.match(/\[(?:tool\.poetry\.)?dependencies\]([\s\S]*?)(?:\n\[|$)/);
    if (depBlock?.[1]) {
      for (const line of depBlock[1].split("\n")) {
        const m = line.match(/^\s*([a-zA-Z0-9_\-.]+)\s*=/);
        if (m?.[1] && m[1] !== "python") deps.push(m[1].toLowerCase());
      }
    }
    // Also pull from [project] dependencies = ["foo>=1", ...]
    const projectDeps = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (projectDeps?.[1]) {
      const items = projectDeps[1].match(/"([^"]+)"/g) ?? [];
      for (const item of items) {
        const pkgName = item.slice(1, -1).split(/[<>=~!]/)[0]?.trim().toLowerCase();
        if (pkgName) deps.push(pkgName);
      }
    }
    return { name: nameMatch?.[1] ?? null, deps };
  } catch {
    return null;
  }
}

function readCargoToml(cwd: string): { name: string | null } | null {
  const path = join(cwd, "Cargo.toml");
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    return { name: match?.[1] ?? null };
  } catch {
    return null;
  }
}

// ============================================================
// Git detection
// ============================================================

function detectGitRepoName(cwd: string): string | null {
  const url = gitConfigGet(cwd, "remote.origin.url");
  if (!url) return null;
  const match = url.trim().match(/[/:]([^/:]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function gitConfigGet(cwd: string, key: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "config", "--get", key], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

function gitRevParse(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

function detectBranchBase(cwd: string): string | null {
  const originHead = gitRevParse(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "develop", "dev"]) {
    const found = gitRevParse(cwd, ["rev-parse", "--verify", "--quiet", candidate]);
    if (found) return candidate;
  }
  return null;
}

// ============================================================
// Engine detection
// ============================================================

function detectExistingEngines(cwd: string): string[] {
  const found: string[] = [];
  if (existsSync(join(cwd, ".claude"))) found.push("claude");
  if (existsSync(join(cwd, "AGENTS.md"))) found.push("agents-md");
  if (existsSync(join(cwd, ".cursor"))) found.push("cursor");
  if (existsSync(join(cwd, ".github", "copilot-instructions.md"))) found.push("copilot");
  return found;
}

// ============================================================
// Package manager detection
// ============================================================

function detectPackageManager(cwd: string): PackageManager | null {
  // 1) "packageManager" field in package.json wins
  const pkg = readPackageJson(cwd);
  if (pkg?.packageManager) {
    const tool = pkg.packageManager.split("@")[0];
    if (tool === "pnpm" || tool === "npm" || tool === "yarn" || tool === "bun") return tool;
  }
  // 2) Lockfile detection
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return null;
}

function detectPackageManagerSource(cwd: string): string {
  const pkg = readPackageJson(cwd);
  if (pkg?.packageManager) return "package.json";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm-lock.yaml";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun.lock";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn.lock";
  if (existsSync(join(cwd, "package-lock.json"))) return "package-lock.json";
  return "unknown";
}

// ============================================================
// Monorepo detection
// ============================================================

function detectMonorepo(cwd: string): MonorepoInfo | null {
  // A pnpm-workspace.yaml only means a monorepo when it actually declares
  // package patterns. Single-package repos sometimes ship one purely for build
  // config (e.g. `onlyBuiltDependencies`) with no `packages:` — those are not
  // monorepos, so fall through to framework detection instead of suggesting a
  // phantom `monorepo-*` preset.
  if (existsSync(join(cwd, "pnpm-workspace.yaml"))) {
    if (collectWorkspacePatterns(cwd).length > 0) {
      if (existsSync(join(cwd, "turbo.json"))) {
        return { tool: "turbo", source: "turbo.json + pnpm-workspace.yaml" };
      }
      return { tool: "pnpm", source: "pnpm-workspace.yaml" };
    }
  }
  if (existsSync(join(cwd, "turbo.json"))) {
    return { tool: "turbo", source: "turbo.json" };
  }
  if (existsSync(join(cwd, "nx.json"))) {
    return { tool: "nx", source: "nx.json" };
  }
  if (existsSync(join(cwd, "rush.json"))) {
    return { tool: "rush", source: "rush.json" };
  }
  if (existsSync(join(cwd, "lerna.json"))) {
    return { tool: "lerna", source: "lerna.json" };
  }
  // workspaces field in package.json — only when it lists real patterns.
  const pkg = readPackageJson(cwd);
  if (pkg?.workspaces && collectWorkspacePatterns(cwd).length > 0) {
    return { tool: "npm", source: "package.json workspaces" };
  }
  return null;
}

// ============================================================
// Stack detection
// ============================================================

function collectNodeDeps(pkg: PackageJson | null): string[] {
  if (!pkg) return [];
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
}

function pick(deps: ReadonlySet<string>, ...candidates: string[]): string | null {
  for (const c of candidates) {
    if (deps.has(c)) return c;
  }
  return null;
}

function detectStack(
  cwd: string,
  pkg: PackageJson | null,
  pyproject: { name: string | null; deps: string[] } | null,
  cargo: { name: string | null } | null,
): StackInfo {
  // Python
  if (pyproject) {
    const deps = new Set(pyproject.deps);
    return {
      language: "python",
      framework: pick(deps, "fastapi", "django", "flask", "starlette") ?? null,
      ui: null,
      forms: pick(deps, "pydantic") ?? null,
      state: null,
      test: pick(deps, "pytest") ?? null,
      validator: null,
      worker: pick(deps, "celery", "rq", "dramatiq", "apscheduler") ?? null,
      deps: Array.from(deps),
    };
  }
  // Rust
  if (cargo) {
    return {
      language: "rust",
      framework: null,
      ui: null,
      forms: null,
      state: null,
      test: null,
      validator: null,
      worker: null,
      deps: [],
    };
  }
  // Node
  const nodeDeps = new Set(collectNodeDeps(pkg));
  if (nodeDeps.size === 0 && !pkg) {
    return {
      language: "unknown",
      framework: null,
      ui: null,
      forms: null,
      state: null,
      test: null,
      validator: null,
      worker: null,
      deps: [],
    };
  }
  const hasTs = nodeDeps.has("typescript") || existsSync(join(cwd, "tsconfig.json"));

  // Order matters: more specific frameworks before the generic build tools
  // they sit on top of (vite/react). Otherwise a Svelte+Vite repo would
  // get classified as 'vite' with a vite-react-ts preset.
  const framework =
    // Application frameworks (they own the project)
    pick(nodeDeps, "next") ??
    pick(nodeDeps, "@nestjs/core") ??
    pick(nodeDeps, "@medusajs/medusa") ??
    pick(nodeDeps, "@keystone-6/core") ??
    pick(nodeDeps, "expo") ??
    pick(nodeDeps, "react-native") ??
    pick(nodeDeps, "remix") ??
    // Meta-frameworks on top of build tools — check before vite/react
    pick(nodeDeps, "astro") ??
    pick(nodeDeps, "@sveltejs/kit") ??
    pick(nodeDeps, "@builder.io/qwik") ??
    pick(nodeDeps, "solid-js") ??
    pick(nodeDeps, "@tauri-apps/api") ??
    pick(nodeDeps, "electron") ??
    pick(nodeDeps, "svelte") ??
    pick(nodeDeps, "vue") ??
    // Build tools / generic frontend
    pick(nodeDeps, "vite") ??
    pick(nodeDeps, "react") ??
    // Backend frameworks
    pick(nodeDeps, "@angular/core") ??
    pick(nodeDeps, "fastify") ??
    pick(nodeDeps, "hono") ??
    pick(nodeDeps, "elysia") ??
    pick(nodeDeps, "express") ??
    null;

  const ui =
    pick(nodeDeps, "@mantine/core") ??
    pick(nodeDeps, "@mui/material") ??
    pick(nodeDeps, "tailwindcss") ??
    pick(nodeDeps, "tamagui") ??
    pick(nodeDeps, "@radix-ui/themes") ??
    null;

  const forms =
    pick(nodeDeps, "formik") ??
    pick(nodeDeps, "react-hook-form") ??
    pick(nodeDeps, "@mantine/form") ??
    pick(nodeDeps, "vee-validate") ??
    null;

  const state =
    pick(nodeDeps, "@reduxjs/toolkit") ??
    pick(nodeDeps, "redux") ??
    pick(nodeDeps, "zustand") ??
    pick(nodeDeps, "jotai") ??
    pick(nodeDeps, "valtio") ??
    pick(nodeDeps, "@tanstack/react-query") ??
    pick(nodeDeps, "@apollo/client") ??
    null;

  const test =
    pick(nodeDeps, "vitest") ??
    pick(nodeDeps, "jest") ??
    pick(nodeDeps, "@playwright/test") ??
    pick(nodeDeps, "cypress") ??
    null;

  // zod wins over joi when a repo somehow has both — it's the preset default
  // and the more common boundary validator. The detector picks at most one.
  const validator: StackInfo["validator"] = nodeDeps.has("zod")
    ? "zod"
    : nodeDeps.has("joi") || nodeDeps.has("@hapi/joi")
      ? "joi"
      : null;

  // Job scheduler / message-queue dep → background worker signal. Used by the
  // preset picker to beat express when the repo processes jobs/messages rather
  // than serving HTTP (the sole presence of express must not win).
  const worker = pick(
    nodeDeps,
    "agenda",
    "bullmq",
    "bull",
    "bee-queue",
    "bree",
    "node-cron",
    "cron",
    "amqplib",
    "amqp-connection-manager",
    "kafkajs",
    "sqs-consumer",
    "rhea",
  );

  return {
    language: hasTs ? "ts" : pkg ? "js" : "unknown",
    framework,
    ui,
    forms,
    state,
    test,
    validator,
    worker,
    deps: Array.from(nodeDeps),
  };
}

// ============================================================
// Preset suggestion
// ============================================================

function suggestPreset(
  stack: StackInfo,
  monorepo: MonorepoInfo | null,
): { preset: string; gap: string | null } {
  // The candidate logic names ideal presets (e.g. "monorepo-turbopnpm", "rust")
  // that may not exist yet. Three outcomes:
  //   - candidate is "custom"            → unknown stack, no gap to surface.
  //   - candidate exists on disk         → use it, no gap.
  //   - candidate recognized but missing → render baseline ("custom") AND expose
  //     the candidate as a `gap` so init names it honestly instead of falling
  //     back silently to custom.
  const candidate = pickPresetCandidate(stack, monorepo);
  if (candidate === "custom") return { preset: "custom", gap: null };
  if (presetExists(candidate)) return { preset: candidate, gap: null };
  return { preset: "custom", gap: candidate };
}

function pickPresetCandidate(stack: StackInfo, monorepo: MonorepoInfo | null): string {
  if (monorepo) {
    if (monorepo.tool === "turbo") return "monorepo-turbopnpm";
    if (monorepo.tool === "pnpm") return "monorepo-pnpm";
    if (monorepo.tool === "npm" || monorepo.tool === "lerna") return "monorepo-npm";
  }

  if (stack.language === "python") {
    if (stack.framework === "fastapi") return "fastapi-python";
    if (stack.framework === "django") return "django-python";
    return "python";
  }

  if (stack.language === "rust") return "rust";

  const fw = stack.framework;
  const ui = stack.ui;
  const state = stack.state;

  if (fw === "@medusajs/medusa") return "medusa";
  if (fw === "@keystone-6/core") return "bun-keystone";
  if (fw === "next") {
    if (state === "@apollo/client") return "nextjs-apollo";
    return "nextjs";
  }
  if (fw === "@nestjs/core") return "nestjs";
  if (fw === "expo" || fw === "react-native") return "react-native-expo";
  // Modern meta-frameworks — must come before vite generic
  if (fw === "astro") return "astro";
  if (fw === "@sveltejs/kit" || fw === "svelte") return "sveltekit";
  if (fw === "@builder.io/qwik") return "qwik";
  if (fw === "solid-js") return "solid";
  if (fw === "@tauri-apps/api") return "tauri";
  if (fw === "electron") return "electron";
  if (fw === "vue") return "vue";
  if (fw === "@angular/core") return "angular";
  if (fw === "vite") {
    if (ui === "@mantine/core") return "vite-react-ts-mantine";
    return "vite-react-ts";
  }
  if (fw === "react") return "react";
  if (fw === "remix") return "remix";
  if (fw === "fastify") return "fastify";
  if (fw === "hono") return "hono";
  if (fw === "elysia") return "elysia";
  // Background worker: a job scheduler / message queue and NO dedicated HTTP
  // framework (express counts as "none dedicated" — it's often just a
  // healthcheck). Beats express-mongoose: notifications--server ships express
  // but defines no business routes. Deliberately scoped to express/no-framework
  // so a Nest/Next/Fastify API that also runs jobs stays its own preset.
  if (stack.worker && (fw === "express" || fw === null)) return "background-worker";
  if (fw === "express") return "express-mongoose";

  return "custom";
}

// ============================================================
// Quality gate guess
// ============================================================

function guessQualityGate(
  pkg: PackageJson | null,
  pm: PackageManager | null,
  stack: StackInfo,
): QualityGateGuess | null {
  if (!pkg) {
    // Python fallback
    if (stack.language === "python") {
      const full = stack.test === "pytest" ? "ruff check . && pytest" : "ruff check .";
      return { fast: "ruff check .", full };
    }
    return null;
  }
  const runner = pm ?? "npm";
  const scripts = pkg.scripts ?? {};
  const has = (name: string) => typeof scripts[name] === "string";
  const run = (name: string) => `${runner} run ${name}`;

  // Cheapest type-check-ish script that actually exists in package.json.
  // Never propose a script name we didn't verify: an invented "typecheck"
  // makes the pre-commit hook fail on every commit. 'check' is a common
  // typecheck alias under Biome/Skia conventions.
  const typecheck = has("typecheck")
    ? run("typecheck")
    : has("type-check")
      ? run("type-check")
      : has("check")
        ? run("check")
        : has("compile")
          ? run("compile")
          : null;

  // Prefer a single umbrella script for `full` when present; pair it with a
  // real type-check for `fast`, falling back to the umbrella itself (it exists).
  if (has("validate")) return { fast: typecheck ?? run("validate"), full: run("validate") };
  if (has("check:all")) return { fast: typecheck ?? run("check:all"), full: run("check:all") };

  // Otherwise compose from the individual scripts that exist.
  const fastParts: string[] = [];
  if (typecheck) fastParts.push(typecheck);

  const fullParts: string[] = [...fastParts];
  if (has("lint")) fullParts.push(run("lint"));
  if (has("test:unit")) fullParts.push(run("test:unit"));
  else if (has("test")) fullParts.push(run("test"));

  if (fullParts.length === 0) return null;

  // `fast` always references a real script: the type-check when present, else
  // the first existing full step (lint/test) — never an unverified name.
  const fast = fastParts.length > 0 ? fastParts.join(" && ") : fullParts[0]!;
  const full = fullParts.join(" && ");
  return { fast, full };
}
