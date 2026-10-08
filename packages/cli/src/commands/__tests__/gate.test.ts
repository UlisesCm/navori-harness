import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { gateCommand } from "../gate.ts";

let cwd: string;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-gate-cmd-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "g", version: "1.0.0", scripts: { ok: "echo fine" } }),
  );
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("gate command", () => {
  // Covers: A1
  it("prints the sentinel first and sets the exit code", async () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "g",
        engines: ["claude"],
        preset: "custom",
        qualityGate: { fast: "npm run ok", full: "npm run ok" },
      }),
    );
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCommand(gateCommand, { rawArgs: ["full", "--cwd", cwd] });
    expect(String(out.mock.calls[0]![0]).split("\n")[0]).toMatch(
      /^navori gate full: exit 0 — log /,
    );
    expect(process.exitCode).toBe(0);
  });

  it("rejects an unknown kind with exit 2", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCommand(gateCommand, { rawArgs: ["nope", "--cwd", cwd] });
    expect(process.exitCode).toBe(2);
    expect(String(err.mock.calls[0]![0])).toContain("unknown kind");
  });

  it("exits 2 with a clear error when qualityGate is missing", async () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "g", engines: ["claude"], preset: "custom" }),
    );
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCommand(gateCommand, { rawArgs: ["fast", "--cwd", cwd] });
    expect(process.exitCode).toBe(2);
    expect(String(err.mock.calls[0]![0])).toContain("qualityGate.fast is not set");
  });
});
