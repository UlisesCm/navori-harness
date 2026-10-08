import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";

const execFileSync = vi.fn();
const spawn = vi.fn((..._args: unknown[]) => ({ on: () => {}, unref: () => {} }));
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
  spawn: (...args: unknown[]) => spawn(...args),
}));
vi.mock(import("../../lib/primitives/which.ts"), () => ({ hasBinary: () => true }));

const { toolsCommand } = await import("../tools.ts");

// Covers: #1244 — output contract v1 of `navori tools notice` and `--ack`.
const SENTINEL = "#navori-tool-notice v1 ack=";
let home: string;
let project: string;
let tools: string;
let out: string;

function seed(latest: string, language = "en"): void {
  mkdirSync(tools, { recursive: true });
  writeFileSync(
    join(tools, "latest.json"),
    JSON.stringify({
      tools: {
        engram: {
          at: Date.now(),
          source: "github",
          id: "Gentleman-Programming/engram",
          status: "ok",
          version: latest,
        },
      },
    }),
  );
  writeFileSync(
    join(project, "navori.config.json"),
    JSON.stringify({
      name: "p",
      engines: ["claude"],
      preset: "custom",
      language,
      plugins: { engram: { enabled: true } },
    }),
  );
  execFileSync.mockReturnValue("engram 3.0.0\n");
}

async function run(...rawArgs: string[]): Promise<void> {
  await runCommand(toolsCommand, { rawArgs: ["notice", ...rawArgs] });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "navori-tools-"));
  project = join(home, "project");
  mkdirSync(project);
  tools = join(home, ".navori", "tool-versions");
  out = "";
  vi.stubEnv("HOME", home);
  vi.stubEnv("CI", "");
  vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "");
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  execFileSync.mockReset();
  spawn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("navori tools notice", () => {
  it("prints the sentinel first, then one localized line per tool, and does not mark delivery", async () => {
    seed("3.2.1");
    await run();
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe(`${SENTINEL}engram@3.2.1`);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("3.2.1");
    expect(lines[1]).toContain("3.0.0");
    expect(lines[1]).toMatch(/newer engram/);
    expect(existsSync(join(tools, "notice.json"))).toBe(false);
  });

  it("uses the repo language", async () => {
    seed("3.2.1", "es");
    await run();
    expect(out.split("\n")[1]).toMatch(/versión nueva de engram/);
  });

  it("prints nothing without a cache but reserves the refresh and launches one worker", async () => {
    seed("3.2.1");
    rmSync(join(tools, "latest.json"));
    await run();
    expect(out).toBe("");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(tools, "attempts.json"))).toBe(true);
  });

  it("prints nothing when nothing is newer enough", async () => {
    seed("3.0.5");
    await run();
    expect(out).toBe("");
  });

  it("stays silent without a config, with a broken one, and when opted out", async () => {
    seed("3.2.1");
    rmSync(join(project, "navori.config.json"));
    await run();
    writeFileSync(join(project, "navori.config.json"), "{ nope");
    await run();
    seed("3.2.1");
    vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "1");
    await run();
    expect(out).toBe("");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("--ack stamps delivery for valid pairs only and the notice stops repeating", async () => {
    seed("3.2.1");
    await run("--ack", "engram@3.2.1,evil@9.9.9,engram@x");
    out = "";
    expect(
      Object.keys(JSON.parse(readFileSync(join(tools, "notice.json"), "utf8")) as object),
    ).toEqual(["engram"]);
    await run();
    expect(out).toBe("");
  });
});
