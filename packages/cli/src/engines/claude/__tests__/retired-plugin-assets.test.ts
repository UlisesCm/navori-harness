import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema, type NavoriConfigInput } from "../../../lib/config/schema.ts";
import * as nativeHooks from "../../../lib/diagnose/native-hooks.ts";
import { readCliVersion } from "../../../lib/render/bundled-assets.ts";
import { injectManagedSection } from "../../../lib/render/marker.ts";
import {
  SYN_BLOCK,
  SYN_ID,
  SYN_SCRIPT,
  SYN_SKILL_ID,
  SYN_SUB_BLOCK,
  makeRepo,
  markedScript,
  put,
  registerSyntheticRetired,
} from "../../shared/__tests__/retired-fixtures.ts";

/**
 * The Claude sweep for RETIRED plugins (step 8.5-bis) and the guarded removal of
 * their blocks and sub-blocks (8.5-ter, render-plan). Driven with SYNTHETIC retired
 * entries plus `cognitive`, so it holds whichever real plugins are retired.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));
vi.mock("../../../lib/diagnose/native-hooks.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/diagnose/native-hooks.ts")>();
  return { ...actual, readHookSources: vi.fn(actual.readHookSources) };
});

const { renderClaudeEngine } = await import("../index.ts");

const SCRIPT = `.claude/scripts/${SYN_SCRIPT}`;
const CALL = `bash ".claude/scripts/${SYN_SCRIPT}"`;

let cwd: string;
let unregister: () => void;

function config(overrides: Partial<NavoriConfigInput> = {}) {
  return NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...overrides,
  });
}

beforeEach(() => {
  unregister = registerSyntheticRetired();
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = makeRepo();
  vi.mocked(nativeHooks.readHookSources).mockClear();
});

afterEach(() => {
  unregister();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("Claude 8.5-bis — retired plugin scripts go through the shared keep policy", () => {
  it("deletes a pristine retired script, and a second render is a no-op", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    const first = renderClaudeEngine(cwd, config());
    expect(existsSync(abs)).toBe(false);
    expect(first.warnings.some((w) => w.includes(SYN_SCRIPT))).toBe(false);

    const second = renderClaudeEngine(cwd, config());
    expect(second.written).toEqual([]);
    expect(second.backupPath).toBeNull();
  });

  it("keeps a script edited outside the block and says why", () => {
    const abs = put(cwd, SCRIPT, `${markedScript()}echo mine\n`);
    const result = renderClaudeEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes(SCRIPT) && w.includes("(modified)"))).toBe(true);
  });

  it("keeps a marker-free script that is not a known legacy render (foreign)", () => {
    const abs = put(cwd, SCRIPT, "#!/usr/bin/env bash\necho mine\n");
    const result = renderClaudeEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes(SCRIPT) && w.includes("(foreign)"))).toBe(true);
  });

  it("keeps it while a git hook calls it, and deletes it on the render after the hook is gone", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    const hook = put(cwd, ".husky/pre-commit", `#!/bin/sh\n${CALL}\n`);
    const kept = renderClaudeEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(kept.warnings.some((w) => w.includes("(hook-referenced)"))).toBe(true);

    rmSync(hook);
    renderClaudeEngine(cwd, config());
    expect(existsSync(abs)).toBe(false);
  });

  it("keeps it when the settings write was skipped and settings.json still registers it", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    // Unparseable settings.json: the render skips it instead of clobbering it, so
    // the hook row survives — and would ask on every Bash call once the script is gone.
    put(cwd, ".claude/settings.json", `{ "hooks": "${CALL}"`);
    const result = renderClaudeEngine(cwd, config());
    expect(result.skipped.some((s) => s.path === ".claude/settings.json")).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes("(settings-referenced)"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("ALERTA") || w.includes("WARNING"))).toBe(true);
  });

  it("keeps it when settings.local.json names it", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    put(cwd, ".claude/settings.local.json", `{ "hooks": "${CALL.replaceAll('"', "'")}" }`);
    const result = renderClaudeEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes("(settings-referenced)"))).toBe(true);
  });

  it("keeps it while plugins.<id>.nativeHook is declared", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    const result = renderClaudeEngine(
      cwd,
      config({ plugins: { [SYN_ID]: { enabled: false, nativeHook: true } } }),
    );
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes("(native-hook-declared)"))).toBe(true);
  });

  it("does not delete anything under --dry-run", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    renderClaudeEngine(cwd, config(), { dryRun: true });
    expect(existsSync(abs)).toBe(true);
  });

  it("keeps a retired directory that holds a symlink, and purges the all-navori one (cognitive)", () => {
    const dir = join(cwd, ".claude/scripts/cognitive-tool");
    put(cwd, ".claude/scripts/cognitive-tool/package.json", "{}\n");
    const outside = put(cwd, "outside.txt", "mine\n");
    symlinkSync(outside, join(dir, "link.txt"));
    const kept = renderClaudeEngine(cwd, config());
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(kept.warnings.some((w) => w.includes("cognitive-tool") && w.includes("(symlink)"))).toBe(
      true,
    );

    rmSync(join(dir, "link.txt"));
    renderClaudeEngine(cwd, config());
    expect(existsSync(dir)).toBe(false);
  });

  it("reads no hook source when no retired asset is on disk", () => {
    put(cwd, ".husky/pre-commit", `#!/bin/sh\n${CALL}\n`);
    renderClaudeEngine(cwd, config());
    expect(nativeHooks.readHookSources).not.toHaveBeenCalled();
  });

  it("reads hook sources at most once per render, however many assets survive ownership", () => {
    put(cwd, SCRIPT, markedScript());
    put(cwd, ".claude/scripts/check-cognitive.sh", "#!/usr/bin/env bash\necho x\n");
    renderClaudeEngine(cwd, config());
    expect(nativeHooks.readHookSources).toHaveBeenCalledTimes(1);
  });
});

/** A CLAUDE.md block as a navori that still shipped the plugin wrote it. */
function blockAt(version: string, body = "retired protocol"): string {
  return injectManagedSection("", SYN_BLOCK, body, { source: `@navori/plugin-${SYN_ID}`, version })
    .output;
}

describe("retired CLAUDE.md blocks are removed guarded (#1273)", () => {
  const withBlock = (block: string): void => {
    renderClaudeEngine(cwd, config({ plugins: { [SYN_ID]: { enabled: true } } }));
    const path = join(cwd, "CLAUDE.md");
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n${block}`);
  };
  const statusOf = () => {
    const result = renderClaudeEngine(cwd, config({ plugins: { [SYN_ID]: { enabled: true } } }));
    return result.claudeMdEntries.find((e) => e.asset.id === SYN_BLOCK)?.status;
  };

  it("removes a pristine block", () => {
    withBlock(blockAt(readCliVersion()));
    expect(statusOf()).toBe("removed-condition-false");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).not.toContain(SYN_BLOCK);
  });

  it("keeps an edited block with the non-conflict status retired-kept", () => {
    withBlock(blockAt(readCliVersion()).replace("retired protocol", "my own words"));
    expect(statusOf()).toBe("retired-kept");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toContain("my own words");
  });

  it("keeps a block from a newer navori with downgrade-skipped", () => {
    withBlock(blockAt("999.0.0"));
    expect(statusOf()).toBe("downgrade-skipped");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toContain(SYN_BLOCK);
  });
});

describe("retired skill sub-blocks are removed guarded (8.5-ter)", () => {
  const target = `.claude/skills/${SYN_SKILL_ID}/SKILL.md`;
  const subBlock = (body: string, version = readCliVersion()): string =>
    injectManagedSection("", SYN_SUB_BLOCK, body, { source: `@navori/plugin-${SYN_ID}`, version })
      .output;

  it("strips a pristine sub-block and keeps the rest of the file", () => {
    const abs = put(cwd, target, `# Zz skill\n\n${subBlock("legacy extension")}`);
    renderClaudeEngine(cwd, config());
    const after = readFileSync(abs, "utf-8");
    expect(after).toContain("# Zz skill");
    expect(after).not.toContain(SYN_SUB_BLOCK);
  });

  it("keeps an edited sub-block and warns", () => {
    const abs = put(
      cwd,
      target,
      `# Zz skill\n\n${subBlock("legacy extension").replace("legacy extension", "my words")}`,
    );
    const result = renderClaudeEngine(cwd, config());
    expect(readFileSync(abs, "utf-8")).toContain("my words");
    expect(result.warnings.some((w) => w.includes(SYN_SUB_BLOCK) && w.includes("edited"))).toBe(
      true,
    );
  });

  it("keeps a sub-block from a newer navori and warns", () => {
    const abs = put(cwd, target, `# Zz skill\n\n${subBlock("legacy extension", "999.0.0")}`);
    const result = renderClaudeEngine(cwd, config());
    expect(readFileSync(abs, "utf-8")).toContain(SYN_SUB_BLOCK);
    expect(result.warnings.some((w) => w.includes(SYN_SUB_BLOCK) && w.includes("newer"))).toBe(
      true,
    );
  });
});

describe("a leftover directory the user owns is untouched", () => {
  it("never reads a plain user script that merely sits next to the retired ones", () => {
    const mine = put(cwd, ".claude/scripts/check-mine.sh", "#!/usr/bin/env bash\necho mine\n");
    mkdirSync(join(cwd, ".claude/scripts"), { recursive: true });
    renderClaudeEngine(cwd, config());
    expect(existsSync(mine)).toBe(true);
  });
});
