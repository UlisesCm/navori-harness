import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #313: `render` reconciles a managed `.gitignore` block driven by
 * `config.gitignoreHarness` (off | local | full). These exercise the write /
 * reconcile / preview paths (R2, R5, R6, R7, R8, R9, R11) through `runRender`.
 * createBackup writes under ~/.navori/backups, so safeHomedir is mocked.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../lib/config.ts");
const { runRender } = await import("../render.ts");
const { extractManagedContent } = await import("../../lib/marker.ts");

let cwd: string;

/** The managed block content for `.gitignore`, or null when absent. */
function gitignoreBlock(dir: string): string | null {
  const path = join(dir, ".gitignore");
  if (!existsSync(path)) return null;
  return extractManagedContent(readFileSync(path, "utf-8"), "gitignore-harness", "shell");
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-gitignore-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function config(input: Record<string, unknown>): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    preset: "custom",
    ...input,
  });
}

describe("runRender — harness .gitignore (#313)", () => {
  // Covers: R6
  it("creates .gitignore with the block when none exists (mode local)", () => {
    config({ engines: ["claude"], gitignoreHarness: "local" });
    const result = runRender(cwd, { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.gitignore?.status).toBe("created");
    const block = gitignoreBlock(cwd);
    expect(block).toContain(".claude/settings.local.json");
    expect(block).toContain(".claude/progress/");
    // local mode: Cubo A only, never the harness dir itself.
    expect(block).not.toContain("CLAUDE.md");
  });

  // Covers: R2
  it("inserts the block preserving the user's existing lines", () => {
    config({ engines: ["claude"], gitignoreHarness: "local" });
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\ndist/\n");
    const result = runRender(cwd, { dryRun: false });
    expect(result.gitignore?.status).toBe("created");
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain(".navori/");
  });

  // Covers: R7
  it("preserves a hand-edited block (user-modified-skipped) unless --force", () => {
    config({ engines: ["claude"], gitignoreHarness: "local" });
    runRender(cwd, { dryRun: false });
    // Tamper with the block body (a line inside the managed markers).
    const path = join(cwd, ".gitignore");
    const tampered = readFileSync(path, "utf-8").replace(".navori/", ".navori/\nhand-edited-line");
    writeFileSync(path, tampered);

    const skipped = runRender(cwd, { dryRun: false });
    expect(skipped.gitignore?.status).toBe("user-modified-skipped");
    expect(skipped.gitignore?.skippedReason).toBeTruthy();
    expect(readFileSync(path, "utf-8")).toContain("hand-edited-line");

    const forced = runRender(cwd, { dryRun: false, force: true });
    expect(forced.gitignore?.status).toBe("updated");
    expect(readFileSync(path, "utf-8")).not.toContain("hand-edited-line");
  });

  // Covers: R5
  it("reconciles the block when engines change, preserving external lines", () => {
    config({ engines: ["claude", "codex"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), "coverage/\n");
    runRender(cwd, { dryRun: false });
    expect(gitignoreBlock(cwd)).toContain(".codex/");

    // Drop codex → its paths leave the block, user line stays.
    config({ engines: ["claude"], gitignoreHarness: "full" });
    const reconciled = runRender(cwd, { dryRun: false });
    expect(reconciled.gitignore?.status).toBe("updated");
    const block = gitignoreBlock(cwd);
    expect(block).not.toContain(".codex/");
    expect(block).toContain(".claude/");
    expect(readFileSync(join(cwd, ".gitignore"), "utf-8")).toContain("coverage/");
  });

  // Covers: R5
  it("is a byte-identical no-op on a second render with no changes", () => {
    config({ engines: ["claude"], gitignoreHarness: "full" });
    runRender(cwd, { dryRun: false });
    const first = readFileSync(join(cwd, ".gitignore"), "utf-8");
    const second = runRender(cwd, { dryRun: false });
    expect(second.gitignore?.status).toBe("unchanged");
    expect(readFileSync(join(cwd, ".gitignore"), "utf-8")).toBe(first);
  });

  // Covers: R8
  it("never creates or touches .gitignore in mode off", () => {
    config({ engines: ["claude"], gitignoreHarness: "off" });
    const result = runRender(cwd, { dryRun: false });
    expect(result.gitignore == null).toBe(true);
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
  });

  // Covers: R8
  it("leaves a pre-existing .gitignore untouched in mode off", () => {
    config({ engines: ["claude"], gitignoreHarness: "off" });
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    runRender(cwd, { dryRun: false });
    expect(readFileSync(join(cwd, ".gitignore"), "utf-8")).toBe("node_modules/\n");
  });

  // Covers: R9
  it("previews the block status without writing (no --apply)", () => {
    config({ engines: ["claude"], gitignoreHarness: "local" });
    const result = runRender(cwd, { dryRun: true });
    expect(result.gitignore?.status).toBe("created");
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
  });

  // Covers: R11
  it("writes the header in the config's language (es vs en)", () => {
    config({ engines: ["claude"], gitignoreHarness: "local", language: "es" });
    runRender(cwd, { dryRun: false });
    const esHeader = readFileSync(join(cwd, ".gitignore"), "utf-8");
    expect(esHeader).toContain("gestionado por navori");

    rmSync(join(cwd, ".gitignore"));
    config({ engines: ["claude"], gitignoreHarness: "local", language: "en" });
    runRender(cwd, { dryRun: false });
    const enHeader = readFileSync(join(cwd, ".gitignore"), "utf-8");
    expect(enHeader).toContain("managed by navori");
  });
});
