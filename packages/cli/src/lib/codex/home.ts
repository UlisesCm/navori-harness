import { isAbsolute, join } from "node:path";
import { HomeError } from "../primitives/errors.ts";
import { safeHomedir } from "../primitives/home.ts";

/**
 * Codex's machine-global home: `$CODEX_HOME` when set, else `~/.codex` — the
 * same resolution Codex itself uses, so trust state is read and written where
 * the host actually looks (spec 0041 R23). An empty value counts as unset; a
 * relative one is refused, because it would resolve against the process cwd
 * and write user state into the repo (the hazard `safeHomedir` guards too).
 */
export function codexHome(): string {
  const override = process.env.CODEX_HOME;
  if (override === undefined || override === "") return join(safeHomedir(), ".codex");
  if (!isAbsolute(override)) {
    throw new HomeError(`CODEX_HOME must be an absolute path (got '${override}').`);
  }
  return override;
}
