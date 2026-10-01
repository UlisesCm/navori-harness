import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../report.ts";
import type { HarnessCatalog } from "../harness.ts";
import { auditsRoot, snapshotPath } from "../paths.ts";
import {
  SNAPSHOT_FORMAT,
  buildSnapshot,
  compareSnapshots,
  copySnapshotTo,
  readSnapshot,
  renderComparison,
  writeSnapshot,
  type RangeSnapshot,
} from "../snapshot.ts";
import { session } from "./lifecycle-fixtures.ts";

const CATALOG: HarnessCatalog = {
  agents: [{ name: "implementer", tools: null, hasMcp: true }],
  skills: [],
  managedSkills: [],
  sections: [],
  claudeMdTokens: 0,
  mcpFamilies: [],
};

/** The command a hook blocked, and the reason text the hook wrote for it. It
 *  carries a path on purpose: that is how a reason can leak what was run. */
const SECRET_PATH = "/home/someone/secret-project/build";
const SECRET_REASON = `Write sobre '${SECRET_PATH}/notes.md'`;

function blockedSession() {
  const s = session();
  s.orchestrator.hookEvents = [
    {
      ts: "2026-09-14T10:00:00.000Z",
      name: "implementer-no-markdown",
      phase: "PreToolUse",
      verdict: "block",
      ms: 5,
      source: "core",
      tool: "Write",
      reason: SECRET_REASON,
      toolUseId: "t1",
    },
    {
      ts: "2026-09-14T10:00:01.000Z",
      name: "implementer-no-markdown",
      phase: "PreToolUse",
      verdict: "block",
      ms: 5,
      source: "core",
      tool: "Write",
      reason: "'sed -i' sobre un archivo .md/.mdx",
      toolUseId: "t2",
    },
  ];
  s.orchestrator.blockedCommands = { t1: `rm -rf ${SECRET_PATH}` };
  return s;
}

function report(repo = "alpha-repo") {
  return buildReport([blockedSession()], { repo, version: "0.11.0", catalog: CATALOG });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-snap-"));
  process.env.NAVORI_AUDITS_ROOT = join(root, "audits");
});
afterEach(() => {
  delete process.env.NAVORI_AUDITS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("snapshot: format and privacy (R68)", () => {
  // Covers: R68
  it("has its own versioned format, independent of the report's schemaVersion", () => {
    const r = report();
    const snap = buildSnapshot(r, "repo");
    expect(Object.keys(snap).sort()).toEqual(
      ["generatedBy", "range", "rangeMetrics", "scope", "snapshotFormat"].sort(),
    );
    expect(snap.snapshotFormat).toBe(SNAPSHOT_FORMAT);
    expect(snap.generatedBy).toBe(r.generatedBy);
    expect(snap.scope).toBe("repo");
    expect(snap.range).toEqual(r.range);
    expect(JSON.stringify(snap)).not.toContain("schemaVersion");
  });

  // Covers: R68
  it("carries no command text: the per-reason block keys are aggregated away", () => {
    const r = report();
    // The premise: the report DOES publish the reason as a key, and it carries
    // a path from the blocked command.
    expect(Object.keys(r.rangeMetrics).some((k) => k.includes(SECRET_PATH))).toBe(true);

    const snap = buildSnapshot(r, "repo");
    const text = JSON.stringify(snap);
    expect(text).not.toContain("secret-project");
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("sed -i");
    expect(Object.keys(snap.rangeMetrics).some((k) => k.includes(".blocks."))).toBe(false);
    // What a baseline needs survives: the total per hook.
    expect(snap.rangeMetrics["hook.implementer-no-markdown.blocks"]).toBe(2);
    expect(snap.rangeMetrics["hook.implementer-no-markdown.fires"]).toBe(2);
  });

  // Covers: R68
  it("an --all-repos snapshot carries no repo name or basename", () => {
    const r = report("all-repos");
    r.repos = [
      { repo: "alpha-repo", audited: 2, host: 4 },
      { repo: "beta-repo", audited: 1, host: null },
    ];
    const text = JSON.stringify(buildSnapshot(r, "all"));
    expect(text).not.toContain("alpha-repo");
    expect(text).not.toContain("beta-repo");
    expect(JSON.parse(text).scope).toBe("all");
  });
});

describe("snapshot: where it is written (R68)", () => {
  // Covers: R68
  it("lands under the audit root by default, in the range directory", () => {
    const path = snapshotPath("alpha-repo", "claude-first-base", "2026-09-01", "2026-09-30");
    expect(path).toBe(
      join(
        auditsRoot(),
        "alpha-repo",
        "ranges",
        "2026-09-01--2026-09-30",
        "snapshot-claude-first-base.json",
      ),
    );
  });

  // Covers: R68
  it("puts an --all-repos snapshot where no repo name appears", () => {
    const path = snapshotPath(null, "base", "2026-09-01", "2026-09-30");
    expect(path).toBe(
      join(auditsRoot(), "_all-repos", "ranges", "2026-09-01--2026-09-30", "snapshot-base.json"),
    );
  });

  // Covers: R68
  it("rejects a name that would leave the audit root", () => {
    for (const bad of ["../x", "a/b", "..", "", ".hidden", "a b", "x\\y"]) {
      expect(() => snapshotPath("r", bad, "2026-09-01", "2026-09-30"), bad).toThrow(
        /snapshot name/,
      );
    }
  });

  // Covers: R68
  it("writes the file and refuses to replace an existing baseline", () => {
    const snap = buildSnapshot(report(), "repo");
    const path = snapshotPath("alpha-repo", "base", snap.range.from, snap.range.to);
    writeSnapshot(path, snap);
    expect(JSON.parse(readFileSync(path, "utf-8")).snapshotFormat).toBe(1);
    expect(() => writeSnapshot(path, snap)).toThrow(/already exists/);
    expect(readSnapshot(path)).toEqual(snap);
  });
});

describe("snapshot: --copy-to (R68)", () => {
  let repo: string;
  let snapshotFile: string;
  const snapOf = (scope: "repo" | "all"): string => {
    const snap = buildSnapshot(report(), scope);
    const path = snapshotPath(
      scope === "all" ? null : "alpha-repo",
      `n-${scope}`,
      snap.range.from,
      snap.range.to,
    );
    writeSnapshot(path, snap);
    return path;
  };

  beforeEach(() => {
    repo = join(root, "work", "repo");
    mkdirSync(join(repo, "docs", "deep"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    snapshotFile = snapOf("repo");
  });

  // Covers: R68
  it("resolves a relative path from the git toplevel, whichever subdirectory the command runs in", () => {
    const written = copySnapshotTo(snapshotFile, "docs/base.json", {
      cwd: join(repo, "docs", "deep"),
      scope: "repo",
      repoRoots: [],
    });
    // realpath: macOS reports /private/var for a /var temp dir.
    expect(written.endsWith(join("work", "repo", "docs", "base.json"))).toBe(true);
    expect(readSnapshot(written).snapshotFormat).toBe(1);
  });

  // Covers: R68
  it("refuses to overwrite an existing file", () => {
    const target = join(repo, "base.json");
    writeFileSync(target, "keep me", "utf-8");
    expect(() =>
      copySnapshotTo(snapshotFile, "base.json", { cwd: repo, scope: "repo", repoRoots: [] }),
    ).toThrow(/already exists/);
    expect(readFileSync(target, "utf-8")).toBe("keep me");
  });

  // Covers: R68
  it("needs an anchor for a relative path outside any git repository", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(() =>
      copySnapshotTo(snapshotFile, "x.json", { cwd: plain, scope: "repo", repoRoots: [] }),
    ).toThrow(/not inside a git repository/);
    const ok = copySnapshotTo(snapshotFile, join(plain, "x.json"), {
      cwd: plain,
      scope: "repo",
      repoRoots: [],
    });
    expect(existsSync(ok)).toBe(true);
  });

  // Covers: R68
  it("refuses an --all-repos snapshot inside any repo: the cwd one, an audited one, or an unaudited one", () => {
    const all = snapOf("all");
    const audited = join(root, "work", "audited");
    mkdirSync(audited, { recursive: true }); // No .git: known only from the audit logs.
    const unaudited = join(root, "work", "unaudited");
    mkdirSync(join(unaudited, ".git"), { recursive: true });
    const opts = { cwd: repo, scope: "all" as const, repoRoots: [audited] };

    expect(() => copySnapshotTo(all, "docs/all.json", opts)).toThrow(/inside a repository/);
    expect(() => copySnapshotTo(all, join(audited, "sub", "all.json"), opts)).toThrow(
      /inside a repository/,
    );
    expect(() => copySnapshotTo(all, join(unaudited, "nested", "all.json"), opts)).toThrow(
      /inside a repository/,
    );
    expect(existsSync(join(repo, "docs", "all.json"))).toBe(false);
    expect(existsSync(join(audited, "sub", "all.json"))).toBe(false);
    expect(existsSync(join(unaudited, "nested"))).toBe(false);

    // Outside every repo it is allowed.
    const outside = join(root, "elsewhere", "all.json");
    expect(copySnapshotTo(all, outside, opts)).toBe(outside);
  });
});

describe("snapshot: --compare (R69)", () => {
  const snap = (rangeMetrics: Record<string, number | null>): RangeSnapshot => ({
    snapshotFormat: 1,
    generatedBy: "navori@0.11.0",
    scope: "repo",
    range: { from: "2026-09-01", to: "2026-09-30" },
    rangeMetrics,
  });

  // Covers: R69
  it("diffs per metric and marks the ones a side lacks with n/a", () => {
    const base = snap({ "hooks.perBashCall": 4, "only.base": 7, same: 1, unmeasured: null });
    const now = snap({ "hooks.perBashCall": 3, "only.now": 2, same: 1, unmeasured: 5 });
    const diffs = compareSnapshots(base, now);
    const by = Object.fromEntries(diffs.map((d) => [d.key, d]));

    expect(by["hooks.perBashCall"]).toMatchObject({ base: 4, current: 3, delta: -1 });
    expect(by["only.base"]).toMatchObject({ base: 7, current: undefined, delta: null });
    expect(by["only.now"]).toMatchObject({ base: undefined, current: 2, delta: null });
    expect(by["unmeasured"]).toMatchObject({ base: null, current: 5, delta: null });

    const lines = renderComparison(diffs, base, now);
    expect(lines).toContain("| hooks.perBashCall | 4 | 3 | -1 |");
    expect(lines).toContain("| only.base | 7 | n/a | n/a |");
    expect(lines).toContain("| only.now | n/a | 2 | n/a |");
    expect(lines).toContain("| unmeasured | n/a | 5 | n/a |");
    expect(lines.join("\n")).not.toContain("| same |");
    expect(lines).toContain("4 changed, 1 unchanged");
  });

  // Covers: R69
  it("warns when the two snapshots are not the same scope", () => {
    const lines = renderComparison([], snap({}), { ...snap({}), scope: "all" });
    expect(lines.join("\n")).toContain("the scopes differ");
  });

  // Covers: R69
  it("rejects a file that is not a snapshot of this format", () => {
    const file = join(root, "x.json");
    writeFileSync(file, JSON.stringify({ snapshotFormat: 2, rangeMetrics: {} }), "utf-8");
    expect(() => readSnapshot(file)).toThrow(/snapshotFormat 2/);
    writeFileSync(file, "{nope", "utf-8");
    expect(() => readSnapshot(file)).toThrow(/not valid JSON/);
    expect(() => readSnapshot(join(root, "missing.json"))).toThrow(/Cannot read/);
  });
});
