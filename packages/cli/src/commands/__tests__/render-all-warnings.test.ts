import { assert, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
  },
}));

import * as p from "@clack/prompts";
import { writeConfig } from "../../lib/config.ts";
import {
  renderRepoRows,
  rollupRenderRows,
  reportRepoRenderRows,
  type RepoRenderRow,
} from "../render.ts";

/**
 * Audit v0.5.1 A1, batch leg: the unknown-library warning (a `project.libraries`
 * id gone from the registry, e.g. the socketio split) is emitted by every
 * engine, but `render --all` / `workspace render` used to drop it — the row
 * carried only status/detail/conflicts. The mass rollout is exactly where the
 * bug bites (15 repos upgraded without `navori update`, all losing guidance
 * silently), so the batch rows must carry engine warnings and the report must
 * surface them like it already surfaces conflicts: named repos, explicit
 * roll-up column, same numbers in human and --json modes.
 */
let cwd: string;

beforeEach(() => {
  vi.clearAllMocks();
  cwd = mkdtempSync(join(tmpdir(), "navori-render-all-warnings-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function seedRepo(libraries: string[], engines: string[] = ["claude"]): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "warn-a",
    engines,
    preset: "custom",
    qualityGate: { fast: "pnpm lint", full: "pnpm test" },
    project: { libraries },
  });
}

describe("renderRepoRows carries engine warnings (audit A1, batch)", () => {
  it("surfaces the retired-library warning in the repo row and the roll-up", () => {
    seedRepo(["socketio"]);

    const rows = renderRepoRows([{ name: "warn-a", path: cwd }], {
      preview: true,
      force: false,
    });

    expect(rows).toHaveLength(1);
    const [row] = rows;
    assert.isDefined(row);
    const warning = row.warnings.find((w) => w.includes("'socketio'"));
    expect(warning).toBeDefined();
    expect(warning).toContain("navori update");
    expect(rollupRenderRows(rows).warnings).toBeGreaterThanOrEqual(1);
  });

  it("dedupes the same warning emitted by multiple engines of one repo", () => {
    // claude AND codex both warn about the retired id with the identical
    // message; the row must carry it once, not once per engine.
    seedRepo(["socketio"], ["claude", "codex"]);

    const rows = renderRepoRows([{ name: "warn-a", path: cwd }], {
      preview: true,
      force: false,
    });

    expect(rows).toHaveLength(1);
    const [row] = rows;
    assert.isDefined(row);
    const hits = row.warnings.filter((w) => w.includes("'socketio'"));
    expect(hits).toHaveLength(1);
  });

  it("carries no warnings when every library id is known", () => {
    seedRepo(["zod-validation", "vitest"]);

    const rows = renderRepoRows([{ name: "warn-a", path: cwd }], {
      preview: true,
      force: false,
    });

    // The length assertion catches a DUPLICATED row: the roll-up still reports
    // 0 warnings, so without this line the case stays green.
    expect(rows).toHaveLength(1);
    const [row] = rows;
    assert.isDefined(row);
    expect(row.warnings).toEqual([]);
    expect(rollupRenderRows(rows).warnings).toBe(0);
  });
});

describe("reportRepoRenderRows surfaces warnings like conflicts", () => {
  const row = (name: string, warnings: string[]): RepoRenderRow => ({
    name,
    status: "up-to-date",
    detail: "",
    conflicts: 0,
    changed: [],
    warnings,
  });

  it("groups an identical warning into ONE line naming every affected repo", () => {
    const msg = "project.libraries: 'socketio' was removed. Run 'navori update'.";
    const result = reportRepoRenderRows(
      [row("repo-a", [msg]), row("repo-b", [msg]), row("repo-c", [])],
      true,
    );

    // One grouped warn (not one per repo), naming both affected repos.
    const warnCalls = vi.mocked(p.log.warn).mock.calls.map((c) => String(c[0]));
    const grouped = warnCalls.filter((c) => c.includes(msg));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toContain("repo-a, repo-b");
    expect(grouped[0]).not.toContain("repo-c");

    // The roll-up counts each row's warning and the summary says so explicitly.
    expect(result.warnings).toBe(2);
    expect(result.summary).toContain("2 warning");
  });

  it("stays silent with zero warnings — the summary '0' is the only trace", () => {
    const result = reportRepoRenderRows([row("a", []), row("b", [])], true);

    expect(p.log.warn).not.toHaveBeenCalled();
    expect(result.warnings).toBe(0);
    expect(result.summary).toContain("0 conflict · 0 warning · 0 failed");
  });
});
