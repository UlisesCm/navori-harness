import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  appendPrivateAuditFile,
  copyPrivateAuditFile,
  createPrivateAuditFile,
  ensurePrivateAuditDirectory,
  readAuditJsonl,
  readPrivateAuditFile,
  removePrivateAuditFile,
  replacePrivateAuditFile,
  rangeReportDir,
  repoFromCwd,
  sessionReportDir,
} from "../paths.ts";
import { NavoriError } from "../../primitives/errors.ts";

vi.mock(import("node:fs"), { spy: true });

/**
 * The report directories compose a filesystem path out of an OPAQUE HOST TOKEN
 * (Claude Code's session id) and a date. That is the same shape of input that
 * produced #503, where an unvalidated id wrote outside the audit root — so the
 * guard is re-asserted here rather than assumed from the log path's copy.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-audit-paths-"));
  process.env.NAVORI_AUDITS_ROOT = root;
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  process.env.NAVORI_AUDITS_ROOT = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("private audit storage", () => {
  // Covers: R10, R11
  it("binds private removal to the caller's consumed device, inode and size", () => {
    const file = join(root, "consumed-spool");
    createPrivateAuditFile(file, "{}\n");
    const { dev, ino, size } = statSync(file);
    for (const expectedIdentity of [
      { dev: dev + 1, ino, size },
      { dev, ino: ino + 1, size },
      { dev, ino, size: size + 1 },
    ]) {
      expect(removePrivateAuditFile(file, { expectedIdentity })).toMatchObject({
        ok: false,
        reason: "changed",
        partial: false,
      });
      expect(readFileSync(file, "utf-8")).toBe("{}\n");
    }
    expect(removePrivateAuditFile(file, { expectedIdentity: { dev, ino, size } })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(existsSync(file)).toBe(false);
  });
  // Covers: R10, R11
  it("validates an empty append without writing or consuming a real short-write injection", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const file = join(root, "empty-validation");
    createPrivateAuditFile(file, "{}\n");
    vi.mocked(fs.writeSync).mockClear();
    vi.mocked(fs.writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      const bytes = data instanceof Uint8Array ? data : Buffer.from(String(data));
      return actual.writeSync(fd, bytes.subarray(0, 2));
    });
    expect(appendPrivateAuditFile(file, () => "")).toEqual({ ok: true, value: 0 });
    expect(fs.writeSync).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("{}\n");
    expect(appendPrivateAuditFile(file, '{"next":1}\n')).toMatchObject({
      ok: false,
      reason: "short-write",
      partial: true,
    });
    expect(fs.writeSync).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, "utf-8")).toBe('{}\n{"');
    expect(appendPrivateAuditFile(file, () => "")).toMatchObject({
      ok: false,
      reason: "incomplete-tail",
      partial: false,
    });
  });
  // Covers: R10, R11
  it("creates owned0700 directories and0600 files even under umask000, leaving ordinary ancestors alone", () => {
    const ordinary = statSync(tmpdir()).mode;
    const old = process.umask(0);
    try {
      const dir = join(root, "private", "nested");
      expect(ensurePrivateAuditDirectory(dir).ok).toBe(true);
      const file = join(dir, "event.jsonl");
      expect(createPrivateAuditFile(file, "{}\n")).toEqual({ ok: true, value: 3 });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(tmpdir()).mode).toBe(ordinary);
    } finally {
      process.umask(old);
    }
  });

  // Covers: R10, R11
  it("refuses insecure owned directories/files without chmod or changing bytes", () => {
    const dir = join(root, "unsafe");
    mkdirSync(dir, { mode: 0o755 });
    const file = join(dir, "event.jsonl");
    writeFileSync(file, "{}\n", { mode: 0o644 });
    expect(appendPrivateAuditFile(file, "{}\n")).toMatchObject({
      ok: false,
      reason: "unsafe",
      partial: false,
    });
    expect(readFileSync(file, "utf-8")).toBe("{}\n");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  // Covers: R10, R11
  it("rejects owned ancestor and final-leaf links, including external output links", () => {
    const dir = join(root, "private");
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, "target");
    createPrivateAuditFile(target, "{}\n");
    symlinkSync(target, join(dir, "leaf"));
    symlinkSync(dir, join(root, "linked-dir"));
    expect(appendPrivateAuditFile(join(dir, "leaf"), "{}\n").ok).toBe(false);
    expect(createPrivateAuditFile(join(root, "linked-dir", "new"), "data").ok).toBe(false);
    expect(
      createPrivateAuditFile(join(root, "linked-dir", "export"), "data", { ownedRoot: null }).ok,
    ).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("{}\n");
    expect(existsSync(join(dir, "new"))).toBe(false);
  });

  // Covers: R10, R11
  it("refuses an incomplete JSONL tail unchanged and exclusive copies never replace", () => {
    const file = join(root, "incomplete");
    createPrivateAuditFile(file, '{}\n{"pending":');
    expect(appendPrivateAuditFile(file, "{}\n")).toMatchObject({
      ok: false,
      reason: "incomplete-tail",
      partial: false,
    });
    expect(readFileSync(file, "utf-8")).toBe('{}\n{"pending":');
    const copy = join(root, "copy");
    expect(copyPrivateAuditFile(file, copy).ok).toBe(true);
    expect(copyPrivateAuditFile(file, copy)).toMatchObject({
      ok: false,
      reason: "exists",
      partial: false,
    });
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  // Covers: R10, R11
  it("exposes a real short append as partial and never repairs the suffix", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const file = join(root, "short");
    createPrivateAuditFile(file, "{}\n");
    vi.mocked(fs.writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      const bytes =
        typeof data === "string"
          ? Buffer.from(data)
          : data instanceof Uint8Array
            ? Buffer.from(data)
            : Buffer.alloc(0);
      return actual.writeSync(fd, bytes.subarray(0, 3));
    });
    expect(appendPrivateAuditFile(file, '{"next":1}\n')).toMatchObject({
      ok: false,
      reason: "short-write",
      partial: true,
    });
    expect(readFileSync(file, "utf-8")).toBe('{}\n{"n');
    expect(appendPrivateAuditFile(file, "{}\n")).toMatchObject({
      ok: false,
      reason: "incomplete-tail",
      partial: false,
    });
  });

  // Covers: R10, R11
  it("rechecks descriptor identity and owner without caching authorization", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const file = join(root, "identity");
    createPrivateAuditFile(file, "{}\n");
    vi.mocked(fs.openSync).mockImplementationOnce((path, flags, mode) => {
      const fd = actual.openSync(path, flags, mode);
      renameSync(file, file + ".original");
      writeFileSync(file, "replacement\n", { mode: 0o600 });
      return fd;
    });
    expect(appendPrivateAuditFile(file, "{}\n")).toMatchObject({
      ok: false,
      reason: "changed",
      partial: false,
    });
    expect(readFileSync(file, "utf-8")).toBe("replacement\n");
    expect(readFileSync(file + ".original", "utf-8")).toBe("{}\n");
    vi.spyOn(process, "getuid").mockReturnValue(statSync(file).uid + 1);
    expect(appendPrivateAuditFile(file, "{}\n")).toMatchObject({
      ok: false,
      reason: "unsafe",
      partial: false,
    });
  });

  // Covers: R10, R11
  it("stages generated replacement privately and refuses unsafe destination unchanged", () => {
    const file = join(root, "report.json");
    expect(replacePrivateAuditFile(file, "old").ok).toBe(true);
    expect(replacePrivateAuditFile(file, "new").ok).toBe(true);
    expect(readPrivateAuditFile(file)).toEqual({ ok: true, value: Buffer.from("new") });
    chmodSync(file, 0o644);
    expect(replacePrivateAuditFile(file, "refused")).toMatchObject({
      ok: false,
      reason: "unsafe",
      partial: false,
    });
    expect(readFileSync(file, "utf-8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  // Covers: R10, R11
  it("refuses a changed generated destination and preserves a partial exclusive copy", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const file = join(root, "generated");
    createPrivateAuditFile(file, "original");
    vi.mocked(fs.writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      renameSync(file, file + ".original");
      writeFileSync(file, "foreign replacement", { mode: 0o600 });
      const bytes = data instanceof Uint8Array ? data : Buffer.from(String(data));
      return actual.writeSync(fd, bytes);
    });
    expect(replacePrivateAuditFile(file, "new report")).toMatchObject({
      ok: false,
      reason: "changed",
      partial: false,
    });
    expect(readFileSync(file, "utf-8")).toBe("foreign replacement");
    expect(readFileSync(file + ".original", "utf-8")).toBe("original");
    const copy = join(root, "partial-copy");
    vi.mocked(fs.writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      const bytes = data instanceof Uint8Array ? data : Buffer.from(String(data));
      return actual.writeSync(fd, bytes.subarray(0, 2));
    });
    expect(copyPrivateAuditFile(file, copy)).toMatchObject({
      ok: false,
      reason: "short-write",
      partial: true,
    });
    expect(readFileSync(copy, "utf-8")).toBe("fo");
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf-8")).toBe("foreign replacement");
  });
});

describe("bounded audit JSONL reader", () => {
  // Covers: R10, R21
  it("uses an explicit private owned root without weakening host or private policies", () => {
    const owned = join(root, "explicit-root");
    const file = join(owned, "spool.jsonl");
    expect(createPrivateAuditFile(file, "{}\n", { ownedRoot: owned }).ok).toBe(true);
    process.env.NAVORI_AUDITS_ROOT = join(root, "different-root");
    expect(readAuditJsonl(file, () => {}, { privateArtifact: true }).sourceStatus).toBe("invalid");
    expect(
      readAuditJsonl(file, () => {}, { privateArtifact: true, ownedRoot: owned }).sourceStatus,
    ).toBe("observed");
    chmodSync(owned, 0o755);
    expect(
      readAuditJsonl(file, () => {}, { privateArtifact: true, ownedRoot: owned }),
    ).toMatchObject({ sourceStatus: "invalid", reason: "unsafe" });
    expect(
      readAuditJsonl(file, () => {}, { ownedRoot: join(root, "ignored-host-boundary") })
        .sourceStatus,
    ).toBe("observed");
    expect(statSync(owned).mode & 0o777).toBe(0o755);
  });
  // Covers: R21
  it("caps transient callbacks at100k events with unknown remainder rather than a false exact count", () => {
    const file = join(root, "many.jsonl");
    writeFileSync(file, "{}\n".repeat(100002));
    let count = 0;
    const result = readAuditJsonl(file, () => {
      count++;
    });
    expect(count).toBe(100000);
    expect(result).toMatchObject({
      sourceStatus: "observed",
      stoppedEarly: true,
      omitted: null,
      omittedLowerBound: 1,
    });
    const link = join(root, "leaf-link");
    symlinkSync(file, link);
    expect(readAuditJsonl(link, () => {}).sourceStatus).toBe("invalid");
  });
  // Covers: R21
  it("handles split UTF8, invalid bytes, oversized lines and incomplete tails without retaining unbounded fragments", () => {
    const file = join(root, "host.jsonl");
    const valid = JSON.stringify({ pad: "a".repeat(65517), word: "á" });
    expect(Buffer.from(valid).indexOf(Buffer.from("á"))).toBe(65535);
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(valid + "\n"),
        Buffer.from([0xff, 10]),
        Buffer.from("x".repeat(1048577) + "\n{}\n{"),
      ]),
    );
    const values: unknown[] = [];
    const health = readAuditJsonl(file, (value) => {
      values.push(value);
    });
    expect(values).toEqual([JSON.parse(valid), {}]);
    expect(health).toMatchObject({
      sourceStatus: "observed",
      invalidUtf8: 1,
      oversizedLines: 1,
      malformedJson: 0,
      incompleteTail: true,
      omitted: 3,
      omittedLowerBound: 3,
    });
  });

  // Covers: R21
  it("distinguishes malformed records, early omitted unknowns, missing inputs and ordinary aliases", () => {
    const file = join(root, "host.jsonl");
    writeFileSync(file, "{bad}\n{}\n{}\n");
    expect(readAuditJsonl(file, () => false)).toMatchObject({
      malformedJson: 1,
      stoppedEarly: true,
      omitted: null,
      omittedLowerBound: 2,
    });
    expect(readAuditJsonl(join(root, "missing"), () => {})).toMatchObject({
      sourceStatus: "unavailable",
      reason: "missing",
    });
    const link = join(root, "host-alias");
    symlinkSync(root, link);
    expect(readAuditJsonl(join(link, "host.jsonl"), () => {}).sourceStatus).toBe("observed");
    expect(
      readAuditJsonl(join(link, "host.jsonl"), () => {}, { privateArtifact: true }).sourceStatus,
    ).toBe("invalid");
  });
});

describe("sessionReportDir (#0013, R15)", () => {
  // Covers: R15
  it("stays under the audit root for a valid id", () => {
    const dir = sessionReportDir("demo", "2026-08-25", "a6260e0b-e88c-48b2");
    expect(dir.startsWith(join(root, "demo"))).toBe(true);
    // Short id: the directory is for a human to open and the date already
    // disambiguates; the full id lives inside the log's `start` event.
    expect(dir.endsWith("2026-08-25-a6260e0b")).toBe(true);
  });

  // Covers: R15
  it.each([["a/../../escaped"], ["../climb"], ["with space"], [""]])(
    "rejects a path-shaped session id (%s)",
    (id) => {
      expect(() => sessionReportDir("demo", "2026-08-25", id)).toThrow(NavoriError);
    },
  );

  // Covers: R15
  it("rejects a day that is not YYYY-MM-DD", () => {
    // An empty range (a session whose transcript carried no timestamps) would
    // otherwise compose a nameless directory, and `..` would climb out of it.
    for (const day of ["", "..", "2026-8-5", "2026-08-25/x"]) {
      expect(() => sessionReportDir("demo", day, "sess1")).toThrow(NavoriError);
    }
  });
});

describe("rangeReportDir (#0013, R16)", () => {
  // Covers: R16
  it("composes <from>--<to> under the audit root", () => {
    const dir = rangeReportDir("demo", "2026-08-25", "2026-08-28");
    expect(dir).toBe(join(root, "demo", "ranges", "2026-08-25--2026-08-28"));
  });

  // Covers: R16
  it("rejects a malformed day on either end", () => {
    expect(() => rangeReportDir("demo", "..", "2026-08-28")).toThrow(NavoriError);
    expect(() => rangeReportDir("demo", "2026-08-25", "")).toThrow(NavoriError);
  });
});

describe("repoFromCwd (#764)", () => {
  it("derives the basename of a standard repo cwd", () => {
    expect(repoFromCwd("/Users/u/dev/navori-harness")).toBe("navori-harness");
  });

  it("truncates at /.claude/worktrees for agent worktree cwd", () => {
    expect(
      repoFromCwd("/Users/u/dev/navori-harness/.claude/worktrees/agent-a2a999b59fde9ce6c"),
    ).toBe("navori-harness");
  });

  it("truncates at /.claude/worktrees for subdirectories inside an agent worktree", () => {
    expect(
      repoFromCwd(
        "/Users/u/dev/navori-harness/.claude/worktrees/agent-a2a999b59fde9ce6c/packages/cli",
      ),
    ).toBe("navori-harness");
  });

  it("handles the .claude/worktrees root itself", () => {
    expect(repoFromCwd("/Users/u/dev/navori-harness/.claude/worktrees")).toBe("navori-harness");
  });

  it("does not truncate a directory that merely starts with worktrees", () => {
    expect(repoFromCwd("/Users/u/dev/navori-harness/.claude/worktrees-backup")).toBe(
      "worktrees-backup",
    );
  });
});

/**
 * #897: a session opened with `cwd` in a subdirectory of the project (e.g.
 * `packages/cli`) must attribute to the project root, not to the
 * subdirectory's own basename. These use REAL fixture directories (not the
 * fake `/Users/u/...` paths above) so `findProjectRoot`'s `existsSync` walk
 * has real markers to find.
 */
describe("repoFromCwd — project root resolution (#897)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "navori-repo-root-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("attributes a cwd at the project root itself", () => {
    writeFileSync(join(projectDir, "navori.config.json"), "{}");
    expect(repoFromCwd(projectDir)).toBe(basename(projectDir));
  });

  it("attributes a cwd in a nested subdirectory to the project root (navori.config.json marker)", () => {
    writeFileSync(join(projectDir, "navori.config.json"), "{}");
    const nested = join(projectDir, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(repoFromCwd(nested)).toBe(basename(projectDir));
  });

  it("attributes a cwd in a nested subdirectory to the project root (.git marker, dir form)", () => {
    mkdirSync(join(projectDir, ".git"));
    const nested = join(projectDir, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(repoFromCwd(nested)).toBe(basename(projectDir));
  });

  it("attributes a cwd in a nested subdirectory to the project root (.git marker, file form — worktree checkout)", () => {
    // In a git worktree, .git is a file with a `gitdir:` pointer, not a directory.
    writeFileSync(join(projectDir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const nested = join(projectDir, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(repoFromCwd(nested)).toBe(basename(projectDir));
  });

  it("truncates an agent worktree cwd first, then resolves the parent repo root (#764 regression)", () => {
    mkdirSync(join(projectDir, ".git"));
    const worktreeNested = join(
      projectDir,
      ".claude",
      "worktrees",
      "agent-a2a999b59fde9ce6c",
      "packages",
      "cli",
    );
    mkdirSync(worktreeNested, { recursive: true });
    expect(repoFromCwd(worktreeNested)).toBe(basename(projectDir));
  });

  it("falls back to the cwd basename when no project root marker is found", () => {
    const orphan = join(projectDir, "no-marker-here");
    mkdirSync(orphan, { recursive: true });
    expect(repoFromCwd(orphan)).toBe("no-marker-here");
  });
});
