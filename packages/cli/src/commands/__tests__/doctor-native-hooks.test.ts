import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "../../lib/config/schema.ts";
import { tc } from "../../lib/i18n.ts";
import { computeHealthVerdict, nativeHookFindingText, scanNativeHooks } from "../doctor.ts";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    stdio: "ignore",
  });
};

function repo(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-doctor-native-")));
  git(cwd, "init", "-q");
  return cwd;
}

function hook(cwd: string, rel: string, body = "#!/bin/sh\nbun run check:fast\n"): void {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function config(overrides: Partial<NavoriConfigInput> = {}, nativeHooks?: boolean): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "nh",
    engines: ["claude", "codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "bun lint", full: "bun test", nativeHooks },
    ...overrides,
  });
}

const codes = (cwd: string, cfg: NavoriConfig) =>
  scanNativeHooks(cwd, cfg)?.findings.map((f) => `${f.level}:${f.code}`) ?? null;

describe("scanNativeHooks", () => {
  // Covers: R5, R6, R7
  describe("filas de D3", () => {
    it("returns null outside git when nothing is declared", () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-doctor-native-nogit-")));
      expect(scanNativeHooks(cwd, config())).toBeNull();
    });

    it("always reports what it found per event (info), with the manager and path", () => {
      const cwd = repo();
      hook(cwd, ".git/hooks/pre-commit");
      const report = scanNativeHooks(cwd, config({}, true))!;
      expect(report.findings.filter((f) => f.code === "found").map((f) => f.event)).toEqual([
        "pre-commit",
        "pre-push",
      ]);
      const text = nativeHookFindingText(report.findings[0]!, tc("en").doctor);
      expect(text).toContain("pre-commit: active (plain)");
      expect(text).toContain(".git/hooks/pre-commit");
      expect(report.errors).toBe(0);
    });

    it("errors when qualityGate.nativeHooks is declared and no pre-commit is active here", () => {
      const cwd = repo();
      const report = scanNativeHooks(cwd, config({}, true))!;
      expect(report.errors).toBe(1);
      const err = report.findings.find((f) => f.code === "gate-declared-missing")!;
      expect(err.level).toBe("error");
      expect(nativeHookFindingText(err, tc("en").doctor)).toContain("qualityGate.nativeHooks");
      expect(computeHealthVerdict(cwd, config({}, true)).ok).toBe(false);
    });

    it("counts a husky stub as absent for the R6 error, naming the manager and the reason", () => {
      const cwd = repo();
      git(cwd, "config", "core.hooksPath", ".husky/_");
      hook(cwd, ".husky/_/h", "#!/usr/bin/env sh\nexit 0\n");
      hook(cwd, ".husky/_/pre-commit", '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
      const err = scanNativeHooks(cwd, config({}, true))!.findings.find(
        (f) => f.code === "gate-declared-missing",
      )!;
      const text = nativeHookFindingText(err, tc("en").doctor);
      expect(text).toContain("husky");
      expect(text).toContain("husky-stub");
    });

    it("warns about duplicated checks when a native pre-commit is active and nothing is declared", () => {
      const cwd = repo();
      hook(cwd, ".git/hooks/pre-commit");
      expect(codes(cwd, config())).toContain("warning:duplicate");
      expect(computeHealthVerdict(cwd, config()).ok).toBe(true);
      expect(codes(cwd, config({}, true))).not.toContain("warning:duplicate");
    });

    it("plugins.<p>.nativeHook: only-guarantee info, error when pre-commit and pre-push are absent", () => {
      const cwd = repo();
      const cfg = config({ plugins: { semgrep: { enabled: true, nativeHook: true } } });
      const found = codes(cwd, cfg);
      expect(found).toContain("info:plugin-only-guarantee");
      expect(found).toContain("error:plugin-declared-missing");
      const err = scanNativeHooks(cwd, cfg)!.findings.find(
        (f) => f.code === "plugin-declared-missing",
      )!;
      expect(err.plugin).toBe("semgrep");
      // A native pre-push alone satisfies the plugin declaration.
      hook(cwd, ".git/hooks/pre-push");
      expect(codes(cwd, cfg)).not.toContain("error:plugin-declared-missing");
    });

    it("ignores a nativeHook plugin whose hooks were not omitted (nothing to guard)", () => {
      const cwd = repo();
      const cfg = config({ plugins: { semgrep: { enabled: false, nativeHook: true } } });
      expect(codes(cwd, cfg)).not.toContain("info:plugin-only-guarantee");
    });

    it("warns per .claude/worktrees worktree whose pre-commit is absent, never as an error", () => {
      const cwd = repo();
      writeFileSync(join(cwd, "a.txt"), "x\n");
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", "init");
      git(cwd, "config", "core.hooksPath", ".githooks");
      hook(cwd, ".githooks/pre-commit");
      const wt = join(cwd, ".claude", "worktrees", "w1");
      git(cwd, "worktree", "add", "-q", "-b", "w1", wt);
      const report = scanNativeHooks(cwd, config({}, true))!;
      const warn = report.findings.filter((f) => f.code === "worktree-missing");
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ level: "warning", path: realpathSync(wt) });
      expect(report.errors).toBe(0);
      // Undeclared: no worktree walk.
      expect(
        scanNativeHooks(cwd, config())!.findings.some((f) => f.code === "worktree-missing"),
      ).toBe(false);
    });
  });
});
