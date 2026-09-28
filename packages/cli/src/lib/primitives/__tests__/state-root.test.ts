import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRoot, resolveStateRoot, stateArtifactPath } from "../state-root.ts";

const workspaces: string[] = [];
afterEach(() =>
  workspaces.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-state-root-")));
  workspaces.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "README"), "test\n");
  git(cwd, "add", "README");
  git(cwd, "commit", "-m", "base");
  return cwd;
}

function mark(cwd: string, dir: string, name: string): void {
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, name), "{}\n");
}

describe("resolveStateRoot", () => {
  // Covers: R1, R2, R3, R6
  it("uses neutral state by default and resolves a nested checkout cwd", () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "nested"));
    const root = resolveStateRoot({ cwd: join(cwd, "nested"), feature: "demo" });
    expect(root.cwd).toBe(checkoutRoot(cwd));
    expect(root.dir).toBe(".navori/state/handoffs");
    expect(root.kind).toBe("neutral");
  });

  // Covers: R1, R2, R3, R6
  it("keeps state checkout-local for linked worktrees", () => {
    const cwd = fixture();
    const linked = join(tmpdir(), `navori-state-linked-${Date.now()}`);
    workspaces.push(linked);
    git(cwd, "worktree", "add", "-b", "linked", linked);
    expect(resolveStateRoot({ cwd, feature: "demo" }).path).not.toBe(
      resolveStateRoot({ cwd: realpathSync(linked), feature: "demo" }).path,
    );
  });

  // Covers: R3, R6
  it("accepts an explicit legacy root contained by the checkout", () => {
    const cwd = fixture();
    const root = resolveStateRoot({ cwd, feature: "demo", dir: ".claude/progress" });
    expect(root.dir).toBe(".claude/progress");
    expect(root.kind).toBe("explicit");
  });

  // Covers: R3, R4, R11
  it("prefers neutral, falls back to one matching legacy root, and rejects two legacy roots", () => {
    const cwd = fixture();
    mark(cwd, ".claude/progress", "workplan_demo.json");
    expect(resolveStateRoot({ cwd, feature: "demo" }).dir).toBe(".claude/progress");
    mark(cwd, ".navori/state/handoffs", "impl_demo.json");
    expect(resolveStateRoot({ cwd, feature: "demo" }).dir).toBe(".navori/state/handoffs");
    rmSync(join(cwd, ".navori"), { recursive: true, force: true });
    mark(cwd, ".codex/progress", "review_demo.md");
    expect(() => resolveStateRoot({ cwd, feature: "demo" })).toThrow("multiple legacy state roots");
  });

  // Covers: R3, R4, R11
  it("does not treat a receipt for another feature as a matching root", () => {
    const cwd = fixture();
    mark(cwd, ".claude/progress", "receipt.txt");
    writeFileSync(
      join(cwd, ".claude/progress", "receipt.txt"),
      "# navori-receipt v2 feature=other\n",
    );
    expect(resolveStateRoot({ cwd, feature: "demo" }).dir).toBe(".navori/state/handoffs");
  });

  // Covers: R6
  it("rejects raw in-checkout traversal and an ancestor alias into another checkout", () => {
    const cwd = fixture();
    expect(() => resolveStateRoot({ cwd, feature: "demo", dir: ".claude/../progress" })).toThrow(
      "traversal",
    );
    const other = fixture();
    mkdirSync(join(other, "sub"));
    symlinkSync(other, join(cwd, "alias"));
    expect(() => resolveStateRoot({ cwd: join(cwd, "alias", "sub"), feature: "demo" })).toThrow(
      "symlinked --cwd",
    );
  });

  // Covers: R6
  it("rejects unsafe feature names, escaping roots, and symlinked state ancestors", () => {
    const cwd = fixture();
    expect(() => resolveStateRoot({ cwd, feature: "bad/name" })).toThrow("invalid feature slug");
    expect(() => resolveStateRoot({ cwd, feature: "demo", dir: "../outside" })).toThrow(
      "traversal",
    );
    expect(() => resolveStateRoot({ cwd, feature: "demo", dir: tmpdir() })).toThrow(
      "escapes checkout",
    );
    const external = mkdtempSync(join(tmpdir(), "navori-state-external-"));
    workspaces.push(external);
    mkdirSync(join(cwd, ".navori"));
    symlinkSync(external, join(cwd, ".navori", "state"));
    expect(() => resolveStateRoot({ cwd, feature: "demo" })).toThrow("symlink");
    rmSync(join(cwd, ".navori"), { recursive: true, force: true });
    mkdirSync(join(cwd, ".navori", "state"), { recursive: true });
    symlinkSync(external, join(cwd, ".navori", "state", "handoffs"));
    expect(() => resolveStateRoot({ cwd, feature: "demo" })).toThrow("symlink");
  });

  // Covers: R6
  it("rejects a symlinked final artifact directory and a symlinked cwd", () => {
    const cwd = fixture();
    const root = resolveStateRoot({ cwd, feature: "demo" });
    mkdirSync(root.path, { recursive: true });
    const external = mkdtempSync(join(tmpdir(), "navori-state-final-"));
    workspaces.push(external);
    symlinkSync(external, join(root.path, "escape"));
    expect(() => stateArtifactPath(root, "escape")).toThrow("escapes checkout");
    const link = join(tmpdir(), `navori-state-cwd-${Date.now()}`);
    workspaces.push(link);
    symlinkSync(cwd, link);
    expect(() => checkoutRoot(link)).toThrow("symlinked --cwd");
  });

  // Covers: R6
  it("rejects a non-Git cwd", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-state-nongit-")));
    workspaces.push(cwd);
    expect(() => resolveStateRoot({ cwd, feature: "demo" })).toThrow("not a Git checkout");
  });
});
