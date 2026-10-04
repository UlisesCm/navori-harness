import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for `implementer-no-markdown.sh` (spec 0030, #985 — R3/R4).
 * Each case installs the RENDERED script (includes expanded, exactly what ships
 * to a repo) into a temp dir and drives it with its PreToolUse payload on
 * stdin. `Covers: R3, R4`.
 */
const HOOKS_DIR = resolve(getCoreRoot(), "core-assets/hooks");
const SCRIPT = "implementer-no-markdown.sh";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-no-md-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Payload {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_type?: string;
}

/** Install the rendered hook and run it under every available shell (#391). */
function runHook(
  payload: Payload,
  nodePath = dirname(process.execPath),
  includeParentPath = true,
  engine: "claude" | "codex" = "claude",
): { status: number; stderr: string } {
  const raw = expandHookIncludes(readFileSync(join(HOOKS_DIR, SCRIPT), "utf-8"));
  const path = engine === "codex" ? join(dir, ".codex", "hooks", SCRIPT) : join(dir, SCRIPT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  return acrossShells((shell) => {
    const r = spawnSync(shell, [path], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${nodePath}:/usr/bin:/bin${includeParentPath ? `:${process.env.PATH ?? ""}` : ""}`,
      },
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  });
}

const METADATA_PROGRAM = `node -e 'const fs=require("node:fs");const p="state/impl.json";const x=JSON.parse(fs.readFileSync(p,"utf8"));for(const f of ["docs/one.md","docs/two.mdx"])if(!x.filesTouched.includes(f))x.filesTouched.push(f);x.filesTouched.sort();x.markdownRequestsFulfilled=x.markdownRequests.map(r=>r.path);x.nativeRender={applyCommand:"bun run render:apply",applyExitCode:0};x.verification.summary="Markdown metadata only";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\\n");'`;

// Exact incident text is hook payload data only; the submitted program is never run.
const INCIDENT_PROGRAM = `node -e 'const fs=require("node:fs");const p=".navori/state/handoffs/impl_dual-workflow-deliveries.json";const x=JSON.parse(fs.readFileSync(p,"utf8"));for(const f of ["packages/core/core-assets/master-plan/delivery-master.md","packages/core/core-assets/master-plan/en/delivery-master.md","packages/core/core-assets/master-plan/slice.md","packages/core/core-assets/master-plan/en/slice.md",".claude/hooks/master-accept-confirm.sh","packages/cli/src/engines/__tests__/__golden__/claude.snap"])if(!x.filesTouched.includes(f))x.filesTouched.push(f);x.filesTouched.sort();x.pendingRequests=["No real baseline, queue, criterion, client acceptance, release or deployment attestation was recorded. D3/D4 execution remains unavailable."];x.markdownRequestsFulfilled=x.markdownRequests.map(r=>r.path);x.nativeRender={applyCommand:"bun run render:apply",applyExitCode:0,mirror:".claude/hooks/master-accept-confirm.sh",goldenCommand:"cd packages/cli && bun run test:golden",goldenExitCode:0,goldenResult:"5/5 passed, 1 snapshot updated (claude.snap)",checkRender:"bun run check:render exit 0, 0 pending changes"};x.verification.summary="A1 60/60; A2 83/83 after scribe; D2 focused 66/66; golden read-only 5/5; format:check/check:assets/check:render/lint/typecheck/diff-check green. Full gate reserved for reviewer.";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\\n");'`;

function bash(cmd: string, agentType = "implementer"): Payload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: cmd },
    agent_type: agentType,
  };
}

// Covers: R3, R4
describe("implementer-no-markdown hook — allow (#985 R3, R4)", () => {
  it("allows the main thread (no agent_type) writing a .md file", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "README.md", content: "x" },
    });
    expect(r.status).toBe(0);
  });

  it("allows the scribe writing a .md file", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "notes.md", content: "x" },
      agent_type: "scribe",
    });
    expect(r.status).toBe(0);
  });

  it("allows the implementer writing a non-md file", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/x.ts", content: "x" },
      agent_type: "implementer",
    });
    expect(r.status).toBe(0);
  });

  it("allows the implementer reading a .md file (cat)", () => {
    expect(runHook(bash("cat notes.md")).status).toBe(0);
  });

  it("allows the implementer grepping a .md file", () => {
    expect(runHook(bash("grep -rn TODO docs/x.md")).status).toBe(0);
  });

  it("allows the implementer redirecting into a non-md file", () => {
    expect(runHook(bash("echo x > src/x.ts")).status).toBe(0);
  });
});

// Regression: #1129. Interpreter command strings are inspected, never executed.
describe("implementer-no-markdown hook — interpreter writes", () => {
  it.each([
    "python3 - <<'EOF'\np = 'notes.md'\nopen(p, 'w').write('x')\nEOF",
    `python -c "open('notes.md', 'a').write('x')"`,
    `python3 -c "from pathlib import Path; Path('NOTES.MDX').write_text('x')"`,
    `node -e "require('fs').writeFileSync('notes.md', 'x')"`,
    `node - <<'EOF'\nrequire('fs').appendFileSync('notes.mdx', 'x')\nEOF`,
    `ruby -e "File.write('notes.md', 'x')"`,
    `ruby -e "File.open('notes.md', 'w') { |f| f.write('x') }"`,
    `perl -e 'open(my $f, ">", "notes.md"); print $f "x";'`,
    `deno eval "Deno.writeTextFileSync('notes.md', 'x')"`,
    `bun -e "Bun.write('notes.md', 'x')"`,
    `/usr/bin/python3 -c "open('notes.md', mode='w').write('x')"`,
  ])("blocks an interpreter write: %s", (command: string): void => {
    const result = runHook(bash(command));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
  });

  it.each([
    `python3 -c "print(open('notes.md').read())"`,
    `python3 -c "print(open('notes.md', 'r').read())"`,
    `python3 -c "from pathlib import Path; print(Path('notes.md').read_text())"`,
    `node -e "console.log(require('fs').readFileSync('notes.md', 'utf8'))"`,
    `ruby -e "puts File.read('notes.md')"`,
    `perl -e 'open(my $f, "<", "notes.md"); print <$f>;'`,
    `deno eval "console.log(Deno.readTextFileSync('notes.md'))"`,
    `bun -e "console.log(await Bun.file('notes.md').text())"`,
    `python3 -c "open('notes.ts', 'w').write('x')"`,
    `node -e "require('fs').writeFileSync('notes.ts', 'x')"`,
  ])("allows a read or non-Markdown write: %s", (command: string): void => {
    expect(runHook(bash(command)).status).toBe(0);
  });

  it.each(["scribe", "reviewer", "scout"])(
    "does not restrict interpreter writes by %s",
    (role: string): void => {
      expect(
        runHook(bash(`node -e "require('fs').writeFileSync('notes.md', 'x')"`, role)).status,
      ).toBe(0);
    },
  );
});

describe("implementer-no-markdown hook — bounded JSON metadata exception", () => {
  it.each([
    INCIDENT_PROGRAM,
    METADATA_PROGRAM,
    METADATA_PROGRAM.replaceAll("const fs", "const io")
      .replaceAll("fs.", "io.")
      .replaceAll("const p", "const target")
      .replaceAll("(p,", "(target,")
      .replaceAll("const x", "const record")
      .replaceAll("x.", "record.")
      .replaceAll("(x,", "(record,")
      .replace("state/impl.json", "other/record.JSON"),
  ])("recognizes a complete JSON-only program as inert payload data", (command: string): void => {
    const marker = join(dir, "should-not-exist");
    const result = runHook(bash(command));
    expect(result.status).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(() => readFileSync(join(dir, "state/impl.json"))).toThrow();
  });

  it.each([
    METADATA_PROGRAM.replace('"state/impl.json"', '"notes.md"'),
    METADATA_PROGRAM.replace('"state/impl.json"', '"notes\\u002emd"'),
    METADATA_PROGRAM.replace('"state/impl.json"', '"NOTES.MDX"'),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'fs.writeFileSync("extra.md","x");x.filesTouched.sort();',
    ),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'fs.writeFileSync(p,"x");x.filesTouched.sort();',
    ),
    METADATA_PROGRAM.replace("x.filesTouched.sort();", 'p="notes.md";x.filesTouched.sort();'),
    METADATA_PROGRAM.replace("x.filesTouched.sort();", 'const p="notes.md";x.filesTouched.sort();'),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'const io=fs;io.writeFileSync("notes.md","x");x.filesTouched.sort();',
    ),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'x.filesTouched.sort(()=>fs.writeFileSync("notes.md","x"));',
    ),
    METADATA_PROGRAM.replace(
      "applyExitCode:0",
      'applyExitCode:(()=>fs.writeFileSync("notes.md","x"))()',
    ),
    METADATA_PROGRAM.replace(
      "applyExitCode:0",
      'get applyExitCode(){fs.writeFileSync("notes.md","x")}',
    ),
    METADATA_PROGRAM.replace("applyExitCode:0", "applyExitCode:0,applyExitCode:1"),
    METADATA_PROGRAM.replace("x.verification.summary", "x.__proto__.summary"),
    METADATA_PROGRAM.replace("applyExitCode:0", '"constructor":0'),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'x.filesTouched[0]="notes.md";x.filesTouched.sort();',
    ),
    METADATA_PROGRAM.replace("x.filesTouched.sort();", "/* harmless */x.filesTouched.sort();"),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'x.filesTouched.sort();require("node:fs").writeFileSync("notes.md","x");',
    ),
    METADATA_PROGRAM.replace("x.filesTouched.sort();", "x.filesTouched.sort();`template`;"),
    METADATA_PROGRAM.replace("x.filesTouched.sort();", "x.filesTouched.sort();(() => 1)();"),
    METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'x.filesTouched.sort();fs.writeFileSync("should-not-exist","x");',
    ),
    METADATA_PROGRAM + " ; echo x > notes.md",
    METADATA_PROGRAM + " && echo x",
    METADATA_PROGRAM + " | cat",
    `env ${METADATA_PROGRAM}`,
    METADATA_PROGRAM.replace("node -e '", 'node -e "'),
    METADATA_PROGRAM.replace("x.filesTouched.sort();", "x.filesTouched.sort();'echo injected'"),
    METADATA_PROGRAM.replace('"state/impl.json"', '"state/impl.json\\q"'),
    METADATA_PROGRAM.replace('"state/impl.json"', '"state/impl.json"+"notes.md"'),
    METADATA_PROGRAM.replace('"Markdown metadata only"', `"${"x".repeat(17000)}notes.md"`),
    METADATA_PROGRAM.replace('"Markdown metadata only"', `[${"0,".repeat(2100)}"notes.md"]`),
    `node -e 'const fs=require("node:fs");const p="state/impl.json";const x=JSON.parse(fs.readFileSync(p,"utf8"));x.data=${"[".repeat(17)}"notes.md"${"]".repeat(17)};fs.writeFileSync(p,JSON.stringify(x,null,2)+"\\n");'`,
    `node -e 'const fs=require("node:fs");const p="state/impl.json";const x=JSON.parse(fs.readFileSync(p,"utf8"));x.${"part.".repeat(8)}leaf="notes.md";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\\n");'`,
  ])("denies unsupported or hostile mixed program %s", (command: string): void => {
    const result = runHook(bash(command));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
    expect(() => readFileSync(join(dir, "should-not-exist"))).toThrow();
  });

  it("keeps the normal exit-2 denial when analyzer Node fails", () => {
    const brokenNode = join(dir, "node-bin");
    mkdirSync(brokenNode);
    const executable = join(brokenNode, "node");
    writeFileSync(executable, "#!/bin/sh\necho MALFORMED\nexit 0\n");
    chmodSync(executable, 0o755);
    const result = runHook(bash(METADATA_PROGRAM), brokenNode);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
    writeFileSync(executable, "#!/bin/sh\nexit 7\n");
    const failed = runHook(bash(METADATA_PROGRAM), brokenNode);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("markdownRequests");
  });

  it("keeps the normal exit-2 denial without Node in PATH", () => {
    const result = runHook(bash(METADATA_PROGRAM), dir, false);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
  });

  it("applies the same bounded classification in the Codex Bash hook", () => {
    expect(runHook(bash(METADATA_PROGRAM), undefined, true, "codex").status).toBe(0);
    const mixed = METADATA_PROGRAM.replace(
      "x.filesTouched.sort();",
      'fs.writeFileSync("extra.md","x");x.filesTouched.sort();',
    );
    expect(runHook(bash(mixed), undefined, true, "codex").status).toBe(2);
  });

  it("keeps mixed Codex apply_patch paths blocked", () => {
    const patch =
      "*** Begin Patch\n*** Add File: data.json\n+{}\n*** Add File: docs/extra.md\n+text\n*** End Patch";
    const result = runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: patch },
        agent_type: "implementer",
      },
      undefined,
      true,
      "codex",
    );
    expect(result.status).toBe(2);
  });
});

// Covers: R3
describe("implementer-no-markdown hook — block per tool (#985 R3)", () => {
  it("blocks Write onto a .md path", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "notes.md", content: "x" },
      agent_type: "implementer",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("markdownRequests");
  });

  it("blocks Edit onto a .MD path (case-insensitive)", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "NOTES.MD", old_string: "a", new_string: "b" },
      agent_type: "implementer",
    });
    expect(r.status).toBe(2);
  });

  it("blocks Edit onto a .mdx path", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "docs/x.mdx", old_string: "a", new_string: "b" },
      agent_type: "implementer",
    });
    expect(r.status).toBe(2);
  });

  it("blocks NotebookEdit onto a .md notebook_path", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "nb.md" },
      agent_type: "implementer",
    });
    expect(r.status).toBe(2);
  });
});

// Covers: R4
describe("implementer-no-markdown hook — block per Bash form (#985 R4)", () => {
  it("blocks output redirection (>) onto a .md path", () => {
    expect(runHook(bash("echo hi > notes.md")).status).toBe(2);
  });

  it("blocks append redirection (>>) onto a .md path", () => {
    expect(runHook(bash("echo hi >> notes.md")).status).toBe(2);
  });

  it("blocks tee onto a .md path", () => {
    expect(runHook(bash("echo hi | tee notes.md")).status).toBe(2);
  });

  it("blocks sed -i on a .md path", () => {
    expect(runHook(bash('sed -i "" -e s/a/b/ notes.md')).status).toBe(2);
  });

  it("blocks perl -i on a .md path", () => {
    expect(runHook(bash("perl -i -pe 's/a/b/' notes.md")).status).toBe(2);
  });

  it("blocks cp onto a .md path", () => {
    expect(runHook(bash("cp /tmp/scratch.txt notes.md")).status).toBe(2);
  });

  it("blocks mv onto a .md path", () => {
    expect(runHook(bash("mv /tmp/scratch.txt docs/notes.md")).status).toBe(2);
  });

  it("names markdownRequests in the impl JSON as the route", () => {
    const r = runHook(bash("echo hi > notes.md"));
    expect(r.stderr).toContain("impl_<feature>.json");
    expect(r.stderr).toContain("markdownRequests");
  });
});
