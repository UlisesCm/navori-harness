import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import { RETIRED_PLUGIN_SUB_BLOCKS } from "../../../lib/config/plugins.ts";

/**
 * #1013 — the `injectInto` half of the same migration `RETIRED_PLUGIN_BLOCKS`
 * closes for CLAUDE.md (see `search-v2-render.test.ts`'s `#1013` describe).
 *
 * `codegraph`/`tgrep`'s pre-#838 manifests appended sub-blocks directly inside
 * agent/skill files (`codegraph-implementer-extension` and friends). #838
 * reintroduced both plugins under new ids without ever registering the old
 * ones, so a repo rendered before #838 keeps those sub-blocks forever: neither
 * the enabled-plugin loop nor the disabled-plugin loop in
 * `engines/claude/index.ts` can reach a sub-block the CURRENT manifest no
 * longer declares.
 *
 * `createBackup` writes under `~/.navori/backups`, so `safeHomedir` is mocked
 * to a throwaway home — same setup as `render-backup-exclude.test.ts`.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { renderClaudeEngine } = await import("../index.ts");

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
  plugins: { codegraph: { enabled: true }, tgrep: { enabled: true } },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-1013-subblocks-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

/** A sub-block exactly as a pre-#838 navori would have appended it. */
const legacySubBlock = (id: string, source: string): string =>
  `\n<!-- navori:managed id="${id}" hash="deadbeef" version="0.0.2" source="@navori/plugin-${source}" -->\n` +
  `## Legacy ${id}\n\nstale body from before #838\n` +
  `<!-- /navori:managed id="${id}" -->\n`;

describe("#1013 — retired injectInto sub-blocks of a live plugin", () => {
  it("strips every registered sub-block, backs up first, and keeps the rest of the target intact", () => {
    // Seed a real render so every target file exists in its current (v2) shape.
    renderClaudeEngine(cwd, CONFIG);

    const seededOriginals = new Map<string, string>(); // targetPath (rel) -> original content
    for (const [source, retired] of Object.entries(RETIRED_PLUGIN_SUB_BLOCKS)) {
      for (const entry of retired.entries) {
        const targetAbs = join(cwd, entry.targetPath);
        if (!existsSync(targetAbs)) continue; // this fixture doesn't render every target
        const original = seededOriginals.get(entry.targetPath) ?? readFileSync(targetAbs, "utf-8");
        seededOriginals.set(entry.targetPath, original);
        writeFileSync(targetAbs, original + legacySubBlock(entry.id, source));
      }
    }
    expect(seededOriginals.size).toBeGreaterThan(0);
    for (const targetPath of seededOriginals.keys()) {
      expect(readFileSync(join(cwd, targetPath), "utf-8")).toContain("stale body from before #838");
    }

    const result = renderClaudeEngine(cwd, CONFIG);

    expect(result.backupPath).not.toBeNull();
    const backup = result.backupPath as string;

    for (const [targetPath, original] of seededOriginals) {
      const after = readFileSync(join(cwd, targetPath), "utf-8");
      expect(after).not.toContain("stale body from before #838");
      // The rest of the target file survives untouched, marker-for-marker.
      expect(after).toContain(original.trimEnd());
      // Backed up before the strip: the pre-render content (WITH the legacy
      // block) is what commitWrites snapshotted.
      const backedUp = readFileSync(join(backup, targetPath), "utf-8");
      expect(backedUp).toContain("stale body from before #838");
    }
  });

  it("is idempotent — a second render with no legacy blocks left touches nothing", () => {
    renderClaudeEngine(cwd, CONFIG);
    const before = new Map<string, string>();
    for (const retired of Object.values(RETIRED_PLUGIN_SUB_BLOCKS)) {
      for (const entry of retired.entries) {
        const targetAbs = join(cwd, entry.targetPath);
        if (existsSync(targetAbs)) before.set(entry.targetPath, readFileSync(targetAbs, "utf-8"));
      }
    }

    const second = renderClaudeEngine(cwd, CONFIG);

    for (const [targetPath, content] of before) {
      expect(readFileSync(join(cwd, targetPath), "utf-8")).toBe(content);
    }
    expect(second.backupPath).toBeNull();
  });
});
