"use strict";
// Spec 0062 T6 (R22; D17 of 0057, D53): the postinstall puts the platform binary in place of both
// JS bins, so `navori` and the native hook start without Node. It only does so when the binary
// answers `--version` with this package's version; otherwise the JS bins stay and run it through
// Node (F43). It never fails the install.

const { spawnSync } = require("node:child_process");
const { chmodSync, copyFileSync, readFileSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { findBinary } = require("./launcher.js");

const BINS = ["navori", "navori-native-hook"];

/**
 * pnpm links bins through a shell shim that runs `node <bin>`, so a native file there would be
 * handed to Node: under pnpm the JS bins stay.
 * @param {NodeJS.ProcessEnv} env
 */
function shimsRunNode(env) {
  return (env.npm_config_user_agent ?? "").startsWith("pnpm/");
}

/**
 * @param {{ root: string, binary?: string, env: NodeJS.ProcessEnv }} options
 * @returns {string} what happened, for the install log
 */
function linkBinary({ root, binary, env }) {
  if (shimsRunNode(env)) return "kept the JS bins: pnpm runs bins through node";
  if (binary === undefined) return "kept the JS bins: no binary for this platform";
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const probe = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const reported = probe.status === 0 ? probe.stdout.trim() : undefined;
  if (reported !== version) {
    return `kept the JS bins: ${binary} --version answered ${reported ?? "nothing"}, expected ${version}`;
  }
  for (const name of BINS) {
    const target = join(root, "bin", name);
    const staged = `${target}.${process.pid}.tmp`;
    try {
      copyFileSync(binary, staged);
      chmodSync(staged, 0o755);
      // Same directory, so the replacement is atomic: a bin is either the JS file or the binary.
      renameSync(staged, target);
    } finally {
      rmSync(staged, { force: true });
    }
  }
  return `linked ${binary}`;
}

/** Entry point of `postinstall.js`. */
function postinstall(root) {
  let outcome;
  try {
    outcome = linkBinary({ root, binary: findBinary(root), env: process.env });
  } catch (error) {
    outcome = `kept the JS bins: ${error instanceof Error ? error.message : String(error)}`;
  }
  process.stdout.write(`navori postinstall: ${outcome}\n`);
}

module.exports = { BINS, shimsRunNode, linkBinary, postinstall };
