/**
 * `navori handoff render <feature>` (spec 0054 R30, 0045 D13) — produces
 * `impl_<feature>.md` from `impl_<feature>.json` with a pure template, so the
 * `scribe` is only dispatched when `markdownRequests` has something to apply.
 * Reads and writes stay inside the state root (`resolveStateRoot`,
 * `stateArtifactPath`, `writeStateFileAtomic`), none of which follow symlinks.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../config/config.ts";
import {
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
} from "../primitives/state-root.ts";
import { ImplHandoffSchema, type ImplHandoff } from "./schema.ts";

/** Outcome of {@link renderHandoff}: written, or refused without touching any file. */
export type RenderHandoffResult =
  | { status: "ok"; path: string }
  | { status: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One `acceptance` entry; the schema leaves them `unknown`, so only known fields are shown. */
function acceptanceLine(entry: unknown): string {
  if (!isRecord(entry)) return `- ${JSON.stringify(entry)}`;
  const text = (key: string): string => (typeof entry[key] === "string" ? entry[key] : "");
  const exit = typeof entry.exitCode === "number" ? ` exit ${entry.exitCode}` : "";
  const excerpt = text("excerpt") === "" ? "" : ` — ${text("excerpt")}`;
  return `- ${text("id") || "?"}: \`${text("command")}\`${exit}${excerpt}`;
}

/**
 * Pure template over `ImplHandoffSchema`: status, files, verification,
 * acceptance, doubts and blockers. It adds no claim the JSON does not carry.
 */
export function renderImplHandoff(impl: ImplHandoff): string {
  const list = (items: string[], empty: string): string[] =>
    items.length === 0 ? [empty] : items.map((item) => `- ${item}`);
  const lines = [
    `# Implementation handoff: ${impl.feature}`,
    "",
    `- Status: ${impl.status}`,
    `- Worktree: ${impl.worktree}`,
    `- Branch: ${impl.branch}`,
    `- Head: ${impl.head ?? "(not recorded)"}`,
    `- Commits: ${impl.commits.length === 0 ? "(none)" : impl.commits.join(", ")}`,
    ...(impl.rootCause === undefined ? [] : ["", "## Root cause", "", impl.rootCause]),
    "",
    "## Files touched",
    "",
    ...list(
      impl.filesTouched.map((file) => `\`${file}\``),
      "(none)",
    ),
    "",
    "## Verification",
    "",
    `- Command: \`${impl.verification.command}\``,
    `- Exit code: ${impl.verification.exitCode}`,
    `- Summary: ${impl.verification.summary}`,
    ...(impl.acceptance && impl.acceptance.length > 0
      ? ["", "## Acceptance", "", ...impl.acceptance.map(acceptanceLine)]
      : []),
    ...(impl.doubts && impl.doubts.length > 0
      ? ["", "## Doubts", "", ...impl.doubts.map((doubt) => `- \`${doubt.file}\`: ${doubt.reason}`)]
      : []),
    "",
    "## Blockers",
    "",
    ...list(impl.blockers, "(none)"),
    "",
    "## Markdown requests",
    "",
    ...list(
      impl.markdownRequests.map(
        (request) => `\`${request.path}\`: ${request.intent} (evidence: ${request.evidence})`,
      ),
      "(none)",
    ),
    "",
  ];
  return lines.join("\n");
}

/**
 * Validates `impl_<feature>.json` and writes `impl_<feature>.md` next to it.
 * Refuses (and writes nothing) when the JSON is missing, unparsable, invalid,
 * belongs to another feature, sits outside the state root, or when
 * `harness.scribeOwnsMarkdown` is not `true` — in that mode the implementer
 * writes the `.md` itself and this command must not overwrite it.
 */
export function renderHandoff(options: {
  cwd: string;
  feature: string;
  dir?: string;
}): RenderHandoffResult {
  const fail = (message: string): RenderHandoffResult => ({ status: "error", message });
  try {
    const root = resolveStateRoot(options);
    let scribeOwnsMarkdown = false;
    try {
      scribeOwnsMarkdown =
        readConfig(resolve(root.cwd, "navori.config.json")).harness?.scribeOwnsMarkdown ?? false;
    } catch {
      scribeOwnsMarkdown = false;
    }
    if (!scribeOwnsMarkdown) {
      return fail(
        "harness.scribeOwnsMarkdown is not true: the implementer writes impl_<feature>.md itself " +
          "in this mode, so `handoff render` will not overwrite it. FIX: set the flag in navori.config.json, or skip this step.",
      );
    }
    const jsonFile = stateArtifactPath(root, `impl_${options.feature}.json`);
    if (!existsSync(jsonFile)) return fail(`impl_${options.feature}.json not found in ${root.dir}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonFile, "utf8"));
    } catch {
      return fail(`impl_${options.feature}.json is not valid JSON`);
    }
    const parsed = ImplHandoffSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(
        `impl_${options.feature}.json is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    if (parsed.data.feature !== options.feature) {
      return fail(
        `impl_${options.feature}.json belongs to feature "${parsed.data.feature}", not "${options.feature}"`,
      );
    }
    writeStateFileAtomic(root, `impl_${options.feature}.md`, renderImplHandoff(parsed.data));
    return { status: "ok", path: stateArtifactPath(root, `impl_${options.feature}.md`) };
  } catch (cause: unknown) {
    return fail(cause instanceof Error ? cause.message : "unsafe state root");
  }
}
