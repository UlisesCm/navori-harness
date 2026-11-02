"use strict";
// Spec 0062 T6 (R22; D17 of 0057, D53): what the `navori` npm package runs when its bins are still
// these JS files, either because the postinstall did not run (`--ignore-scripts`, scripts blocked
// by default in bun and pnpm) or because this platform has no binary.

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

/** The platforms with a binary package (R21); anything else runs the frozen TS. */
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

/** Exit code of `navori-native-hook` without a binary: the hook prologue runs its shell body. */
const NO_NATIVE_HOOK = 127;

/**
 * The platform package for this process, if one exists.
 * @param {string} platform
 * @param {string} arch
 * @returns {string | undefined}
 */
function platformPackage(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return PLATFORMS.includes(key) ? `@navori/${key}` : undefined;
}

/**
 * The binary the platform package installed next to this package, if any.
 * @param {string} root the `navori` package directory
 * @returns {string | undefined}
 */
function findBinary(root, pkg = platformPackage()) {
  if (pkg === undefined) return undefined;
  try {
    return require.resolve(`${pkg}/bin/navori`, { paths: [root] });
  } catch {
    // An optional dependency the manager skipped, or one that failed to install.
    return undefined;
  }
}

/** The frozen TS: the exact `dist/` of the last TS release, with its own `package.json`. */
function legacyEntry(root) {
  return join(root, "legacy", "dist", "index.js");
}

/**
 * The environment of whoever ran the bin, without what pnpm's shell shim added: it prepends its
 * store directories (`.../.pnpm/...`) to `NODE_PATH`, and the binary will not model a hook under a
 * `NODE_*` variable it did not get from the engine.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function callerEnv(env) {
  if (env.NODE_PATH === undefined) return env;
  const kept = env.NODE_PATH.split(":").filter((dir) => !/\/\.pnpm(\/|$)/.test(dir));
  const next = { ...env };
  if (kept.length === 0) delete next.NODE_PATH;
  else next.NODE_PATH = kept.join(":");
  return next;
}

/**
 * What a bin runs: the binary through Node, the frozen TS, or nothing for the native hook.
 * @param {"navori" | "navori-native-hook"} name
 * @param {{ root: string, binary?: string, argv: string[], env: NodeJS.ProcessEnv }} options
 * @returns {{ program: string, args: string[], env: NodeJS.ProcessEnv } | { exit: number }}
 */
function plan(name, { root, binary, argv, env }) {
  const legacy = legacyEntry(root);
  if (binary !== undefined) {
    // The binary delegates what it does not port to the frozen TS shipped beside it.
    const caller = callerEnv(env);
    return { program: binary, args: argv, env: { ...caller, NAVORI_TS_CLI: caller.NAVORI_TS_CLI || legacy } };
  }
  if (name === "navori-native-hook") return { exit: NO_NATIVE_HOOK };
  return { program: process.execPath, args: [legacy, ...argv], env };
}

/**
 * Runs a bin and ends this process the way the child ended (exit code or signal).
 * @param {"navori" | "navori-native-hook"} name
 * @param {string} root
 */
function launch(name, root) {
  const step = plan(name, { root, binary: findBinary(root), argv: process.argv.slice(2), env: process.env });
  if ("exit" in step) process.exit(step.exit);
  const result = spawnSync(step.program, step.args, { stdio: "inherit", env: step.env });
  if (result.error !== undefined) {
    process.stderr.write(`navori: cannot run ${step.program}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal !== null) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

module.exports = { PLATFORMS, NO_NATIVE_HOOK, platformPackage, findBinary, legacyEntry, callerEnv, plan, launch };
