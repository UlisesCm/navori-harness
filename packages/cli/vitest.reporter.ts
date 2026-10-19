import { stripVTControlCharacters } from "node:util";
import type { Reporter, TestCase, TestModule, TestRunEndReason } from "vitest/node";
import { truncateMiddle } from "./src/lib/gate/summary.ts";

/** Failed case names listed before collapsing into `… <k> more failed`. */
export const MAX_NAMES = 50;
/** Failed cases that also get assertion/diff/console detail. */
export const MAX_DETAILS = 10;
/** Byte cap of one case's whole detail (location + errors + console), trimmed in the middle: head and tail survive. */
export const DETAIL_BYTES = 1024;
/** Byte cap of the module/global errors section. Always shown, never dropped. */
export const ERRORS_BYTES = 2048;

interface ErrorLike {
  message: string;
  name?: string;
  stack?: string;
  stacks?: ReadonlyArray<{ file: string; line: number }>;
  diff?: string;
}

const clean = (text: string): string => stripVTControlCharacters(text).trimEnd();

function formatError(error: ErrorLike): string {
  const head = `${error.name ?? "Error"}: ${error.message}`;
  const body = error.diff ? `${head}\n${error.diff}` : head;
  return clean(body);
}

/** Collection, lifecycle-hook (`afterAll`, setup guards) and unhandled errors, tagged by origin. */
function collectErrors(
  modules: ReadonlyArray<TestModule>,
  unhandled: ReadonlyArray<ErrorLike>,
): string[] {
  const out: string[] = [];
  for (const mod of modules) {
    for (const error of mod.errors()) out.push(`${mod.relativeModuleId}: ${formatError(error)}`);
    for (const suite of mod.children.allSuites())
      for (const error of suite.errors()) out.push(`${suite.fullName}: ${formatError(error)}`);
  }
  for (const error of unhandled) out.push(`unhandled: ${formatError(error)}`);
  return out;
}

/** `file:line` of the first stack frame inside the test's own file, if any. */
function locate(test: TestCase, errors: ReadonlyArray<ErrorLike>): string | undefined {
  for (const error of errors) {
    const frame = error.stacks?.find((f) => f.file.endsWith(test.module.relativeModuleId));
    if (frame) return `${test.module.relativeModuleId}:${frame.line}`;
  }
  return undefined;
}

function caseDetail(test: TestCase): string {
  const result = test.result();
  const errors = result.state === "failed" ? result.errors : [];
  const at = locate(test, errors);
  const parts = [...(at ? [`at ${at}`] : []), ...errors.map(formatError)];
  const logs = test.logs().map((log) => clean(log.content));
  if (logs.length > 0) parts.push(`console:\n${logs.join("\n")}`);
  return truncateMiddle(parts.join("\n"), DETAIL_BYTES);
}

/**
 * Renders the compact summary of a finished run. Green is one line; red is the
 * totals line, errors outside any case, every failed case name (capped) and the
 * first few details. A run that did not pass (bail, interrupt) or left tests
 * unfinished is red even with no failed case. Pure so the contract is testable
 * without a Vitest run.
 */
export function renderCompact(
  modules: ReadonlyArray<TestModule>,
  unhandled: ReadonlyArray<ErrorLike>,
  seconds: number,
  reason: TestRunEndReason = "passed",
): string {
  let passed = 0;
  let skipped = 0;
  let pending = 0;
  const failed: TestCase[] = [];
  for (const mod of modules) {
    for (const test of mod.children.allTests()) {
      const state = test.result().state;
      if (state === "passed") passed++;
      else if (state === "skipped") skipped++;
      else if (state === "failed") failed.push(test);
      else pending++;
    }
  }
  const errors = collectErrors(modules, unhandled);
  const time = `${seconds.toFixed(1)}s`;
  const notRun = pending > 0 ? `, ${pending} not finished` : "";
  const counts = `${passed} passed, ${skipped} skipped${notRun} (${modules.length} files) in ${time}`;
  const incomplete = reason !== "passed" || pending > 0;
  if (failed.length === 0 && errors.length === 0 && !incomplete) return `Tests: ${counts}\n`;

  const head =
    failed.length === 0 && incomplete
      ? `Tests: INTERRUPTED (${reason}) — ${counts}`
      : `Tests: ${failed.length} failed, ${counts}`;
  const lines = [head];
  if (errors.length > 0) {
    lines.push(`Errors (${errors.length}):`, truncateMiddle(errors.join("\n"), ERRORS_BYTES));
  }
  for (const test of failed.slice(0, MAX_NAMES))
    lines.push(`FAIL ${test.module.relativeModuleId} > ${test.fullName}`);
  if (failed.length > MAX_NAMES) lines.push(`… ${failed.length - MAX_NAMES} more failed`);
  for (const test of failed.slice(0, MAX_DETAILS)) {
    lines.push(`--- ${test.module.relativeModuleId} > ${test.fullName}`, caseDetail(test));
  }
  if (failed.length > MAX_DETAILS)
    lines.push(`… details shown for ${MAX_DETAILS} of ${failed.length}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `compact` reporter (spec 0055 D14): one totals line when green, bounded
 * failure evidence when red. Selected by vitest.config.ts when stdout is not a TTY.
 */
export default class CompactReporter implements Reporter {
  private startedAt = performance.now();

  /** Records the start of this run, including watch-mode reruns. */
  onTestRunStart(): void {
    this.startedAt = performance.now();
  }

  /** Writes the completed run's compact totals and bounded failure evidence. */
  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandled: ReadonlyArray<ErrorLike>,
    reason: TestRunEndReason,
  ): void {
    process.stdout.write(
      renderCompact(modules, unhandled, (performance.now() - this.startedAt) / 1000, reason),
    );
  }
}
