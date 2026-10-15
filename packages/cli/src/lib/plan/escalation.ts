/** Bounded, immutable workflow escalation acknowledgements; never review/effect authority. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  fstatSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
const Entry = z.object({
  ts: z.string().datetime({ offset: true }),
  reviewHash: Hash,
  verdict: z.literal("CHANGES_REQUESTED"),
});
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
const Ack = z.object({ binding: Binding, decision: z.string().trim().min(1).max(4096) }).strict();

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
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 8192) throw new Error("oversized rejection history entry");
    hashes.add(Entry.parse(JSON.parse(line)).reviewHash);
  }
  if (hashes.size > 4096) throw new Error("oversized rejection history");
  return { files: [log, review], hashes: [...hashes].sort() };
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

/** Validates stored scope separately from the permanent rejection-epoch consumption key. */
export function requireAcknowledgement(binding: EscalationBinding): void {
  const state = paths(binding);
  if (existsSync(state.consumed)) throw new Error("escalation acknowledgement already consumed");
  const text = readPlanSnapshot(state.ack).content;
  if (text === null)
    throw new Error(
      `escalate to the user, then run navori plan acknowledge ${binding.feature} --opening '${binding.opening}' --decision '<user workflow decision>'`,
    );
  const ack = Ack.parse(JSON.parse(text));
  if (JSON.stringify(ack.binding) !== JSON.stringify(binding))
    throw new Error("escalation acknowledgement binding changed");
}

/** Exclusive permanent burn, bracketed by scope/dispatch checks; crash or drift stays spent. */
export function consumeEscalation(
  binding: EscalationBinding,
  dispatchUnchanged: () => boolean,
): void {
  requireAcknowledgement(binding);
  if (!dispatchUnchanged() || !unchanged(binding))
    throw new Error("escalation inputs changed before consumption");
  const state = paths(binding);
  ensureStateDirectory(state.root);
  const fd = openSync(state.consumed, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(binding)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!dispatchUnchanged() || !unchanged(binding))
    throw new Error(
      "escalation inputs changed after consumption; acknowledgement remains consumed",
    );
}
