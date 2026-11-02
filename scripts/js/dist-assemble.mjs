import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0062 T6 (R21, R22; D17 of 0057, D51, D53): assembles the npm packages of the cutover without
 * publishing them. During coexistence `packages/cli` keeps shipping the TS untouched (R4), so the
 * Rust distribution is staged apart:
 *
 *   <out>/navori/                 `navori`: JS bins, postinstall, `optionalDependencies` on the four
 *                                 platform packages and `legacy/`, the last TS release verified
 *                                 against its pinned `integrity` (`packaging/legacy.json`)
 *   <out>/navori-<os>-<cpu>/      `@navori/<os>-<cpu>`: the binary as `bin/navori`, with `os`/`cpu`
 *
 *   node scripts/js/dist-assemble.mjs --out <dir> --binary linux-x64=<path> [--binary ...]
 *                                     [--legacy-tarball <tgz>] [--pack]
 *
 * Without `--legacy-tarball` it downloads the pinned release with `npm pack`. `--pack` leaves one
 * tarball per package in `<out>` and prints their paths as JSON.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGING = join(REPO_ROOT, "packaging");

/** The binary platforms (R21), named as `process.platform`-`process.arch`. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

/** The package scope of the platform packages (D51, Q24). */
export const SCOPE = "@navori";

/** The version the binaries report: the Cargo workspace's, which the postinstall compares. */
export function workspaceVersion(root = REPO_ROOT) {
  const toml = readFileSync(join(root, "Cargo.toml"), "utf8");
  const section = toml.slice(toml.indexOf("[workspace.package]"));
  const match = /^version\s*=\s*"([^"]+)"/m.exec(section);
  if (match === null) throw new Error("Cargo.toml has no [workspace.package] version");
  return match[1];
}

/** `sha512-<base64>` of a file, the form of npm's `dist.integrity`. */
export function integrityOf(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

/**
 * Unpacks the pinned TS release into `<target>`: `package.json`, `dist/` and the rest of its
 * tarball, byte for byte. A tarball whose integrity differs from the pin is refused.
 * @param {string} tarball
 * @param {{ version: string, integrity: string }} pin
 * @param {string} target
 */
export function unpackLegacy(tarball, pin, target) {
  const actual = integrityOf(tarball);
  if (actual !== pin.integrity) {
    throw new Error(`legacy tarball integrity ${actual} does not match the pinned ${pin.integrity}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "navori-legacy-"));
  try {
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", scratch], { encoding: "utf8" });
    if (untar.status !== 0) throw new Error(`cannot unpack ${tarball}: ${untar.stderr}`);
    const manifest = JSON.parse(readFileSync(join(scratch, "package", "package.json"), "utf8"));
    if (manifest.name !== "navori" || manifest.version !== pin.version) {
      throw new Error(`legacy tarball is ${manifest.name}@${manifest.version}, expected navori@${pin.version}`);
    }
    cpSync(join(scratch, "package"), target, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Downloads the pinned release with `npm pack` into `dir` and returns the tarball's path. */
function fetchLegacy(pin, dir) {
  const pack = spawnSync("npm", ["pack", `navori@${pin.version}`, "--pack-destination", dir, "--json"], {
    encoding: "utf8",
  });
  if (pack.status !== 0) throw new Error(`npm pack navori@${pin.version} failed: ${pack.stderr}`);
  return join(dir, JSON.parse(pack.stdout)[0].filename);
}

/**
 * The `navori` manifest: the TS package's metadata, both bins, the postinstall and the four
 * platform packages as optional dependencies at the same version.
 * @param {string} version
 * @param {Record<string, unknown>} ts the `packages/cli/package.json` it inherits metadata from
 */
export function mainManifest(version, ts) {
  return {
    name: "navori",
    version,
    description: ts.description,
    license: ts.license,
    repository: ts.repository,
    homepage: ts.homepage,
    keywords: ts.keywords,
    bin: { navori: "bin/navori", "navori-native-hook": "bin/navori-native-hook" },
    files: ["bin", "lib", "postinstall.js", "legacy", "README.md"],
    scripts: { postinstall: "node postinstall.js" },
    optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [`${SCOPE}/${p}`, version])),
    engines: ts.engines,
  };
}

/** A platform package's manifest: installed only where `os` and `cpu` match. */
export function platformManifest(platform, version, ts) {
  const [os, cpu] = platform.split("-");
  return {
    name: `${SCOPE}/${platform}`,
    version,
    description: `The navori binary for ${platform}.`,
    license: ts.license,
    repository: ts.repository,
    os: [os],
    cpu: [cpu],
    files: ["bin"],
  };
}

/**
 * Writes the packages under `out`.
 * @param {{ out: string, binaries: Record<string, string>, legacyTarball: string, pin: { version: string, integrity: string }, version?: string }} options
 * @returns {{ main: string, platforms: Record<string, string> }} the package directories
 */
export function assemble({ out, binaries, legacyTarball, pin, version = workspaceVersion() }) {
  for (const platform of Object.keys(binaries)) {
    if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform ${platform}; expected one of ${PLATFORMS.join(", ")}`);
  }
  const ts = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8"));
  const main = join(out, "navori");
  rmSync(main, { recursive: true, force: true });
  mkdirSync(main, { recursive: true });
  cpSync(join(PACKAGING, "npm"), main, { recursive: true });
  for (const bin of ["navori", "navori-native-hook"]) chmodSync(join(main, "bin", bin), 0o755);
  copyFileSync(join(REPO_ROOT, "packages", "cli", "README.md"), join(main, "README.md"));
  unpackLegacy(legacyTarball, pin, join(main, "legacy"));
  writeFileSync(join(main, "package.json"), `${JSON.stringify(mainManifest(version, ts), null, 2)}\n`);

  /** @type {Record<string, string>} */
  const platforms = {};
  for (const [platform, binary] of Object.entries(binaries)) {
    const dir = join(out, `navori-${platform}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(binary, join(dir, "bin", "navori"));
    chmodSync(join(dir, "bin", "navori"), 0o755);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(platformManifest(platform, version, ts), null, 2)}\n`);
    platforms[platform] = dir;
  }
  return { main, platforms };
}

/** `npm pack` of a package directory into `dest`; returns the tarball's path. */
export function pack(dir, dest) {
  const run = spawnSync("npm", ["pack", "--pack-destination", dest, "--json"], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`npm pack ${dir} failed: ${run.stderr}`);
  return join(dest, JSON.parse(run.stdout)[0].filename);
}

/** Reads `packaging/legacy.json`. */
export function legacyPin() {
  return JSON.parse(readFileSync(join(PACKAGING, "legacy.json"), "utf8"));
}

/**
 * @param {string[]} argv
 * @returns {{ out: string, binaries: Record<string, string>, legacyTarball?: string, pack: boolean }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const binaries = {};
  let out;
  let legacyTarball;
  let packIt = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--pack") {
      packIt = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--out") out = resolve(value);
    else if (flag === "--legacy-tarball") legacyTarball = resolve(value);
    else if (flag === "--binary") {
      const at = value.indexOf("=");
      if (at <= 0) throw new Error("--binary must be <os>-<cpu>=<path>");
      binaries[value.slice(0, at)] = resolve(value.slice(at + 1));
    } else throw new Error(`unknown option ${flag}`);
  }
  if (out === undefined) throw new Error("--out is required");
  return { out, binaries, legacyTarball, pack: packIt };
}

async function main(argv) {
  const options = parseArgs(argv);
  const pin = legacyPin();
  mkdirSync(options.out, { recursive: true });
  const legacyTarball = options.legacyTarball ?? fetchLegacy(pin, options.out);
  const dirs = assemble({ out: options.out, binaries: options.binaries, legacyTarball, pin });
  if (!options.pack) {
    process.stdout.write(`${JSON.stringify(dirs)}\n`);
    return 0;
  }
  const tarballs = {
    main: pack(dirs.main, options.out),
    platforms: Object.fromEntries(Object.entries(dirs.platforms).map(([p, dir]) => [p, pack(dir, options.out)])),
  };
  process.stdout.write(`${JSON.stringify(tarballs)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dist-assemble: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
