import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #1482 — `scripts/js/check-deps-sync.mjs` compares installed direct deps with
 * bun.lock. Fixtures are throwaway trees; nothing touches the real node_modules.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "..", "..", "..", "scripts", "js", "check-deps-sync.mjs");
const { checkDepsSync } = (await import(SCRIPT)) as {
  checkDepsSync: (root: string) => { ok: boolean; problems: string[] };
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Fixture {
  lockPackages: Record<string, string[]>;
  deps: Record<string, string>;
  installed: Record<string, string>; // path relative to root -> version
  optional?: Record<string, string>;
}

function build(f: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "deps-sync-"));
  roots.push(root);
  const ws = { "": { name: "root", dependencies: f.deps, optionalDependencies: f.optional ?? {} } };
  // Trailing commas mimic bun.lock's JSONC.
  const lock = JSON.stringify({ workspaces: ws, packages: f.lockPackages }, null, 2).replace(
    /(\n\s*)\}/g,
    ",$1}",
  );
  writeFileSync(join(root, "bun.lock"), lock);
  for (const [rel, version] of Object.entries(f.installed)) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  }
  return root;
}

describe("check-deps-sync", () => {
  it("passes when installed matches the lockfile", () => {
    const root = build({
      lockPackages: { foo: ["foo@1.8.1"] },
      deps: { foo: "^1.0.0" },
      installed: { "node_modules/foo": "1.8.1" },
    });
    expect(checkDepsSync(root)).toEqual({ ok: true, problems: [] });
  });

  it("fails on version drift, naming the package", () => {
    const root = build({
      lockPackages: { foo: ["foo@1.8.1"] },
      deps: { foo: "^1.0.0" },
      installed: { "node_modules/foo": "0.10.1" },
    });
    const r = checkDepsSync(root);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toBe("foo: installed 0.10.1, bun.lock wants 1.8.1 (root)");
  });

  it("fails on a missing package but tolerates a missing optional one", () => {
    const root = build({
      lockPackages: { foo: ["foo@1.0.0"], opt: ["opt@2.0.0"] },
      deps: { foo: "^1.0.0" },
      optional: { opt: "^2.0.0" },
      installed: {},
    });
    const r = checkDepsSync(root);
    expect(r.problems).toEqual(["foo: not installed, bun.lock wants 1.0.0 (root)"]);
  });

  it("skips workspace: and non-registry specs", () => {
    const root = build({
      lockPackages: { a: ["a@workspace:packages/a"], b: ["b@github:x/b#abc"] },
      deps: { a: "workspace:*", b: "github:x/b" },
      installed: {},
    });
    expect(checkDepsSync(root).ok).toBe(true);
  });

  it("prefers the nested <workspace>/<dep> lockfile key", () => {
    const root = build({
      lockPackages: { foo: ["foo@1.0.0"], "root/foo": ["foo@2.0.0"] },
      deps: { foo: "^2.0.0" },
      installed: { "node_modules/foo": "2.0.0" },
    });
    expect(checkDepsSync(root).ok).toBe(true);
  });

  it("CLI exits 1 on drift and prints the fix", () => {
    const root = build({
      lockPackages: { foo: ["foo@1.8.1"] },
      deps: { foo: "^1.0.0" },
      installed: { "node_modules/foo": "0.10.1" },
    });
    const r = spawnSync("node", [SCRIPT, root], { encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("foo: installed 0.10.1");
    expect(r.stderr).toContain("bun install --frozen-lockfile");
  });

  it("CLI exits 0 on the real, synced repo", () => {
    const r = spawnSync("node", [SCRIPT], { encoding: "utf-8" });
    expect(r.status).toBe(0);
  });
});
