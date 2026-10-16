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
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import { expandHookIncludes } from "../../lib/render/hook-includes.ts";
import { shellSingleQuote } from "../../lib/primitives/shell-escape.ts";
import { PROGRESS_SOFT_CAP_BYTES } from "../../lib/assets/doc-budgets.ts";
import { HOOK_SHELLS, type HookShell } from "../../lib/__tests__/helpers/shells.ts";
import {
  SESSION_CONTEXT_BEGIN,
  SESSION_CONTEXT_DOMINIO,
  SESSION_CONTEXT_END,
  SESSION_CONTEXT_NOTICE,
  TOOL_NOTICE_SENTINEL,
  sessionContextOutput,
} from "../tools.ts";

/**
 * `navori tools session-context` (spec 0054 R25, D12): the two sections the SessionStart
 * hook used to fetch with two CLI calls, in one output, all or nothing — and the hook's
 * fallback to the two calls when that output is missing, partial or from an older CLI.
 *
 * Covers: R25
 */

const NOTICE_BODY = "A newer engram is available: 3.2.1 (installed: 3.0.0).";
const NOTICE = `${TOOL_NOTICE_SENTINEL}engram@3.2.1\n${NOTICE_BODY}\n`;
const DOMINIO = "## Dominio\n- **coachee** — user-profile.kind\n";

describe("sessionContextOutput", () => {
  // Covers: R25
  it("salida completa o nada", () => {
    expect(
      sessionContextOutput(
        () => NOTICE,
        () => DOMINIO,
      ),
    ).toBe(
      `${SESSION_CONTEXT_BEGIN}\n${SESSION_CONTEXT_NOTICE}\n${NOTICE}${SESSION_CONTEXT_DOMINIO}\n${DOMINIO}${SESSION_CONTEXT_END}\n`,
    );
    // Empty sections keep both markers.
    expect(
      sessionContextOutput(
        () => "",
        () => "",
      ),
    ).toBe(
      `${SESSION_CONTEXT_BEGIN}\n${SESSION_CONTEXT_NOTICE}\n${SESSION_CONTEXT_DOMINIO}\n${SESSION_CONTEXT_END}\n`,
    );
    // One failing section prints NOTHING, not the other one.
    const boom = (): string => {
      throw new Error("broken store");
    };
    expect(sessionContextOutput(() => NOTICE, boom)).toBeNull();
    expect(sessionContextOutput(boom, () => DOMINIO)).toBeNull();
    // Content that could forge the framing is refused whole.
    expect(
      sessionContextOutput(
        () => NOTICE,
        () => `x\n#section notice\ny\n`,
      ),
    ).toBeNull();
    expect(
      sessionContextOutput(
        () => `${SESSION_CONTEXT_END}\n`,
        () => DOMINIO,
      ),
    ).toBeNull();
  });

  // Covers: R25
  it("el aviso se omite con NAVORI_NO_UPDATE_NOTIFIER=1 sin llamar a su fuente", () => {
    const before = process.env.NAVORI_NO_UPDATE_NOTIFIER;
    process.env.NAVORI_NO_UPDATE_NOTIFIER = "1";
    try {
      let called = false;
      const out = sessionContextOutput(
        () => {
          called = true;
          return NOTICE;
        },
        () => DOMINIO,
      );
      expect(called).toBe(false);
      expect(out).not.toContain(NOTICE_BODY);
      expect(out).toContain(DOMINIO);
    } finally {
      if (before === undefined) delete process.env.NAVORI_NO_UPDATE_NOTIFIER;
      else process.env.NAVORI_NO_UPDATE_NOTIFIER = before;
    }
  });
});

describe.each(HOOK_SHELLS)("session-start-context.sh and session-context under %s", (shell) => {
  const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/session-start-context.sh");
  let dir: string;
  let home: string;
  let bin: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "navori-sc-"));
    home = mkdtempSync(join(tmpdir(), "navori-sc-home-"));
    bin = mkdtempSync(join(tmpdir(), "navori-sc-bin-"));
    log = join(bin, "calls.log");
    mkdirSync(join(home, ".navori", "workspaces"), { recursive: true });
    writeFileSync(
      join(dir, "hook.sh"),
      expandHookIncludes(readFileSync(HOOK_SRC, "utf-8"))
        .replace("{{shq:branchBase}}", shellSingleQuote("main"))
        .replace("{{navori.progressSoftCapBytes}}", String(PROGRESS_SOFT_CAP_BYTES)),
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    for (const path of [dir, home, bin]) rmSync(path, { recursive: true, force: true });
  });

  /**
   * A `navori` stub. `sessionContext` is what `tools session-context` prints (and its
   * exit code); the two old subcommands answer with `NOTICE` and `DOMINIO`.
   */
  function stub(sessionContext: { out: string; exit: number }, version = "0.12.1"): void {
    writeFileSync(join(bin, "sc-out"), sessionContext.out);
    writeFileSync(join(bin, "notice-out"), NOTICE);
    writeFileSync(join(bin, "dominio-out"), DOMINIO);
    writeFileSync(
      join(bin, "navori"),
      `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  "--version") echo '${version}'; exit 0 ;;
  "tools session-context") cat '${join(bin, "sc-out")}'; exit ${sessionContext.exit} ;;
  "tools notice") cat '${join(bin, "notice-out")}' ;;
  "dominio inject") cat '${join(bin, "dominio-out")}' ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(join(bin, "navori"), 0o755);
  }

  const memo = (): string => join(home, ".navori", ".no-session-context");
  function run(sh: HookShell, keepMemo = false): { ctx: string; calls: string[] } {
    rmSync(log, { force: true });
    if (!keepMemo) rmSync(memo(), { force: true });
    const r = spawnSync(sh, [join(dir, "hook.sh")], {
      cwd: dir,
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        NAVORI_NO_UPDATE_NOTIFIER: "",
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
    });
    const ctx = r.stdout.trim()
      ? (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } })
          .hookSpecificOutput.additionalContext
      : "";
    return {
      ctx,
      calls: existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [],
    };
  }

  const framed = (notice: string, dominio: string, end = `${SESSION_CONTEXT_END}\n`): string =>
    `${SESSION_CONTEXT_BEGIN}\n${SESSION_CONTEXT_NOTICE}\n${notice}${SESSION_CONTEXT_DOMINIO}\n${dominio}${end}`;

  // Covers: R25
  it("salida completa o nada y caída a las dos llamadas con CLI viejo", () => {
    // Complete output: ONE call for both sections (plus the ack of the delivered notice).
    stub({ out: framed(NOTICE, DOMINIO), exit: 0 });
    const full = run(shell);
    expect(full.calls).toEqual(["tools session-context", "tools notice --ack engram@3.2.1"]);
    expect(full.ctx).toContain(NOTICE_BODY);
    expect(full.ctx).toContain("coachee");
    expect(full.ctx).not.toContain("#section");
    expect(full.ctx.indexOf(NOTICE_BODY)).toBeGreaterThan(full.ctx.indexOf("coachee"));

    // Anything else falls back to the two calls the hook always made, and the model
    // still gets both sections: non-zero exit, an older CLI's usage banner, a truncated
    // frame, a missing section, a repeated marker.
    const fallbacks: Array<[string, { out: string; exit: number }]> = [
      ["exit 1 with nothing", { out: "", exit: 1 }],
      [
        "an older CLI's unknown-command answer",
        { out: "USAGE navori init|add|render\n ERROR  Unknown command session-context\n", exit: 1 },
      ],
      ["usage text from a CLI that exits 0", { out: "USAGE navori init|add|render\n", exit: 0 }],
      ["a truncated frame", { out: framed(NOTICE, DOMINIO, ""), exit: 0 }],
      ["complete output but exit 1", { out: framed(NOTICE, DOMINIO), exit: 1 }],
      [
        "only the notice section",
        {
          out: `${SESSION_CONTEXT_BEGIN}\n${SESSION_CONTEXT_NOTICE}\n${NOTICE}${SESSION_CONTEXT_END}\n`,
          exit: 0,
        },
      ],
      [
        "a repeated marker",
        { out: framed(NOTICE, `${SESSION_CONTEXT_DOMINIO}\n${DOMINIO}`), exit: 0 },
      ],
      ["trailing text after the end marker", { out: `${framed(NOTICE, DOMINIO)}extra\n`, exit: 0 }],
    ];
    for (const [name, output] of fallbacks) {
      stub(output);
      const r = run(shell);
      // The version probe only runs to key the memo on an unknown-command answer.
      r.calls = r.calls.filter((c) => c !== "--version");
      expect(r.calls, name).toEqual([
        "tools session-context",
        "tools notice",
        "dominio inject",
        "tools notice --ack engram@3.2.1",
      ]);
      expect(r.ctx, name).toContain(NOTICE_BODY);
      expect(r.ctx, name).toContain("coachee");
    }
  });

  const UNKNOWN = {
    out: "USAGE navori init|add|render\n ERROR  Unknown command session-context\n",
    exit: 1,
  };

  // Covers: R25
  it("un CLI viejo se recuerda por versión: la caída no vuelve a pagar la llamada nueva", () => {
    stub(UNKNOWN);
    const first = run(shell);
    expect(first.calls[0]).toBe("tools session-context");
    expect(readFileSync(memo(), "utf-8")).toBe("0.12.1\n");
    // Same version: the probe is skipped, only the two old calls (plus the version check).
    const second = run(shell, true);
    expect(second.calls).toEqual([
      "--version",
      "tools notice",
      "dominio inject",
      "tools notice --ack engram@3.2.1",
    ]);
    expect(second.ctx).toContain(NOTICE_BODY);
    // An upgraded version re-probes (the binary's mtime is irrelevant) and, if framed, is used.
    stub({ out: framed(NOTICE, DOMINIO), exit: 0 }, "0.13.0");
    expect(run(shell, true).calls).toContain("tools session-context");
  });

  // Covers: R25
  it("solo un unknown-command claro escribe el memo; salida rota de un CLI que lo conoce no", () => {
    const bad: Array<[string, { out: string; exit: number }]> = [
      ["a deliberate empty failure", { out: "", exit: 1 }],
      ["a truncated frame", { out: framed(NOTICE, DOMINIO, ""), exit: 0 }],
      ["malformed output with exit 0", { out: "garbage\n", exit: 0 }],
      ["usage text without the unknown-command message", { out: "USAGE navori x\n", exit: 1 }],
    ];
    for (const [name, output] of bad) {
      stub(output);
      run(shell);
      expect(existsSync(memo()), name).toBe(false);
    }
    // A zero-byte memo from an earlier build never matches a version: it is re-probed.
    stub({ out: framed(NOTICE, DOMINIO), exit: 0 });
    writeFileSync(memo(), "");
    expect(run(shell, true).calls).toContain("tools session-context");
  });
});
