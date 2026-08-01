import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestNextSteps,
  collectMissingPlugins,
  scanManagedDrift,
  scanManagedOrder,
  scanMalformedMarkers,
  scanDuplicateMarkers,
  scanExcludedBlocks,
  scanOrphanedEngineOutputs,
  listMarkers,
  type DriftReport,
} from "../health.ts";
import * as plugins from "../plugins.ts";
import { NavoriConfigSchema } from "../schema.ts";
import { computeManagedHash, injectManagedSection } from "../marker.ts";
import { computeRenderPlan } from "../render-plan.ts";
import { effectiveConfigForWorkspace } from "../monorepo.ts";
import { CLAUDE_COMPUTED_BLOCK_IDS, renderClaudeEngine } from "../../engines/claude/index.ts";

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
const downgradeDrift: DriftReport = {
  filePath: ".claude/agents/leader.md",
  markerId: "leader-base",
  source: "@navori/core",
  kind: "downgrade",
  fromVersion: "9.9.9",
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

  // #242: a downgrade (disk newer than the CLI) is NOT fixed by render — the
  // anti-rollback preserves the block — so the advice must be "update the CLI".
  it("tells the user to update the CLI on downgrade drift, not render", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [],
      drifts: [downgradeDrift],
    });
    expect(steps.some((s) => /navori@latest|desactualizado/i.test(s))).toBe(true);
    // The render/sync version-drift advice must NOT appear for a pure downgrade.
    expect(steps.some((s) => s.includes("última versión"))).toBe(false);
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
    expect(missing[0]!.reason).toBe("unknown plugin id");
  });

  it("gives a retired plugin an actionable hint, not 'unknown plugin id' (#271)", () => {
    const missing = collectMissingPlugins(cfg({ cognitive: { enabled: true } }));
    expect(missing).toHaveLength(1);
    expect(missing[0]!.id).toBe("cognitive");
    // A retired plugin must be distinguishable from a real typo: point the user
    // at the fix instead of the dead-end "unknown plugin id".
    expect(missing[0]!.reason).not.toBe("unknown plugin id");
    expect(missing[0]!.reason).toContain("navori remove cognitive");
    expect(missing[0]!.reason).toContain("#130");
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

  // #242: when the on-disk version is NEWER than the running CLI, the mismatch
  // is a downgrade (render's anti-rollback preserves the block), classified
  // apart from a plain version drift so doctor advises updating the CLI.
  it("classifies a marker newer than the CLI as a downgrade, not version drift", () => {
    const body = "stable body";
    // 999.0.0 is guaranteed newer than any real CLI version.
    writeAgent(body, `hash="${computeManagedHash(body)}" version="999.0.0" source="@navori/core"`);
    const drifts = scanManagedDrift(cwd, config);
    const d = drifts.find((x) => x.markerId === "leader-base");
    expect(d?.kind).toBe("downgrade");
    expect(d?.fromVersion).toBe("999.0.0");
    expect(drifts.some((x) => x.kind === "version")).toBe(false);
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
  // gap already closed for CLAUDE.md above. #312: only scanned when agents-md is
  // a configured engine (a leftover AGENTS.md under engines:["claude"] is an
  // orphan, not drift), so this asserts with agents-md enabled.
  it("detects content drift in the managed block inside AGENTS.md", () => {
    const agentsConfig = NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude", "agents-md"],
      preset: "custom",
    });
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `<!-- navori:managed id="navori-agents" hash="deadbeef" version="9.9.9" source="@navori/core" -->\n` +
        `hand-edited agents block\n<!-- /navori:managed id="navori-agents" -->\n`,
    );
    const drifts = scanManagedDrift(cwd, agentsConfig);
    expect(
      drifts.some(
        (d) => d.kind === "content" && d.markerId === "navori-agents" && d.filePath === "AGENTS.md",
      ),
    ).toBe(true);
  });

  it("detects shell-marker drift in Codex config", () => {
    const codexConfig = NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude", "codex"],
      preset: "custom",
    });
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      `# navori:managed start id="codex-config-base" hash="deadbeef" version="9.9.9" source="@navori/core"\n` +
        `sandbox_mode = "danger-full-access"\n# navori:managed end id="codex-config-base"\n`,
    );
    const drifts = scanManagedDrift(cwd, codexConfig);
    expect(
      drifts.some(
        (d) =>
          d.kind === "content" &&
          d.markerId === "codex-config-base" &&
          d.filePath === ".codex/config.toml",
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

  it("detects a swap AMONG computed blocks only when the engine's ids are threaded (#228 follow-up)", () => {
    // Two engine-computed blocks in the wrong relative order (canonical:
    // skills-index before agentes-disponibles).
    let doc = injectManagedSection("", "agentes-disponibles", "x").output;
    doc = injectManagedSection(doc, "skills-index", "y").output;
    writeFileSync(join(cwd, "CLAUDE.md"), doc);

    // Without the ids, both computed blocks are absent from the canonical list,
    // so they keep their document order — the swap goes unnoticed.
    expect(scanManagedOrder(cwd, config)).toBeNull();

    // With the ids threaded (as doctor does), the swap is flagged.
    const r = scanManagedOrder(cwd, config, CLAUDE_COMPUTED_BLOCK_IDS);
    expect(r).not.toBeNull();
    expect(r!.current).toEqual(["agentes-disponibles", "skills-index"]);
    expect(r!.expected).toEqual(["skills-index", "agentes-disponibles"]);
    expect(r!.misplacedFirst).toEqual({ id: "skills-index", currentPos: 2, total: 2 });
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

  // #226: the Copilot / Cursor prose files carry the same html markers but were
  // absent from the malformed-marker scan's file list (its "same scope as
  // scanManagedDrift" comment lied). Now both scans share `collectMarkerFiles`.
  it("flags a broken marker in .github/copilot-instructions.md (previously unscanned)", () => {
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(
      join(cwd, ".github/copilot-instructions.md"),
      `<!-- navori:managed id="navori-copilot" hash="abc" version="9.9.9" source="@navori/core"\n` +
        `body\n<!-- /navori:managed id="navori-copilot" -->\n`,
    );
    const found = scanMalformedMarkers(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: ".github/copilot-instructions.md", line: 1 });
  });

  it("flags a broken marker in .cursor/rules/navori.mdc (previously unscanned)", () => {
    mkdirSync(join(cwd, ".cursor/rules"), { recursive: true });
    writeFileSync(
      join(cwd, ".cursor/rules/navori.mdc"),
      `<!-- navori:managed id="navori-cursor" hash="abc" version="9.9.9" source="@navori/core"\n` +
        `body\n<!-- /navori:managed id="navori-cursor" -->\n`,
    );
    const found = scanMalformedMarkers(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: ".cursor/rules/navori.mdc", line: 1 });
  });

  it("does NOT apply the html --> check to Codex shell markers", () => {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    // A perfectly-formed shell marker has no `-->`; it must not be flagged.
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      `# navori:managed start id="codex-config-base"\nsandbox_mode = "read-only"\n# navori:managed end id="codex-config-base"\n`,
    );
    expect(scanMalformedMarkers(cwd)).toHaveLength(0);
  });
});

// #235: render/sync manage the managed blocks in EVERY monorepo workspace, so
// the health scans must inspect them too — a root-only scan let a workspace drift
// exit `doctor --strict` green while `sync` saw a conflict.
describe("monorepo workspace scanning (#235)", () => {
  let cwd: string;
  const monorepoConfig = (workspaces: Array<{ name: string; path: string }>) =>
    NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      monorepo: { enabled: true, workspaces },
    });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-mono-health-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("scanManagedDrift detects content drift in a workspace CLAUDE.md, path-prefixed", () => {
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    writeFileSync(
      join(cwd, "apps/api/CLAUDE.md"),
      `<!-- navori:managed id="idioma-rol" hash="deadbeef" version="9.9.9" source="@navori/core" -->\n` +
        `hand-edited in the workspace\n<!-- /navori:managed id="idioma-rol" -->\n`,
    );
    const drifts = scanManagedDrift(cwd, monorepoConfig([{ name: "api", path: "apps/api" }]));
    expect(
      drifts.some(
        (d) =>
          d.kind === "content" &&
          d.markerId === "idioma-rol" &&
          d.filePath === "apps/api/CLAUDE.md",
      ),
    ).toBe(true);
  });

  it("scanManagedDrift skips an orphaned (missing) workspace dir", () => {
    // Declared in config but never created on disk — render skips it, so must we.
    expect(
      scanManagedDrift(cwd, monorepoConfig([{ name: "gone", path: "apps/gone" }])),
    ).toHaveLength(0);
  });

  it("scanManagedOrder reports an out-of-order workspace CLAUDE.md tagged with its path", () => {
    // No root CLAUDE.md → root is clean → the scan falls through to the workspace.
    // Use engine-COMPUTED blocks, not the root-only spine (idioma-rol/orquestacion):
    // a workspace render omits root-only blocks, and #266 makes doctor's workspace
    // scan mirror that (`omitRootOnly:true`), so a realistic workspace order-drift is
    // a swap among the computed blocks (threaded via CLAUDE_COMPUTED_BLOCK_IDS).
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    let doc = injectManagedSection("", "agentes-disponibles", "x").output;
    doc = injectManagedSection(doc, "skills-index", "y").output; // canonical: skills-index first
    writeFileSync(join(cwd, "apps/api/CLAUDE.md"), doc);

    const r = scanManagedOrder(
      cwd,
      monorepoConfig([{ name: "api", path: "apps/api" }]),
      CLAUDE_COMPUTED_BLOCK_IDS,
    );
    expect(r).not.toBeNull();
    expect(r!.workspacePath).toBe("apps/api");
    expect(r!.current).toEqual(["agentes-disponibles", "skills-index"]);
    expect(r!.expected).toEqual(["skills-index", "agentes-disponibles"]);
  });

  it("scanMalformedMarkers scans workspace files when passed the config", () => {
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    writeFileSync(
      join(cwd, "apps/api/CLAUDE.md"),
      `<!-- navori:managed id="idioma-rol" hash="abc" version="9.9.9" source="@navori/core"\n` +
        `body\n<!-- /navori:managed id="idioma-rol" -->\n`,
    );
    const found = scanMalformedMarkers(cwd, monorepoConfig([{ name: "api", path: "apps/api" }]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: "apps/api/CLAUDE.md", line: 1 });
    // Without the config, the workspace is invisible (root-only, back-compat).
    expect(scanMalformedMarkers(cwd)).toHaveLength(0);
  });

  // #266: a LOCAL preset lives at the monorepo root (`.navori/presets/`), not in
  // the workspace. Resolving it against the workspace dir dropped its managed block
  // from doctor's canonical order and shunted it to the tail → a permanent false
  // order-drift report that `render` could never clear.
  it("scanManagedOrder does not false-positive on a LOCAL preset block in a workspace (#266)", () => {
    const presetDir = join(cwd, ".navori/presets/mypreset");
    mkdirSync(join(presetDir, "managed"), { recursive: true });
    writeFileSync(
      join(presetDir, "mypreset.json"),
      JSON.stringify({
        id: "mypreset",
        displayName: "Local preset",
        extends: "core",
        extras: {
          managed: [{ id: "stack-mypreset", relPath: "managed/stack.md" }],
          agents: [],
          skills: [],
          hooks: [],
        },
      }),
    );
    writeFileSync(join(presetDir, "managed/stack.md"), "## Local stack\n\nStack notes.\n");

    const config = NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude"],
      preset: "mypreset",
      monorepo: { enabled: true, workspaces: [{ name: "backend", path: "apps/backend" }] },
    });
    const ws = config.monorepo!.workspaces[0]!;

    // Render the workspace CLAUDE.md the way `render` does: repoRoot = monorepo
    // root, so the local preset resolves and `stack-mypreset` is emitted BEFORE
    // the computed blocks — the byte-correct on-disk order.
    const wsCwd = join(cwd, ws.path);
    mkdirSync(wsCwd, { recursive: true });
    renderClaudeEngine(wsCwd, effectiveConfigForWorkspace(config, ws), { repoRoot: cwd });

    // Sanity: the rendered file really carries the local-preset block.
    expect(listMarkers(join(wsCwd, "CLAUDE.md")).map((m) => m.id)).toContain("stack-mypreset");

    // Doctor must agree with render — no drift. Before the fix this returned a
    // non-null report (stack-mypreset expected at the tail).
    expect(scanManagedOrder(cwd, config, CLAUDE_COMPUTED_BLOCK_IDS)).toBeNull();
  });
});

describe("scanDuplicateMarkers (#274)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-dup-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const dupBlock = (id: string, body: string): string =>
    `<!-- navori:managed id="${id}" hash="${computeManagedHash(body)}" version="9.9.9" source="@navori/core" -->\n` +
    `${body}\n<!-- /navori:managed id="${id}" -->\n`;

  it("reports a managed id that appears twice in the same file", () => {
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      dupBlock("sdd", "first copy") + dupBlock("sdd", "STALE second copy"),
    );
    const found = scanDuplicateMarkers(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: "CLAUDE.md", id: "sdd", count: 2 });
  });

  it("returns [] for a healthy file with unique ids", () => {
    const doc = injectManagedSection("", "idioma-rol", "x").output;
    writeFileSync(join(cwd, "CLAUDE.md"), doc);
    expect(scanDuplicateMarkers(cwd)).toHaveLength(0);
  });

  it("scans monorepo workspaces when passed the config", () => {
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    writeFileSync(join(cwd, "apps/api/CLAUDE.md"), dupBlock("sdd", "a") + dupBlock("sdd", "b"));
    const config = NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      monorepo: { enabled: true, workspaces: [{ name: "api", path: "apps/api" }] },
    });
    const found = scanDuplicateMarkers(cwd, config);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ filePath: "apps/api/CLAUDE.md", id: "sdd", count: 2 });
    // Without the config the workspace is invisible (root-only).
    expect(scanDuplicateMarkers(cwd)).toHaveLength(0);
  });
});

// #275: `.claude/hooks/*.sh` are marker-managed (shell style) but were absent
// from ENGINE_OUTPUTS[claude], so doctor/status stayed blind to their content
// drift — including the security guard `guard-destructive.sh`.
describe("scanManagedDrift covers .claude/hooks/*.sh (#275)", () => {
  let cwd: string;
  const config = NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" });
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-hooks-drift-"));
    mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("reports content drift when a hook's managed body is tampered with", () => {
    // A shell marker whose body no longer hashes to its `hash=` (hand/malicious edit).
    writeFileSync(
      join(cwd, ".claude/hooks/guard-destructive.sh"),
      `# navori:managed start id="guard-destructive-base" hash="deadbeef" version="9.9.9" source="@navori/core"\n` +
        `echo TAMPERED_BY_ATTACKER\n# navori:managed end id="guard-destructive-base"\n`,
    );
    const drifts = scanManagedDrift(cwd, config);
    expect(
      drifts.some(
        (d) => d.kind === "content" && d.filePath === ".claude/hooks/guard-destructive.sh",
      ),
    ).toBe(true);
  });

  it("no drift when the hook body matches its hash", () => {
    const body = 'echo "safe"';
    writeFileSync(
      join(cwd, ".claude/hooks/guard-destructive.sh"),
      `# navori:managed start id="guard-destructive-base" hash="${computeManagedHash(body)}" version="9.9.9" source="@navori/core"\n` +
        `${body}\n# navori:managed end id="guard-destructive-base"\n`,
    );
    // Only version drift (9.9.9 ≠ CLI version) may appear; no content drift.
    const drifts = scanManagedDrift(cwd, config);
    expect(drifts.some((d) => d.kind === "content")).toBe(false);
  });
});

// #281: a transient fs error (EMFILE/ENFILE/EAGAIN) from loadPlugin must NOT be
// misclassified as a missing plugin — that flipped doctor's verdict and made the
// e2e suite flaky under parallelism. A real unknown plugin still lists as missing.
describe("collectMissingPlugins classifies transient fs errors (#281)", () => {
  const cfg = () =>
    NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      plugins: { engram: { enabled: true } },
    });

  afterEach(() => vi.restoreAllMocks());

  it("rethrows a transient EMFILE instead of counting the plugin as missing", () => {
    const emfile = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    vi.spyOn(plugins, "loadPlugin").mockImplementation(() => {
      throw emfile;
    });
    expect(() => collectMissingPlugins(cfg())).toThrow(/EMFILE/);
  });

  it("still lists a genuinely unknown plugin as missing", () => {
    const missing = collectMissingPlugins(
      NavoriConfigSchema.parse({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        plugins: { "ghost-plugin": { enabled: true } },
      }),
    );
    expect(missing.map((m) => m.id)).toContain("ghost-plugin");
  });
});

// #312: when config.engines narrows, a disabled engine's leftover outputs
// (AGENTS.md, .codex/, .cursor/…) linger. They must NOT be reported as
// actionable drift — render never revisits them — but surfaced as orphans that
// `render --prune` removes.
describe("orphaned engine outputs (#312)", () => {
  let cwd: string;
  const claudeOnly = NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-orphan-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  // A hand-edited (or version-stale) AGENTS.md owned by no configured engine is
  // an orphan, so the actionable drift scan stays silent about it.
  it("scanManagedDrift ignores an orphaned AGENTS.md under engines:['claude']", () => {
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `<!-- navori:managed id="navori-agents" hash="deadbeef" version="9.9.9" source="@navori/core" -->\n` +
        `stale orphaned block\n<!-- /navori:managed id="navori-agents" -->\n`,
    );
    expect(scanManagedDrift(cwd, claudeOnly)).toHaveLength(0);
  });

  it("scanOrphanedEngineOutputs lists AGENTS.md as an orphan of a disabled engine", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "any content\n");
    const orphans = scanOrphanedEngineOutputs(cwd, claudeOnly);
    const paths = orphans.flatMap((o) => o.paths);
    expect(paths).toContain("AGENTS.md");
  });

  it("collapses .codex file outputs to the .codex/ directory", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(join(cwd, ".codex/config.toml"), "x\n");
    mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
    const orphans = scanOrphanedEngineOutputs(cwd, claudeOnly);
    const codex = orphans.find((o) => o.engine === "codex");
    expect(codex?.paths).toContain(".codex");
    expect(codex?.paths).toContain(".agents");
    // The nested config.toml folds into the parent dir — not listed separately.
    expect(codex?.paths).not.toContain(".codex/config.toml");
  });

  // The AGENTS.md overlap guard: it's owned by BOTH codex and agents-md, so it's
  // only an orphan when NEITHER is configured. With codex still enabled it stays.
  it("does NOT flag AGENTS.md when a still-enabled engine (codex) also owns it", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "shared content\n");
    const codexEnabled = NavoriConfigSchema.parse({
      name: "demo",
      engines: ["codex"],
      preset: "custom",
    });
    const orphans = scanOrphanedEngineOutputs(cwd, codexEnabled);
    expect(orphans.flatMap((o) => o.paths)).not.toContain("AGENTS.md");
  });

  it("flags AGENTS.md once when both codex and agents-md are disabled", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "content\n");
    const orphans = scanOrphanedEngineOutputs(cwd, claudeOnly);
    const agentsMdPaths = orphans.flatMap((o) => o.paths).filter((p) => p === "AGENTS.md");
    expect(agentsMdPaths).toHaveLength(1);
  });

  it("returns nothing when no disabled engine has outputs on disk", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "content\n");
    expect(scanOrphanedEngineOutputs(cwd, claudeOnly)).toHaveLength(0);
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
