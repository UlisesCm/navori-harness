import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYN_SCRIPT,
  makeRepo,
  markedScript,
  put,
  registerSyntheticRetired,
} from "../../engines/shared/__tests__/retired-fixtures.ts";

/**
 * `render --prune` walks the whole tree of an orphaned engine and used to delete
 * every `ours` file under it, `.codex/scripts/*` included, with no hook check.
 * A retired plugin's script now goes through the same keep policy the render
 * sweeps use: kept while a hook still calls it, deleted when nothing does.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../lib/config/config.ts");
const { runRender } = await import("../render.ts");

const SCRIPT = `.codex/scripts/${SYN_SCRIPT}`;

let cwd: string;
let unregister: () => void;

beforeEach(() => {
  unregister = registerSyntheticRetired();
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = makeRepo();
  // Claude only: `.codex/` is the orphaned engine the prune walks.
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
});

afterEach(() => {
  unregister();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("render --prune and a retired plugin's script", () => {
  it("deletes a pristine, unreferenced script", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    const result = runRender(cwd, { dryRun: false, prune: true });
    expect(result.ok).toBe(true);
    expect(existsSync(abs)).toBe(false);
    expect(result.prunedEngineOutputs).toContain(SCRIPT);
  });

  it("keeps a script a git hook still calls, and reports why", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    put(cwd, ".husky/pre-commit", `#!/bin/sh\nbash ".codex/scripts/${SYN_SCRIPT}" </dev/null\n`);
    const result = runRender(cwd, { dryRun: false, prune: true });
    expect(result.ok).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(result.keptEngineOutputs).toContainEqual({ path: SCRIPT, reason: "hook-referenced" });
  });

  it("keeps a script edited outside the block (modified)", () => {
    const abs = put(cwd, SCRIPT, `${markedScript()}echo mine\n`);
    const result = runRender(cwd, { dryRun: false, prune: true });
    expect(existsSync(abs)).toBe(true);
    expect(result.keptEngineOutputs).toContainEqual({ path: SCRIPT, reason: "modified" });
  });

  it("deletes nothing in preview, yet already says what it would keep", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    put(cwd, ".husky/pre-commit", `#!/bin/sh\nbash ".codex/scripts/${SYN_SCRIPT}"\n`);
    const result = runRender(cwd, { dryRun: true, prune: true });
    expect(existsSync(abs)).toBe(true);
    expect(result.keptEngineOutputs).toContainEqual({ path: SCRIPT, reason: "hook-referenced" });
  });
});
