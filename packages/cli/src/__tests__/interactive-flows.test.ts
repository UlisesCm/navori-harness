import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * E2E coverage for the CLI's INTERACTIVE flows (#7). The happy-path e2e suite
 * spawns the binary with `--yes`/`--recommended`, so the @clack/prompts wizards
 * never run. @clack requires a TTY, so stdin-scripting a spawned process does
 * not work either. Instead we test the interactive functions in-process and mock
 * @clack with a reusable helper:
 *
 *   - `queueAnswers(...)` pre-loads the answers select/confirm/text consume in
 *     order (one per prompt, in call order).
 *   - the `CANCEL` sentinel simulates the user aborting (Ctrl-C) — `isCancel`
 *     returns true only for it.
 *
 * Same shape applies to any future interactive flow: export the function, queue
 * answers, assert the resolved value + side effects.
 */
const clk = vi.hoisted(() => ({ queue: [] as unknown[], CANCEL: Symbol("clack-cancel") }));

vi.mock("@clack/prompts", () => {
  const dequeue = async () => clk.queue.shift();
  return {
    select: vi.fn(dequeue),
    confirm: vi.fn(dequeue),
    text: vi.fn(dequeue),
    multiselect: vi.fn(dequeue),
    isCancel: (v: unknown) => v === clk.CANCEL,
    note: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
    log: { message: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn(), step: vi.fn() },
  };
});

// migrate.ts moves files into the real ~/.navori/migrations; here we only care
// that the adoption flow invokes it. The backup mechanics live in migrate.test.ts.
vi.mock("../lib/migrate.ts", () => ({
  createMigrationBackup: vi.fn(() => ({ path: "/fake/backup", movedPaths: ["CLAUDE.md", ".claude"] })),
  removeOriginals: vi.fn(),
}));

import * as p from "@clack/prompts";
import { createMigrationBackup, removeOriginals } from "../lib/migrate.ts";
import { resolveConflictsInteractively, type TargetPlan } from "../commands/sync.ts";
import { chooseAdoptionMode } from "../commands/init.ts";
import type { ClaudeInfraInventory } from "../lib/claude-infra.ts";

const CANCEL = clk.CANCEL;
function queueAnswers(...answers: unknown[]): void {
  clk.queue.length = 0;
  clk.queue.push(...answers);
}

beforeEach(() => {
  vi.clearAllMocks();
  clk.queue.length = 0;
});

describe("sync — resolveConflictsInteractively (interactive conflict resolution, #7)", () => {
  function planWithConflicts(cwd: string, ids: string[]): TargetPlan[] {
    const entries = ids.map((id) => ({
      asset: { id },
      source: "core",
      status: "user-modified-skipped",
      newContent: `nuevo ${id}`,
    }));
    return [
      { target: { label: "root", cwd, repoRoot: cwd, config: {} }, plan: { claudeMdEntries: entries } },
    ] as unknown as TargetPlan[];
  }

  it("'keep' leaves the block in skipIds and 'accept' moves it to forceIds", async () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-if-"));
    queueAnswers("keep", "accept");

    const res = await resolveConflictsInteractively(
      planWithConflicts(repo, ["idioma-rol", "formato-respuesta"]),
    );

    expect(res).not.toBeNull();
    const root = res!.get("root")!;
    expect([...root.skipIds]).toEqual(["idioma-rol"]);
    expect([...root.forceIds]).toEqual(["formato-respuesta"]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("isCancel aborts the whole resolution with null — navori never loses an edit without consent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-if-"));
    queueAnswers(CANCEL);

    const res = await resolveConflictsInteractively(planWithConflicts(repo, ["idioma-rol"]));

    expect(res).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it("no conflicts → empty map, asks nothing", async () => {
    const plans = [
      {
        target: { label: "root", cwd: "/x" },
        plan: {
          claudeMdEntries: [
            { asset: { id: "idioma-rol" }, source: "core", status: "unchanged", newContent: null },
          ],
        },
      },
    ] as unknown as TargetPlan[];

    const res = await resolveConflictsInteractively(plans);

    expect(res!.size).toBe(0);
    expect(p.select).not.toHaveBeenCalled();
  });
});

describe("init — chooseAdoptionMode (interactive adoption, #7)", () => {
  function makeInfra(present: boolean): ClaudeInfraInventory {
    return {
      present,
      agentFiles: [],
      skillFiles: [],
      hasSettings: false,
      hasLocalSettings: false,
      hasClaudeMd: present,
      hasAgentsMd: false,
      hasCheckpointsMd: false,
      hasFeatureList: false,
      progressFiles: 0,
      specsDirs: 0,
      hasNavoriConfig: false,
    };
  }

  it("no existing infra → 'fresh', asks nothing", async () => {
    const r = await chooseAdoptionMode("/x", makeInfra(false), "app", { lang: "es" });
    expect(r).toBe("fresh");
    expect(p.select).not.toHaveBeenCalled();
  });

  it("--yes with existing infra → 'coexist' (never replaces silently)", async () => {
    const r = await chooseAdoptionMode("/x", makeInfra(true), "app", { yes: true, lang: "es" });
    expect(r).toBe("coexist");
    expect(p.select).not.toHaveBeenCalled();
  });

  it("selecting 'coexist' → 'coexist'", async () => {
    queueAnswers("coexist");
    const r = await chooseAdoptionMode("/x", makeInfra(true), "app", { lang: "es" });
    expect(r).toBe("coexist");
  });

  it("'replace' but confirm=false → null, touches nothing", async () => {
    queueAnswers("replace", false);
    const r = await chooseAdoptionMode("/x", makeInfra(true), "app", { lang: "es" });
    expect(r).toBeNull();
    expect(createMigrationBackup).not.toHaveBeenCalled();
    expect(removeOriginals).not.toHaveBeenCalled();
  });

  it("cancelling the select → null", async () => {
    queueAnswers(CANCEL);
    const r = await chooseAdoptionMode("/x", makeInfra(true), "app", { lang: "es" });
    expect(r).toBeNull();
  });

  it("'replace' + confirm=true → 'replace', backs up and removes the originals", async () => {
    queueAnswers("replace", true);

    const r = await chooseAdoptionMode("/repo", makeInfra(true), "dash", { lang: "es" });

    expect(r).toBe("replace");
    expect(createMigrationBackup).toHaveBeenCalledWith("/repo", "dash");
    expect(removeOriginals).toHaveBeenCalledWith("/repo", ["CLAUDE.md", ".claude"]);
  });
});
