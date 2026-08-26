import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { runCommand } = await import("citty");
const { writeConfig } = await import("../../lib/config.ts");
const { runRender, renderCommand } = await import("../render.ts");
const { injectManagedSection } = await import("../../lib/marker.ts");
const { readCliVersion } = await import("../../lib/bundled-assets.ts");

let cwd: string;

/** A file exactly as an engine would have rendered it: managed marker, current
 *  version, navori as the source. The only shape the prune may delete. */
const navoriAuthored = (id: string, body: string): string =>
  injectManagedSection("", id, `${body}\n`, {
    version: readCliVersion(),
    source: "@navori/core",
  }).output;

const AGENTS_MD = navoriAuthored("agentes-disponibles", "rendered by navori");
const CODEX_TOML = navoriAuthored("codex-config", 'sandbox_mode = "read-only"');

/** Every file under `dir`, as `dir`-relative paths, sorted — the assertion shape
 *  from `backup-proportional.test.ts:93`: it fails on a MISSING file and on an
 *  extra one, which `existsSync` per path never does. */
function listFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-prune-"));
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

  it("deletes orphaned outputs with --prune on an apply run", () => {
    const result = runRender(cwd, { dryRun: false, prune: true });
    expect(result.prunedEngineOutputs).toContain("AGENTS.md");
    // Reported file by file — a directory is emptied, never removed sight unseen.
    expect(result.prunedEngineOutputs).toContain(".codex/config.toml");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    // The directory goes too once nothing of the user's is left in it; otherwise
    // the orphan scan would report an empty `.codex` forever.
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
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
