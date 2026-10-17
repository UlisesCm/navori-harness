import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { runHookBatch, runHookIsolated } from "./helpers/hook-batch.ts";
import { normalizeCorpusText, recordHookCase, type RawCorpusLine } from "./helpers/hook-corpus.ts";

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
}
interface Verdict {
  status: number;
  stdout: string;
  stderr: string;
}
interface Replay {
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
    deps: { runHookBatch: typeof runHookBatch; resolveHook: (hook: string) => string };
  }) => Promise<{ ok: boolean; cases: number; failure?: string }>;
  withActiveSession: (input: string) => string;
}

const here = dirname(fileURLToPath(import.meta.url));
const replay = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "hook-verdict-replay.mjs"))
    .href
)) as Replay;

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

describe("hook verdict corpus", () => {
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

    // Without the variable nothing is written.
    delete process.env.NAVORI_HOOK_CORPUS;
    runHookIsolated(hook, "bash", { input: payload });
    expect(rawLines(raw)).toHaveLength(before + 4);
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
