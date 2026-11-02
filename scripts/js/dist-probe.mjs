import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readSync, closeSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS, assemble, legacyPin, pack, workspaceVersion } from "./dist-assemble.mjs";
import { readCorpus } from "./hook-verdict-replay.mjs";
import { runRustHook } from "./rust-hook-adapter.mjs";
import { writeSignedAssets } from "./rust-replay-assets.mjs";
import { PERMANENT_DELEGATION } from "./rust-areas.mjs";

/**
 * Spec 0062 T7 (R84, R22; F43, F45): installs the assembled packages the way users will, on this
 * host's platform, and checks they answer. For npm, pnpm and bun, with and without install scripts:
 *
 *   - `navori --version` answers the binary's version, through the binary itself when the
 *     postinstall linked it, or through the JS launcher and Node when it did not;
 *   - `navori-native-hook` blocks a destructive command (a `guard-destructive` case of the corpus
 *     whose recorded verdict is a block);
 *   - a delegated subcommand reaches the frozen TS shipped in `legacy/`.
 *
 * One more scenario installs without the platform package (`--omit=optional`): `navori` is then the
 * frozen TS and `navori-native-hook` exits 127 so the hook prologue runs its shell body (R22).
 *
 *   node scripts/js/dist-probe.mjs [--binary <path>] [--managers npm,pnpm,bun] [--keep]
 *
 * The binary defaults to NAVORI_RUST_BIN, else `target/debug/navori-rust`. Without pnpm on PATH it
 * runs the pinned `pnpm@PNPM_VERSION` through npx.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The pnpm release the probe runs when none is installed. */
export const PNPM_VERSION = "12.16.1";

export const MANAGERS = ["npm", "pnpm", "bun"];

/**
 * How each manager installs the two tarballs, and whether its install leaves the native binary in
 * the bins (`linked`) or the JS launcher (pnpm's shims always run `node <bin>`, D53).
 * @param {"npm" | "pnpm" | "bun"} manager
 * @param {boolean} scripts
 * @param {string[]} tarballs
 * @returns {{ argv: string[], manifest: Record<string, unknown>, linked: boolean, env?: Record<string, string> }}
 */
export function installPlan(manager, scripts, tarballs) {
  const base = { name: "navori-dist-probe", version: "1.0.0", private: true };
  switch (manager) {
    case "npm":
      return {
        argv: ["npm", "install", "--no-audit", "--no-fund", ...(scripts ? [] : ["--ignore-scripts"]), ...tarballs],
        manifest: base,
        linked: scripts,
      };
    case "pnpm":
      // pnpm matches `allowBuilds: navori` against registry packages only; a local tarball's id is
      // `navori@file:<path>`, so the probe allows every build of its throwaway project instead.
      return {
        argv: ["pnpm", "add", ...(scripts ? [] : ["--ignore-scripts"]), ...tarballs],
        manifest: base,
        linked: false,
        ...(scripts ? { env: { PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true" } } : {}),
      };
    case "bun":
      // bun blocks dependency scripts unless the project trusts the package.
      return {
        argv: ["bun", "add", ...(scripts ? [] : ["--ignore-scripts"]), ...tarballs],
        manifest: scripts ? { ...base, trustedDependencies: ["navori"] } : base,
        linked: scripts,
      };
    default:
      throw new Error(`unknown manager ${manager}`);
  }
}

/** Whether a file starts with `#!`, i.e. is still the JS launcher rather than the binary. */
export function isScript(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
  } finally {
    closeSync(fd);
  }
}

/** The subcommand that must delegate: a permanent delegation entry, else an unknown one (F45). */
export function delegationProbe(list = PERMANENT_DELEGATION) {
  const entry = list[0];
  return entry === undefined ? ["__navori-dist-probe"] : [...entry.path, "--help"];
}

/** A corpus case the binary must block: `guard-destructive`, Claude, outside a repo, exit 2. */
export function blockingCase(corpus = readCorpus()) {
  const found = corpus.find(
    (c) =>
      c.hook === "guard-destructive.sh" &&
      c.engine === "claude" &&
      c.cwdKind === "none" &&
      (c.args ?? []).length === 0 &&
      (c.fixture ?? []).length === 0 &&
      Object.keys(c.envDelta).length === 0 &&
      c.expected.off.status === 2,
  );
  if (found === undefined) throw new Error("the corpus has no blocking guard-destructive case");
  return found;
}

/**
 * The PATH the hook check runs under: Node's directory and the system's. The probe tests that the
 * package delivers a native verdict; which host tools the binary accredits (a Homebrew `jq` on
 * GitHub's macOS images is not, so the hook defers to its shell body) is the hooks flow's matrix.
 */
export function hookPath(node = process.execPath) {
  return [dirname(node), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
}

/** The program and leading arguments for a manager, with pnpm through npx when not installed. */
function managerCommand(argv) {
  const [name, ...rest] = argv;
  if (name === "pnpm" && !onPath("pnpm")) return ["npx", "-y", `pnpm@${PNPM_VERSION}`, ...rest];
  return argv;
}

function onPath(name) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      return readdirSync(dir).includes(name);
    } catch {
      return false;
    }
  });
}

/**
 * Checks one installed project. Returns the failures (empty when it answers as expected).
 * @param {{ project: string, version: string, legacyVersion: string, native: boolean, linked: boolean, hooks: string }} s
 */
export function checkInstall({ project, version, legacyVersion, native, linked, hooks }) {
  const failures = [];
  const bins = join(project, "node_modules", ".bin");
  // The installed package alone decides where delegation goes.
  const env = { ...process.env };
  delete env.NAVORI_TS_CLI;
  delete env.NAVORI_DELEGATED;
  const run = (bin, args) =>
    spawnSync(join(bins, bin), args, { cwd: project, encoding: "utf8", env, timeout: 60_000 });

  const own = run("navori", ["--version"]);
  const expected = native ? version : legacyVersion;
  // The frozen TS prints through consola, which prefixes `[log] ` under CI: its last word counts.
  if (own.status !== 0 || own.stdout.trim().split(/\s+/).at(-1) !== expected) {
    failures.push(`navori --version answered ${JSON.stringify(own.stdout.trim())} (exit ${own.status}), expected ${expected}`);
  }
  const launcher = join(project, "node_modules", "navori", "bin", "navori");
  if (native && isScript(launcher) === linked) {
    failures.push(linked ? "the postinstall did not link the binary" : "the bin is not the JS launcher");
  }

  const hook = join(project, "node_modules", ".bin", "navori-native-hook");
  if (native) {
    const c = blockingCase();
    const cwd = mkdtempSync(join(tmpdir(), "navori-probe-cwd-"));
    try {
      const result = runRustHook({
        binary: hook,
        script: join(hooks, ".claude", "hooks", c.hook),
        input: c.input,
        cwd,
        env: { PATH: hookPath(), NAVORI_AUDITS_ROOT: join(cwd, "no-audits") },
      });
      if (!result.available || result.status !== 2) {
        // The adapter keeps a deferral's stderr to itself; one direct run says why.
        const again = spawnSync(hook, ["hook", "--via-script", join(hooks, ".claude", "hooks", c.hook)], {
          cwd,
          input: c.input,
          encoding: "utf8",
          env: { ...process.env, PATH: hookPath(), NAVORI_HOOK_IMPL: "rust", NAVORI_AUDITS_ROOT: join(cwd, "no-audits") },
        });
        failures.push(
          `navori-native-hook did not block a destructive command: ${JSON.stringify(result.available ? { status: result.status } : result)}; stderr: ${again.stderr.trim().slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const delegated = run("navori", delegationProbe());
    const text = `${delegated.stdout}${delegated.stderr}`;
    if ([69, 70].includes(delegated.status ?? -1) || !text.includes(`v${legacyVersion}`)) {
      failures.push(`a delegated subcommand did not reach the frozen TS v${legacyVersion} (exit ${delegated.status})`);
    }
  } else {
    const result = spawnSync(hook, ["hook"], { cwd: project, input: "", encoding: "utf8" });
    if (result.status !== 127) failures.push(`navori-native-hook without a binary exited ${result.status}, expected 127`);
  }
  return failures;
}

function parseArgs(argv) {
  const options = { binary: process.env.NAVORI_RUST_BIN || join(REPO_ROOT, "target", "debug", "navori-rust"), managers: MANAGERS, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--keep") {
      options.keep = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--binary") options.binary = resolve(value);
    else if (flag === "--managers") {
      options.managers = value.split(",");
      const unknown = options.managers.filter((m) => !MANAGERS.includes(m));
      if (unknown.length > 0) throw new Error(`unknown manager ${unknown.join(", ")}`);
    } else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const platform = `${process.platform}-${process.arch}`;
  if (!PLATFORMS.includes(platform)) throw new Error(`${platform} has no binary package; run the probe on ${PLATFORMS.join(", ")}`);
  const pin = legacyPin();
  const version = workspaceVersion();
  const root = mkdtempSync(join(tmpdir(), "navori-dist-probe-"));
  try {
    const dist = join(root, "dist");
    mkdirSync(dist);
    const fetched = spawnSync("npm", ["pack", `navori@${pin.version}`, "--pack-destination", dist, "--json"], { encoding: "utf8" });
    if (fetched.status !== 0) throw new Error(`npm pack navori@${pin.version} failed: ${fetched.stderr}`);
    const legacyTarball = join(dist, JSON.parse(fetched.stdout)[0].filename);
    const dirs = assemble({ out: dist, binaries: { [platform]: options.binary }, legacyTarball, pin, version });
    const main = pack(dirs.main, dist);
    const plat = pack(dirs.platforms[platform], dist);
    const hooks = writeSignedAssets(join(root, "hooks"));

    /** @type {Array<{ name: string, failures: string[] }>} */
    const results = [];
    const scenario = (name, argv, manifest, check, extraEnv = {}) => {
      const project = join(root, name);
      mkdirSync(project);
      writeFileSync(join(project, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      const [cmd, ...args] = managerCommand(argv);
      const install = spawnSync(cmd, args, { cwd: project, encoding: "utf8", timeout: 300_000, env: { ...process.env, ...extraEnv } });
      const failures = install.status === 0 ? check(project) : [`${argv.slice(0, 2).join(" ")} failed (exit ${install.status}): ${(install.stderr || install.stdout || String(install.error ?? "")).trim().slice(-400)}`];
      results.push({ name, failures });
    };
    for (const manager of options.managers) {
      for (const scripts of [true, false]) {
        const plan = installPlan(manager, scripts, [main, plat]);
        scenario(
          `${manager}-${scripts ? "scripts" : "no-scripts"}`,
          plan.argv,
          plan.manifest,
          (project) => checkInstall({ project, version, legacyVersion: pin.version, native: true, linked: plan.linked, hooks }),
          plan.env,
        );
      }
    }
    scenario("npm-no-binary", ["npm", "install", "--no-audit", "--no-fund", "--omit=optional", main], { name: "navori-dist-probe", version: "1.0.0", private: true }, (project) =>
      checkInstall({ project, version, legacyVersion: pin.version, native: false, linked: false, hooks }),
    );

    for (const r of results) {
      process.stdout.write(`  ${r.failures.length === 0 ? "ok  " : "FAIL"} ${r.name}\n`);
      for (const f of r.failures) process.stdout.write(`       ${f}\n`);
    }
    const ok = results.every((r) => r.failures.length === 0);
    process.stdout.write(`dist-probe: ${platform} ${ok ? "green" : "red"} (${results.length} installs)\n`);
    return ok ? 0 : 1;
  } finally {
    if (options.keep) process.stdout.write(`dist-probe: kept ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dist-probe: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
