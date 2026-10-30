import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { runHookBatch, runHookIsolated } from "./helpers/hook-batch.ts";
import {
  normalizeCorpusText,
  recordHookCase,
  recordSpawnedHook,
  type RawCorpusLine,
} from "./helpers/hook-corpus.ts";

/**
 * Spec 0055 R13 — corpus capture (inside the hook helpers) and replay tool. Fixed fixtures and a
 * tiny fake hook only: the committed corpus is replayed against the real hooks by
 * `node scripts/js/hook-verdict-replay.mjs`, not here.
 */

interface Case {
  hook: string;
  engine: string;
  shell: string;
  input: string;
  envDelta: Record<string, string>;
  cwdKind: "none" | "repo";
  args?: string[];
  fixture?: { path: string; content: string; mode?: number }[];
}
interface Verdict {
  status: number;
  stdout: string;
  stderr: string;
}
/** A committed corpus case: the invocation plus its recorded verdicts. */
type CorpusCase = Case & {
  expected: {
    off: Verdict;
    active: Verdict & { event: { metadata?: Record<string, unknown> }[] };
  };
};
interface Replay {
  readCorpus: () => CorpusCase[];
  parseReplayArgs: (args: string[]) => {
    impl: "shell" | "rust";
    modes: string[];
    only?: string[];
    shell?: string;
  };
  caseKey: (c: Case) => string;
  coverageRows: (
    cases: Case[],
    observed: Record<string, { observed: number }>,
  ) => { hook: string; cases: number; observed: number; pct: number }[];
  firstDifference: (
    expected: Verdict & { event?: unknown },
    actual: Verdict & { event?: unknown },
  ) => { field: string } | null;
  mergeRaw: (lines: (Case & { status: "included" | "excluded"; reason?: string })[]) => {
    cases: Case[];
    observed: Record<
      string,
      { observed: number; included: number; excluded: Record<string, number> }
    >;
  };
  normalizeEvent: (event: unknown) => unknown;
  replayCorpus: (options: {
    corpus: (Case & { expected: Record<string, unknown> })[];
    modes?: string[];
    impl?: "shell" | "rust";
    only?: string[];
    deps: {
      runHookBatch: typeof runHookBatch;
      resolveHook: (hook: string, engine: string, scratch: { bin: string }) => string;
    };
  }) => Promise<{ ok: boolean; cases: number; failure?: string }>;
  withActiveSession: (input: string) => string;
  signedAssets: () => Promise<string>;
  createScratch: () => { cleanup: () => void };
  runMode: (
    cases: Case[],
    mode: "off" | "active",
    deps:
      | {
          resolveHook: (hook: string, engine: string) => string;
          binary: string;
          impl: "rust";
          scratch: { cleanup: () => void };
        }
      | {
          resolveHook: (hook: string, engine: string) => string;
          runHookBatch: typeof runHookBatch;
          scratch: { cleanup: () => void };
        },
  ) => (Verdict & { event?: unknown[] })[];
}

type NativeResult =
  | { available: true; status: number; stdout: Buffer; stderr: Buffer }
  | { available: false; reason: string; modeDeferred?: true };
interface RustAdapter {
  runRustHook: (options: {
    binary: string;
    script: string;
    input: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
    timeoutMs?: number;
  }) => NativeResult;
  prepareRustReplay: (options: { manifestPath: string; binary: string; scriptsRoot?: string }) => {
    binary: string;
    resolveHook: (hook: string, engine: string) => string;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const replay = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "hook-verdict-replay.mjs"))
    .href
)) as Replay;
const rustAdapter = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "rust-hook-adapter.mjs"))
    .href
)) as RustAdapter;
const replayPath = resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "js",
  "hook-verdict-replay.mjs",
);

const mkdirp = (path: string): void => void mkdirSync(path, { recursive: true });
const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "navori-replay-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  delete process.env.NAVORI_HOOK_CORPUS;
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Real hook asset, expanded the way the hook tests install it. */
function installCoreHook(dir: string, name: string): string {
  const source = readFileSync(resolve(getCoreRoot(), "core-assets/hooks", name), "utf-8");
  const path = join(dir, name);
  writeFileSync(path, expandHookIncludes(source));
  chmodSync(path, 0o755);
  return path;
}

function rawLines(dir: string): RawCorpusLine[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("raw-"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RawCorpusLine),
    );
}

const FAKE_HOOK = [
  "#!/usr/bin/env bash",
  "input=$(cat)",
  'printf "out:%s" "$input"',
  'case "$input" in *fail*) echo "failed" >&2; exit 2 ;; esac',
  'spool="${NAVORI_AUDITS_ROOT:-}/project/spool-corpus-active"',
  'if [ -d "$spool" ]; then printf \'{"v":1,"host":"claude","metadata":{"ms":7,"tsMs":1756000000123}}\' > "$spool/e-1.json"; fi',
  "",
].join("\n");

const base = (input: string): Case => ({
  hook: "fake.sh",
  engine: "claude",
  shell: "bash",
  input,
  envDelta: {},
  cwdKind: "repo",
});

/** Executable process-protocol fixture, never a native implementation or signed hook. */
function nativeFixture(dir: string, source: string): string {
  const path = join(dir, "native-process");
  writeFileSync(path, `#!${process.execPath}\n${source}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("native hook replay transport", () => {
  // Covers: R11
  it("without a hooks dir, signs the expanded assets the corpus recorded, with their deps", async () => {
    const repo = resolve(here, "..", "..", "..", "..");
    const manifest = JSON.parse(readFileSync(join(repo, "crates", "ported.json"), "utf8")) as {
      hooks: Record<string, { impl: string; deps?: Record<string, string> }>;
    };
    const dir = await replay.signedAssets();
    try {
      expect(Object.keys(manifest.hooks)).toContain("guard-destructive");
      for (const [id, hook] of Object.entries(manifest.hooks)) {
        const asset = expandHookIncludes(
          readFileSync(join(repo, "packages/core/core-assets/hooks", `${id}.sh`), "utf8"),
        );
        for (const engine of [".claude", ".codex", ".pi/navori"]) {
          const signed = readFileSync(join(dir, engine, "hooks", `${id}.sh`), "utf8");
          const header = /^# navori:native-hook v=1 file=sha256:([a-f0-9]{64}) impl=(\S+)\n/.exec(
            signed,
          );
          expect(header?.[2]).toBe(hook.impl);
          expect(signed.slice(header?.[0].length)).toBe(asset);
          const digest = createHash("sha256").update(
            signed.replace(/file=sha256:[a-f0-9]{64}/, `file=sha256:${"0".repeat(64)}`),
          );
          for (const [name, pinned] of Object.entries(hook.deps ?? {}).sort()) {
            const bytes = readFileSync(join(dir, engine, name));
            // The dependency is the source asset the manifest pins, not a rendered copy.
            expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(pinned);
            digest.update(bytes);
          }
          expect(header?.[1]).toBe(digest.digest("hex"));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Covers: R11
  it("selects the same 232 corpus cases for a bare hook id and its .sh filename", () => {
    const short = replay.parseReplayArgs([
      "--impl",
      "rust",
      "--audit",
      "off",
      "--only",
      "subagent-no-background",
    ]);
    const full = replay.parseReplayArgs([
      "--impl",
      "rust",
      "--audit",
      "off",
      "--only",
      "subagent-no-background.sh",
    ]);
    expect(short.only).toEqual(["subagent-no-background.sh"]);
    const corpus = replay.readCorpus();
    const selected = corpus.filter((entry) => short.only?.includes(entry.hook));
    expect(selected).toHaveLength(232);
    expect(selected).toEqual(corpus.filter((entry) => full.only?.includes(entry.hook)));
    expect(short.modes).toEqual(["off"]);
    expect(
      replay.parseReplayArgs(["--impl", "rust", "--only", "subagent-no-background"]).modes,
    ).toEqual(["off", "active"]);
  });

  // Covers: R11
  it("parses implementation, audit and hook selection explicitly", () => {
    expect(replay.parseReplayArgs([])).toMatchObject({ impl: "shell", modes: ["off", "active"] });
    expect(
      replay.parseReplayArgs(["--impl", "rust", "--audit", "off", "--only", "a.sh,b.sh"]),
    ).toMatchObject({
      impl: "rust",
      modes: ["off"],
      only: ["a.sh", "b.sh"],
    });
    expect(
      replay.parseReplayArgs(["--hook", "a.sh", "--audit", "active", "--shell", "zsh"]),
    ).toMatchObject({
      impl: "shell",
      modes: ["active"],
      only: ["a.sh"],
      shell: "zsh",
    });
    for (const args of [
      ["--impl", "other"],
      ["--audit", "both"],
      ["--unknown"],
      ["--impl"],
      ["--only", ""],
      ["--only", "a.sh,"],
      ["--hook", "../a.sh"],
      ["--hook", "a.sh", "--only", "b.sh"],
      ["--impl", "rust", "--shell", "bash"],
      ["--coverage", "--impl", "shell"],
      ["--generate", "raw", "--audit", "off"],
      ["--check-stable"],
      ["unexpected"],
    ])
      expect(() => replay.parseReplayArgs(args)).toThrow();
  });

  // Covers: R11
  it("rejects unknown flags and zero selection at the actual CLI", () => {
    for (const args of [
      ["--unsupported"],
      ["--only", "no-such-hook.sh"],
      ["--only", "audit-writer"],
      ["--generate", tmp()],
    ]) {
      const output = spawnSync(process.execPath, [replayPath, ...args], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(output.error).toBeUndefined();
      expect(output.status).toBe(1);
      expect(output.stdout).not.toContain("cases identical");
      expect(output.stderr).toMatch(/unknown option|no corpus cases/);
    }
  });

  // Covers: R11
  it("cannot substitute shell dependencies or zero runs for native execution", async () => {
    const deps = {
      runHookBatch: (): never => {
        throw new Error("shell must not execute");
      },
      resolveHook: (): string => {
        throw new Error("shell expansion must not execute");
      },
    };
    const corpus = [{ ...base(""), expected: { off: { status: 0, stdout: "", stderr: "" } } }];
    expect(await replay.replayCorpus({ corpus: [], deps })).toMatchObject({ ok: false, cases: 0 });
    expect(await replay.replayCorpus({ corpus, modes: [], deps })).toMatchObject({ ok: false });
    expect(await replay.replayCorpus({ corpus, only: ["other.sh"], deps })).toMatchObject({
      ok: false,
      cases: 0,
    });
    expect(await replay.replayCorpus({ corpus, modes: ["off"], impl: "rust", deps })).toMatchObject(
      {
        ok: false,
        cases: 1,
        // Empty registry or missing binary: either way no native verdict, never shell parity.
        failure: expect.stringMatching(/^native unavailable: /),
      },
    );
  });

  // Covers: R11
  it("rust reproduce el corpus o la categoría de su divergencia: active reads the native spool event", () => {
    const dir = tmp();
    const write = `const fs = require('node:fs'), path = require('node:path');
const spool = path.join(process.env.NAVORI_AUDITS_ROOT, 'project', 'spool-corpus-active');
fs.writeFileSync(path.join(spool, 'e-1.json'), JSON.stringify({ v: 1, host: 'claude', metadata: { ms: 7, tsMs: 1756000000123 } }));`;
    const cases = [{ ...base('{"tool_name":"Bash"}') }];
    const run = (source: string): (Verdict & { event?: unknown[] })[] => {
      const scratch = replay.createScratch();
      try {
        return replay.runMode(cases, "active", {
          resolveHook: () => join(dir, ".claude", "hooks", "fake.sh"),
          binary: nativeFixture(dir, source),
          impl: "rust",
          scratch,
        });
      } finally {
        scratch.cleanup();
      }
    };
    const [recorded] = run(write);
    const event = { v: 1, host: "claude", metadata: { ms: "<int>=0", tsMs: "<int13>" } };
    expect(recorded).toEqual({ status: 0, stdout: "", stderr: "", event: [event] });
    // A native run that records nothing cannot pass for the shell's event.
    const [silent] = run("process.exit(0);");
    expect(silent?.event).toEqual([]);
    expect(replay.firstDifference(recorded as Verdict, silent as Verdict)).toMatchObject({
      field: "event",
    });
  });

  // Covers: R11, R12
  it("spawns the supplied executable directly with exact argv/stdin and forced Rust", () => {
    const dir = tmp();
    const binary = nativeFixture(
      dir,
      `
const fs = require('node:fs');
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8'), impl: process.env.NAVORI_HOOK_IMPL, cwd: process.cwd() }));
process.stderr.write('diagnostic\\n\\n');
process.exit(1);`,
    );
    const script = join(dir, ".codex", "hooks", "fixture.sh");
    const input = '{"tool_input":{"command":"literal $(never-run)"}}\n\n';
    const result = rustAdapter.runRustHook({
      binary,
      script,
      input,
      cwd: dir,
      env: { NAVORI_HOOK_IMPL: "shell", PATH: "" },
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.reason);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.toString("utf8")) as unknown).toEqual({
      args: ["hook", "--via-script", script],
      input,
      impl: "rust",
      cwd: realpathSync(dir),
    });
    expect(result.stderr).toEqual(Buffer.from("diagnostic\n\n"));
    for (const status of [0, 2]) {
      const native = nativeFixture(
        dir,
        `process.stdout.write('verdict\\n\\n'); process.exit(${status});`,
      );
      expect(rustAdapter.runRustHook({ binary: native, script, input })).toEqual({
        available: true,
        status,
        stdout: Buffer.from("verdict\n\n"),
        stderr: Buffer.alloc(0),
      });
    }
    const bytes = nativeFixture(dir, "process.stdout.write(Buffer.from([0xff, 0, 10]));");
    expect(rustAdapter.runRustHook({ binary: bytes, script, input })).toMatchObject({
      available: true,
      stdout: Buffer.from([0xff, 0, 10]),
    });
  });

  // Covers: R51
  it("tells a mode deferred by design apart from any other deferral", () => {
    const dir = tmp();
    const script = join(dir, ".codex", "hooks", "fixture.sh");
    const rows: Array<[string, boolean]> = [
      ["navori-rust: hook deferred: hook mode is not ported", true],
      ["navori-rust: hook deferred: hook is ineligible: unsupported locale", false],
      ["navori-rust: hook deferred: hook mode is not ported, eventually", true],
      ["hook mode is not ported", false],
    ];
    for (const [stderr, byMode] of rows) {
      const result = rustAdapter.runRustHook({
        binary: nativeFixture(
          dir,
          `process.stderr.write(${JSON.stringify(`${stderr}\n`)}); process.exit(1);`,
        ),
        script,
        input: "",
        args: ["codex", "capture-start"],
      });
      if (stderr.startsWith("navori-rust: hook deferred: ")) {
        expect(result).toMatchObject({ available: false });
        expect(!result.available && result.modeDeferred === true).toBe(byMode);
      } else {
        expect(result).toMatchObject({ available: true, status: 1 });
      }
    }
  });

  // Covers: R11, R12
  it("treats defer, forced missing implementation and process failures as unavailable", () => {
    const dir = tmp();
    const script = join(dir, ".claude", "hooks", "fixture.sh");
    for (const source of [
      "process.stdout.write('discard partial'); process.exit(3);",
      "process.stderr.write('navori-rust: hook deferred: hook has no compiled implementation\\n'); process.exit(1);",
      "process.kill(process.pid, 'SIGTERM');",
      "process.exit(101);",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ]) {
      const result = rustAdapter.runRustHook({
        binary: nativeFixture(dir, source),
        script,
        input: "payload",
        timeoutMs: 250,
      });
      expect(result).toMatchObject({ available: false });
      expect(result).not.toHaveProperty("stdout");
    }
    expect(
      rustAdapter.runRustHook({ binary: join(dir, "missing"), script, input: "" }),
    ).toMatchObject({
      available: false,
    });
    const denied = nativeFixture(dir, "process.exit(0);");
    chmodSync(denied, 0o644);
    expect(rustAdapter.runRustHook({ binary: denied, script, input: "" })).toMatchObject({
      available: false,
    });
    expect(
      rustAdapter.runRustHook({
        binary: process.execPath,
        script,
        input: "",
        cwd: join(dir, "missing"),
      }),
    ).toMatchObject({
      available: false,
      reason: "native process error: ENOENT",
    });
  });

  // Covers: R11
  it("requires a registered supported hook mode and an existing prepared script", () => {
    const dir = tmp();
    const manifestPath = join(dir, "ported.json");
    const prepare = (): ReturnType<RustAdapter["prepareRustReplay"]> =>
      rustAdapter.prepareRustReplay({ manifestPath, binary: process.execPath, scriptsRoot: dir });
    writeFileSync(manifestPath, JSON.stringify({ schema: 2, hooks: {} }));
    expect(prepare).toThrow("hook registry is empty");
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 2, hooks: { fixture: { mode: "unknown" } } }),
    );
    expect(() => prepare().resolveHook("fixture.sh", "claude")).toThrow("unsupported hook mode");
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 2, hooks: { fixture: { mode: "active" } } }),
    );
    expect(() => prepare().resolveHook("other.sh", "claude")).toThrow("not registered");
    expect(() =>
      rustAdapter
        .prepareRustReplay({ manifestPath, binary: process.execPath })
        .resolveHook("fixture.sh", "claude"),
    ).toThrow("prepared scripts are missing");
    expect(() => prepare().resolveHook("fixture.sh", "claude")).toThrow();
    // No signature or implementation is manufactured by the replay. Runtime validation is still required.
    mkdirp(join(dir, ".claude", "hooks"));
    const script = join(dir, ".claude", "hooks", "fixture.sh");
    writeFileSync(script, "transport fixture only");
    expect(prepare().resolveHook("fixture.sh", "claude")).toBe(script);
  });

  // Covers: R11, R12
  it("runs a shadow descriptor only through forced native argv and rejects an old deferring binary", () => {
    const dir = tmp();
    const binary = nativeFixture(
      dir,
      `
const args = process.argv.slice(2);
if (process.env.NAVORI_HOOK_IMPL !== 'rust' || args.length !== 3 || args[0] !== 'hook' || args[1] !== '--via-script') process.exit(101);
process.stdout.write(JSON.stringify({ args, impl: process.env.NAVORI_HOOK_IMPL }));
process.exit(1);`,
    );
    const script = join(dir, ".claude", "hooks", "fixture.sh");
    mkdirp(dirname(script));
    writeFileSync(script, "transport fixture only; no real handler parity");
    const manifestPath = join(dir, "ported.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 2, hooks: { fixture: { mode: "shadow" } } }),
    );
    const prepared = rustAdapter.prepareRustReplay({ manifestPath, binary, scriptsRoot: dir });
    const resolved = prepared.resolveHook("fixture.sh", "claude");
    const options = {
      binary: prepared.binary,
      script: resolved,
      input: "payload",
      env: { NAVORI_HOOK_IMPL: "shell" },
    };
    const result = rustAdapter.runRustHook(options);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.reason);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
      args: ["hook", "--via-script", script],
      impl: "rust",
    });
    for (const source of [
      "process.stdout.write('automatic shell verdict'); process.exit(3);",
      "process.stderr.write('navori-rust: hook deferred: shadow execution is unavailable\\n'); process.exit(1);",
    ]) {
      writeFileSync(binary, `#!${process.execPath}\n${source}\n`);
      expect(rustAdapter.runRustHook(options)).toMatchObject({
        available: false,
        reason: expect.stringContaining("deferred"),
      });
      expect(rustAdapter.runRustHook(options)).not.toHaveProperty("stdout");
    }
  });

  // Covers: R11, R12
  it("pins relative harness paths and PATH binaries before entering a restricted case", () => {
    const dir = tmp();
    const binary = nativeFixture(dir, "process.stdout.write(process.argv[4]);");
    const script = join(dir, ".codex", "hooks", "fixture.sh");
    mkdirp(dirname(script));
    writeFileSync(script, "transport fixture only");
    const manifestPath = join(dir, "ported.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 2, hooks: { fixture: { mode: "active" } } }),
    );
    const prepared = rustAdapter.prepareRustReplay({
      manifestPath,
      binary: relative(process.cwd(), binary),
      scriptsRoot: relative(process.cwd(), dir),
    });
    const pinnedScript = prepared.resolveHook("fixture.sh", "codex");
    expect(prepared.binary).toBe(realpathSync(binary));
    expect(pinnedScript).toBe(script);
    const elsewhere = tmp();
    expect(
      rustAdapter.runRustHook({
        binary: prepared.binary,
        script: pinnedScript,
        input: "",
        cwd: elsewhere,
        env: { PATH: "" },
      }),
    ).toMatchObject({
      available: true,
      status: 0,
      stdout: Buffer.from(script),
    });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      const pathBinary = rustAdapter.prepareRustReplay({
        manifestPath,
        binary: basename(binary),
        scriptsRoot: dir,
      });
      expect(pathBinary.binary).toBe(realpathSync(binary));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

/**
 * Spec 0059 D35: the verdict classes each session hook must have in the committed corpus, per
 * engine and registered mode, before it enters shadow. A class is the audit verdicts of the active
 * run (`verdict` or `verdict:reason`, joined by `>`), or, for the advisory hooks whose verdict is
 * always `skip`, whether stdout carries a notice.
 */
const SESSION_HOOK_CLASSES: { hook: string; engine: string; mode: string; classes: string[] }[] = [
  ...["claude", "codex", "pi"].map((engine) => ({
    hook: "quality-gate-pre-commit.sh",
    engine,
    mode: "",
    classes: [
      "skip",
      "gate-started>allow",
      "gate-started>block",
      "block",
      ...(engine === "codex" ? [] : ["ask"]),
    ],
  })),
  {
    hook: "plan-gate.sh",
    engine: "claude",
    mode: "",
    classes: [
      "allow",
      "block:plan-denied",
      "ask:subcommand-unavailable",
      "ask:binary-missing",
      "block:binary-missing",
    ],
  },
  {
    hook: "plan-gate.sh",
    engine: "codex",
    mode: "",
    classes: ["allow", "block:plan-denied", "block:subcommand-unavailable", "block:binary-missing"],
  },
  { hook: "subagent-stop-handoff.sh", engine: "codex", mode: "codex", classes: ["clean", "dirty"] },
  ...["claude-session-start", "claude-post-model-switch"].map((mode) => ({
    hook: "model-advisor.sh",
    engine: "claude",
    mode,
    classes: ["silent"],
  })),
  {
    hook: "model-advisor.sh",
    engine: "claude",
    mode: "claude-stop",
    classes: ["notice", "silent"],
  },
  {
    hook: "model-advisor.sh",
    engine: "codex",
    mode: "codex-session-start",
    classes: ["notice", "silent"],
  },
];

describe("hook verdict corpus", () => {
  // Covers: R54
  it("cada hook de sesi\u00f3n cubre cada clase de veredicto y modo por engine", () => {
    const corpus = replay.readCorpus();
    const classOf = (c: (typeof corpus)[number]): string => {
      if (c.hook === "model-advisor.sh")
        return c.expected.off.stdout.includes('"systemMessage"') ? "notice" : "silent";
      return c.expected.active.event
        .map(({ metadata = {} }) => {
          const reason = metadata.reason;
          return typeof reason === "string" && reason !== "unspecified" && reason !== ""
            ? `${String(metadata.verdict)}:${reason}`
            : String(metadata.verdict);
        })
        .join(">");
    };
    const missing = SESSION_HOOK_CLASSES.flatMap(({ hook, engine, mode, classes }) => {
      const seen = new Set(
        corpus
          .filter((c) => c.hook === hook && c.engine === engine && (c.args?.[0] ?? "") === mode)
          .map(classOf),
      );
      return classes
        .filter((cls) => !seen.has(cls))
        .map((cls) => `${hook} ${engine} ${mode || "-"}: ${cls}`);
    });
    expect(missing).toEqual([]);
  });

  // Covers: R13
  it("replays recorded CLI and Node paths without exposing tools to restricted cases", async () => {
    const dir = tmp();
    const hookPath = join(dir, "path.sh");
    writeFileSync(
      hookPath,
      [
        'if command -v navori >/dev/null; then navori; else printf "no-cli\\n"; fi',
        "if command -v node >/dev/null; then node -p 'JSON.stringify({portable:true})'; else printf \"no-node\\n\"; fi",
      ].join("\n"),
    );
    const shim = join(dir, "shim");
    mkdirp(shim);
    for (const name of ["navori", "node"]) {
      const path = join(shim, name);
      writeFileSync(path, `#!/bin/sh\nprintf '${name}-shim\\n'\n`);
      chmodSync(path, 0o755);
    }
    const recordedNode = "/unavailable-host/.nvm/versions/node/v24.0.0/bin";
    const recordedTools = `@REPO@/packages/cli/node_modules/.bin:${recordedNode}`;
    const rows = [
      [recordedTools, 'local-cli\n{"portable":true}\n'],
      [`${shim}:${recordedTools}`, "navori-shim\nnode-shim\n"],
      [recordedNode, 'no-cli\n{"portable":true}\n'],
      ["@CWD@/empty", "no-cli\nno-node\n"],
      ["", "no-cli\nno-node\n"],
    ] as const;
    const corpus = rows.map(([PATH, stdout]) => ({
      ...base(""),
      envDelta: { PATH },
      expected: { off: { status: 0, stdout, stderr: "" } },
    }));
    const result = await replay.replayCorpus({
      corpus,
      modes: ["off"],
      deps: {
        runHookBatch,
        resolveHook: (_hook, _engine, scratch) => {
          // Replace only the scratch symlink: the test exercises resolution without a CLI build.
          const localCli = join(scratch.bin, "navori");
          if (existsSync(localCli)) unlinkSync(localCli);
          writeFileSync(localCli, "#!/bin/sh\nprintf 'local-cli\\n'\n");
          chmodSync(localCli, 0o755);
          return hookPath;
        },
      },
    });
    expect(result).toEqual({ ok: true, cases: rows.length });
  });

  // Covers: R13
  it("el replay falla en el primer caso cuyo exit, stdout o stderr difiere", async () => {
    const dir = tmp();
    const hookPath = join(dir, "fake.sh");
    writeFileSync(hookPath, FAKE_HOOK);
    chmodSync(hookPath, 0o755);
    const deps = { runHookBatch, resolveHook: () => hookPath };
    const off = (stdout: string, status = 0, stderr = ""): Verdict => ({ status, stdout, stderr });
    const event = [{ v: 1, host: "claude", metadata: { ms: "<int>=0", tsMs: "<int13>" } }];
    const active = (v: Verdict, e: unknown = event): Verdict & { event: unknown } => ({
      ...v,
      event: e,
    });
    const corpus = [
      {
        ...base('{"a":1}'),
        expected: {
          off: off('out:{"a":1}'),
          active: active(off('out:{"a":1,"session_id":"corpus-active"}')),
        },
      },
      {
        ...base("go fail"),
        expected: {
          off: off("out:go fail", 2, "failed\n"),
          active: active(off("out:go fail", 2, "failed\n"), []),
        },
      },
      {
        ...base("third"),
        expected: { off: off("out:third"), active: active(off("out:third"), []) },
      },
      {
        ...base("fourth"),
        expected: { off: off("out:fourth"), active: active(off("out:fourth"), []) },
      },
    ];
    const ok = await replay.replayCorpus({ corpus, deps });
    expect(ok).toEqual({ ok: true, cases: 4 });

    // Third and fourth both differ: the replay reports the FIRST one, naming field and case.
    const wrong = structuredClone(corpus);
    (wrong[2]!.expected.off as Verdict).stdout = "out:changed";
    (wrong[3]!.expected.off as Verdict).status = 9;
    const failed = await replay.replayCorpus({ corpus: wrong, modes: ["off"], deps });
    expect(failed.ok).toBe(false);
    expect(failed.failure).toContain("case 3/4");
    expect(failed.failure).toContain("differs in stdout");
    expect(failed.failure).not.toContain("case 4/4");

    // Exit code and stderr count as much as stdout.
    const status = structuredClone(corpus);
    (status[1]!.expected.off as Verdict).status = 0;
    expect((await replay.replayCorpus({ corpus: status, modes: ["off"], deps })).failure).toContain(
      "differs in status",
    );
    const stderr = structuredClone(corpus);
    (stderr[1]!.expected.off as Verdict).stderr = "";
    expect((await replay.replayCorpus({ corpus: stderr, modes: ["off"], deps })).failure).toContain(
      "differs in stderr",
    );

    // The audit event of the active mode is part of the verdict (format, not the clock).
    const format = structuredClone(corpus);
    (
      (format[0]!.expected.active as { event: unknown[] }).event[0] as {
        metadata: { tsMs: string };
      }
    ).metadata.tsMs = "<int12>";
    const eventDiff = await replay.replayCorpus({ corpus: format, modes: ["active"], deps });
    expect(eventDiff.failure).toContain("audit active");
    expect(eventDiff.failure).toContain("differs in event");
  });

  // Covers: R13
  it("la captura vive en los helpers del hook y respeta las reglas de D2", () => {
    const dir = tmp();
    const raw = join(dir, "raw");
    const hook = installCoreHook(dir, "general-purpose-confirm.sh");
    process.env.NAVORI_HOOK_CORPUS = raw;

    // runHookBatch records every case and runHookIsolated its own, before any spawn.
    const payload = JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "scout" } });
    runHookBatch(hook, "bash", [{ input: payload }, { input: payload, env: { PROBE: "1" } }]);
    runHookIsolated(hook, "bash", { input: payload });
    const lines = rawLines(raw);
    expect(lines).toHaveLength(3);
    expect(
      lines.every((l) => l.hook === "general-purpose-confirm.sh" && l.engine === "claude"),
    ).toBe(true);
    expect(lines.every((l) => l.status === "included" && l.cwdKind === "repo")).toBe(true);
    expect(lines.map((l) => l.envDelta)).toEqual([{}, { PROBE: "1" }, {}]);

    // Engine comes from the path the hook ran at.
    mkdirp(join(dir, ".codex", "hooks"));
    const codex = installCoreHook(join(dir, ".codex", "hooks"), "general-purpose-confirm.sh");
    recordHookCase(codex, "zsh", { input: payload });
    expect(rawLines(raw).at(-1)).toMatchObject({ engine: "codex", shell: "zsh" });

    // A copy that is not that asset (a fixture sharing the name) is not recorded.
    const fixture = join(dir, "fixture", "general-purpose-confirm.sh");
    mkdirp(dirname(fixture));
    writeFileSync(fixture, "#!/usr/bin/env bash\nexit 0\n");
    recordHookCase(fixture, "bash", { input: payload });
    expect(rawLines(raw)).toHaveLength(4);

    // Exclusions are recorded (they feed the coverage denominator) with their reason; a test's own
    // audit root is dropped (the replay mode owns it) and a temp cwd becomes a token.
    const before = rawLines(raw).length;
    recordHookCase(hook, "bash", {
      input: payload,
      env: { NAVORI_AUDITS_ROOT: "/x", NAVORI_AUDIT_HOST: "codex" },
    });
    recordHookCase(hook, "bash", { input: payload, cwd: "/etc" });
    const namedCwd = mkdtempSync(join(tmpdir(), "navori-replay-cwd-"));
    dirs.push(namedCwd);
    const named = JSON.stringify({ cwd: namedCwd, tool_name: "Agent" });
    recordHookCase(hook, "bash", {
      input: named,
      cwd: namedCwd,
      env: { CLAUDE_PROJECT_DIR: namedCwd },
    });
    recordHookCase(hook, "bash", { input: payload, cwd: namedCwd });
    const added = rawLines(raw).slice(before);
    expect(added.map((l) => [l.status, l.reason ?? l.cwdKind])).toEqual([
      ["included", "repo"],
      ["excluded", "cwd-outside-checkout"],
      ["included", "none"],
      ["included", "none"],
    ]);
    expect(added[0]?.envDelta).toEqual({ NAVORI_AUDIT_HOST: "codex" });
    expect(added[2]?.envDelta).toEqual({ CLAUDE_PROJECT_DIR: "@CWD@" });
    expect(added[2]?.input).toBe('{"cwd":"@CWD@","tool_name":"Agent"}');

    // Covers: R54 — a state dir outside the case's temp cwd outlives the run: excluded.
    const pad = (scratchpad: string) => JSON.stringify({ scratchpad_dir: scratchpad });
    recordHookCase(hook, "bash", { input: pad(`${namedCwd}/pad`), cwd: namedCwd });
    recordHookCase(hook, "bash", { input: pad(join(dir, "pad")), cwd: namedCwd });
    recordHookCase(hook, "bash", { input: pad(join(dir, "pad")) });
    expect(
      rawLines(raw)
        .slice(before + 4)
        .map((l) => [l.status, l.reason ?? l.cwdKind]),
    ).toEqual([
      ["included", "none"],
      ["excluded", "state-outside-cwd"],
      ["excluded", "state-outside-cwd"],
    ]);

    // Without the variable nothing is written.
    delete process.env.NAVORI_HOOK_CORPUS;
    runHookIsolated(hook, "bash", { input: payload });
    expect(rawLines(raw)).toHaveLength(before + 7);
  });

  // Covers: R13
  it("el corpus se normaliza, se deduplica y publica su cobertura por hook", () => {
    // Checkout and the random tail of a temp dir never reach a case.
    const tmpRoot = tmpdir();
    expect(normalizeCorpusText(`${tmpRoot}/navori-gp-AbC123/.claude`)).toBe(
      "@TMP@/navori-gp-@R@/.claude",
    );
    expect(normalizeCorpusText(`${tmpRoot}/navori-gp-ZzZ999/.claude`)).toBe(
      "@TMP@/navori-gp-@R@/.claude",
    );

    const line = (
      hook: string,
      input: string,
      status: "included" | "excluded",
      reason?: string,
    ) => ({
      ...base(input),
      hook,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    const { cases, observed } = replay.mergeRaw([
      line("a.sh", "1", "included"),
      line("a.sh", "1", "included"), // same invocation seen by the helper and by the wrapper
      line("a.sh", "2", "included"),
      line("a.sh", "3", "excluded", "temp-cwd-named"),
      line("b.sh", "1", "excluded", "audit-env"),
    ]);
    expect(cases.map((c) => [c.hook, c.input])).toEqual([
      ["a.sh", "1"],
      ["a.sh", "2"],
    ]);
    expect(observed["a.sh"]).toEqual({
      observed: 3,
      included: 2,
      excluded: { "temp-cwd-named": 1 },
    });
    expect(replay.coverageRows(cases, observed)).toEqual([
      { hook: "a.sh", cases: 2, observed: 3, pct: 66.7 },
      { hook: "b.sh", cases: 0, observed: 1, pct: 0 },
    ]);
    expect(replay.caseKey(base("x"))).not.toBe(replay.caseKey({ ...base("x"), shell: "zsh" }));

    // The audit event keeps its shape; only the clock and the duration are masked.
    expect(
      replay.normalizeEvent({ v: 1, metadata: { name: "x", ms: 12, tsMs: 1756000000123 } }),
    ).toEqual({ v: 1, metadata: { name: "x", ms: "<int>=0", tsMs: "<int13>" } });
    expect(
      (replay.normalizeEvent({ metadata: { ms: -1, tsMs: 17560 } }) as { metadata: unknown })
        .metadata,
    ).toEqual({ ms: -1, tsMs: 17560 });

    // A payload without a session gets the fixed one in active mode; a valid one is untouched.
    expect(JSON.parse(replay.withActiveSession('{"a":1}'))).toEqual({
      a: 1,
      session_id: "corpus-active",
    });
    expect(replay.withActiveSession('{"session_id":"s-1"}')).toBe('{"session_id":"s-1"}');
    expect(replay.withActiveSession("not json")).toBe("not json");
    expect(
      replay.firstDifference(
        { status: 0, stdout: "a", stderr: "" },
        { status: 0, stdout: "a", stderr: "" },
      ),
    ).toBeNull();
  });

  // Covers: R54
  it("los argumentos del hook viajan de la captura al replay shell y nativo", () => {
    const dir = tmp();
    const raw = join(dir, "raw");
    const hook = installCoreHook(dir, "general-purpose-confirm.sh");
    const payload = JSON.stringify({ tool_name: "Agent" });
    process.env.NAVORI_HOOK_CORPUS = raw;
    // A direct spawn with a mode is recorded with it; without one the line has no `args` key, so
    // every corpus recorded before modes keeps its exact bytes.
    recordSpawnedHook("bash", [[hook, "claude-stop"], { input: payload }]);
    recordSpawnedHook("bash", [[hook], { input: payload }]);
    recordSpawnedHook("bash", [[hook, 3], { input: payload }]);
    runHookBatch(hook, "bash", [{ input: payload, args: ["codex", "capture-start"] }]);
    delete process.env.NAVORI_HOOK_CORPUS;
    const lines = rawLines(raw);
    expect(lines.map((l) => l.args)).toEqual([
      ["claude-stop"],
      undefined,
      ["codex", "capture-start"],
    ]);
    expect(Object.keys(lines[1] ?? {})).not.toContain("args");

    // Arguments make distinct cases; an argument-less key is the one recorded before T5.
    const { cases } = replay.mergeRaw(lines);
    expect(cases).toHaveLength(3);
    const plain = base("x");
    expect(replay.caseKey(plain)).toBe(
      JSON.stringify([plain.hook, plain.engine, plain.shell, plain.cwdKind, "x", []]),
    );
    expect(replay.caseKey({ ...plain, args: [] })).toBe(replay.caseKey(plain));

    // The batch and the isolated spawn hand the hook the same `$@` (quoting kept).
    const echo = join(dir, "fixture", "echo.sh");
    mkdirp(dirname(echo));
    writeFileSync(echo, `printf '[%s]' "$@"\n`);
    const args = ["codex", "two words", "it's"];
    const [batched, none] = runHookBatch(echo, "bash", [{ input: "", args }, { input: "" }]);
    expect(batched?.stdout).toBe("[codex][two words][it's]");
    expect(none?.stdout).toBe("[]");
    expect(runHookIsolated(echo, "bash", { input: "", args }).stdout).toBe(batched?.stdout);

    // The native transport passes them after the script, as the rendered prologue passes `"$@"`.
    const binary = nativeFixture(
      dir,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    const script = join(dir, ".claude", "hooks", "fixture.sh");
    const native = rustAdapter.runRustHook({ binary, script, input: "", args: ["claude-stop"] });
    if (!native.available) throw new Error(native.reason);
    expect(JSON.parse(native.stdout.toString("utf8")) as unknown).toEqual([
      "hook",
      "--via-script",
      script,
      "claude-stop",
    ]);
  });

  // Covers: R54
  it("el estado declarado del caso se recrea en el replay", () => {
    const dir = tmp();
    const raw = join(dir, "raw");
    const cwd = mkdtempSync(join(tmpdir(), "navori-fixture-cwd-"));
    dirs.push(cwd);
    // A hook that reads declared state and runs a declared tool stub from the case's PATH.
    const hook = join(dir, ".claude", "hooks", "fixture.sh");
    mkdirp(dirname(hook));
    writeFileSync(hook, 'cat state/flag\nprintf "|"\nnavori --version\n');
    const fixture = [
      { path: "state/flag", content: `at ${cwd}\n` },
      { path: "bin/navori", content: "#!/bin/sh\necho stub-9.9.9\n", mode: 0o755 },
    ];
    const c = { input: "{}", cwd, env: { PATH: `${cwd}/bin:/usr/bin:/bin` }, fixture };
    const expected = `at ${cwd}\n|stub-9.9.9\n`;
    expect(runHookBatch(hook, "bash", [c])[0]?.stdout).toBe(expected);
    expect(runHookIsolated(hook, "bash", c).stdout).toBe(expected);

    // Recorded with the cwd as a token, then replayed in a fresh empty cwd that never saw it.
    process.env.NAVORI_HOOK_CORPUS = raw;
    const core = installCoreHook(dir, "general-purpose-confirm.sh");
    recordHookCase(core, "bash", c);
    delete process.env.NAVORI_HOOK_CORPUS;
    const [line] = rawLines(raw);
    expect(line?.fixture).toEqual([
      { path: "state/flag", content: "at @CWD@\n" },
      { path: "bin/navori", content: "#!/bin/sh\necho stub-9.9.9\n", mode: 0o755 },
    ]);
    expect(line?.envDelta).toEqual({ PATH: "@CWD@/bin:/usr/bin:/bin" });
    const [merged] = replay.mergeRaw(line === undefined ? [] : [line]).cases;
    if (merged === undefined) throw new Error("no case");
    expect(replay.caseKey(merged)).not.toBe(replay.caseKey({ ...merged, fixture: undefined }));
    const scratch = replay.createScratch();
    try {
      const [out] = replay.runMode([merged], "off", {
        resolveHook: () => hook,
        runHookBatch,
        scratch,
      });
      expect(out?.stdout).toBe("at @CASE@/none\n|stub-9.9.9\n");
    } finally {
      scratch.cleanup();
    }

    // A fixture never lands outside a temp cwd, nor escapes it, nor races another lane.
    expect(() => runHookIsolated(hook, "bash", { ...c, cwd: process.cwd() })).toThrow(
      /not under the temp dir/,
    );
    expect(() =>
      runHookIsolated(hook, "bash", { ...c, fixture: [{ path: "../x", content: "" }] }),
    ).toThrow(/stay under the case cwd/);
    expect(() =>
      runHookBatch(hook, "bash", [c, { ...c, fixture: [{ path: "other", content: "" }] }]),
    ).toThrow(/different fixtures/);
  });

  // Covers: R13
  it("ignora solo el número de línea de los diagnósticos del shell", () => {
    const base = { status: 2, stdout: "" };
    const bash = (n: number, msg = "command not found") => ({
      ...base,
      stderr: `/x/h.sh: line ${n}: {{p}}: ${msg}\n`,
    });
    const zsh = (n: number) => ({ ...base, stderr: `/x/h.sh:${n}: {{p}}: command not found\n` });
    expect(replay.firstDifference(bash(485), bash(540))).toBeNull();
    expect(replay.firstDifference(zsh(485), zsh(540))).toBeNull();
    expect(replay.firstDifference(bash(485), bash(540, "other message"))).toMatchObject({
      field: "stderr",
    });
  });

  // Covers: R13
  it("conserva diferencias de stdout, status y evento aunque sólo cambie una línea del stderr", () => {
    const expected = { status: 2, stdout: "/x/h.sh: line 485: output\n", stderr: "" };
    const stdout = "/x/h.sh: line 540: output\n";
    expect(replay.firstDifference(expected, { ...expected, stdout })).toMatchObject({
      field: "stdout",
    });
    const zsh = { ...expected, stdout: "/x/h.sh:485: output\n" };
    expect(replay.firstDifference(zsh, { ...zsh, stdout: "/x/h.sh:540: output\n" })).toMatchObject({
      field: "stdout",
    });
    const base = { ...expected, stderr: "/x/h.sh: line 485: command not found\n" };
    const actual = { ...base, stderr: "/x/h.sh: line 540: command not found\n" };
    expect(replay.firstDifference(base, { ...actual, status: 1 })).toMatchObject({
      field: "status",
    });
    expect(
      replay.firstDifference(
        { ...base, event: { verdict: "allow" } },
        { ...actual, event: { verdict: "deny" } },
      ),
    ).toMatchObject({ field: "event" });
  });
});
