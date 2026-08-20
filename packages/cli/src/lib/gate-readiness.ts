/**
 * Quality-gate readiness (#368) — is the declared gate a command that can
 * actually RUN here?
 *
 * The harness's startup block already says "confirm the declared gates run;
 * install them or note the debt". Nothing checked it. Measured on a real
 * two-repo ticket: with no `node_modules`, the declared `qualityGate` never
 * ran, which makes three phases of the intake pipeline (the implementer's
 * gate, verify-before-done, the pilot's PR gate) structurally unreachable —
 * and the discovery happened at step 10, mid-implementation.
 *
 * Prose an agent may skip costs tokens every session and still gets skipped.
 * The same rule as a check costs zero context and cannot be forgotten.
 *
 * Deliberately STATIC: doctor never executes the gate (it would be slow and
 * has side effects). It answers the three questions that are cheap and
 * deterministic — is the binary on PATH, does the script exist, are the deps
 * installed — which is exactly the class of failure measured in the field.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasBinary } from "./which.ts";
import type { NavoriConfig } from "./config.ts";

export type GateBlocker = "missing-binary" | "missing-script" | "missing-deps";

export interface GateReadinessIssue {
  /** Which declared gate: `fast` or `full`. */
  gate: "fast" | "full";
  /** What is missing: a binary name, a script name, or the deps' directory. */
  detail: string;
  reason: GateBlocker;
}

/** Shell words that are not the command whose availability we can check. */
const SHELL_BUILTINS = new Set([
  "cd",
  "echo",
  "export",
  "set",
  "source",
  ".",
  "true",
  "false",
  "exit",
  "eval",
  "unset",
  "read",
]);

/** JS package managers: for these the gate's argument is a package.json script. */
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

/**
 * Split a gate command into segments on the shell separators, the same way the
 * pre-commit hook's rules do. Each segment starts with its command word.
 */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Drop `VAR=value` prefixes so the first token is the command word. */
function commandWords(segment: string): string[] {
  const words = segment.split(/\s+/);
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return words;
}

/**
 * The package.json script a package-manager invocation runs, or null when the
 * shape is anything but the two unambiguous ones (`pm <script>` and
 * `pm run <script>`). Any flag in the invocation (`--filter x`, `-w y`) makes
 * the argument's meaning ambiguous, so we decline to guess: a false "that
 * script doesn't exist" is worse than no check at all.
 */
function scriptOf(words: string[]): string | null {
  const args = words.slice(1);
  if (args.some((w) => w.startsWith("-"))) return null;
  const rest = args[0] === "run" || args[0] === "run-script" ? args.slice(1) : args;
  if (rest.length !== 1) return null;
  const script = rest[0];
  // `npm test` / `pnpm install` are pm subcommands; only `test` maps to a
  // script, and the rest carry no script contract worth checking.
  return script === "install" || script === "i" || script === "exec" ? null : script;
}

/** Read `scripts` from a package.json, or null when there's none to read. */
function readScripts(dir: string): Record<string, string> | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    return typeof scripts === "object" && scripts !== null
      ? (scripts as Record<string, string>)
      : {};
  } catch {
    return null; // a broken package.json is its own problem, not the gate's
  }
}

/**
 * Static readiness check of every declared gate. Returns one issue per distinct
 * blocker; an empty array means every declared gate is runnable as far as a
 * static check can tell.
 */
export function scanQualityGateReadiness(cwd: string, config: NavoriConfig): GateReadinessIssue[] {
  const gates: Array<["fast" | "full", string | undefined]> = [
    ["fast", config.qualityGate?.fast],
    ["full", config.qualityGate?.full],
  ];

  const out: GateReadinessIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: GateReadinessIssue): void => {
    const key = `${issue.reason}:${issue.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(issue);
  };

  for (const [gate, command] of gates) {
    if (!command) continue;
    // A `cd` in one segment changes where the NEXT ones resolve — this repo's
    // own gate is `pnpm format:check && cd packages/cli && pnpm test`.
    let dir = cwd;
    for (const segment of segments(command)) {
      const words = commandWords(segment);
      const bin = words[0];
      if (!bin) continue;
      if (bin === "cd") {
        const target = words[1];
        if (target && !target.startsWith("-")) dir = resolve(dir, target);
        continue;
      }
      if (SHELL_BUILTINS.has(bin)) continue;
      if (!hasBinary(bin)) {
        push({ gate, detail: bin, reason: "missing-binary" });
        continue;
      }
      if (!PACKAGE_MANAGERS.has(bin)) continue;

      const scripts = readScripts(dir);
      if (scripts === null) continue; // no package.json here — nothing to assert
      if (!existsSync(join(dir, "node_modules"))) {
        push({ gate, detail: relativeTo(cwd, dir), reason: "missing-deps" });
        continue; // deps missing explains any script failure; don't pile on
      }
      const script = scriptOf(words);
      if (script !== null && !(script in scripts)) {
        push({ gate, detail: script, reason: "missing-script" });
      }
    }
  }
  return out;
}

/** Repo-relative label for a directory, `.` for the repo root. */
function relativeTo(cwd: string, dir: string): string {
  if (dir === cwd) return ".";
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : dir;
}
