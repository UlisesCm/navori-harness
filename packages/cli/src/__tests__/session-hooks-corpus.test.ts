import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { type FixtureFile, type HookCase, runHookIsolated } from "./helpers/hook-batch.ts";

/**
 * Spec 0059 T5 (R54, D35): one case per verdict class and mode argument, in every engine that
 * registers each session hook, before the hook enters shadow. Each case declares its state
 * (`fixture`) so the corpus replay recreates it, and asserts its class here, so a capture
 * (`NAVORI_HOOK_CORPUS=<dir>`) of this file is the seed of those hooks' corpus.
 *
 * The corpus replays the expanded asset with its templates unrendered: `qualityGate.fast` stays
 * the literal `{{shq:qualityGate.fast}}`, so a stub with that exact name stands in for the
 * project's gate runner.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOOKS = join(REPO_ROOT, "packages", "core", "core-assets", "hooks");
const ENGINE_DIRS = { claude: ".claude/hooks", codex: ".codex/hooks", pi: ".pi/navori/hooks" };
type Engine = keyof typeof ENGINE_DIRS;

/** Case cwds go after each test; installed hooks, shared by a describe's tests, at the end. */
const dirs: string[] = [];
const installed: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const dir of installed.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string, owner = dirs): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owner.push(dir);
  return dir;
}

/** The expanded core asset installed under an engine's hooks directory. */
function install(name: string, engine: Engine): string {
  const target = join(temp("navori-session-hook-", installed), ENGINE_DIRS[engine], name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expandHookIncludes(readFileSync(join(HOOKS, name), "utf8")), {
    mode: 0o755,
  });
  return target;
}

/** An executable stub under the case's `bin/`. */
const stub = (name: string, body: string): FixtureFile => ({
  path: `bin/${name}`,
  content: `#!/bin/sh\n${body}\n`,
  mode: 0o755,
});

/** A case in a fresh temp cwd whose PATH starts at its own `bin/`. */
function inTemp(input: object, fixture: FixtureFile[] = [], args?: string[]): HookCase {
  const cwd = temp("navori-session-case-");
  return {
    input: JSON.stringify(input),
    cwd,
    env: { PATH: `${cwd}/bin:/usr/bin:/bin` },
    fixture,
    ...(args === undefined ? {} : { args }),
  };
}

const GATE = "{{shq:qualityGate.fast}}";
const bash = (command: string, permission = "default") => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  permission_mode: permission,
  session_id: "corpus-session",
  tool_input: { command },
});

describe("quality-gate-pre-commit: every verdict class per engine", () => {
  const hook = "quality-gate-pre-commit.sh";
  const green = stub(GATE, "exit 0");
  const red = stub(GATE, "echo 'lint failed' >&2\nexit 1");
  const cached = stub("navori", '[ "$1 $2 $3" = "gate probe --clean" ] && exit 0\nexit 1');

  for (const engine of ["claude", "codex", "pi"] as const) {
    const path = install(hook, engine);
    const run = (c: HookCase) => runHookIsolated(path, "bash", c);
    const commit = (fixture: FixtureFile[], permission?: string) =>
      run(inTemp(bash("git commit -m x", permission), fixture));

    // Covers: R54
    it(`${engine}: skip, allow, block and the cache hit`, () => {
      expect(run(inTemp(bash("ls -la"))).status).toBe(0);
      const allowed = commit([green]);
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toContain("running quality-gate fast");
      const failed = commit([red]);
      expect(failed.status).toBe(2);
      expect(failed.stderr).toContain("quality-gate fast failed");
      const hit = commit([green, cached]);
      expect(hit.status).toBe(0);
      expect(hit.stderr).toContain("green fast result is cached");
    });

    // Covers: R54
    it(`${engine}: a missing runner asks where the host can, blocks elsewhere`, () => {
      const asked = commit([]);
      const blocked = commit([], "bypassPermissions");
      expect(blocked.status).toBe(2);
      if (engine === "codex") {
        expect(asked.status).toBe(2);
      } else {
        expect(asked.status).toBe(0);
        expect(asked.stdout).toContain('"permissionDecision":"ask"');
      }
    });
  }

  // Covers: R54
  it("pi: a push is gated too, claude and codex let it through", () => {
    for (const engine of ["pi", "claude"] as const) {
      const pushed = runHookIsolated(
        install(hook, engine),
        "bash",
        inTemp(bash("git push origin feature"), [red]),
      );
      expect(pushed.status).toBe(engine === "pi" ? 2 : 0);
    }
  });
});
