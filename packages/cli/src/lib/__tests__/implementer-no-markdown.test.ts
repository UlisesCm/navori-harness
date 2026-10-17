import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { acrossShells, HOOK_SHELLS } from "./helpers/shells.ts";
import {
  createHookBatch,
  type HookBatch,
  type HookCase,
} from "../../__tests__/helpers/hook-batch.ts";

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
  cwd?: string;
}

type Engine = "claude" | "codex";

/** A primed table runs dozens of hook invocations in one process per shell. */
const PRIME_TIMEOUT_MS = 120_000;
const DEFAULT_NODE_PATH = dirname(process.execPath);
const hookPathEnv = (nodePath: string, includeParentPath: boolean): string =>
  `${nodePath}:/usr/bin:/bin${includeParentPath ? `:${process.env.PATH ?? ""}` : ""}`;

/**
 * Shared, EMPTY directory the primed tables run in (spec 0054 D4). Only tables
 * whose verdict depends on the payload alone are primed; a test that writes
 * fixtures into its own `dir` before calling `runHook` keeps a real spawn.
 * The hook only ever inspects payload text, so the sentinel check below also
 * proves nothing a payload mentions was executed.
 */
const batchDir = mkdtempSync(join(tmpdir(), "navori-no-md-batch-"));
const batchHooks = new Map<Engine, { path: string; batch: HookBatch }>();

function batchHookFor(engine: Engine): { path: string; batch: HookBatch } {
  let entry = batchHooks.get(engine);
  if (entry === undefined) {
    const path = installHook(batchDir, engine, "");
    entry = { path, batch: createHookBatch(path) };
    batchHooks.set(engine, entry);
  }
  return entry;
}

function batchCase(payload: Payload, nodePath: string, includeParentPath: boolean): HookCase {
  return {
    input: JSON.stringify(payload),
    cwd: batchDir,
    env: { PATH: hookPathEnv(nodePath, includeParentPath) },
  };
}

/** Runs payload-only cases in one process per shell; later `runHook` calls read them back. */
function primeHook(payloads: readonly Payload[], engine: Engine = "claude"): void {
  const { batch } = batchHookFor(engine);
  batch.prime(
    HOOK_SHELLS,
    payloads.map((p) => batchCase(p, DEFAULT_NODE_PATH, true)),
  );
  const stray = readdirSync(batchDir).filter((f) => f !== SCRIPT && f !== ".codex");
  expect(stray, "a primed payload must never be executed (stray files in the batch dir)").toEqual(
    [],
  );
}

function installHook(root: string, engine: Engine, prelude: string): string {
  const raw = expandHookIncludes(readFileSync(join(HOOKS_DIR, SCRIPT), "utf-8"));
  const path = engine === "codex" ? join(root, ".codex", "hooks", SCRIPT) : join(root, SCRIPT);
  mkdirSync(dirname(path), { recursive: true });
  const firstNewline = raw.indexOf("\n") + 1;
  writeFileSync(
    path,
    prelude ? `${raw.slice(0, firstNewline)}${prelude}\n${raw.slice(firstNewline)}` : raw,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Install the rendered hook and run it under every available shell (#391). */
function runHook(
  payload: Payload,
  nodePath = DEFAULT_NODE_PATH,
  includeParentPath = true,
  engine: Engine = "claude",
  prelude: string = "",
): { status: number; stderr: string } {
  if (prelude === "" && batchHooks.has(engine)) {
    const { batch } = batchHooks.get(engine) as { batch: HookBatch };
    const c = batchCase(payload, nodePath, includeParentPath);
    if (batch.cached(HOOK_SHELLS[0], c) !== undefined) {
      return acrossShells((shell) => {
        const r = batch.cached(shell, c) as NonNullable<ReturnType<HookBatch["cached"]>>;
        return { status: r.status, stderr: r.stderr };
      });
    }
  }
  const path = installHook(dir, engine, prelude);
  return acrossShells((shell) => {
    const r = spawnSync(shell, [path], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: hookPathEnv(nodePath, includeParentPath),
      },
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  });
}

const METADATA_PROGRAM = `node -e 'const fs=require("node:fs");const p="state/impl.json";const x=JSON.parse(fs.readFileSync(p,"utf8"));for(const f of ["docs/one.md","docs/two.mdx"])if(!x.filesTouched.includes(f))x.filesTouched.push(f);x.filesTouched.sort();x.markdownRequestsFulfilled=x.markdownRequests.map(r=>r.path);x.nativeRender={applyCommand:"bun run render:apply",applyExitCode:0};x.verification.summary="Markdown metadata only";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\\n");'`;

// Exact incident text is hook payload data only; the submitted program is never run.
const INCIDENT_PROGRAM = `node -e 'const fs=require("node:fs");const p=".navori/state/handoffs/impl_dual-workflow-deliveries.json";const x=JSON.parse(fs.readFileSync(p,"utf8"));for(const f of ["packages/core/core-assets/master-plan/delivery-master.md","packages/core/core-assets/master-plan/en/delivery-master.md","packages/core/core-assets/master-plan/slice.md","packages/core/core-assets/master-plan/en/slice.md",".claude/hooks/master-accept-confirm.sh","packages/cli/src/engines/__tests__/__golden__/claude.snap"])if(!x.filesTouched.includes(f))x.filesTouched.push(f);x.filesTouched.sort();x.pendingRequests=["No real baseline, queue, criterion, client acceptance, release or deployment attestation was recorded. D3/D4 execution remains unavailable."];x.markdownRequestsFulfilled=x.markdownRequests.map(r=>r.path);x.nativeRender={applyCommand:"bun run render:apply",applyExitCode:0,mirror:".claude/hooks/master-accept-confirm.sh",goldenCommand:"cd packages/cli && bun run test:golden",goldenExitCode:0,goldenResult:"5/5 passed, 1 snapshot updated (claude.snap)",checkRender:"bun run check:render exit 0, 0 pending changes"};x.verification.summary="A1 60/60; A2 83/83 after scribe; D2 focused 66/66; golden read-only 5/5; format:check/check:assets/check:render/lint/typecheck/diff-check green. Full gate reserved for reviewer.";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\\n");'`;

const PATH_SOURCE = `from pathlib import Path
p = Path("fixture.ts")
text = p.read_text(encoding="utf-8")
text = text.replace("AGENTS.md", "instructions.md")
p.write_text(text, encoding="utf-8")`;

/** Wrap source as inert hook payload data, never as an executable probe. */
function pathCommand(source = PATH_SOURCE): string {
  return `python3 - <<'PY'\n${source}\nPY`;
}

function bash(cmd: string, agentType = "implementer"): Payload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: cmd },
    agent_type: agentType,
  };
}

describe("implementer-no-markdown hook — closed Python Path rewrite", () => {
  // Covers: R3, R4
  it.each([
    { name: "single quoted heredoc", command: pathCommand() },
    { name: "double quoted heredoc", command: pathCommand().replace("<<'PY'", '<<"PY"') },
    { name: "single quoted -c", command: `python3 -c '${PATH_SOURCE}'` },
    {
      name: "double quoted -c without expansion",
      command: `python3 -c "${PATH_SOURCE.replaceAll('"', "'")}"`,
    },
  ])(
    "allows $name without executing submitted source",
    ({ command }: { name: string; command: string }) => {
      const fixture = join(dir, "fixture.ts");
      writeFileSync(fixture, "AGENTS.md\n");
      expect(runHook(bash(command)).status).toBe(0);
      expect(readFileSync(fixture, "utf8")).toBe("AGENTS.md\n");
    },
  );

  // #1330: destination-based rule; no Markdown write. These programs only write
  // a literal non-Markdown path, so deviations from the old template shape are fine.
  // Covers: #1330
  const TABLE_121 = [
    {
      name: "extra call",
      source: PATH_SOURCE.replace("text = text.replace", 'print("hostile")\ntext = text.replace'),
    },
    {
      name: "different text binding",
      source: PATH_SOURCE.replace("text = text.replace", "other = text.replace"),
    },
    {
      name: "nonlocal write content",
      source: PATH_SOURCE.replace("p.write_text(text", 'p.write_text("AGENTS.md"'),
    },
    { name: "nonUTF8 read", source: PATH_SOURCE.replace('encoding="utf-8"', 'encoding="latin1"') },
    { name: "additional write", source: PATH_SOURCE + '\np.write_text(text, encoding="utf-8")' },
  ];
  beforeAll(
    () => primeHook(TABLE_121.map(({ source }) => bash(pathCommand(source)))),
    PRIME_TIMEOUT_MS,
  );
  it.each(TABLE_121)("allows $name (#1330)", ({ source }: { name: string; source: string }) => {
    expect(runHook(bash(pathCommand(source))).status).toBe(0);
  });

  // Covers: R3, R4
  const TABLE_141 = [
    { name: "Markdown destination", source: PATH_SOURCE.replace('"fixture.ts"', '"notes.md"') },
    { name: "mixed case mdx", source: PATH_SOURCE.replace('"fixture.ts"', '"NOTES.MdX"') },
    {
      name: "decoded Unicode Markdown",
      source: PATH_SOURCE.replace('"fixture.ts"', '"notes.\\u006dd"'),
    },
    {
      name: "dynamic concatenation",
      source: PATH_SOURCE.replace('"fixture.ts"', '"fixture." + "ts"'),
    },
    { name: "formatted destination", source: PATH_SOURCE.replace('"fixture.ts"', 'f"fixture.ts"') },
    {
      name: "destination callback",
      source: PATH_SOURCE.replace('"fixture.ts"', "get_destination()"),
    },
    {
      name: "path rebinding",
      source: PATH_SOURCE.replace("p.write_text", 'p = Path("notes.md")\np.write_text'),
    },
    {
      name: "constructor shadow",
      source: PATH_SOURCE.replace("p = Path", "Path = dangerous\np = Path"),
    },
    {
      name: "import alias",
      source: PATH_SOURCE.replace("from pathlib import Path", "from pathlib import Path as Other"),
    },
    {
      name: "extra import",
      source: PATH_SOURCE.replace(
        "from pathlib import Path",
        "from pathlib import Path\nimport os",
      ),
    },
    {
      name: "replacement callback",
      source: PATH_SOURCE.replace('"instructions.md"', "callback()"),
    },
    { name: "lambda replacement", source: PATH_SOURCE.replace('"instructions.md"', 'lambda: "x"') },
    {
      name: "different replacement receiver",
      source: PATH_SOURCE.replace("text.replace", "other.replace"),
    },
    {
      name: "different write destination",
      source: PATH_SOURCE.replace("p.write_text(text", "other.write_text(text"),
    },
    {
      name: "hostile side effect",
      source: PATH_SOURCE + '\n__import__("pathlib").Path("should-not-exist").write_text("x")',
    },
    {
      name: "command byte cap",
      source: PATH_SOURCE.replace('"instructions.md"', JSON.stringify("x".repeat(17000))),
    },
    {
      name: "AST node cap",
      source: PATH_SOURCE.replace(
        "p.write_text(text",
        'text=text.replace("a","b")\n'.repeat(420) + "p.write_text(text",
      ),
    },
    {
      name: "nested unsupported AST",
      source: PATH_SOURCE.replace('"fixture.ts"', "[".repeat(17) + '"fixture.ts"' + "]".repeat(17)),
    },
    { name: "malformed Python", source: PATH_SOURCE + "\ninvalid Python(" },
  ];
  beforeAll(
    () => primeHook(TABLE_141.map(({ source }) => bash(pathCommand(source)))),
    PRIME_TIMEOUT_MS,
  );
  it.each(TABLE_141)("retains denial for $name", ({ source }: { name: string; source: string }) => {
    const result = runHook(bash(pathCommand(source)));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
    expect(() => readFileSync(join(dir, "should-not-exist"))).toThrow();
  });

  // Covers: R3, R4
  const TABLE_217 = [
    { name: "prefix", command: `echo prefix; ${pathCommand()}` },
    { name: "newline suffix", command: `${pathCommand()}\necho suffix` },
    { name: "shell chain", command: `${pathCommand()} && echo suffix` },
    { name: "unquoted heredoc", command: pathCommand().replace("<<'PY'", "<<PY") },
    { name: "delimiter suffix", command: pathCommand().replace("\nPY", "\nPY; echo suffix") },
    {
      name: "shell expansion",
      command: `python3 -c "${PATH_SOURCE.replaceAll('"', "'")}; text = '$HOME'"`,
    },
  ];
  beforeAll(() => primeHook(TABLE_217.map(({ command }) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_217)(
    "retains denial for $name",
    ({ command }: { name: string; command: string }) => {
      expect(runHook(bash(command)).status).toBe(2);
    },
  );

  // Covers: R3, R4
  it("fails closed for malformed, failed and unavailable analyzer outcomes", () => {
    const bin = join(dir, "python-bin");
    mkdirSync(bin);
    const executable = join(bin, "python3");
    for (const outcome of ["echo MALFORMED\nexit 0", "exit 7", "exit 127"]) {
      writeFileSync(executable, `#!/bin/sh\n${outcome}\n`);
      chmodSync(executable, 0o755);
      const result = runHook(bash(pathCommand()), bin);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("markdownRequests");
    }
  });
});

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
  const TABLE_292 = [
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
  ];
  beforeAll(() => primeHook(TABLE_292.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_292)("blocks an interpreter write: %s", (command: string): void => {
    const result = runHook(bash(command));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
  });

  const TABLE_310 = [
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
  ];
  beforeAll(() => primeHook(TABLE_310.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_310)("allows a read or non-Markdown write: %s", (command: string): void => {
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

// Submitted source remains hook payload data, including its Git calls and JSON read.
const PYTHON_PROGRAM = `python3 - <<'PY'
import json, subprocess
from pathlib import Path
root = Path.cwd()
runtime = json.loads((root / 'probe.json').read_text())
report = {'worktree': str(root), 'repo': runtime['repo'], 'results': runtime['results'], 'branch': subprocess.check_output(['git', 'branch', '--show-current'], text=True).strip(), 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'markdownRequests': [{'path': 'docs/task.md', 'evidence': 'NOTES.MDX'}]}
(root / 'impl.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\\n')
print('handoff written')
PY`;

describe.each(["claude", "codex"] as const)("closed Python JSON handoff — %s", (engine) => {
  it.each([
    PYTHON_PROGRAM,
    PYTHON_PROGRAM + "\n",
    PYTHON_PROGRAM.replace("impl.json", "impl.JSON"),
    PYTHON_PROGRAM.replace(
      "report =",
      `#${"x".repeat(16384 - PYTHON_PROGRAM.length - 2)}\nreport =`,
    ),
    PYTHON_PROGRAM.replace("'docs/task.md'", `${"[".repeat(13)}'docs/task.md'${"]".repeat(13)}`),
  ])("allows metadata without executing reads, Git queries or writes", (command: string): void => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    // Codex normalization calls git -C ...; only submitted argv can mark execution.
    writeFileSync(
      git,
      '#!/bin/sh\ncase "$*" in "branch --show-current"|"rev-parse HEAD") touch git-called;; esac\nexit 99\n',
    );
    chmodSync(git, 0o755);
    writeFileSync(join(dir, "probe.json"), "not JSON: must not be read");
    expect(runHook(bash(command), bin, true, engine).status).toBe(0);
    expect(readFileSync(join(dir, "probe.json"), "utf8")).toBe("not JSON: must not be read");
    expect(() => readFileSync(join(dir, "impl.json"))).toThrow();
    expect(() => readFileSync(join(dir, "git-called"))).toThrow();
  });

  // #1330: destination-based rule; no Markdown write.
  // Covers: #1330
  const TABLE_375 = [
    PYTHON_PROGRAM.replace(
      "print('handoff written')",
      "(root / 'other.json').write_text('{}')\nprint('handoff written')",
    ),
    PYTHON_PROGRAM.replace(".strip()", ".strip('x')"),
    PYTHON_PROGRAM.replace("str(root)", "str(root, 'utf8')"),
    PYTHON_PROGRAM.replace("'docs/task.md'", "[x for x in ['docs/task.md']]"),
    PYTHON_PROGRAM.replace("['git', 'rev-parse', 'HEAD']", "['git', 'status', '--short']"),
  ];
  beforeAll(
    () =>
      primeHook(
        TABLE_375.map((command) => bash(command)),
        engine,
      ),
    PRIME_TIMEOUT_MS,
  );
  it.each(TABLE_375)("allows a destination-safe variant %#", (command: string): void => {
    expect(runHook(bash(command), undefined, true, engine).status).toBe(0);
  });

  // Covers: #1330
  const TABLE_389 = [
    PYTHON_PROGRAM.replace("['git', 'rev-parse', 'HEAD']", "['git', 'checkout', 'HEAD']"),
    PYTHON_PROGRAM.replace("['git', 'rev-parse', 'HEAD']", "['git', 'diff', '--output=x.json']"),
    PYTHON_PROGRAM.replace("['git', 'rev-parse', 'HEAD']", "['rm', '-rf', 'x']"),
  ];
  beforeAll(
    () =>
      primeHook(
        TABLE_389.map((command) => bash(command)),
        engine,
      ),
    PRIME_TIMEOUT_MS,
  );
  it.each(TABLE_389)("denies subprocess outside read-only git %#", (command: string): void => {
    expect(runHook(bash(command), undefined, true, engine).status).toBe(2);
  });

  const TABLE_397 = [
    PYTHON_PROGRAM.replace("'impl.json'", "'notes.md'"),
    PYTHON_PROGRAM.replace("'impl.json'", "'NOTES.MDX'"),
    PYTHON_PROGRAM.replace("'impl.json'", "'notes\\u002emd'"),
    PYTHON_PROGRAM.replace("'impl.json'", "'impl.json\\x00'"),
    PYTHON_PROGRAM.replace("'impl.json'", "destination"),
    PYTHON_PROGRAM.replace("'impl.json'", "f'impl.json'"),
    PYTHON_PROGRAM.replace("report =", "root = Path('notes.md')\nreport ="),
    PYTHON_PROGRAM.replace("report =", "alias = Path\nreport ="),
    PYTHON_PROGRAM.replace("report =", "import os\nreport ="),
    PYTHON_PROGRAM.replace("report =", "open('notes.md', 'w').write('x')\nreport ="),
    PYTHON_PROGRAM.replace(
      "print('handoff written')",
      "(root / 'other.md').write_text('x')\nprint('handoff written')",
    ),
    PYTHON_PROGRAM.replace("'--show-current'", "'--delete'"),
    PYTHON_PROGRAM.replace("text=True", "text=True, shell=True"),
    PYTHON_PROGRAM.replace("text=True", "text=True, cwd=root"),
    PYTHON_PROGRAM.replace("text=True", "text=True, env={}"),
    PYTHON_PROGRAM.replace("['git', 'rev-parse', 'HEAD']", "argv"),
    PYTHON_PROGRAM.replace("runtime['repo']", "runtime[key]"),
    PYTHON_PROGRAM.replace("'docs/task.md'", "danger('docs/task.md')"),
    PYTHON_PROGRAM.replace("'docs/task.md'", "'''\nPY\ntouch notes.md\n'''"),
    PYTHON_PROGRAM.slice(0, -2),
    PYTHON_PROGRAM + " ",
    PYTHON_PROGRAM + "\necho done",
    PYTHON_PROGRAM + " | cat",
    PYTHON_PROGRAM.replace("<<'PY'", "<<PY"),
    PYTHON_PROGRAM.replace("<<'PY'", "<<-'PY'"),
    PYTHON_PROGRAM.replace("python3 -", "env python3 -"),
    PYTHON_PROGRAM.replace("python3 -", "python3 - $(echo x)"),
    PYTHON_PROGRAM.replaceAll("\n", "\r\n"),
    PYTHON_PROGRAM.replace("report =", "report = broken syntax\nreport ="),
    PYTHON_PROGRAM.replace("'docs/task.md'", `'${"x".repeat(17000)}docs/task.md'`),
    PYTHON_PROGRAM.replace(
      "report =",
      `#${"x".repeat(16385 - PYTHON_PROGRAM.length - 2)}\nreport =`,
    ),
    PYTHON_PROGRAM.replace("'docs/task.md'", `[${"0,".repeat(4100)}'docs/task.md']`),
    PYTHON_PROGRAM.replace("'docs/task.md'", `${"[".repeat(17)}'docs/task.md'${"]".repeat(17)}`),
  ];
  beforeAll(
    () =>
      primeHook(
        TABLE_397.map((command) => bash(command)),
        engine,
      ),
    PRIME_TIMEOUT_MS,
  );
  it.each(TABLE_397)("denies unsupported complete programs: %s", (command: string): void => {
    const result = runHook(bash(command), undefined, true, engine);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("markdownRequests");
    expect(() => readFileSync(join(dir, "impl.json"))).toThrow();
  });

  it("fails closed for malformed output and analyzer errors", () => {
    const executable = join(dir, "python3");
    for (const script of ["echo MALFORMED\nexit 0", "exit 7"]) {
      writeFileSync(executable, `#!/bin/sh\n${script}\n`);
      chmodSync(executable, 0o755);
      expect(runHook(bash(PYTHON_PROGRAM), dir, true, engine).status).toBe(2);
    }
  });

  it("fails closed when controlled shell resolution cannot find Python", () => {
    // PATH alone is insufficient: /usr/bin may contain Python on this host.
    const prelude =
      'command() { if [ "$1" = "-v" ] && [ "$2" = "python3" ]; then return 1; fi; builtin command "$@"; }';
    expect(runHook(bash(PYTHON_PROGRAM), undefined, true, engine, prelude).status).toBe(2);
  });
});

describe("implementer-no-markdown hook — bounded JSON metadata exception", () => {
  const TABLE_462 = [
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
  ];
  beforeAll(() => primeHook(TABLE_462.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_462)(
    "recognizes a complete JSON-only program as inert payload data",
    (command: string): void => {
      const marker = join(dir, "should-not-exist");
      const result = runHook(bash(command));
      expect(result.status).toBe(0);
      expect(() => readFileSync(marker)).toThrow();
      expect(() => readFileSync(join(dir, "state/impl.json"))).toThrow();
    },
  );

  const TABLE_481 = [
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
  ];
  beforeAll(() => primeHook(TABLE_481.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_481)("denies unsupported or hostile mixed program %s", (command: string): void => {
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

function edit(filePath: string, tool = "Edit", agentType: string | null = "implementer"): Payload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: filePath },
    ...(agentType ? { agent_type: agentType } : {}),
  };
}

describe("implementer-no-markdown hook — AI doctrine exception (R49)", () => {
  const DOCTRINE = [
    "packages/core/core-assets/agents/implementer.md",
    "packages/core/core-assets/skills/x.md",
    "packages/core/core-assets/managed/y.md",
    "packages/core/core-assets/hooks/z.mdx",
    ".claude/agents/implementer.md",
    ".claude/skills/verify/SKILL.md",
    ".claude/context/a.md",
    ".codex/agents/implementer.md",
    ".codex/orchestrator.md",
    ".agents/skills/s/SKILL.md",
    ".pi/navori/hooks/h.md",
  ];
  const BLOCKED = [
    "progress/current.md",
    "specs/0052/tasks.md",
    "docs/DIRECTION.md",
    "README.md",
    ".navori/state/handoffs/x.md",
    ".claude/progress/impl_x.md",
    ".claude/skills/../../progress/current.md",
    "../outside/.claude/agents/a.md",
    ".claude/agents-evil/a.md",
  ];

  // Covers: R49
  it("el implementer edita doctrina de IA y sigue bloqueado en progress, specs, docs, rutas con .. y Bash", () => {
    for (const path of DOCTRINE) {
      for (const tool of ["Write", "Edit"]) {
        expect(runHook(edit(path, tool)).status, `${tool} ${path}`).toBe(0);
      }
    }
    expect(
      runHook({
        hook_event_name: "PreToolUse",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: ".claude/agents/n.md" },
        agent_type: "implementer",
      }).status,
    ).toBe(0);
    for (const path of BLOCKED) {
      expect(runHook(edit(path)).status, path).toBe(2);
    }
    // The message names the allowed prefixes and the markdownRequests route.
    const msg = runHook(edit("docs/x.md"));
    expect(msg.stderr).toContain(".claude/agents/");
    expect(msg.stderr).toContain("packages/core/core-assets/agents/");
    expect(msg.stderr).toContain("markdownRequests");
    // Bash forms never relax, even onto a doctrine path.
    expect(runHook(bash("echo hi > .claude/agents/a.md")).status).toBe(2);
    expect(runHook(bash("tee .claude/skills/s/SKILL.md")).status).toBe(2);
  });

  // Covers: R49
  it("trims an absolute path against the repo root and blocks one outside it", () => {
    const prelude = `CLAUDE_PROJECT_DIR=${JSON.stringify(dir)}; export CLAUDE_PROJECT_DIR`;
    const run = (p: string): number => runHook(edit(p), undefined, true, "claude", prelude).status;
    expect(run(`${dir}/.claude/agents/a.md`)).toBe(0);
    expect(run(`${dir}/docs/a.md`)).toBe(2);
    expect(run(`${dir}/.claude/../progress/current.md`)).toBe(2);
    expect(run("/elsewhere/.claude/agents/a.md")).toBe(2);
    expect(run(`${dir}-sibling/.claude/agents/a.md`)).toBe(2);
  });

  // Covers: R49
  it("checks every apply_patch path: doctrine passes, a mixed patch with progress blocks (Codex)", () => {
    const patch = (...paths: string[]): Payload => ({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command: `${paths.map((p) => `*** Update File: ${p}\n@@\n-a\n+b`).join("\n")}\n`,
      },
      agent_type: "implementer",
    });
    const run = (p: Payload): number => runHook(p, undefined, true, "codex").status;
    expect(run(patch(".codex/agents/a.md", ".agents/skills/s/SKILL.md"))).toBe(0);
    expect(run(patch(".codex/agents/a.md", "progress/current.md"))).toBe(2);
  });

  // Covers: R49
  it("leaves other roles and the main thread unchanged", () => {
    expect(runHook(edit("progress/current.md", "Edit", "scribe")).status).toBe(0);
    expect(runHook(edit("progress/current.md", "Edit", null)).status).toBe(0);
  });
});

// Covers: #1330
describe("implementer-no-markdown hook — registered worktrees (#1330)", () => {
  let root: string;
  let host: string;
  let sibling: string;
  let other: string;
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const init = (path: string): void => {
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    git(
      path,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
  };
  beforeEach(() => {
    root = realpathSync(dir);
    host = join(root, "host");
    sibling = join(root, "sibling");
    other = join(root, "other");
    init(host);
    git(host, "worktree", "add", "-q", "-b", "delivery", sibling);
    init(other);
  });
  const prelude = (): string =>
    `CLAUDE_PROJECT_DIR=${JSON.stringify(host)}; export CLAUDE_PROJECT_DIR`;
  const run = (path: string, tool = "Edit", extra = ""): number =>
    runHook({ ...edit(path, tool), cwd: host }, undefined, true, "claude", `${prelude()}\n${extra}`)
      .status;
  const patch = (...headers: string[]): Payload => ({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: `${headers.join("\n")}\n` },
    agent_type: "implementer",
    cwd: host,
  });
  const codex = (p: Payload): number => runHook(p, undefined, true, "codex").status;

  it("allows every doctrine prefix in a registered sibling worktree", () => {
    for (const rel of [
      "packages/core/core-assets/agents/x.md",
      "packages/core/core-assets/skills/x.md",
      "packages/core/core-assets/managed/x.md",
      "packages/core/core-assets/hooks/x.mdx",
      ".claude/agents/x.md",
      ".claude/skills/s/SKILL.md",
      ".claude/context/x.md",
      ".claude/hooks/x.md",
      ".codex/agents/x.md",
      ".codex/hooks/x.md",
      ".codex/orchestrator.md",
      ".agents/skills/s/SKILL.md",
      ".pi/navori/x.md",
    ]) {
      for (const tool of ["Write", "Edit"]) expect(run(`${sibling}/${rel}`, tool), rel).toBe(0);
    }
    expect(
      runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "NotebookEdit",
          tool_input: { notebook_path: `${sibling}/.claude/agents/n.md` },
          agent_type: "implementer",
          cwd: host,
        },
        undefined,
        true,
        "claude",
        prelude(),
      ).status,
    ).toBe(0);
    // Controls: host-relative, host-absolute, and a session sitting inside the sibling.
    expect(run(".claude/agents/a.md")).toBe(0);
    expect(run(`${host}/.claude/agents/a.md`)).toBe(0);
    expect(
      runHook(
        { ...edit(`${sibling}/.claude/agents/a.md`), cwd: sibling },
        undefined,
        true,
        "claude",
        `CLAUDE_PROJECT_DIR=${JSON.stringify(sibling)}; export CLAUDE_PROJECT_DIR`,
      ).status,
    ).toBe(0);
  });

  it("checks every apply_patch header against registered worktrees (Codex)", () => {
    const doc = `${sibling}/.codex/agents/a.md`;
    expect(codex(patch(`*** Add File: ${doc}`, "+x"))).toBe(0);
    expect(codex(patch(`*** Update File: ${doc}`, "@@", "-a", "+b"))).toBe(0);
    expect(codex(patch(`*** Delete File: ${doc}`))).toBe(0);
    expect(
      codex(patch(`*** Update File: ${doc}`, `*** Move to: ${sibling}/.agents/skills/s/SKILL.md`)),
    ).toBe(0);
    expect(
      codex(patch(`*** Add File: ${doc}`, "+x", `*** Add File: ${host}/.claude/agents/h.md`, "+y")),
    ).toBe(0);
    expect(
      codex(patch(`*** Add File: ${doc}`, "+x", `*** Add File: ${sibling}/docs/x.md`, "+y")),
    ).toBe(2);
    expect(codex(patch(`*** Update File: ${doc}`, "*** Move to: progress/x.md"))).toBe(2);
  });

  it("blocks sibling paths outside the closed doctrine list", () => {
    for (const rel of [
      "docs/x.md",
      "progress/current.md",
      "specs/0052/tasks.md",
      ".navori/state/handoffs/x.md",
      ".claude/agents-evil/a.md",
      "packages/core/core-assets/agentsX/a.md",
    ]) {
      expect(run(`${sibling}/${rel}`), rel).toBe(2);
    }
  });

  it("blocks doctrine in an unrelated repo, a non-git dir and unregistered checkouts", () => {
    expect(run(`${other}/.claude/agents/a.md`)).toBe(2);
    mkdirSync(join(root, "plain/.claude/agents"), { recursive: true });
    expect(run(`${root}/plain/.claude/agents/a.md`)).toBe(2);
    // A clone shares no worktree entry with the host.
    git(root, "clone", "-q", host, "clone");
    expect(run(`${root}/clone/.claude/agents/a.md`)).toBe(2);
    // A worktree directory removed behind git's back is not an existing checkout.
    rmSync(sibling, { recursive: true, force: true });
    expect(run(`${sibling}/.claude/agents/a.md`)).toBe(2);
  });

  it("blocks traversal and symlinks fail-closed", () => {
    expect(run(`${sibling}/.claude/skills/../../progress/current.md`)).toBe(2);
    expect(run(`${host}/../sibling/.claude/agents/a.md`)).toBe(2);
    symlinkSync(sibling, join(host, "link"));
    expect(run(`${host}/link/.claude/agents/a.md`)).toBe(2);
    // Symlink leaf pointing at a non-doctrine file.
    mkdirSync(join(sibling, "docs"), { recursive: true });
    writeFileSync(join(sibling, "docs/x.md"), "x");
    mkdirSync(join(sibling, ".claude/agents"), { recursive: true });
    symlinkSync(join(sibling, "docs/x.md"), join(sibling, ".claude/agents/leaf.md"));
    expect(run(`${sibling}/.claude/agents/leaf.md`)).toBe(2);
    // The sibling root itself reached through a symlinked ancestor.
    symlinkSync(root, join(root, "via"));
    expect(run(`${root}/via/sibling/.claude/agents/a.md`)).toBe(2);
  });

  it("fails closed when git is unavailable, without regressing host paths", () => {
    const noGit = "git() { return 127; }";
    expect(run(`${sibling}/.claude/agents/a.md`, "Edit", noGit)).toBe(2);
    expect(run(`${host}/.claude/agents/a.md`, "Edit", noGit)).toBe(0);
    expect(run(".claude/agents/a.md", "Edit", noGit)).toBe(0);
  });

  it("leaves other roles alone and never relaxes Bash forms", () => {
    const asRole = (agent: string | null): number =>
      runHook(
        { ...edit(`${sibling}/docs/x.md`, "Edit", agent), cwd: host },
        undefined,
        true,
        "claude",
        prelude(),
      ).status;
    expect(asRole("scribe")).toBe(0);
    expect(asRole(null)).toBe(0);
    for (const cmd of [
      `echo hi > ${sibling}/.claude/agents/a.md`,
      `tee ${sibling}/.claude/agents/a.md`,
      `cp a ${sibling}/.claude/agents/a.md`,
    ]) {
      expect(runHook({ ...bash(cmd), cwd: host }).status, cmd).toBe(2);
    }
  });
});

// Covers: #1330
describe("implementer-no-markdown hook — destination-based interpreter rule (#1330)", () => {
  const heredoc = (source: string): string => `python3 - <<'PY'\n${source}\nPY`;
  const DATA = '{"filesTouched": ["docs/a.md", "specs/x/tasks.mdx"]}';
  // The text gate needs a Markdown literal plus a write API; this prefix makes sure it fires so
  // the AST analyzer decides on the rest of the program.
  const risky = (source: string): string =>
    heredoc(`NOTE = "docs/a.md"\nopen("keep.json", "w")\n${source}`);

  const TABLE_964 = [
    heredoc(
      `import json\nfrom pathlib import Path\nd = ${DATA}\nPath(".navori/state/handoffs/impl_x.json").write_text(json.dumps(d))`,
    ),
    `python3 -c 'import json; open("out/impl_x.json", "w").write(json.dumps(${DATA}))'`,
    heredoc(`import json\nd = ${DATA}\njson.dump(d, open("x.json", "w"))`),
    heredoc(`import json\nd = ${DATA}\nwith open("x.json", "w") as f:\n    json.dump(d, f)`),
    `node -e 'require("fs").writeFileSync("out/impl_x.json", JSON.stringify({f:["docs/a.md"]}))'`,
    `node -e 'const d={f:["docs/a.md"]};const p="x.json";require("node:fs").writeFileSync(p, JSON.stringify(d, null, 2) + "\\n");'`,
  ];
  beforeAll(() => primeHook(TABLE_964.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_964)(
    "allows a JSON write whose data mentions Markdown: %#",
    (command: string): void => {
      expect(runHook(bash(command)).status).toBe(0);
    },
  );

  // Covers: #1330
  const TABLE_978 = [
    heredoc(`import shutil\nshutil.copy("x.json", "y.md")`),
    heredoc(`import shutil\nshutil.move("x.json", "y.md")`),
    heredoc(`import os\nos.rename("x.json", "y.md")`),
    heredoc(`import os\nos.replace("x.json", "y.md")`),
    heredoc(`from pathlib import Path\nPath("x.json").rename("y.md")`),
    heredoc(`from pathlib import Path\nPath("x.json").replace("y.md")`),
    `node -e 'require("fs").copyFileSync("x.json", "y.md")'`,
    `node -e 'require("fs").renameSync("x.json", "y.md")'`,
  ];
  beforeAll(() => primeHook(TABLE_978.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_978)(
    "denies copy/move onto Markdown without a write clue: %#",
    (command: string): void => {
      const result = runHook(bash(command));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("markdownRequests");
    },
  );

  const TABLE_993 = [
    risky(`open("notes.md", "w").write("x")`),
    risky(`from pathlib import Path\nPath("a.md").write_text("x")`),
    risky(`open(sys.argv[1], "w").write("x")`),
    risky(`d = "no" + "tes.md"\nopen(d, "w").write("x")`),
    risky(`n = "notes"\nopen(f"{n}.md", "w").write("x")`),
    risky(`open("x.json", "w").write("{}")\nopen("notes.md", "w").write("x")`),
    risky(`import shutil\nshutil.copy("x.json", "y.md")`),
    risky(`import subprocess\nsubprocess.run(["cp", "x.json", "y.md"])`),
    risky(`import os\nos.rename("x.json", "y.md")`),
    risky(`from pathlib import Path\nPath("x.json").rename("y.md")`),
    risky(`from pathlib import Path\nPath("x.json").replace("y.md")`),
    risky(`open("NOTES.MD", "w").write("x")`),
    risky(`open("notes\\u002emd", "w").write("x")`),
    risky(`exec("open('notes.md','w')")`),
    risky(`__import__("os").system("touch notes.md")`),
    // The shell closes the heredoc at the first delimiter line.
    `python3 - <<'PY'\nopen("x.json", "w").write("x")\nPY\ntouch notes.md\nPY`,
    risky(`open("x.json", "w").write("${"x".repeat(17000)}")`),
    risky(`open("x.json", "w"`),
    `ruby -e 'File.write("x.json", "docs/a.md")'`,
    `perl -e 'open(my $f, ">", "x.json"); print $f "docs/a.md"'`,
    `deno eval 'Deno.writeTextFileSync("x.json", "docs/a.md")'`,
    `bun -e 'Bun.write("x.json", "docs/a.md")'`,
    `node -e 'require("fs").writeFileSync("notes.md", JSON.stringify({}))'`,
    `node -e 'const p="notes.md";require("fs").writeFileSync(p, JSON.stringify({}))'`,
    `node -e 'require("fs").writeFileSync("x.json", JSON.stringify({}));require("fs").writeFileSync("n.md", "x")'`,
    `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({f:["a.md"]}))'`,
  ];
  beforeAll(() => primeHook(TABLE_993.map((command) => bash(command))), PRIME_TIMEOUT_MS);
  it.each(TABLE_993)(
    "denies a program that can write Markdown or is not analyzable: %#",
    (command: string): void => {
      const result = runHook(bash(command));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("markdownRequests");
    },
  );
});

// Mutation smoke (spec 0054 D4): a batch that cannot see a verdict change would
// pass vacuously, so invert every block exit in a temp copy and require the
// batched verdict to follow.
// Covers: R3, R4
describe("implementer-no-markdown hook — batch harness smoke", () => {
  it("a hook with its block exit inverted flips the batched verdict", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-no-md-mut-"));
    const original = installHook(root, "claude", "");
    const mutated = join(root, "mutated.sh");
    writeFileSync(mutated, readFileSync(original, "utf-8").replace(/exit 2/g, "exit 0"));
    chmodSync(mutated, 0o755);
    const blocked: Payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "notes.md", content: "x" },
      agent_type: "implementer",
    };
    const c = { ...batchCase(blocked, DEFAULT_NODE_PATH, true), cwd: root };
    try {
      for (const shell of HOOK_SHELLS) {
        const real = createHookBatch(original);
        const flipped = createHookBatch(mutated);
        real.prime([shell], [c]);
        flipped.prime([shell], [c]);
        expect(real.run(shell, c).status).toBe(2);
        expect(flipped.run(shell, c).status).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
