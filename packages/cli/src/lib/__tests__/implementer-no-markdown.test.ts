import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
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
function runHook(payload: Payload): { status: number; stderr: string } {
  const raw = expandHookIncludes(readFileSync(join(HOOKS_DIR, SCRIPT), "utf-8"));
  const path = join(dir, SCRIPT);
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  const nodeDir = dirname(process.execPath);
  return acrossShells((shell) => {
    const r = spawnSync(shell, [path], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      },
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  });
}

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
