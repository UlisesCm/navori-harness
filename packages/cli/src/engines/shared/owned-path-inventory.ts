/** Authorship of an actual selected destination, not overwrite authority. */
export type OwnedPathAuthorship = "missing" | "ours" | "modified" | "newer" | "foreign";

/** Immutable input to guard interpolation, before managed hashing/composition. */
export interface SealedOwnedPaths {
  readonly paths: readonly string[];
  /** Newline-delimited exact relative paths; '-' denotes an empty inventory. */
  readonly value: string;
}

/** Target-local, filesystem-free protection metadata. Never authorizes writes. */
export class OwnedPathInventory {
  private readonly observations = new Map<string, Map<string, OwnedPathAuthorship>>();
  private readonly accepted = new Set<string>();
  private readonly excluded = new Set<string>();
  private sealed: SealedOwnedPaths | undefined;

  /** Retain block-specific evidence separately from the file-protection union. */
  observe(path: string, authorship: OwnedPathAuthorship, managedId: string = ""): void {
    this.assertOpen();
    if (
      !path ||
      path === "-" ||
      /[\r\n\\]/.test(path) ||
      path.includes("\0") ||
      path.startsWith("/") ||
      /^[a-z]:/i.test(path) ||
      path.split("/").some((part: string): boolean => !part || part === "." || part === "..")
    )
      throw new Error(`Invalid owned destination: ${JSON.stringify(path)}`);
    const blocks = this.observations.get(path) ?? new Map<string, OwnedPathAuthorship>();
    const previous = blocks.get(managedId);
    if (previous !== undefined && previous !== authorship) {
      throw new Error(`Conflicting ownership observation: ${path}`);
    }
    blocks.set(managedId, authorship);
    this.observations.set(path, blocks);
  }

  /** Record an explicitly accepted acquisition; selection alone is insufficient. */
  accept(path: string): void {
    this.assertObserved(path);
    this.accepted.add(path);
  }

  /** Record a generation veto without changing overwrite/prune policy. */
  exclude(path: string): void {
    this.assertObserved(path);
    this.excluded.add(path);
  }

  /** Freeze the exact sorted union. Idempotent; all subsequent registration fails. */
  seal(): SealedOwnedPaths {
    if (this.sealed !== undefined) return this.sealed;
    const paths = [...this.observations]
      .filter(
        ([path, blocks]: [string, Map<string, OwnedPathAuthorship>]): boolean =>
          !this.excluded.has(path) &&
          (this.accepted.has(path) ||
            [...blocks.values()].some(
              (authorship: OwnedPathAuthorship): boolean => authorship !== "foreign",
            )),
      )
      .map(([path]: [string, Map<string, OwnedPathAuthorship>]): string => path)
      .sort();
    this.sealed = Object.freeze({ paths: Object.freeze(paths), value: paths.join("\n") || "-" });
    return this.sealed;
  }

  /** Require the owner to close the full target union before finalization. */
  requireSealed(): SealedOwnedPaths {
    if (this.sealed === undefined) throw new Error("Owned path inventory is not sealed");
    return this.sealed;
  }

  private assertOpen(): void {
    if (this.sealed !== undefined) throw new Error("Owned path inventory is sealed");
  }

  private assertObserved(path: string): void {
    this.assertOpen();
    if (!this.observations.has(path)) throw new Error(`Unobserved owned destination: ${path}`);
  }
}
