/**
 * Acceptance evidence for `navori plan update --progress A<n>=cumplido`
 * (spec 0039 R7-R9, carry-over 0038 D1/D2).
 *
 * The host runs a criterion's `command` in its own Bash tool and a hook
 * appends one line per success to `workplan_<feature>.evidence.jsonl`. This
 * module only READS that log and compares it with the criterion and the
 * current state of the tree. It never spawns a criterion's `command`
 * (invariant 9): the only processes it starts are `git` plumbing calls.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { stateArtifactPath, type StateRoot } from "../primitives/state-root.ts";
import type { RecordedEvidence } from "./schema.ts";

/** Paths excluded from the tree fingerprint so the evidence log, state files
 * and sibling worktrees never change the hash they are recorded against. */
const FINGERPRINT_EXCLUDES = [
  ".navori/state",
  ".claude/progress",
  ".codex/progress",
  ".claude/worktrees",
] as const;

/** Producer-captured authority, qualified definition and exact lifecycle directory. */
export const DeliveryEvidenceBindingSchema = z.strictObject({
  policy: z.literal("deliveries-content-v1"),
  authorityGeneration: z.number().int().positive(),
  stagePath: z
    .string()
    .regex(/^[^\t\r\n\\]+$/)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.split("/").some((segment) => !segment || segment === "." || segment === ".."),
    ),
  sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  baselineIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  queueIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  qualifiedId: z.string().regex(/^P\d+\.A\d+$/),
  criterionIdentity: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DeliveryEvidenceBinding = z.infer<typeof DeliveryEvidenceBindingSchema>;

/** One line of `workplan_<feature>.evidence.jsonl` (0038 § Contracts). */
const EvidenceLineSchema = z.object({
  ts: z.string(),
  feature: z.string(),
  id: z.string(),
  command: z.string(),
  tree: z.string(),
  cwd: z.string(),
  head: z.string(),
  worktreeTree: z.string(),
  dirty: z.boolean(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  deliveryBinding: DeliveryEvidenceBindingSchema.optional(),
});
export type EvidenceLine = z.infer<typeof EvidenceLineSchema>;

/**
 * Repo-controlled code paths neutralized on EVERY git call of this module
 * (invariant 9: `plan update` must not execute code the repo configures):
 * `core.fsmonitor` is a hook command git runs on index refresh, and
 * `core.hooksPath` redirects hooks. Filters (`filter.<n>.clean|process`) are
 * avoided structurally: the fingerprint never uses `git add`, it hashes
 * blobs with `--no-filters` (see `fingerprintTree`).
 */
const GIT_HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): string | undefined {
  const result = spawnSync("git", [...GIT_HARDENING, ...args], {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

/** `git rev-parse HEAD` of `tree`, or `""` when unborn/unreadable. */
export function readHead(tree: string): string {
  return git(tree, ["rev-parse", "HEAD"])?.trim() ?? "";
}

export type Fingerprint = { ok: true; tree: string } | { ok: false; reason: string };

/**
 * Content hash of the whole working tree (uncommitted edits and new
 * non-ignored files included). Built WITHOUT `git add`, which would run
 * `clean`/`process` filters and fsmonitor from the repo's own config:
 * file list from `ls-files --cached --others --exclude-standard`, raw blobs
 * from `hash-object -w --no-filters`, assembled into a scratch index
 * (`read-tree --empty` + `update-index --index-info`) and `write-tree`d.
 * The real index, refs and working tree are never modified; only loose
 * objects (and one scratch index inside the git dir) are written. Symlinks
 * hash their target; gitlinks/directories are skipped. Same procedure the
 * recording hook must use (0038 D1 step 4).
 */
export function fingerprintTree(
  tree: string,
  binding?: Pick<DeliveryEvidenceBinding, "stagePath">,
): Fingerprint {
  const excludes: string[] = [...FINGERPRINT_EXCLUDES];
  if (binding) {
    const parsed = DeliveryEvidenceBindingSchema.shape.stagePath.safeParse(binding.stagePath);
    if (!parsed.success) return { ok: false, reason: "invalid delivery binding" };
    const root = real(tree);
    const stage = root && resolve(root, binding.stagePath);
    if (!root || !stage || !stage.startsWith(`${root}${sep}`) || real(stage) !== stage)
      return { ok: false, reason: "delivery stage is not physically contained" };
    for (const name of ["state.json", "STATUS.md"]) {
      const path = join(stage, name);
      if ((name === "state.json" || existsSync(path)) && real(path) !== path)
        return { ok: false, reason: "delivery lifecycle file is missing or redirected" };
      excludes.push(`${binding.stagePath}/${name}`);
    }
  }
  const scratch = git(tree, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "navori-fp-index",
  ])?.trim();
  if (!scratch) return { ok: false, reason: "not a readable git checkout" };
  if (existsSync(`${scratch}.lock`)) {
    return {
      ok: false,
      reason: `stale lock file ${scratch}.lock (remove it if no git process is running)`,
    };
  }
  const listed = git(tree, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
    "--",
    ".",
    ...excludes.map((p) => `:(exclude,literal)${p}`),
  ]);
  if (listed === undefined) return { ok: false, reason: "git ls-files failed" };
  const files: Array<{ path: string; mode: string }> = [];
  const links: Array<{ path: string; target: string }> = [];
  for (const path of listed.split("\0").filter(Boolean)) {
    if (path.includes("\n")) return { ok: false, reason: "a tracked path contains a newline" };
    let stat;
    try {
      stat = lstatSync(join(tree, path));
    } catch {
      continue; // tracked but deleted from the working tree
    }
    if (stat.isSymbolicLink()) links.push({ path, target: readlinkSync(join(tree, path)) });
    else if (stat.isFile()) files.push({ path, mode: stat.mode & 0o111 ? "100755" : "100644" });
  }
  const entries: string[] = [];
  if (files.length > 0) {
    const shas = git(tree, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      input: `${files.map((f) => f.path).join("\n")}\n`,
    })
      ?.split("\n")
      .filter(Boolean);
    if (!shas || shas.length !== files.length) {
      return { ok: false, reason: "git hash-object failed" };
    }
    files.forEach((f, i) => entries.push(`${f.mode} ${shas[i]}\t${f.path}\0`));
  }
  for (const link of links) {
    const sha = git(tree, ["hash-object", "-w", "--no-filters", "--stdin"], {
      input: link.target,
    })?.trim();
    if (!sha) return { ok: false, reason: "git hash-object failed" };
    entries.push(`120000 ${sha}\t${link.path}\0`);
  }
  const env = { ...process.env, GIT_INDEX_FILE: scratch };
  if (git(tree, ["read-tree", "--empty"], { env }) === undefined) {
    return { ok: false, reason: `cannot write ${scratch} (read-only git dir?)` };
  }
  if (
    entries.length > 0 &&
    git(tree, ["update-index", "--add", "-z", "--index-info"], { env, input: entries.join("") }) ===
      undefined
  ) {
    return { ok: false, reason: `git update-index failed on ${scratch}` };
  }
  const written = git(tree, ["write-tree"], { env })?.trim();
  return written ? { ok: true, tree: written } : { ok: false, reason: "git write-tree failed" };
}

/** `fingerprintTree`'s hash, or `undefined` when it cannot be computed. */
export function computeWorktreeTree(tree: string): string | undefined {
  const result = fingerprintTree(tree);
  return result.ok ? result.tree : undefined;
}

/** Parses the evidence log, skipping blank or malformed lines (fail-soft:
 * a torn line must not make every other line unreadable). Newest last. */
export function readEvidenceLog(path: string): EvidenceLine[] {
  if (!existsSync(path)) return [];
  const lines: EvidenceLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = EvidenceLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
    } catch {
      // malformed line: ignored
    }
  }
  return lines;
}

export type EvidenceVerdict =
  | { ok: true; evidence: RecordedEvidence }
  | { ok: false; why: string; fix: string };

export interface ValidateEvidenceInput {
  root: StateRoot;
  feature: string;
  id: string;
  /** The criterion's CURRENT command. */
  command: string;
  /** `impl_<feature>.json`'s declared worktree, if any. */
  implWorktree?: string;
  /** Required current identity for source-backed slices; never synthesize from a log. */
  deliveryBinding?: DeliveryEvidenceBinding;
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Key-order independent comparison over the schema's keys (all values are primitives). */
function sameBinding(left?: DeliveryEvidenceBinding, right?: DeliveryEvidenceBinding): boolean {
  if (!left || !right) return left === right;
  const keys = Object.keys(
    DeliveryEvidenceBindingSchema.shape,
  ) as (keyof DeliveryEvidenceBinding)[];
  return keys.every((key) => left[key] === right[key]);
}

/**
 * Claude Code persists `cd`, so the recorded cwd of a `cd <dir> && ...`
 * criterion is `<tree>/<dir>`. Returns that `<dir>` only for a strict leading
 * `cd <dir> &&`: relative, plain segments (no `..`, `~`, quotes, variables,
 * globs or other shell syntax).
 */
function leadingCdDir(command: string): string | undefined {
  const dir = /^cd[ \t]+([^\s&;|<>$`"'\\*?[\]{}()~]+)[ \t]*&&/.exec(command)?.[1];
  if (dir === undefined || dir.startsWith("/")) return undefined;
  const segments = dir.split("/");
  return segments.some((s) => s === "" || s === "." || s === "..") ? undefined : dir;
}

/** Real path of the criterion's leading `cd` target, only if it stays inside `tree`. */
function cdTargetCwd(tree: string, command: string): string | undefined {
  const dir = leadingCdDir(command);
  if (dir === undefined) return undefined;
  const target = real(join(tree, dir));
  return target?.startsWith(`${tree}${sep}`) ? target : undefined;
}

/** Why one command-matching candidate is not valid, or `undefined` if it is. */
function candidateProblem(
  line: EvidenceLine,
  accepted: readonly string[],
  command: string,
  binding?: DeliveryEvidenceBinding,
): { why: string; tree: string } | undefined {
  const tree = real(line.tree);
  if (tree === undefined) return { why: `tree ${line.tree} no longer exists`, tree: line.tree };
  if (!accepted.includes(tree)) {
    return { why: `ran in ${line.tree}, not this feature's checkout/worktree`, tree };
  }
  const cwd = real(line.cwd);
  if (cwd !== tree && (cwd === undefined || cwd !== cdTargetCwd(tree, command))) {
    return { why: `ran from ${line.cwd}, not the tree root ${tree}`, tree };
  }
  const head = readHead(tree);
  if (head !== line.head && !binding) {
    return {
      why: `tree changed since the run (HEAD ${line.head.slice(0, 7) || "none"} → ${head.slice(0, 7) || "none"})`,
      tree,
    };
  }
  if (!sameBinding(line.deliveryBinding, binding))
    return { why: "producer delivery authority or criterion definition changed", tree };
  const fingerprint = fingerprintTree(tree, binding);
  if (!fingerprint.ok) {
    return { why: `cannot compute the tree fingerprint: ${fingerprint.reason}`, tree };
  }
  if (fingerprint.tree !== line.worktreeTree) {
    return { why: "tree changed since the run (uncommitted changes)", tree };
  }
  return undefined;
}

/**
 * Finds the newest evidence line that still holds for `id`: same command as
 * the criterion today, run at the root of this feature's checkout/worktree,
 * on the same HEAD and the same content fingerprint. Never runs `command`.
 */
export function validateEvidence(input: ValidateEvidenceInput): EvidenceVerdict {
  const { root, feature, id, command } = input;
  const lines = readEvidenceLog(
    stateArtifactPath(root, `workplan_${feature}.evidence.jsonl`),
  ).filter((l) => l.feature === feature && l.id === id);
  const accepted = [real(root.cwd), input.implWorktree ? real(input.implWorktree) : undefined]
    .filter((p): p is string => p !== undefined)
    .map((p) => resolve(p));
  const treeRoot = accepted[0] ?? root.cwd;
  const rerun = (tree: string): string =>
    `from ${tree}, run exactly:\n         ${command}\n` +
    `       then: navori plan update ${feature} --progress ${id}=cumplido`;

  if (lines.length === 0) {
    return {
      ok: false,
      why: "no run recorded",
      fix:
        `${rerun(treeRoot)}\n` +
        "       (large repos: the hook computes a tree fingerprint after the run and can be " +
        "killed mid-way, leaving no line; rerun the command, or check the evidence log exists)",
    };
  }
  const sameCommand = lines.filter((l) => l.command === command).reverse();
  if (sameCommand.length === 0) {
    return { ok: false, why: "recorded for a different command", fix: rerun(treeRoot) };
  }
  let firstProblem: { why: string; tree: string } | undefined;
  for (const line of sameCommand) {
    const problem = candidateProblem(line, accepted, command, input.deliveryBinding);
    if (problem === undefined) {
      return {
        ok: true,
        evidence: {
          kind: "recorded",
          command: line.command,
          ranAt: line.ts,
          tree: line.tree,
          head: line.head,
          worktreeTree: line.worktreeTree,
          dirty: line.dirty,
        },
      };
    }
    firstProblem ??= problem;
  }
  const problem = firstProblem!;
  return {
    ok: false,
    why: problem.why,
    fix:
      rerun(accepted.includes(problem.tree) ? problem.tree : treeRoot) +
      (problem.why.startsWith("cannot compute") ? `\n       (${problem.why})` : ""),
  };
}
