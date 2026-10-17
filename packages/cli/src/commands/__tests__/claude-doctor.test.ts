import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { writeConfig } from "../../lib/config/config.ts";
import { runRender } from "../render.ts";
import { scanClaudeHookScripts, computeHealthVerdict, doctorCommand } from "../doctor.ts";

// Fake home for the whole file: no test here may read or write the real `~`.
const fakeHome = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/primitives/home.ts", () => ({ safeHomedir: () => fakeHome.dir }));
beforeEach(() => {
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  fakeHome.dir = mkdtempSync(join(tmpdir(), "navori-fake-home-"));
});
afterEach(() => vi.unstubAllEnvs());

describe("doctor global CLAUDE.md size (#1270)", () => {
  const GLOBAL_FILE = (): string => join(fakeHome.dir, ".claude", "CLAUDE.md");

  function writeGlobal(chars: number): void {
    mkdirSync(join(fakeHome.dir, ".claude"), { recursive: true });
    writeFileSync(GLOBAL_FILE(), "a".repeat(chars));
  }

  /** Run `doctor` (json or text) on a repo with the given engines; returns output + exit code. */
  async function run(
    engines: string[],
    json: boolean,
  ): Promise<{
    text: string;
    report: { globalClaudeMd: unknown };
    exitCode: number | string | undefined;
  }> {
    const cwd = mkdtempSync(join(tmpdir(), "navori-global-doctor-"));
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "g", engines, preset: "custom", branchBase: "main" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await doctorCommand.run?.({
        args: { _: [], cwd, json, strict: false },
        rawArgs: [],
        cmd: doctorCommand,
      });
      const text = [...log.mock.calls, ...stdout.mock.calls].flat().join("\n");
      const last = String(log.mock.calls.at(-1)?.[0]);
      const report = json ? JSON.parse(last) : { globalClaudeMd: undefined };
      return { text, report, exitCode: process.exitCode };
    } finally {
      process.exitCode = before;
      log.mockRestore();
      stdout.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  // Covers: #1270
  it("warns with size, cap and remedy when over the cap (text)", async () => {
    writeGlobal(2500);
    const { text } = await run(["claude"], false);
    expect(text).toContain("2500");
    expect(text).toContain("2000");
    expect(text).toContain("Dominio");
  });

  // Covers: #1270
  it("includes globalClaudeMd in --json when over the cap", async () => {
    writeGlobal(2500);
    const { report } = await run(["claude"], true);
    expect(report.globalClaudeMd).toEqual({
      path: "~/.claude/CLAUDE.md",
      chars: 2500,
      thresholdChars: 2000,
    });
  });

  // Covers: #1270
  it("does not warn under the cap or when the file is missing", async () => {
    writeGlobal(100);
    const under = await run(["claude"], true);
    expect(under.report.globalClaudeMd).toBeNull();
    rmSync(GLOBAL_FILE());
    const missing = await run(["claude"], true);
    expect(missing.report.globalClaudeMd).toBeNull();
  });

  // Covers: #1270
  it("does not warn for a repo without the claude engine", async () => {
    writeGlobal(2500);
    const json = await run(["codex"], true);
    expect(json.report.globalClaudeMd).toBeNull();
    const text = await run(["codex"], false);
    expect(text.text).not.toContain("2500");
  });

  // Covers: #1270
  it("is advisory: same exit code with and without the oversized file", async () => {
    writeGlobal(9000);
    const fat = await run(["claude"], true);
    rmSync(GLOBAL_FILE());
    const slim = await run(["claude"], true);
    expect(fat.exitCode).toBe(slim.exitCode);
  });

  // Covers: #1270
  it("never writes the global file: bytes and mtime unchanged", async () => {
    writeGlobal(2500);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(GLOBAL_FILE(), past, past);
    const bytes = readFileSync(GLOBAL_FILE());
    const mtime = statSync(GLOBAL_FILE()).mtimeMs;
    await run(["claude"], false);
    await run(["claude"], true);
    expect(readFileSync(GLOBAL_FILE()).equals(bytes)).toBe(true);
    expect(statSync(GLOBAL_FILE()).mtimeMs).toBe(mtime);
  });
});

describe("doctor progressSize (#1263)", () => {
  /** Run `doctor --json` on a repo whose session-state file has `chars` bytes. */
  async function runJson(chars: number): Promise<{
    progressSize: { path: string; bytes: number; thresholdBytes: number } | null;
    exitCode: number | string | undefined;
  }> {
    const cwd = mkdtempSync(join(tmpdir(), "navori-progress-doctor-"));
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "p", engines: ["codex"], preset: "custom", branchBase: "main" }),
    );
    mkdirSync(join(cwd, "progress"));
    writeFileSync(join(cwd, "progress/current.md"), "a".repeat(chars));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await doctorCommand.run?.({
        args: { _: [], cwd, json: true, strict: false },
        rawArgs: [],
        cmd: doctorCommand,
      });
      const report = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      return { progressSize: report.progressSize, exitCode: process.exitCode };
    } finally {
      process.exitCode = before;
      output.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("includes progressSize in --json when over the cap", async () => {
    const { progressSize } = await runJson(4500);
    expect(progressSize).toEqual({
      path: "progress/current.md",
      bytes: 4500,
      thresholdBytes: 4000,
    });
  });

  it("reports null under the cap", async () => {
    expect((await runJson(100)).progressSize).toBeNull();
  });

  it("is advisory: the same exit code with and without the oversized file", async () => {
    const fat = await runJson(9000);
    const slim = await runJson(100);
    expect(fat.exitCode).toBe(slim.exitCode);
  });
});

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-claude-doctor-"));
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cl",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    ...overrides,
  });
}

/** Write a `.claude/settings.json` with one PreToolUse hook pointing at `cmd`. */
function writeSettings(cwd: string, cmd: string): void {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }],
      },
    }),
  );
}

describe("scanClaudeHookScripts (#213)", () => {
  it("returns null when claude is not a configured engine", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-semgrep.sh"');
    expect(scanClaudeHookScripts(cwd, config({ engines: ["codex"] }))).toBeNull();
  });

  it("returns null when there is no settings.json yet", () => {
    expect(scanClaudeHookScripts(tempRepo(), config())).toBeNull();
  });

  it("returns null on corrupted settings.json (left to scanCorruptedSettings)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/settings.json"), "{ not valid json");
    expect(scanClaudeHookScripts(cwd, config())).toBeNull();
  });

  it("flags a referenced script that is missing on disk", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-semgrep.sh"');
    const report = scanClaudeHookScripts(cwd, config());
    expect(report?.missing).toContain(".claude/scripts/check-semgrep.sh");
    expect(report?.notExecutable).toEqual([]);
  });

  it("flags a referenced script present but without the executable bit", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-jscpd.sh"');
    mkdirSync(join(cwd, ".claude/scripts"), { recursive: true });
    const script = join(cwd, ".claude/scripts/check-jscpd.sh");
    writeFileSync(script, "#!/bin/sh\n");
    chmodSync(script, 0o644); // no +x
    const report = scanClaudeHookScripts(cwd, config());
    expect(report?.notExecutable).toContain(".claude/scripts/check-jscpd.sh");
    expect(report?.missing).toEqual([]);
  });

  it("passes a referenced hook that exists and is executable", () => {
    const cwd = tempRepo();
    writeSettings(cwd, 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-destructive.sh"');
    mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
    const hook = join(cwd, ".claude/hooks/guard-destructive.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    chmodSync(hook, 0o755);
    const report = scanClaudeHookScripts(cwd, config());
    expect(report).toEqual({ missing: [], notExecutable: [] });
  });

  it("finds hook references nested under different events", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"' },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                { type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/ctx.sh"' },
              ],
            },
          ],
        },
      }),
    );
    const report = scanClaudeHookScripts(cwd, config());
    expect(report?.missing).toEqual([".claude/hooks/guard.sh", ".claude/scripts/ctx.sh"]);
  });
});

describe("computeHealthVerdict (#244 — shared doctor/status gate)", () => {
  it("is ok on a bare custom-preset repo with no rendered output", () => {
    const cwd = tempRepo();
    expect(computeHealthVerdict(cwd, config()).ok).toBe(true);
  });

  it("flips ok when settings.json is corrupted (same signal doctor exits 2 on)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/settings.json"), "{ not valid json");
    const verdict = computeHealthVerdict(cwd, config());
    expect(verdict.ok).toBe(false);
    expect(verdict.corruptedSettings).toHaveLength(1);
  });

  it("flips ok when an enabled plugin can't be loaded", () => {
    const cwd = tempRepo();
    const verdict = computeHealthVerdict(cwd, config({ plugins: { ghost: { enabled: true } } }));
    expect(verdict.ok).toBe(false);
    expect(verdict.missingPlugins.map((m) => m.id)).toContain("ghost");
  });
});

describe("doctor render-pending (spec 0052 R3)", () => {
  // Covers: R3
  it("doctor advierte render pendiente cuando plan-gate.sh renderizado es más viejo que el binario", async () => {
    const cwd = tempRepo();
    writeConfig(join(cwd, "navori.config.json"), {
      name: "pending-doctor",
      engines: ["claude", "agents-md"],
      preset: "custom",
      harness: { planTiers: true },
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = async (json: boolean, strict = false): Promise<unknown> => {
      output.mockClear();
      process.exitCode = undefined;
      await doctorCommand.run?.({
        args: { _: [], cwd, json, strict },
        rawArgs: [],
        cmd: doctorCommand,
      });
      return json ? JSON.parse(String(output.mock.calls.at(-1)?.[0])) : undefined;
    };
    const before = process.exitCode;
    try {
      expect(runRender(cwd).ok).toBe(true);
      const fresh = (await run(true)) as { renderPending: number | null };
      expect(fresh.renderPending).toBe(0);
      const freshExit = process.exitCode;
      await run(true, true);
      const freshStrictExit = process.exitCode;

      // An older binary rendered a plan-gate.sh with other contents: the file exists.
      writeFileSync(
        join(cwd, ".claude/hooks/plan-gate.sh"),
        "#!/usr/bin/env bash\n# plan-gate from an older navori\nexit 0\n",
      );
      const stale = (await run(true)) as { renderPending: number | null };
      expect(stale.renderPending).toBeGreaterThan(0);
      // The warning is advisory: same exit code, also under --strict.
      expect(process.exitCode).toBe(freshExit);
      await run(true, true);
      expect(process.exitCode).toBe(freshStrictExit);

      // Text mode names the remedy.
      const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
      warn.mockClear();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await run(false);
      const text = [...warn.mock.calls, ...stdout.mock.calls].flat().join("\n");
      stdout.mockRestore();
      expect(text).toContain("navori render --apply");
    } finally {
      process.exitCode = before;
      output.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
