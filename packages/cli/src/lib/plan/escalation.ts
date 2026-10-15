/** Bounded, immutable workflow escalation acknowledgements; never review/effect authority. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  fstatSync,
  linkSync,
  opendirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Entry = z
  .object({
    ts: z.string().datetime({ offset: true }),
    reviewHash: Hash,
    verdict: z.literal("CHANGES_REQUESTED"),
  })
  .strict();
const Reset = z
  .object({
    ts: z.string().datetime({ offset: true }),
    kind: z.literal("reset"),
    approvedBy: z.literal("user"),
    reason: z.string().trim().min(1).max(4096),
    rejectionsBefore: z.number().int().min(2),
  })
  .strict();
const HistoryEntry = z.union([Entry, Reset]);
const Binding = z
  .object({
    cwd: z.string(),
    feature: z.string(),
    level: z.number().int().min(2).max(3),
    opening: z.string(),
    hashes: z.array(Hash).min(2).max(4096),
    files: z.array(z.object({ path: z.string(), hash: Hash.nullable() })).max(8),
  })
  .strict();
const Decision = z.string().trim().min(1).max(4096);
const Ack = z.object({ binding: Binding, decision: Decision }).strict();
const Reference = z.string().regex(/^(base|grant):[a-f0-9]{64}$/);
const Continuation = z
  .object({
    version: z.literal(1),
    kind: z.literal("plan-continuation"),
    epoch: Hash,
    ordinal: z.number().int().min(1).max(32),
    predecessor: Reference,
    authorizationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    decision: Decision,
    binding: Binding,
    snapshot: Hash,
  })
  .strict();
const Burn = z
  .object({
    version: z.literal(1),
    kind: z.literal("plan-continuation-burn"),
    reference: Reference,
    snapshot: Hash,
  })
  .strict();
const RECORD_BYTES = 64 * 1024;
const LINEAGE_BYTES = 2 * 1024 * 1024;
const ENUMERATION_LIMIT = 512;

/** Explicit operator request; the identifier represents intent, not authenticated identity. */
export interface ContinuationRequest {
  continueAfter: string;
  authorizationId: string;
  snapshot: string;
}
/** Read-only reconciliation separates stored authority from the currently validated scope. */
export interface EscalationInspection {
  status: "inspected";
  feature: string;
  currentSnapshot: string;
  terminal: {
    reference: string;
    ordinal: number;
    status: "consumed" | "unconsumed";
    storedSnapshot: string;
    predecessor?: string;
    authorizationId?: string;
  };
  eligiblePredecessor?: string;
}
type Grant = EscalationInspection["terminal"] & { binding: EscalationBinding };
type Lineage = { grants: Grant[]; visited: Set<string>; bytes: number };

/** Bytes captured once for both validation and digesting, including absent review/log files. */
export interface PlanSnapshot {
  path: string;
  content: string | null;
}
/** Scope digests separate from the stable complete-rejection epoch identity. */
export type EscalationBinding = z.infer<typeof Binding>;
/** Validated legacy log hashes and the exact current review/log bytes. */
export interface RejectionHistory {
  files: PlanSnapshot[];
  hashes: string[];
  activeTimestamps: string[];
}

/** Reads a regular file through a bounded descriptor; only ENOENT is optional absence. */
export function readPlanSnapshot(path: string, maximum: number = MAX_BYTES): PlanSnapshot {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { path, content: null };
    throw cause;
  }
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > maximum)
      throw new Error(`unsafe or oversized plan state: ${path}`);
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > maximum) throw new Error(`oversized plan state: ${path}`);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    return { path, content };
  } finally {
    closeSync(fd);
  }
}

/** Strict legacy JSONL compatibility: incomplete/invalid history cannot lower the cap. */
export function readRejectionHistory(root: StateRoot, feature: string): RejectionHistory {
  const log = readPlanSnapshot(
    stateArtifactPath(root, `workplan_${feature}.gate.jsonl`),
    MAX_LOG_BYTES,
  );
  const review = readPlanSnapshot(stateArtifactPath(root, `review_${feature}.md`));
  const text = log.content ?? "";
  if (text && !text.endsWith("\n")) throw new Error("incomplete rejection history");
  const hashes = new Set<string>();
  let activeTimestamps: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 8192) throw new Error("oversized rejection history entry");
    const entry = HistoryEntry.parse(JSON.parse(line));
    if ("kind" in entry) activeTimestamps = [];
    else if (!hashes.has(entry.reviewHash)) {
      hashes.add(entry.reviewHash);
      activeTimestamps.push(entry.ts);
    }
  }
  if (hashes.size > 4096) throw new Error("oversized rejection history");
  reconcileHistory(root.cwd, feature, [...hashes]);
  return { files: [log, review], hashes: [...hashes].sort(), activeTimestamps };
}

/** Appends only a new current rejection; preserves every original historical byte. */
export function recordRejections(root: StateRoot, feature: string): RejectionHistory {
  const history = readRejectionHistory(root, feature);
  const review = history.files[1]!.content ?? "";
  if (
    [...review.matchAll(/\*\*Final verdict:\*\*\s*([A-Z_]+)/g)].at(-1)?.[1] === "CHANGES_REQUESTED"
  ) {
    const reviewHash = digest(review);
    if (!history.hashes.includes(reviewHash)) {
      if (!snapshotsMatch(history.files))
        throw new Error("rejection history changed during validation");
      ensureStateDirectory(root);
      appendFileSync(
        stateArtifactPath(root, `workplan_${feature}.gate.jsonl`),
        `${JSON.stringify({ ts: new Date().toISOString(), reviewHash, verdict: "CHANGES_REQUESTED" })}\n`,
      );
      return readRejectionHistory(root, feature);
    }
  }
  return history;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Captures hashes of the exact bytes already validated by the normal gate. */
export function escalationBinding(
  root: StateRoot,
  feature: string,
  level: number,
  opening: string,
  history: RejectionHistory,
  files: PlanSnapshot[],
): EscalationBinding {
  return Binding.parse({
    cwd: root.cwd,
    feature,
    level,
    opening,
    hashes: history.hashes,
    files: [...files, ...history.files].map((file) => ({
      path: file.path,
      hash: file.content === null ? null : digest(file.content),
    })),
  });
}

/** Compares all captured input bytes against current bounded state. */
export function snapshotsMatch(files: PlanSnapshot[]): boolean {
  return files.every((file) => readPlanSnapshot(file.path).content === file.content);
}

/** Reconciles scope digests without claiming filesystem transaction isolation. */
function unchanged(binding: EscalationBinding): boolean {
  return binding.files.every((file) => {
    const snapshot = readPlanSnapshot(file.path);
    return (snapshot.content === null ? null : digest(snapshot.content)) === file.hash;
  });
}

/** Resolves one immutable epoch in the checkout's canonical neutral state directory. */
function paths(binding: EscalationBinding): {
  root: StateRoot;
  ack: string;
  consumed: string;
} {
  // Epoch identity excludes mutable scope/decision/clock: none can restore a spent attempt.
  const epoch = digest(JSON.stringify([binding.cwd, binding.feature, binding.hashes]));
  const root = resolveStateRoot({
    cwd: binding.cwd,
    feature: binding.feature,
    dir: ".navori/state/handoffs",
  });
  return {
    root,
    ack: stateArtifactPath(root, `escalation_${epoch}.json`),
    consumed: stateArtifactPath(root, `escalation_${epoch}.consumed`),
  };
}

/** Records the retained user workflow decision once; repeated epochs are never renewed. */
export function acknowledgeEscalation(
  binding: EscalationBinding,
  decision: string,
): { status: "acknowledged" | "consumed"; feature: string } {
  const record = Ack.parse({ binding, decision });
  const state = paths(binding);
  reconcileHistory(binding.cwd, binding.feature, binding.hashes);
  if (!unchanged(binding)) throw new Error("escalation inputs changed during acknowledgement");
  ensureStateDirectory(state.root);
  if (existsSync(state.consumed)) return { status: "consumed", feature: binding.feature };
  try {
    writeFileSync(state.ack, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  requireAcknowledgement(binding);
  if (!unchanged(binding)) throw new Error("escalation inputs changed during acknowledgement");
  return { status: "acknowledged", feature: binding.feature };
}

/** Pins the validated immutable terminal and its byte budget before any dispatch callback. */
function acknowledgedLineage(binding: EscalationBinding): Lineage {
  reconcileHistory(binding.cwd, binding.feature, binding.hashes);
  const lineage = readLineage(binding);
  const tip = lineage.grants.at(-1)!;
  if (tip.status === "consumed") throw new Error("escalation acknowledgement already consumed");
  if (tip.storedSnapshot !== snapshotDigest(binding))
    throw new Error("escalation acknowledgement binding changed");
  return lineage;
}

/** Validates only the actual current terminal grant; never generates a successor. */
export function requireAcknowledgement(binding: EscalationBinding): void {
  acknowledgedLineage(binding);
}

/** Exclusive permanent burn, bracketed by scope/dispatch checks; crash or drift stays spent. */
export function consumeEscalation(
  binding: EscalationBinding,
  dispatchUnchanged: () => boolean,
): void {
  const lineage = acknowledgedLineage(binding);
  const tip = lineage.grants.at(-1)!;
  if (!dispatchUnchanged() || !unchanged(binding))
    throw new Error("escalation inputs changed before consumption");
  const state = paths(binding);
  ensureStateDirectory(state.root);
  if (tip.ordinal > 0) {
    const burn = Burn.parse({
      version: 1,
      kind: "plan-continuation-burn",
      reference: tip.reference,
      snapshot: tip.storedSnapshot,
    });
    if (lineage.bytes + Buffer.byteLength(`${JSON.stringify(burn)}\n`) > LINEAGE_BYTES)
      throw new Error("oversized escalation lineage");
    if (
      !publish(
        state.root,
        burnPath(state.root, tip.reference),
        burn,
        () => dispatchUnchanged() && unchanged(binding),
      )
    )
      throw new Error("escalation acknowledgement already consumed");
  } else {
    const fd = openSync(state.consumed, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(binding)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  if (!dispatchUnchanged() || !unchanged(binding))
    throw new Error(
      "escalation inputs changed after consumption; acknowledgement remains consumed",
    );
}

/** Domain-separated digest of validated, ordered workflow bytes; never a fresh disk read. */
export function snapshotDigest(binding: EscalationBinding): string {
  return digest(JSON.stringify(["plan-snapshot-v1", checkedBinding(binding)]));
}

function epoch(binding: EscalationBinding): string {
  return digest(JSON.stringify([binding.cwd, binding.feature, binding.hashes]));
}

/** Rejects noncanonical rejection sets instead of silently selecting another epoch. */
function checkedBinding(value: unknown): EscalationBinding {
  const binding = Binding.parse(value);
  if (
    JSON.stringify(binding.hashes) !== JSON.stringify([...new Set(binding.hashes)].sort()) ||
    new Set(binding.files.map((file) => file.path)).size !== binding.files.length
  )
    throw new Error("noncanonical escalation binding");
  return binding;
}

function successorPath(root: StateRoot, reference: string): string {
  Reference.parse(reference);
  return stateArtifactPath(root, `escalation_continuation_${reference.split(":")[1]}.json`);
}

function burnPath(root: StateRoot, reference: string): string {
  Reference.parse(reference);
  return stateArtifactPath(root, `escalation_burn_${reference.split(":")[1]}.json`);
}

/** Complete-file, no-replace publication. A post-link failure is uncertain and stays published. */
function publish(
  root: StateRoot,
  destination: string,
  value: unknown,
  unchangedInputs: () => boolean,
): boolean {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > RECORD_BYTES) throw new Error("oversized continuation record");
  ensureStateDirectory(root);
  const temporary = stateArtifactPath(root, `escalation_private_${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  let published = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    if (!unchangedInputs()) throw new Error("escalation inputs changed before publication");
    // Revalidate containment immediately before the filesystem publication primitive.
    ensureStateDirectory(root);
    try {
      linkSync(temporary, destination);
      published = true;
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw cause;
    }
    const directory = openSync(root.path, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return true;
  } catch (cause: unknown) {
    if (published)
      throw new Error("continuation publication uncertain; inspect retained state", { cause });
    throw cause;
  } finally {
    closeSync(fd);
    // Only this invocation's private temporary is eligible for cleanup, never a published slot.
    unlinkSync(temporary);
  }
}

/** Strict bounded ancestry. The budget includes legacy, successor and burn bytes. */
function readLineage(binding: EscalationBinding): Lineage {
  checkedBinding(binding);
  const state = paths(binding);
  const visited = new Set<string>();
  let total = 0;
  const read = (path: string, maximum = RECORD_BYTES): string | null => {
    const text = readPlanSnapshot(path, maximum).content;
    if (text !== null) {
      visited.add(path);
      total += Buffer.byteLength(text);
      if (total > LINEAGE_BYTES) throw new Error("oversized escalation lineage");
    }
    return text;
  };
  const text = read(state.ack, MAX_BYTES);
  if (text === null) throw new Error("escalate to the user, then run navori plan acknowledge");
  const ack = Ack.parse(JSON.parse(text));
  checkedBinding(ack.binding);
  if (epoch(ack.binding) !== epoch(binding)) throw new Error("legacy escalation epoch mismatch");
  const spent = read(state.consumed, MAX_BYTES);
  if (
    spent !== null &&
    JSON.stringify(checkedBinding(JSON.parse(spent))) !== JSON.stringify(ack.binding)
  )
    throw new Error("invalid legacy consumption binding");
  const grants: Grant[] = [
    {
      reference: `base:${digest(JSON.stringify(["plan-base-v1", epoch(binding), digest(text), spent === null ? null : digest(spent)]))}`,
      ordinal: 0,
      status: spent === null ? "unconsumed" : "consumed",
      storedSnapshot: snapshotDigest(ack.binding),
      binding: ack.binding,
    },
  ];
  const ids = new Set<string>();
  for (;;) {
    const parent = grants.at(-1)!;
    const childText = read(successorPath(state.root, parent.reference));
    if (childText === null) break;
    if (parent.status !== "consumed" || grants.length > 32)
      throw new Error("invalid or exhausted continuation ancestry");
    const child = Continuation.parse(JSON.parse(childText));
    checkedBinding(child.binding);
    if (
      child.epoch !== epoch(binding) ||
      epoch(child.binding) !== epoch(binding) ||
      child.predecessor !== parent.reference ||
      child.ordinal !== grants.length ||
      child.snapshot !== snapshotDigest(child.binding) ||
      ids.has(child.authorizationId)
    )
      throw new Error("invalid continuation ancestry");
    ids.add(child.authorizationId);
    const reference = `grant:${digest(JSON.stringify(["plan-grant-v1", child]))}`;
    const burnText = read(burnPath(state.root, reference));
    if (burnText !== null) {
      const burn = Burn.parse(JSON.parse(burnText));
      if (burn.reference !== reference || burn.snapshot !== child.snapshot)
        throw new Error("invalid continuation burn");
    }
    grants.push({
      reference,
      ordinal: child.ordinal,
      status: burnText === null ? "unconsumed" : "consumed",
      storedSnapshot: child.snapshot,
      predecessor: child.predecessor,
      authorizationId: child.authorizationId,
      binding: child.binding,
    });
  }
  return { grants, visited, bytes: total };
}

/** Bounded neutral-state reconciliation runs even below the two-rejection fast path.
 * Unattributable malformed candidates deny conservatively; private temporaries are inert.
 */
function reconcileHistory(cwd: string, feature: string, hashes: string[]): void {
  const root = resolveStateRoot({ cwd, feature, dir: ".navori/state/handoffs" });
  if (!existsSync(root.path)) return;
  const candidates: { path: string; name: string; binding?: EscalationBinding }[] = [];
  let entries = 0,
    bytes = 0;
  const names: string[] = [];
  const directory = opendirSync(root.path);
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (names.length === 8192) throw new Error("escalation directory enumeration limit exceeded");
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  for (const name of names) {
    if (!name.startsWith("escalation_") || /^escalation_private_[a-f0-9-]{36}\.tmp$/.test(name))
      continue;
    if (++entries > ENUMERATION_LIMIT) throw new Error("escalation enumeration limit exceeded");
    const path = stateArtifactPath(root, name);
    const text = readPlanSnapshot(path, MAX_BYTES).content;
    if (text === null) throw new Error("escalation state changed during enumeration");
    bytes += Buffer.byteLength(text);
    if (bytes > 16 * 1024 * 1024) throw new Error("escalation enumeration byte limit exceeded");
    const raw: unknown = JSON.parse(text);
    let binding: EscalationBinding | undefined;
    if (/^escalation_[a-f0-9]{64}\.json$/.test(name)) {
      binding = checkedBinding(Ack.parse(raw).binding);
      if (name !== `escalation_${epoch(binding)}.json`)
        throw new Error("misnamed legacy acknowledgement");
    } else if (/^escalation_[a-f0-9]{64}\.consumed$/.test(name)) {
      binding = checkedBinding(raw);
      if (name !== `escalation_${epoch(binding)}.consumed`)
        throw new Error("misnamed legacy consumption");
    } else if (/^escalation_continuation_[a-f0-9]{64}\.json$/.test(name)) {
      if (Buffer.byteLength(text) > RECORD_BYTES) throw new Error("oversized continuation record");
      binding = checkedBinding(Continuation.parse(raw).binding);
    } else if (/^escalation_burn_[a-f0-9]{64}\.json$/.test(name)) {
      Burn.parse(raw);
    } else throw new Error("unattributable escalation state");
    if (
      binding?.cwd === cwd &&
      binding.feature === feature &&
      !binding.hashes.every((hash) => hashes.includes(hash))
    )
      throw new Error("rejection history rollback: missing evidenced rejection");
    candidates.push({ path, name, binding });
  }
  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.binding && /^escalation_[a-f0-9]{64}\.json$/.test(candidate.name)) {
      // Validate all visible epochs so malformed/orphan burns cannot be misattributed.
      const lineage = readLineage(candidate.binding);
      for (const path of lineage.visited) visited.add(path);
    }
  }
  if (candidates.some((candidate) => !visited.has(candidate.path)))
    throw new Error("orphan or ambiguous escalation state");
}

function currentGrant(binding: EscalationBinding): Grant {
  reconcileHistory(binding.cwd, binding.feature, binding.hashes);
  return readLineage(binding).grants.at(-1)!;
}

/** Inspects the actual terminal, including outstanding grants, without rewriting any state. */
export function inspectEscalation(binding: EscalationBinding): EscalationInspection {
  const { binding: stored, ...terminal } = currentGrant(binding);
  void stored;
  if (!unchanged(binding)) throw new Error("escalation inputs changed during inspection");
  return {
    status: "inspected",
    feature: binding.feature,
    currentSnapshot: snapshotDigest(binding),
    terminal,
    ...(terminal.status === "consumed" && terminal.ordinal < 32
      ? { eligiblePredecessor: terminal.reference }
      : {}),
  };
}

/** Publishes one explicitly approved child of a spent terminal; exact replay is observation only. */
export function continueEscalation(
  binding: EscalationBinding,
  decision: string,
  request: ContinuationRequest,
): { status: "acknowledged" | "consumed"; feature: string; reference: string } {
  reconcileHistory(binding.cwd, binding.feature, binding.hashes);
  const lineage = readLineage(binding);
  const parent = lineage.grants.find(
    (grant) => grant.reference === Reference.parse(request.continueAfter),
  );
  if (!parent || parent.status !== "consumed") throw new Error("consumed predecessor required");
  const child = Continuation.parse({
    version: 1,
    kind: "plan-continuation",
    epoch: epoch(binding),
    ordinal: parent.ordinal + 1,
    predecessor: parent.reference,
    authorizationId: request.authorizationId,
    decision,
    binding,
    snapshot: request.snapshot,
  });
  if (child.snapshot !== snapshotDigest(binding) || !unchanged(binding))
    throw new Error("continuation snapshot changed");
  const state = paths(binding);
  const path = successorPath(state.root, parent.reference);
  const reference = `grant:${digest(JSON.stringify(["plan-grant-v1", child]))}`;
  const observe = (): {
    status: "acknowledged" | "consumed";
    feature: string;
    reference: string;
  } => {
    const stored = readPlanSnapshot(path, RECORD_BYTES).content;
    if (
      stored === null ||
      JSON.stringify(Continuation.parse(JSON.parse(stored))) !== JSON.stringify(child)
    )
      throw new Error("continuation conflict; inspect the winning authorization");
    const grant = readLineage(binding).grants.find((item) => item.reference === reference);
    if (!grant) throw new Error("continuation publication cannot be reconciled");
    return {
      status: grant.status === "consumed" ? "consumed" : "acknowledged",
      feature: binding.feature,
      reference,
    };
  };
  if (existsSync(path)) return observe();
  if (lineage.grants.at(-1) !== parent) throw new Error("terminal predecessor required");
  if (lineage.grants.some((grant) => grant.authorizationId === request.authorizationId))
    throw new Error("authorization identifier already used");
  if (lineage.bytes + Buffer.byteLength(`${JSON.stringify(child)}\n`) > LINEAGE_BYTES)
    throw new Error("oversized escalation lineage");
  publish(state.root, path, child, () => unchanged(binding));
  if (!unchanged(binding))
    throw new Error("continuation snapshot changed after publication; inspect retained state");
  return observe();
}
