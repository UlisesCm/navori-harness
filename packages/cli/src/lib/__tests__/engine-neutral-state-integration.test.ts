import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfig } from "../config/config.ts";
import { checkReceipt, signReceipt } from "../diagnose/receipt.ts";
import { resolveStateRoot, writeStateFileAtomic } from "../primitives/state-root.ts";
import { runRender } from "../../commands/render.ts";
import { scanGitHygiene } from "../../commands/doctor.ts";
import { NavoriConfigSchema } from "../config/schema.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { main: string; linked: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-neutral-integration-")));
  temporary.push(root);
  const main = join(root, "main");
  const linked = join(root, "linked");
  const remote = join(root, "remote.git");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  git(root, "init", "--bare", remote);
  git(main, "remote", "add", "origin", remote);
  writeFileSync(join(main, "README"), "base\n");
  git(main, "add", "README");
  git(main, "commit", "-m", "base");
  git(main, "push", "-u", "origin", "main");
  git(main, "worktree", "add", "-b", "linked", linked);
  return { main, linked };
}

describe("Spec 0036 engine-neutral state integration", () => {
  // Covers: R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12
  it("keeps two rendered engines and linked checkouts isolated through migration and receipt checks", () => {
    const { main, linked } = fixture();
    const config = NavoriConfigSchema.parse({
      name: "neutral-integration",
      engines: ["claude", "codex"],
      preset: "custom",
      gitignoreHarness: "off",
    });
    writeConfig(join(main, "navori.config.json"), config);
    writeConfig(join(linked, "navori.config.json"), config);
    expect(runRender(main, { dryRun: false }).ok).toBe(true);
    expect(runRender(linked, { dryRun: false }).ok).toBe(true);

    for (const cwd of [main, linked]) {
      const claude = readFileSync(join(cwd, ".claude/agents/implementer.md"), "utf8");
      const codex = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf8");
      expect(claude).toContain(".navori/state/handoffs/");
      expect(codex).toContain(".navori/state/handoffs/");
      expect(existsSync(join(cwd, ".claude/hooks/subagent-stop-handoff.sh"))).toBe(true);
      expect(existsSync(join(cwd, ".codex/hooks/subagent-stop-handoff.sh"))).toBe(true);
      const claudeHook = readFileSync(join(cwd, ".claude/hooks/subagent-stop-handoff.sh"), "utf8");
      const codexHook = readFileSync(join(cwd, ".codex/hooks/subagent-stop-handoff.sh"), "utf8");
      for (const hook of [claudeHook, codexHook]) {
        expect(hook.match(/payload=\$\{payload-\$\(cat\)\}/g)).toHaveLength(1);
        expect(hook).toContain('".navori/state/handoffs"');
        expect(hook).not.toContain("navori_field() {");
      }
      expect(readFileSync(join(cwd, ".claude/settings.json"), "utf8")).toContain(
        ".claude/hooks/subagent-stop-handoff.sh",
      );
      expect(readFileSync(join(cwd, ".codex/config.toml"), "utf8")).toContain(
        ".codex/hooks/subagent-stop-handoff.sh",
      );
      expect(readFileSync(join(cwd, ".navori/.gitignore"), "utf8")).toContain("state/");
      expect(git(cwd, "check-ignore", ".navori/state/handoffs/workplan_demo.json")).toBe(
        ".navori/state/handoffs/workplan_demo.json",
      );
      expect(git(cwd, "check-ignore", ".claude/progress/impl_old.json")).toBe(
        ".claude/progress/impl_old.json",
      );
      expect(git(cwd, "check-ignore", ".codex/progress/impl_old.json")).toBe(
        ".codex/progress/impl_old.json",
      );
      expect(
        spawnSync("git", ["check-ignore", "-q", ".navori/presets/demo.json"], {
          cwd,
        }).status,
      ).toBe(1);
    }

    const first = resolveStateRoot({ cwd: main, feature: "demo" });
    const second = resolveStateRoot({ cwd: linked, feature: "demo" });
    expect(first.dir).toBe(".navori/state/handoffs");
    expect(second.dir).toBe(first.dir);
    expect(first.path).not.toBe(second.path);
    writeStateFileAtomic(first, "workplan_demo.json", '{"feature":"demo"}\n');
    writeStateFileAtomic(second, "workplan_demo.json", '{"feature":"demo","linked":true}\n');
    expect(readFileSync(join(first.path, "workplan_demo.json"), "utf8")).not.toBe(
      readFileSync(join(second.path, "workplan_demo.json"), "utf8"),
    );

    mkdirSync(join(main, ".claude/progress"), { recursive: true });
    mkdirSync(join(main, ".codex/progress"), { recursive: true });
    writeFileSync(join(main, ".claude/progress", "workplan_old.json"), "{}\n");
    expect(resolveStateRoot({ cwd: main, feature: "old" }).dir).toBe(".claude/progress");
    writeFileSync(join(main, ".codex/progress", "impl_old.json"), "{}\n");
    expect(() => resolveStateRoot({ cwd: main, feature: "old" })).toThrow("--dir");
    expect(resolveStateRoot({ cwd: main, feature: "old", dir: ".claude/progress" }).dir).toBe(
      ".claude/progress",
    );
    expect(resolveStateRoot({ cwd: main, feature: "demo" }).dir).toBe(first.dir);

    expect(() => resolveStateRoot({ cwd: main, feature: "../unsafe" })).toThrow("invalid feature");
    expect(() => resolveStateRoot({ cwd: main, feature: "demo", dir: "../outside" })).toThrow(
      "traversal",
    );
    const alias = join(main, "unsafe-alias");
    symlinkSync(linked, alias);
    expect(() => resolveStateRoot({ cwd: alias, feature: "demo" })).toThrow("symlinked --cwd");
    unlinkSync(alias);

    const stampName = "session-1046";
    const oldStamp = join(main, ".git/navori/routing-watch", stampName);
    mkdirSync(join(main, ".git/navori/routing-watch"), { recursive: true });
    writeFileSync(oldStamp, "#notified\n");
    for (const cwd of [main, linked]) {
      const hook = join(cwd, ".claude/hooks/routing-watch.sh");
      execFileSync("bash", [hook], {
        cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        input: JSON.stringify({
          session_id: stampName,
          tool_name: "Edit",
          tool_input: { file_path: "src/example.ts" },
        }),
        encoding: "utf8",
      });
      expect(existsSync(join(cwd, ".navori/state/hooks/routing-watch", stampName))).toBe(true);
    }
    expect(readFileSync(oldStamp, "utf8")).toBe("#notified\n");

    const hygiene = scanGitHygiene(main, config);
    expect(hygiene?.ephemeralNotIgnored).toEqual([]);
    expect(hygiene?.ephemeralTracked).toEqual([]);
    expect(hygiene?.presetsIgnored).toBe(false);
    expect(git(main, "ls-files", "--others", "--exclude-standard")).not.toContain(".navori/state/");
    const preview = runRender(main, { dryRun: true });
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview.entries)).not.toContain(
      ".navori/state/handoffs/workplan_demo.json",
    );
    expect(runRender(main, { dryRun: false }).ok).toBe(true);
    expect(readFileSync(join(main, ".claude/progress/workplan_old.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(main, ".codex/progress/impl_old.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(oldStamp, "utf8")).toBe("#notified\n");

    writeFileSync(join(main, "README"), "changed\n");
    const receipt = signReceipt({
      cwd: main,
      feature: "demo",
      dir: first.dir,
      target: "main",
      gate: "bun test",
    });
    expect(receipt.result.status, receipt.result.error ?? "").toBe("ok");
    expect(
      checkReceipt({
        cwd: main,
        feature: "demo",
        dir: first.dir,
        target: "main",
        gate: "bun test",
      }).result.status,
    ).toBe("ok");
    const receiptPath = join(first.path, "receipt.txt");
    writeFileSync(
      receiptPath,
      readFileSync(receiptPath, "utf8").replace("feature=demo", "feature=other"),
    );
    const rejected = checkReceipt({
      cwd: main,
      feature: "demo",
      dir: first.dir,
      target: "main",
      gate: "bun test",
    });
    expect(rejected.result.error).toContain('receipt belongs to feature "other"');
    renameSync(receiptPath, join(first.path, "receipt.consumed.txt"));
    const consumed = checkReceipt({
      cwd: main,
      feature: "demo",
      dir: first.dir,
      target: "main",
      gate: "bun test",
      includeConsumed: true,
    });
    expect(consumed.result.error).toContain('receipt belongs to feature "other"');
  });
});
