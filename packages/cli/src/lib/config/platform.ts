import { PLATFORMS, type Platform } from "./plugins.ts";

/**
 * The current OS as a key of an `externalTool.install` matrix, or `null` when
 * this OS is not one navori's manifests describe (freebsd, openbsd, sunos, aix).
 *
 * `null`, never a guess: `add` used to fold every non-darwin/linux platform
 * into `win32`, so on FreeBSD it offered `winget install --id GitHub.cli` — a
 * command that cannot exist there. Shared with `doctor`, which read
 * `process.platform` raw, so both commands now answer the same question the
 * same way on the same machine.
 *
 * Read at call time on purpose: `process.platform` is patched by tests.
 */
export function currentPlatform(): Platform | null {
  const found = PLATFORMS.find((p) => p === process.platform);
  return found ?? null;
}
