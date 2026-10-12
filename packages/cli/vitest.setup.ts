import { afterAll, afterEach, beforeEach, inject } from "vitest";
import { createTempFile } from "./vitest.tempLifecycle.ts";
import { describeNavoriHomeLeak, snapshotNavoriHome } from "./vitest.homeGuard.ts";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";

declare module "vitest" {
  export interface ProvidedContext {
    navoriTempRunRoot: string;
  }
}

// #1272 — execFileSync/execSync inherit the parent's stderr by default, so every
// `git push` / `git clone` a fixture runs leaks "To /var/folders/…" lines into the
// runner log. Pipe it unless the caller chose a stdio: a failing call still throws
// an error carrying `stderr`, so the evidence is not lost.
const childProcess = createRequire(import.meta.url)("node:child_process") as Record<
  string,
  (...args: unknown[]) => unknown
>;
for (const name of ["execFileSync", "execSync"] as const) {
  const original = childProcess[name];
  if (original === undefined) continue;
  childProcess[name] = (...args: unknown[]): unknown => {
    const last = args[args.length - 1];
    const hasOptions = typeof last === "object" && last !== null && !Array.isArray(last);
    const options = hasOptions ? (last as Record<string, unknown>) : {};
    const patched = options.stdio === undefined ? { ...options, stdio: "pipe" } : options;
    return original(...(hasOptions ? args.slice(0, -1) : args), patched);
  };
}
syncBuiltinESMExports();

// #1272 — in-process CLI code writes to process.stdout/stderr directly (clack UI,
// zod issue dumps, "test temporaries retained"), which `silent` cannot see. Hold
// each test's raw writes and release them only if that test failed.
type Write = typeof process.stdout.write;
let held: Array<{ stream: NodeJS.WriteStream; chunk: Parameters<Write>[0] }> | null = null;
for (const stream of [process.stdout, process.stderr]) {
  const write: Write = stream.write.bind(stream);
  stream.write = ((chunk: Parameters<Write>[0], ...rest: unknown[]): boolean => {
    if (held === null) return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    held.push({ stream, chunk });
    const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
    done?.();
    return true;
  }) as Write;
}
beforeEach(() => {
  held = [];
});
afterEach((ctx) => {
  const pending = held ?? [];
  held = null;
  if (ctx.task.result?.state === "fail") for (const { stream, chunk } of pending) stream.write(chunk);
});

// setupFiles executes before spec imports, on every watch rerun.
const file = createTempFile(inject("navoriTempRunRoot"));
const watchedHome = join(file.home, ".navori");
const before = snapshotNavoriHome(watchedHome);
const selfRepo = basename(resolve(fileURLToPath(new URL("../..", import.meta.url))));

/** Check isolated HOME after direct children close, before disposing file fixtures. */
// Budget for disposing the file's temp root; fixture-heavy tests should clean up after themselves.
const cleanupTimeout = 30_000;
afterAll(async () => {
  let leak: string | null = null;
  await file.dispose(() => {
    leak = describeNavoriHomeLeak(watchedHome, before, snapshotNavoriHome(watchedHome), selfRepo);
    if (leak) {
      process.stderr.write(
        `\n✖ ~/.navori isolation guard (#404/#424)\n${leak}\n  The file's home is kept for inspection: ${file.home}\n\n`,
      );
      return "HOME isolation evidence";
    }
    return undefined;
  });
  // A worker's exitCode does not propagate to the Vitest coordinator.
  if (leak) throw new Error(`HOME isolation guard failed; evidence retained at ${file.home}`);
}, cleanupTimeout);
