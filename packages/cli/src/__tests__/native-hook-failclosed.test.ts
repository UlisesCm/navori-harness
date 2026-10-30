import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  nativeRunnerShell,
  type NativeEngine,
  type NativeHook,
} from "../lib/render/native-hook.ts";
import { claudeHookCommand } from "../engines/claude/build-settings.ts";
import { codexHookCommand } from "../engines/codex/hook-registrations.ts";
import { renderManagedFile } from "../engines/shared/render-managed-file.ts";
import type { HookExtensionPending } from "../engines/shared/hook-extension.ts";
import { readConfig } from "../lib/config/config.ts";
import { readCliVersion } from "../lib/render/bundled-assets.ts";
import { finalizeNativeHooks } from "../lib/render/native-hook-render.ts";
import { loadNativeHooks } from "../lib/render/native-hook.ts";
import { acrossShells, type HookShell } from "../lib/__tests__/helpers/shells.ts";

const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sensitive = {
  sensitive:
    "native hook POSIX wrapper must preserve stdin, argv, exit status and trailing newlines under bash/zsh",
};
const entry = (gating = true): NativeHook => ({
  mode: "shadow",
  gating,
  blocks: { "example-base": `sha256:${"a".repeat(64)}` },
  deps: {},
  impl: `sha256:${"a".repeat(64)}`,
});

function project(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "native-failclosed-"));
  dirs.push(dir);
  writeFileSync(join(dir, "navori-rust"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "navori-rust"), 0o755);
  return dir;
}

function run(
  shell: HookShell,
  dir: string,
  engine: NativeEngine,
  gating = true,
  forced?: "rust" | "shell",
): { code: number | null; stdout: string; stderr: string } {
  const fragment = nativeRunnerShell({
    engine,
    hook: "example",
    descriptor: entry(gating),
    invocation: '--via-script "$0"',
    args: '"$@"',
  });
  const result = spawnSync(
    shell,
    ["-c", `set -e\n${fragment}\nprintf 'shell:%s' "$(cat)"`, "fixture.sh", "first", "second"],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        NAVORI_HOOK_IMPL: forced ?? "",
      },
      input: "payload",
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const QUALITY_GATE = "quality-gate-pre-commit";
const QUALITY_GATE_TARGETS: Readonly<Record<NativeEngine, string>> = {
  claude: `.claude/hooks/${QUALITY_GATE}.sh`,
  codex: `.codex/hooks/${QUALITY_GATE}.sh`,
  pi: `.pi/navori/hooks/${QUALITY_GATE}.sh`,
};

/**
 * A project where the real `quality-gate-pre-commit` asset is rendered and wrapped by the
 * renderer for every engine, with the shipped manifest descriptor and a fake `navori-rust`.
 */
function qualityGateProject(): { dir: string; descriptor: NativeHook } {
  const descriptor = loadNativeHooks()[QUALITY_GATE];
  if (descriptor === undefined) throw new Error(`${QUALITY_GATE} is not in crates/ported.json`);
  const dir = project("exit 0");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const base = readConfig(
    resolve(
      import.meta.dirname,
      "../../../../scripts/js/rust-oracle/fixtures/fresh-init/navori.config.json",
    ),
  );
  const config = {
    ...base,
    harnessVersion: readCliVersion(),
    qualityGate: { full: "exit 0", ...base.qualityGate, fast: "exit 0" },
  };
  const assetPath = resolve(
    import.meta.dirname,
    `../../../core/core-assets/hooks/${QUALITY_GATE}.sh`,
  );
  for (const engine of ["claude", "codex", "pi"] as const) {
    const target = QUALITY_GATE_TARGETS[engine];
    mkdirSync(join(dir, target, ".."), { recursive: true });
    writeFileSync(
      join(dir, target),
      renderManagedFile({
        assetPath,
        existingContent: null,
        managedId: "qg-pre-commit-base",
        meta: { source: "@navori/core", version: readCliVersion() },
        config,
        engine,
      }).content,
    );
    const pending: HookExtensionPending[] = [];
    const wrapped = finalizeNativeHooks({
      cwd: dir,
      engine,
      config,
      pending,
      hooks: [{ id: QUALITY_GATE, assetPath, managedId: "qg-pre-commit-base" }],
      plugins: [],
      manifest: { [QUALITY_GATE]: descriptor },
    });
    if (!wrapped.has(target) || pending[0] === undefined)
      throw new Error(`${engine}: the renderer did not wrap ${QUALITY_GATE}`);
    writeFileSync(join(dir, target), pending[0].content);
  }
  return { dir, descriptor };
}

/** Runs the command each engine registers for the hook, with a commit payload on stdin. */
function runRegistered(
  shell: HookShell,
  dir: string,
  engine: NativeEngine,
  descriptor: NativeHook,
  closeStdout: boolean,
): { code: number | null; stdout: string } {
  const command = {
    claude: claudeHookCommand("PreToolUse", QUALITY_GATE_TARGETS.claude, undefined, descriptor),
    codex: codexHookCommand({ script: QUALITY_GATE, event: "PreToolUse", timeout: 600 }),
    // The Pi bridge spawns bash on the installed script, with the project as cwd.
    pi: `bash "${QUALITY_GATE_TARGETS.pi}"`,
  }[engine];
  const value = spawnSync(shell, ["-c", `${closeStdout ? "exec 1>&-\n" : ""}${command}`], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      CLAUDE_PROJECT_DIR: dir,
      NAVORI_HOOK_IMPL: "",
    },
    input: JSON.stringify({
      session_id: "failclosed",
      cwd: dir,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "x"' },
    }),
    encoding: "utf8",
    timeout: 10000,
  });
  if (value.error) throw value.error;
  return { code: value.status, stdout: value.stdout };
}

describe("native hook fail-closed wrapper", (): void => {
  // Covers: R50
  it("quality-gate-pre-commit nunca permite ante SIGSEGV, 101 o stdout cerrado", (): void => {
    const { dir, descriptor } = qualityGateProject();
    expect(descriptor).toMatchObject({ mode: "shadow", gating: true });
    const failures = [
      { body: "printf 'partial'; kill -SEGV $$", closeStdout: false },
      { body: "printf 'partial'; exit 101", closeStdout: false },
      { body: "printf 'complete'; exit 0", closeStdout: true },
    ];
    for (const failure of failures) {
      writeFileSync(join(dir, "navori-rust"), `#!/bin/sh\n${failure.body}\n`);
      for (const engine of ["claude", "codex", "pi"] as const) {
        const label = `${engine}: ${failure.body}`;
        const result = acrossShells(
          (shell: HookShell) => runRegistered(shell, dir, engine, descriptor, failure.closeStdout),
          sensitive,
        );
        expect(result.stdout, label).not.toContain("partial");
        if (failure.closeStdout) {
          expect(result.code, label).toBe(2);
        } else if (engine === "claude") {
          expect(result.code, label).toBe(0);
          expect(JSON.parse(result.stdout) as unknown, label).toMatchObject({
            hookSpecificOutput: { permissionDecision: "ask" },
          });
        } else {
          expect(result, label).toEqual({ code: 2, stdout: "" });
        }
      }
    }
  });

  // Covers: R13
  it("argumentos con expansiones shell conservan el comando legacy sin doble evaluación", (): void => {
    for (const args of ['"$HOME"', '"$(cat)"', "first; echo second"]) {
      expect(claudeHookCommand("PreToolUse", ".claude/hooks/example.sh", args, entry())).toBe(
        claudeHookCommand("PreToolUse", ".claude/hooks/example.sh", args),
      );
    }
  });
  // Covers: R12, R13
  it("coincide con el golden de wiring independiente revisado a mano", (): void => {
    const expected = readFileSync(
      resolve(import.meta.dirname, "../../../../crates/navori-hooks/tests/golden/wiring.snap"),
      "utf8",
    );
    const actual =
      (["claude", "codex", "pi"] as const)
        .map(
          (engine: NativeEngine): string =>
            `=== ${engine}-script ===\n${nativeRunnerShell({ engine, hook: "example", descriptor: entry(), invocation: '--via-script "$0"', args: '"$@"' })}`,
        )
        .join("\n\n") +
      `\n\n=== claude-command ===\n${claudeHookCommand("PreToolUse", ".claude/hooks/example.sh", "first", entry())}\n`;
    expect(actual).toBe(expected);
  });

  // Covers: R12, R13
  it("Claude transmite el evento y argv y mantiene Stop advisory", (): void => {
    const dir = project("printf '%s\\n' \"$@\"; exit 0");
    const result = acrossShells((shell: HookShell): string => {
      const command = claudeHookCommand("PreToolUse", ".claude/hooks/example.sh", "first", entry());
      const value = spawnSync(shell, ["-c", command], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          CLAUDE_PROJECT_DIR: dir,
          NAVORI_HOOK_IMPL: "",
        },
        encoding: "utf8",
        timeout: 5000,
      });
      if (value.error) throw value.error;
      return value.stdout;
    }, sensitive);
    expect(result).toBe(
      `hook\n--via-command\nPreToolUse\n${dir}/.claude/hooks/example.sh\n--shadow\nfirst\n`,
    );
    writeFileSync(join(dir, "navori-rust"), "#!/bin/sh\nexit 101\n");
    const stop = acrossShells(
      (shell: HookShell): number | null =>
        spawnSync(
          shell,
          ["-c", claudeHookCommand("Stop", ".claude/hooks/example.sh", undefined, entry())],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH ?? ""}`,
              CLAUDE_PROJECT_DIR: dir,
              NAVORI_HOOK_IMPL: "",
            },
            encoding: "utf8",
            timeout: 5000,
          },
        ).status,
      sensitive,
    );
    expect(stop).toBe(1);
  });
  // Covers: R12
  it("stdout cerrado no termina con permitir, incluso si el hijo respondió 0", (): void => {
    const dir = project("printf 'complete'; exit 0");
    for (const gating of [true, false])
      for (const engine of ["claude", "codex", "pi"] as const) {
        const fragment = nativeRunnerShell({
          engine,
          hook: "example",
          descriptor: entry(gating),
          invocation: '--via-script "$0"',
        });
        const result = acrossShells((shell: HookShell): number | null => {
          const value = spawnSync(shell, ["-c", `exec 1>&-\n${fragment}\nexit 0`], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, NAVORI_HOOK_IMPL: "" },
            encoding: "utf8",
            timeout: 5000,
          });
          if (value.error) throw value.error;
          return value.status;
        }, sensitive);
        expect(result).toBe(gating ? 2 : 1);
      }
  });
  // Covers: R12, R13
  it("3, 126 y 127 descartan stdout nativo y conservan stdin para el shell", (): void => {
    for (const code of [3, 126, 127]) {
      const dir = project(`printf 'discard me'; exit ${code}`);
      const result = acrossShells((shell: HookShell) => run(shell, dir, "codex"), sensitive);
      expect(result).toEqual({ code: 0, stdout: "shell:payload", stderr: "" });
    }
  });

  // Covers: R12
  it("SIGKILL, SIGABRT, SIGSEGV y exit 101 nunca permiten ni publican stdout parcial", (): void => {
    for (const failure of ["kill -KILL $$", "kill -ABRT $$", "kill -SEGV $$", "exit 101"]) {
      const dir = project(`printf 'partial'; ${failure}`);
      for (const engine of ["claude", "codex", "pi"] as const) {
        const result = acrossShells((shell: HookShell) => {
          const value = run(shell, dir, engine);
          return { code: value.code, stdout: value.stdout };
        }, sensitive);
        expect(result.stdout).not.toContain("partial");
        if (engine === "claude") {
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout) as unknown).toMatchObject({
            hookSpecificOutput: { permissionDecision: "ask" },
          });
        } else {
          expect(result.code).toBe(2);
          expect(result.stdout).toBe("");
        }
      }
    }
  });

  // Covers: R12
  it("los hooks advisory fallan con 1 y no fuerzan un bloqueo de Stop", (): void => {
    const dir = project("exit 101");
    for (const engine of ["claude", "codex", "pi"] as const) {
      const result = acrossShells((shell: HookShell) => run(shell, dir, engine, false), sensitive);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("native runtime failed");
    }
  });

  // Covers: R11, R13
  it("preserva stdout con saltos finales, exit code y orden de argumentos shadow", (): void => {
    const dir = project("printf '%s\\n' \"$@\"; printf 'end\\n\\n'; exit 2");
    const result = acrossShells((shell: HookShell) => run(shell, dir, "codex"), sensitive);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("hook\n--via-script\nfixture.sh\n--shadow\nfirst\nsecond\nend\n\n");
  });

  // Covers: R13
  it("shell fuerza respaldo y rust convierte diferimiento en error", (): void => {
    const dir = project("exit 3");
    expect(
      acrossShells((shell: HookShell) => run(shell, dir, "codex", true, "shell"), sensitive).stdout,
    ).toBe("shell:payload");
    const forced = acrossShells(
      (shell: HookShell) => run(shell, dir, "codex", true, "rust"),
      sensitive,
    );
    expect(forced.code).toBe(1);
    expect(forced.stdout).toBe("");
    expect(forced.stderr).toContain("unavailable or deferred");
  });

  // Covers: R12, R13
  it("el brazo Claude usa el mismo fallback y conserva stdin, evento y argumentos", (): void => {
    const dir = project("exit 3");
    mkdirSync(join(dir, ".claude/hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/hooks/example.sh"),
      "#!/bin/sh\nprintf 'shell:%s' \"$(cat)\"\n",
    );
    const command = claudeHookCommand("PreToolUse", ".claude/hooks/example.sh", "first", entry());
    const result = acrossShells((shell: HookShell) => {
      const run = spawnSync(shell, ["-c", command], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          CLAUDE_PROJECT_DIR: dir,
          NAVORI_HOOK_IMPL: "",
        },
        input: "payload",
        encoding: "utf8",
        timeout: 5000,
      });
      if (run.error) throw run.error;
      return { code: run.status, stdout: run.stdout, stderr: run.stderr };
    }, sensitive);
    expect(result).toEqual({ code: 0, stdout: "shell:payload", stderr: "" });
  });
});
