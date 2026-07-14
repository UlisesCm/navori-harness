import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  copyFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { safeHomedir } from "./home.ts";
import { NavoriError } from "./errors.ts";

function workspacesRootLazy(): string {
  return join(safeHomedir(), ".navori", "workspaces");
}
const MANIFEST_NAME = "workspace.json";

const RepoEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "repo name must be kebab-case"),
  path: z.string().min(1),
  stack: z.string().optional(),
  description: z.string().optional(),
  branchBase: z.string().optional(),
});

export const WorkspaceDefaultsSchema = z.object({
  branchBase: z.string().optional(),
  prTarget: z.string().optional(),
  commits: z.enum(["conventional", "conventional-es", "free"]).optional(),
  language: z.enum(["es", "en"]).optional(),
  engines: z.array(z.string()).optional(),
  plugins: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
});

export const WorkspaceConfigSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "workspace name must be kebab-case"),
  description: z.string().optional(),
  /** Folder for cross-repo tickets (relative to workspace dir).
   * Restricted to a simple relative segment to prevent path traversal
   * (e.g. "../etc/passwd") and to avoid silent failure of absolute
   * paths under path.join. */
  ticketsDir: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/,
      "ticketsDir must be a relative path (alphanumeric, '-', '_', '.', '/'). No leading '/' or '..'.",
    )
    .refine((s) => !s.split("/").includes(".."), {
      message: "ticketsDir must not contain '..' segments",
    })
    .default("tickets"),
  defaults: WorkspaceDefaultsSchema.default({}),
  repos: z.array(RepoEntrySchema).default([]),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceRepoEntry = z.infer<typeof RepoEntrySchema>;
export type WorkspaceDefaults = z.infer<typeof WorkspaceDefaultsSchema>;

export class WorkspaceError extends NavoriError {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super("workspace-invalid", message);
    this.issues = issues;
  }
}

export function workspacesRoot(): string {
  return workspacesRootLazy();
}

export function workspaceDirectory(name: string): string {
  return join(workspacesRootLazy(), name);
}

export function workspacePath(name: string): string {
  return join(workspaceDirectory(name), MANIFEST_NAME);
}

/** Legacy layout: <name>.json next to the workspaces root. Used only by migration. */
function legacyWorkspacePath(name: string): string {
  return join(workspacesRootLazy(), `${name}.json`);
}

export function ensureWorkspacesRoot(): void {
  mkdirSync(workspacesRootLazy(), { recursive: true });
}

/**
 * Migrate from the legacy layout `<name>.json + <name>/` to the new
 * `<name>/workspace.json + <name>/tickets/`. Idempotent: if already migrated
 * or never existed in the old form, this is a no-op.
 */
function migrateLegacyLayoutIfNeeded(name: string): void {
  const legacy = legacyWorkspacePath(name);
  const current = workspacePath(name);
  if (!existsSync(legacy) || existsSync(current)) return;
  const dir = workspaceDirectory(name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(legacy, current);
  try {
    rmSync(legacy, { force: true });
  } catch {
    // best-effort; the new manifest is already in place
  }
}

export function listWorkspaces(): string[] {
  if (!existsSync(workspacesRootLazy())) return [];
  // Migrate any legacy .json sitting at the root before listing
  for (const entry of readdirSync(workspacesRootLazy())) {
    if (entry.endsWith(".json")) {
      const name = entry.replace(/\.json$/, "");
      migrateLegacyLayoutIfNeeded(name);
    }
  }
  const names: string[] = [];
  for (const entry of readdirSync(workspacesRootLazy())) {
    const full = join(workspacesRootLazy(), entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(full, MANIFEST_NAME))) names.push(entry);
  }
  return names.sort();
}

export function loadWorkspace(name: string): WorkspaceConfig | null {
  migrateLegacyLayoutIfNeeded(name);
  const path = workspacePath(name);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").replace(/^﻿/, ""); // strip BOM if present
  } catch (err) {
    throw new WorkspaceError(`Cannot read workspace '${name}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceError(`Invalid JSON in workspace '${name}': ${(err as Error).message}`);
  }
  const result = WorkspaceConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkspaceError(`Validation failed for workspace '${name}'`, result.error.issues);
  }
  return result.data;
}

export function writeWorkspace(workspace: WorkspaceConfig): string {
  ensureWorkspacesRoot();
  const dir = workspaceDirectory(workspace.name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, workspace.ticketsDir), { recursive: true });

  const path = workspacePath(workspace.name);
  const validated = WorkspaceConfigSchema.parse({
    $schema: "https://navori.dev/schema/navori.workspace.v1.json",
    ...workspace,
  });
  writeFileAtomic(path, JSON.stringify(validated, null, 2) + "\n");
  return path;
}

/**
 * Best-effort canonical form of a path for comparisons: absolute + symlinks
 * resolved (e.g. /var vs /private/var on macOS). Falls back to plain resolve()
 * when the path does not exist — stale registry entries still compare sanely.
 */
export function canonicalPath(input: string): string {
  const abs = resolve(input);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Normalize a repo path for registration: absolute, symlinks resolved, and
 * verified to exist on disk. Registering a phantom path is how stale
 * machine-specific entries are born (#76), so a missing directory is an error.
 */
export function resolveRepoPath(input: string): string {
  const abs = resolve(input);
  if (!existsSync(abs)) {
    throw new WorkspaceError(`Repo path does not exist: ${abs}`);
  }
  return canonicalPath(abs);
}

export type LinkAction = "added" | "updated-path" | "unchanged";

export interface LinkRepoResult {
  /** True when the workspace did not exist on this machine and was created. */
  createdWorkspace: boolean;
  action: LinkAction;
  /** Absolute path to the workspace manifest (workspace.json). */
  manifestPath: string;
  /** Previous registered path when action is "updated-path". */
  previousPath?: string;
}

/**
 * Register (or re-register) a repo in a workspace manifest, creating the
 * workspace when it does not exist yet. The registry at ~/.navori/workspaces/
 * is machine-local and never travels with the repo (#76): a teammate who
 * cloned the repos elsewhere runs `navori workspace link` to rebuild their
 * own registry. Entries are keyed by repo name — an existing entry whose path
 * differs (another machine's path, or a stale one) gets its path updated.
 * Idempotent: linking twice is a no-op.
 */
export function linkRepoToWorkspace(
  workspaceName: string,
  repo: { name: string; path: string },
): LinkRepoResult {
  let ws = loadWorkspace(workspaceName);
  const createdWorkspace = ws === null;
  if (!ws) {
    // Minimal manifest — schema defaults fill ticketsDir/defaults/repos.
    ws = WorkspaceConfigSchema.parse({ name: workspaceName });
  }
  const existing = ws.repos.find((r) => r.name === repo.name);
  let action: LinkAction;
  let previousPath: string | undefined;
  if (!existing) {
    ws.repos.push({ name: repo.name, path: repo.path });
    action = "added";
  } else if (canonicalPath(existing.path) !== canonicalPath(repo.path)) {
    previousPath = existing.path;
    existing.path = repo.path;
    action = "updated-path";
  } else {
    action = "unchanged";
  }
  const manifestPath =
    createdWorkspace || action !== "unchanged" ? writeWorkspace(ws) : workspacePath(workspaceName);
  return { createdWorkspace, action, manifestPath, ...(previousPath ? { previousPath } : {}) };
}

/**
 * Resolve a path from inside a workspace, e.g. "workspace://bonum/tickets/X.md".
 * Returns null if it cannot be resolved (workspace missing, bad scheme, etc.).
 */
export function resolveWorkspaceUri(uri: string): { workspaceName: string; absPath: string } | null {
  const match = uri.match(/^workspace:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, workspaceName = "", relPath = ""] = match;
  if (!workspaceName || !relPath) return null;
  const dir = workspaceDirectory(workspaceName);
  return { workspaceName, absPath: join(dir, relPath) };
}
