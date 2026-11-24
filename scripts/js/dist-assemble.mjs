import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnHelp } from "./script-help.mjs";

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
 *                                     [--legacy-tarball <tgz>] [--legacy-pin <json>] [--pack]
 *
 * Without `--legacy-tarball` it downloads the pinned legacy package (`LEGACY_PACKAGE@<version>`)
 * with `npm pack`. `--legacy-pin` replaces `packaging/legacy.json` (rehearsals pin the tarball they
 * just built). `--pack` leaves one tarball per package in `<out>` and prints their paths as JSON.
 *
 * The frozen TS is a package of its own (decision of 20 Nov, option E). It is built once, from the
 * commit before the cutover PR deletes `packages/cli/src`, and published before the release:
 *
 *   node scripts/js/dist-assemble.mjs legacy --from <ref> --out <dir> [--version <v>] [--write-pin]
 *                                     [--pin-out <file>]
 *   node scripts/js/dist-assemble.mjs legacy --from-dir <built checkout> --out <dir> ...
 *   node scripts/js/dist-assemble.mjs legacy --from-pin --out <dir> ...
 *   node scripts/js/dist-assemble.mjs check-pin
 *
 * `--from-pin` is what the rehearsal runs: it builds the commit and version `packaging/legacy.json`
 * pins, so it keeps working after the cutover deletes the TS sources (T10 keeps only the artifact
 * suites under `packages/cli/src`); with an empty pin it builds `HEAD`, which only works while the
 * TS entry (`packages/cli/src/index.ts`) is still in the tree. It takes no `--version`. When the
 * pin carries an integrity, the rebuilt tarball must match it (the build is reproducible), so the
 * rehearsal checks what is published instead of trusting the pin it writes.
 * `check-pin` is the step before publishing: it fails unless `packaging/legacy.json` has a 40-hex
 * `commit`, a `sha512-` integrity and the `packages/cli/package.json` version, and unless that
 * version is also the Cargo workspace's (what the binary answers to `--version`).
 * `--from-dir` refuses a checkout with uncommitted changes, so the recorded commit is the one that was built.
 *
 * It prints `{ tarball, name, version, integrity, commit }`; `--write-pin` records
 * `{ version, integrity, commit }` in `packaging/legacy.json`. A pin with `null` integrity/commit
 * means "not published yet": the assembly refuses it (JSON has no comments, so it is said here).
 * The tarball holds `package/package.json` (the legacy manifest) and `package/navori/`, which
 * mirrors the checkout layout because the TS only loads `crates/ported.json` from
 * `<dir>/packages/cli/dist` (native-hook.ts): `packages/cli/{package.json,dist/}`,
 * `crates/ported.json` (same commit) and `dist/index.js`, a shim onto the real entry.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGING = join(REPO_ROOT, "packaging");

/** The binary platforms (R21), named as `process.platform`-`process.arch`. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

/** The package scope of the platform packages (D51, Q24). */
export const SCOPE = "@navori";

/** The only place the legacy package's name lives. Plan B of Q24 is `navori-legacy`. */
export const LEGACY_PACKAGE = "@navori/legacy";

/** The entry the launcher and `delegate.rs` run (`<pkg>/legacy/dist/index.js`), onto the real one. */
export const LEGACY_SHIM = `#!/usr/bin/env node
// Entry shim: the frozen TS lives at packages/cli/dist so it finds crates/ported.json.
import "../packages/cli/dist/index.js";
`;

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
 * Unpacks the pinned legacy package into `<target>`: the nested `navori/` directory (checkout
 * layout, see the header), byte for byte. A tarball whose integrity differs from the pin, or whose
 * manifests or layout are not the expected ones, is refused.
 * @param {string} tarball
 * When `ported` is given (the path of the `crates/ported.json` the binaries were built from), the
 * legacy's copy must be identical: the frozen TS renders the native hook prologues from it, and a
 * different manifest makes it fight the binary's render.
 * When `stamp` is given (the `packages/cli/package.json` version the binaries stamp, STAMP_VERSION),
 * the pin must carry it: the frozen TS refuses to write over markers stamped by a newer version.
 * @param {{ version: string, integrity: string | null }} pin
 * @param {string} target
 * @param {string} [ported]
 * @param {string} [stamp]
 */
export function unpackLegacy(tarball, pin, target, ported, stamp) {
  if (stamp !== undefined && pin.version !== stamp) {
    throw new Error(
      `the legacy pin is ${pin.version} but the binaries stamp ${stamp} (packages/cli/package.json); the legacy must be built with --version ${stamp}`,
    );
  }
  if (typeof pin.integrity !== "string" || pin.integrity === "") {
    throw new Error(
      "packaging/legacy.json has no integrity yet: run `dist-assemble legacy --from <commit before the cutover> --version <release> --write-pin`, publish it, then assemble",
    );
  }
  const actual = integrityOf(tarball);
  if (actual !== pin.integrity) {
    throw new Error(`legacy tarball integrity ${actual} does not match the pinned ${pin.integrity}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "navori-legacy-"));
  try {
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", scratch], { encoding: "utf8" });
    if (untar.status !== 0) throw new Error(`cannot unpack ${tarball}: ${untar.stderr}`);
    const outer = JSON.parse(readFileSync(join(scratch, "package", "package.json"), "utf8"));
    if (outer.name !== LEGACY_PACKAGE || outer.version !== pin.version) {
      throw new Error(`legacy tarball is ${outer.name}@${outer.version}, expected ${LEGACY_PACKAGE}@${pin.version}`);
    }
    const nested = join(scratch, "package", "navori");
    const inner = JSON.parse(readFileSync(join(nested, "packages", "cli", "package.json"), "utf8"));
    if (inner.name !== "navori") {
      throw new Error(`the frozen TS manifest is named ${inner.name}, expected navori (its version lookup requires it)`);
    }
    // The frozen TS reports (and stamps) this one, not the outer manifest's.
    if (inner.version !== pin.version) {
      throw new Error(`the frozen TS inside the legacy tarball is ${inner.version}, expected ${pin.version}`);
    }
    for (const file of ["crates/ported.json", "dist/index.js"]) {
      if (!existsSync(join(nested, file))) throw new Error(`the legacy tarball has no navori/${file}`);
    }
    if (ported !== undefined && !readFileSync(join(nested, "crates", "ported.json")).equals(readFileSync(ported))) {
      throw new Error(
        `the legacy's crates/ported.json differs from ${ported}, the one the binaries were built from; rebuild the legacy from a commit with the same manifest`,
      );
    }
    cpSync(nested, target, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Downloads the pinned legacy package with `npm pack` into `dir` and returns the tarball's path. */
export function fetchLegacy(pin, dir) {
  const spec = `${LEGACY_PACKAGE}@${pin.version}`;
  const pack = spawnSync("npm", ["pack", spec, "--pack-destination", dir, "--json"], { encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`npm pack ${spec} failed: ${pack.stderr}`);
  return join(dir, JSON.parse(pack.stdout)[0].filename);
}

/**
 * The legacy package's manifest: no scripts, a `navori-legacy` bin onto the nested TS, and the TS
 * package's engines.
 * @param {string} version
 * @param {Record<string, unknown>} ts the `packages/cli/package.json` it inherits metadata from
 */
export function legacyManifest(version, ts) {
  return {
    name: LEGACY_PACKAGE,
    version,
    description: "The frozen TypeScript navori CLI that the native navori package delegates to.",
    license: ts.license,
    repository: ts.repository,
    homepage: ts.homepage,
    type: "module",
    bin: { "navori-legacy": "navori/dist/index.js" },
    files: ["navori"],
    engines: ts.engines,
  };
}

/**
 * The frozen TS's own manifest as it ships inside the legacy package. The name stays `navori`: the
 * TS reads `dist/../package.json` for its version and only accepts that name.
 */
export function nestedManifest(version, ts) {
  const keep = ["description", "license", "repository", "homepage", "engines", "features", "bin"];
  return {
    name: "navori",
    version,
    type: ts.type,
    ...Object.fromEntries(keep.filter((k) => ts[k] !== undefined).map((k) => [k, ts[k]])),
  };
}

/**
 * Stages the legacy package from a built TS checkout and packs it into `out`.
 * @param {{ root: string, out: string, version?: string }} options `root` has `packages/cli/dist`
 * @returns {{ tarball: string, name: string, version: string, integrity: string }}
 */
export function buildLegacy({ root, out, version }) {
  const cli = join(root, "packages", "cli");
  const ts = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
  if (!existsSync(join(cli, "dist", "index.js"))) throw new Error(`${cli} has no dist/index.js; build it first`);
  const finalVersion = version ?? ts.version;
  const stage = mkdtempSync(join(tmpdir(), "navori-legacy-stage-"));
  try {
    const nested = join(stage, "navori");
    mkdirSync(nested, { recursive: true });
    const nestedCli = join(nested, "packages", "cli");
    mkdirSync(nestedCli, { recursive: true });
    cpSync(join(cli, "dist"), join(nestedCli, "dist"), { recursive: true });
    writeFileSync(join(nestedCli, "package.json"), `${JSON.stringify(nestedManifest(finalVersion, ts), null, 2)}\n`);
    mkdirSync(join(nested, "crates"), { recursive: true });
    copyFileSync(join(root, "crates", "ported.json"), join(nested, "crates", "ported.json"));
    mkdirSync(join(nested, "dist"), { recursive: true });
    writeFileSync(join(nested, "dist", "index.js"), LEGACY_SHIM);
    // Nameless on purpose: only packages/cli/package.json may be named `navori` (readCliVersion).
    writeFileSync(join(nested, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);
    copyFileSync(join(cli, "README.md"), join(nested, "README.md"));
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(legacyManifest(finalVersion, ts), null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const tarball = pack(stage, out);
    return { tarball, name: LEGACY_PACKAGE, version: finalVersion, integrity: integrityOf(tarball) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Runs a command, failing loudly. */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

/** Output of a command, trimmed. */
function capture(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * What `legacy --from-pin` builds: the pinned commit at the pinned version, or `HEAD` at its own
 * version while the pin is empty. After the cutover (no `packages/cli/src/index.ts`) an empty pin
 * is an error: `HEAD` has no TS to build.
 * @param {{ version: string, commit?: string | null }} pin
 * @param {{ hasTsSources: boolean }} tree
 * @returns {{ from: string, version: string | undefined }}
 */
export function legacySource(pin, { hasTsSources }) {
  if (typeof pin.commit === "string" && pin.commit !== "") {
    assertCommitSha(pin.commit);
    return { from: pin.commit, version: pin.version };
  }
  if (!hasTsSources) {
    throw new Error(
      "the TS sources are gone (cutover: no packages/cli/src/index.ts) and packaging/legacy.json pins no commit: pin the legacy with `dist-assemble legacy --from <commit before the cutover> --version <release> --write-pin` first",
    );
  }
  return { from: "HEAD", version: undefined };
}

/** A pinned commit is a full SHA-1, never a ref or an option. */
export function assertCommitSha(commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`packaging/legacy.json pins commit ${JSON.stringify(commit)}, expected a 40-hex commit SHA`);
  }
}

/**
 * A rebuilt legacy must be byte-identical to the pinned one when the pin has an integrity.
 * @param {{ integrity?: string | null }} pin
 * @param {string} integrity the rebuilt tarball's
 */
export function assertRebuiltIntegrity(pin, integrity) {
  if (typeof pin.integrity === "string" && pin.integrity !== "" && pin.integrity !== integrity) {
    throw new Error(`the rebuilt legacy is ${integrity}, but packaging/legacy.json pins ${pin.integrity}`);
  }
}

/**
 * The check before publishing: the pin is complete (40-hex commit, sha512 integrity) and carries
 * the version the binaries stamp. An empty pin is fine for rehearsals, never for a release.
 * @param {{ version?: string, integrity?: string | null, commit?: string | null }} pin
 * @param {string} stamp the `packages/cli/package.json` version
 */
export function assertPublishablePin(pin, stamp) {
  assertCommitSha(pin.commit);
  if (typeof pin.integrity !== "string" || !pin.integrity.startsWith("sha512-")) {
    throw new Error(`packaging/legacy.json pins integrity ${JSON.stringify(pin.integrity)}, expected the sha512 of the published legacy`);
  }
  if (pin.version !== stamp) {
    throw new Error(`packaging/legacy.json pins ${pin.version}, but packages/cli/package.json is ${stamp}`);
  }
}

/**
 * The check before publishing that the binary's version (Cargo) is the stamp (`packages/cli`): the
 * hooks run a ported subcommand in process only when `navori --version` answers STAMP_VERSION
 * (`hook_facts.rs` `in_process`, plan-gate `same_version`), and the published `navori` is the binary.
 * @param {string} workspace the `[workspace.package]` version of `Cargo.toml`
 * @param {string} stamp the `packages/cli/package.json` version
 */
export function assertReleaseVersions(workspace, stamp) {
  if (workspace !== stamp) {
    throw new Error(
      `Cargo.toml is ${workspace} but packages/cli/package.json is ${stamp}: the published navori would answer --version with ${workspace}, so the hooks' in-process lane would never run; set both to the release version`,
    );
  }
}

/**
 * Refuses a checkout with uncommitted changes (`git status --porcelain`, ignored files aside): the
 * pin records its `HEAD`, which must be what was built.
 * @param {string} porcelain the output of `git status --porcelain`
 * @param {string} dir
 */
export function assertCleanCheckout(porcelain, dir) {
  if (porcelain.trim() !== "") {
    throw new Error(
      `${dir} has uncommitted changes, so its HEAD is not what would be packed; commit or stash them, or use --from <ref>:\n${porcelain.trim()}`,
    );
  }
}

/**
 * `legacy` subcommand: builds the TS at `--from <ref>` (or the pinned one, `--from-pin`) in a
 * temporary detached worktree, or uses `--from-dir`, an already built clean checkout, and packs it.
 */
function legacyCommand(argv) {
  const opts = { from: undefined, fromDir: undefined, fromPin: false, out: undefined, version: undefined, writePin: false, pinOut: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--write-pin") {
      opts.writePin = true;
      continue;
    }
    if (flag === "--from-pin") {
      opts.fromPin = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--from") opts.from = value;
    else if (flag === "--from-dir") opts.fromDir = resolve(value);
    else if (flag === "--out") opts.out = resolve(value);
    else if (flag === "--version") opts.version = value;
    else if (flag === "--pin-out") opts.pinOut = resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (opts.out === undefined) throw new Error("--out is required");
  if ([opts.from !== undefined, opts.fromDir !== undefined, opts.fromPin].filter(Boolean).length !== 1) {
    throw new Error("exactly one of --from <ref>, --from-dir <path> or --from-pin is required");
  }
  const pinned = opts.fromPin ? legacyPin() : undefined;
  if (pinned !== undefined) {
    if (opts.version !== undefined) throw new Error("--from-pin takes the pinned version; drop --version");
    // The tsdown entry: T10 deletes it but keeps the artifact suites under packages/cli/src.
    const source = legacySource(pinned, { hasTsSources: existsSync(join(REPO_ROOT, "packages", "cli", "src", "index.ts")) });
    opts.from = source.from;
    opts.version = source.version;
  }

  let result;
  let commit;
  if (opts.fromDir !== undefined) {
    assertCleanCheckout(capture("git", ["status", "--porcelain"], opts.fromDir), opts.fromDir);
    commit = capture("git", ["rev-parse", "HEAD"], opts.fromDir);
    result = buildLegacy({ root: opts.fromDir, out: opts.out, version: opts.version });
  } else {
    commit = capture("git", ["rev-parse", "--verify", "--end-of-options", `${opts.from}^{commit}`], REPO_ROOT);
    const tree = mkdtempSync(join(tmpdir(), "navori-legacy-src-"));
    rmSync(tree, { recursive: true, force: true });
    run("git", ["worktree", "add", "--detach", tree, commit], REPO_ROOT);
    try {
      run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], tree); // no hooks:install into the shared .git
      run("bun", ["run", "build"], join(tree, "packages", "cli"));
      result = buildLegacy({ root: tree, out: opts.out, version: opts.version });
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: REPO_ROOT });
      rmSync(tree, { recursive: true, force: true });
    }
  }
  if (pinned !== undefined) assertRebuiltIntegrity(pinned, result.integrity);
  const report = { ...result, commit };
  const pin = `${JSON.stringify({ version: report.version, integrity: report.integrity, commit }, null, 2)}\n`;
  if (opts.writePin) writeFileSync(join(PACKAGING, "legacy.json"), pin);
  if (opts.pinOut !== undefined) writeFileSync(opts.pinOut, pin);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
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
    bin: { navori: "bin/navori", "navori-native-hook": "bin/navori-native-hook", "navori-rust": "bin/navori-rust" },
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
 * @param {{ out: string, binaries: Record<string, string>, legacyTarball: string, pin: { version: string, integrity: string | null }, version?: string }} options
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
  for (const bin of ["navori", "navori-native-hook", "navori-rust"]) chmodSync(join(main, "bin", bin), 0o755);
  copyFileSync(join(REPO_ROOT, "packages", "cli", "README.md"), join(main, "README.md"));
  unpackLegacy(legacyTarball, pin, join(main, "legacy"), join(REPO_ROOT, "crates", "ported.json"), ts.version);
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

/** Reads `packaging/legacy.json`, or the pin file given. */
export function legacyPin(file = join(PACKAGING, "legacy.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * @param {string[]} argv
 * @returns {{ out: string, binaries: Record<string, string>, legacyTarball?: string, legacyPin?: string, pack: boolean }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const binaries = {};
  let out;
  let legacyTarball;
  let legacyPinFile;
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
    else if (flag === "--legacy-pin") legacyPinFile = resolve(value);
    else if (flag === "--binary") {
      const at = value.indexOf("=");
      if (at <= 0) throw new Error("--binary must be <os>-<cpu>=<path>");
      binaries[value.slice(0, at)] = resolve(value.slice(at + 1));
    } else throw new Error(`unknown option ${flag}`);
  }
  if (out === undefined) throw new Error("--out is required");
  return { out, binaries, legacyTarball, legacyPin: legacyPinFile, pack: packIt };
}

async function main(argv) {
  if (argv[0] === "legacy") return legacyCommand(argv.slice(1));
  if (argv[0] === "check-pin") {
    if (argv.length > 1) throw new Error("check-pin takes no options");
    const stamp = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8")).version;
    assertPublishablePin(legacyPin(), stamp);
    assertReleaseVersions(workspaceVersion(), stamp);
    process.stdout.write("dist-assemble: packaging/legacy.json is complete\n");
    return 0;
  }
  const options = parseArgs(argv);
  const pin = legacyPin(options.legacyPin);
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

const USAGE = `usage: node scripts/js/dist-assemble.mjs --out <dir> --binary linux-x64=<path> [--binary ...]
                                    [--legacy-tarball <tgz>] [--legacy-pin <json>] [--pack]
       node scripts/js/dist-assemble.mjs legacy --from <ref> --out <dir> [--version <v>] [--write-pin] [--pin-out <file>]
       node scripts/js/dist-assemble.mjs legacy --from-dir <built checkout> --out <dir> ...
       node scripts/js/dist-assemble.mjs legacy --from-pin --out <dir> ...
       node scripts/js/dist-assemble.mjs check-pin
  -h, --help  print this text and exit`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exitOnHelp(process.argv.slice(2), USAGE);
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dist-assemble: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
