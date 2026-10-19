import { spawnSync } from "node:child_process";
import { expect } from "vitest";

/**
 * Shells the rendered hooks must behave identically under (#391).
 *
 * The hooks run with whatever shell the host wires in; on the team's machines
 * that is zsh, where an unquoted `for f in $files` does NOT word-split — the
 * exact divergence behind #344 and #365. Spec 0055 D9: the safety net for that
 * class is `hooks-zsh-parity.test.ts`, which replays the COMPLETE hook verdict
 * corpus under zsh. The suite itself therefore runs bash only
 * ({@link HOOK_SHELLS}) and adds zsh through {@link shellSensitive}, with a
 * reason, for the cases the corpus cannot reproduce (git state, fixtures) and
 * whose result depends on the shell. `NAVORI_TEST_ALL_SHELLS=1` restores the
 * full matrix everywhere (diagnosis, the `all_shells` CI dispatch).
 */
export type HookShell = "bash" | "zsh";

const hasZsh = spawnSync("zsh", ["-c", "exit 0"]).status === 0;

/** Every shell available on this host; `bash` is always first (platform gate: `describe.runIf(runsBash)`). */
const AVAILABLE_SHELLS: readonly [HookShell, ...HookShell[]] = hasZsh ? ["bash", "zsh"] : ["bash"];

/** True when `NAVORI_TEST_ALL_SHELLS=1` asks for the full bash+zsh matrix. */
export const ALL_SHELLS: boolean = process.env.NAVORI_TEST_ALL_SHELLS === "1";

/** Shells a regular case runs under: bash, or the full matrix with `NAVORI_TEST_ALL_SHELLS=1`. */
export const HOOK_SHELLS: readonly [HookShell, ...HookShell[]] = ALL_SHELLS
  ? AVAILABLE_SHELLS
  : ["bash"];

/**
 * Shells for a case whose result depends on the shell itself (word-splitting,
 * zsh options, globbing). `reason` names the concrete construct and is
 * mandatory: an empty one throws, so a sensitive mark cannot be a blind opt-in.
 * zsh is dropped, not failed, when the binary is absent.
 */
export function shellSensitive(reason: string): readonly [HookShell, ...HookShell[]] {
  if (reason.trim() === "") throw new Error("shellSensitive needs a non-empty reason");
  return AVAILABLE_SHELLS;
}

/** Options of {@link acrossShells}. */
export interface AcrossShellsOptions {
  /** Reason this case is shell-dependent; it adds zsh to the run (see {@link shellSensitive}). */
  sensitive?: string;
}

/**
 * Run `run` once per selected shell and assert every shell agrees on the
 * outcome (deep equality); returns the agreed result. Selection: bash only by
 * default, bash+zsh with `{ sensitive: reason }` (or any case under
 * `NAVORI_TEST_ALL_SHELLS=1`). Divergence between bash and zsh is exactly the
 * regression class this guards: an unquoted `for f in $files` (word-splits
 * under bash, stays whole under zsh) breaks the suite instead of shipping.
 */
export function acrossShells<T>(
  run: (shell: HookShell) => T,
  options: AcrossShellsOptions = {},
): T {
  const shells = options.sensitive === undefined ? HOOK_SHELLS : shellSensitive(options.sensitive);
  // Destructuring the tuple (not the mapped array) is what keeps `first`
  // non-nullable: `map` widens a tuple back to a plain array. Every shell still
  // runs BEFORE the first assertion, so a divergence never hides a later shell.
  const [first, ...rest] = shells;
  const expected = run(first);
  const others = rest.map((shell) => ({ shell, result: run(shell) }));
  for (const { shell, result } of others) {
    expect(
      result,
      `${shell} diverges from ${first} — the hook is not shell-portable (#391)`,
    ).toEqual(expected);
  }
  return expected;
}
