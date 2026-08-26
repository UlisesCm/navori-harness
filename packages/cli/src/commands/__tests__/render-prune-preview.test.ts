import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * #521: `render --prune` is the most destructive operation in the product, and
 * it could not be previewed. Without `--apply` it re-printed the orphan ROOTS —
 * the same list a plain `render` already prints — and `--json` answered
 * `prunedEngineOutputs: []`, `keptEngineOutputs: []`: empty values that read as
 * an answer without being one. The file-by-file verdict #496 introduced (delete
 * only what carries navori's marker, spare and NAME the rest) existed only
 * AFTER the deletion, which is the one moment it is no longer a decision.
 *
 * The property is EQUIVALENCE, not "preview returns something": on the same
 * fixture, the preview plan must be exactly the plan the apply executes — that
 * is what makes it safe to approve from.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { runCommand } = await import("citty");
const { writeConfig } = await import("../../lib/config.ts");
const { runRender, renderCommand } = await import("../render.ts");
const { injectManagedSection } = await import("../../lib/marker.ts");
const { readCliVersion } = await import("../../lib/bundled-assets.ts");

/** ANSI escapes, BUILT rather than written as a literal control char (which
 *  the linter rejects): picocolors keeps them under FORCE_COLOR. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

let cwd: string;

/** A file exactly as an engine would have rendered it: managed marker, current
 *  version, navori as the source — the only shape a prune may delete. */
const navoriAuthored = (id: string, body: string): string =>
  injectManagedSection("", id, `${body}\n`, {
    version: readCliVersion(),
    source: "@navori/core",
  }).output;

/** Every file under `dir`, as `dir`-relative paths, sorted: fails on a missing
 *  file AND on an extra one, which `existsSync` per path never does. */
function listFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else out.push(relative(root, full));
  }
  return out.sort();
}

/**
 * An orphaned `.codex/` of the shape the rollout met: navori's own file next to
 * the user's hand-written one and the ephemeral harness state — so the plan has
 * something in EVERY bucket (remove, foreign, ephemeral) and an equivalence
 * assertion cannot pass by comparing two empty lists.
 */
beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-prune-preview-"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
  mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
  mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
  writeFileSync(join(cwd, ".codex/config.toml"), navoriAuthored("codex-config", "sandbox = true"));
  writeFileSync(join(cwd, ".codex/agents/mio.toml"), "agente escrito a mano\n");
  writeFileSync(join(cwd, ".codex/progress/receipt.txt"), "APPROVED\n");
  writeFileSync(join(cwd, "AGENTS.md"), navoriAuthored("agentes-disponibles", "rendered"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("render --prune can be previewed (#521)", () => {
  it("reports in preview EXACTLY the plan the apply then executes", () => {
    const before = listFiles(cwd);

    const preview = runRender(cwd, { dryRun: true, prune: true });

    // Anti-false-green #1: the plan is non-trivial and reaches every bucket.
    // Both lists were `[]` before the fix, and `[] === []` is the shape this
    // assertion exists to reject.
    expect(preview.prunedEngineOutputs).toEqual([".codex/config.toml", "AGENTS.md"]);
    expect(preview.keptEngineOutputs).toEqual([
      { path: ".codex/agents/mio.toml", reason: "foreign" },
      { path: ".codex/progress", reason: "ephemeral" },
    ]);
    // Anti-false-green #2: a preview that "reports" by deleting is not a preview.
    expect(listFiles(cwd)).toEqual(before);
    expect(preview.prunedBackupPath).toBeNull();

    const applied = runRender(cwd, { dryRun: false, prune: true });

    // THE property: same fixture, same plan. What the user approved is what ran.
    expect(preview.prunedEngineOutputs).toEqual(applied.prunedEngineOutputs);
    expect(preview.keptEngineOutputs).toEqual(applied.keptEngineOutputs);
    // And the apply did carry it out, so the equality above is not two previews.
    expect(existsSync(join(cwd, ".codex/config.toml"))).toBe(false);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/agents/mio.toml"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/progress/receipt.txt"))).toBe(true);
  });

  it("--json publishes the plan in preview mode, not two empty arrays", async () => {
    const payload = await renderJson("--prune");

    expect(payload.mode).toBe("preview");
    expect(payload.prunedEngineOutputs).toEqual([".codex/config.toml", "AGENTS.md"]);
    expect(payload.keptEngineOutputs).toEqual([
      { path: ".codex/agents/mio.toml", reason: "foreign" },
      { path: ".codex/progress", reason: "ephemeral" },
    ]);
    expect(existsSync(join(cwd, ".codex/config.toml"))).toBe(true);
  });

  it("the human report names each file, and never claims it deleted anything", async () => {
    const output = await renderOutput("--prune");

    // What it would delete, file by file — not the roots a plain render prints.
    expect(output).toContain(".codex/config.toml");
    expect(output).toContain("AGENTS.md");
    // …what it would keep, with the reason.
    expect(output).toContain(".codex/agents/mio.toml");
    expect(output).toMatch(/sin marcador de navori|no navori marker/);
    // …in the conditional voice: the past tense belongs to the apply run.
    expect(output).toMatch(/borraría|would delete/);
    expect(output).not.toMatch(/Borré|Deleted orphaned/);
    // And the roots warning is gone: pointing at '--prune --apply' next to a
    // plan that already names every file is the noise the plan replaces.
    expect(output).not.toMatch(/Outputs huérfanos|Orphaned outputs/);
  });

  it("still reports the orphan roots when --prune was NOT asked for", async () => {
    // The control: no --prune, no plan — the warning that points at it stays.
    const output = await renderOutput();

    expect(output).toMatch(/Outputs huérfanos|Orphaned outputs/);
    expect(output).not.toMatch(/borraría|would delete/);
  });
});

/** Run `render` capturing the human report clack writes to stdout. */
async function renderOutput(...args: string[]): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await runCommand(renderCommand, { rawArgs: ["--cwd", cwd, ...args] });
  } finally {
    spy.mockRestore();
  }
  return chunks.join("").replace(ANSI, "");
}

interface PrunePayload {
  mode: string;
  prunedEngineOutputs: string[];
  keptEngineOutputs: Array<{ path: string; reason: string }>;
}

/** Run `render --json` and parse the payload. */
async function renderJson(...args: string[]): Promise<PrunePayload> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
    lines.push(String(msg));
  });
  try {
    await runCommand(renderCommand, { rawArgs: ["--cwd", cwd, "--json", ...args] });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines.at(-1) as string) as PrunePayload;
}
