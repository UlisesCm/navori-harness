import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * activation-verify.mjs end to end on a fabricated tree: one active hook registered in Claude and
 * Pi, and a fake `navori-rust` that embeds the manifest bytes (what the real binary does).
 */

interface Row {
  hook: string;
  engine: string;
  ok: boolean;
  decision?: string;
  problems: string[];
  notes?: string[];
}
interface Result {
  rows: Row[];
}

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
const script = join(repo, "scripts", "js", "activation-verify.mjs");
const MANIFEST = `${JSON.stringify({ hooks: { demo: { mode: "active", gating: true, impl: "sha256:0" } } })}\n`;
const BLOCK = [
  "# navori:native-runtime start",
  "nv_native=$(command -v navori-rust) || exit 1",
  'nv_out=$("$nv_native" hook --via-script "$0" "$@"); nv_rc=$?; printf %s "$nv_out"; exit "$nv_rc"',
  "# navori:native-runtime end",
].join("\n");
const WRAPPER = `#!/bin/bash\n${BLOCK}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

/** A checkout-like tree plus a bin dir holding a fake `navori-rust` running `body`. */
function fixture(body: string, { piScript = true } = {}): { root: string; bin: string } {
  const base = mkdtempSync(join(tmpdir(), "activation-verify-"));
  roots.push(base);
  const root = join(base, "root");
  const bin = join(base, "bin");
  write(join(root, "crates", "ported.json"), MANIFEST);
  write(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            // Claude runs the block inline, as navori renders it, before the script.
            hooks: [
              {
                type: "command",
                command: `${BLOCK}\nbash "$CLAUDE_PROJECT_DIR/.claude/hooks/demo.sh"`,
              },
            ],
          },
        ],
      },
    }),
  );
  write(join(root, ".claude", "hooks", "demo.sh"), WRAPPER, 0o755);
  if (piScript) write(join(root, ".pi", "navori", "hooks", "demo.sh"), WRAPPER, 0o755);
  else mkdirSync(join(root, ".pi", "navori", "hooks"), { recursive: true });
  write(
    join(root, "packages", "cli", "src", "engines", "pi", "hook-bindings.ts"),
    'export const BINDINGS = [\n  { script: "demo", on: "tool_call", tools: ["bash"], },\n];\n',
  );
  // The manifest bytes inside a shell comment: the check looks for them in the binary file.
  write(join(bin, "navori-rust"), `#!/bin/sh\n: '${MANIFEST}'\n${body}\n`, 0o755);
  return { root, bin };
}

function run(
  root: string,
  bin: string,
  extra: string[] = [],
): { code: number | null; result: Result; ms: number } {
  const started = Date.now();
  const out = spawnSync(
    process.execPath,
    [script, "--root", root, "--runs", "2", "--json", ...extra],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeout: 60_000,
    },
  );
  if (out.status === 2) throw new Error(out.stderr);
  return { code: out.status, result: JSON.parse(out.stdout) as Result, ms: Date.now() - started };
}

describe("activation-verify", () => {
  it("pasa con el hook registrado y decidido en los dos engines", () => {
    const { root, bin } = fixture("exit 0");
    const { code, result } = run(root, bin, ["--engine", "claude", "--engine", "pi"]);
    expect(result.rows.map((r) => [r.engine, r.ok, r.problems])).toEqual([
      ["claude", true, []],
      ["pi", true, []],
    ]);
    expect(code).toBe(0);
  });

  it("falla si el script de Pi falta, en vez de saltarse el engine", () => {
    const { root, bin } = fixture("exit 0", { piScript: false });
    const { code, result } = run(root, bin);
    const pi = result.rows.find((r) => r.engine === "pi");
    expect(pi?.ok).toBe(false);
    expect(pi?.problems).toContain(".pi/navori/hooks/demo.sh missing");
    expect(code).toBe(1);
  });

  it("con --engine, un engine sin registro falla; sin --engine queda como nota", () => {
    const { root, bin } = fixture("exit 0");
    write(
      join(root, "packages", "cli", "src", "engines", "pi", "hook-bindings.ts"),
      "export const BINDINGS = [];\n",
    );
    const required = run(root, bin, ["--engine", "pi"]);
    expect(required.result.rows.find((r) => r.engine === "pi")).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/not registered on PreToolUse in pi/)],
    });
    expect(required.code).toBe(1);
    const optional = run(root, bin);
    expect(optional.result.rows.find((r) => r.engine === "pi")).toMatchObject({
      ok: true,
      notes: [expect.stringMatching(/not registered on PreToolUse in pi/)],
    });
    expect(optional.code).toBe(0);
  });

  it("un nativo colgado falla y no se cronometra", () => {
    const { root, bin } = fixture("exec sleep 30");
    const { code, result, ms } = run(root, bin, ["--engine", "claude", "--call-timeout", "1000"]);
    const claude = result.rows.find((r) => r.engine === "claude");
    expect(claude?.ok).toBe(false);
    expect(claude?.decision).toBe("unfinished");
    expect(claude?.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/did not finish within 1000 ms/)]),
    );
    expect(code).toBe(1);
    // --version plus two engines × two calls at 1 s each, not runs × the timeout or the sleep.
    expect(ms).toBeLessThan(15_000);
  }, 30_000);
});
