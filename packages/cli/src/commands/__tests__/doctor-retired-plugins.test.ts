import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NavoriConfigSchema, type NavoriConfigInput } from "../../lib/config/schema.ts";
import * as nativeHooks from "../../lib/diagnose/native-hooks.ts";
import { loadEnabledPlugins } from "../../lib/config/plugins.ts";
import { scanRetiredPluginLeftovers } from "../../lib/diagnose/health.ts";
import { tc } from "../../lib/i18n.ts";
import {
  SYN_ID,
  SYN_SCRIPT,
  makeRepo,
  markedScript,
  put,
  registerSyntheticRetired,
} from "../../engines/shared/__tests__/retired-fixtures.ts";
import { computeHealthVerdict, doctorCommand } from "../doctor.ts";

/**
 * A config that still lists a retired plugin is a WARNING, never a failure: the id
 * is not "missing", `computeHealthVerdict` stays green, and `doctor` exits 0 with
 * `ok: true` in `--json` and under `--strict`. The leftovers (kept script, hooks
 * that call a script that is gone) come from `scanRetiredPluginLeftovers`.
 */
vi.mock("../../lib/diagnose/native-hooks.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/diagnose/native-hooks.ts")>();
  return { ...actual, readHookSources: vi.fn(actual.readHookSources) };
});

let cwd: string;
let unregister: () => void;

const CONFIG: NavoriConfigInput = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  branchBase: "main",
  plugins: { [SYN_ID]: { enabled: true } },
};

beforeEach(() => {
  unregister = registerSyntheticRetired();
  cwd = makeRepo();
  vi.mocked(nativeHooks.readHookSources).mockClear();
  writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(CONFIG));
});

afterEach(() => {
  unregister();
  rmSync(cwd, { recursive: true, force: true });
});

async function runDoctor(
  strict: boolean,
): Promise<{ report: Record<string, unknown>; code: unknown }> {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await doctorCommand.run?.({
      args: { _: [], cwd, json: true, strict },
      rawArgs: [],
      cmd: doctorCommand,
    });
    return { report: JSON.parse(String(output.mock.calls.at(-1)?.[0])), code: process.exitCode };
  } finally {
    process.exitCode = before;
    output.mockRestore();
  }
}

describe("retired ≠ missing", () => {
  it("routes a retired id to `retired`, not `missing`, in the plugin loader", () => {
    const result = loadEnabledPlugins({
      [SYN_ID]: { enabled: true },
      cognitive: { enabled: true },
      "ghost-plugin": { enabled: true },
    });
    expect(result.retired.sort()).toEqual(["cognitive", SYN_ID]);
    expect(result.missing.map((m) => m.id)).toEqual(["ghost-plugin"]);
  });

  it("keeps the health verdict green while a retired id is declared", () => {
    const verdict = computeHealthVerdict(cwd, NavoriConfigSchema.parse(CONFIG));
    expect(verdict.missingPlugins).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe("doctor warns about retired-plugin leftovers without failing", () => {
  const seed = (): void => {
    // A kept (edited) script, plus a hook that calls a retired script that is already gone.
    put(cwd, `.claude/scripts/${SYN_SCRIPT}`, `${markedScript()}echo mine\n`);
    put(cwd, ".husky/pre-commit", `#!/bin/sh\nbash ".claude/scripts/${SYN_SCRIPT}"\n`);
  };

  it("lists the declared id, the kept script with its reason, and the referencing hook", () => {
    seed();
    const left = scanRetiredPluginLeftovers(cwd, NavoriConfigSchema.parse(CONFIG));
    expect(left.declared).toEqual([{ id: SYN_ID, removedIn: "#999" }]);
    expect(left.assets).toEqual([{ path: `.claude/scripts/${SYN_SCRIPT}`, reason: "modified" }]);
    expect(left.references).toEqual([
      { script: SYN_SCRIPT, source: ".husky/pre-commit", scriptMissing: false },
    ]);
  });

  it("says a hook that calls a script that is gone WILL FAIL", () => {
    put(cwd, ".husky/pre-commit", `#!/bin/sh\nbash ".claude/scripts/${SYN_SCRIPT}"\n`);
    const left = scanRetiredPluginLeftovers(cwd, NavoriConfigSchema.parse(CONFIG));
    expect(left.references).toEqual([
      { script: SYN_SCRIPT, source: ".husky/pre-commit", scriptMissing: true },
    ]);
    const td = tc("en").doctor;
    expect(td.retiredPluginReferenceRow(SYN_SCRIPT, true)).toContain("will fail");
    expect(td.retiredPluginReferenceRow(SYN_SCRIPT, false)).not.toContain("will fail");
    expect(td.retiredPluginDeclaredRow(SYN_ID, "#999")).toContain(
      "remove it from navori.config.json",
    );
  });

  it("doctor exits 0, --json is ok:true, and --strict still exits 0", async () => {
    seed();
    const plain = await runDoctor(false);
    expect(plain.report.ok).toBe(true);
    expect(plain.code ?? 0).toBe(0);
    expect(plain.report.retiredPlugins).toMatchObject({
      declared: [{ id: SYN_ID }],
      assets: [{ reason: "modified" }],
    });

    const strict = await runDoctor(true);
    expect(strict.report.ok).toBe(true);
    expect(strict.code ?? 0).toBe(0);
  });

  it("reads no hook source when nothing retired is declared or on disk", () => {
    put(cwd, ".husky/pre-commit", `#!/bin/sh\nbash ".claude/scripts/${SYN_SCRIPT}"\n`);
    const clean = NavoriConfigSchema.parse({ ...CONFIG, plugins: {} });
    expect(scanRetiredPluginLeftovers(cwd, clean)).toEqual({
      declared: [],
      assets: [],
      blocks: [],
      references: [],
    });
    expect(nativeHooks.readHookSources).not.toHaveBeenCalled();
  });
});
