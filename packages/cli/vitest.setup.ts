import { afterAll, afterEach, beforeEach, expect, inject } from "vitest";
import { createTempFile } from "./vitest.tempLifecycle.ts";
import { describeNavoriHomeLeak, snapshotNavoriHome } from "./vitest.homeGuard.ts";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

declare module "vitest" {
  export interface ProvidedContext {
    navoriTempRunRoot: string;
  }
}

// #1272 — execFileSync/execSync inherit the parent's stderr by default, so every
// `git push` / `git clone` a fixture runs leaks "To /var/folders/…" lines into the
// runner log. Pipe it unless the caller chose a stdio: a failing call still throws
// an error carrying `stderr`, so the evidence is not lost.
//
// Spec 0055 R1 — the same wrapper counts the child processes this file launches
// (`spawn`, `spawnSync`, `exec`, `execFile`, `execFileSync`, `execSync`, `fork`), so
// `bench:tests` can report them per file. Only DIRECT children of the worker are seen;
// grandchildren (a hook's `jq`) are not observable portably from Node.
const childProcess = createRequire(import.meta.url)("node:child_process") as Record<
  string,
  ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown }
>;
let spawns = 0;
// `exec` calls `module.exports.execFile` (the patched one) synchronously: count that child once.
let insideWrapped = false;
const counted = <T>(run: () => T): T => {
  const nested = insideWrapped;
  if (!nested) spawns += 1;
  insideWrapped = true;
  try {
    return run();
  } finally {
    insideWrapped = nested;
  }
};
// Spec 0055 R13 — with NAVORI_HOOK_CORPUS, direct hook spawns (singles that bypass the hook
// helpers) are recorded too. Loaded lazily: the hook-asset modules cost a little per test file.
const corpus =
  process.env.NAVORI_HOOK_CORPUS === undefined || process.env.NAVORI_HOOK_CORPUS === ""
    ? undefined
    : await import("./src/__tests__/helpers/hook-corpus.ts");
const PIPED_STDERR = new Set(["execFileSync", "execSync"]);
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
] as const) {
  const original = childProcess[name];
  if (original === undefined) continue;
  const wrapped = (...args: unknown[]): unknown =>
    counted(() => {
      if (corpus !== undefined && (name === "spawnSync" || name === "execFileSync")) {
        corpus.recordSpawnedHook(args[0], args.slice(1));
      }
      if (!PIPED_STDERR.has(name)) return original(...args);
      const last = args[args.length - 1];
      const hasOptions = typeof last === "object" && last !== null && !Array.isArray(last);
      const options = hasOptions ? (last as Record<string, unknown>) : {};
      const patched = options.stdio === undefined ? { ...options, stdio: "pipe" } : options;
      return original(...(hasOptions ? args.slice(0, -1) : args), patched);
    });
  // `util.promisify(exec)` resolves `{ stdout, stderr }` through this symbol on the ORIGINAL
  // function; a plain wrapper would lose it and resolve only the stdout string.
  const custom = original[promisify.custom];
  if (custom !== undefined) {
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]): unknown => counted(() => custom(...args)),
    });
  }
  childProcess[name] = wrapped;
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

// Spec 0055 R1 — `bench:tests` points NAVORI_BENCH_PROC_DIR here; one `{ file, spawns }` per test file.
afterAll(() => {
  const dir = process.env.NAVORI_BENCH_PROC_DIR;
  if (dir === undefined || dir === "") return;
  const filepath = expect.getState().testPath ?? "unknown";
  const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
  mkdirSync(dir, { recursive: true });
  const slug = createHash("sha1").update(filepath).digest("hex").slice(0, 12);
  writeFileSync(
    join(dir, `${process.pid}-${slug}.json`),
    JSON.stringify({ file: relative(packageRoot, filepath).split("\\").join("/"), spawns }),
  );
});

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
