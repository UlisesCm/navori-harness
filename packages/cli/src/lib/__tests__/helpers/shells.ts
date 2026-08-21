import { spawnSync } from "node:child_process";
import { expect } from "vitest";

/**
 * Shells the rendered hooks must behave identically under (#391).
 *
 * The hooks run with whatever shell the host wires in; on the team's machines
 * that is zsh, where an unquoted `for f in $files` does NOT word-split — the
 * exact divergence behind #344 and #365. Every hook suite therefore runs its
 * table under bash AND zsh. `bash` is always listed (the platform gate is the
 * existing `describe.runIf(runsBash)`); `zsh` is appended only when the binary
 * exists, so its absence skips the zsh rows cleanly instead of failing.
 */
export type HookShell = "bash" | "zsh";

const hasZsh = spawnSync("zsh", ["-c", "exit 0"]).status === 0;

export const HOOK_SHELLS: readonly HookShell[] = hasZsh ? ["bash", "zsh"] : ["bash"];

/**
 * Run `run` once per available shell and assert every shell agrees on the
 * outcome (deep equality); returns the agreed result. Divergence between bash
 * and zsh is exactly the regression class this guards: the same table of cases
 * exercises every shell, so an unquoted `for f in $files` (word-splits under
 * bash, stays whole under zsh) breaks the suite instead of shipping.
 */
export function acrossShells<T>(run: (shell: HookShell) => T): T {
  const [first, ...rest] = HOOK_SHELLS.map((shell) => ({ shell, result: run(shell) }));
  for (const { shell, result } of rest) {
    expect(
      result,
      `${shell} diverges from ${first.shell} — the hook is not shell-portable (#391)`,
    ).toEqual(first.result);
  }
  return first.result;
}
