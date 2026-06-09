import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const WORKSPACES_ROOT = join(homedir(), ".navori", "workspaces");
const MANIFEST_NAME = "workspace.json";

const RepoEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "repo name must be kebab-case"),
  path: z.string().min(1),
  stack: z.string().optional(),
  description: z.string().optional(),
  branchBase: z.string().optional(),
});

const WorkspaceDefaultsSchema = z.object({
  branchBase: z.string().optional(),
  commits: z.enum(["conventional", "conventional-es", "free"]).optional(),
  language: z.enum(["es", "en"]).optional(),
  engines: z.array(z.string()).optional(),
  plugins: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
});

export const WorkspaceConfigSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "workspace name must be kebab-case"),
  description: z.string().optional(),
  /** Folder for cross-repo tickets (relative to workspace dir). */
  ticketsDir: z.string().default("tickets"),
  defaults: WorkspaceDefaultsSchema.default({}),
  repos: z.array(RepoEntrySchema).default([]),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceRepoEntry = z.infer<typeof RepoEntrySchema>;
export type WorkspaceDefaults = z.infer<typeof WorkspaceDefaultsSchema>;

export class WorkspaceError extends Error {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super(message);
    this.name = "WorkspaceError";
    this.issues = issues;
  }
}

export function workspacesRoot(): string {
  return WORKSPACES_ROOT;
}

export function workspaceDirectory(name: string): string {
  return join(WORKSPACES_ROOT, name);
}

export function workspacePath(name: string): string {
  return join(workspaceDirectory(name), MANIFEST_NAME);
}

/** Legacy layout: <name>.json next to the workspaces root. Used only by migration. */
function legacyWorkspacePath(name: string): string {
  return join(WORKSPACES_ROOT, `${name}.json`);
}

export function ensureWorkspacesRoot(): void {
  mkdirSync(WORKSPACES_ROOT, { recursive: true });
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
  if (!existsSync(WORKSPACES_ROOT)) return [];
  // Migrate any legacy .json sitting at the root before listing
  for (const entry of readdirSync(WORKSPACES_ROOT)) {
    if (entry.endsWith(".json")) {
      const name = entry.replace(/\.json$/, "");
      migrateLegacyLayoutIfNeeded(name);
    }
  }
  const names: string[] = [];
  for (const entry of readdirSync(WORKSPACES_ROOT)) {
    const full = join(WORKSPACES_ROOT, entry);
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
    raw = readFileSync(path, "utf-8");
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
