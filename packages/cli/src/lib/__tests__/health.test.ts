import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestNextSteps,
  collectMissingPlugins,
  scanManagedDrift,
  scanManagedOrder,
  scanMalformedMarkers,
  scanExcludedBlocks,
  listMarkers,
  type DriftReport,
} from "../health.ts";
import { NavoriConfigSchema } from "../schema.ts";
import { computeManagedHash, injectManagedSection } from "../marker.ts";
import { computeRenderPlan } from "../render-plan.ts";

const contentDrift: DriftReport = {
  filePath: ".claude/agents/leader.md",
  markerId: "leader-base",
  source: "@navori/core",
  kind: "content",
};
const versionDrift: DriftReport = {
  filePath: ".claude/agents/leader.md",
  markerId: "leader-base",
  source: "@navori/core",
  kind: "version",
  fromVersion: "0.0.1",
  toVersion: "0.0.2",
};

describe("suggestNextSteps (spec 0003 §3.5.3)", () => {
  it("suggests render --apply when CLAUDE.md is missing", () => {
    const steps = suggestNextSteps({ claudeMdExists: false, missingPlugins: [], drifts: [] });
    expect(steps.some((s) => s.includes("render --apply"))).toBe(true);
  });

  it("suggests sync --interactive on content drift", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [],
      drifts: [contentDrift],
    });
    expect(steps.some((s) => s.includes("sync --interactive"))).toBe(true);
  });

  it("suggests render --apply on version drift", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [],
      drifts: [versionDrift],
    });
    expect(steps.some((s) => s.includes("render --apply"))).toBe(true);
  });

  it("flags missing plugins", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [{ id: "ghost", reason: "unknown plugin id" }],
      drifts: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("plugin"))).toBe(true);
  });

  it("says all-clear when nothing is pending", () => {
    const steps = suggestNextSteps({ claudeMdExists: true, missingPlugins: [], drifts: [] });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatch(/al día/i);
  });

  it("suggests render --apply to reorder out-of-order blocks", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [],
      drifts: [],
      orderReport: {
        current: ["idioma-rol", "orquestacion"],
        expected: ["orquestacion", "idioma-rol"],
        interleaved: false,
        misplacedFirst: null,
      },
    });
    expect(steps.some((s) => s.includes("reordenar"))).toBe(true);
  });

  it("tells the user to move interleaved prose before reordering, naming the misplaced lead block", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [],
      drifts: [],
      orderReport: {
        current: ["idioma-rol", "orquestacion"],
        expected: ["orquestacion", "idioma-rol"],
        interleaved: true,
        misplacedFirst: { id: "orquestacion", currentPos: 2, total: 2 },
      },
    });
    const move = steps.find((s) => s.startsWith("Mueve"));
    expect(move).toBeDefined();
    // The spotlight makes it actionable: names the block and where it should go.
    expect(move).toContain("orquestacion");
    expect(move).toContain("debería ir 1º");
  });
});

describe("collectMissingPlugins", () => {
  const cfg = (plugins: Record<string, { enabled: boolean }>) =>
    NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom", plugins });

  it("reports an enabled plugin that can't be loaded", () => {
    const missing = collectMissingPlugins(cfg({ "ghost-plugin": { enabled: true } }));
    expect(missing).toHaveLength(1);
    expect(missing[0]!.id).toBe("ghost-plugin");
  });

  it("ignores disabled plugins", () => {
    expect(collectMissingPlugins(cfg({ "ghost-plugin": { enabled: false } }))).toHaveLength(0);
  });

  it("returns empty when there are no plugins", () => {
    expect(
      collectMissingPlugins(
        NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" }),
      ),
    ).toHaveLength(0);
  });
});

describe("listMarkers + scanManagedDrift", () => {
  let cwd: string;
  const config = NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-health-"));
    mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function writeAgent(body: string, attrs: string): void {
    writeFileSync(
      join(cwd, ".claude/agents/leader.md"),
      `<!-- navori:managed id="leader-base" ${attrs} -->\n${body}\n<!-- /navori:managed id="leader-base" -->\n`,
    );
  }

  it("listMarkers parses id/hash/version/source", () => {
    writeAgent("body", 'hash="abc123" version="9.9.9" source="@navori/core"');
    const markers = listMarkers(join(cwd, ".claude/agents/leader.md"));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      id: "leader-base",
      hash: "abc123",
      version: "9.9.9",
      source: "@navori/core",
    });
  });

  it("listMarkers returns [] for a missing file", () => {
    expect(listMarkers(join(cwd, "nope.md"))).toEqual([]);
  });

  it("detects content drift when the body no longer matches its hash", () => {
    writeAgent("hand-edited body", 'hash="deadbeef" version="9.9.9" source="@navori/core"');
    const drifts = scanManagedDrift(cwd, config);
    expect(drifts.some((d) => d.kind === "content" && d.markerId === "leader-base")).toBe(true);
  });

  it("detects version drift when the version is older than the bundle", () => {
    // Correct hash so content drift doesn't fire — isolate the version check.
    const body = "stable body";
    writeAgent(body, `hash="${computeManagedHash(body)}" version="0.0.0" source="@navori/core"`);
    const drifts = scanManagedDrift(cwd, config);
    expect(drifts.some((d) => d.kind === "version" && d.markerId === "leader-base")).toBe(true);
    expect(drifts.some((d) => d.kind === "content")).toBe(false);
  });

  it("no drift for a marker without version/hash attrs", () => {
    writeAgent("body", 'source="@navori/core"');
    expect(scanManagedDrift(cwd, config)).toHaveLength(0);
  });

  // Regression (F4): CLAUDE.md was outside the scan scope, so doctor/status
  // reported drift:0 while render/sync flagged the same hand-edited block.
  it("detects content drift in a managed block inside CLAUDE.md", () => {
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      `<!-- navori:managed id="idioma-rol" hash="deadbeef" version="9.9.9" source="@navori/core" -->\n` +
        `hand-edited core block\n<!-- /navori:managed id="idioma-rol" -->\n`,
    );
    const drifts = scanManagedDrift(cwd, config);
    expect(
      drifts.some(
        (d) => d.kind === "content" && d.markerId === "idioma-rol" && d.filePath === "CLAUDE.md",
      ),
    ).toBe(true);
  });

  // Wave 3 (#71 item 12): AGENTS.md (agents-md engine) was outside the scan
  // scope, so doctor was blind to hand-edits of its managed block — the same
  // gap already closed for CLAUDE.md above.
  it("detects content drift in the managed block inside AGENTS.md", () => {
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `<!-- navori:managed id="navori-agents" hash="deadbeef" version="9.9.9" source="@navori/core" -->\n` +
        `hand-edited agents block\n<!-- /navori:managed id="navori-agents" -->\n`,
    );
    const drifts = scanManagedDrift(cwd, config);
    expect(
      drifts.some(
        (d) => d.kind === "content" && d.markerId === "navori-agents" && d.filePath === "AGENTS.md",
      ),
    ).toBe(true);
  });

  // Directory-shaped skills (`<id>/SKILL.md` + refs) are walked recursively so
  // their managed markers are not invisible to doctor — and unmanaged user files
  // in the tree never false-positive.
  it("reports no drift for a user's directory-shaped skill without navori markers", () => {
    const skillDir = join(cwd, ".claude/skills/my-user-skill");
    mkdirSync(join(skillDir, "refs"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-user-skill\n---\n\nMy own skill.\n");
    writeFileSync(join(skillDir, "refs", "notes.md"), "# Notes\n\nUnmanaged content.\n");
    expect(scanManagedDrift(cwd, config)).toHaveLength(0);
  });

  it("detects content drift in a managed block inside a directory-shaped skill", () => {
    const skillDir = join(cwd, ".claude/skills/big-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `<!-- navori:managed id="big-skill-base" hash="deadbeef" version="9.9.9" source="@navori/core" -->\n` +
        `hand-edited skill block\n<!-- /navori:managed id="big-skill-base" -->\n`,
    );
    const drifts = scanManagedDrift(cwd, config);
    expect(
      drifts.some(
        (d) =>
          d.kind === "content" &&
          d.markerId === "big-skill-base" &&
          d.filePath === ".claude/skills/big-skill/SKILL.md",
      ),
    ).toBe(true);
  });
});

describe("scanManagedOrder", () => {
  const config = NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" });
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-order-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when CLAUDE.md is absent", () => {
    expect(scanManagedOrder(cwd, config)).toBeNull();
  });

  it("returns null when blocks are already in canonical order", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), computeRenderPlan("", config, cwd).next);
    expect(scanManagedOrder(cwd, config)).toBeNull();
  });

  it("returns null with fewer than two blocks", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), injectManagedSection("", "orquestacion", "x").output);
    expect(scanManagedOrder(cwd, config)).toBeNull();
  });

  it("detects an out-of-order orchestrator block", () => {
    let doc = injectManagedSection("", "idioma-rol", "x").output;
    doc = injectManagedSection(doc, "orquestacion", "y").output; // canonical: orquestacion first
    writeFileSync(join(cwd, "CLAUDE.md"), doc);

    const r = scanManagedOrder(cwd, config);
    expect(r).not.toBeNull();
    expect(r!.current).toEqual(["idioma-rol", "orquestacion"]);
    expect(r!.expected).toEqual(["orquestacion", "idioma-rol"]);
    expect(r!.interleaved).toBe(false);
    // #71 item 9: spotlight the lead block that's out of place.
    expect(r!.misplacedFirst).toEqual({ id: "orquestacion", currentPos: 2, total: 2 });
  });

  it("flags interleaved prose so the order can't be auto-fixed, spotlighting the lead block", () => {
    // Built by hand: injectManagedSection no longer produces interleaving (it
    // inserts new blocks after the last managed block, #77), but a user moving
    // blocks/prose around by hand still can.
    const first = injectManagedSection("", "idioma-rol", "x").output;
    const second = injectManagedSection("", "orquestacion", "y").output;
    const doc = `${first.trimEnd()}\n\nNOTA DEL USUARIO\n\n${second}`;
    writeFileSync(join(cwd, "CLAUDE.md"), doc);

    const r = scanManagedOrder(cwd, config);
    expect(r).not.toBeNull();
    expect(r!.interleaved).toBe(true);
    expect(r!.misplacedFirst).toEqual({ id: "orquestacion", currentPos: 2, total: 2 });
  });
});

describe("scanMalformedMarkers (#71 item 11)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-malformed-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("flags an open marker that lost its --> terminator", () => {
    // Well-formed close, but the open line is missing ` -->`.
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      `<!-- navori:managed id="idioma-rol" hash="abc" version="9.9.9" source="@navori/core"\n` +
        `body\n<!-- /navori:managed id="idioma-rol" -->\n`,
    );
    const found = scanMalformedMarkers(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: "CLAUDE.md", line: 1 });
  });

  it("flags a close marker that lost its --> terminator", () => {
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `<!-- navori:managed id="navori-agents" hash="abc" version="9.9.9" source="@navori/core" -->\n` +
        `body\n<!-- /navori:managed id="navori-agents"\n`,
    );
    const found = scanMalformedMarkers(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: "AGENTS.md", line: 3 });
  });

  it("does not flag well-formed markers", () => {
    const doc = injectManagedSection("", "idioma-rol", "x").output;
    writeFileSync(join(cwd, "CLAUDE.md"), doc);
    expect(scanMalformedMarkers(cwd)).toHaveLength(0);
  });
});

describe("scanExcludedBlocks (feature: blocks.exclude)", () => {
  const base = { name: "demo", engines: ["claude"], preset: "custom" };

  it("returns null when nothing is excluded", () => {
    expect(scanExcludedBlocks(NavoriConfigSchema.parse(base))).toBeNull();
    expect(
      scanExcludedBlocks(NavoriConfigSchema.parse({ ...base, blocks: { exclude: [] } })),
    ).toBeNull();
  });

  it("reports known excluded core blocks (always visible — no silent drift)", () => {
    const report = scanExcludedBlocks(
      NavoriConfigSchema.parse({ ...base, blocks: { exclude: ["orquestacion", "sdd"] } }),
    );
    expect(report).toEqual({ excluded: ["orquestacion", "sdd"], nonExcludable: [], unknown: [] });
  });

  it("separates unknown ids (typos) from known ones so doctor can warn", () => {
    const report = scanExcludedBlocks(
      NavoriConfigSchema.parse({ ...base, blocks: { exclude: ["orquestacion", "orquestracion"] } }),
    );
    expect(report?.excluded).toEqual(["orquestacion"]);
    expect(report?.unknown).toEqual(["orquestracion"]);
  });

  // A real core block that isn't excludable (e.g. `operaciones-seguras`, part of
  // the safety contract) must land in `nonExcludable` — the render keeps it and
  // doctor warns the opt-out had no effect — not in `excluded` or `unknown`.
  it("routes a non-excludable core block to `nonExcludable`, not `excluded`", () => {
    const report = scanExcludedBlocks(
      NavoriConfigSchema.parse({
        ...base,
        blocks: { exclude: ["orquestacion", "operaciones-seguras"] },
      }),
    );
    expect(report?.excluded).toEqual(["orquestacion"]);
    expect(report?.nonExcludable).toEqual(["operaciones-seguras"]);
    expect(report?.unknown).toEqual([]);
  });
});
