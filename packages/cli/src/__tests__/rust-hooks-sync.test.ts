import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

/**
 * Spec 0060 T17 — `scripts/js/rust-hooks-sync.mjs` against a minimal repository: the render and
 * cargo steps go through a stub runner, so nothing builds.
 */

interface Sync {
  main: (
    argv: string[],
    seams?: { root?: string; run?: (cmd: string, args: string[]) => number },
  ) => number;
}
interface ManifestCheck {
  implementationHash: (root: string, id: string) => string;
}
const scripts = join(import.meta.dirname, "../../../../scripts/js");
const sync = (await import(pathToFileURL(join(scripts, "rust-hooks-sync.mjs")).href)) as Sync;
const checks = (await import(
  pathToFileURL(join(scripts, "rust-manifest-check.mjs")).href
)) as ManifestCheck;

const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (body: string): string => `sha256:${createHash("sha256").update(body).digest("hex")}`;

// Covers: R70, R77
it("un impl desfasado deja --check en rojo y la sincronización lo corrige", (): void => {
  const root = mkdtempSync(join(tmpdir(), "rust-hooks-sync-"));
  dirs.push(root);
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  mkdirSync(join(root, "packages/plugins"), { recursive: true });
  write("packages/core/core-assets/hooks/example.sh", "body\n");
  write("packages/core/core-assets/hooks/other.sh", "other\n");
  write("crates/navori-hooks/src/hooks/example/mod.rs", "hook\n");
  write("crates/navori-hooks/src/hooks/other/mod.rs", "other hook\n");
  write("crates/navori-hooks/src/runner.rs", "runner\n");
  const manifest = (exampleImpl: string, otherImpl: string): string =>
    [
      "{",
      '  "schema": 2,',
      '  "commands": [{ "path": ["render"], "flags": ["apply"] }],',
      '  "hooks": {',
      '    "example": { "mode": "shadow", "gating": true,',
      `      "blocks": { "example-base": "${hash("body\n")}" },`,
      `      "impl": "${exampleImpl}" },`,
      '    "other": {',
      '      "mode": "shadow",',
      `      "blocks": { "other-base": "${hash("other\n")}" },`,
      `      "impl": "${otherImpl}"`,
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
  const before = manifest(
    checks.implementationHash(root, "example"),
    checks.implementationHash(root, "other"),
  );
  write("crates/ported.json", before);
  const calls: string[] = [];
  const run = (cmd: string, args: string[]): number => {
    calls.push([cmd, ...args].join(" "));
    return 0;
  };
  expect(sync.main(["--check"], { root, run })).toBe(0);
  expect(calls).toEqual(["bun run check:render"]);

  // A shared runtime file changes the impl of every hook (D8).
  write("crates/navori-hooks/src/runner.rs", "new runner\n");
  calls.length = 0;
  expect(sync.main(["--check"], { root, run })).toBe(1);
  expect(calls).toEqual([]);
  expect(readFileSync(join(root, "crates/ported.json"), "utf8")).toBe(before);

  expect(sync.main([], { root, run })).toBe(0);
  expect(calls).toEqual([
    "bun run render:apply",
    "cargo install --path crates/navori-cli --locked",
  ]);
  // Only the two hash strings changed: the layout of the file is kept byte for byte.
  expect(readFileSync(join(root, "crates/ported.json"), "utf8")).toBe(
    manifest(checks.implementationHash(root, "example"), checks.implementationHash(root, "other")),
  );
  calls.length = 0;
  expect(sync.main(["--check"], { root, run })).toBe(0);
  expect(sync.main(["--no-install"], { root, run })).toBe(0);
  expect(calls.at(-1)).toBe("cargo build -p navori-cli --locked");

  // A failing render stops before cargo; a stale render leaves --check red.
  calls.length = 0;
  expect(sync.main([], { root, run: (cmd, args) => (run(cmd, args), cmd === "bun" ? 1 : 0) })).toBe(
    1,
  );
  expect(calls).toEqual(["bun run render:apply"]);
  expect(sync.main(["--check"], { root, run: () => 1 })).toBe(1);
});
