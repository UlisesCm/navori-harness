import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellSensitive, type HookShell } from "../lib/__tests__/helpers/shells.ts";

/**
 * `payload_fields` (`_partials/extract-cmd.sh`, spec 0054 R22, D10): N fields with ONE
 * jq (or node) call, and today's field-by-field extraction whenever the single read
 * cannot be trusted. The payload is model-controlled text, so the failure to rule
 * out is a field SHIFT: a NUL inside `command` must never move `cwd` or the role
 * into another variable.
 *
 * Covers: R22
 */

const PARTIAL = resolve(
  fileURLToPath(
    new URL("../../../core/core-assets/hooks/_partials/extract-cmd.sh", import.meta.url),
  ),
);
const SEP = "\u001e";
const SPECS = "cmd=tool_input.command cwd=cwd sid=session_id bg=tool_input.run_in_background";

function which(name: string): string {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf-8" }).stdout.trim();
  if (!found) throw new Error(`${name} not found`);
  return found;
}

/** A PATH directory holding only the named tools (plus an optional call counter for jq). */
function toolDir(tools: string[], countJq = false): { bin: string; jqCalls: () => number } {
  const bin = mkdtempSync(join(tmpdir(), "navori-pf-bin-"));
  const log = join(bin, "jq-calls");
  for (const tool of tools) {
    if (tool === "jq" && countJq) {
      writeFileSync(join(bin, "jq"), `#!/bin/sh\necho x >> '${log}'\nexec '${which("jq")}' "$@"\n`);
      chmodSync(join(bin, "jq"), 0o755);
    } else symlinkSync(which(tool), join(bin, tool));
  }
  return {
    bin,
    jqCalls: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").length : 0),
  };
}

/** Runs `payload_fields` over `payload`; the variables come back separated by U+001E. */
function extract(shell: HookShell, payload: string, bin: string): string[] {
  const script = [
    `. '${PARTIAL}'`,
    `payload=$1`,
    `payload_fields ${SPECS}`,
    `printf '%s${SEP}%s${SEP}%s${SEP}%s' "$cmd" "$cwd" "$sid" "$bg"`,
  ].join("\n");
  const r = spawnSync(which(shell), ["-c", script, "x", payload], {
    encoding: "utf-8",
    env: { PATH: bin },
  });
  return r.stdout.split(SEP);
}

const payloadOf = (command: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    tool_input: { command, run_in_background: false },
    cwd: "/work dir",
    session_id: "s-1",
    ...extra,
  });

describe.each(
  shellSensitive(
    "payload_fields is shell code: `printf -v`, `read -d ''` and NUL handling differ in zsh (#391)",
  ),
)("payload_fields under %s", (shell) => {
  const ENGINES = [
    ["jq", ["jq", "sed"]],
    ["node", ["node", "sed"]],
  ] as const;

  // Covers: R22
  it.each(ENGINES)(
    "valores con salto de línea, comillas y NUL; jq y node; caída a extracción por campo (%s)",
    (_engine, tools) => {
      const { bin } = toolDir([...tools]);
      try {
        // Newlines (inner kept, trailing stripped like `$(…)`), quotes and unicode.
        expect(extract(shell, payloadOf('echo "a b"\n\tline2\n\n'), bin)).toEqual([
          'echo "a b"\n\tline2',
          "/work dir",
          "s-1",
          "",
        ]);
        expect(extract(shell, payloadOf("printf 'ñ ✓ \\\\'"), bin)[0]).toBe("printf 'ñ ✓ \\\\'");
        // `true` prints as `true`; `false` and absent fields are empty, as with `jq -r`.
        expect(
          extract(
            shell,
            payloadOf("x", { tool_input: { command: "x", run_in_background: true } }),
            bin,
          ),
        ).toEqual(["x", "/work dir", "s-1", "true"]);
        expect(extract(shell, "{}", bin)).toEqual(["", "", "", ""]);
        expect(extract(shell, "", bin)).toEqual(["", "", "", ""]);

        // A NUL inside `command` (`\u0000` is valid JSON) must not shift the other fields:
        // the single read refuses it and the field-by-field read runs, as today.
        const poisoned = extract(
          shell,
          payloadOf("echo \\u0000 rm -rf /").replace("\\\\u", "\\u"),
          bin,
        );
        expect(poisoned[1]).toBe("/work dir");
        expect(poisoned[2]).toBe("s-1");
        // `false` is "" under jq and "false" under today's node per-field read.
        expect(["", "false"]).toContain(poisoned[3]);
        expect(poisoned[0]).not.toContain(SEP);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  // Covers: R22
  it("una sola invocación de jq, y la caída por campo solo ante un NUL", () => {
    const { bin, jqCalls } = toolDir(["jq", "sed"], true);
    try {
      extract(shell, payloadOf("echo hi"), bin);
      expect(jqCalls()).toBe(1);
      const nul = payloadOf("x").replace('"command":"x"', '"command":"a\\u0000b"');
      expect(nul).toContain("\\u0000");
      extract(shell, nul, bin);
      // 1 refused single read + 4 field-by-field reads.
      expect(jqCalls()).toBe(1 + 1 + 4);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  // Covers: R22
  it("sin jq ni node usa la extracción por campo con sed", () => {
    const { bin } = toolDir(["sed"]);
    try {
      expect(extract(shell, payloadOf("echo hi"), bin).slice(0, 3)).toEqual([
        "echo hi",
        "/work dir",
        "s-1",
      ]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
