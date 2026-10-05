import { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const environmentKeys = [
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOME",
  "USERPROFILE",
  "NAVORI_BACKUP_ROOT",
  "CODEX_HOME",
] as const;

const retentionMarker = ".navori-retain";

/** Only a missing marker permits ordinary cleanup; other I/O failures retain evidence. */
function runRetained(root: string): boolean {
  try {
    readFileSync(join(root, retentionMarker));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Owns one exact allocated root; incomplete file lifetimes remain inspectable. */
export interface TempRun {
  root: string;
  dispose(): void;
}

/** Allocate the suite container without changing coordinator environment. */
export function createTempRun(base: string = tmpdir()): TempRun {
  const root = mkdtempSync(join(base, "navori-test-run-"));
  const publishRetention = (): boolean => {
    try {
      writeFileSync(join(root, retentionMarker), "", { flag: "a" });
      return true;
    } catch (error) {
      process.stderr.write(`test retention publication failed at ${root}: ${String(error)}\n`);
      return false;
    }
  };
  const onExit = (): void => {
    if (publishRetention())
      process.stderr.write(`test temporaries retained after interrupted run: ${root}\n`);
  };
  process.once("exit", onExit);
  return {
    root,
    dispose(): void {
      process.off("exit", onExit);
      // Remaining file roots were not safely completed, or hold diagnosed evidence.
      if (readdirSync(root).length > 0) {
        if (publishRetention())
          process.stderr.write(`test temporaries retained for inspection: ${root}\n`);
        return;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** File owner used before spec imports, including watch reruns and fallback configs. */
export interface TempFile {
  root: string;
  home: string;
  dispose(retainReason?: string | (() => string | undefined)): Promise<void>;
}

/**
 * Route temporary allocations and inheriting children into an exact file root.
 * Node's child_process diagnostic channel tracks direct asynchronous children;
 * detached grandchildren and runtimes without that channel are outside this contract.
 */
export function createTempFile(runRoot?: string): TempFile {
  const keepArtifacts = process.env.NAVORI_KEEP_TEST_ARTIFACTS === "1";
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(runRoot ?? tmpdir(), "navori-test-file-"));
  const home = join(root, "home");
  const backups = join(root, "backups");
  mkdirSync(home);
  mkdirSync(backups);
  Object.assign(process.env, {
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    HOME: home,
    USERPROFILE: home,
    NAVORI_BACKUP_ROOT: backups,
  });
  delete process.env.CODEX_HOME;
  const children = new Map<ChildProcess, Promise<void>>();
  const onChild = (message: unknown): void => {
    if (
      !message ||
      typeof message !== "object" ||
      !("process" in message) ||
      !(message.process instanceof ChildProcess)
    )
      return;
    const child = message.process;
    children.set(
      child,
      new Promise<void>((done) =>
        child.once("close", () => {
          children.delete(child);
          done();
        }),
      ),
    );
  };
  subscribe("child_process", onChild);
  const onExit = (): void => {
    process.stderr.write(`test file temporaries retained after interrupted worker: ${root}\n`);
  };
  process.once("exit", onExit);
  return {
    root,
    home,
    /** Wait for direct children, retain uncertain lifetimes and restore worker overrides. */
    async dispose(retainReason?: string | (() => string | undefined)): Promise<void> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (children.size > 0) {
          await Promise.race([
            Promise.all(children.values()),
            new Promise<void>((done) => {
              timeout = setTimeout(done, 1_000);
            }),
          ]);
        }
        // Final evidence checks run only after supported writers have closed.
        const reason =
          typeof retainReason === "function"
            ? children.size === 0
              ? retainReason()
              : undefined
            : retainReason;
        // Publication before this check binds late workers; it cannot undo deletion begun earlier.
        const retainedRun = runRoot !== undefined && runRetained(runRoot);
        if (children.size > 0 || reason || keepArtifacts || retainedRun) {
          process.stderr.write(
            `test file temporaries retained (${reason ?? (children.size > 0 ? "direct child still active" : keepArtifacts ? "NAVORI_KEEP_TEST_ARTIFACTS=1" : "coordinator retention")}): ${root}\n`,
          );
        } else {
          rmSync(root, { recursive: true, force: true });
        }
      } catch (error) {
        process.stderr.write(`test temporary cleanup failed at ${root}: ${String(error)}\n`);
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        unsubscribe("child_process", onChild);
        process.off("exit", onExit);
        for (const key of environmentKeys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    },
  };
}
