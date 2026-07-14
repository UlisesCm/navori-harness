import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { workspaceDirectory, loadWorkspace } from "./workspace.ts";
import { NavoriError } from "./errors.ts";
import { NavoriConfigSchema } from "./schema.ts";

export interface TicketSummary {
  id: string;
  /** Absolute path of the .md file. */
  path: string;
  /** First line of the file (intended as title). */
  title: string;
  /** "active" if directly under tickets/, "archive" if under tickets/_archive/. */
  state: "active" | "archive";
}

export class TicketError extends NavoriError {
  constructor(message: string) {
    super("ticket-error", message);
  }
}

export function ticketsDir(workspaceName: string): string {
  const ws = loadWorkspace(workspaceName);
  if (!ws) throw new TicketError(`Workspace '${workspaceName}' not found`);
  return join(workspaceDirectory(workspaceName), ws.ticketsDir);
}

function readTitle(path: string): string {
  try {
    const content = readFileSync(path, "utf-8").split("\n");
    for (const line of content) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Strip leading "# " from markdown heading
      return trimmed.replace(/^#+\s+/, "");
    }
    return "(empty)";
  } catch {
    return "(unreadable)";
  }
}

export function listTickets(workspaceName: string): TicketSummary[] {
  const dir = ticketsDir(workspaceName);
  if (!existsSync(dir)) return [];

  const out: TicketSummary[] = [];

  const collect = (folder: string, state: "active" | "archive") => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder)) {
      if (!entry.endsWith(".md")) continue;
      const full = join(folder, entry);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      out.push({
        id: entry.replace(/\.md$/, ""),
        path: full,
        title: readTitle(full),
        state,
      });
    }
  };

  collect(dir, "active");
  collect(join(dir, "_archive"), "archive");
  return out;
}

export function findTicket(workspaceName: string, id: string): TicketSummary | null {
  const all = listTickets(workspaceName);
  return all.find((t) => t.id === id) ?? null;
}

function defaultTemplate(id: string, title: string): string {
  return [
    `# ${title}`,
    "",
    `**ID**: ${id}`,
    "",
    "## Goal",
    "<one-liner of what this ticket achieves>",
    "",
    "## Repos affected",
    "- ",
    "",
    "## Scope",
    "- ",
    "",
    "## Notes",
    "- ",
    "",
    "## Links",
    "- ",
    "",
  ].join("\n");
}

export function archiveTicket(workspaceName: string, id: string): TicketSummary {
  const summary = findTicket(workspaceName, id);
  if (!summary) throw new TicketError(`Ticket '${id}' not found in workspace '${workspaceName}'`);
  if (summary.state === "archive") return summary;
  const dir = ticketsDir(workspaceName);
  const archiveDir = join(dir, "_archive");
  mkdirSync(archiveDir, { recursive: true });
  const dest = join(archiveDir, `${id}.md`);
  renameSync(summary.path, dest);
  return { id, path: dest, title: summary.title, state: "archive" };
}

export function deleteTicket(workspaceName: string, id: string): void {
  const summary = findTicket(workspaceName, id);
  if (!summary) throw new TicketError(`Ticket '${id}' not found in workspace '${workspaceName}'`);
  rmSync(summary.path, { force: true });
}

export function createTicket(workspaceName: string, id: string, title?: string): TicketSummary {
  if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(id)) {
    throw new TicketError(`Invalid ticket id '${id}'. Use letters, digits, hyphens, underscores.`);
  }
  const dir = ticketsDir(workspaceName);
  if (!existsSync(dir)) throw new TicketError(`Tickets directory does not exist: ${dir}`);

  const path = join(dir, `${id}.md`);
  if (existsSync(path)) throw new TicketError(`Ticket '${id}' already exists at ${path}`);

  const finalTitle = title?.trim() || id;
  writeFileAtomic(path, defaultTemplate(id, finalTitle));
  return {
    id,
    path,
    title: finalTitle,
    state: "active",
  };
}

/**
 * Resolve a repo's session-state file (`progress/current.md` by default),
 * honoring `progress.dir` / `progress.currentFile` from the repo's
 * navori.config.json. Falls back to the defaults when the config is missing,
 * unreadable or invalid — the scan must never throw for a broken repo.
 */
function currentProgressPath(repoRoot: string): string {
  const fallback = join(repoRoot, "progress", "current.md");
  const configPath = join(repoRoot, "navori.config.json");
  if (!existsSync(configPath)) return fallback;
  try {
    const parsed = NavoriConfigSchema.safeParse(
      JSON.parse(readFileSync(configPath, "utf-8")),
    );
    if (!parsed.success) return fallback;
    const dir = parsed.data.progress?.dir ?? "progress";
    const file = parsed.data.progress?.currentFile ?? "current.md";
    return join(repoRoot, dir, file);
  } catch {
    return fallback;
  }
}

/**
 * Scan a list of repos for session-state files (`progress/current.md`, or the
 * path configured in each repo's navori.config.json) that reference a given
 * ticket id (via "workspace://<ws>/tickets/<id>" or "ticket: <id>" line).
 */
export function findReferencingRepos(
  repoPaths: string[],
  ticketId: string,
): Array<{ path: string; matches: string[] }> {
  const result: Array<{ path: string; matches: string[] }> = [];
  const idPattern = new RegExp(`\\b${ticketId}\\b`);

  for (const repoPath of repoPaths) {
    const abs = resolve(repoPath);
    const current = currentProgressPath(abs);
    if (!existsSync(current)) continue;
    try {
      const content = readFileSync(current, "utf-8");
      const matches: string[] = [];
      for (const line of content.split("\n")) {
        if (idPattern.test(line)) matches.push(line.trim());
      }
      if (matches.length > 0) {
        result.push({ path: abs, matches });
      }
    } catch {
      // ignore
    }
  }
  return result;
}
