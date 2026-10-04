import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "citty";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterCommand } from "../master.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function invoke(
  cwd: string,
  ...args: string[]
): Promise<{ code: number | undefined; output: string }> {
  const oldCode = process.exitCode;
  const oldErr = process.stderr.write;
  let output = "";
  process.exitCode = undefined;
  process.stderr.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCommand(masterCommand, { rawArgs: [...args, "--cwd", cwd] });
    return { code: process.exitCode, output };
  } finally {
    process.exitCode = oldCode;
    process.stderr.write = oldErr;
  }
}

describe("delivery CLI", () => {
  it("does not turn a general implementation request into baseline or queue authority", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-d2-cli-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        sdd: { enabled: true },
      }),
    );
    expect((await invoke(cwd, "delivery-baseline")).code).toBe(1);
    expect((await invoke(cwd, "delivery-queue", "--delivery", "E1", "--parts", "P1")).code).toBe(1);
    expect((await invoke(cwd, "delivery-check")).output).toMatch(/no active deliveries stage/);
  });
});
