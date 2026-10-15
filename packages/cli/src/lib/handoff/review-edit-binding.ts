/** Native review output binding and read-only compatibility preflight. */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkoutRoot, validateFeatureSlug, type StateRoot } from "../primitives/state-root.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { nativeActor, type NativeActor } from "./actor-provenance.ts";

const neutral = ".navori/state/handoffs";
const capability = "navori:review-edit-binding/v1";
/** Optional begin-only extension; it is deliberately outside the public seal. */
export const ReviewEditBindingSchema = z.strictObject({
  v: z.literal(1),
  checkout: z.string().min(1),
  gitDir: z.string().min(1),
  commonDir: z.string().min(1),
  stateDir: z.literal(neutral),
  target: z.string().min(1),
});
type ReviewEditBinding = z.infer<typeof ReviewEditBindingSchema>;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0) throw new Error("review checkout unavailable");
  return result.stdout.trim();
}

/** Creates a binding only in the actual checkout and registered native source repository. */
export function createReviewEditBinding(
  root: StateRoot,
  reviewer: NativeActor,
  target: string,
): ReviewEditBinding | undefined {
  if (root.dir !== neutral || realpathSync(process.cwd()) !== root.cwd) return undefined;
  const host = checkoutRoot(reviewer.sourceCwd);
  const commonDir = realpathSync(
    git(root.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const registered = git(host, "worktree", "list", "--porcelain", "-z").split("\0");
  if (
    !registered.includes(`worktree ${host}`) ||
    !registered.includes(`worktree ${root.cwd}`) ||
    commonDir !== realpathSync(git(host, "rev-parse", "--path-format=absolute", "--git-common-dir"))
  )
    throw new Error("review target is not a registered native source worktree");
  return ReviewEditBindingSchema.parse({
    v: 1,
    checkout: root.cwd,
    gitDir: realpathSync(git(root.cwd, "rev-parse", "--path-format=absolute", "--git-dir")),
    commonDir,
    stateDir: neutral,
    target,
  });
}

/** The native begin producer owns this exact thread/feature pointer. */
export const reviewEditIndexName = (feature: string, thread: string): string =>
  `review_${feature}.${thread}.edit.json`;

/** Loads the same builtins-only reader rendered inline in role-guard. */
function readerSource(): string {
  const source = readFileSync(
    join(getCoreRoot(), "core-assets/hooks/_partials/review-edit-binding.sh"),
    "utf8",
  );
  const reader = source
    .split("<<'NV_REVIEW_EDIT_BINDING'\n")[1]
    ?.split("\nNV_REVIEW_EDIT_BINDING")[0];
  if (!reader) throw new Error("review binding reader unavailable");
  return reader;
}

/** Runs exactly the hook reader, without manufacturing a native actor identity. */
export function checkReviewEditOutputs(options: {
  hostCwd: string;
  thread: string;
  outputs: string[];
}): { status: "ok" | "error"; reason: string } {
  const result = spawnSync(
    "node",
    ["-", options.hostCwd, options.thread, "reviewer", neutral, ...options.outputs],
    {
      input: readerSource(),
      encoding: "utf8",
      timeout: 9000,
    },
  );
  return {
    status: result.status === 0 ? "ok" : "error",
    reason: result.error ? "node-unavailable-or-timeout" : result.stdout.trim() || "reader-failed",
  };
}

/** Detects unsupported hooks/bindings before the reviewer spends the full gate. */
export function preflightReviewEdits(options: { cwd: string; feature: string; hostCwd: string }): {
  status: "ok" | "error";
  reason: string;
} {
  try {
    validateFeatureSlug(options.feature);
    const host = checkoutRoot(options.hostCwd);
    const hook = readFileSync(join(host, ".codex/hooks/role-guard.sh"), "utf8");
    if (
      !hook.includes(capability) ||
      !hook.includes(readerSource()) ||
      !hook.includes('nv_review_edit_binding "$navori_root" "$(payload_field agent_id)"')
    )
      return {
        status: "error",
        reason: "unsupported-host-hook: render the reviewed hook before live review",
      };
    if (realpathSync(process.cwd()) !== checkoutRoot(options.cwd))
      return { status: "error", reason: "preflight requires the actual target checkout" };
    const reviewer = nativeActor(options.cwd);
    if (!reviewer || reviewer.role !== "reviewer")
      return { status: "error", reason: "independent native reviewer unavailable" };
    return checkReviewEditOutputs({
      hostCwd: host,
      thread: reviewer.thread,
      outputs: ["md", "json"].map((ext) =>
        join(options.cwd, neutral, `review_${options.feature}.${ext}`),
      ),
    });
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}
