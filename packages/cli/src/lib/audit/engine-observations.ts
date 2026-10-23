/** Closed observations only: transcript text never crosses this boundary. */
export interface CompactionRecovery {
  total: number;
  contextRestored: number;
  pending: number;
}

export function hasContextText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return (
    Array.isArray(value) &&
    value.some(
      (block: unknown): boolean =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    )
  );
}

export function closedAgentResult(content: unknown): {
  verdict: "APPROVED" | "CHANGES_REQUESTED" | null;
  handoffBlocked: boolean | undefined;
} {
  const blocks = Array.isArray(content) ? content : [];
  let text = "";
  for (const block of blocks) {
    if (
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
    )
      text = block.text;
  }
  if (text.length > 65536) return { verdict: null, handoffBlocked: undefined };
  return {
    verdict: /\bCHANGES_REQUESTED\b/.test(text)
      ? "CHANGES_REQUESTED"
      : /\bAPPROVED\b/.test(text)
        ? "APPROVED"
        : null,
    handoffBlocked: /(?:^|\n)\s*(?:status:\s*)?BLOCKED\b/i.test(text),
  };
}

/** A marker restores at most the latest boundary; earlier un-restored boundaries stay pending. */
export function observeCompaction(
  summary: CompactionRecovery,
  kind: "boundary" | "context",
  pending: boolean,
): boolean {
  if (kind === "boundary") {
    summary.total++;
    summary.pending++;
    return true;
  }
  if (pending) {
    summary.contextRestored++;
    summary.pending--;
  }
  return false;
}

/** Pi stores a branch graph: a later file entry can belong to a sibling branch. */
export class PiCompactionTracker {
  readonly summary: CompactionRecovery = { total: 0, contextRestored: 0, pending: 0 };
  private readonly boundaryByEntry = new Map<string, string | null>();
  private readonly restored = new Set<string>();

  observe(record: Record<string, unknown>): void {
    const id = typeof record.id === "string" && record.id.length <= 256 ? record.id : null;
    if (id && this.boundaryByEntry.has(id)) return;
    const boundary = record.type === "compaction";
    if (boundary) {
      this.summary.total++;
      this.summary.pending++;
    }
    // Without native lineage a restoration cannot be joined, even with adjacent entries.
    if (!id || !Object.hasOwn(record, "parentId")) return;
    let pending =
      typeof record.parentId === "string"
        ? (this.boundaryByEntry.get(record.parentId) ?? null)
        : null;
    if (boundary) pending = id;
    else if (
      record.type === "custom_message" &&
      record.customType === "navori-context" &&
      hasContextText(record.content) &&
      pending
    ) {
      if (!this.restored.has(pending)) {
        this.restored.add(pending);
        this.summary.contextRestored++;
        this.summary.pending--;
      }
      pending = null;
    }
    this.boundaryByEntry.set(id, pending);
  }
}
