import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * spec 0026 T10 (R39, R41) — the `.codex/agents/<id>.toml` half of
 * `scanRetiredAssets`, mirroring `engines/claude/__tests__/retired-
 * assets.test.ts`'s reasoning: `RETIRED_AGENTS` ships empty in production
 * (T8/T11 precedent — an entry lands in the SAME commit that stops rendering
 * the old id), so this mocks ONE seeded entry with a distinct `codex` marker
 * to exercise the real function end to end instead of asserting behavior
 * nothing here would otherwise run.
 */

vi.mock(import("../../engines/shared/harness-assets.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engines/shared/harness-assets.ts")>();
  return {
    ...actual,
    RETIRED_AGENTS: [
      {
        id: "leader",
        successor: "orchestrator",
        harnessKey: "leader",
        markerIdByAdapter: { claude: "leader-base", codex: "leader-codex-base" },
      },
    ],
  };
});

const { scanRetiredAssets } = await import("../health.ts");
const { injectManagedSection } = await import("../marker.ts");
const { readCliVersion } = await import("../bundled-assets.ts");

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-retired-codex-agent-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function tomlPath(): string {
  return join(cwd, ".codex/agents/leader.toml");
}

describe("scanRetiredAssets — .codex/agents/<id>.toml, marker <id>-codex-base (spec 0026 T10)", () => {
  // Covers: R41
  it("reports a navori-owned leftover with its successor, no reason (would be removed)", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(
      tomlPath(),
      injectManagedSection("", "leader-codex-base", "cuerpo\n", {
        version: readCliVersion(),
        source: "@navori/core",
      }).output,
      "utf-8",
    );

    const report = scanRetiredAssets(cwd);
    expect(report).toContainEqual({
      path: ".codex/agents/leader.toml",
      id: "leader",
      successor: "orchestrator",
    });
  });

  // Covers: R39, R41
  it("reports a foreign leftover (no navori-codex marker) with reason 'foreign'", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(tomlPath(), "# ajeno, escrito a mano\n", "utf-8");

    const report = scanRetiredAssets(cwd);
    expect(report).toContainEqual({
      path: ".codex/agents/leader.toml",
      id: "leader",
      successor: "orchestrator",
      reason: "foreign",
    });
  });

  // Covers: R39, R41
  it("reports a leftover from a newer navori with reason 'newer'", () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(
      tomlPath(),
      injectManagedSection("", "leader-codex-base", "cuerpo\n", {
        version: "99.0.0",
        source: "@navori/core",
      }).output,
      "utf-8",
    );

    const report = scanRetiredAssets(cwd);
    expect(report).toContainEqual({
      path: ".codex/agents/leader.toml",
      id: "leader",
      successor: "orchestrator",
      reason: "newer",
    });
  });

  it("reports nothing when the repo never had it", () => {
    expect(scanRetiredAssets(cwd)).toEqual([]);
  });
});
