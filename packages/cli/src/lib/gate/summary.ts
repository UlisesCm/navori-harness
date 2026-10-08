/**
 * Pure heuristics that turn a quality-gate log into a compact verdict. The exit
 * code is the verdict; these summaries only help a reader skip the log, so a
 * miss never hides a failure.
 */

import { stripVTControlCharacters } from "node:util";

const MAX_LINE = 300;
const GREEN_CAP = 2048;
const RED_CAP = 4096;
const TAIL_GREEN = 3;
const TAIL_RED = 15;
const EXCERPT_BUDGET = 2400;
const CONTEXT = 2;

// Runner totals: vitest/jest, pytest, cargo, go, coverage tables.
const TOTALS =
  /^\s*(?:Test Files\s|Test Suites:|Tests?:|Tests\s+\d|Snapshots:|=+ .*\b(?:passed|failed|error|skipped)\b.* in [\d.]+s|\d+ (?:passed|failed)\b.* in [\d.]+s|test result:|ok\s+\S+|All files\b|TOTAL\b|Statements\s*:|Branches\s*:|Functions\s*:|Lines\s*:)/;
const CARGO_RESULT = /^\s*test result:/;
const GO_OK = /^ok\s+\S+/;
// Failure markers. `N failed` only counts when N > 0 so "0 failed" stays green.
const FAILURE =
  /\bFAIL(?:ED)?\b|--- FAIL|✗|×|\bError\b|\berror(?:\[|:)|\bpanicked\b|AssertionError|\b[1-9]\d* failed\b/;

/** Strips ANSI escapes and clips overlong lines. */
export function cleanLines(log: string): string[] {
  return stripVTControlCharacters(log)
    .split(/\r?\n/)
    .map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line.trimEnd()));
}

/**
 * Keeps head and tail of `text` within `maxBytes` (UTF-8), cutting the middle
 * so both the start and the end of the evidence survive.
 */
export function truncateMiddle(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = "\n… [truncated] …\n";
  let keep = Math.max(0, maxBytes - Buffer.byteLength(marker));
  for (;;) {
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    const out = `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
    if (Buffer.byteLength(out) <= maxBytes || keep === 0) return out;
    keep = Math.floor(keep * 0.9);
  }
}

function lastNonEmpty(lines: string[], count: number): string[] {
  return lines.filter((l) => l.trim() !== "").slice(-count);
}

/** Totals lines from a log, with per-package/per-crate repetition collapsed. */
export function totalsLines(lines: string[]): string[] {
  const out: string[] = [];
  const cargo = lines.filter((l) => CARGO_RESULT.test(l));
  const goOk = lines.filter((l) => GO_OK.test(l));
  for (const line of lines) {
    if (!TOTALS.test(line) || CARGO_RESULT.test(line) || GO_OK.test(line)) continue;
    if (!out.includes(line)) out.push(line);
  }
  if (cargo.length > 0) {
    out.push(cargo[cargo.length - 1]!);
    if (cargo.length > 1) out.push(`(${cargo.length} "test result" lines; last shown)`);
  }
  if (goOk.length > 0) out.push(`go: ${goOk.length} package(s) ok`);
  return out.slice(-10);
}

/** Green body: totals lines + last 3 non-empty lines, middle-truncated to fit. */
export function summarizeGreen(log: string, budget = GREEN_CAP): string {
  const lines = cleanLines(log);
  const body = [...totalsLines(lines)];
  for (const line of lastNonEmpty(lines, TAIL_GREEN)) if (!body.includes(line)) body.push(line);
  return truncateMiddle(body.join("\n"), budget);
}

/** Failure excerpt (matches + context) from `lines`, merged into ranges. */
export function failureExcerpt(lines: string[]): string {
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!FAILURE.test(line)) return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++)
      keep.add(j);
  });
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1 && out.length > 0) out.push("…");
    if (lines[i]!.trim() !== "") out.push(lines[i]!);
    prev = i;
  }
  return out.join("\n");
}

/** Red body: failure excerpt from before the tail + short tail, middle-truncated. */
export function summarizeRed(log: string, budget = RED_CAP): string {
  const lines = cleanLines(log);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const tailStart = Math.max(0, lines.length - TAIL_RED);
  const excerpt = truncateMiddle(failureExcerpt(lines.slice(0, tailStart)), EXCERPT_BUDGET);
  const tail = lines.slice(tailStart).join("\n");
  const body = excerpt ? `${excerpt}\n--- tail ---\n${tail}` : tail;
  return truncateMiddle(body, budget);
}

/** First stdout line of `navori gate`, always exactly this shape. */
export function sentinelLine(kind: string, exitCode: number, logPath: string): string {
  return `navori gate ${kind}: exit ${exitCode} — log ${logPath}`;
}

/** Full stdout: sentinel + green/red body, total capped at 2 KB / 4 KB. */
export function renderVerdict(
  kind: string,
  exitCode: number,
  logPath: string,
  log: string,
): string {
  const sentinel = sentinelLine(kind, exitCode, logPath);
  const cap = exitCode === 0 ? GREEN_CAP : RED_CAP;
  const budget = cap - Buffer.byteLength(sentinel) - 1;
  const body = exitCode === 0 ? summarizeGreen(log, budget) : summarizeRed(log, budget);
  return body ? `${sentinel}\n${body}` : sentinel;
}
