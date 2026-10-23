import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

interface Manifest {
  commands: { path: string[] }[];
  hooks: Record<
    string,
    { blocks: Record<string, string>; deps?: Record<string, string>; impl: string }
  >;
}
interface ManifestCheck {
  checkHistory: (
    before: Manifest,
    after: Manifest,
    previous: string,
    current: string,
    now?: number,
  ) => string[];
  checkHashes: (root: string, manifest: Manifest) => void;
  implementationHash: (root: string, id: string) => string;
}
const checks = (await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/js/rust-manifest-check.mjs")).href
)) as ManifestCheck;
const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const manifest = (commands: string[]): Manifest => ({
  commands: commands.map((id: string): { path: string[] } => ({ path: id.split(" ") })),
  hooks: {},
});
const event = (op: string, id = "render"): string =>
  JSON.stringify({ date: "2026-01-01", op, id, reason: "parity gap", pr: 1 });

// Covers: R10
it("quitar una entrada sin unport falla, incluso con un registro antiguo", (): void => {
  const before = manifest(["render"]);
  const after = manifest([]);
  const unport = event("unport");
  expect((): string[] => checks.checkHistory(before, after, "", "")).toThrow("unport");
  expect((): string[] => checks.checkHistory(before, after, unport, unport)).toThrow("new unport");
  expect(checks.checkHistory(before, after, "", unport, Date.parse("2026-01-16"))).toEqual([
    "render has been unported for more than 14 days",
  ]);
  expect((): string[] => checks.checkHistory(before, after, event("port"), unport)).toThrow(
    "append-only",
  );
  expect((): string[] =>
    checks.checkHistory(before, after, "", `${unport}\n${event("port")}`),
  ).toThrow("unport");
  expect(checks.checkHistory(after, before, unport, `${unport}\n${event("port")}`)).toEqual([]);
});

// Covers: R10
it("recalcula los hashes de assets, deps y fuentes Rust compartidos", (): void => {
  const root = mkdtempSync(join(tmpdir(), "rust-manifest-"));
  dirs.push(root);
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const hash = (body: string): string =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`;
  mkdirSync(join(root, "packages/plugins"), { recursive: true });
  write("packages/core/core-assets/hooks/example.sh", "body\n");
  write("packages/core/core-assets/scripts/dep.sh", "dep\n");
  write("crates/navori-hooks/src/hooks/example/mod.rs", "hook\n");
  write("crates/navori-hooks/src/runner.rs", "runner\n");
  const m: Manifest = {
    commands: [],
    hooks: {
      example: {
        blocks: { "example-base": hash("body\n") },
        deps: { "scripts/dep.sh": hash("dep\n") },
        impl: checks.implementationHash(root, "example"),
      },
    },
  };
  expect((): void => checks.checkHashes(root, m)).not.toThrow();
  write("packages/core/core-assets/hooks/example.sh", "body \n");
  expect((): void => checks.checkHashes(root, m)).toThrow("blocks.example-base");
  write("packages/core/core-assets/hooks/example.sh", "body\n");
  write("packages/core/core-assets/scripts/dep.sh", "dep\r\n");
  expect((): void => checks.checkHashes(root, m)).toThrow("deps.scripts/dep.sh");
  write("packages/core/core-assets/scripts/dep.sh", "dep\n");
  write("crates/navori-hooks/src/runner.rs", "new runner\n");
  expect((): void => checks.checkHashes(root, m)).toThrow("impl");
});
