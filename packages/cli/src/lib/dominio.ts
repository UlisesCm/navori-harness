/**
 * Dominio — the workspace's curated knowledge base (spec 0011).
 *
 * Durable, cross-repo canonical facts (data model, business rules, migrations,
 * gotchas, glossary) live as plain markdown under
 * `~/.navori/workspaces/<name>/dominio/`: one file per entry (`<id>.md`) plus a
 * derived index (`DOMINIO.md`). The index is a CACHE reconstructible from the
 * entries — entries are the source of truth (§5.4), so concurrent writers touch
 * distinct files and the index is regenerated with `reindex`.
 *
 * The generated artifact (`DOMINIO.md`) and the `validateDominio` findings are
 * localized off the workspace language so an es/en workspace gets a consistent
 * index and warnings (#245); callers pass the resolved `Lang` (default es).
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { workspaceDirectory, listWorkspaces, loadWorkspace, canonicalPath } from "./workspace.ts";
import { splitFrontmatter, parseFrontmatterFields, getFrontmatterField } from "./frontmatter.ts";
import { NavoriError } from "./errors.ts";
import { tc, DEFAULT_LANG, type Lang } from "./i18n.ts";

const DOMINIO_DIRNAME = "dominio";
const INDEX_NAME = "DOMINIO.md";
const SUMMARY_MAX = 140;

export const DOMINIO_TYPES = [
  "architecture",
  "business-rule",
  "migration",
  "gotcha",
  "glossary",
] as const;
export type DominioType = (typeof DOMINIO_TYPES)[number];

export const DOMINIO_STATUSES = ["canonical", "deprecated", "superseded"] as const;
export type DominioStatus = (typeof DOMINIO_STATUSES)[number];

export class DominioError extends NavoriError {
  constructor(message: string) {
    super("dominio-error", message);
  }
}

export interface DominioEntry {
  /** = filename slug, the reconciliation key. Source of truth is the file. */
  id: string;
  title: string;
  type: DominioType;
  /** Repos the fact applies to, or "all". */
  appliesTo: string[] | "all";
  status: DominioStatus;
  /** Ids this entry replaces (history chain). */
  supersedes: string[];
  updated?: string;
  updatedBy?: string;
  /** First non-empty body line, for the index/injection. */
  summary: string;
  /** Absolute path of the `<id>.md` file. */
  path: string;
}

/** A validation finding from `validateDominio` — all warnings (never break a build). */
export interface DominioFinding {
  id: string;
  message: string;
}

export function dominioDir(workspaceName: string): string {
  return join(workspaceDirectory(workspaceName), DOMINIO_DIRNAME);
}

export function dominioIndexPath(workspaceName: string): string {
  return join(dominioDir(workspaceName), INDEX_NAME);
}

function coerceType(raw: string | undefined): DominioType {
  return (DOMINIO_TYPES as readonly string[]).includes(raw ?? "") ? (raw as DominioType) : "gotcha";
}

function coerceStatus(raw: string | undefined): DominioStatus {
  return (DOMINIO_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as DominioStatus)
    : "canonical";
}

/** Parse a frontmatter list value: `[a, b, c]`, `a, b`, or empty. */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseAppliesTo(raw: string | undefined): string[] | "all" {
  if (
    raw &&
    raw
      .trim()
      .replace(/^\[|\]$/g, "")
      .trim()
      .toLowerCase() === "all"
  )
    return "all";
  return parseList(raw);
}

function firstBodyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip leading markdown noise (heading, list marker, bold fences).
    const clean = trimmed
      .replace(/^#+\s+/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/\*\*/g, "");
    if (!clean) continue;
    return clean.length > SUMMARY_MAX ? clean.slice(0, SUMMARY_MAX - 1) + "…" : clean;
  }
  return "";
}

/**
 * Read one entry file, tolerant: a malformed entry never throws (a broken store
 * must not crash injection or listing). Unknown enum values fall back; missing
 * fields get sane defaults. Use `validateDominio` to surface the problems.
 */
export function readEntry(path: string): DominioEntry {
  const id = basenameId(path);
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return blankEntry(id, path);
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  // getFrontmatterField (not parseFrontmatterFields) because it escapes the key
  // and thus reads hyphenated keys like `applies-to`, which the bulk parser's
  // `[a-zA-Z0-9_]` key regex silently drops.
  const field = (key: string): string | undefined =>
    getFrontmatterField(frontmatter, key) ?? undefined;
  const title = field("title");
  const updated = field("updated");
  const updatedBy = field("updated_by");
  return {
    id,
    title: title?.trim() || id,
    type: coerceType(field("type")),
    appliesTo: parseAppliesTo(field("applies-to")),
    status: coerceStatus(field("status")),
    supersedes: parseList(field("supersedes")),
    ...(updated ? { updated } : {}),
    ...(updatedBy ? { updatedBy } : {}),
    summary: firstBodyLine(body),
    path,
  };
}

function basenameId(path: string): string {
  const base = path.split(sep).pop() ?? path;
  return base.replace(/\.md$/i, "");
}

function blankEntry(id: string, path: string): DominioEntry {
  return {
    id,
    title: id,
    type: "gotcha",
    appliesTo: [],
    status: "canonical",
    supersedes: [],
    summary: "",
    path,
  };
}

/** All entries in a workspace's Dominio (excludes the generated index). */
export function listEntries(workspaceName: string): DominioEntry[] {
  const dir = dominioDir(workspaceName);
  if (!existsSync(dir)) return [];
  const out: DominioEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === INDEX_NAME) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(readEntry(full));
  }
  // Canonical first, then deprecated, then superseded; stable by title within.
  const rank: Record<DominioStatus, number> = { canonical: 0, deprecated: 1, superseded: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
}

export function findEntry(workspaceName: string, id: string): DominioEntry | null {
  return listEntries(workspaceName).find((e) => e.id === id) ?? null;
}

function statusSuffix(entry: DominioEntry): string {
  if (entry.status === "deprecated") return " _(deprecated)_";
  if (entry.status === "superseded") {
    const to = entry.supersedes[0];
    return to ? ` _(superseded → ${to})_` : " _(superseded)_";
  }
  return "";
}

/** Build the derived index markdown (`DOMINIO.md`) from the entries. */
export function buildIndex(
  workspaceName: string,
  entries: DominioEntry[],
  lang: Lang = DEFAULT_LANG,
): string {
  const d = tc(lang).dominio;
  const lines = [d.indexTitle(workspaceName), "", d.indexGenerated, ""];
  if (entries.length === 0) {
    lines.push(d.indexEmpty);
  } else {
    for (const e of entries) {
      const summary = e.summary ? ` — ${e.summary}` : "";
      lines.push(`- [${e.title}](${e.id}.md)${summary}${statusSuffix(e)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Ensure the Dominio dir + an index file exist for a workspace. */
export function ensureDominio(
  workspaceName: string,
  lang: Lang = DEFAULT_LANG,
): {
  dir: string;
  indexPath: string;
  created: boolean;
} {
  if (!loadWorkspace(workspaceName)) {
    throw new DominioError(`Workspace '${workspaceName}' not found`);
  }
  const dir = dominioDir(workspaceName);
  const indexPath = dominioIndexPath(workspaceName);
  const created = !existsSync(indexPath);
  mkdirSync(dir, { recursive: true });
  if (created) {
    writeFileAtomic(indexPath, buildIndex(workspaceName, listEntries(workspaceName), lang));
  }
  return { dir, indexPath, created };
}

/** Rebuild the index from the entries. Returns the entry count and index path. */
export function reindex(
  workspaceName: string,
  lang: Lang = DEFAULT_LANG,
): { count: number; indexPath: string } {
  if (!loadWorkspace(workspaceName)) {
    throw new DominioError(`Workspace '${workspaceName}' not found`);
  }
  const entries = listEntries(workspaceName);
  const dir = dominioDir(workspaceName);
  mkdirSync(dir, { recursive: true });
  const indexPath = dominioIndexPath(workspaceName);
  writeFileAtomic(indexPath, buildIndex(workspaceName, entries, lang));
  return { count: entries.length, indexPath };
}

/**
 * Workspaces whose registered repos contain `cwd` (equal or ancestor). Machine-
 * local resolution: walks the registry, matching canonicalized paths. A repo can
 * belong to more than one workspace, so this returns all matches.
 */
export function resolveWorkspacesForCwd(cwd: string): string[] {
  const target = canonicalPath(cwd);
  const out: string[] = [];
  for (const name of listWorkspaces()) {
    let ws;
    try {
      ws = loadWorkspace(name);
    } catch {
      continue;
    }
    if (!ws) continue;
    for (const repo of ws.repos) {
      const repoPath = canonicalPath(repo.path);
      if (target === repoPath || target.startsWith(repoPath + sep)) {
        out.push(name);
        break;
      }
    }
  }
  return out;
}

/**
 * Validate a workspace's Dominio. All findings are warnings (spec §9): a broken
 * or empty Dominio must never break a render. Checks: unknown enum values,
 * duplicate ids, dangling `supersedes` targets, index staleness, and a
 * `canonical` entry that a `superseded` one still claims to replace.
 */
export function validateDominio(
  workspaceName: string,
  lang: Lang = DEFAULT_LANG,
): DominioFinding[] {
  const d = tc(lang).dominio;
  const findings: DominioFinding[] = [];
  const dir = dominioDir(workspaceName);
  if (!existsSync(dir)) return findings;

  const entries = listEntries(workspaceName);
  const ids = new Set(entries.map((e) => e.id));

  for (const e of entries) {
    // Re-read raw enum to catch unknown values coerced away by readEntry.
    const fm = parseFrontmatterFields(splitFrontmatter(safeRead(e.path)).frontmatter);
    if (fm.type && !(DOMINIO_TYPES as readonly string[]).includes(fm.type)) {
      findings.push({ id: e.id, message: d.findingUnknownType(fm.type) });
    }
    if (fm.status && !(DOMINIO_STATUSES as readonly string[]).includes(fm.status)) {
      findings.push({ id: e.id, message: d.findingUnknownStatus(fm.status) });
    }
    if (!fm.title) {
      findings.push({ id: e.id, message: d.findingMissingTitle });
    }
    for (const target of e.supersedes) {
      if (!ids.has(target)) {
        findings.push({ id: e.id, message: d.findingSupersedesUnknown(target) });
      }
    }
    if (e.status === "superseded" && e.supersedes.length === 0) {
      findings.push({ id: e.id, message: d.findingSupersededNoTarget });
    }
  }

  // Index staleness: the on-disk index must equal reindex(entries). Compare
  // against the same locale the index is written in so a language switch is the
  // only thing that flips staleness, not a hardcoded catalog mismatch.
  const indexPath = dominioIndexPath(workspaceName);
  const expected = buildIndex(workspaceName, entries, lang);
  if (!existsSync(indexPath)) {
    findings.push({ id: INDEX_NAME, message: d.findingIndexMissing });
  } else if (safeRead(indexPath) !== expected) {
    findings.push({ id: INDEX_NAME, message: d.findingIndexStale });
  }

  return findings;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Slugify a title into a kebab-case id (for a future `dominio add`). */
export function toSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "entry";
}
