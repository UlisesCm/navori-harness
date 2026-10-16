import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_SHELLS } from "../../../lib/__tests__/helpers/shells.ts";
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
    for (const shell of HOOK_SHELLS) {
      const batch = runHookBatch(echoHook, shell, cases);
      const isolated = cases.map((c) => runHookIsolated(echoHook, shell, c));
      expect(batch).toEqual(isolated);
      expect(batch.map((r) => r.status)).toEqual([0, 2, 3, 0, 0]);
    }
  });

  it("un hook que mata o reemplaza el driver hace fallar el lote", () => {
    const killer = writeHook("kill.sh", "kill -9 $$");
    for (const shell of HOOK_SHELLS) {
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
    for (const shell of HOOK_SHELLS) {
      const r = runHookBatch(execer, shell, [{ input: "x\n" }, { input: "y\n" }]);
      expect(r.map((x) => x.status)).toEqual([7, 0]);
    }
  });

  it("prime evita el spawn y un caso sin primar cae a un spawn real", () => {
    const batch = createHookBatch(echoHook);
    const primed: HookCase = { input: "4\nprimed\n" };
    const other: HookCase = { input: "5\nother\n" };
    batch.prime(HOOK_SHELLS, [primed]);
    for (const shell of HOOK_SHELLS) {
      expect(batch.run(shell, primed)).toEqual(runHookIsolated(echoHook, shell, primed));
      expect(batch.run(shell, other).status).toBe(5);
    }
  });
});
