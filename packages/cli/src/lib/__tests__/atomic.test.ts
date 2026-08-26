import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * #504 — the old specs proved `writeFileAtomic` WRITES; none of them proved the
 * property it exists for (DESIGN §14.8): a destination that is never left
 * half-written. Reading the file after a successful call cannot distinguish an
 * atomic swap from a plain `writeFileSync`.
 *
 * So the specs below observe the write from INSIDE, through two seams on
 * `node:fs` — a hook that runs right after the bytes reach the temp file, and
 * one that runs just before the rename. They are the closest a single-process
 * test gets to "the machine dies here", and they cover the three moments a crash
 * can land on: mid-write, between write and rename, and the rename itself.
 *
 * What is NOT covered, deliberately (see the report for #504): durability across
 * a power loss. `writeFileAtomic` fsyncs the FILE but not the parent DIRECTORY,
 * so a crash right after the rename can lose the directory entry. Proving that
 * needs a real crash and a filesystem that can be inspected afterwards — a VM
 * or a fault-injecting FUSE mount, not a unit test.
 */
const fsHooks = vi.hoisted(() => ({
  /** Runs after the content has reached the temp file, before fsync/rename. */
  afterWrite: null as (() => void) | null,
  /** Runs before the rename that publishes the temp file as the destination. */
  beforeRename: null as ((from: string, to: string) => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync(fd: number, data: string): number {
      const written = actual.writeSync(fd, data);
      fsHooks.afterWrite?.();
      return written;
    },
    renameSync(from: string, to: string): void {
      fsHooks.beforeRename?.(from, to);
      actual.renameSync(from, to);
    },
  };
});

const { writeFileAtomic } = await import("../atomic.ts");

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "navori-atomic-"));
}

/** Temp files navori left in `dir` (the litter a failed write must not leave). */
function tempLitter(dir: string): string[] {
  return readdirSync(dir).filter((e) => e.includes(".navori.tmp."));
}

afterEach(() => {
  fsHooks.afterWrite = null;
  fsHooks.beforeRename = null;
});

describe("writeFileAtomic", () => {
  it("writes content to the destination path", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileAtomic(path, "hello atomic");
      expect(readFileSync(path, "utf-8")).toBe("hello atomic");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("overwrites existing file atomically", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileSync(path, "old content", "utf-8");
      writeFileAtomic(path, "new content");
      expect(readFileSync(path, "utf-8")).toBe("new content");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("leaves no temp file behind on success", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileAtomic(path, "content");
      const entries = readdirSync(dir);
      expect(tempLitter(dir)).toHaveLength(0);
      expect(entries).toContain("out.txt");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("preserves unicode and multi-line content", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.md");
    const content = "# Título\n\n- Código en inglés\n- Chat es-MX ✓\n";
    try {
      writeFileAtomic(path, content);
      expect(readFileSync(path, "utf-8")).toBe(content);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("writeFileAtomic — the atomicity invariant (#504)", () => {
  it("holds the OLD file intact while the new bytes are already on disk", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileSync(path, "old content", "utf-8");
      let midWrite: { dest: string; tmp: string | null } | null = null;
      fsHooks.afterWrite = () => {
        const tmp = tempLitter(dir)[0] ?? null;
        midWrite = {
          dest: readFileSync(path, "utf-8"),
          tmp: tmp ? readFileSync(join(dir, tmp), "utf-8") : null,
        };
      };

      writeFileAtomic(path, "new content");

      // The window a crash can land in: the new content is COMPLETE somewhere
      // else, and the destination is still the old file, byte for byte. A
      // writeFileSync straight to `path` would show "new content" (or a prefix
      // of it) here — which is the corruption this module exists to prevent.
      expect(midWrite).not.toBeNull();
      expect(midWrite!.dest).toBe("old content");
      expect(midWrite!.tmp).toBe("new content");
      expect(readFileSync(path, "utf-8")).toBe("new content");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not create the destination until the rename (a crash leaves NO file)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      let existedMidWrite: boolean | null = null;
      fsHooks.afterWrite = () => {
        existedMidWrite = existsSync(path);
      };

      writeFileAtomic(path, "content");

      // A consumer that finds the file finds it whole: it appears at the rename
      // or not at all, never as an empty or truncated stub.
      expect(existedMidWrite).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe("content");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("renames from a temp in the SAME directory (a cross-device rename is not atomic)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      const renames: Array<[string, string]> = [];
      fsHooks.beforeRename = (from, to) => renames.push([from, to]);

      writeFileAtomic(path, "content");

      expect(renames).toHaveLength(1);
      const [from, to] = renames[0] as [string, string];
      expect(to).toBe(path);
      // rename(2) is atomic only WITHIN a filesystem. A temp in os.tmpdir()
      // would degrade to a copy across devices — non-atomic, and silently so.
      expect(dirname(from)).toBe(dirname(to));
      expect(basename(from).startsWith(`.${basename(to)}.navori.tmp.`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("a failure mid-write leaves the destination untouched and no litter", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileSync(path, "old content", "utf-8");
      // The disk fills up (ENOSPC) right after the bytes were handed to the fd.
      fsHooks.afterWrite = () => {
        throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
      };

      expect(() => writeFileAtomic(path, "new content")).toThrow(/no space left/);

      expect(readFileSync(path, "utf-8")).toBe("old content");
      expect(tempLitter(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("a failure at the rename leaves the destination untouched and no litter", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileSync(path, "old content", "utf-8");
      // The last instant before the swap — the temp file is complete on disk and
      // the publish never happens. Nothing may leak into the destination.
      fsHooks.beforeRename = () => {
        throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
      };

      expect(() => writeFileAtomic(path, "new content")).toThrow(/permission denied/);

      expect(readFileSync(path, "utf-8")).toBe("old content");
      expect(tempLitter(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("a failure on a NEW file leaves no half-written file behind", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      fsHooks.afterWrite = () => {
        throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
      };

      expect(() => writeFileAtomic(path, "content")).toThrow(/simulated EIO/);

      // Neither the destination nor a temp survives: the caller's next read gets
      // "absent", which it can handle — unlike a truncated file, which it cannot.
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
