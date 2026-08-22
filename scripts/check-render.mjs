import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * #421 — harness mirror drift guard.
 *
 * This repo dogfoods navori: its `.claude/` tree and `CLAUDE.md` are the OUTPUT
 * of `navori render` over `@navori/core`. Nothing used to verify that the output
 * on disk still matched the core, so six merged PRs left the mirror a full day
 * behind — and what went stale wasn't prose, it was the rendered hook scripts,
 * which kept running WITHOUT the portability fix of #391 (#420 closed it by
 * hand, 15 files).
 *
 * `render` already answers the question: in preview mode (no `--apply`) it
 * touches nothing and `--json` reports, per file, what it WOULD write. This
 * script reads that and turns it into an exit code.
 *
 * Two drift classes, two different remedies — both are failures:
 *   - pending writes  → the mirror is behind the core; `render --apply` fixes it.
 *   - skipped files   → render REFUSES to overwrite (hand-edited managed block,
 *                       or a block written by a newer navori). `render --apply`
 *                       would NOT fix these, so they get their own message.
 *
 * Freshness is the caller's job, on purpose: `packages/cli/dist/assets/core` is
 * a build-time COPY of `packages/core/core-assets` (see copy-assets.mjs), and
 * the CLI prefers that copy over the live sources — so rendering with a stale
 * `dist/` compares against the OLD core and passes in silence. That's why the
 * entry point is `pnpm check:render`, which rebuilds first, and why CI calls
 * that script rather than this file directly.
 *
 * Usage: node scripts/check-render.mjs [--cwd <repo>]
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const CLI_REL = "packages/cli/dist/index.js";
const CLI = resolve(REPO_ROOT, CLI_REL);

function fail(message, detail) {
  console.error(`✗ ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/** Resolve the repo to check. Defaults to this monorepo; `--cwd` targets another. */
function parseTarget(argv) {
  const i = argv.indexOf("--cwd");
  if (i === -1) return { target: REPO_ROOT, explicit: false };
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) fail("--cwd needs a directory argument");
  return { target: resolve(value), explicit: true };
}

const { target, explicit } = parseTarget(process.argv.slice(2));

// A missing binary must be RED, never a silent pass: a check that can't run is
// exactly the blind spot #421 is about.
if (!existsSync(CLI)) {
  fail(`navori CLI not built at ${CLI} — run 'pnpm --filter navori build' first`);
}

const run = spawnSync(process.execPath, [CLI, "render", "--json", "--cwd", target], {
  encoding: "utf-8",
});

if (run.error) {
  fail(`could not run '${CLI_REL} render --json'`, String(run.error.message ?? run.error));
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  fail(
    `'${CLI_REL} render --json' did not emit JSON (exit ${run.status})`,
    [run.stdout, run.stderr].filter(Boolean).join("\n").trim(),
  );
}

if (report.ok !== true) {
  fail(
    `render failed: ${report.reason ?? "unknown"}`,
    [report.detail, run.stderr].filter(Boolean).join("\n").trim(),
  );
}

// Defensive: without `--apply` render must never write. If a future flag change
// flips the default, this check would be MUTATING the repo it audits.
if (report.mode !== "preview") {
  fail(`expected a preview render, got mode='${report.mode}' — refusing to trust the result`);
}

/** Every scope that carries a rendered tree: the repo root plus each workspace. */
const scopes = [
  { label: null, scope: report.root ?? {} },
  ...(report.workspaces ?? []).map((w) => ({ label: w.path ?? w.name, scope: w })),
];

const prefixed = (label, path) => (label ? `${label}/${path}` : path);
const stale = [];
const blocked = [];

for (const { label, scope } of scopes) {
  for (const file of scope.written ?? []) stale.push([file.status, prefixed(label, file.path)]);
  for (const file of scope.skipped ?? []) blocked.push([prefixed(label, file.path), file.reason]);
  for (const engine of scope.extraEngines ?? []) {
    for (const file of engine.written ?? []) stale.push([file.status, prefixed(label, file.path)]);
    for (const file of engine.skipped ?? []) blocked.push([prefixed(label, file.path), file.reason]);
  }
}
for (const engine of report.extraEngines ?? []) {
  for (const file of engine.written ?? []) stale.push([file.status, file.path]);
  for (const file of engine.skipped ?? []) blocked.push([file.path, file.reason]);
}
if (report.gitignore) {
  const status = report.gitignore.status;
  if (status === "created" || status === "updated") stale.push([status, report.gitignore.path]);
  else if (status.endsWith("-skipped")) blocked.push([report.gitignore.path, status]);
}

// The managed-block ids inside CLAUDE.md — the file itself is already listed in
// `written`, but naming the blocks says WHAT drifted inside it.
const staleBlocks = [];
for (const { label, scope } of scopes) {
  for (const entry of scope.entries ?? []) {
    if (entry.status !== "unchanged") staleBlocks.push([entry.status, prefixed(label, entry.id)]);
  }
}

if (stale.length === 0 && blocked.length === 0) {
  console.log(`✓ harness mirror up to date — 'render --json' reports 0 pending changes`);
  process.exit(0);
}

const lines = [`✗ the rendered harness mirror is OUT OF DATE (.claude/ + CLAUDE.md vs @navori/core)`];

if (stale.length > 0) {
  lines.push(``, `  stale files (${stale.length}):`);
  for (const [status, path] of stale) lines.push(`    ${status.padEnd(9)} ${path}`);
}

if (staleBlocks.length > 0) {
  lines.push(``, `  stale CLAUDE.md blocks (${staleBlocks.length}):`);
  for (const [status, id] of staleBlocks) lines.push(`    ${status.padEnd(9)} ${id}`);
}

if (stale.length > 0) {
  const cwdArg = explicit ? ` --cwd ${target}` : "";
  lines.push(
    ``,
    `  re-render the mirror from the repo root:`,
    `    pnpm --filter navori build && node ${CLI_REL} render --apply${cwdArg}`,
    ``,
    `  use the LOCAL binary: a globally installed 'navori' renders the PUBLISHED`,
    `  core, not this working tree's packages/core.`,
  );
}

if (blocked.length > 0) {
  lines.push(
    ``,
    `  files render refuses to overwrite (${blocked.length}) — 'render --apply' will NOT fix these:`,
  );
  for (const [path, reason] of blocked) lines.push(`    ${path} — ${reason}`);
}

console.error(lines.join("\n"));
process.exit(1);
