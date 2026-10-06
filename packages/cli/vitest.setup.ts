import { afterAll, inject } from "vitest";
import { createTempFile } from "./vitest.tempLifecycle.ts";
import { describeNavoriHomeLeak, snapshotNavoriHome } from "./vitest.homeGuard.ts";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare module "vitest" {
  export interface ProvidedContext {
    navoriTempRunRoot: string;
  }
}

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
