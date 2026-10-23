import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Options {
  seed: number;
  cases: number;
  hook: string;
  engine: "claude" | "codex" | "pi";
  shell: "bash" | "zsh";
  audit: "off" | "active";
  timeoutMs: number;
}
interface Fixtures {
  manifestPath: string;
  binary: string;
  scriptsRoot: string;
  shellScript: string;
}
interface Result {
  ok: boolean;
  seed: number;
  completed: number;
  index?: number;
  payload?: string;
  difference?: { field: string; expected: unknown; actual: unknown };
  failure?: string;
}
interface Fuzzer {
  parseFuzzArgs: (args: string[]) => Options;
  generatePayloads: (seed: number, count: number) => string[];
  fuzzHooks: (options: Partial<Options>, fixtures?: Fixtures) => Promise<Result>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const script = join(root, "scripts", "js", "hook-fuzz.mjs");
const fuzzer = (await import(pathToFileURL(script).href)) as Fuzzer;
const directories: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-fuzz-test-")));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real process fixtures exercise only the transport/comparator, never productive native parity. */
function fixtures(nativeSource: string, shellSource = "cat\n"): Fixtures {
  const dir = temp();
  const binary = join(dir, "native-process");
  writeFileSync(binary, `#!${process.execPath}\n${nativeSource}\n`);
  chmodSync(binary, 0o755);
  const hook = join(dir, ".claude", "hooks", "fixture.sh");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "# transport fixture, no native signature or implementation\n");
  const shellScript = join(dir, "shell.sh");
  writeFileSync(shellScript, shellSource);
  const manifestPath = join(dir, "ported.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ schema: 1, hooks: { fixture: { mode: "active" } } }),
  );
  return { binary, manifestPath, shellScript, scriptsRoot: dir };
}

const echo = "process.stdout.write(require('node:fs').readFileSync(0));";
const options = { seed: 7, cases: 3, hook: "fixture", timeoutMs: 1000 } as const;

describe("deterministic live hook fuzzing", () => {
  // Covers: R11
  it("reproduces the seed and validates strict bounded CLI options", () => {
    expect(fuzzer.generatePayloads(7, 20)).toEqual(fuzzer.generatePayloads(7, 20));
    expect(fuzzer.generatePayloads(7, 20)).not.toEqual(fuzzer.generatePayloads(8, 20));
    expect(
      fuzzer.parseFuzzArgs(["--seed", "0", "--cases", "2", "--hook", "fixture", "--engine", "pi"]),
    ).toMatchObject({ seed: 0, cases: 2, hook: "fixture.sh", engine: "pi", audit: "off" });
    expect(fuzzer.parseFuzzArgs(["--cases", "100000"])).toMatchObject({ cases: 100000 });
    expect(fuzzer.parseFuzzArgs([])).toMatchObject({ cases: 1000 });
    for (const args of [
      ["--cases", "0"],
      ["--cases", "100001"],
      ["--cases", "1.5"],
      ["--cases", "NaN"],
      ["--seed", "-1"],
      ["--seed", "4294967296"],
      ["--seed", "1", "--seed", "2"],
      ["--timeout-ms", "0"],
      ["--timeout-ms", "60001"],
      ["--hook", "../fixture"],
      ["--audit", "both"],
      ["--engine", "other"],
      ["--shell", "sh"],
      ["--cases"],
      ["--unknown"],
    ])
      expect(() => fuzzer.parseFuzzArgs(args)).toThrow();
  });

  // Covers: R11
  it("compares live shell stdout with direct process output for the same generated payload", async () => {
    const result = await fuzzer.fuzzHooks(options, fixtures(echo));
    expect(result).toEqual({ ok: true, seed: 7, completed: 3 });
  });

  // Covers: R11
  it("reports a seeded divergence with the exact reproducible payload", async () => {
    const transport = fixtures(
      "process.stdout.write('native:' + require('node:fs').readFileSync(0, 'utf8'));",
    );
    const first = await fuzzer.fuzzHooks(options, transport);
    const second = await fuzzer.fuzzHooks(options, transport);
    const payload = fuzzer.generatePayloads(7, 3)[0];
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: false,
      seed: 7,
      completed: 1,
      index: 1,
      payload,
      difference: { field: "stdout", expected: payload, actual: `native:${payload}` },
    });
  });

  // Covers: R11, R12
  it("restores the entire sandbox and uses identical cwd/home/tmp for both runtimes", async () => {
    const body = `
const fs = require("node:fs");
const path = require("node:path");
const input = fs.readFileSync(0, "utf8");
const paths = [process.cwd(), process.env.HOME, process.env.TMPDIR].map(p => path.join(p, "state"));
const value = { input, cwd: process.cwd(), home: process.env.HOME, tmp: process.env.TMPDIR, before: paths.map(p => fs.existsSync(p)) };
for (const p of paths) fs.writeFileSync(p, "changed");
process.stdout.write(JSON.stringify(value));`;
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const transport = fixtures(body, `exec ${quote(process.execPath)} -e ${quote(body)}\n`);
    const result = await fuzzer.fuzzHooks({ ...options, cases: 2 }, transport);
    expect(result).toEqual({ ok: true, seed: 7, completed: 2 });
    expect(existsSync(join(transport.scriptsRoot, "state"))).toBe(false);
    expect(
      readFileSync(join(transport.scriptsRoot, ".claude", "hooks", "fixture.sh"), "utf8"),
    ).toContain("no native signature");
  });

  // Covers: R11, R12
  it("never reports success on native defer, forced missing implementation or either runtime timeout", async () => {
    for (const source of [
      "process.exit(3);",
      "process.stderr.write('navori-rust: hook deferred: hook has no compiled implementation\\n'); process.exit(1);",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ]) {
      const result = await fuzzer.fuzzHooks({ ...options, timeoutMs: 250 }, fixtures(source));
      expect(result).toMatchObject({ ok: false, seed: 7, completed: 0, index: 1 });
      expect(result.failure).toMatch(/native unavailable|ETIMEDOUT/);
    }
    const shellTimeout = await fuzzer.fuzzHooks(
      { ...options, timeoutMs: 1000 },
      fixtures(echo, "while :; do :; done\n"),
    );
    expect(shellTimeout).toMatchObject({ ok: false, completed: 0, index: 1 });
    expect(shellTimeout.failure).toBe("shell unavailable: ETIMEDOUT");
  });

  // Covers: R11, R12
  it("rejects inactive audit/runtime preconditions before starting the requested batch", async () => {
    const transport = fixtures(echo);
    const active = await fuzzer.fuzzHooks({ ...options, cases: 1000, audit: "active" }, transport);
    expect(active).toMatchObject({ ok: false, completed: 0 });
    expect(active.failure).toContain("audit active requires CLI-writer fixtures");
    for (const hooks of [{}, { fixture: { mode: "shadow" } }]) {
      writeFileSync(transport.manifestPath, JSON.stringify({ schema: 1, hooks }));
      expect(await fuzzer.fuzzHooks({ ...options, cases: 100000 }, transport)).toMatchObject({
        ok: false,
        completed: 0,
      });
    }
    writeFileSync(
      transport.manifestPath,
      JSON.stringify({ schema: 1, hooks: { fixture: { mode: "active" } } }),
    );
    expect(
      await fuzzer.fuzzHooks(
        { ...options, cases: 1000 },
        { ...transport, binary: join(transport.scriptsRoot, "missing") },
      ),
    ).toMatchObject({ ok: false, completed: 0 });
    const capture = join(transport.scriptsRoot, "executed");
    writeFileSync(
      transport.binary,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, 'unexpected');\n`,
    );
    const result = spawnSync(process.execPath, [script, "--seed", "1", "--cases", "1000"], {
      env: {
        ...process.env,
        NAVORI_RUST_BIN: transport.binary,
        NAVORI_RUST_HOOKS_DIR: transport.scriptsRoot,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("native unavailable");
    expect(result.stdout).not.toContain("identical");
    expect(existsSync(capture)).toBe(false);
  });
});
