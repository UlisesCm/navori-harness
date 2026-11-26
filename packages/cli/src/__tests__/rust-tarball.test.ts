import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

interface TarballCheck {
  checkTarball: (packs: unknown, pkg: unknown, root?: string) => number;
}
const { checkTarball } = (await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/js/rust-tarball-check.mjs")).href
)) as TarballCheck;

// Covers: R4
it("el tarball no contiene artefactos Rust ni postinstall", (): void => {
  const inventory = (path: string): unknown => [{ files: [{ path }] }];
  expect(checkTarball(inventory("dist/index.js"), {})).toBe(1);
  for (const path of [
    "crates/foo.rs",
    "dist/target/a",
    "dist/navori-rust",
    "dist/navori-rust-linux-arm64",
    "dist/x.node",
    "Cargo.toml",
  ]) {
    expect((): number => checkTarball(inventory(path), {}), path).toThrow();
  }
  expect((): number =>
    checkTarball(inventory("dist/index.js"), { scripts: { postinstall: "install-rust" } }),
  ).toThrow("postinstall");
  expect((): number => checkTarball([], {})).toThrow("inventory");
});

// Covers: R4
it("rechaza un binario nativo sin extensión", (): void => {
  const root = mkdtempSync(join(tmpdir(), "rust-tarball-"));
  try {
    writeFileSync(join(root, "innocent-name"), Buffer.from("7f454c4600000000", "hex"));
    expect((): number => checkTarball([{ files: [{ path: "innocent-name" }] }], {}, root)).toThrow(
      "Native binary",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
