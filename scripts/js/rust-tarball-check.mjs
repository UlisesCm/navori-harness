import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Spec 0057 R4: npm stays TS-only throughout the migration. */
export function checkTarball(packs, pkg, root) {
  if (
    !Array.isArray(packs) ||
    packs.length !== 1 ||
    !Array.isArray(packs[0].files) ||
    packs[0].files.length === 0
  )
    throw new Error("npm pack returned no file inventory");
  if (pkg.scripts && Object.hasOwn(pkg.scripts, "postinstall"))
    throw new Error("postinstall is forbidden during Rust coexistence");
  for (const file of packs[0].files) {
    const path = file.path;
    if (
      typeof path !== "string" ||
      /(^|\/)(crates|target)(\/|$)|(^|\/)navori-rust(?:[./-]|$)|\.(?:exe|dll|dylib|so|a|rlib|rmeta|wasm|node)$|(^|\/)Cargo\.(?:toml|lock)$/.test(
        path,
      )
    )
      throw new Error(`Rust/native artifact in npm tarball: ${path}`);
    if (root) {
      const magic = readFileSync(resolve(root, path)).subarray(0, 4).toString("hex");
      if (
        [
          "7f454c46",
          "feedface",
          "feedfacf",
          "cefaedfe",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
          "0061736d",
        ].includes(magic) ||
        magic.startsWith("4d5a")
      )
        throw new Error(`Native binary in npm tarball: ${path}`);
    }
  }
  return packs[0].files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const cwd = resolve("packages/cli");
    // prepack builds dist; CI explicitly runs ensure-dist before this check.
    const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.error || run.status !== 0) throw new Error(run.error?.message ?? run.stderr);
    const count = checkTarball(
      JSON.parse(run.stdout),
      JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")),
      cwd,
    );
    console.log(`rust-tarball: ${count} files, no Rust artifacts or postinstall`);
  } catch (error) {
    console.error(`rust-tarball: ${error.message}`);
    process.exitCode = 1;
  }
}
