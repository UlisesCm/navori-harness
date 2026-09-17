import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { resolveHarnessPlan } from "../../engines/shared/harness-plan.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * Behavioral tests for core-assets/hooks/comment-draft-confirm.sh (spec 0026
 * E1, R10-R13).
 *
 * The value under test: a Bash call that publishes a comment or review shows
 * its actual draft text in the `ask` reason — the one place the tool call
 * itself never shows it, because `--body-file`/`-F` only ever carry a path.
 * `ask` on Claude forces the human to look before it goes out; `deny` under
 * `.codex/hooks/` because Codex does not support `ask` yet and would
 * otherwise fail open.
 */

const runsBash = process.platform !== "win32";
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** The hook as a RENDERED repo runs it — includes expanded, as `render` does. */
const hookSource = expandHookIncludes(
  readFileSync(resolve(getCoreRoot(), "core-assets/hooks/comment-draft-confirm.sh"), "utf-8"),
);

function writeHook(dir: string, relPath = "comment-draft-confirm.sh"): string {
  const p = join(dir, relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, hookSource);
  chmodSync(p, 0o755);
  return p;
}

const hookPath = writeHook(mkdtempSync(join(tmpdir(), "navori-cdc-src-")));

const SESSION = "sess-cdc-1";

interface HookRun {
  code: number;
  stdout: string;
}

function bash(command: string): Record<string, unknown> {
  return { session_id: SESSION, tool_name: "Bash", tool_input: { command } };
}

function runHookAt(
  scriptPath: string,
  shell: HookShell,
  payload: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): HookRun {
  const cwd = mkdtempSync(join(tmpdir(), "navori-cdc-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const r = spawnSync(shell, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...(env ?? process.env), CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

/** Run under every available shell and assert they agree (#391). */
function run(payload: Record<string, unknown>, env?: NodeJS.ProcessEnv): HookRun {
  return acrossShells((shell) => runHookAt(hookPath, shell, payload, env));
}

interface Verdict {
  decision?: string;
  reason: string;
}

function verdictOf(r: HookRun): Verdict {
  const parsed = JSON.parse(r.stdout) as {
    hookSpecificOutput?: {
      hookEventName?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision,
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

function writeBody(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-cdc-body-"));
  const p = join(dir, "body.txt");
  writeFileSync(p, text);
  return p;
}

function writeAdf(paragraphs: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-cdc-adf-"));
  const p = join(dir, "body.json");
  writeFileSync(
    p,
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: paragraphs.map((text) => ({ type: "text", text })),
        },
      ],
    }),
  );
  return p;
}

describe.runIf(runsBash && hasJq)("comment-draft-confirm.sh — una fila por payload", () => {
  // Covers: R10
  it("gh pr comment --body-file", () => {
    const file = writeBody("hola mundo");
    const v = verdictOf(run(bash(`gh pr comment 5 --body-file ${file}`)));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("hola mundo");
    expect(v.reason).toContain(file);
  });

  // Covers: R10
  it("gh issue comment --edit-last", () => {
    const file = writeBody("edited body");
    const v = verdictOf(run(bash(`gh issue comment 9 --edit-last --body-file ${file}`)));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("edited body");
  });

  // Covers: R10
  it("gh pr review -c con -F", () => {
    const file = writeBody("looks good overall");
    const v = verdictOf(run(bash(`gh pr review 5 -c -F ${file}`)));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("looks good overall");
  });

  // Covers: R10
  it("gh pr review --approve sin cuerpo no dispara nada", () => {
    const r = run(bash("gh pr review 5 --approve"));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // Covers: R10
  it("gh api REST sobre /comments con --input", () => {
    const file = writeBody('{"body":"a REST comment"}');
    const v = verdictOf(run(bash(`gh api repos/o/r/issues/1/comments -X POST --input ${file}`)));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("a REST comment");
  });

  // Covers: R10
  it("gh api REST sobre una ruta ajena no dispara nada", () => {
    const file = writeBody('{"sha":"x"}');
    const r = run(bash(`gh api repos/o/r/commits -X POST --input ${file}`));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // Covers: R10, R11
  it("gh api graphql — creación (addComment)", () => {
    const file = writeBody("a graphql comment");
    const v = verdictOf(
      run(
        bash(
          `gh api graphql -f query='mutation{addComment(input:{subjectId:"x"}){clientMutationId}}' -F body=@${file}`,
        ),
      ),
    );
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("a graphql comment");
  });

  // Covers: R10, R11
  it("gh api graphql — edición (updateIssueComment)", () => {
    const file = writeBody("an edited graphql comment");
    const v = verdictOf(
      run(
        bash(
          `gh api graphql -f query='mutation{updateIssueComment(input:{id:"x"}){clientMutationId}}' -F body=@${file}`,
        ),
      ),
    );
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("an edited graphql comment");
  });

  // Covers: R10
  it("gh api graphql sin mutación de comentario no dispara nada", () => {
    const r = run(bash("gh api graphql -f query='{__schema{mutationType{fields{name}}}}'"));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // Covers: R10
  it("acli jira workitem comment create --jql --body-file", () => {
    const file = writeBody("a jira comment via jql");
    const v = verdictOf(
      run(bash(`acli jira workitem comment create --jql "project = X" --body-file ${file}`)),
    );
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("a jira comment via jql");
  });

  // Covers: R10
  it("acli jira workitem comment update --body-file", () => {
    const file = writeBody("an updated jira comment");
    const v = verdictOf(
      run(bash(`acli jira workitem comment update --key T-1 --id 5 --body-file ${file}`)),
    );
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("an updated jira comment");
  });
});

describe.runIf(runsBash && hasJq)("comment-draft-confirm.sh — R11 (forma del cuerpo)", () => {
  // Covers: R11
  it("cuerpo en línea con `;`, `|` y saltos de línea — la razón no lo re-muestra", () => {
    const v = verdictOf(run(bash('gh pr comment 5 --body "a; rm -rf | echo\nmore"')));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("inline");
    // The risky text never gets re-derived into the reason (R11's own
    // limitation): showing it would mean parsing past separators the
    // compound-command scan does not respect quoting for.
    expect(v.reason).not.toContain("rm -rf");
  });

  // Covers: R11
  it("ADF por -F (contenido detectado por sniffing)", () => {
    const file = writeAdf(["Hola", "Mundo"]);
    const v = verdictOf(run(bash(`acli jira workitem comment create --key T-1 -F ${file}`)));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("Hola Mundo");
  });

  // Covers: R11
  it("ADF por --body-adf", () => {
    const file = writeAdf(["Buenas", "tardes"]);
    const v = verdictOf(
      run(bash(`acli jira workitem comment update --key T-1 --id 5 --body-adf ${file}`)),
    );
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("Buenas tardes");
  });

  // Covers: R12
  it("archivo ilegible → razón fija (R12), nunca bloquea", () => {
    const v = verdictOf(run(bash("gh pr comment 5 --body-file /nonexistent/path/body.txt")));
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/could not be read or rendered/);
  });

  // Covers: R11
  it("más de 1,500 caracteres se trunca con el conteo de lo omitido", () => {
    const file = writeBody("a".repeat(2000));
    const v = verdictOf(run(bash(`gh pr comment 5 --body-file ${file}`)));
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("a".repeat(1500));
    expect(v.reason).not.toContain("a".repeat(1501));
    expect(v.reason).toContain("[+500 caracteres omitidos]");
  });
});

describe.runIf(runsBash && hasJq)(
  "comment-draft-confirm.sh — R52 (fixture para la consulta del criterio 3)",
  () => {
    /**
     * "Comentarios" (design.md, Criterios pre-registrados #3): every command
     * of the hook's table present in the audit log has a hook verdict. The
     * query that decides that criterion is the EXISTING generic hook-event
     * parser (`attachHookEvents`, `lib/audit/parse.ts`) — no per-hook code —
     * so this is a positive-control fixture proving comment-draft-confirm's
     * own audit record is a shape that parser actually counts, not a new
     * counting mechanism of its own.
     */
    // Covers: R52
    it("un log de audit fixture con un comentario produce un veredicto contado por la consulta del criterio 3", async () => {
      const { attachHookEvents, parseSession } = await import("../audit/parse.ts");
      const auditsRoot = mkdtempSync(join(tmpdir(), "navori-cdc-audits-"));
      const repo = mkdtempSync(join(tmpdir(), "navori-cdc-audit-repo-"));
      // The recorder derives the audit sub-directory from `basename(cwd)`
      // (`navori_audit_repo_from_cwd`) — it has to match the repo the payload
      // names, not an arbitrary label, or the log write silently misses.
      const repoName = repo.split("/").pop() as string;
      mkdirSync(join(auditsRoot, repoName), { recursive: true });
      const logPath = join(auditsRoot, repoName, `session-${SESSION}.log`);
      writeFileSync(logPath, "", "utf-8");

      const file = writeBody("audit fixture body");
      const r = spawnSync("bash", [hookPath], {
        input: JSON.stringify({ ...bash(`gh pr comment 5 --body-file ${file}`), cwd: repo }),
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo, NAVORI_AUDITS_ROOT: auditsRoot },
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");

      const emptySession = parseSession(
        (() => {
          const dir = mkdtempSync(join(tmpdir(), "navori-cdc-empty-jsonl-"));
          const p = join(dir, "empty.jsonl");
          writeFileSync(p, "", "utf-8");
          return p;
        })(),
      );
      attachHookEvents(emptySession, logPath);
      const events =
        emptySession.orchestrator.hookEvents.length > 0
          ? emptySession.orchestrator.hookEvents
          : emptySession.agents.flatMap((a) => a.hookEvents);
      const cdcEvent = events.find((e) => e.name === "comment-draft-confirm");
      expect(cdcEvent).toBeDefined();
      expect(cdcEvent?.verdict).toBe("ask");
    });
  },
);

describe.runIf(runsBash)("comment-draft-confirm.sh — comando ajeno, sin salida", () => {
  it.each([
    ["git status", "no toca gh ni acli"],
    ["gh pr view 5 --json state", "solo lectura"],
    ["gh pr list --state open", "solo lectura"],
    ['git commit -m "fix: comment handling"', "la palabra comment en prosa ajena"],
    ["acli jira workitem comment list --key T-1", "list, no create/update"],
  ])("se calla en `%s` (%s)", (cmd) => {
    const r = run(bash(cmd));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("se calla cuando no se pudo leer el comando", () => {
    const r = run({ session_id: SESSION, tool_name: "Bash", tool_input: {} });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

describe.runIf(runsBash)("comment-draft-confirm.sh — R12 sin jq ni node", () => {
  let restrictedEnv: NodeJS.ProcessEnv;

  function resolveBin(name: string): string {
    return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
  }

  beforeAll(() => {
    const bin = mkdtempSync(join(tmpdir(), "navori-cdc-nobin-"));
    for (const tool of ["cat", "grep", "sed", "head", "bash"]) {
      symlinkSync(resolveBin(tool), join(bin, tool));
    }
    restrictedEnv = { PATH: bin };
  });

  // Covers: R12
  it("cae a la razón fija, con `ask` en Claude, y nunca bloquea", () => {
    const file = writeBody("hola mundo");
    const r = runHookAt(
      hookPath,
      "bash",
      bash(`gh pr comment 5 --body-file ${file}`),
      restrictedEnv,
    );
    expect(r.code).toBe(0);
    const v = verdictOf(r);
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/no jq\/node on PATH/);
  });

  it("un comando ajeno sigue sin decir nada", () => {
    const r = runHookAt(hookPath, "bash", bash("git status"), restrictedEnv);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

describe.runIf(runsBash)("comment-draft-confirm.sh — R13 instalado bajo .codex/hooks/", () => {
  const codexHookPath = writeHook(
    mkdtempSync(join(tmpdir(), "navori-cdc-codex-")),
    ".codex/hooks/comment-draft-confirm.sh",
  );

  // Covers: R10, R13
  it("installed under .codex/hooks it denies with draft path and command", () => {
    const file = writeBody("codex draft");
    const r = runHookAt(codexHookPath, "bash", bash(`gh pr comment 5 --body-file ${file}`));
    expect(r.code).toBe(0);
    const v = verdictOf(r);
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain(file);
    expect(v.reason).toContain("codex draft");
  });

  // Covers: R13
  it("cuerpo en línea/stdin: no inventa un archivo, indica que no existe", () => {
    const r = runHookAt(codexHookPath, "bash", bash('gh pr comment 5 --body "inline text"'));
    expect(r.code).toBe(0);
    const v = verdictOf(r);
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("inline");
  });

  // Covers: R13
  it("el deny prevalece aun sin jq/node", () => {
    const bin = mkdtempSync(join(tmpdir(), "navori-cdc-codex-nobin-"));
    for (const tool of ["cat", "grep", "sed", "head", "bash"]) {
      symlinkSync(
        execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).trim(),
        join(bin, tool),
      );
    }
    const r = runHookAt(codexHookPath, "bash", bash("gh pr comment 5 --body-file /tmp/x"), {
      PATH: bin,
    });
    expect(r.code).toBe(0);
    expect(verdictOf(r).decision).toBe("deny");
  });
});

describe("comment-draft-confirm — wiring (spec 0026 E1)", () => {
  const MINIMAL_CONFIG = {
    name: "test",
    engines: ["claude"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
  } as unknown as NavoriConfig;

  it("queda registrado en PreToolUse(Bash) sin condición y se materializa en cada repo", () => {
    const pre = (
      buildClaudeSettings(MINIMAL_CONFIG, []).hooks as {
        PreToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      }
    ).PreToolUse;
    const bucket = pre?.find((b) =>
      b.hooks.some((h) => h.command.includes("comment-draft-confirm.sh")),
    );
    expect(bucket).toBeDefined();
    expect(bucket?.matcher).toBe("Bash");

    const plan = resolveHarnessPlan(MINIMAL_CONFIG, resolve(getCoreRoot(), "core-assets"), null);
    expect(plan.hooks.map((h) => h.id)).toContain("comment-draft-confirm");
  });
});
