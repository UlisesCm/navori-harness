import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import { commitWrites } from "./execute-plan.ts";
import { engineOutputPaths } from "./gitignore-harness.ts";
import { tc, type Lang } from "../../lib/i18n.ts";
import { injectManagedSection, removeManagedSection, type MarkerMeta } from "../../lib/marker.ts";
import type { RenderStatus } from "../../lib/style.ts";

/**
 * Prevention for #523: a formatter can freeze the whole harness.
 *
 * `prettier --write .` reformats Markdown it is not told to skip — `*forms*`
 * becomes `_forms_`, blank lines move — which changes nothing semantically but
 * invalidates the `hash` of EVERY managed block in `CLAUDE.md`. navori then
 * marks them `user-modified-skipped` and stops updating them: the harness sits
 * frozen at whatever version it was on, and only a human can unfreeze it. In
 * `navori-dashboard-template` one `pnpm format` did exactly that to 17 of 19
 * blocks. The two sibling repos escaped only because their `format` script
 * happened not to cover `CLAUDE.md` — luck, not design.
 *
 * So when `init` detects prettier, it writes the harness paths into a managed
 * block in `.prettierignore`, the same way `render` maintains the harness block
 * in `.gitignore`.
 */

/** Managed-block id for the harness `.prettierignore` region. */
export const PRETTIERIGNORE_MANAGED_ID = "prettierignore-harness";

/** File name at the repo root that carries the managed block. */
const PRETTIERIGNORE_FILE = ".prettierignore";

/** `.prettierignore` uses gitignore syntax, so `#`-comments are valid lines. */
const PRETTIERIGNORE_COMMENT_STYLE = "shell" as const;

/**
 * Config files prettier loads on its own. Any of them means the repo runs
 * prettier even when the dependency lives somewhere else (a root workspace, a
 * global install, `npx prettier`).
 * See https://prettier.io/docs/configuration
 */
const PRETTIER_CONFIG_FILES: readonly string[] = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
];

/** The shape of `package.json` this module reads. Everything is optional: a
 *  malformed or partial manifest must degrade to "prettier not detected", never
 *  throw. */
interface PackageManifest {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  /** Prettier config inlined in package.json (`"prettier": { … }`). */
  prettier?: unknown;
}

/** Best-effort `package.json` read; null when absent or unparseable. */
function readPackageManifest(cwd: string): PackageManifest | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    // Strip a BOM: JSON.parse rejects it and a BOM'd manifest is common on
    // Windows-authored repos.
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
    return typeof parsed === "object" && parsed !== null ? (parsed as PackageManifest) : null;
  } catch {
    return null;
  }
}

/**
 * Does this repo run prettier? Four independent signals, mirroring how the rest
 * of navori detects tooling (dependency in `package.json` + config file on
 * disk), plus the one that actually caused #523:
 *
 * 1. `prettier` in `dependencies` / `devDependencies`.
 * 2. A prettier config file at the repo root.
 * 3. A `"prettier"` key in `package.json` (config inlined there).
 * 4. An npm script whose command invokes `prettier` — the reported repo's
 *    `"format": "prettier --write ."`. This one matters on its own: a repo can
 *    call `npx prettier` with no dependency and no config file and still eat
 *    `CLAUDE.md`.
 *
 * Never throws: a missing or malformed `package.json` degrades to `false`.
 */
export function detectPrettier(cwd: string): boolean {
  for (const file of PRETTIER_CONFIG_FILES) {
    if (existsSync(join(cwd, file))) return true;
  }
  const pkg = readPackageManifest(cwd);
  if (!pkg) return false;
  if (pkg.prettier !== undefined) return true;
  if (pkg.dependencies?.prettier !== undefined) return true;
  if (pkg.devDependencies?.prettier !== undefined) return true;
  for (const command of Object.values(pkg.scripts ?? {})) {
    // Word-bounded so `prettier-plugin-foo --check` alone doesn't count, but
    // `pnpm exec prettier --write .` does.
    if (typeof command === "string" && /(?:^|[\s/"'])prettier(?:$|[\s"'])/.test(command)) {
      return true;
    }
  }
  return false;
}

/**
 * Paths prettier must not touch: every harness output owned by the configured
 * engines (`.claude/`, `CLAUDE.md`, `.codex/`, `AGENTS.md`, …), derived from the
 * same `ENGINE_OUTPUTS` map the `.gitignore` block uses. Deriving instead of
 * hardcoding `["CLAUDE.md", "AGENTS.md"]` is what makes this cover the OTHER
 * half of the class: `.claude/agents/*.md` and `.claude/skills/**\/*.md` carry
 * managed blocks too, and a formatter freezes them exactly the same way.
 */
export function prettierIgnoreEntries(engines: readonly string[]): string[] {
  return engineOutputPaths(engines);
}

/** Outcome of reconciling the harness block in `.prettierignore`. */
export interface PrettierIgnoreResult {
  /** Repo-relative path (always `.prettierignore`). */
  path: string;
  /** Render-plan vocabulary, so callers report it like every other file. */
  status: RenderStatus;
  /** Entries this run put — or would put, under `dryRun` — inside the block.
   *  Empty when the user's own rules already cover every one of them. */
  entries: string[];
  /** Snapshot taken before overwriting, or null when nothing was destroyed
   *  (file created, preview, or no write at all). */
  backupPath?: string | null;
  /** Localized prose, set only when the block was hand-edited and preserved. */
  skippedReason?: string;
}

function coreMeta(): MarkerMeta {
  return { source: "@navori/core", version: readCliVersion() };
}

/** Normalize an ignore entry for comparison: `.claude` and `.claude/` are the
 *  same rule, and leading/trailing whitespace is not part of it. */
function normalizeEntry(line: string): string {
  return line.trim().replace(/\/+$/, "");
}

/**
 * Ignore rules the user already wrote OUTSIDE navori's managed block. Read so
 * an entry they already cover is never re-emitted: re-adding `CLAUDE.md` under
 * our marker when their file already lists it produces a duplicate rule for no
 * benefit, and "already there" is precisely the case where navori should do
 * nothing.
 */
function userOwnedEntries(existing: string): Set<string> {
  const outsideBlock = removeManagedSection(
    existing,
    PRETTIERIGNORE_MANAGED_ID,
    PRETTIERIGNORE_COMMENT_STYLE,
  );
  const owned = new Set<string>();
  for (const raw of outsideBlock.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    owned.add(normalizeEntry(line));
  }
  return owned;
}

/**
 * Write or reconcile the harness block in `.prettierignore` when — and only
 * when — the repo runs prettier.
 *
 * - Prettier not detected → returns `null` and NEVER reads, creates or modifies
 *   the file. navori does not install opinions about a tool the repo doesn't use.
 * - Every desired entry already covered by the user's own rules → returns
 *   `unchanged` with no entries, and still writes nothing.
 * - Otherwise the block is injected into the existing file (preserving every
 *   line outside it) or, when there is no `.prettierignore` at all, into a fresh
 *   one seeded with a localized header. Creating it is deliberate: without the
 *   file prettier's only built-in ignores are `node_modules` and `.git`, so
 *   `prettier --write .` reaches `CLAUDE.md` and the prevention would be a no-op
 *   exactly in the repos that need it most. It is created ONLY under a positive
 *   prettier signal, and it is an ordinary versioned file the user can edit.
 * - A hand-edited block is preserved (`user-modified-skipped`) unless `force`.
 * - The write goes through `commitWrites`, the render's single backup choke
 *   point — `.prettierignore`, like `.gitignore`, is a file navori edits but did
 *   NOT author, so a bad injection must be recoverable.
 */
export function ensurePrettierIgnore(
  cwd: string,
  config: { engines: readonly string[] },
  options: { dryRun?: boolean; force?: boolean; lang: Lang },
): PrettierIgnoreResult | null {
  if (!detectPrettier(cwd)) return null;

  const desired = prettierIgnoreEntries(config.engines);
  if (desired.length === 0) return null; // no configured engine owns anything.

  const filePath = join(cwd, PRETTIERIGNORE_FILE);
  const exists = existsSync(filePath);
  const existing = exists
    ? readFileSync(filePath, "utf-8")
    : tc(options.lang).render.prettierIgnoreHeader;

  const alreadyCovered = userOwnedEntries(existing);
  const entries = desired.filter((entry) => !alreadyCovered.has(normalizeEntry(entry)));
  if (entries.length === 0) {
    return { path: PRETTIERIGNORE_FILE, status: "unchanged", entries: [] };
  }

  const result = injectManagedSection(
    existing,
    PRETTIERIGNORE_MANAGED_ID,
    entries.join("\n"),
    coreMeta(),
    PRETTIERIGNORE_COMMENT_STYLE,
    options.force === true,
  );

  if (result.status === "user-modified-skipped" || result.status === "downgrade-skipped") {
    return {
      path: PRETTIERIGNORE_FILE,
      status: result.status,
      entries,
      skippedReason:
        result.status === "user-modified-skipped"
          ? tc(options.lang).engine.managedBlockEditedByHand
          : tc(options.lang).engine.blockFromNewerNavori(
              result.details?.existingVersion ?? undefined,
            ),
    };
  }

  if (options.dryRun !== true && (result.status === "created" || result.status === "updated")) {
    const { backupPath } = commitWrites({
      pending: [
        {
          path: filePath,
          relPath: PRETTIERIGNORE_FILE,
          content: result.output,
          status: result.status,
        },
      ],
      removals: [],
      cwd,
      lang: options.lang,
    });
    return { path: PRETTIERIGNORE_FILE, status: result.status, entries, backupPath };
  }

  return { path: PRETTIERIGNORE_FILE, status: result.status, entries };
}
