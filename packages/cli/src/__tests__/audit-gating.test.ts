import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0055 D4 — the audit decides by the session's own log, with builtins. Hooks are the
 * rendered mirrors (the raw asset is not runnable). `perl` and `date` are PATH shims that log
 * each call; `EPOCHREALTIME` is unset inside the shell so bash 5 (CI) takes the same
 * no-builtin-clock path as macOS bash 3.2 — without that the no-exec assertion would be vacuous.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const PARTIALS = join(REPO_ROOT, "packages/core/core-assets/hooks/_partials");
const SHELLS = ["bash", "zsh"] as const;
const SESSION = "gate-sess";

const HOOKS: { name: string; path: string; event: string; tool: string; extra: object }[] = [
  {
    name: "guard-destructive",
    path: ".claude/hooks/guard-destructive.sh",
    event: "PreToolUse",
    tool: "Bash",
    extra: { tool_input: { command: "git status --short" } },
  },
  {
    name: "routing-watch",
    path: ".claude/hooks/routing-watch.sh",
    event: "PostToolUse",
    tool: "Bash",
    extra: { tool_input: { command: "git status --short" }, tool_response: { stdout: "" } },
  },
  {
    name: "role-guard",
    path: ".codex/hooks/role-guard.sh",
    event: "PreToolUse",
    tool: "apply_patch",
    extra: { tool_input: { command: "*** Begin Patch\n*** End Patch\n" } },
  },
];

let tmp: string;
let audits: string;
let project: string;
let shims: string;
let shimLog: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "navori-gating-"));
  audits = join(tmp, "audits");
  project = join(tmp, "proj");
  shims = join(tmp, "shims");
  shimLog = join(tmp, "shim-calls.log");
  mkdirSync(audits);
  mkdirSync(project);
  mkdirSync(shims);
  for (const bin of ["perl", "date"]) {
    // Count the call, then run the real binary so the clock still works.
    writeFileSync(
      join(shims, bin),
      `#!/bin/sh\necho ${bin} >> "${shimLog}"\nPATH=/usr/bin:/bin exec ${bin} "$@"\n`,
    );
    chmodSync(join(shims, bin), 0o755);
  }
  // Transparent transport: appends every record the hook hands to the CLI.
  writeFileSync(
    join(shims, "navori"),
    `#!/bin/sh\ncat >> "${join(tmp, "events.jsonl")}"\necho >> "${join(tmp, "events.jsonl")}"\n`,
  );
  chmodSync(join(shims, "navori"), 0o755);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function payload(hook: (typeof HOOKS)[number], cwd = project): string {
  return JSON.stringify({
    session_id: SESSION,
    cwd,
    hook_event_name: hook.event,
    tool_name: hook.tool,
    tool_use_id: "toolu_1",
    ...hook.extra,
  });
}

function makeLog(repo: string): void {
  mkdirSync(join(audits, repo), { recursive: true });
  writeFileSync(join(audits, repo, `session-${SESSION}.log`), "");
}

/** Runs a rendered hook with clock-counting shims and no builtin clock in either shell. */
function runHook(shell: string, hook: (typeof HOOKS)[number], input: string, cwd = project): void {
  const res = spawnSync(shell, ["-c", 'unset EPOCHREALTIME; . "$0"', join(REPO_ROOT, hook.path)], {
    input,
    encoding: "utf-8",
    cwd,
    env: {
      ...process.env,
      HOME: tmp,
      NAVORI_AUDITS_ROOT: audits,
      CLAUDE_PROJECT_DIR: project,
      PATH: `${shims}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
    },
  });
  expect(res.status, res.stderr).not.toBeNull();
}

function shimCalls(): string[] {
  return existsSync(shimLog) ? readFileSync(shimLog, "utf-8").split("\n").filter(Boolean) : [];
}

function events(): Record<string, unknown>[] {
  const file = join(tmp, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("audit gating by active session log (spec 0055 R8, R9)", () => {
  for (const shell of SHELLS) {
    for (const hook of HOOKS) {
      // Covers: R8
      it(`sin log activo y sin EPOCHREALTIME no hay execs de perl ni date en ${shell} (${hook.name})`, () => {
        runHook(shell, hook, payload(hook));
        expect(shimCalls()).toEqual([]);
        expect(events()).toEqual([]);
      });

      // Covers: R8
      it(`control: con log activo el mismo camino sí paga el timestamp en ${shell} (${hook.name})`, () => {
        makeLog("proj");
        runHook(shell, hook, payload(hook));
        expect(shimCalls()).toContain("perl");
      });
    }
  }

  for (const shell of SHELLS) {
    // Covers: R9
    it(`log activo escribe el mismo evento y el repo .foo se audita en ${shell}`, () => {
      const hook = HOOKS[0]!;
      makeLog("proj");
      runHook(shell, hook, payload(hook));
      const [event] = events();
      expect(event).toMatchObject({
        event: "hook",
        name: "guard-destructive",
        phase: "PreToolUse",
        verdict: "skip",
        toolUseId: "toolu_1",
        tool: "Bash",
      });
      expect(String(event!.tsMs)).toMatch(/^\d{13}$/);
      expect(typeof event!.ms).toBe("number");

      // Dot-prefixed repo: the default glob skips it, the hidden-dir globs must not.
      rmSync(join(tmp, "events.jsonl"));
      const dotRepo = join(tmp, ".foo");
      mkdirSync(dotRepo);
      makeLog(".foo");
      runHook(shell, hook, payload(hook, dotRepo), dotRepo);
      expect(events()).toHaveLength(1);
    });

    // Covers: R8, R9
    it(`ids dudosos (duplicado, ausente, con comillas escapadas) mantienen el camino de hoy en ${shell}`, () => {
      const hook = HOOKS[0]!;
      const dup = `{"session_id":"${SESSION}","tool_name":"Bash","cwd":"${project}","hook_event_name":"PreToolUse","tool_input":{"command":"ls","note":{"session_id":"x"}}}`;
      runHook(shell, hook, dup);
      // No log exists, so nothing is recorded; but the clock was paid (doubt -> today's path).
      expect(shimCalls()).toContain("perl");
    });

    // Covers: R9
    it(`el log que nace durante el hook registra el evento con ms 0 en ${shell}`, () => {
      const script = [
        "unset EPOCHREALTIME",
        `. "${join(PARTIALS, "audit-repo.sh")}"`,
        `. "${join(PARTIALS, "audit-log.sh")}"`,
        `payload='{"session_id":"${SESSION}","cwd":"${project}","tool_use_id":"toolu_2"}'`,
        "navori_audit_name=race; navori_audit_phase=UserPromptSubmit",
        "navori_audit_begin",
        `[ "$navori_audit_on" = 0 ] || exit 3`,
        `mkdir -p "${audits}/proj"; : > "${audits}/proj/session-${SESSION}.log"`,
        "navori_audit_log allow",
      ].join("\n");
      const res = spawnSync(shell, ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          NAVORI_AUDITS_ROOT: audits,
          PATH: `${shims}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
        },
      });
      expect(res.status, res.stderr).toBe(0);
      const [event] = events();
      expect(event).toMatchObject({ name: "race", ms: 0 });
      expect(String(event!.tsMs)).toMatch(/^\d{13}$/);
    });
  }
});
