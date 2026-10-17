import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellSensitive } from "../../../lib/__tests__/helpers/shells.ts";

/** The batch driver is a shell script: subshell isolation, `$0` and `set -e` inheritance differ per shell. */
const BATCH_SHELLS = shellSensitive(
  "batch driver: subshell isolation, `$0` and `set -e`/`trap` inheritance are shell-specific",
);
import { createHookBatch, runHookBatch, runHookIsolated, type HookCase } from "../hook-batch.ts";

const dir = mkdtempSync(join(tmpdir(), "navori-hook-batch-test-"));

function writeHook(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

let echoHook = "";
beforeAll(() => {
  // Reads stdin, echoes it, reports env/cwd/$0 on stderr and exits with the
  // number on the first stdin line. `set -e` + a trap prove the driver's
  // state does not leak into, or out of, a case.
  echoHook = writeHook(
    "echo.sh",
    [
      "set -eu",
      "trap 'echo trap-ran >&2' EXIT",
      "IFS= read -r first || first=0",
      'cat; echo "env=${PROBE:-unset} cwd=$(basename "$PWD") zero=$(basename "$0")" >&2',
      'exit "$first"',
    ].join("\n"),
  );
});

describe("hook-batch", () => {
  // Covers: R7, R9
  it("el lote reporta exit, stdout y stderr por caso igual que un spawn aislado", () => {
    const cases: HookCase[] = [
      { input: "0\nok\n" },
      { input: "2\nblocked\n" },
      { input: "3\nenv\n", env: { PROBE: 'it\'s "quoted" $x' } },
      { input: "0\ncwd\n", cwd: dir },
      { input: "" },
    ];
    for (const shell of BATCH_SHELLS) {
      const batch = runHookBatch(echoHook, shell, cases);
      const isolated = cases.map((c) => runHookIsolated(echoHook, shell, c));
      expect(batch).toEqual(isolated);
      expect(batch.map((r) => r.status)).toEqual([0, 2, 3, 0, 0]);
    }
  });

  it("un hook que mata o reemplaza el driver hace fallar el lote", () => {
    const killer = writeHook("kill.sh", "kill -9 $$");
    for (const shell of BATCH_SHELLS) {
      expect(() => runHookBatch(killer, shell, [{ input: "a" }, { input: "b" }])).toThrow(
        /driver did not finish|never reported its delimiter/,
      );
    }
  });

  it("exec en un caso solo reemplaza su subshell", () => {
    const execer = writeHook(
      "exec.sh",
      "IFS= read -r l; if [ \"$l\" = x ]; then exec sh -c 'exit 7'; fi; exit 0",
    );
    for (const shell of BATCH_SHELLS) {
      const r = runHookBatch(execer, shell, [{ input: "x\n" }, { input: "y\n" }]);
      expect(r.map((x) => x.status)).toEqual([7, 0]);
    }
  });

  it("prime evita el spawn y un caso sin primar cae a un spawn real", () => {
    const batch = createHookBatch(echoHook);
    const primed: HookCase = { input: "4\nprimed\n" };
    const other: HookCase = { input: "5\nother\n" };
    batch.prime(BATCH_SHELLS, [primed]);
    for (const shell of BATCH_SHELLS) {
      expect(batch.run(shell, primed)).toEqual(runHookIsolated(echoHook, shell, primed));
      expect(batch.run(shell, other).status).toBe(5);
    }
  });

  // Covers: R18
  it("lanes: 1 serializa los casos que escriben el mismo log, sin pérdidas", () => {
    // A read-modify-write counter: two concurrent lanes lose increments, one lane never does.
    const counter = join(dir, "counter");
    const log = join(dir, "events.log");
    const writer = writeHook(
      "append.sh",
      [
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        `echo $((n + 1)) > "${counter}"`,
        `echo "event $n" >> "${log}"`,
      ].join("\n"),
    );
    const cases: HookCase[] = Array.from({ length: 12 }, () => ({ input: "" }));
    for (const shell of BATCH_SHELLS) {
      writeFileSync(counter, "0");
      writeFileSync(log, "");
      const batch = createHookBatch(writer);
      batch.prime([shell], cases.slice(0, 1), { lanes: 1 });
      const results = runHookBatch(writer, shell, cases, { lanes: 1 });
      expect(results.every((r) => r.status === 0)).toBe(true);
      expect(readFileSync(counter, "utf-8").trim()).toBe(String(1 + cases.length));
      const lines = readFileSync(log, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1 + cases.length);
      expect(new Set(lines).size).toBe(lines.length);
    }
  });
});
