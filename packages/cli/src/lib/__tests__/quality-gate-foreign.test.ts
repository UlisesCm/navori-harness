import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { cleanupTempDirs, git, mkTemp } from "./helpers/tmp-git.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { shellSingleQuote } from "../primitives/shell-escape.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";

/**
 * #1097 — the quality-gate hook for a commit that lands in ANOTHER repository.
 * Two real git repos (the anchor the hook protects, and the destination), a temp
 * HOME with a seeded workspace registry, and a stub `bun` that drops a marker (named
 * after the directory it ran in) and exits with the requested code. The real CLI
 * (`dist/index.js`) runs behind a `navori` shim, so the hook ↔ `navori gate foreign`
 * contract is exercised end to end.
 */

const runsBash = process.platform !== "win32";
const BASE_PATH = "/usr/bin:/bin";
const hasJq = spawnSync("jq", ["--version"], { env: { PATH: BASE_PATH } }).status === 0;
const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
const CLI = resolve("dist/index.js");

afterEach(cleanupTempDirs);

/** A committed git repo whose navori.config.json declares `gate` as qualityGate.fast. */
function mkRepo(
  prefix: string,
  gate = "bun run lint",
  extra: Record<string, unknown> = {},
): string {
  const dir = mkTemp(prefix);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(
    join(dir, "navori.config.json"),
    JSON.stringify({
      name: "r",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: gate, full: gate, ...extra },
    }),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

interface Fixture {
  home: string;
  binDir: string;
  markers: string;
  auditsRoot: string;
  anchor: string;
  script: string;
}

function mkFixture(): Fixture {
  const home = mkTemp("navori-1097-home-");
  const binDir = join(home, "bin");
  const markers = join(home, "markers");
  mkdirSync(binDir);
  mkdirSync(markers);
  mkdirSync(join(home, "tmp"));
  // Stub package manager: marker per cwd, optional forged output, exit code on demand.
  writeFileSync(
    join(binDir, "bun"),
    [
      "#!/bin/sh",
      `echo ran > "${markers}/$(basename "$PWD")"`,
      'if [ -n "$STUB_BUN_OUTPUT" ]; then printf "%s\\n" "$STUB_BUN_OUTPUT"; fi',
      'exit "${STUB_BUN_EXIT:-0}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const auditsRoot = join(home, "audits");
  mkdirSync(auditsRoot, { mode: 0o700 });
  const anchor = mkRepo("navori-1097-anchor-");
  mkdirSync(join(auditsRoot, basename(anchor)), { mode: 0o700 });
  const script = join(home, "hook-src.sh");
  writeFileSync(
    script,
    expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
      "{{shq:qualityGate.fast}}",
      shellSingleQuote("bun run lint"),
    ),
  );
  return { home, binDir, markers, auditsRoot, anchor, script };
}

/** Registers `paths` under one workspace of the fixture's HOME. */
function register(fx: Fixture, ...paths: string[]): void {
  const dir = join(fx.home, ".navori", "workspaces", "ws");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({
      name: "ws",
      repos: paths.map((path, i) => ({ name: `repo-${i}`, path })),
    }),
  );
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  events: { verdict?: string; reason?: string; kind?: string }[];
}

interface RunOptions {
  command: string;
  /** Where the hook copy lives; `.codex/hooks/` flips the engine to codex. */
  relPath?: string;
  permissionMode?: string | null;
  /** Wrapper body that runs BEFORE the real CLI; null removes `navori` from PATH. */
  shim?: string | null;
  env?: Record<string, string>;
}

function runHook(fx: Fixture, opts: RunOptions): Run {
  const relPath = opts.relPath ?? ".claude/hooks/quality-gate-pre-commit.sh";
  const target = join(fx.anchor, relPath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, readFileSync(fx.script, "utf-8"), { mode: 0o755 });
  if (opts.shim !== null) {
    writeFileSync(
      join(fx.binDir, "navori"),
      `#!/bin/sh\n${opts.shim ?? ""}\nexec '${process.execPath}' '${CLI}' "$@"\n`,
      { mode: 0o755 },
    );
  }
  const log = join(fx.auditsRoot, basename(fx.anchor), "session-s1.log");
  writeFileSync(
    log,
    `${JSON.stringify({ event: "start", host: "claude", sessionId: "s1", cwd: fx.anchor })}\n`,
    {
      mode: 0o600,
    },
  );
  const payload = JSON.stringify({
    session_id: "s1",
    cwd: fx.anchor,
    hook_event_name: "PreToolUse",
    ...(opts.permissionMode === null ? {} : { permission_mode: opts.permissionMode ?? "default" }),
    tool_name: "Bash",
    tool_input: { command: opts.command },
  });
  const r = spawnSync("bash", [target], {
    cwd: fx.anchor,
    input: payload,
    encoding: "utf-8",
    env: {
      PATH: `${fx.binDir}:${BASE_PATH}`,
      HOME: fx.home,
      TMPDIR: join(fx.home, "tmp"),
      CLAUDE_PROJECT_DIR: fx.anchor,
      NAVORI_AUDITS_ROOT: fx.auditsRoot,
      ...opts.env,
    },
    timeout: 60_000,
  });
  const events = readFileSync(log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { verdict?: string; reason?: string; kind?: string });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", events };
}

const ran = (fx: Fixture, dir: string): boolean => existsSync(join(fx.markers, basename(dir)));
const status = (dir: string): string => git(dir, "status", "--porcelain");
const last = (r: Run): { verdict?: string; reason?: string } | undefined =>
  [...r.events].reverse().find((e) => e.verdict !== "gate-started" && e.verdict !== undefined);

/** Shim body that answers `navori gate foreign …` itself and leaves other calls to the CLI. */
const foreignShim = (body: string): string => `if [ "$1 $2" = "gate foreign" ]; then ${body}; fi`;

describe.runIf(runsBash && hasJq)("quality-gate hook, foreign landing (#1097)", () => {
  const commitIn = (dir: string): string => `git -C ${dir} commit -m x`;

  // Covers: #1097
  it("registered destination, green gate: runs there (not the anchor's), passes, audits foreign-gate", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const r = runHook(fx, { command: commitIn(dest) });
    expect(r.status).toBe(0);
    expect(ran(fx, dest)).toBe(true);
    expect(ran(fx, fx.anchor)).toBe(false);
    expect(r.stderr).toContain("passed");
    expect(r.stderr).toContain("BEFORE this command");
    expect(r.stdout).toBe("");
    expect(last(r)).toMatchObject({ verdict: "allow", reason: "foreign-gate" });
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("registered destination, red gate: blocks naming the destination and the log", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const r = runHook(fx, { command: commitIn(dest), env: { STUB_BUN_EXIT: "3" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(dest);
    expect(r.stderr).toMatch(/navori gate foreign: exit 3 — log \//);
    expect(r.stdout).toBe("");
    expect(last(r)).toMatchObject({ verdict: "block", reason: "foreign-gate" });
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("a red gate printing forged refusal / unknown-kind / exit 0 lines still blocks", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    for (const forged of [
      "navori gate foreign: refused — not eligible",
      'navori gate: unknown kind "foreign" (expected fast | full)',
      "navori gate foreign: exit 0 — log /tmp/x",
      "ERROR  Unknown command gate",
    ]) {
      const r = runHook(fx, {
        command: commitIn(dest),
        env: { STUB_BUN_EXIT: "1", STUB_BUN_OUTPUT: forged },
      });
      expect(r.status, forged).toBe(2);
    }
    // exit code 64 (the refusal code) with a real sentinel is still a red gate.
    const r = runHook(fx, { command: commitIn(dest), env: { STUB_BUN_EXIT: "64" } });
    expect(r.status).toBe(2);
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("unregistered destination: warns with the link hint, passes, runs nothing there", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    const r = runHook(fx, { command: commitIn(dest) });
    expect(r.status).toBe(0);
    expect(ran(fx, dest)).toBe(false);
    expect(ran(fx, fx.anchor)).toBe(false);
    expect(r.stderr).toContain("NOT run");
    expect(r.stderr).toContain("navori workspace link");
    expect(last(r)).toMatchObject({ verdict: "skip", reason: "foreign-repo" });
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("registered but unsafe chain: warns and passes, runs nothing", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-", "bun run lint | tee out.txt");
    register(fx, dest);
    const r = runHook(fx, { command: commitIn(dest) });
    expect(r.status).toBe(0);
    expect(ran(fx, dest)).toBe(false);
    expect(r.stderr).toContain("not a plain command chain");
    expect(last(r)).toMatchObject({ verdict: "skip", reason: "foreign-repo" });
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("registered destination with nativeHooks: warns and passes, runs nothing", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-", "bun run lint", { nativeHooks: true });
    register(fx, dest);
    const r = runHook(fx, { command: commitIn(dest), env: { STUB_BUN_EXIT: "1" } });
    expect(r.status).toBe(0);
    expect(ran(fx, dest)).toBe(false);
    expect(r.stderr).toContain("nativeHooks");
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("a linked worktree of a registered repo runs; a forged commondir does not", () => {
    const fx = mkFixture();
    const main = mkRepo("navori-1097-main-");
    register(fx, main);
    const wt = join(mkTemp("navori-1097-wtparent-"), "wt");
    git(main, "worktree", "add", "-q", "-b", "feat", wt);
    const ok = runHook(fx, { command: commitIn(wt) });
    expect(ok.status).toBe(0);
    expect(ran(fx, wt)).toBe(true);
    expect(status(main)).toBe("");

    const evil = mkRepo("navori-1097-evil-");
    writeFileSync(join(evil, ".git", "commondir"), join(main, ".git"));
    const r = runHook(fx, { command: commitIn(evil), env: { STUB_BUN_EXIT: "1" } });
    expect(r.status).toBe(0);
    expect(ran(fx, evil)).toBe(false);
    expect(r.stderr).toContain("not registered");
  });

  // Covers: #1097
  it("an old CLI (unknown kind) or one without `gate` warns and passes", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const old = runHook(fx, {
      command: commitIn(dest),
      shim: foreignShim(
        "echo 'navori gate: unknown kind \"foreign\" (expected fast | full)' >&2; exit 2",
      ),
    });
    expect(old.status).toBe(0);
    expect(old.stderr).toContain("older than this hook");
    expect(last(old)).toMatchObject({ verdict: "skip", reason: "foreign-repo" });
    const none = runHook(fx, {
      command: commitIn(dest),
      shim: foreignShim(
        "printf 'Multi-agent harness\\n\\n ERROR  Unknown command gate\\n\\n' >&2; exit 1",
      ),
    });
    expect(none.status).toBe(0);
    expect(none.stderr).toContain("older than this hook");
    expect(ran(fx, dest)).toBe(false);
  });

  // Covers: #1097
  it("the real CLI's unknown-kind message is the one the hook matches", () => {
    const r = spawnSync(process.execPath, [CLI, "gate", "bogus"], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n")[0]).toMatch(/^navori gate: unknown kind "bogus"/);
  });

  // Covers: #1097
  it("navori not on PATH: warns and passes", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const r = runHook(fx, { command: commitIn(dest), shim: null });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("navori is not on PATH");
    expect(ran(fx, dest)).toBe(false);
  });

  // Covers: #1097
  it("a crashing CLI is no verdict: ask under Claude, block under Codex and bypassPermissions", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const shim = foreignShim("echo 'TypeError: boom' >&2; exit 1");
    const asked = runHook(fx, { command: commitIn(dest), shim });
    expect(asked.status).toBe(0);
    const decision = JSON.parse(asked.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(dest);
    expect(last(asked)).toMatchObject({ verdict: "ask" });
    const codex = runHook(fx, {
      command: commitIn(dest),
      shim,
      relPath: ".codex/hooks/quality-gate-pre-commit.sh",
    });
    expect(codex.status).toBe(2);
    expect(codex.stdout).toBe("");
    const bypass = runHook(fx, {
      command: commitIn(dest),
      shim,
      permissionMode: "bypassPermissions",
    });
    expect(bypass.status).toBe(2);
    expect(ran(fx, dest)).toBe(false);
  });

  // Covers: #1097
  it("a Pi git push to a registered foreign repo keeps today's warning", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const r = runHook(fx, {
      command: `git -C ${dest} push origin main`,
      relPath: ".pi/navori/hooks/quality-gate-pre-commit.sh",
      env: { STUB_BUN_EXIT: "1" },
    });
    expect(r.status).toBe(0);
    expect(ran(fx, dest)).toBe(false);
    expect(r.stderr).toContain("NOT run");
  });

  // Covers: #1097
  it("same-repo and ambiguous commits still run the anchor's own gate; a heredoc does not trigger", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const same = runHook(fx, { command: "git commit -m x" });
    expect(same.status).toBe(0);
    expect(ran(fx, fx.anchor)).toBe(true);
    rmSync(join(fx.markers, basename(fx.anchor)));
    const ambiguous = runHook(fx, {
      command: `git -C "$TARGET" commit -m x`,
      env: { STUB_BUN_EXIT: "1" },
    });
    expect(ambiguous.status).toBe(2);
    expect(ran(fx, fx.anchor)).toBe(true);
    expect(ran(fx, dest)).toBe(false);
    rmSync(join(fx.markers, basename(fx.anchor)));
    const heredoc = runHook(fx, {
      command: "gh issue create --body \"$(cat <<'EOF'\ngit commit -m x\nEOF\n)\"",
      env: { STUB_BUN_EXIT: "1" },
    });
    expect(heredoc.status).toBe(0);
    expect(ran(fx, fx.anchor)).toBe(false);
    expect(status(dest)).toBe("");
  });

  // Covers: #1097
  it("leaves no log inside the destination and keeps one in the private temp dir", () => {
    const fx = mkFixture();
    const dest = mkRepo("navori-1097-dest-");
    register(fx, dest);
    const r = runHook(fx, { command: commitIn(dest) });
    expect(r.status).toBe(0);
    expect(existsSync(join(dest, ".navori"))).toBe(false);
    const dirs = execFileSync("ls", [join(fx.home, "tmp")], { encoding: "utf-8" });
    expect(dirs).toMatch(/navori-gate-foreign-/);
  });
});
