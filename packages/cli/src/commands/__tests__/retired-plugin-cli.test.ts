import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `navori add` / `navori remove` for a RETIRED plugin, through the built CLI.
 * `cognitive` is the one real retired id (`deleteForeign`, so its marker-free
 * leftovers are navori's to purge).
 */
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "index.js");
const HOME = mkdtempSync(join(tmpdir(), "navori-retired-cli-home-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-retired-cli-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync("node", [CLI, ...args, "--cwd", cwd], {
    encoding: "utf-8",
    env: { ...process.env, HOME, NO_COLOR: "1" },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const writeConfig = (plugins: Record<string, unknown>): void =>
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "true", full: "true" },
      plugins,
    }),
  );

describe("navori add <retired plugin>", () => {
  it("says the plugin was retired (not 'unknown') and exits 1", () => {
    writeConfig({});
    const r = run(["add", "cognitive"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/retir/i);
    expect(r.out).toContain("#130");
    expect(r.out).not.toMatch(/desconocido|unknown plugin/i);
  });
});

describe("navori remove <retired plugin>", () => {
  const script = (): string => join(cwd, ".claude/scripts/check-cognitive.sh");
  const seed = (): void => {
    mkdirSync(join(cwd, ".claude/scripts"), { recursive: true });
    writeFileSync(script(), "#!/usr/bin/env bash\necho cognitive\n");
  };

  it("cleans up a retired plugin's leftovers and drops the config key", () => {
    writeConfig({ cognitive: { enabled: true } });
    seed();
    const r = run(["remove", "cognitive", "--yes"]);
    expect(r.status).toBe(0);
    expect(existsSync(script())).toBe(false);
    expect(JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf-8")).plugins).toEqual({});
  });

  it("phase 1 preserves nativeHook, so the script a native hook calls survives that render", () => {
    writeConfig({ cognitive: { enabled: true, nativeHook: true } });
    seed();
    const r = run(["remove", "cognitive", "--yes"]);
    expect(r.status).toBe(0);
    // Phase 1 kept `nativeHook` while it rendered: the script is still there. Phase 2 dropped
    // the key (documented residual risk: the next render deletes it, `doctor` and the release
    // note tell `nativeHook` users to vendor the script first).
    expect(existsSync(script())).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf-8")).plugins).toEqual({});
  });
});
