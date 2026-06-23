import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { presetExists } from "./presets.ts";

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
  const suggestedPreset = suggestPreset(stack, monorepo);
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
  if (existsSync(join(cwd, "pnpm-workspace.yaml"))) {
    if (existsSync(join(cwd, "turbo.json"))) {
      return { tool: "turbo", source: "turbo.json + pnpm-workspace.yaml" };
    }
    return { tool: "pnpm", source: "pnpm-workspace.yaml" };
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
  // workspaces field in package.json
  const pkg = readPackageJson(cwd);
  if (pkg?.workspaces) {
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

  return {
    language: hasTs ? "ts" : pkg ? "js" : "unknown",
    framework,
    ui,
    forms,
    state,
    test,
    deps: Array.from(nodeDeps),
  };
}

// ============================================================
// Preset suggestion
// ============================================================

function suggestPreset(stack: StackInfo, monorepo: MonorepoInfo | null): string {
  // Only suggest a preset that actually ships a definition. The candidate logic
  // names ideal presets (e.g. "monorepo-turbopnpm", "rust") that may not exist
  // yet; surfacing a phantom id would render the baseline AND warn. Fall back to
  // "custom" (same baseline, no warning) until the preset is authored.
  const candidate = pickPresetCandidate(stack, monorepo);
  return presetExists(candidate) ? candidate : "custom";
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
  if (fw === "express") return "express-microservice";

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

  // Prefer a single "validate" / "check:all" script if it exists
  if (has("validate")) {
    return { fast: `${runner} run typecheck`, full: `${runner} run validate` };
  }
  if (has("check:all")) {
    return { fast: `${runner} run typecheck`, full: `${runner} run check:all` };
  }

  // Compose from common script names. 'check' is a common alias for typecheck
  // in projects that use Biome or Skia conventions.
  const fastParts: string[] = [];
  if (has("typecheck")) fastParts.push(`${runner} run typecheck`);
  else if (has("type-check")) fastParts.push(`${runner} run type-check`);
  else if (has("check")) fastParts.push(`${runner} run check`);
  else if (has("compile")) fastParts.push(`${runner} run compile`);

  const fullParts: string[] = [...fastParts];
  if (has("lint")) fullParts.push(`${runner} run lint`);
  if (has("test:unit")) fullParts.push(`${runner} run test:unit`);
  else if (has("test")) fullParts.push(`${runner} run test`);

  if (fastParts.length === 0 && fullParts.length === 0) return null;

  const fast = fastParts.join(" && ") || `${runner} run lint`;
  const full = fullParts.join(" && ") || fast;
  return { fast, full };
}
