import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NavoriConfigSchema, type NavoriConfigInput } from "../../../lib/config/schema.ts";
import * as nativeHooks from "../../../lib/diagnose/native-hooks.ts";
import { readCliVersion } from "../../../lib/render/bundled-assets.ts";
import { injectManagedSection } from "../../../lib/render/marker.ts";
import {
  SYN_ID,
  SYN_SCRIPT,
  SYN_CODEX_SUB_BLOCK,
  makeRepo,
  markedScript,
  put,
  registerSyntheticRetired,
} from "../../shared/__tests__/retired-fixtures.ts";

/**
 * The Codex side of the retired-plugin cleanup: the `.codex/scripts` orphan scan
 * (now behind the shared keep policy, so a hook that still calls the script keeps
 * it even in a Codex-only repo), the residual-registration warning for retired ids,
 * and the sweep of retired skill sub-blocks under `.agents/skills`.
 */
vi.mock("../../../lib/diagnose/native-hooks.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/diagnose/native-hooks.ts")>();
  return { ...actual, readHookSources: vi.fn(actual.readHookSources) };
});

const { renderCodexEngine } = await import("../index.ts");

const SCRIPT = `.codex/scripts/${SYN_SCRIPT}`;
const CALL = `bash ".codex/scripts/${SYN_SCRIPT}"`;

let cwd: string;
let unregister: () => void;

function config(overrides: Partial<NavoriConfigInput> = {}) {
  return NavoriConfigSchema.parse({
    name: "codex-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...overrides,
  });
}

beforeEach(() => {
  unregister = registerSyntheticRetired();
  cwd = makeRepo();
  vi.mocked(nativeHooks.readHookSources).mockClear();
});

afterEach(() => {
  unregister();
  rmSync(cwd, { recursive: true, force: true });
});

describe("Codex .codex/scripts orphan scan — retired plugin scripts", () => {
  it("deletes a pristine retired script, and a second render is a no-op", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    renderCodexEngine(cwd, config());
    expect(existsSync(abs)).toBe(false);
    expect(renderCodexEngine(cwd, config()).written).toEqual([]);
  });

  it("keeps a script with a line appended after the end marker (no fresh render to compare)", () => {
    const abs = put(cwd, SCRIPT, `${markedScript()}echo mine\n`);
    const result = renderCodexEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes(SCRIPT))).toBe(true);
  });

  it("keeps a marker-free script as foreign", () => {
    const abs = put(cwd, SCRIPT, "#!/usr/bin/env bash\necho mine\n");
    const result = renderCodexEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes(SCRIPT))).toBe(true);
  });

  it("a Codex-only repo whose husky hook calls the script keeps it (hook-referenced)", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    put(cwd, ".husky/pre-commit", `#!/bin/sh\n${CALL} </dev/null\n`);
    const result = renderCodexEngine(cwd, config());
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes(SCRIPT) && w.includes("invoca"))).toBe(true);
  });

  it("keeps it while plugins.<id>.nativeHook is declared", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    renderCodexEngine(cwd, config({ plugins: { [SYN_ID]: { enabled: false, nativeHook: true } } }));
    expect(existsSync(abs)).toBe(true);
  });

  it("keeps it, and warns about the registration, when a skipped config.toml still names it", () => {
    renderCodexEngine(cwd, config());
    const configPath = join(cwd, ".codex/config.toml");
    // Hand-edit inside navori's block: the next render skips config.toml and leaves the row.
    const original = readFileSync(configPath, "utf-8");
    writeFileSync(
      configPath,
      original.replace(
        /^(# navori:managed start .*)$/m,
        `$1\n# bash "$(git rev-parse --show-toplevel)/${SCRIPT}"`,
      ),
    );
    const abs = put(cwd, SCRIPT, markedScript());

    const result = renderCodexEngine(cwd, config());
    expect(result.skipped.some((s) => s.path === ".codex/config.toml")).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(result.warnings.some((w) => w.includes(SCRIPT) && w.includes("config.toml"))).toBe(true);
    // The residual-registration warning names the retired script (a retired id has no manifest).
    expect(result.warnings.some((w) => w.includes(`${SCRIPT} `) && /ALERTA|WARNING/.test(w))).toBe(
      true,
    );
  });

  it("does not delete anything under --dry-run", () => {
    const abs = put(cwd, SCRIPT, markedScript());
    renderCodexEngine(cwd, config(), { dryRun: true });
    expect(existsSync(abs)).toBe(true);
  });

  it("reads no hook source when no retired asset is on disk", () => {
    put(cwd, ".husky/pre-commit", `#!/bin/sh\n${CALL}\n`);
    renderCodexEngine(cwd, config());
    expect(nativeHooks.readHookSources).not.toHaveBeenCalled();
  });

  it("does not raise a load-failure warning for a retired id the config still lists", () => {
    const result = renderCodexEngine(
      cwd,
      config({ plugins: { [SYN_ID]: { enabled: true }, cognitive: { enabled: true } } }),
    );
    expect(
      result.warnings.some((w) => w.includes("no pudo cargarse") || w.includes("could not")),
    ).toBe(false);
  });
});

describe("Codex sweep of retired skill sub-blocks under .agents/skills", () => {
  const target = ".agents/skills/review-diff/SKILL.md";
  const subBlock = (body: string, version = readCliVersion()): string =>
    injectManagedSection("", SYN_CODEX_SUB_BLOCK, body, {
      source: `@navori/plugin-${SYN_ID}`,
      version,
    }).output;
  /** Renders once (so the skill exists as a real Codex skill), then appends a block. */
  const seed = (block: string): string => {
    renderCodexEngine(cwd, config());
    const abs = join(cwd, target);
    writeFileSync(abs, `${readFileSync(abs, "utf-8")}\n${block}`);
    return abs;
  };

  it("strips a pristine sub-block and keeps the rest of the skill", () => {
    const abs = seed(subBlock("legacy extension"));
    renderCodexEngine(cwd, config());
    const after = readFileSync(abs, "utf-8");
    expect(after).toContain("review-diff");
    expect(after).not.toContain(SYN_CODEX_SUB_BLOCK);
  });

  it("keeps an edited sub-block and warns", () => {
    const abs = seed(subBlock("legacy extension").replace("legacy extension", "my words"));
    const result = renderCodexEngine(cwd, config());
    expect(readFileSync(abs, "utf-8")).toContain("my words");
    expect(
      result.warnings.some((w) => w.includes(SYN_CODEX_SUB_BLOCK) && w.includes("edited")),
    ).toBe(true);
  });

  it("keeps a sub-block from a newer navori and warns", () => {
    const abs = seed(subBlock("legacy extension", "999.0.0"));
    const result = renderCodexEngine(cwd, config());
    expect(readFileSync(abs, "utf-8")).toContain(SYN_CODEX_SUB_BLOCK);
    expect(
      result.warnings.some((w) => w.includes(SYN_CODEX_SUB_BLOCK) && w.includes("newer")),
    ).toBe(true);
  });

  it("ignores agent targets: Codex agent TOML is regenerated whole", () => {
    const toml = put(cwd, ".codex/agents/zz-agent.toml", 'name = "zz-agent"\n');
    renderCodexEngine(cwd, config());
    expect(readFileSync(toml, "utf-8")).toContain("zz-agent");
  });
});
