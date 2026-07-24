import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Build the CLI before the suite runs.
 *
 * The e2e specs spawn the compiled binary (`dist/index.js`) rather than the
 * source, so a stale or missing `dist/` makes them assert against old behavior
 * and fail for environmental reasons (e.g. a fresh worktree where `dist/` is
 * gitignored). Building here — once per vitest run — makes `dist/` a guaranteed
 * prerequisite regardless of which script (`test`, `test:watch`, `test:coverage`)
 * invoked vitest.
 */
export default function setup(): void {
  const r = spawnSync("pnpm", ["build"], {
    cwd: pkgRoot,
    stdio: "inherit",
    // pnpm resolves through a shell shim on Windows CI.
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    throw new Error(
      `vitest globalSetup: 'pnpm build' failed (exit ${r.status ?? "signal"}). ` +
        `The e2e suite runs against ${resolve(pkgRoot, "dist/index.js")}.`,
    );
  }
}
