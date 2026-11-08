import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, makeSandboxDirs, navoriAuthored } from "./prune-fixtures.ts";

/**
 * #312: outputs left behind by an engine removed from config.engines[] (a stale
 * AGENTS.md / .codex after narrowing to claude) must be reported by render, and
 * deleted only with `--prune` on an apply run — never in preview. createBackup
 * writes under ~/.navori/backups, so safeHomedir is mocked to a throwaway home.
 *
 * #496: and only the FILES navori itself wrote. The orphan scan reports paths
 * from a static per-engine map, so "`.cursor/` belongs to a disabled engine" is
 * a statement about ownership, not about who authored the bytes.
 *
 * #504.1: the safety net gets asserted, not assumed. Backing up before deleting
 * was covered by exactly zero assertions — swapping `createBackup(cwd, paths)`
 * for `createBackup(cwd, [])` left the whole 2124-test suite green.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { runCommand } = await import("citty");
const { writeConfig, readConfig, effectiveConfig } = await import("../../lib/config/config.ts");
const { parseAsset } = await import("../../engines/claude/parse-asset.ts");
const { interpolate } = await import("../../lib/render/interpolate.ts");
const { runRender, renderCommand } = await import("../render.ts");
const { injectManagedSection } = await import("../../lib/render/marker.ts");
const { readCliVersion, getCoreRoot } = await import("../../lib/render/bundled-assets.ts");

let cwd: string;

const AGENTS_MD = navoriAuthored("agentes-disponibles", "rendered by navori");
const CODEX_TOML = navoriAuthored("codex-config", 'sandbox_mode = "read-only"', "shell");

beforeEach(() => {
  ({ home: home.dir, cwd } = makeSandboxDirs("render-prune"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
  // Leftovers from a previously-configured agents-md/codex engine, both carrying
  // navori's marker because navori is what wrote them.
  writeFileSync(join(cwd, "AGENTS.md"), AGENTS_MD);
  mkdirSync(join(cwd, ".codex"), { recursive: true });
  writeFileSync(join(cwd, ".codex/config.toml"), CODEX_TOML);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("runRender — orphaned engine output pruning (#312)", () => {
  it("reports orphaned outputs without deleting them (no --prune)", () => {
    const result = runRender(cwd, { dryRun: false, prune: false });
    expect(result.ok).toBe(true);
    const orphanPaths = (result.orphanedEngineOutputs ?? []).flatMap((o) => o.paths);
    expect(orphanPaths).toContain("AGENTS.md");
    expect(orphanPaths).toContain(".codex");
    expect(result.prunedEngineOutputs ?? []).toHaveLength(0);
    // Left untouched.
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex"))).toBe(true);
  });

  it("does NOT delete on --prune in preview mode — it reports the plan instead", () => {
    const result = runRender(cwd, { dryRun: true, prune: true });
    // #521: this used to assert `prunedEngineOutputs` was EMPTY here, pinning
    // the defect as the contract — the preview's silence was the bug, not the
    // safety. The invariant is that nothing is deleted, and it still holds; the
    // plan travels back so the user can approve it (equivalence with the apply
    // plan is pinned in `render-prune-preview.test.ts`).
    expect(result.prunedEngineOutputs).toEqual([".codex/config.toml", "AGENTS.md"]);
    expect(result.prunedBackupPath).toBeNull();
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex"))).toBe(true);
  });

  // Covers: R7, R11 — #1291: the protective ignore survives only while Codex state exists.
  it("keeps .codex/.gitignore on --prune while .codex/progress/ state exists", () => {
    mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
    writeFileSync(join(cwd, ".codex/progress/receipt.txt"), "APPROVED\n");

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).not.toContain(".codex/.gitignore");
    expect(existsSync(join(cwd, ".codex/.gitignore"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/config.toml"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/progress/receipt.txt"))).toBe(true);
  });

  // #1291: render -> prune -> render never creates and deletes the same file.
  it.each(["pi", "claude"] as const)(
    "%s-only config: no nested .gitignore for disabled engines, round trip is stable",
    (engine) => {
      rmSync(join(cwd, ".codex"), { recursive: true, force: true });
      rmSync(join(cwd, "AGENTS.md"), { force: true });
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines: [engine],
        preset: "custom",
      });

      runRender(cwd, { dryRun: false });
      const pruneRun = runRender(cwd, { dryRun: false, prune: true });
      const second = runRender(cwd, { dryRun: false });

      if (engine === "pi") expect(existsSync(join(cwd, ".claude/.gitignore"))).toBe(false);
      expect(existsSync(join(cwd, ".codex/.gitignore"))).toBe(false);
      expect(pruneRun.prunedEngineOutputs ?? []).toEqual([]);
      expect((second.orphanedEngineOutputs ?? []).flatMap((o) => o.paths)).toEqual([]);
    },
  );

  // #1291: upgrade path — a nested file rendered by an older navori in a repo that disabled the engine.
  it("existing .claude/.gitignore in a pi-only repo: kept with state, pruned with backup without", () => {
    rmSync(join(cwd, ".codex"), { recursive: true, force: true });
    rmSync(join(cwd, "AGENTS.md"), { force: true });
    runRender(cwd, { dryRun: false });
    expect(existsSync(join(cwd, ".claude/.gitignore"))).toBe(true);
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["pi"],
      preset: "custom",
    });
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/x"), "state\n");

    const kept = runRender(cwd, { dryRun: false, prune: true });
    expect(kept.prunedEngineOutputs ?? []).not.toContain(".claude/.gitignore");
    expect(existsSync(join(cwd, ".claude/.gitignore"))).toBe(true);

    rmSync(join(cwd, ".claude/progress"), { recursive: true, force: true });
    const pruned = runRender(cwd, { dryRun: false, prune: true });
    expect(pruned.prunedEngineOutputs).toContain(".claude/.gitignore");
    expect(pruned.prunedBackupPath).not.toBeNull();
    expect(existsSync(join(cwd, ".claude/.gitignore"))).toBe(false);

    runRender(cwd, { dryRun: false });
    expect(existsSync(join(cwd, ".claude/.gitignore"))).toBe(false);
  });

  it("deletes orphaned outputs with --prune on an apply run", () => {
    const result = runRender(cwd, { dryRun: false, prune: true });
    expect(result.prunedEngineOutputs).toContain("AGENTS.md");
    // Reported file by file — a directory is emptied, never removed sight unseen.
    expect(result.prunedEngineOutputs).toContain(".codex/config.toml");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    // #1291: Claude-only with no Codex state — render never wrote a protective
    // `.codex/.gitignore`, so there is nothing to prune or keep.
    expect(result.prunedEngineOutputs).not.toContain(".codex/.gitignore");
    expect(existsSync(join(cwd, ".codex/.gitignore"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/config.toml"))).toBe(false);
  });

  it("keeps AGENTS.md when agents-md is still a configured engine", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude", "agents-md"],
      preset: "custom",
    });
    const result = runRender(cwd, { dryRun: false, prune: true });
    const orphanPaths = (result.orphanedEngineOutputs ?? []).flatMap((o) => o.paths);
    expect(orphanPaths).not.toContain("AGENTS.md");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
  });
});

describe("runRender --prune — the backup is the safety net, so it is asserted (#504.1)", () => {
  it("snapshots the deleted files WITH their pre-deletion content", () => {
    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedBackupPath).toBeTruthy();
    const backup = result.prunedBackupPath as string;
    // A listing, not an existsSync per path: an empty backup (the mutation that
    // kept 2124/2124 green) fails here, and so does a backup that grew a file.
    expect(listFiles(backup)).toEqual(["AGENTS.md", ".codex/config.toml"].sort());
    // Content, not just presence — a backup of empty files restores nothing.
    expect(readFileSync(join(backup, "AGENTS.md"), "utf-8")).toBe(AGENTS_MD);
    expect(readFileSync(join(backup, ".codex/config.toml"), "utf-8")).toBe(CODEX_TOML);
  });

  it("never copies the ephemeral harness state into the backup (#348)", () => {
    // `.codex/progress/` is where the Codex receipt lives. Copying it is what
    // filled a disk with 131 GB of backups, and restoring it resurrects a stale
    // receipt that blocks the next commit.
    mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
    writeFileSync(join(cwd, ".codex/progress/receipt.txt"), "APPROVED\n");

    const result = runRender(cwd, { dryRun: false, prune: true });
    const backup = result.prunedBackupPath as string;

    expect(listFiles(backup)).toEqual(["AGENTS.md", ".codex/config.toml"].sort());
    // Not deleted either: it is not navori's to remove, and the run says so.
    expect(existsSync(join(cwd, ".codex/progress/receipt.txt"))).toBe(true);
    expect(result.keptEngineOutputs).toContainEqual({
      path: ".codex/progress",
      reason: "ephemeral",
    });
  });

  it("takes no backup and reports nothing pruned when nothing is navori's", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "escrito a mano\n");
    rmSync(join(cwd, ".codex"), { recursive: true, force: true });

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).toEqual([]);
    expect(result.prunedBackupPath).toBeNull();
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
  });
});

describe("runRender --prune — deletes navori's files, never the user's (#496)", () => {
  it("empties a mixed .cursor/ of navori's file only, and reports what it spared", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    mkdirSync(join(cwd, ".cursor/rules"), { recursive: true });
    // navori's own output…
    writeFileSync(join(cwd, ".cursor/rules/navori.mdc"), navoriAuthored("cursor-rules", "managed"));
    // …next to the user's own rules and their MCP config.
    writeFileSync(join(cwd, ".cursor/rules/mis-reglas.mdc"), "reglas propias del usuario\n");
    writeFileSync(join(cwd, ".cursor/mcp.json"), '{"mcpServers":{}}\n');

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).toContain(".cursor/rules/navori.mdc");
    expect(existsSync(join(cwd, ".cursor/rules/navori.mdc"))).toBe(false);
    // The user's files — and therefore the directory — survive.
    expect(readFileSync(join(cwd, ".cursor/rules/mis-reglas.mdc"), "utf-8")).toBe(
      "reglas propias del usuario\n",
    );
    expect(readFileSync(join(cwd, ".cursor/mcp.json"), "utf-8")).toBe('{"mcpServers":{}}\n');
    expect(result.keptEngineOutputs).toEqual(
      expect.arrayContaining([
        { path: ".cursor/rules/mis-reglas.mdc", reason: "foreign" },
        { path: ".cursor/mcp.json", reason: "foreign" },
      ]),
    );
  });

  it("does not delete a hand-written AGENTS.md or copilot-instructions.md", () => {
    // The issue's exact reproduction: files the user typed, in paths a disabled
    // engine happens to own.
    writeFileSync(join(cwd, "AGENTS.md"), "# Notas a mano\n");
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(join(cwd, ".github/copilot-instructions.md"), "instrucciones a mano\n");

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe("# Notas a mano\n");
    expect(readFileSync(join(cwd, ".github/copilot-instructions.md"), "utf-8")).toBe(
      "instrucciones a mano\n",
    );
    expect(result.prunedEngineOutputs).not.toContain("AGENTS.md");
    expect(result.keptEngineOutputs).toContainEqual({ path: "AGENTS.md", reason: "foreign" });
  });

  it("removes a `.mcp.json` navori generated whole, with the engine that motivated it (#557)", () => {
    // Reproduction from the issue: `claude` out of `engines[]`, and the registry
    // it wrote left on disk — pointing at MCP servers nobody will read again —
    // without a single line of the run mentioning it.
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["codex"],
      preset: "custom",
    });
    writeFileSync(
      join(cwd, ".mcp.json"),
      `${JSON.stringify(
        {
          $navori: { managed: true, version: readCliVersion() },
          mcpServers: { engram: { command: "engram", args: ["mcp"] } },
        },
        null,
        2,
      )}\n`,
    );

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).toContain(".mcp.json");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });

  it("keeps a `.mcp.json` that is the user's, and SAYS it kept it (#557)", () => {
    // The nuance the fix turns on: navori only ever added keys to this file, so
    // deleting it would take the user's server with it. Keeping it silently is
    // what the issue objected to — the user could not tell it had been left.
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["codex"],
      preset: "custom",
    });
    const usersRegistry = `${JSON.stringify(
      { mcpServers: { "my-server": { command: "my-bin", args: [] } } },
      null,
      2,
    )}\n`;
    writeFileSync(join(cwd, ".mcp.json"), usersRegistry);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, ".mcp.json"), "utf-8")).toBe(usersRegistry);
    expect(result.prunedEngineOutputs).not.toContain(".mcp.json");
    expect(result.keptEngineOutputs).toContainEqual({ path: ".mcp.json", reason: "foreign" });
  });

  it("does not delete a managed file a NEWER navori wrote (anti-rollback)", () => {
    writeFileSync(
      join(cwd, "AGENTS.md"),
      injectManagedSection("", "agentes-disponibles", "del futuro\n", {
        version: "99.0.0",
        source: "@navori/core",
      }).output,
    );

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(result.prunedEngineOutputs).not.toContain("AGENTS.md");
  });
});

/**
 * #479's failure mode, in the shape this very block cites: a signal the human
 * report prints but the machine-readable one omits. `prunedEngineOutputs` says
 * what went; without its companion a `--json` consumer cannot tell "nothing was
 * orphaned" from "everything under there is yours and I left it".
 */
describe("render --json publishes what the prune SPARED, not only what it deleted", () => {
  interface PrunePayload {
    prunedEngineOutputs: string[];
    keptEngineOutputs: Array<{ path: string; reason: string }>;
  }

  it("carries keptEngineOutputs next to prunedEngineOutputs", async () => {
    // The fixture's AGENTS.md is navori's; hand-written, it becomes the spared
    // half, so the payload has to report both at once.
    writeFileSync(join(cwd, "AGENTS.md"), "escrito a mano\n");

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    try {
      await runCommand(renderCommand, {
        rawArgs: ["--cwd", cwd, "--apply", "--prune", "--json"],
      });
    } finally {
      spy.mockRestore();
    }

    const payload = JSON.parse(lines.at(-1) as string) as PrunePayload;
    expect(payload.prunedEngineOutputs).toEqual([".codex/config.toml"]);
    expect(payload.keptEngineOutputs).toEqual([{ path: "AGENTS.md", reason: "foreign" }]);
  });
});

/**
 * #1604: removing an engine removes its managed BLOCKS, not the user's text. The
 * files here are rendered by the real engines (so the scaffold is the one navori
 * writes, not a copy of it in the test), then the engine is disabled and pruned.
 */
describe("runRender --prune — user text outside the blocks survives (#1604)", () => {
  const NOTES = "\n## Mis notas\nTexto propio del usuario.\n";

  /** Render with `engines`, then narrow the config to `remaining` (the prune's trigger). */
  function renderThenDisable(engines: string[], remaining: string[]): void {
    rmSync(join(cwd, "AGENTS.md"), { force: true });
    rmSync(join(cwd, ".codex"), { recursive: true, force: true });
    writeConfig(join(cwd, "navori.config.json"), { name: "demo", engines, preset: "custom" });
    runRender(cwd, { dryRun: false });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: remaining,
      preset: "custom",
    });
  }

  /** Prune and check the file stayed, minus every managed block, with a backup of the original. */
  function expectStripped(rel: string, userText: string): void {
    const original = readFileSync(join(cwd, rel), "utf-8");
    const result = runRender(cwd, { dryRun: false, prune: true });

    const after = readFileSync(join(cwd, rel), "utf-8");
    expect(after).not.toContain("navori:managed");
    expect(after).toContain(userText);
    expect(result.strippedEngineOutputs).toContain(rel);
    expect(result.prunedEngineOutputs).not.toContain(rel);
    expect(readFileSync(join(result.prunedBackupPath as string, rel), "utf-8")).toBe(original);
  }

  it.each([
    ["AGENTS.md (agents-md scaffold)", ["claude", "agents-md"], ["claude"], "AGENTS.md"],
    ["AGENTS.md (codex scaffold)", ["claude", "codex"], ["claude"], "AGENTS.md"],
    [
      ".github/copilot-instructions.md",
      ["claude", "copilot"],
      ["claude"],
      ".github/copilot-instructions.md",
    ],
    ["CLAUDE.md", ["claude", "agents-md"], ["agents-md"], "CLAUDE.md"],
  ])("%s: kept with its blocks stripped and the text intact", (_name, engines, remaining, rel) => {
    renderThenDisable(engines, remaining);
    expect(readFileSync(join(cwd, rel), "utf-8")).toContain("navori:managed");
    writeFileSync(join(cwd, rel), `${readFileSync(join(cwd, rel), "utf-8")}${NOTES}`);

    expectStripped(rel, "## Mis notas\nTexto propio del usuario.\n");
  });

  it("keeps everything outside the blocks byte-for-byte", () => {
    const mine = `# Mi proyecto\n\nuna linea\n\n${NOTES.trimStart()}`;
    writeFileSync(join(cwd, "AGENTS.md"), `${AGENTS_MD}${mine}`);

    runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(mine);
  });

  it("a pristine scaffold (nothing of the user's) is still deleted whole", () => {
    renderThenDisable(["claude", "agents-md"], ["claude"]);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(result.prunedEngineOutputs).toContain("AGENTS.md");
    expect(result.strippedEngineOutputs).toEqual([]);
  });

  it("only whitespace and blank lines outside the blocks is not user text: deleted", () => {
    writeFileSync(join(cwd, "AGENTS.md"), `\n  \n${AGENTS_MD}\n\n\t\n   \n`);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(result.prunedEngineOutputs).toContain("AGENTS.md");
    expect(result.strippedEngineOutputs).toEqual([]);
  });

  it("a single user line outside the blocks is enough to keep the file", () => {
    writeFileSync(join(cwd, "AGENTS.md"), `${AGENTS_MD}\nsolo una linea mia\n`);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe("\nsolo una linea mia\n");
    expect(result.strippedEngineOutputs).toEqual(["AGENTS.md"]);
    expect(result.prunedEngineOutputs).not.toContain("AGENTS.md");
  });

  it("a skill file with only navori's frontmatter around its block is still deleted", () => {
    mkdirSync(join(cwd, ".agents/skills/demo"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents/skills/demo/SKILL.md"),
      `---\nname: demo\ndescription: demo skill\n---\n\n${navoriAuthored("demo", "body")}`,
    );

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(existsSync(join(cwd, ".agents/skills/demo/SKILL.md"))).toBe(false);
    expect(result.prunedEngineOutputs).toContain(".agents/skills/demo/SKILL.md");
    expect(result.strippedEngineOutputs).not.toContain(".agents/skills/demo/SKILL.md");
  });

  // The exemptions below belong to ONE file kind each: outside it, the same bytes
  // are the user's and must keep the file.
  it.each([
    ["AGENTS.md", "claude"],
    ["CLAUDE.md", "agents-md"],
    [".github/copilot-instructions.md", "claude"],
  ])("%s: the user's own frontmatter outside the blocks keeps the file", (rel, enabled) => {
    mkdirSync(join(cwd, ".github"), { recursive: true });
    // The engine that writes the file must be the disabled one, so it is an orphan.
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: [enabled],
      preset: "custom",
    });
    const mine = "---\ntitle: mio\n---\n";
    writeFileSync(join(cwd, rel), `${mine}${AGENTS_MD}`);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, rel), "utf-8")).toBe(mine);
    expect(result.strippedEngineOutputs).toContain(rel);
  });

  it("a user line in .codex/config.toml keeps it, even one shaped like a shebang", () => {
    writeFileSync(join(cwd, ".codex/config.toml"), `#!/usr/bin/env mine\n${CODEX_TOML}`);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, ".codex/config.toml"), "utf-8")).toBe("#!/usr/bin/env mine\n");
    expect(result.strippedEngineOutputs).toContain(".codex/config.toml");
  });

  describe("extension zones are matched EXACTLY against the bundled assets", () => {
    /** The zone a bundled asset seeds after its user-section marker, as render writes it. */
    const seededZone = (asset: string, marker: string): string => {
      const text = readFileSync(join(getCoreRoot(), "core-assets", asset), "utf-8");
      return `\n${text.slice(text.indexOf(marker) + marker.length).replace(/^\n/, "")}`;
    };
    const HOOK_ZONE = (): string =>
      seededZone("hooks/guard-destructive.sh", "# navori:user-section");
    const AGENT_ZONE = (): string =>
      seededZone("agents/scout.md", "<!-- navori:user-section -->").replace(
        /\{\{[^}]*\}\}/g,
        "legacy/, vendor/",
      );

    beforeEach(() => {
      mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
      mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines: ["agents-md"],
        preset: "custom",
      });
    });

    it("a hook / agent holding only the seeded zone is deleted", () => {
      writeFileSync(
        join(cwd, ".claude/hooks/a.sh"),
        `${navoriAuthored("a", "#!/usr/bin/env bash", "shell")}${HOOK_ZONE()}`,
      );
      writeFileSync(
        join(cwd, ".claude/agents/a.md"),
        `---\nname: a\n---\n${navoriAuthored("a", "body")}${AGENT_ZONE()}`,
      );

      const result = runRender(cwd, { dryRun: false, prune: true });

      expect(existsSync(join(cwd, ".claude/hooks/a.sh"))).toBe(false);
      expect(existsSync(join(cwd, ".claude/agents/a.md"))).toBe(false);
      expect(result.strippedEngineOutputs).toEqual([]);
    });

    it("a hook with one comment line of the user's is kept", () => {
      const mine = `${HOOK_ZONE()}# my guard\n`;
      writeFileSync(
        join(cwd, ".claude/hooks/b.sh"),
        `${navoriAuthored("b", "#!/usr/bin/env bash", "shell")}${mine}`,
      );

      const result = runRender(cwd, { dryRun: false, prune: true });

      expect(result.strippedEngineOutputs).toEqual([".claude/hooks/b.sh"]);
      expect(readFileSync(join(cwd, ".claude/hooks/b.sh"), "utf-8")).toBe(mine);
    });

    it("a hook with a command of the user's is kept", () => {
      const mine = `${HOOK_ZONE()}echo mine\n`;
      writeFileSync(
        join(cwd, ".claude/hooks/c.sh"),
        `${navoriAuthored("c", "#!/usr/bin/env bash", "shell")}${mine}`,
      );

      runRender(cwd, { dryRun: false, prune: true });

      expect(readFileSync(join(cwd, ".claude/hooks/c.sh"), "utf-8")).toBe(mine);
    });

    it("an agent whose seeded comment was edited is kept", () => {
      const edited = AGENT_ZONE().replace("add here", "I wrote here");
      expect(edited).not.toBe(AGENT_ZONE());
      writeFileSync(
        join(cwd, ".claude/agents/b.md"),
        `---\nname: b\n---\n${navoriAuthored("b", "body")}${edited}`,
      );

      const result = runRender(cwd, { dryRun: false, prune: true });

      expect(result.strippedEngineOutputs).toEqual([".claude/agents/b.md"]);
      expect(readFileSync(join(cwd, ".claude/agents/b.md"), "utf-8")).toBe(
        `---\nname: b\n---\n${edited}`,
      );
    });
  });

  describe("a `{{var}}` line of a seeded zone is compared literally, never as a pattern", () => {
    // Every bundled zone that interpolates a project value.
    const WITH_VARS: ReadonlyArray<[string, string]> = [
      ["agents/orchestrator.md", ".claude/agents/orchestrator.md"],
      ["agents/auditor.md", ".claude/agents/auditor.md"],
      ["agents/reviewer.md", ".claude/agents/reviewer.md"],
      ["agents/implementer.md", ".claude/agents/implementer.md"],
      ["skills/review-diff.md", ".claude/skills/review-diff.md"],
      ["skills/verify-before-done.md", ".claude/skills/verify-before-done.md"],
    ];
    const FILLED = { criticalAreas: ["auth", "billing"], legacyPaths: ["old/", "vendor/"] };

    /** Config on disk with the engine that writes the files disabled (so they are orphans). */
    const configure = (project?: typeof FILLED): void => {
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines: ["agents-md"],
        preset: "custom",
        ...(project ? { project } : {}),
      });
    };
    /** The zone template an asset seeds, rendered as the engines do with `project`. */
    const zoneOf = (asset: string, project?: Partial<typeof FILLED>): string => {
      const { userTemplate } = parseAsset(
        readFileSync(join(getCoreRoot(), "core-assets", asset), "utf-8"),
        "html",
      );
      const cfg = effectiveConfig(readConfig(join(cwd, "navori.config.json")));
      return interpolate(
        userTemplate as string,
        {
          ...cfg,
          project: { ...cfg.project, ...project },
        } as typeof cfg,
      );
    };
    const place = (rel: string, zone: string): void => {
      mkdirSync(join(cwd, rel, ".."), { recursive: true });
      writeFileSync(join(cwd, rel), `---\nname: x\n---\n${navoriAuthored("x", "body")}\n${zone}`);
    };

    it.each(WITH_VARS)("%s: text appended to a var line keeps the file", (asset, rel) => {
      configure(FILLED);
      const template = parseAsset(
        readFileSync(join(getCoreRoot(), "core-assets", asset), "utf-8"),
        "html",
      ).userTemplate as string;
      const at = template.split("\n").findIndex((line) => line.includes("{{"));
      const lines = zoneOf(asset).split("\n");
      lines[at] = `${lines[at]} MINE`;
      place(rel, lines.join("\n"));

      const result = runRender(cwd, { dryRun: false, prune: true });

      expect(result.strippedEngineOutputs).toContain(rel);
      expect(readFileSync(join(cwd, rel), "utf-8")).toContain(" MINE");
      expect(readFileSync(join(cwd, rel), "utf-8")).not.toContain("navori:managed");
    });

    it.each(WITH_VARS)(
      "%s: the untouched zone is deleted, current or init-time render",
      (asset, rel) => {
        // 1. Rendered with the config as it stands now.
        configure(FILLED);
        place(rel, zoneOf(asset));
        expect(runRender(cwd, { dryRun: false, prune: true }).prunedEngineOutputs).toContain(rel);
        expect(existsSync(join(cwd, rel))).toBe(false);

        // 2. Rendered at init (nothing declared), the user filled the values in later.
        place(rel, zoneOf(asset, { criticalAreas: undefined, legacyPaths: undefined }));
        expect(runRender(cwd, { dryRun: false, prune: true }).prunedEngineOutputs).toContain(rel);
        expect(existsSync(join(cwd, rel))).toBe(false);
      },
    );
  });

  describe("round trip: what the engines render is deleted when the engine is disabled", () => {
    const only = (engines: string[], project?: Record<string, unknown>): void =>
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines,
        preset: "custom",
        ...(project ? { project } : {}),
      } as Parameters<typeof writeConfig>[1]);

    it.each([
      ["current config", undefined],
      ["init-time render, criticalAreas declared afterwards", { criticalAreas: ["auth"] }],
    ])("claude, %s", (_name, later) => {
      only(["claude"]);
      runRender(cwd, { dryRun: false });
      expect(existsSync(join(cwd, ".claude/agents/orchestrator.md"))).toBe(true);
      only(["agents-md"], later);

      const result = runRender(cwd, { dryRun: false, prune: true });

      expect(result.strippedEngineOutputs).toEqual([]);
      for (const rel of [
        ".claude/agents/orchestrator.md",
        ".claude/agents/reviewer.md",
        ".claude/hooks/guard-destructive.sh",
        "CLAUDE.md",
      ]) {
        expect(existsSync(join(cwd, rel))).toBe(false);
      }
    });

    it("cursor: deleted as rendered, kept stripped with a user `globs` in its frontmatter", () => {
      only(["claude", "cursor"]);
      runRender(cwd, { dryRun: false });
      const rule = join(cwd, ".cursor/rules/navori.mdc");
      const rendered = readFileSync(rule, "utf-8");
      only(["claude"]);
      writeFileSync(
        rule,
        rendered.replace("alwaysApply: true", "alwaysApply: true\nglobs: src/**"),
      );

      const kept = runRender(cwd, { dryRun: false, prune: true });

      expect(kept.strippedEngineOutputs).toContain(".cursor/rules/navori.mdc");
      expect(readFileSync(rule, "utf-8")).toContain("globs: src/**");
      expect(readFileSync(rule, "utf-8")).not.toContain("navori:managed");

      writeFileSync(rule, rendered);
      const gone = runRender(cwd, { dryRun: false, prune: true });
      expect(gone.prunedEngineOutputs).toContain(".cursor/rules/navori.mdc");
      expect(existsSync(rule)).toBe(false);
    });
  });

  it("an orphaned Codex agents/openai.yaml (shell markers) is removed", () => {
    mkdirSync(join(cwd, ".agents/skills/x/agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents/skills/x/agents/openai.yaml"),
      navoriAuthored("x-openai-policy", "policy:\n  allow_implicit_invocation: false", "shell"),
    );

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(existsSync(join(cwd, ".agents/skills/x/agents/openai.yaml"))).toBe(false);
    expect(result.prunedEngineOutputs).toContain(".agents/skills/x/agents/openai.yaml");
  });

  it("a file with an extension no engine writes markers into is kept whole", () => {
    mkdirSync(join(cwd, ".agents/skills/x"), { recursive: true });
    writeFileSync(join(cwd, ".agents/skills/x/notes.txt"), navoriAuthored("n", "body"));

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(existsSync(join(cwd, ".agents/skills/x/notes.txt"))).toBe(true);
    expect(result.keptEngineOutputs).toContainEqual({
      path: ".agents/skills/x/notes.txt",
      reason: "modified",
    });
  });

  it("another engine's scaffold line is the user's text in this file", () => {
    // `# Copilot instructions` is Copilot's title, not AGENTS.md's.
    writeFileSync(join(cwd, "AGENTS.md"), `${AGENTS_MD}\n# Copilot instructions\n`);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe("\n# Copilot instructions\n");
    expect(result.strippedEngineOutputs).toContain("AGENTS.md");
  });

  it("CRLF files leave no stray carriage return where a block was", () => {
    writeFileSync(join(cwd, "AGENTS.md"), `${AGENTS_MD.trimEnd()}\r\nmio\r\n`);

    runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe("mio\r\n");
  });

  it("a marker that does not pair cleanly keeps the whole file, reported as modified", () => {
    const unclosed = `<!-- navori:managed id="x" hash="abc" version="${readCliVersion()}" -->\nmio\n`;
    writeFileSync(join(cwd, "AGENTS.md"), `${AGENTS_MD}${unclosed}`);
    const original = readFileSync(join(cwd, "AGENTS.md"), "utf-8");

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(original);
    expect(result.keptEngineOutputs).toContainEqual({ path: "AGENTS.md", reason: "modified" });
    expect(result.strippedEngineOutputs).not.toContain("AGENTS.md");
    expect(result.prunedEngineOutputs).not.toContain("AGENTS.md");
  });
});
