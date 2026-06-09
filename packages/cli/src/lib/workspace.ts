import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const WORKSPACES_ROOT = join(homedir(), ".navori", "workspaces");

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

export function workspacePath(name: string): string {
  return join(WORKSPACES_ROOT, `${name}.json`);
}

export function workspaceDirectory(name: string): string {
  return join(WORKSPACES_ROOT, name);
}

export function ensureWorkspacesRoot(): void {
  mkdirSync(WORKSPACES_ROOT, { recursive: true });
}

export function listWorkspaces(): string[] {
  if (!existsSync(WORKSPACES_ROOT)) return [];
  return readdirSync(WORKSPACES_ROOT)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function loadWorkspace(name: string): WorkspaceConfig | null {
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
  const path = workspacePath(workspace.name);
  const dir = workspaceDirectory(workspace.name);
  // Ensure the per-workspace directory exists too (for tickets/, etc.)
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, workspace.ticketsDir), { recursive: true });

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
