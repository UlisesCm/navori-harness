import type { NavoriConfig } from "../../lib/config/config.ts";
import { shellSingleQuote } from "../../lib/primitives/shell-escape.ts";
import { COMMON_WRITES, ROSTER_AGENTS } from "./roster.ts";

const SPECS_DIR_TOKEN = "{{sdd.specsDir}}";

/** Trim `./` and slashes so a prefix is a clean repo-relative path; "" when nothing is left. */
function cleanPrefix(prefix: string): string {
  return prefix.replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

/**
 * Resolve one `RosterAgent.writes` entry to a `<path>/` prefix, or `null` when
 * it resolves to the repo root (an empty/`.` `sdd.specsDir` must not open the
 * whole repo to a restricted role).
 */
function resolvePrefix(entry: string, specsDir: string): string | null {
  const clean = cleanPrefix(entry.replaceAll(SPECS_DIR_TOKEN, specsDir));
  return clean === "" || clean === "." ? null : `${clean}/`;
}

/** `printf` arm body listing `prefixes`, one per line, each a single-quoted shell token. */
function printPrefixes(prefixes: readonly string[]): string {
  return `printf '%s\\n' ${prefixes.map(shellSingleQuote).join(" ")}`;
}

/**
 * Compile `RosterAgent.writes` into the shell `case` body that `role-guard.sh`
 * interpolates (`{{rolePolicy}}`, spec 0041 D6, R7). `$1` is the role; the arm
 * prints the allowed repo-relative prefixes one per line. Any role without an
 * arm — `default`, unknown, or a roster role with no `writes` — falls to the
 * `*` arm with {@link COMMON_WRITES} only (fail-closed, R6). Values are
 * single-quoted, so a hostile `sdd.specsDir` cannot break out of the script.
 */
export function buildRolePolicyShell(config: NavoriConfig): string {
  const specsDir = cleanPrefix(config.sdd?.specsDir ?? "specs");
  const common = COMMON_WRITES.map((entry) => resolvePrefix(entry, specsDir)).filter(
    (p): p is string => p !== null,
  );
  const arms = ROSTER_AGENTS.flatMap((agent) => {
    if (agent.writes === undefined) return [];
    const prefixes = agent.writes
      .map((entry) => resolvePrefix(entry, specsDir))
      .filter((p): p is string => p !== null);
    return [`    ${agent.id}) ${printPrefixes(prefixes)} ;;`];
  });
  return ['  case "$1" in', ...arms, `    *) ${printPrefixes(common)} ;;`, "  esac"].join("\n");
}
