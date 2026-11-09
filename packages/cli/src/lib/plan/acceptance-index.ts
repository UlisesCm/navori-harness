/**
 * `acceptance-index` (spec 0039 R6/R7, carry-over 0038 D1): the file the
 * `routing-watch` success lane reads to recognize, with shell builtins only,
 * that a Bash call ran an acceptance criterion's `command`.
 *
 * Text, one line per criterion (pending or cumplido), rewritten whole by the CLI each time it
 * writes a workplan:
 *   `<command JSON-escaped, no quotes>\t<feature>\t<A<n>>\t<absolute state dir>\n`
 * The hook never parses a workplan; the CLI never trusts the hook's output.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stateArtifactPath,
  writeStateFileAtomic,
  type StateRoot,
} from "../primitives/state-root.ts";
import { WorkplanSchema } from "./schema.ts";
import { parseExpected } from "./expected.ts";

/** Where the hook looks (`$CLAUDE_PROJECT_DIR/.navori/state/handoffs`). */
const NEUTRAL_DIR = ".navori/state/handoffs";
const LEGACY_DIRS = [".claude/progress", ".codex/progress"] as const;
const INDEX_NAME = "acceptance-index";

/** The command exactly as `JSON.stringify` writes it inside a payload string. */
export function jsonEscape(command: string): string {
  return JSON.stringify(command).slice(1, -1);
}

/** Index lines for the criteria of every readable workplan in `dir`. */
function linesForDir(dir: string): { lines: string[]; comparisons: string[] } {
  const lines: string[] = [];
  const comparisons: string[] = [];
  if (!existsSync(dir)) return { lines, comparisons };
  for (const name of readdirSync(dir).sort()) {
    if (!/^workplan_.+\.json$/.test(name)) continue;
    try {
      const plan = WorkplanSchema.parse(JSON.parse(readFileSync(resolve(dir, name), "utf8")));
      for (const criterion of plan.acceptance) {
        // Cumplido criteria stay indexed: a rerun after a change must record fresh
        // evidence, and a stale green never validates against a moved tree.
        lines.push(`${jsonEscape(criterion.command)}\t${plan.feature}\t${criterion.id}\t${dir}\n`);
        const spec = parseExpected(criterion.expected);
        if (spec.kind !== "free")
          comparisons.push(
            JSON.stringify({
              command: criterion.command,
              feature: plan.feature,
              id: criterion.id,
              dir,
              binding: null,
              stage: "",
              expected: criterion.expected,
              spec,
            }) + "\n",
          );
      }
    } catch {
      // An unreadable or invalid workplan contributes nothing: the index is
      // advisory input to a hook, never a place to fail a CLI write.
    }
  }
  return { lines, comparisons };
}

/** Pure builder: index text for the workplans under `dirs` (absolute paths). */
export function buildAcceptanceIndex(dirs: readonly string[]): string {
  return [...new Set(dirs)].flatMap((dir: string) => linesForDir(dir).lines).join("");
}

/**
 * Rewrites the index at the neutral state dir of `root`'s checkout, scanning
 * the neutral dir, both legacy dirs and `root`'s own dir (explicit `--dir`).
 */
export function writeAcceptanceIndex(root: StateRoot): void {
  const dirs = [NEUTRAL_DIR, ...LEGACY_DIRS].map((d) => resolve(root.cwd, d));
  dirs.push(root.path);
  const neutral: StateRoot = {
    cwd: root.cwd,
    dir: NEUTRAL_DIR,
    path: resolve(root.cwd, NEUTRAL_DIR),
    kind: "neutral",
  };
  stateArtifactPath(neutral, INDEX_NAME);
  const indexes = [...new Set(dirs)].map(linesForDir);
  writeStateFileAtomic(
    neutral,
    "acceptance-expected.jsonl",
    indexes.flatMap((index) => index.comparisons).join(""),
  );
  writeStateFileAtomic(neutral, INDEX_NAME, indexes.flatMap((index) => index.lines).join(""));
}
