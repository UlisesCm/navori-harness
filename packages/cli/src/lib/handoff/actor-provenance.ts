/** Native designated producer ownership, under the trusted local writer contract. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { contentIdentity } from "../primitives/content-identity.ts";
import {
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
} from "../primitives/state-root.ts";
import { ImplHandoffSchema } from "./schema.ts";
import { WorkplanSchema } from "../plan/schema.ts";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";
import { hasParallelAuthority, isDerivedHandoffPath, parallelOwnershipValid } from "./parallel.ts";

const id = z.string().regex(/^[0-9a-f-]{36}$/);
/** Context and native source bindings; binding changes never establish independence. */
export const NativeActorSchema = z.strictObject({
  host: z.literal("codex"),
  thread: id,
  root: id,
  parent: id,
  role: z.enum(["implementer", "scribe", "reviewer"]),
  version: z.literal("0.162.1"),
  sourceCwd: z.string(),
  sourceHash: z.string(),
});
export type NativeActor = z.infer<typeof NativeActorSchema>;
const HeaderSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id,
    session_id: id,
    parent_thread_id: id,
    cli_version: z.literal("0.162.1"),
    cwd: z.string(),
    agent_role: NativeActorSchema.shape.role,
    source: z.object({
      subagent: z.object({
        thread_spawn: z.object({
          parent_thread_id: id,
          agent_role: NativeActorSchema.shape.role,
        }),
      }),
    }),
  }),
});
const digest = (raw: string | Buffer): string => createHash("sha256").update(raw).digest("hex");

function commonDir(cwd: string): string {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd, encoding: "utf8", timeout: 2000 },
  );
  if (result.status !== 0) throw new Error("actor checkout unavailable");
  return realpathSync(result.stdout.trim());
}

/** Reads only this native thread's uniquely selected, bounded metadata header. */
export function nativeActor(cwd: string): NativeActor | undefined {
  try {
    const thread = process.env.CODEX_THREAD_ID;
    if (!thread || !id.safeParse(thread).success) return undefined;
    const sessions = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    const candidates: string[] = [];
    // TODO(hygiene): bounded date tree; use host-provided source path if sessions exceed 4096 directories.
    let scanned = 0;
    for (const year of readdirSync(sessions, { withFileTypes: true })) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      for (const month of readdirSync(join(sessions, year.name), { withFileTypes: true })) {
        if (!month.isDirectory() || !/^\d\d$/.test(month.name)) continue;
        for (const day of readdirSync(join(sessions, year.name, month.name), {
          withFileTypes: true,
        })) {
          if (++scanned > 4096) return undefined;
          if (!day.isDirectory() || !/^\d\d$/.test(day.name)) continue;
          const dir = join(sessions, year.name, month.name, day.name);
          for (const file of readdirSync(dir))
            if (file.endsWith(`${thread}.jsonl`)) candidates.push(join(dir, file));
        }
      }
    }
    if (candidates.length !== 1) return undefined;
    const fd = openSync(candidates[0]!, "r");
    const buffer = Buffer.alloc(65536);
    let raw: string;
    try {
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, bytes).indexOf(10);
      if (newline < 0) return undefined;
      raw = buffer.subarray(0, newline).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const parsed = HeaderSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const h = parsed.data.payload;
    const child = h.source.subagent.thread_spawn;
    if (
      h.id !== thread ||
      h.parent_thread_id !== child.parent_thread_id ||
      h.agent_role !== child.agent_role ||
      commonDir(h.cwd) !== commonDir(cwd)
    )
      return undefined;
    return {
      host: "codex",
      thread,
      root: h.session_id,
      parent: h.parent_thread_id,
      role: h.agent_role,
      version: h.cli_version,
      sourceCwd: realpathSync(h.cwd),
      sourceHash: digest(raw),
    };
  } catch {
    return undefined;
  }
}

/** Independence compares context, rather than role or checkout fingerprints. */
export function independentActor(reviewer: NativeActor, producers: NativeActor[]): boolean {
  return (
    reviewer.role === "reviewer" &&
    producers.length > 0 &&
    producers.every(
      (p) =>
        p.root === reviewer.root &&
        !(p.host === reviewer.host && p.root === reviewer.root && p.thread === reviewer.thread),
    )
  );
}

const OwnershipSchema = z.strictObject({
  feature: z.string(),
  cwd: z.string(),
  target: z.string(),
  head: z.string(),
  base: z.string().nullable(),
  fingerprint: z.string(),
  handoff: z.string(),
  actors: z.array(NativeActorSchema).min(1),
  files: z.record(z.string(), z.string()),
});
export type Ownership = z.infer<typeof OwnershipSchema>;

/** Reads the CLI-owned delivery record without promoting missing or historical identities. */
export function readOwnership(cwd: string, feature: string, dir?: string): Ownership | undefined {
  try {
    const root = resolveStateRoot({ cwd, feature, dir });
    const parsed = OwnershipSchema.safeParse(
      JSON.parse(readFileSync(stateArtifactPath(root, `ownership_${feature}.json`), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validates the same publication bytes/base as review-evidence's sameIdentity.
 * HEAD is captured as provenance; committing identical reviewed bytes preserves
 * ownership, while byte/base/handoff drift invalidates it.
 */
export function currentOwnership(
  cwd: string,
  feature: string,
  target: string,
  fingerprint: string,
  head: string,
  base: string | null,
  dir?: string,
): Ownership | undefined {
  const ownership = readOwnership(cwd, feature, dir);
  if (
    !ownership ||
    ownership.cwd !== realpathSync(cwd) ||
    ownership.target !== target ||
    !head ||
    ownership.base !== base
  )
    return undefined;
  try {
    const parallel = hasParallelAuthority(cwd, feature, dir);
    if (
      parallel
        ? !parallelOwnershipValid({ cwd, feature, target, dir }, ownership)
        : ownership.fingerprint !== fingerprint
    )
      return undefined;
    const root = resolveStateRoot({ cwd, feature, dir });
    return digest(readFileSync(stateArtifactPath(root, `impl_${feature}.json`))) ===
      ownership.handoff
      ? ownership
      : undefined;
  } catch {
    return undefined;
  }
}

/** Attests designated implementer ownership, or appends a scribe after allowed prose changes. */
export function attestHandoff(options: {
  cwd: string;
  feature: string;
  target: string;
  dir?: string;
}): { status: "attested" | "error"; message?: string } {
  try {
    if (realpathSync(process.cwd()) !== realpathSync(options.cwd))
      throw new Error("attest must run in the actual target checkout");
    const actor = nativeActor(options.cwd);
    if (!actor || !["implementer", "scribe"].includes(actor.role))
      throw new Error("native designated producer identity unavailable");
    const root = resolveStateRoot(options);
    if (hasParallelAuthority(root.cwd, options.feature, root.dir))
      throw new Error(
        "parallel authority requires finalize-parallel; serial attestation is unavailable",
      );
    const raw = readFileSync(stateArtifactPath(root, `impl_${options.feature}.json`));
    const handoff = ImplHandoffSchema.parse(JSON.parse(raw.toString()));
    const plan = WorkplanSchema.parse(
      JSON.parse(readFileSync(stateArtifactPath(root, `workplan_${options.feature}.json`), "utf8")),
    );
    if (
      handoff.feature !== options.feature ||
      plan.feature !== options.feature ||
      realpathSync(handoff.worktree) !== realpathSync(root.cwd)
    )
      throw new Error("handoff/workplan target mismatch");
    const allowed = new Set(plan.files.map((f) => f.path));
    if (handoff.filesTouched.some((f) => !allowed.has(f)))
      throw new Error("producer files escape approved scope");
    const identity = contentIdentity(root.cwd, { target: options.target });
    if (!identity.ok) throw new Error(`content identity ${identity.reason}`);
    const changed = spawnSync(
      "git",
      ["-c", "core.fsmonitor=false", "diff", "--name-only", identity.base ?? identity.head],
      { cwd: root.cwd, encoding: "utf8", timeout: 2000 },
    );
    const untracked = spawnSync(
      "git",
      ["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard"],
      { cwd: root.cwd, encoding: "utf8", timeout: 2000 },
    );
    const paths = `${changed.stdout}\n${untracked.stdout}`
      .trim()
      .split("\n")
      .filter((p) => p && !isUnderProgressDir(p));
    if (changed.status !== 0 || untracked.status !== 0 || paths.some((f) => !allowed.has(f)))
      throw new Error("diff escapes approved scope");
    const files: Record<string, string> = {};
    for (const path of allowed)
      if (!isUnderProgressDir(path))
        files[path] = existsSync(join(root.cwd, path))
          ? digest(readFileSync(join(root.cwd, path)))
          : "missing";
    let actors = [actor];
    if (actor.role === "scribe") {
      const prior = readOwnership(root.cwd, options.feature, root.dir);
      if (
        !prior ||
        prior.handoff !== digest(raw) ||
        prior.head !== identity.head ||
        prior.base !== identity.base ||
        !prior.actors.some((p) => p.role === "implementer")
      )
        throw new Error("scribe requires the designated implementer ownership");
      const prose = new Set(handoff.markdownRequests.map((r) => r.path));
      for (const [path, hash] of Object.entries(files)) {
        if (hash !== prior.files[path] && !prose.has(path) && !isDerivedHandoffPath(path))
          throw new Error(`scribe changed non-prose ownership: ${path}`);
      }
      actors = [...prior.actors.filter((p) => p.role !== "scribe"), actor];
    }
    const record: Ownership = {
      feature: options.feature,
      cwd: realpathSync(root.cwd),
      target: options.target,
      head: identity.head,
      base: identity.base,
      fingerprint: identity.fingerprint,
      handoff: digest(raw),
      actors,
      files,
    };
    writeStateFileAtomic(root, `ownership_${options.feature}.json`, `${JSON.stringify(record)}\n`);
    return { status: "attested" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "ownership unavailable",
    };
  }
}
