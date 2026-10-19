import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sessionContextOutput } from "../commands/tools.ts";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { shellSingleQuote } from "../lib/primitives/shell-escape.ts";
import { PROGRESS_SOFT_CAP_BYTES } from "../lib/assets/doc-budgets.ts";
import { shellSensitive } from "../lib/__tests__/helpers/shells.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const DIST = join(ROOT, "packages/cli/dist/index.js");
let root: string;
let home: string;
let state: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-m6-"));
  home = join(root, "home");
  state = join(home, ".navori/tool-versions/notice.json");
  mkdirSync(dirname(state), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Real ACK state, without networking or a fake ACK implementation. */
function acknowledged(): boolean {
  return existsSync(state) && readFileSync(state, "utf8").includes('"version":"3.2.1"');
}

describe("reserved session-context delivery", () => {
  // Covers: R11
  it.each(["ñ€", "first\nsecond", "last\n\n"])("uses exact UTF-8 reservation for %j", (body) => {
    const notice = `#navori-tool-notice v1 ack=engram@3.2.1\n${body}\n`;
    const bytes = Buffer.byteLength(body) + 1;
    expect(
      sessionContextOutput(
        () => notice,
        () => "",
        bytes - 1,
      ),
    ).toContain(" notice-reserve\n");
    expect(acknowledged()).toBe(false);
    expect(
      sessionContextOutput(
        () => notice,
        () => "",
        bytes,
      ),
    ).toContain(notice);
    expect(acknowledged()).toBe(true);
  });

  // Covers: R11
  it.each(["bad notice\n", "#navori-tool-notice v1 ack=bad;command\nx\n", "#section notice\n"])(
    "rejects malformed notice %j without consuming it",
    (notice) => {
      expect(
        sessionContextOutput(
          () => notice,
          () => "",
          300,
        ),
      ).toBeNull();
      expect(acknowledged()).toBe(false);
    },
  );

  // Covers: R11
  it("validates Dominio and reservation before ACK, preserving legacy default", () => {
    const notice = "#navori-tool-notice v1 ack=engram@3.2.1\nhello\n";
    expect(
      sessionContextOutput(
        () => notice,
        () => "#end navori-session-context\n",
        300,
      ),
    ).toBeNull();
    expect(
      sessionContextOutput(
        () => notice,
        () => {
          throw new Error("failed");
        },
        300,
      ),
    ).toBeNull();
    for (const reserve of [-1, NaN, Infinity, 1.5])
      expect(
        sessionContextOutput(
          () => notice,
          () => "",
          reserve,
        ),
      ).toBeNull();
    expect(
      sessionContextOutput(
        () => notice,
        () => "",
      ),
    ).toMatch(/^#navori-session-context v1\n/);
    expect(acknowledged()).toBe(false);
  });

  // Covers: R11
  it("does not consume absent or opted-out notices", () => {
    expect(
      sessionContextOutput(
        () => "",
        () => "",
        300,
      ),
    ).not.toBeNull();
    vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "1");
    expect(
      sessionContextOutput(
        () => {
          throw new Error("must not run");
        },
        () => "",
        300,
      ),
    ).not.toBeNull();
    expect(acknowledged()).toBe(false);
  });
});

describe.each(shellSensitive("SessionStart frame parsing and UTF-8 byte accounting"))(
  "modern SessionStart under %s",
  (shell) => {
    /** Real CLI and cached release, with a deterministic installed-version binary. */
    function install(warnings = false): {
      bin: string;
      log: string;
      body: string;
      env: NodeJS.ProcessEnv;
    } {
      const bin = join(root, "bin");
      const log = join(root, "calls");
      mkdirSync(bin);
      const config = JSON.parse(readFileSync(join(ROOT, "navori.config.json"), "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        join(root, "navori.config.json"),
        JSON.stringify({
          ...config,
          ...(warnings ? {} : { qualityGate: { fast: "true", full: "true" } }),
          language: "es",
          plugins: { engram: { enabled: true } },
        }),
      );
      const now = Date.now();
      writeFileSync(
        join(dirname(state), "latest.json"),
        JSON.stringify({
          tools: {
            engram: {
              at: now,
              source: "github",
              id: "Gentleman-Programming/engram",
              status: "ok",
              version: "3.2.1",
            },
          },
        }),
      );
      writeFileSync(
        join(dirname(state), "attempts.json"),
        JSON.stringify({ engram: { at: now, token: null } }),
      );
      writeFileSync(join(bin, "engram"), "#!/bin/sh\nprintf 'engram 3.0.0\\n'\n", { mode: 0o755 });
      writeFileSync(
        join(bin, "navori"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellSingleQuote(log)}\nexec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(DIST)} "$@"\n`,
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        HOME: home,
        CI: "",
        NAVORI_NO_UPDATE_NOTIFIER: "",
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        NAVORI_AUDITS_ROOT: join(root, "audits"),
      };
      const notice = spawnSync(process.execPath, [DIST, "tools", "notice"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      expect(notice.status, notice.stderr).toBe(0);
      if (warnings) expect(notice.stderr).toContain("qualityGate.affected");
      expect(notice.stdout).toContain("ack=engram@3.2.1");
      const body = notice.stdout.slice(notice.stdout.indexOf("\n") + 1, -1);
      const source = expandHookIncludes(
        readFileSync(join(getCoreRoot(), "core-assets/hooks/session-start-context.sh"), "utf8"),
      )
        .replace("{{shq:branchBase}}", shellSingleQuote("dev"))
        .replace("{{navori.progressSoftCapBytes}}", String(PROGRESS_SOFT_CAP_BYTES));
      writeFileSync(join(root, "hook.sh"), source);
      return { bin, log, body, env };
    }

    /** Check real CLI state and hook delivery together, including legitimate stderr warnings. */
    function assertCommon(warnings: boolean): void {
      const { log, body, env } = install(warnings);
      const diagnostics = join(root, "diagnostics");
      mkdirSync(diagnostics);
      const inherited = join(diagnostics, "caller-owned");
      writeFileSync(inherited, "preserve caller data");
      const bytes = Buffer.byteLength(body) + 1;
      expect(bytes).toBeGreaterThan(body.length + 1);
      const run = spawnSync(shell, [join(root, "hook.sh")], {
        cwd: root,
        env: {
          ...env,
          NAVORI_NOTICE_RESERVE: String(bytes),
          TMPDIR: diagnostics,
          navori_sc_err: inherited,
        },
        input: '{"hook_event_name":"SessionStart","source":"startup"}',
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout, run.stderr).not.toBe("");
      const output = JSON.parse(run.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(output.hookSpecificOutput.additionalContext).toContain(body);
      expect(run.stdout).not.toContain("qualityGate.affected");
      expect(readFileSync(log, "utf8")).toBe(`tools session-context --notice-reserve ${bytes}\n`);
      expect(acknowledged()).toBe(true);
      expect(readdirSync(diagnostics)).toEqual(["caller-owned"]);
      expect(readFileSync(inherited, "utf8")).toBe("preserve caller data");
    }

    // Covers: R11, R13
    it("camino común invoca navori una vez", () => assertCommon(false));

    // Covers: R11
    it("delivers and acknowledges notices despite a legitimate config warning", () =>
      assertCommon(true));

    // Covers: R11
    it("preserves inherited diagnostic paths when notice and workspace lookup are disabled", () => {
      const { log, env } = install();
      const inherited = join(root, "caller-owned");
      writeFileSync(inherited, "preserve caller data");
      const run = spawnSync(shell, [join(root, "hook.sh")], {
        cwd: root,
        env: { ...env, NAVORI_NO_UPDATE_NOTIFIER: "1", navori_sc_err: inherited },
        input: '{"hook_event_name":"SessionStart","source":"startup"}',
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe("");
      expect(existsSync(log)).toBe(false);
      expect(existsSync(inherited)).toBe(true);
      expect(readFileSync(inherited, "utf8")).toBe("preserve caller data");
      expect(acknowledged()).toBe(false);
    });

    // Covers: R11
    it("leaves oversized notices pending and emits their doctor pointer", () => {
      const { log, body, env } = install();
      const bytes = Buffer.byteLength(body);
      const run = spawnSync(shell, [join(root, "hook.sh")], {
        cwd: root,
        env: { ...env, NAVORI_NOTICE_RESERVE: String(bytes) },
        input: '{"hook_event_name":"SessionStart"}',
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("navori doctor");
      expect(run.stdout).not.toContain(body);
      expect(readFileSync(log, "utf8")).toBe(`tools session-context --notice-reserve ${bytes}\n`);
      expect(acknowledged()).toBe(false);
    });

    // Covers: R11
    it.each([false, true])(
      "keeps empty/disabled notices unacknowledged (disabled=%s)",
      (disabled) => {
        const { log, env } = install();
        if (disabled) mkdirSync(join(home, ".navori/workspaces"));
        else writeFileSync(join(dirname(state), "latest.json"), "{}");
        const run = spawnSync(shell, [join(root, "hook.sh")], {
          cwd: root,
          env: { ...env, NAVORI_NO_UPDATE_NOTIFIER: disabled ? "1" : "" },
          input: '{"hook_event_name":"SessionStart"}',
          encoding: "utf8",
        });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toBe("");
        expect(readFileSync(log, "utf8")).toBe("tools session-context --notice-reserve 300\n");
        expect(acknowledged()).toBe(false);
      },
    );
  },
);
