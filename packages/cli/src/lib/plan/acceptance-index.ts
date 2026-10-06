/**
 * `acceptance-index` (spec 0039 R6/R7, carry-over 0038 D1): the file the
 * `routing-watch` success lane reads to recognize, with shell builtins only,
 * that a Bash call ran a pending acceptance criterion's `command`.
 *
 * Text, one line per pending criterion, rewritten whole by the CLI each time it
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
import { deliveryCriterionCapture } from "../master/delivery.ts";
import { resolveStateRoot } from "../primitives/state-root.ts";

/** Where the hook looks (`$CLAUDE_PROJECT_DIR/.navori/state/handoffs`). */
const NEUTRAL_DIR = ".navori/state/handoffs";
const LEGACY_DIRS = [".claude/progress", ".codex/progress"] as const;
const INDEX_NAME = "acceptance-index";

/** The command exactly as `JSON.stringify` writes it inside a payload string. */
function jsonEscape(command: string): string {
  return JSON.stringify(command).slice(1, -1);
}

/** Index lines for the pending criteria of every readable workplan in `dir`. */
function linesForDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^workplan_.+\.json$/.test(name)) continue;
    try {
      const plan = WorkplanSchema.parse(JSON.parse(readFileSync(resolve(dir, name), "utf8")));
      // Projection runs once per plan; a stale slice throws here and contributes no line.
      const capture =
        plan.source &&
        plan.acceptance.some((criterion) => plan.progress[criterion.id] !== "cumplido")
          ? deliveryCriterionCapture(
              resolveStateRoot({ cwd: dir, feature: plan.feature, dir }).cwd,
              plan.source,
            )
          : undefined;
      for (const criterion of plan.acceptance) {
        if (plan.progress[criterion.id] === "cumplido") continue;
        if (capture) {
          const binding = capture(criterion.id, criterion.command);
          lines.push(
            `${jsonEscape(criterion.command)}\t${plan.feature}\t${criterion.id}\t${dir}\t${JSON.stringify(binding)}\t${binding.stagePath}\n`,
          );
        } else {
          lines.push(
            `${jsonEscape(criterion.command)}\t${plan.feature}\t${criterion.id}\t${dir}\n`,
          );
        }
      }
    } catch {
      // An unreadable or invalid workplan contributes nothing: the index is
      // advisory input to a hook, never a place to fail a CLI write.
    }
  }
  return lines;
}

/** Pure builder: index text for the workplans under `dirs` (absolute paths). */
export function buildAcceptanceIndex(dirs: readonly string[]): string {
  return [...new Set(dirs)].flatMap(linesForDir).join("");
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
  writeStateFileAtomic(neutral, INDEX_NAME, buildAcceptanceIndex(dirs));
}
