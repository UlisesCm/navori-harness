import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  compared: number;
  cached: number;
  index?: number;
  payload?: string;
  difference?: { field: string; expected: unknown; actual: unknown };
  failure?: string;
}
interface Fuzzer {
  parseFuzzArgs: (args: string[]) => Options;
  generatePayloads: (seed: number, count: number, hook?: string) => string[];
  fuzzHooks: (
    options: Partial<Options>,
    fixtures?: Fixtures,
    progress?: {
      everyMs?: number;
      now?: () => number;
      report?: (compared: number, total: number, elapsedMs: number) => void;
    },
    run?: { shard?: { index: number; count: number }; cacheDir?: string; verifyEvery?: number },
  ) => Promise<Result>;
  fuzzParallel: (
    options: Options,
    run: { jobs: number; cache: "on" | "off"; priority: "low" | "normal" },
    extra?: { fixtures?: Fixtures },
  ) => Promise<Result & { jobs?: number }>;
  progressLine: (completed: number, total: number, elapsedMs: number) => string;
  uniqueCases: (payloads: string[]) => Array<{ index: number; weight: number }>;
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
    expect(fuzzer.parseFuzzArgs([])).toMatchObject({
      cases: 1000,
      run: { cache: "on", priority: "low" },
    });
    expect(fuzzer.parseFuzzArgs(["--jobs", "4", "--cache", "off", "--shard", "1/4"])).toMatchObject(
      { run: { jobs: 4, cache: "off", shard: { index: 1, count: 4 } } },
    );
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
      ["--jobs", "0"],
      ["--jobs", "65"],
      ["--cache", "maybe"],
      ["--priority", "high"],
      ["--shard", "2/2"],
      ["--shard", "1"],
      ["--fixtures", "{}"],
    ])
      expect(() => fuzzer.parseFuzzArgs(args)).toThrow();
  });

  // Covers: R70
  it("la gramática de general-purpose-confirm cubre cada campo y sus formas inertes", () => {
    const inputs = fuzzer
      .generatePayloads(1, 2000, "general-purpose-confirm.sh")
      .map((payload) => {
        try {
          return (JSON.parse(payload) as { tool_input?: unknown }).tool_input;
        } catch {
          return undefined;
        }
      })
      .filter(
        (input): input is Record<string, unknown> => typeof input === "object" && input !== null,
      );
    const has = (check: (input: Record<string, unknown>) => boolean): boolean => inputs.some(check);
    expect(has((i) => i.subagent_type === "general-purpose")).toBe(true);
    expect(has((i) => !("subagent_type" in i) && i.agent_type === "general-purpose")).toBe(true);
    expect(has((i) => i.subagent_type === "" && i.agent_type === "general-purpose")).toBe(true);
    expect(has((i) => typeof i.subagent_type !== "string" && "subagent_type" in i)).toBe(true);
    expect(has((i) => i.subagent_type === "general-purpose-lite")).toBe(true);
    expect(has((i) => i.subagent_type === "scout" && typeof i.prompt === "string")).toBe(true);
    expect(fuzzer.generatePayloads(1, 50, "general-purpose-confirm.sh")).toEqual(
      fuzzer.generatePayloads(1, 50, "general-purpose-confirm.sh"),
    );
  });

  // Covers: R11
  it("keeps the original grammar stream so recorded seeds still reproduce", () => {
    const stream = JSON.stringify(fuzzer.generatePayloads(1, 2000));
    expect(createHash("sha1").update(stream).digest("hex")).toBe(
      "fb56db350100be26e4b8eac502c3733aa68ea289",
    );
    expect(fuzzer.generatePayloads(1, 50, "subagent-no-background.sh")).toEqual(
      fuzzer.generatePayloads(1, 50),
    );
  });

  // Covers: R11, R12
  it("gives guard-destructive a grammar over every rule and the payload's edge shapes", () => {
    const payloads = fuzzer.generatePayloads(1, 5000, "guard-destructive.sh");
    expect(fuzzer.generatePayloads(1, 5000, "guard-destructive.sh")).toEqual(payloads);
    expect(payloads).not.toEqual(fuzzer.generatePayloads(2, 5000, "guard-destructive.sh"));
    const commands: string[] = [];
    const shapes = new Set<string>();
    for (const [index, payload] of payloads.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        shapes.add("malformed");
        continue;
      }
      if (index % 11 === 0) shapes.add("malformed");
      if (typeof parsed !== "object" || parsed === null || !("tool_input" in parsed)) continue;
      const input = (parsed as { tool_input: unknown }).tool_input;
      if (typeof input === "string") shapes.add("string tool_input");
      else if (typeof input === "object" && input !== null && "command" in input) {
        const command = (input as { command: unknown }).command;
        if (typeof command === "string") commands.push(command);
        else shapes.add(`${typeof command} command`);
      }
      if (!("cwd" in parsed)) shapes.add("no cwd");
    }
    expect([...shapes].sort()).toEqual(
      ["malformed", "no cwd", "number command", "object command", "string tool_input"].sort(),
    );
    for (const needle of [
      "--no-verify",
      "git push --force origin main",
      "rm -rf /",
      "--no-preserve-root",
      ":(){ :|:& };:",
      "of=/dev/sda",
      "> CLAUDE.md",
      "cp x .claude/settings.json",
      "pi --no-extensions",
      "engram delete",
      "git reset --hard",
      "git clean -fdx",
      "grep -rn foo .",
      "<<'EOF'",
      "\u0000",
      " && ",
      "\n",
    ])
      expect(
        commands.some((command) => command.includes(needle)),
        needle,
      ).toBe(true);
  });

  // Covers: R11
  it("compares live shell stdout with direct process output for the same generated payload", async () => {
    const result = await fuzzer.fuzzHooks(options, fixtures(echo));
    expect(result).toEqual({ ok: true, seed: 7, completed: 3, compared: 3, cached: 0 });
  });

  // Covers: R11
  it("reports periodic progress without changing the result, and never after the last case", async () => {
    let clock = 0;
    const lines: string[] = [];
    const result = await fuzzer.fuzzHooks(options, fixtures(echo), {
      everyMs: 60_000,
      now: () => (clock += 60_000),
      report: (compared, total, elapsedMs) =>
        lines.push(fuzzer.progressLine(compared, total, elapsedMs)),
    });
    expect(result).toEqual({ ok: true, seed: 7, completed: 3, compared: 3, cached: 0 });
    expect(lines).toEqual([
      "hook-fuzz: 1/3 (33%) in 1m, ~2m left",
      "hook-fuzz: 2/3 (66%) in 2m, ~1m left",
    ]);
    expect(fuzzer.progressLine(0, 100000, 0)).toBe("hook-fuzz: 0/100000 (0%) in 0m, ~? left");
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
    expect(result).toEqual({ ok: true, seed: 7, completed: 2, compared: 2, cached: 0 });
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
    for (const hooks of [{}, { fixture: { mode: "unknown" } }]) {
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

  // Covers: R11, R12
  it("fuzzes shadow descriptors through forced Rust and never counts native deferral as parity", async () => {
    const transport = fixtures(`
const args = process.argv.slice(2);
if (process.env.NAVORI_HOOK_IMPL !== 'rust' || args.length !== 3 || args[0] !== 'hook' || args[1] !== '--via-script' || !args[2].endsWith('/.claude/hooks/fixture.sh')) process.exit(101);
${echo}`);
    writeFileSync(
      transport.manifestPath,
      JSON.stringify({ schema: 1, hooks: { fixture: { mode: "shadow" } } }),
    );
    expect(await fuzzer.fuzzHooks(options, transport)).toEqual({
      ok: true,
      seed: 7,
      completed: 3,
      compared: 3,
      cached: 0,
    });
    for (const source of [
      "process.exit(3);",
      "process.stderr.write('navori-rust: hook deferred: shadow execution is unavailable\\n'); process.exit(1);",
    ]) {
      writeFileSync(transport.binary, `#!${process.execPath}\n${source}\n`);
      const result = await fuzzer.fuzzHooks(options, transport);
      expect(result).toMatchObject({ ok: false, completed: 0, index: 1 });
      expect(result.failure).toContain("native unavailable");
    }
  });
  // Covers: R11
  it("compares payloads that differ only in session_id once and still counts every generated case", () => {
    const base = { hook_event_name: "PreToolUse", tool_input: { command: "ls" } };
    const payloads = [
      JSON.stringify({ session_id: "a", ...base }),
      JSON.stringify({ session_id: "b", ...base }),
      "{",
      JSON.stringify({ session_id: "c", ...base, cwd: "x" }),
      "{",
    ];
    expect(fuzzer.uniqueCases(payloads)).toEqual([
      { index: 0, weight: 2 },
      { index: 2, weight: 2 },
      { index: 3, weight: 1 },
    ]);
  });

  // Covers: R11
  it("splits unique cases across shards without overlap or loss", async () => {
    const transport = fixtures(echo);
    const whole = await fuzzer.fuzzHooks({ ...options, cases: 6 }, transport);
    const parts: Result[] = [];
    for (const index of [0, 1])
      parts.push(
        await fuzzer.fuzzHooks(
          { ...options, cases: 6 },
          transport,
          {},
          { shard: { index, count: 2 } },
        ),
      );
    expect(whole).toMatchObject({ ok: true, completed: 6 });
    expect(parts.map((part) => part.ok)).toEqual([true, true]);
    const sum = (field: "completed" | "compared"): number =>
      parts.reduce((total, part) => total + part[field], 0);
    expect(sum("completed")).toBe(6);
    expect(sum("compared")).toBe(whole.compared);
    expect(Math.min(...parts.map((part) => part.compared))).toBeGreaterThan(0);
  });

  // Covers: R11
  it("serves the shell verdict from the cache, keeps Rust live and fails on a stale cache", async () => {
    const dir = temp();
    const counter = join(dir, "shell-runs");
    const cacheDir = join(dir, "cache");
    const transport = fixtures(echo, `printf x >> '${counter}'\ncat\n`);
    const shellRuns = (): number =>
      existsSync(counter) ? readFileSync(counter, "utf8").length : 0;
    const first = await fuzzer.fuzzHooks(options, transport, {}, { cacheDir });
    expect(first).toEqual({ ok: true, seed: 7, completed: 3, compared: 3, cached: 0 });
    expect(shellRuns()).toBe(3);
    const second = await fuzzer.fuzzHooks(
      options,
      transport,
      {},
      { cacheDir, verifyEvery: 2 ** 32 },
    );
    expect(second).toEqual({ ok: true, seed: 7, completed: 3, compared: 3, cached: 3 });
    expect(shellRuns()).toBe(3);
    const fingerprint = readdirSync(cacheDir)[0] ?? "";
    expect(fingerprint).not.toBe("");
    for (const name of readdirSync(join(cacheDir, fingerprint))) {
      const file = join(cacheDir, fingerprint, name);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      const tampered = lines.map((line) => {
        const entry = JSON.parse(line) as { k: string; v: { stdout: string } };
        return JSON.stringify({ ...entry, v: { ...entry.v, stdout: "tampered" } });
      });
      writeFileSync(file, `${tampered.join("\n")}\n`);
    }
    const stale = await fuzzer.fuzzHooks(options, transport, {}, { cacheDir, verifyEvery: 1 });
    expect(stale).toMatchObject({ ok: false, index: 1 });
    expect(stale.failure).toContain("stale shell cache");
  });

  // Covers: R11
  it("runs shard workers in parallel with the totals of one process and stops on a divergence", async () => {
    const { run: _run, ...plain } = fuzzer.parseFuzzArgs([
      "--seed",
      "7",
      "--cases",
      "6",
      "--hook",
      "fixture",
      "--timeout-ms",
      "1000",
    ]) as Options & { run: unknown };
    const transport = fixtures(echo);
    const single = await fuzzer.fuzzHooks(plain, transport);
    const parallel = await fuzzer.fuzzParallel(
      plain,
      { jobs: 2, cache: "off", priority: "low" },
      { fixtures: transport },
    );
    expect(parallel).toMatchObject({ ok: true, completed: 6, compared: single.compared, jobs: 2 });
    const diverging = fixtures(
      "process.stdout.write('native:' + require('node:fs').readFileSync(0, 'utf8'));",
    );
    const failed = await fuzzer.fuzzParallel(
      plain,
      { jobs: 2, cache: "off", priority: "normal" },
      { fixtures: diverging },
    );
    expect(failed).toMatchObject({ ok: false, difference: { field: "stdout" } });
    expect(failed.payload).toBe(fuzzer.generatePayloads(7, 6)[(failed.index ?? 0) - 1]);
  });
});
