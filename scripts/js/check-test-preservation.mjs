import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0054 R7-R9 — a rewritten test file must not lose coverage.
 *
 * Compares the working tree with `git merge-base HEAD <baseRef>` for the files in
 * `test-preservation.config.json`: case count (a removal must be named in
 * `removedCases`), the set of `// Covers:` tokens, and, for the doctrine merge,
 * the literal baseline. Static analysis only: it never runs the suite. The
 * per-file mutation smoke lives with each rewrite's own tests (M3b), not here.
 *
 * Usage: node scripts/js/check-test-preservation.mjs [--config <path>]
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

/** @param {string} baseRef @param {string} path @param {string} mergeBase */
function readBase(mergeBase, path) {
  return execFileSync("git", ["show", `${mergeBase}:${path}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {string[]} argv */
function main(argv) {
  const at = argv.indexOf("--config");
  const config = JSON.parse(
    readFileSync(
      resolve(
        at === -1 ? resolve(REPO_ROOT, "scripts/js/test-preservation.config.json") : argv[at + 1],
      ),
      "utf8",
    ),
  );
  let mergeBase;
  try {
    mergeBase = execFileSync("git", ["merge-base", "HEAD", config.baseRef], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    process.stderr.write(
      `check-test-preservation: no merge-base with ${config.baseRef}: ${error.message}\n`,
    );
    return 1;
  }
  const read = (path) =>
    existsSync(resolve(REPO_ROOT, path)) ? readFileSync(resolve(REPO_ROOT, path), "utf8") : null;
  const violations = [];
  for (const file of config.files) {
    const nowText = read(file.path);
    if (nowText === null) {
      violations.push(`${file.path}: file is gone`);
      continue;
    }
    violations.push(
      ...compareFile({
        label: file.path,
        baseTexts: [readBase(mergeBase, file.path)],
        nowText,
        removedCases: file.removedCases,
      }),
    );
  }
  for (const merge of config.merges) {
    const nowText = read(merge.into);
    if (nowText === null) {
      violations.push(`${merge.into}: file is gone`);
      continue;
    }
    violations.push(
      ...compareFile({
        label: merge.into,
        baseTexts: merge.from.map((path) => readBase(mergeBase, path)),
        nowText,
        rowIds: merge.countRowIds,
      }),
    );
    const literalText = read(merge.literalBaseline.path);
    if (literalText === null) {
      violations.push(`${merge.literalBaseline.path}: baseline is gone`);
    } else {
      violations.push(
        ...compareLiteralBaseline({
          baseline: JSON.parse(literalText),
          expected: merge.literalBaseline,
          nowText,
        }),
      );
    }
  }
  if (violations.length > 0) {
    process.stderr.write(
      `check-test-preservation: FAILED\n${violations.map((v) => `  - ${v}`).join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `check-test-preservation: ${config.files.length} files and ${config.merges.length} merge preserved vs ${mergeBase.slice(0, 8)}\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
