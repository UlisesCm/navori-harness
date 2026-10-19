import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempFile } from "../../vitest.tempLifecycle.ts";
import { auditsRoot } from "../lib/audit/paths.ts";
import { auditsUnderHome } from "./helpers/hermetic-env.ts";

/** The worker file already runs hermetic (vitest.setup.ts); nested files test the lifecycle itself. */
describe("hermetic test environment", () => {
  // Covers: R5
  it("hides the audit root and the session keys from children", () => {
    expect(process.env.NAVORI_AUDITS_ROOT).toBeDefined();
    expect(existsSync(process.env.NAVORI_AUDITS_ROOT ?? "")).toBe(false);
    for (const key of [
      "CLAUDE_PROJECT_DIR",
      "CLAUDE_CODE_SESSION_ID",
      "NAVORI_AUDIT_HOST",
      "NAVORI_AUDIT_SESSION_ID",
      "GIT_INDEX_FILE",
      "GIT_DIR",
    ])
      expect(process.env[key]).toBeUndefined();
  });

  // Covers: R6
  it("git config --list no muestra orígenes fuera del root temporal", () => {
    const root = process.env.TMPDIR ?? "";
    const out = execFileSync("git", ["config", "--list", "--show-origin"], {
      encoding: "utf8",
      cwd: root, // outside any checkout, so the repo's own .git/config is not listed
    });
    const origins = out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[0] ?? "");
    for (const origin of origins) {
      // Only file origins count; `command line:` entries carry no user path.
      if (origin.startsWith("file:"))
        expect(origin.slice("file:".length).startsWith(root)).toBe(true);
    }
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  // Covers: R6
  it("git init copies a minimal template without sample hooks", () => {
    const dir = join(process.env.TMPDIR ?? "", "tpl-repo");
    const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    expect(existsSync(join(dir, ".git", "hooks", "pre-commit.sample"))).toBe(false);
    expect(existsSync(join(dir, ".git", "hooks"))).toBe(true);
  });

  // Covers: R5
  it("auditsUnderHome devuelve la raíz de auditoría bajo HOME", () => {
    const env = auditsUnderHome({ ...process.env });
    expect("NAVORI_AUDITS_ROOT" in env).toBe(false);
    const saved = process.env.NAVORI_AUDITS_ROOT;
    delete process.env.NAVORI_AUDITS_ROOT;
    try {
      expect(auditsRoot()).toBe(join(env.HOME ?? "", ".navori", "audits"));
    } finally {
      process.env.NAVORI_AUDITS_ROOT = saved;
    }
  });

  // Covers: R5, R6
  it("createTempFile quita GIT_* heredado y lo restaura en dispose", async () => {
    process.env.GIT_INDEX_FILE = "/inherited/index";
    process.env.CLAUDE_PROJECT_DIR = "/inherited/project";
    const before = {
      home: process.env.HOME,
      audits: process.env.NAVORI_AUDITS_ROOT,
      cfg: process.env.GIT_CONFIG_GLOBAL,
    };
    const file = createTempFile();
    try {
      expect(process.env.GIT_INDEX_FILE).toBeUndefined();
      expect(process.env.CLAUDE_PROJECT_DIR).toBeUndefined();
      expect(readFileSync(process.env.GIT_CONFIG_GLOBAL ?? "", "utf8")).toBe("");
      expect(process.env.XDG_CONFIG_HOME).toBe(join(file.root, "xdg"));
    } finally {
      await file.dispose();
    }
    expect(process.env.GIT_INDEX_FILE).toBe("/inherited/index");
    expect(process.env.CLAUDE_PROJECT_DIR).toBe("/inherited/project");
    expect(process.env.HOME).toBe(before.home);
    expect(process.env.NAVORI_AUDITS_ROOT).toBe(before.audits);
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(before.cfg);
    delete process.env.GIT_INDEX_FILE;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
});
