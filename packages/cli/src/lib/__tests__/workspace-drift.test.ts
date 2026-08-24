import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../config.ts";

/**
 * #326 — bonum-webapp spent a week with a hand-adopted harness (no workspace, a
 * single plugin) while its five siblings ran the full six, and `navori doctor`
 * said OK with no pending actions. It was right about the files: every managed
 * block was current. The drift lived in the CONFIG, and nothing compared it —
 * neither against the workspace defaults nor, crucially, against the siblings
 * (the workspace declared no plugin policy, so against the defaults that repo
 * was conformant).
 *
 * safeHomedir is mocked so the machine-local registry lives in a fake home.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const { scanWorkspaceDrift } = await import("../workspace-drift.ts");
const { writeWorkspace } = await import("../workspace.ts");

let repoDir: string;
const siblingDirs: string[] = [];

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "navori-repo-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  for (const dir of siblingDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return {
    name: "webapp",
    version: "0.5.1",
    workspace: "bonum",
    engines: ["claude"],
    preset: "custom",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
    ...overrides,
  } as NavoriConfig;
}

/** Materialize a sibling repo on disk with the given config, and register it. */
function sibling(
  name: string,
  overrides: Partial<NavoriConfig> = {},
): { name: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `navori-sibling-${name}-`));
  siblingDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "navori.config.json"),
    JSON.stringify(config({ name, ...overrides }), null, 2),
  );
  return { name, path: dir };
}

/** Register the workspace with `repoDir` plus the given siblings. */
function workspace(
  repos: Array<{ name: string; path: string }>,
  defaults: Record<string, unknown> = {},
): void {
  writeWorkspace({
    name: "bonum",
    ticketsDir: "tickets",
    defaults,
    repos: [{ name: "webapp", path: repoDir }, ...repos],
  });
}

describe("scanWorkspaceDrift (#326)", () => {
  it("returns null without a workspace, or when the manifest is missing", () => {
    expect(scanWorkspaceDrift(repoDir, config({ workspace: undefined }))).toBeNull();
    expect(scanWorkspaceDrift(repoDir, config())).toBeNull(); // no manifest written
  });

  it("reports a key that diverges from a declared workspace default", () => {
    workspace([], { branchBase: "develop" });
    const report = scanWorkspaceDrift(repoDir, config());
    expect(report?.vsDefaults).toEqual([
      { key: "branchBase", local: "main", expected: "develop", agree: 0, total: 0 },
    ]);
  });

  it("says nothing about keys the workspace declares no default for", () => {
    workspace([], {});
    expect(scanWorkspaceDrift(repoDir, config())).toBeNull();
  });

  it("reports a plugin most siblings enable and this repo doesn't (the real case)", () => {
    const withPlugins = { plugins: { engram: { enabled: true }, semgrep: { enabled: true } } };
    workspace([
      sibling("dashboard", withPlugins),
      sibling("nexus", withPlugins),
      sibling("mentoring", withPlugins),
    ]);
    const report = scanWorkspaceDrift(repoDir, config({ plugins: { engram: { enabled: true } } }));
    expect(report?.siblingsRead).toBe(3);
    expect(report?.vsSiblings).toEqual([
      { key: "plugins.semgrep", local: "—", expected: "enabled", agree: 3, total: 3 },
    ]);
  });

  // #374: `enabled: false` is an answer. Reporting it against the siblings'
  // mode turned a settled decision into a warning on every doctor run, forever.
  it("does not flag a plugin this repo EXPLICITLY disabled, however many siblings enable it", () => {
    const withPlugins = { plugins: { semgrep: { enabled: true } } };
    workspace([sibling("a", withPlugins), sibling("b", withPlugins), sibling("c", withPlugins)]);
    const report = scanWorkspaceDrift(
      repoDir,
      config({ plugins: { semgrep: { enabled: false } } }),
    );
    expect(report).toBeNull();
  });

  it("still flags the plugin when this repo never declared it at all", () => {
    const withPlugins = { plugins: { semgrep: { enabled: true } } };
    workspace([sibling("a", withPlugins), sibling("b", withPlugins), sibling("c", withPlugins)]);
    const report = scanWorkspaceDrift(repoDir, config());
    expect(report?.vsSiblings).toEqual([
      { key: "plugins.semgrep", local: "—", expected: "enabled", agree: 3, total: 3 },
    ]);
  });

  it("stays one-directional: siblings that mostly DISABLED a plugin never push this repo to drop it", () => {
    workspace([
      sibling("a", { plugins: { semgrep: { enabled: false } } }),
      sibling("b", { plugins: { semgrep: { enabled: false } } }),
      sibling("c", { plugins: { semgrep: { enabled: true } } }),
    ]);
    const report = scanWorkspaceDrift(repoDir, config({ plugins: { semgrep: { enabled: true } } }));
    expect(report).toBeNull();
  });

  it("needs a STRICT majority — an even split is not a policy", () => {
    workspace([
      sibling("a", { plugins: { semgrep: { enabled: true } } }),
      sibling("b", { plugins: { semgrep: { enabled: true } } }),
      sibling("c"),
      sibling("d"),
    ]);
    expect(scanWorkspaceDrift(repoDir, config())).toBeNull();
  });

  it("ignores a single sibling — 'the majority' of one is a coincidence", () => {
    workspace([sibling("solo", { branchBase: "develop" })]);
    expect(scanWorkspaceDrift(repoDir, config())).toBeNull();
  });

  it("does not flag a plugin THIS repo enables and the siblings don't", () => {
    workspace([sibling("a"), sibling("b"), sibling("c")]);
    const report = scanWorkspaceDrift(repoDir, config({ plugins: { jscpd: { enabled: true } } }));
    expect(report).toBeNull();
  });

  it("flags models/effort as declared-vs-undeclared, not by their contents", () => {
    // Annotated, not inferred: an inline literal is contextually typed by
    // `sibling`, but a shared const widens "sonnet"/"high" to `string` and stops
    // matching the enums.
    const declared: Partial<NavoriConfig> = {
      models: { implementer: "sonnet" },
      effort: { implementer: "high" },
    };
    workspace([
      sibling("a", declared),
      // A different tier per repo is a local call — only the absence is drift.
      sibling("b", { models: { implementer: "opus" }, effort: { implementer: "low" } }),
      sibling("c", declared),
    ]);
    const report = scanWorkspaceDrift(repoDir, config());
    expect(report?.vsSiblings.map((d) => d.key).sort()).toEqual(["effort", "models"]);
    expect(report?.vsSiblings.every((d) => d.expected === "declared")).toBe(true);
  });

  it("never reports `preset` — sibling repos legitimately run different stacks", () => {
    workspace([
      sibling("a", { preset: "nestjs" }),
      sibling("b", { preset: "nestjs" }),
      sibling("c", { preset: "nestjs" }),
    ]);
    expect(scanWorkspaceDrift(repoDir, config({ preset: "custom" }))).toBeNull();
  });

  it("compares the EFFECTIVE prTarget (prTarget ?? branchBase)", () => {
    // Siblings spell out prTarget: develop; this repo omits it and branches off
    // main, so its effective target IS main — a real divergence, reported once.
    workspace([
      sibling("a", { branchBase: "main", prTarget: "develop" }),
      sibling("b", { branchBase: "main", prTarget: "develop" }),
      sibling("c", { branchBase: "main", prTarget: "develop" }),
    ]);
    const report = scanWorkspaceDrift(repoDir, config());
    expect(report?.vsSiblings).toEqual([
      { key: "prTarget", local: "main", expected: "develop", agree: 3, total: 3 },
    ]);
  });

  it("skips siblings whose path is stale or whose config doesn't parse", () => {
    const broken = mkdtempSync(join(tmpdir(), "navori-sibling-broken-"));
    siblingDirs.push(broken);
    writeFileSync(join(broken, "navori.config.json"), "{ not json");
    workspace([
      sibling("a", { branchBase: "develop" }),
      sibling("b", { branchBase: "develop" }),
      { name: "gone", path: join(tmpdir(), "navori-sibling-does-not-exist") },
      { name: "broken", path: broken },
    ]);
    const report = scanWorkspaceDrift(repoDir, config());
    expect(report?.siblingsRead).toBe(2);
    expect(report?.vsSiblings).toEqual([
      { key: "branchBase", local: "main", expected: "develop", agree: 2, total: 2 },
    ]);
  });

  it("reports a key once — the defaults row wins over the siblings row", () => {
    workspace([sibling("a", { branchBase: "develop" }), sibling("b", { branchBase: "develop" })], {
      branchBase: "develop",
    });
    const report = scanWorkspaceDrift(repoDir, config());
    expect(report?.vsDefaults.map((d) => d.key)).toEqual(["branchBase"]);
    expect(report?.vsSiblings).toEqual([]);
  });
});
