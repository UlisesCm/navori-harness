// The imports and the `vi.mock` + dynamic-import prologue below cannot move into a shared
// module (vi.mock only hoists inside the test file), so the other prune suite repeats them.
/* jscpd:ignore-start */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, makeSandboxDirs, navoriAuthored } from "./prune-fixtures.ts";

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
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { runCommand } = await import("citty");
const { writeConfig } = await import("../../lib/config/config.ts");
const { runRender, renderCommand } = await import("../render.ts");
/* jscpd:ignore-end */

/** ANSI escapes, BUILT rather than written as a literal control char (which
 *  the linter rejects): picocolors keeps them under FORCE_COLOR. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

let cwd: string;

/**
 * An orphaned `.codex/` of the shape the rollout met: navori's own file next to
 * the user's hand-written one and the ephemeral harness state — so the plan has
 * something in EVERY bucket (remove, foreign, ephemeral) and an equivalence
 * assertion cannot pass by comparing two empty lists.
 */
beforeEach(() => {
  ({ home: home.dir, cwd } = makeSandboxDirs("prune-preview"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
  mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
  mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
  writeFileSync(
    join(cwd, ".codex/config.toml"),
    navoriAuthored("codex-config", "sandbox = true", "shell"),
  );
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
    // Covers: R7, R11 — preview/apply never plan or remove the legacy guard.
    expect(preview.prunedEngineOutputs).not.toContain(".codex/.gitignore");
    expect(applied.prunedEngineOutputs).not.toContain(".codex/.gitignore");
    expect(existsSync(join(cwd, ".codex/.gitignore"))).toBe(true);
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

describe("render --prune strips the blocks of a file that also holds the user's text (#1604)", () => {
  const MINE = "## Mis notas\nTexto propio del usuario.\n";

  beforeEach(() => {
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `${navoriAuthored("agentes-disponibles", "rendered")}\n${MINE}`,
    );
  });

  it("preview, apply and --json agree: blocks removed, file kept", async () => {
    const original = readFileSync(join(cwd, "AGENTS.md"), "utf-8");

    const preview = runRender(cwd, { dryRun: true, prune: true });
    expect(preview.strippedEngineOutputs).toEqual(["AGENTS.md"]);
    expect(preview.prunedEngineOutputs).toEqual([".codex/config.toml"]);
    // A preview rewrites nothing.
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(original);

    const payload = await renderJson("--prune");
    expect(payload.mode).toBe("preview");
    expect(payload.strippedEngineOutputs).toEqual(["AGENTS.md"]);
    expect(payload.prunedEngineOutputs).toEqual([".codex/config.toml"]);

    const applied = runRender(cwd, { dryRun: false, prune: true });
    expect(applied.strippedEngineOutputs).toEqual(preview.strippedEngineOutputs);
    expect(applied.prunedEngineOutputs).toEqual(preview.prunedEngineOutputs);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(`\n${MINE}`);
    expect(readFileSync(join(applied.prunedBackupPath as string, "AGENTS.md"), "utf-8")).toBe(
      original,
    );
  });

  it("the human report says the text is kept, in the conditional voice for a preview", async () => {
    const preview = await renderOutput("--prune");
    expect(preview).toContain("AGENTS.md");
    expect(preview).toMatch(/conservaría tu texto|keep your text/);
    expect(preview).not.toMatch(/conservé tu texto|kept your text/);

    const applied = await renderOutput("--prune", "--apply");
    expect(applied).toMatch(/conservé tu texto|kept your text/);
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
  strippedEngineOutputs: string[];
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
