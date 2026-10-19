import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0054 R7-R9 and spec 0055 R21 — a rewritten test file must not lose coverage.
 *
 * Discovers EVERY `*.test.ts` changed or deleted against `git merge-base HEAD <base>` (default
 * `origin/dev`, then `dev`) and compares case count, the set of `// Covers:` tokens and, for a
 * merge, the literal baseline. A removal must be declared in `test-preservation.config.json`:
 * `files[].removedCases` (`{ title, reason }`, the reason is mandatory) or `merges[]` (cases moved
 * between files). Static analysis only: it never runs the suite.
 *
 * Usage: node scripts/js/check-test-preservation.mjs [--base <ref>] [--config <path>]
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASE_LINE = /^\s*(?:it|test)(?:\.[a-zA-Z]+)*\(/;
const TITLE = /^\s*(?:it|test)(?:\.[a-zA-Z]+)*\(\s*(["'`])(.+?)\1/;

/**
 * Number of cases. With `rowIds`, table rows (`id: "..."` lines) count too.
 *
 * @param {string} text
 * @param {{ rowIds?: boolean }} [options]
 * @returns {number}
 */
export function countCases(text, options = {}) {
  let total = 0;
  for (const line of text.split("\n")) {
    if (CASE_LINE.test(line) || (options.rowIds && /^\s+id: /.test(line))) total += 1;
  }
  return total;
}

/**
 * Titles of literal-titled `it`/`test` cases.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function caseTitles(text) {
  const titles = new Set();
  for (const line of text.split("\n")) {
    const match = TITLE.exec(line);
    if (match) titles.add(match[2]);
  }
  return titles;
}

/**
 * Tokens (`R<n>`, `A<n>`, `#<n>`) named by `Covers:` comments.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function coversSet(text) {
  const tokens = new Set();
  for (const line of text.split("\n")) {
    const at = line.indexOf("Covers:");
    if (at === -1) continue;
    const list = line.slice(at + "Covers:".length).split("—")[0];
    for (const token of list.match(/\b(?:R|A)\d+\b|#\d+/g) ?? []) tokens.add(token);
  }
  return tokens;
}

/**
 * Compares one rewritten file (or a merge) with its baseline text(s).
 *
 * @param {{ label: string, baseTexts: string[], nowText: string, removedCases?: string[], rowIds?: boolean }} input
 * @returns {string[]} violations, empty when preserved
 */
export function compareFile({ label, baseTexts, nowText, removedCases = [], rowIds = false }) {
  const violations = [];
  const baseCount = baseTexts.reduce((sum, text) => sum + countCases(text), 0);
  const nowCount = countCases(nowText, { rowIds });
  if (nowCount < baseCount - removedCases.length) {
    violations.push(
      `${label}: ${nowCount} cases, baseline ${baseCount} (allowed removals: ${removedCases.length})`,
    );
  }
  const nowCovers = coversSet(nowText);
  for (const token of new Set(baseTexts.flatMap((text) => [...coversSet(text)]))) {
    if (!nowCovers.has(token)) violations.push(`${label}: lost "Covers: ${token}"`);
  }
  if (removedCases.length > 0) {
    const nowTitles = caseTitles(nowText);
    const baseTitles = new Set(baseTexts.flatMap((text) => [...caseTitles(text)]));
    for (const title of baseTitles) {
      if (!nowTitles.has(title) && !removedCases.includes(title))
        violations.push(`${label}: case removed without documentation: "${title}"`);
    }
    for (const title of removedCases) {
      if (nowTitles.has(title))
        violations.push(`${label}: "${title}" is listed as removed but still exists`);
    }
  }
  return violations;
}

/**
 * Checks the doctrine literal baseline is intact and still asserted.
 *
 * @param {{ baseline: { positive?: unknown[], negative?: unknown[] }, expected: { positive: number, negative: number, equivalenceCase: string }, nowText: string }} input
 * @returns {string[]}
 */
export function compareLiteralBaseline({ baseline, expected, nowText }) {
  const violations = [];
  const positive = Array.isArray(baseline.positive) ? baseline.positive.length : 0;
  const negative = Array.isArray(baseline.negative) ? baseline.negative.length : 0;
  if (positive < expected.positive)
    violations.push(`literal baseline lost positives: ${positive} < ${expected.positive}`);
  if (negative < expected.negative)
    violations.push(`literal baseline lost negatives: ${negative} < ${expected.negative}`);
  if (!caseTitles(nowText).has(expected.equivalenceCase))
    violations.push(`equivalence case missing: "${expected.equivalenceCase}"`);
  return violations;
}

/**
 * Checks every declared removal carries a non-empty reason.
 *
 * @param {string} label
 * @param {unknown[] | undefined} entries `{ title, reason }` objects
 * @returns {string[]} violations
 */
export function removalReasonViolations(label, entries = []) {
  const violations = [];
  for (const entry of entries) {
    const title = entry && typeof entry === "object" ? entry.title : undefined;
    const reason = entry && typeof entry === "object" ? entry.reason : undefined;
    if (typeof title !== "string" || title === "")
      violations.push(`${label}: removedCases entries must be { title, reason }`);
    else if (typeof reason !== "string" || reason.trim() === "")
      violations.push(`${label}: removed case "${title}" has no reason`);
  }
  return violations;
}

/**
 * Parses `git diff --name-status --no-renames` output into changed/deleted test files.
 *
 * @param {string} output
 * @returns {{ modified: string[], deleted: string[] }}
 */
export function parseNameStatus(output) {
  const modified = [];
  const deleted = [];
  for (const line of output.split("\n")) {
    const [status, path] = line.split("\t");
    if (!path || !path.endsWith(".test.ts")) continue;
    if (status === "M") modified.push(path);
    else if (status === "D") deleted.push(path);
  }
  return { modified, deleted };
}

/**
 * Pure core: compares every changed/deleted test against its baseline.
 *
 * @param {{
 *   config: { files?: { path: string, rowIds?: boolean, removedCases?: unknown[] }[], merges?: { into: string, from: string[], reason?: string, countRowIds?: boolean, removedCases?: unknown[], literalBaseline?: { path: string, positive: number, negative: number, equivalenceCase: string } }[] },
 *   changes: { modified: string[], deleted: string[] },
 *   readBase: (path: string) => string | null,
 *   readNow: (path: string) => string | null,
 * }} input
 * @returns {string[]} violations
 */
export function checkPreservation({ config, changes, readBase, readNow }) {
  const violations = [];
  const files = config.files ?? [];
  const merges = config.merges ?? [];
  const absorbed = new Set(merges.flatMap((merge) => merge.from));
  const titlesOf = (entries = []) =>
    entries.map((entry) => (entry && typeof entry === "object" ? entry.title : entry));
  for (const file of files)
    violations.push(...removalReasonViolations(file.path, file.removedCases));
  for (const merge of merges) {
    if (typeof merge.reason !== "string" || merge.reason.trim() === "")
      violations.push(`${merge.into}: merge has no reason`);
    violations.push(...removalReasonViolations(merge.into, merge.removedCases));
  }
  const declared = (path) => files.find((file) => file.path === path);
  const handled = new Set();
  for (const merge of merges) {
    handled.add(merge.into);
    for (const path of merge.from) handled.add(path);
    const nowText = readNow(merge.into);
    if (nowText === null) {
      violations.push(`${merge.into}: file is gone`);
      continue;
    }
    const baseTexts = [];
    for (const path of [merge.into, ...merge.from]) {
      const text = readBase(path);
      // A path absent at the merge-base: the fusion already landed there, nothing to compare.
      if (text !== null) baseTexts.push(text);
    }
    if (baseTexts.length > 0)
      violations.push(
        ...compareFile({
          label: merge.into,
          baseTexts,
          nowText,
          removedCases: titlesOf(merge.removedCases),
          rowIds: merge.countRowIds,
        }),
      );
    if (merge.literalBaseline) {
      const literalText = readNow(merge.literalBaseline.path);
      if (literalText === null) violations.push(`${merge.literalBaseline.path}: baseline is gone`);
      else
        violations.push(
          ...compareLiteralBaseline({
            baseline: JSON.parse(literalText),
            expected: merge.literalBaseline,
            nowText,
          }),
        );
    }
  }
  for (const path of changes.modified) {
    if (handled.has(path)) continue;
    const base = readBase(path);
    const now = readNow(path);
    if (base === null || now === null) continue;
    const entry = declared(path);
    violations.push(
      ...compareFile({
        label: path,
        baseTexts: [base],
        nowText: now,
        removedCases: titlesOf(entry?.removedCases),
        rowIds: entry?.rowIds,
      }),
    );
  }
  for (const path of changes.deleted) {
    if (absorbed.has(path)) continue;
    const base = readBase(path);
    if (base === null) continue;
    const titles = new Set(titlesOf(declared(path)?.removedCases));
    const missing = [...caseTitles(base)].filter((title) => !titles.has(title));
    const dynamic = countCases(base) - caseTitles(base).size;
    if (missing.length > 0 || dynamic > 0)
      violations.push(
        `${path}: file deleted without removedCases for ${missing.length > 0 ? missing.map((t) => `"${t}"`).join(", ") : `${dynamic} non-literal case(s)`} (or a merges.from entry)`,
      );
  }
  return violations;
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {string[]} argv */
function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const config = JSON.parse(
    readFileSync(
      resolve(flag("--config") ?? resolve(REPO_ROOT, "scripts/js/test-preservation.config.json")),
      "utf8",
    ),
  );
  const candidates = [flag("--base") ?? config.baseRef ?? "origin/dev", "dev"];
  let mergeBase;
  let usedRef;
  for (const ref of candidates) {
    try {
      mergeBase = git(["merge-base", "HEAD", ref]).trim();
      usedRef = ref;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (mergeBase === undefined) {
    process.stderr.write(
      `check-test-preservation: no merge-base with ${candidates.join(" or ")}\n`,
    );
    return 1;
  }
  const changes = parseNameStatus(
    git(["diff", "--name-status", "--no-renames", mergeBase, "--", "*.test.ts"]),
  );
  const readBase = (path) => {
    try {
      return git(["show", `${mergeBase}:${path}`]);
    } catch {
      return null;
    }
  };
  const readNow = (path) =>
    existsSync(resolve(REPO_ROOT, path)) ? readFileSync(resolve(REPO_ROOT, path), "utf8") : null;
  const violations = checkPreservation({ config, changes, readBase, readNow });
  if (violations.length > 0) {
    process.stderr.write(
      `check-test-preservation: FAILED\n${violations.map((v) => `  - ${v}`).join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `check-test-preservation: ${changes.modified.length} changed and ${changes.deleted.length} deleted test files preserved vs ${usedRef} ${mergeBase.slice(0, 8)}\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
