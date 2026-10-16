/** Opt-in parallel delivery under the existing trusted local writer contract. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { readConfig } from "../config/config.ts";
import { resolveDeliveryThresholds } from "../config/schema.ts";
import { WorkplanSchema } from "../plan/schema.ts";
import { contentIdentity } from "../primitives/content-identity.ts";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
  type StateRoot,
} from "../primitives/state-root.ts";
import { checkSpec } from "../spec/check.ts";
import { locateSpecDir } from "../spec/locate.ts";
import { parseRequirementIds } from "../spec/requirements.ts";
import { parseTasks } from "../spec/tasks.ts";
import {
  NativeActorSchema,
  currentOwnership,
  nativeActor,
  type Ownership,
} from "./actor-provenance.ts";
import { ImplHandoffSchema, MarkdownRequestSchema } from "./schema.ts";

const nonempty = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const files = z.record(z.string(), z.string());
const requestSchema = z.strictObject({
  spec: nonempty,
  delivery: z.string().regex(/^E[1-9]\d*$/),
  milestone: z.string().regex(/^M[1-9]\d*$/),
  implementerPaths: z.array(nonempty).min(1),
  markdownRequests: z.array(MarkdownRequestSchema.strict()).min(1),
  derivedPaths: z.array(nonempty),
});
const contractSchema = requestSchema
  .extend({
    formatVersion: z.literal(1),
    runId: z.uuid(),
    feature: nonempty,
    cwd: nonempty,
    branch: nonempty,
    target: nonempty,
    head: z.string().regex(/^[a-f0-9]{40}$/),
    base: z.string().regex(/^[a-f0-9]{40}$/),
    preparedAt: z.iso.datetime(),
    bindings: z.record(z.string(), hash),
    derivedBefore: files,
    readonlyBefore: files,
    previousRunId: z.uuid().optional(),
  })
  .strict();
type Contract = z.infer<typeof contractSchema>;
type Options = { cwd: string; feature: string; target: string; dir?: string };
type FeatureRoot = StateRoot & { feature: string };
type Result = {
  status: "prepared" | "completed" | "finalized" | "ok" | "error";
  runId?: string;
  message?: string;
};
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const name = (feature: string): string => `parallel_${feature}.json`;
const doneName = (c: Contract, role: string): string =>
  `parallel_${c.feature}_${c.runId}_${role}.json`;
const claimName = (c: Contract, role: string): string =>
  `parallel_${c.feature}_${c.runId}_${role}_start.json`;
const finalName = (c: Contract): string => `parallel_${c.feature}_${c.runId}_final.json`;
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error("parallel git identity unavailable");
  return result.stdout.trim();
}

/** Mirrors receipt's read-only base selection without fetching or inventing a remote. */
function targetBase(cwd: string, target: string): string {
  const origin = git(cwd, ["remote"]).split("\n").includes("origin");
  if (!origin && git(cwd, ["branch", "--show-current"]) === target)
    throw new Error("parallel requires a feature branch distinct from its local target");
  return git(cwd, [
    "rev-parse",
    "--verify",
    origin ? `refs/remotes/origin/${target}` : `refs/heads/${target}`,
  ]);
}

/** Rejects traversal and every symlink component, including dangling links. */
function safePath(cwd: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    /[\\\r\n:]/.test(path) ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.split("/").includes(".git")
  )
    throw new Error(`unsafe parallel path: ${path}`);
  let current = cwd;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`parallel symlink: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

/** Hashes regular owned bytes and executable mode without following links. */
function fileHash(cwd: string, path: string): string {
  const full = safePath(cwd, path);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile()) throw new Error(`parallel path is not a regular file: ${path}`);
    return digest(`${stat.mode & 0o111}\0${digest(readFileSync(full))}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}
const hashes = (cwd: string, paths: string[]): Record<string, string> =>
  Object.fromEntries(paths.map((path) => [path, fileHash(cwd, path)]));
const prosePaths = (c: z.infer<typeof requestSchema>): string[] =>
  c.markdownRequests.map((r) => r.path);
const ownedPaths = (c: z.infer<typeof requestSchema>): string[] => [
  ...c.implementerPaths,
  ...prosePaths(c),
  ...c.derivedPaths,
];

/** Exclusive destinations make preparation and each role's completion immutable. */
function exclusive(root: StateRoot, file: string, value: unknown): void {
  ensureStateDirectory(root);
  writeFileSync(stateArtifactPath(root, file), `${JSON.stringify(value)}\n`, { flag: "wx" });
}

function attempt(action: () => Result): Result {
  try {
    return action();
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "parallel evidence unavailable",
    };
  }
}

/** Recognizes approved generated categories, never arbitrary source or human prose. */
export function isDerivedHandoffPath(path: string): boolean {
  return (
    /^(?:AGENTS\.md|CLAUDE\.md|\.pi\/navori\.json|\.codex\/orchestrator\.md)$/.test(path) ||
    /^(?:\.claude\/(?:agents|context|skills|hooks)\/|\.codex\/(?:agents|hooks)\/|\.agents\/skills\/|\.pi\/agents\/)/.test(
      path,
    ) ||
    /^packages\/cli\/src\/engines\/__tests__\/__golden__\/[\w-]+\.snap$/.test(path)
  );
}

/** Ignores only recorded acceptance status/evidence and task checkbox state. */
function bindingHash(path: string, text: string): string {
  if (/\/workplan_[^/]+\.json$/.test(path)) {
    const {
      progress: _progress,
      evidence: _evidence,
      ...contract
    } = JSON.parse(text) as Record<string, unknown>;
    return digest(JSON.stringify(contract));
  }
  return digest(
    path.endsWith("/tasks.md")
      ? text.replace(/^(\s*-\s+)\[[ xX]\](\s+\*\*T\d+\*\*)/gm, "$1[ ]$2")
      : text,
  );
}

/** Reuses plan/spec validators and binds accepted material contract bytes. */
function bindings(root: FeatureRoot, c: z.infer<typeof requestSchema>): Record<string, string> {
  const config = readConfig(join(root.cwd, "navori.config.json"));
  if (!config.harness?.scribeOwnsMarkdown) throw new Error("parallel requires scribeOwnsMarkdown");
  const planPath = stateArtifactPath(root, `workplan_${root.feature}.json`);
  const raw = json(planPath);
  const plan = WorkplanSchema.parse(raw);
  if (plan.level !== 3 || plan.feature !== root.feature)
    throw new Error("parallel requires a valid level-3 workplan for this feature");
  if (plan.feature !== `${c.spec}-${c.delivery.toLowerCase()}`)
    throw new Error("parallel spec delivery feature mismatch");
  const location = locateSpecDir(root.cwd, config.sdd?.specsDir ?? "specs", c.spec);
  if (!location.ok) throw new Error(location.why);
  const specPaths = ["requirements.md", "design.md", "tasks.md"].map((p) =>
    relative(root.cwd, join(location.dir, p)),
  );
  const texts = specPaths.map((p) => readFileSync(safePath(root.cwd, p), "utf8"));
  const tasks = parseTasks(texts[2]!);
  const requirements = parseRequirementIds(texts[0]!);
  const delivery = tasks.deliveries.filter((d) => d.id === c.delivery);
  if (
    tasks.format !== "deliveries" ||
    requirements.length === 0 ||
    !checkSpec(tasks, resolveDeliveryThresholds(config), requirements).ok ||
    delivery.length !== 1 ||
    delivery[0]!.milestones.filter((m) => m.id === c.milestone).length !== 1 ||
    texts.some((t) => !t.trim())
  )
    throw new Error("parallel requires accepted spec/delivery/milestone membership");
  const allowed = new Set(plan.files.map((f) => f.path));
  const paths = ownedPaths(c);
  for (const path of paths) {
    safePath(root.cwd, path);
    if (
      !allowed.has(path) ||
      isUnderProgressDir(path) ||
      specPaths.includes(path) ||
      path === "navori.config.json"
    )
      throw new Error(`parallel path outside independent approved scope: ${path}`);
  }
  if (paths.some((a, i) => paths.some((b, j) => i !== j && (a === b || a.startsWith(`${b}/`)))))
    throw new Error("parallel paths overlap");
  if (
    prosePaths(c).some((p) => ![".md", ".mdx"].includes(extname(p))) ||
    c.implementerPaths.some((p) => [".md", ".mdx"].includes(extname(p))) ||
    c.derivedPaths.some((p) => !isDerivedHandoffPath(p))
  )
    throw new Error("parallel role or derived paths invalid");
  return Object.fromEntries(
    [relative(root.cwd, planPath), "navori.config.json", ...specPaths].map((p) => [
      p,
      bindingHash(p, readFileSync(safePath(root.cwd, p), "utf8")),
    ]),
  );
}

const context = (o: Options): FeatureRoot => ({ ...resolveStateRoot(o), feature: o.feature });

/** Checks active bindings and the actual diff, allowing only declared serial render outputs. */
function validate(
  root: FeatureRoot,
  c: Contract,
  allowCommitted = false,
): ReturnType<typeof contentIdentity> & { ok: true } {
  const identity = contentIdentity(root.cwd, { target: c.target });
  if (!identity.ok) throw new Error("parallel content identity unavailable");
  if (!allowCommitted && git(root.cwd, ["diff", "--cached", "--name-only"]))
    throw new Error("parallel production forbids staging");
  if (
    c.feature !== root.feature ||
    c.cwd !== root.cwd ||
    c.branch !== git(root.cwd, ["branch", "--show-current"]) ||
    (!allowCommitted && identity.head !== c.head) ||
    targetBase(root.cwd, c.target) !== c.base ||
    JSON.stringify(bindings(root, c)) !== JSON.stringify(c.bindings)
  )
    throw new Error("parallel authorization drift");
  const changed =
    `${git(root.cwd, ["diff", "--name-only", "-z", c.head])}\0${git(root.cwd, ["ls-files", "--others", "--exclude-standard", "-z"])}`
      .split("\0")
      .filter((p) => p && !isUnderProgressDir(p));
  const allowed = new Set([
    ...ownedPaths(c),
    ...Object.keys(c.readonlyBefore),
    ...Object.keys(c.bindings).filter((p) => p.endsWith("/tasks.md")),
  ]);
  if (changed.some((p) => !allowed.has(p))) throw new Error("parallel diff escapes approved scope");
  if (
    JSON.stringify(hashes(root.cwd, Object.keys(c.readonlyBefore))) !==
    JSON.stringify(c.readonlyBefore)
  )
    throw new Error("parallel readonly baseline changed");
  ownedPaths(c).forEach((p) => safePath(root.cwd, p));
  return identity;
}

function readContract(root: FeatureRoot): Contract {
  return contractSchema.parse(json(stateArtifactPath(root, name(root.feature))));
}

/** True even for invalid authority: an older serial record must never revive. */
export function hasParallelAuthority(cwd: string, feature: string, dir?: string): boolean {
  const root = resolveStateRoot({ cwd, feature, dir });
  try {
    lstatSync(join(root.path, name(feature)));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Captures prior scope; user approval remains the existing workflow's responsibility. */
export async function prepareParallel(
  options: Options & { request: unknown; supersede?: string },
): Promise<Result> {
  // Load the full validator after actor schemas initialize: it reaches receipt through master plans.
  const { checkWorkplan } = await import("../plan/check.ts");
  return attempt(() => {
    const root = context(options);
    if (
      !checkWorkplan(json(stateArtifactPath(root, `workplan_${options.feature}.json`)), {
        cwd: root.cwd,
        feature: options.feature,
      }).ok
    )
      throw new Error("parallel requires a valid workplan");
    const request = requestSchema.parse(options.request);
    const previous = hasParallelAuthority(root.cwd, root.feature, root.dir)
      ? readContract(root)
      : undefined;
    if (previous) {
      if (options.supersede !== previous.runId || previous.target !== options.target)
        throw new Error("explicit --supersede of the active parallel run is required");
      const inheritedFiles = Object.assign(
        {},
        previous.readonlyBefore,
        ...completions(root, previous, true).map((r) => r.files),
      ) as Record<string, string>;
      if (
        Object.entries(inheritedFiles).some(
          ([p, hash]) => !ownedPaths(request).includes(p) && fileHash(root.cwd, p) !== hash,
        ) ||
        previous.derivedPaths.some((p) => !request.derivedPaths.includes(p))
      )
        throw new Error("successor must preserve readonly bytes and retain derived scope");
    } else if (options.supersede) throw new Error("no parallel run to supersede");
    const identity = contentIdentity(root.cwd, { target: options.target });
    if (!identity.ok) throw new Error("parallel requires available HEAD and target/base");
    const c: Contract = {
      ...request,
      formatVersion: 1,
      feature: options.feature,
      cwd: root.cwd,
      target: options.target,
      head: identity.head,
      base: targetBase(root.cwd, options.target),
      branch: git(root.cwd, ["branch", "--show-current"]),
      preparedAt: new Date().toISOString(),
      runId: randomUUID(),
      bindings: bindings(root, request),
      derivedBefore: hashes(root.cwd, request.derivedPaths),
      readonlyBefore: {},
      ...(previous ? { previousRunId: previous.runId } : {}),
    };
    if (!c.branch) throw new Error("parallel requires a named branch");
    const dirty =
      `${git(root.cwd, ["diff", "--name-only", "-z", "HEAD"])}\0${git(root.cwd, ["ls-files", "--others", "--exclude-standard", "-z"])}`
        .split("\0")
        .filter((p) => p && !isUnderProgressDir(p));
    const inherited = new Set(
      previous ? [...ownedPaths(previous), ...Object.keys(previous.readonlyBefore)] : [],
    );
    const bookkeeping = (p: string): boolean => p.endsWith("/tasks.md") && p in c.bindings;
    if (dirty.some((p) => !inherited.has(p) && !bookkeeping(p)) || identity.indexDiverges)
      throw new Error("parallel preparation requires a clean delivery snapshot");
    c.readonlyBefore = hashes(
      root.cwd,
      dirty.filter((p) => !ownedPaths(c).includes(p) && !bookkeeping(p)),
    );
    validate(root, c);
    exclusive(root, `parallel_${c.feature}_${c.runId}_authorization.json`, c);
    if (previous) {
      exclusive(root, `parallel_${c.feature}_${previous.runId}_successor.json`, { runId: c.runId });
      writeStateFileAtomic(root, name(options.feature), `${JSON.stringify(c)}\n`);
    } else exclusive(root, name(options.feature), c);
    return { status: "prepared", runId: c.runId };
  });
}

/** Parallel preflight deliberately does not manufacture a final producer handoff. */
export function checkParallel(options: Options): Result {
  return attempt(() => {
    const root = context(options);
    const c = readContract(root);
    if (c.target !== options.target) throw new Error("parallel target mismatch");
    production(root, c);
    return { status: "ok", runId: c.runId };
  });
}

/** All producer entrypoints retain the same pre-render barrier. */
function production(root: FeatureRoot, c: Contract): void {
  validate(root, c);
  if (JSON.stringify(hashes(root.cwd, c.derivedPaths)) !== JSON.stringify(c.derivedBefore))
    throw new Error("render must wait for both producers");
}

// Construct lazily: actor-provenance also consults parallel authority at consumer time.
const claimSchema = () =>
  z.strictObject({
    runId: z.uuid(),
    authorizationDigest: hash,
    actor: NativeActorSchema,
    startedAt: z.iso.datetime(),
  });
const completionSchema = () =>
  z.strictObject({
    runId: z.uuid(),
    authorizationDigest: hash,
    role: z.enum(["implementer", "scribe"]),
    actor: NativeActorSchema,
    status: z.enum(["DONE", "BLOCKED"]),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    blockers: z.array(nonempty),
    files,
  });
type Completion = z.infer<ReturnType<typeof completionSchema>>;

/** Starts a native role's observed work interval; no caller identity or timestamp is accepted. */
export function beginParallel(options: Options & { runId: string }): Result {
  return attempt(() => {
    const root = context(options);
    const c = readContract(root);
    const actor = nativeActor(root.cwd);
    if (realpathSync(process.cwd()) !== root.cwd || !actor || actor.role === "reviewer")
      throw new Error("parallel begin requires the native producer in the target checkout");
    if (options.runId !== c.runId || options.target !== c.target)
      throw new Error("parallel run or target mismatch");
    production(root, c);
    exclusive(root, claimName(c, actor.role), {
      runId: c.runId,
      authorizationDigest: digest(JSON.stringify(c)),
      actor,
      startedAt: new Date().toISOString(),
    });
    return { status: "ok", runId: c.runId };
  });
}

/** Validates an immutable start against the current run, role and preparation. */
function claim(
  root: FeatureRoot,
  c: Contract,
  role: string,
): z.infer<ReturnType<typeof claimSchema>> {
  const record = claimSchema().parse(json(stateArtifactPath(root, claimName(c, role))));
  if (
    record.runId !== c.runId ||
    record.authorizationDigest !== digest(JSON.stringify(c)) ||
    record.actor.role !== role ||
    record.startedAt < c.preparedAt
  )
    throw new Error("parallel claim is stale or belongs to another role/run");
  return record;
}

/** Each native role seals only its own paths, in a separate exclusive file. */
export function completeParallel(
  options: Options & { runId: string; status: string; reason?: string },
): Result {
  return attempt(() => {
    const root = context(options);
    const c = readContract(root);
    const actor = nativeActor(root.cwd);
    if (realpathSync(process.cwd()) !== root.cwd || !actor || actor.role === "reviewer")
      throw new Error("parallel completion requires the native producer in the target checkout");
    if (options.runId !== c.runId || options.target !== c.target)
      throw new Error("parallel run or target mismatch");
    production(root, c);
    const status = z.enum(["DONE", "BLOCKED"]).parse(options.status);
    const start = claim(root, c, actor.role);
    if (JSON.stringify(start.actor) !== JSON.stringify(actor))
      throw new Error("parallel completion belongs to another native claim");
    const blockers = status === "BLOCKED" ? [nonempty.parse(options.reason)] : [];
    const record: Completion = {
      runId: c.runId,
      authorizationDigest: digest(JSON.stringify(c)),
      role: actor.role,
      actor,
      status,
      startedAt: start.startedAt,
      completedAt: new Date().toISOString(),
      blockers,
      files: hashes(root.cwd, actor.role === "implementer" ? c.implementerPaths : prosePaths(c)),
    };
    exclusive(root, doneName(c, actor.role), record);
    return { status: "completed", runId: c.runId };
  });
}

/** Verifies both immutable completions and their unchanged owned bytes. */
function completions(root: FeatureRoot, c: Contract, succeeding = false): Completion[] {
  const records = (["implementer", "scribe"] as const).map((role) => {
    const record = completionSchema().parse(json(stateArtifactPath(root, doneName(c, role))));
    const start = claim(root, c, role);
    const expected = hashes(root.cwd, role === "implementer" ? c.implementerPaths : prosePaths(c));
    if (
      record.runId !== c.runId ||
      record.authorizationDigest !== digest(JSON.stringify(c)) ||
      record.role !== role ||
      record.actor.role !== role ||
      (!succeeding && (record.status !== "DONE" || record.blockers.length)) ||
      record.startedAt !== start.startedAt ||
      record.completedAt < start.startedAt ||
      JSON.stringify(record.actor) !== JSON.stringify(start.actor) ||
      (!succeeding && JSON.stringify(record.files) !== JSON.stringify(expected))
    )
      throw new Error(`parallel ${role} completion invalid or changed after DONE`);
    return record;
  });
  if (
    records[0]!.actor.root !== records[1]!.actor.root ||
    records[0]!.actor.thread === records[1]!.actor.thread
  )
    throw new Error("parallel requires two distinct native producers in the same session");
  return records;
}

/** Serial join after official render/shared checks; emits the existing ownership interface. */
export function finalizeParallel(options: Options): Result {
  return attempt(() => {
    const root = context(options);
    const c = readContract(root);
    if (options.target !== c.target || realpathSync(process.cwd()) !== root.cwd)
      throw new Error("parallel finalization target mismatch");
    const identity = validate(root, c);
    const records = completions(root, c);
    const raw = readFileSync(stateArtifactPath(root, `impl_${c.feature}.json`));
    const handoff = ImplHandoffSchema.parse(JSON.parse(raw.toString()));
    const actor = nativeActor(root.cwd);
    if (
      !actor ||
      !records.some(
        (r) => JSON.stringify(r.actor) === JSON.stringify(actor) && r.role === "implementer",
      ) ||
      handoff.feature !== c.feature ||
      handoff.status !== "DONE" ||
      handoff.blockers.length ||
      handoff.verification.exitCode !== 0 ||
      handoff.head !== c.head ||
      handoff.branch !== c.branch ||
      realpathSync(handoff.worktree) !== c.cwd ||
      JSON.stringify(handoff.markdownRequests) !== JSON.stringify(c.markdownRequests) ||
      handoff.filesTouched.some((p) => !ownedPaths(c).includes(p))
    )
      throw new Error(
        "parallel requires the real final implementer handoff and designated native implementer",
      );
    const record: Ownership = {
      feature: c.feature,
      cwd: c.cwd,
      target: c.target,
      head: c.head,
      base: identity.base,
      fingerprint: identity.fingerprint,
      handoff: digest(raw),
      actors: records.map((r) => r.actor),
      files: hashes(root.cwd, ownedPaths(c)),
    };
    writeStateFileAtomic(root, `ownership_${c.feature}.json`, `${JSON.stringify(record)}\n`);
    exclusive(root, finalName(c), {
      authorizationDigest: digest(JSON.stringify(c)),
      ownershipDigest: digest(JSON.stringify(record)),
      finalizedAt: new Date().toISOString(),
    });
    return { status: "finalized", runId: c.runId };
  });
}

/** Consumers refuse active, failed or stale authority even when serial ownership predates it. */
export function parallelOwnershipValid(options: Options, ownership: Ownership): boolean {
  try {
    const root = context(options);
    const c = readContract(root);
    validate(root, c, true);
    completions(root, c);
    const final = z
      .strictObject({
        authorizationDigest: hash,
        ownershipDigest: hash,
        finalizedAt: z.iso.datetime(),
      })
      .parse(json(stateArtifactPath(root, finalName(c))));
    return (
      options.target === c.target &&
      final.authorizationDigest === digest(JSON.stringify(c)) &&
      final.ownershipDigest === digest(JSON.stringify(ownership)) &&
      JSON.stringify(ownership.files) === JSON.stringify(hashes(root.cwd, ownedPaths(c)))
    );
  } catch {
    return false;
  }
}

/** Supplies current CLI-owned intervals for a live validator; caller summaries are not evidence. */
export function parallelLiveEvidence(
  options: Options,
):
  | { status: "ok"; authorization: Contract; finalizedAt: string; producers: Completion[] }
  | { status: "error"; message: string } {
  try {
    const root = context(options);
    const c = readContract(root);
    const identity = validate(root, c, true);
    if (
      !currentOwnership(
        root.cwd,
        c.feature,
        options.target,
        identity.fingerprint,
        identity.head,
        identity.base,
        root.dir,
      )
    )
      throw new Error("current finalized parallel ownership unavailable");
    return {
      status: "ok",
      authorization: c,
      finalizedAt: (json(stateArtifactPath(root, finalName(c))) as { finalizedAt: string })
        .finalizedAt,
      producers: completions(root, c),
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "live evidence unavailable",
    };
  }
}
