import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../report.ts";
import { parseSession } from "../parse.ts";
import type { HarnessCatalog } from "../harness.ts";
import { auditsRoot, snapshotPath } from "../paths.ts";
import {
  SNAPSHOT_FORMAT,
  buildSnapshot,
  compareSnapshots,
  copySnapshotTo,
  gitRootCommit,
  readSnapshot,
  renderComparison,
  writeSnapshot,
  type Cohort,
  type RangeSnapshot,
  type SnapshotMetric,
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
  // Historic manually constructed hooks are explicitly observed source facts.
  s.availability = {
    hooks: {
      state: "observed",
      reason: null,
      source: "audit-log",
      adapter: "audit-log",
      sourceVersion: null,
    },
  };
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

const ROOT = "a".repeat(40);
const OPTS = { scope: "repo" as const, rootCommit: ROOT, auditMode: "opt-in" as const };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-snap-"));
  process.env.NAVORI_AUDITS_ROOT = join(root, "audits");
});
afterEach(() => {
  delete process.env.NAVORI_AUDITS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("snapshot: format 2 and privacy (R19, R68)", () => {
  // Covers: R10, R11, R68
  it("creates private snapshots independent of umask and never repairs historical files", () => {
    const snap = buildSnapshot(report(), OPTS);
    const path = snapshotPath("alpha-repo", "private", snap.range.from, snap.range.to);
    const previous = process.umask(0);
    try {
      writeSnapshot(path, snap);
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(auditsRoot()).mode & 0o777).toBe(0o700);
    chmodSync(path, 0o644);
    const before = readFileSync(path);
    expect(readSnapshot(path).snapshotFormat).toBe(2);
    expect(() => writeSnapshot(path, snap)).toThrow(/already exists/);
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const link = join(root, "legacy-link.json");
    symlinkSync(path, link);
    expect(() => readSnapshot(link)).toThrow();
  });

  // Covers: R19
  it("builds format 2 from a schema 11 report and refuses the older schema", () => {
    const r = report();
    const snap = buildSnapshot(r, OPTS);
    expect(snap.snapshotFormat).toBe(SNAPSHOT_FORMAT);
    expect(Object.keys(snap).sort()).toEqual(
      [
        "cohorts",
        "controls",
        "generatedBy",
        "invalidEntries",
        "metrics",
        "range",
        "repo",
        "repos",
        "scope",
        "snapshotFormat",
      ].sort(),
    );
    expect(snap.generatedBy).toBe(r.generatedBy);
    expect(snap.controls).toEqual({ auditMode: "opt-in", miner: "0.11.0" });
    expect(snap.cohorts.all?.sessions).toBe(1);
    expect(snap.cohorts.hooks?.sessions).toBe(1);
    // The fixture carries no tools evidence: it is out of the tools population.
    expect(snap.cohorts.tools?.sessions).toBe(0);
    expect(Object.values(snap.metrics).every((m) => m.state)).toBe(true);
    r.schemaVersion = 10;
    expect(() => buildSnapshot(r, OPTS)).toThrow(/schema 11/);
  });

  // Covers: R43, R19
  it("round-trips the R43 metrics of a parsed Claude 2.1.29x window as observed with n", () => {
    const sessions = [0, 1, 2].map((i) => {
      const dir = mkdtempSync(join(tmpdir(), "navori-snap-r43-"));
      const heavy = {
        type: "assistant",
        timestamp: "2026-10-05T10:00:00.000Z",
        diagnostics: Object.fromEntries(
          Array.from({ length: 100 }, (_, k) => [`k${k}`, "y".repeat(60)]),
        ),
        message: {
          id: `m${i}`,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100 * (i + 1) },
          content: [{ type: "text", text: "t".repeat(3000) }],
        },
      };
      const main = join(dir, `s${i}.jsonl`);
      writeFileSync(main, `${JSON.stringify(heavy)}\n`);
      const subagents = join(dir, `s${i}`, "subagents");
      mkdirSync(subagents, { recursive: true });
      writeFileSync(join(subagents, `agent-a${i}.jsonl`), `${JSON.stringify(heavy)}\n`);
      writeFileSync(
        join(subagents, `agent-a${i}.meta.json`),
        JSON.stringify({ agentType: "implementer" }),
      );
      return parseSession(main);
    });
    const snap = buildSnapshot(
      buildReport(sessions, { repo: "alpha-repo", version: "0.11.0", catalog: CATALOG }),
      OPTS,
    );
    const path = snapshotPath("alpha-repo", "r43", "2026-10-05", "2026-10-05");
    writeSnapshot(path, snap);
    const back = readSnapshot(path);
    expect(back.snapshotFormat).toBe(2);
    expect(back.metrics["agent.implementer.launches"]).toMatchObject({
      value: 3,
      state: "observed",
      n: 3,
    });
    expect(back.metrics["agent.implementer.sessions"]).toMatchObject({
      value: 3,
      state: "observed",
    });
    expect(back.metrics["agent.implementer.cacheRead.p50"]).toMatchObject({
      value: 200,
      state: "observed",
      n: 3,
    });
  });

  // Covers: R19, R68
  it("carries no command text, repo name or path: free-text keys and names are published labels", () => {
    const r = report();
    expect(Object.keys(r.rangeMetrics).some((k) => k.includes(SECRET_PATH))).toBe(true);
    const snap = buildSnapshot(r, OPTS);
    const text = JSON.stringify(snap);
    for (const leak of [
      "secret-project",
      "rm -rf",
      "sed -i",
      "alpha-repo",
      "implementer-no-markdown",
    ])
      expect(text).not.toContain(leak);
    expect(Object.keys(snap.metrics).some((k) => k.includes(".blocks."))).toBe(false);
    // What a baseline needs survives under the published key: the total per hook.
    const total = Object.entries(snap.metrics).find(([k]) =>
      /^hook\.unknown-[a-f0-9]{12}\.blocks$/.test(k),
    );
    expect(total?.[1].value).toBe(2);
  });

  // Covers: R19
  it("identifies the repo by its root commit: stable, never the basename, explicit unknown without git", () => {
    const a = buildSnapshot(report("alpha-repo"), OPTS);
    const sameRoot = buildSnapshot(report("renamed-checkout"), OPTS);
    const other = buildSnapshot(report("alpha-repo"), { ...OPTS, rootCommit: "b".repeat(40) });
    expect(a.repo).toMatch(/^[a-f0-9]{16}$/);
    expect(a.repo).toBe(sameRoot.repo);
    expect(a.repo).not.toBe(other.repo);
    expect(JSON.stringify(a)).not.toContain(ROOT);
    const unknown = buildSnapshot(report("alpha-repo"), { ...OPTS, rootCommit: null });
    expect(unknown.repo).toBeNull();
    const cmp = compareSnapshots(unknown, unknown);
    expect(cmp.rows.every((r) => r.reasons.includes("cohort-unknown:repo"))).toBe(true);
  });

  // Covers: R19, R68
  it("an --all-repos snapshot carries a count and a digest, no repo name or id", () => {
    const r = report("all-repos");
    r.repos = [
      { repo: "alpha-repo", audited: 2, host: 4 },
      { repo: "beta-repo", audited: 1, host: null },
    ];
    const snap = buildSnapshot(r, { scope: "all", rootCommit: null, auditMode: "unknown" });
    const text = JSON.stringify(snap);
    expect(text).not.toContain("alpha-repo");
    expect(text).not.toContain("beta-repo");
    expect(snap.scope).toBe("all");
    expect(snap.repos).toBe(2);
    expect(snap.repo).toMatch(/^[a-f0-9]{16}$/);
  });

  // Covers: R19
  it("reads the root commit of a git repository and nothing outside one", () => {
    const repo = join(root, "git-repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "x"],
      {
        cwd: repo,
      },
    );
    expect(gitRootCommit(repo)).toMatch(/^[0-9a-f]{40,64}$/);
    const plain = join(root, "plain-dir");
    mkdirSync(plain);
    expect(gitRootCommit(plain)).toBeNull();
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
    const snap = buildSnapshot(report(), OPTS);
    const path = snapshotPath("alpha-repo", "base", snap.range.from, snap.range.to);
    writeSnapshot(path, snap);
    expect(JSON.parse(readFileSync(path, "utf-8")).snapshotFormat).toBe(2);
    expect(() => writeSnapshot(path, snap)).toThrow(/already exists/);
    expect(readSnapshot(path)).toEqual(snap);
  });
});

describe("snapshot: --copy-to (R68)", () => {
  let repo: string;
  let snapshotFile: string;
  const snapOf = (scope: "repo" | "all"): string => {
    const snap = buildSnapshot(report(), { ...OPTS, scope });
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
    expect(readSnapshot(written).snapshotFormat).toBe(2);
    expect(statSync(written).mode & 0o777).toBe(0o600);
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

const cohort = (over: Partial<Cohort> = {}): Cohort => ({
  sessions: 3,
  host: { claude: 3 },
  regime: { "0.11.0": 3 },
  models: {
    "main-thread": { "claude-opus-4-8": 3 },
    implementer: { "claude-sonnet-4-5": 3 },
    scout: { "claude-haiku-4-5": 3 },
  },
  work: { untracked: 3 },
  ...over,
});
const metric = (value: number | null, over: Partial<SnapshotMetric> = {}): SnapshotMetric => ({
  value,
  state: "observed",
  reason: null,
  n: 120,
  ...over,
});
function snap(over: Partial<RangeSnapshot> = {}, c: Cohort = cohort()): RangeSnapshot {
  return {
    snapshotFormat: 2,
    generatedBy: "navori@0.11.2",
    scope: "repo",
    repo: "a".repeat(16),
    repos: null,
    range: { from: "2026-09-01", to: "2026-09-08" },
    controls: { auditMode: "opt-in", miner: "0.11.2" },
    cohorts: { all: c, tools: c, hooks: c },
    metrics: {},
    invalidEntries: 0,
    ...over,
  };
}
const NEXT = { from: "2026-09-15", to: "2026-09-22" };
const R43 = "agent.implementer.cacheRead.p50";
const row = (b: RangeSnapshot, c: RangeSnapshot, key: string) =>
  compareSnapshots(b, c).rows.find((r) => r.key === key)!;
const pair = (
  key: string,
  bm: SnapshotMetric,
  cm: SnapshotMetric,
  over: Partial<RangeSnapshot> = {},
  baseOver: Partial<RangeSnapshot> = {},
): [RangeSnapshot, RangeSnapshot] => [
  snap({ metrics: { [key]: bm }, ...baseOver }),
  snap({ metrics: { [key]: cm }, range: NEXT, ...over }),
];

describe("snapshot: legacy format 1 (R19)", () => {
  const legacy = join(tmpdir(), `navori-v1-${process.pid}.json`);
  afterEach(() => rmSync(legacy, { force: true }));

  // Covers: R19
  it("reads v1 as unknown: no scope, cohort, state or free-text key is invented", () => {
    writeFileSync(
      legacy,
      JSON.stringify({
        snapshotFormat: 1,
        generatedBy: "\u001b[31mevil",
        range: { from: "2026-09-01", to: "2026-09-08" },
        rangeMetrics: {
          [R43]: 0,
          "agent.implementer.cacheRead.n": 130,
          "agent.my-secret-agent.turns.p50": 4,
          "hook.x.blocks.rm -rf /secret": 1,
          bad: "text",
        },
      }),
    );
    const v1 = readSnapshot(legacy);
    expect(v1.snapshotFormat).toBe(1);
    expect(v1.scope).toBe("unknown");
    expect(v1.repo).toBeNull();
    expect(v1.cohorts).toEqual({ all: null, tools: null, hooks: null });
    expect(v1.generatedBy).toBe("navori@unknown");
    expect(JSON.stringify(v1)).not.toContain("my-secret-agent");
    expect(JSON.stringify(v1)).not.toContain("rm -rf");
    expect(v1.invalidEntries).toBe(1);
    expect(v1.metrics[R43]).toMatchObject({ value: 0, state: "legacy-unknown", n: 130 });
    // n comes from the sibling `.n` key only; a key without one stays unknown.
    const turns = Object.values(v1.metrics).find((m) => m.value === 4);
    expect(turns?.n).toBeNull();
    // Equal values still compare as descriptive: nothing legacy is matched, a v1 zero least of all.
    const r = row(v1, snap({ metrics: { [R43]: metric(0) }, range: NEXT }), R43);
    expect(r.outcome).toBe("descriptive");
    expect(r.reasons).toContain("legacy-snapshot");
    expect(r.relativeChange).toBeNull();
  });

  // Covers: R19
  it("rejects a format this navori does not read", () => {
    writeFileSync(legacy, JSON.stringify({ snapshotFormat: 3, metrics: {} }), "utf-8");
    expect(() => readSnapshot(legacy)).toThrow(/snapshotFormat 3/);
    writeFileSync(legacy, "{nope", "utf-8");
    expect(() => readSnapshot(legacy)).toThrow(/not valid JSON/);
    expect(() => readSnapshot(join(root, "missing.json"))).toThrow(/Cannot read/);
  });
});

describe("snapshot: reading a file from someone else (R19)", () => {
  // Covers: R19
  it("revalidates v2: bad keys, labels and strings are dropped, __proto__ never lands", () => {
    const file = join(root, "hostile.json");
    const good = snap({ metrics: { [R43]: metric(5) } });
    const hostile = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    hostile.generatedBy = "\u001b[2Jnavori";
    hostile.metrics = JSON.parse(
      `{"${R43}": ${JSON.stringify(metric(5))}, "__proto__": ${JSON.stringify(metric(1))}, "agent.\\u001b[31mx.calls": ${JSON.stringify(metric(1))}, "tool.Bash.calls": {"value": "text"}}`,
    );
    (hostile.cohorts as Record<string, Cohort>).tools = JSON.parse(
      '{"sessions":1,"host":{"__proto__":1},"regime":{},"models":{},"work":{}}',
    );
    writeFileSync(file, JSON.stringify(hostile), "utf-8");
    const read = readSnapshot(file);
    expect(Object.keys(read.metrics)).toEqual([R43]);
    expect(read.invalidEntries).toBe(3);
    expect(read.generatedBy).toBe("navori@unknown");
    expect(read.cohorts.tools).toBeNull();
    expect(({} as Record<string, unknown>).value).toBeUndefined();
    expect(Object.getPrototypeOf(read.metrics)).toBeNull();
  });

  // Covers: R19
  it("round-trips what it writes", () => {
    const written = buildSnapshot(report(), OPTS);
    const path = snapshotPath("alpha-repo", "roundtrip", written.range.from, written.range.to);
    writeSnapshot(path, written);
    expect(readSnapshot(path)).toEqual(written);
  });
});

describe("snapshot: per-metric preflight (R19)", () => {
  // Covers: R19
  it("a different host or work type is a mismatch; regime and model together are confounded", () => {
    const [b, c] = pair(R43, metric(100), metric(100));
    const codex = cohort({ host: { codex: 3 } });
    expect(
      row(b, { ...c, cohorts: { all: codex, tools: codex, hooks: codex } }, R43).reasons,
    ).toContain("cohort-mismatch:host");
    const both = cohort({
      regime: { "0.12.0": 3 },
      models: { ...cohort().models, implementer: { "claude-opus-4-8": 3 } },
    });
    const confounded = row(b, { ...c, cohorts: { all: both, tools: both, hooks: both } }, R43);
    expect(confounded.reasons).toContain("confounded");
    expect(confounded.outcome).toBe("descriptive");
    const session = "session.cacheRead.p50";
    const tracked = cohort({ work: { tracked: 3 } });
    const [sb, sc] = pair(session, metric(100, {}), metric(100, {}));
    expect(
      row(sb, { ...sc, cohorts: { all: tracked, tools: tracked, hooks: tracked } }, session)
        .reasons,
    ).toContain("cohort-mismatch:work");
  });

  // Covers: R19
  it("an unknown or moved regime and a mixed model make only the metrics that depend on them descriptive", () => {
    const mixed = cohort({
      regime: { "0.11.0": 2, moved: 1 },
      models: { ...cohort().models, scout: { "claude-haiku-4-5": 2, "claude-sonnet-4-5": 1 } },
    });
    const b = snap(
      { metrics: { "agent.scout.turns.p50": metric(4), "hooks.perBashCall": metric(1, {}) } },
      mixed,
    );
    const c = snap(
      {
        metrics: { "agent.scout.turns.p50": metric(4), "hooks.perBashCall": metric(1, {}) },
        range: NEXT,
      },
      cohort(),
    );
    const scout = row(b, c, "agent.scout.turns.p50");
    expect(scout.reasons).toContain("cohort-unknown:regime");
    expect(row(b, c, "hooks.perBashCall").reasons).toContain("cohort-unknown:regime");
    const modelOnly = snap({ metrics: b.metrics }, cohort({ models: mixed.models }));
    expect(row(modelOnly, c, "agent.scout.turns.p50").reasons).toContain("cohort-mixed:model");
    expect(row(modelOnly, c, "hooks.perBashCall").reasons).not.toContain("cohort-mixed:model");
    const unknownRegime = cohort({ regime: { unknown: 3 } });
    expect(
      row(snap({ metrics: b.metrics }, unknownRegime), c, "hooks.perBashCall").reasons,
    ).toContain("cohort-unknown:regime");
  });

  // Covers: R19
  it("overlapping windows are descriptive; touching ones are not an overlap; unreadable ones are unknown", () => {
    const [b, c] = pair(R43, metric(100), metric(100));
    const over = { ...c, range: { from: "2026-09-05", to: "2026-09-12" } };
    expect(row(b, over, R43).reasons).toContain("overlapping-window");
    const touching = { ...c, range: { from: "2026-09-08", to: "2026-09-15" } };
    expect(row(b, touching, R43).reasons).not.toContain("overlapping-window");
    expect(row(b, { ...c, range: { from: "", to: "" } }, R43).reasons).toContain("window-unknown");
    expect(row(b, { ...c, range: { from: "2026-09-15", to: "2026-09-15" } }, R43).reasons).toEqual(
      [],
    );
    expect(
      row(
        b,
        { ...c, range: { from: "2026-09-15T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" } },
        R43,
      ).reasons,
    ).toContain("window-unknown");
  });

  // Covers: R19
  it("a single-day range is the whole UTC day: comparable when disjoint, overlapping when not", () => {
    const [b, c] = pair(R43, metric(100), metric(100));
    const day = (d: string) => ({ from: d, to: d });
    const base = { ...b, range: day("2026-09-01") };
    expect(row(base, { ...c, range: day("2026-09-02") }, R43).reasons).toEqual([]);
    expect(row(base, { ...c, range: day("2026-09-01") }, R43).reasons).toContain(
      "overlapping-window",
    );
    expect(
      row(base, { ...c, range: { from: "2026-08-31", to: "2026-09-02" } }, R43).reasons,
    ).toContain("overlapping-window");
  });

  // Covers: R19
  it("a different repo or scope never compares like for like", () => {
    const [b, c] = pair(R43, metric(100), metric(100), { repo: "b".repeat(16) });
    expect(row(b, c, R43).reasons).toContain("cohort-mismatch:repo");
    const [b2, c2] = pair(R43, metric(100), metric(100), { scope: "all" });
    expect(row(b2, c2, R43).reasons).toContain("cohort-mismatch:scope");
  });

  // Covers: R19
  it("insufficient samples are inconclusive and nothing reads as an improvement without a measured noise band", () => {
    const [b, c] = pair(R43, metric(100, { n: 99 }), metric(88, { n: 130 }), {}, {});
    const short = row(b, c, R43);
    expect(short.outcome).toBe("inconclusive");
    expect(short.reasons).toContain("below-floor");
    const [b2, c2] = pair(R43, metric(100), metric(88));
    const met = row(b2, c2, R43);
    expect(met.outcome).toBe("matched");
    expect(met.delta).toBe(-12);
    expect(met.relativeChange).toBe(-0.12);
    expect(met.criterion).toMatchObject({
      source: "spec-0039/R43",
      state: "threshold-met-unverified",
      noiseBand: "unmeasured",
    });
    expect(met.criterion?.uncontrolled).toContain("task-mix");
    expect(met).not.toHaveProperty("improvement");
    const [b3, c3] = pair(R43, metric(100), metric(95));
    expect(row(b3, c3, R43).criterion?.state).toBe("threshold-not-met");
    // Without a pre-registered floor even a huge N is descriptive.
    const [b4, c4] = pair("tool.Bash.calls", metric(1, { n: 10_000 }), metric(2, { n: 10_000 }));
    expect(row(b4, c4, "tool.Bash.calls").reasons).toContain("no-preregistered-floor");
    const [b5, c5] = pair(
      "agent.scout.turns.p50",
      metric(4, { n: 10_000 }),
      metric(3, { n: 10_000 }),
    );
    const noFloor = row(b5, c5, "agent.scout.turns.p50");
    expect(noFloor.outcome).toBe("descriptive");
    expect(noFloor.delta).toBe(-1);
  });

  // Covers: R19
  it("partial coverage is inconclusive and an unmeasured side never becomes a delta", () => {
    const [b, c] = pair(R43, metric(100), metric(88, { state: "partial" }));
    expect(row(b, c, R43)).toMatchObject({
      outcome: "inconclusive",
      reasons: ["partial-coverage"],
    });
    const [b2, c2] = pair(R43, metric(100), metric(null, { state: "unavailable" }));
    const gone = row(b2, c2, R43);
    expect(gone.reasons).toContain("side-unavailable");
    expect(gone.delta).toBeNull();
    expect(gone.relativeChange).toBeNull();
    const absent = compareSnapshots(snap({ metrics: { [R43]: metric(1) } }), snap({ range: NEXT }));
    expect(absent.rows[0]?.current).toBeNull();
    expect(absent.rows[0]?.reasons).toContain("side-unavailable");
  });

  // Covers: R19
  it("a different audit.mode or miner is not controlled, and an unknown one cannot be", () => {
    const [b, c] = pair(R43, metric(100), metric(88), {
      controls: { auditMode: "always", miner: "0.11.2" },
    });
    const mode = row(b, c, R43);
    expect(mode.outcome).toBe("notControlled");
    expect(mode.reasons).toEqual(["audit-mode-uncontrolled"]);
    expect(mode.criterion).toBeUndefined();
    const [b2, c2] = pair(R43, metric(100), metric(88), {
      controls: { auditMode: "opt-in", miner: "0.12.0" },
    });
    expect(row(b2, c2, R43).reasons).toEqual(["miner-differs"]);
    const unknownMode = { auditMode: "unknown", miner: "0.11.2" } as const;
    const [b3, c3] = pair(
      R43,
      metric(100),
      metric(88),
      { controls: unknownMode },
      { controls: unknownMode },
    );
    expect(row(b3, c3, R43).outcome).toBe("notControlled");
  });

  // Covers: R19
  it("counts get no delta across windows; intensive figures keep a negative one", () => {
    const [b, c] = pair("tool.Bash.calls", metric(50, {}), metric(500, {}));
    const count = row(b, c, "tool.Bash.calls");
    expect(count).toMatchObject({ base: 50, current: 500, delta: null, relativeChange: null });
    expect(count.reasons).toContain("extensive-count");
    const [b2, c2] = pair("hooks.perBashCall", metric(4, {}), metric(3, {}));
    expect(row(b2, c2, "hooks.perBashCall")).toMatchObject({ delta: -1, relativeChange: -0.25 });
    const [b3, c3] = pair(R43, metric(0), metric(5));
    expect(row(b3, c3, R43).relativeChange).toBeNull();
    const diag = row(...pair("agent.x.n", metric(1, {}), metric(2, {})), "agent.x.n");
    expect(diag.reasons).toContain("diagnostic-metric");
  });

  // Covers: R19
  it("renders the outcome counts and the rule that matched is not improvement", () => {
    const [b, c] = pair(R43, metric(100), metric(88));
    const cmp = compareSnapshots(b, c);
    expect(cmp.totals).toEqual({ matched: 1, descriptive: 0, inconclusive: 0, notControlled: 0 });
    const lines = renderComparison(cmp, b, c).join("\n");
    expect(lines).toContain("matched 1");
    expect(lines).toContain("does not mean improvement");
    expect(lines).toContain("threshold-met-unverified");
    expect(lines).toContain("noise band unmeasured");
  });
});
