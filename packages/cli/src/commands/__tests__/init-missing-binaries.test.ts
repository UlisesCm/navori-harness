import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { formatMissingBinaryHow } from "../init.ts";
import { loadPlugin } from "../../lib/config/plugins.ts";
import { currentPlatform } from "../../lib/config/platform.ts";
import { t, tc } from "../../lib/i18n.ts";

/**
 * #1023 — `init --yes`/`init --recommended` used to only warn about a missing
 * external-tool binary under `--full` (packages/cli/src/commands/init.ts:372,
 * pre-fix). An always-on plugin like engram could land in `.mcp.json` with no
 * working binary and no warning at all in a headless run. `reportMissingBinaries`
 * now runs in every mode that writes config.
 *
 * These are e2e (spawn the built CLI) rather than in-process, because the rest
 * of `initCommand`'s auto-yes path (detectProject, writeConfig, registry) isn't
 * exercised anywhere else without a real process — matching the existing
 * `cli.e2e.test.ts` pattern. `hasBinary` (lib/primitives/which.ts) reads
 * `process.env.PATH` directly with no shell lookup, so overriding PATH in the
 * child's env is equivalent to mocking `hasBinary` without depending on
 * whatever the host machine happens to have installed (never assumes engram
 * is present OR absent on the machine running the suite).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "..", "dist", "index.js");
const NODE_BIN_DIR = dirname(process.execPath);

const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-e2e-home-missing-bin-"));
afterAll(() => {
  rmSync(E2E_HOME, { recursive: true, force: true });
});

interface CliResult {
  status: number;
  combined: string;
}

function runCli(args: string[], pathOverride: string): CliResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { HOME: E2E_HOME, NO_COLOR: "1", PATH: pathOverride },
  });
  return {
    status: r.status ?? -1,
    combined: stripVTControlCharacters((r.stdout ?? "") + (r.stderr ?? "")),
  };
}

const PATH_SEP = process.platform === "win32" ? ";" : ":";
// Only node's own bin dir — guarantees `engram` (or any plugin binary) isn't
// resolvable regardless of what's installed on the dev/CI machine's real PATH.
const PATH_WITHOUT_BINARIES = NODE_BIN_DIR;

// A fake, always-executable `engram` planted in its own dir — deterministic
// "binary present" case that never depends on whether the host machine
// actually has the real engram installed.
const FAKE_BIN_DIR = mkdtempSync(join(tmpdir(), "navori-fake-bin-"));
const fakeEngramName = process.platform === "win32" ? "engram.cmd" : "engram";
writeFileSync(join(FAKE_BIN_DIR, fakeEngramName), "#!/bin/sh\nexit 0\n", "utf-8");
if (process.platform !== "win32") chmodSync(join(FAKE_BIN_DIR, fakeEngramName), 0o755);
afterAll(() => {
  rmSync(FAKE_BIN_DIR, { recursive: true, force: true });
});
const PATH_WITH_BINARIES = `${FAKE_BIN_DIR}${PATH_SEP}${NODE_BIN_DIR}`;

function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-e2e-missing-bin-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf-8");
  return dir;
}

// `init` writes the wizard's default language (es, since these e2e runs
// never pass --lang) — mirror that here so `expectedHow` matches what the
// spawned CLI actually prints, whatever the host platform's install command
// looks like (single-line `brew install ...` on darwin, or engram's
// multi-line release-download script on linux).
const engramTool = loadPlugin("engram").manifest.externalTool;
const platform = currentPlatform();
const engramInstallForHostPlatform = platform ? (engramTool?.install?.[platform] ?? null) : null;
const expectedHow = formatMissingBinaryHow(
  {
    install: engramInstallForHostPlatform,
    postInstall: engramTool?.postInstall ?? null,
    installDocs: engramTool?.installDocs ?? null,
  },
  t("es"),
  tc("es").doctor,
);

describe("init missing-binary warning (#1023)", () => {
  let dirs: string[] = [];

  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI}. Run 'bun run build' before tests.`);
    }
    mkdirSync(E2E_HOME, { recursive: true });
  });

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    dirs = [];
  });

  it("init --yes with engram absent from PATH warns with the binary and its install command", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    const r = runCli(["init", "--yes", "--no-render", "--cwd", repo], PATH_WITHOUT_BINARIES);

    expect(r.status).toBe(0);
    expect(r.combined).toContain("engram");
    expect(r.combined).toContain(expectedHow);
  });

  it("init --recommended with engram absent from PATH warns with the binary and its install command", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    const r = runCli(
      ["init", "--recommended", "--no-render", "--cwd", repo],
      PATH_WITHOUT_BINARIES,
    );

    expect(r.status).toBe(0);
    expect(r.combined).toContain("engram");
    expect(r.combined).toContain(expectedHow);
  });

  it("init --yes with engram present on PATH emits no missing-binary warning", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    const r = runCli(["init", "--yes", "--no-render", "--cwd", repo], PATH_WITH_BINARIES);

    expect(r.status).toBe(0);
    expect(r.combined).not.toContain(expectedHow);
  });

  it("init --recommended with engram present on PATH emits no missing-binary warning", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    const r = runCli(["init", "--recommended", "--no-render", "--cwd", repo], PATH_WITH_BINARIES);

    expect(r.status).toBe(0);
    expect(r.combined).not.toContain(expectedHow);
  });
});

/**
 * #1023 review — a multi-line `install` script must never be truncated to
 * its first line: for engram on Linux that line is `set -euo pipefail`,
 * a shell directive with no download/verify/move logic, so pasting it
 * installs nothing (the exact broken-MCP-with-no-actionable-warning state
 * the ticket reports). Uses engram's real Linux manifest data directly
 * (packages/plugins/engram/plugin.json) instead of spawning the CLI, so the
 * assertion holds regardless of which OS runs the suite.
 */
describe("formatMissingBinaryHow — multi-line install (#1023 review)", () => {
  const linuxInstall = engramTool?.install?.linux;

  it("engram's linux install script is in fact multi-line (test premise)", () => {
    expect(linuxInstall).toBeTruthy();
    expect(linuxInstall).toContain("\n");
  });

  it("points at installDocs instead of truncating the script to its first line", () => {
    const how = formatMissingBinaryHow(
      {
        install: linuxInstall ?? null,
        postInstall: engramTool?.postInstall ?? null,
        installDocs: engramTool?.installDocs ?? null,
      },
      t("es"),
      tc("es").doctor,
    );

    expect(how).not.toContain("set -euo pipefail");
    expect(engramTool?.installDocs).toBeTruthy();
    expect(how).toContain(engramTool!.installDocs!);
  });

  it("falls back to the 'navori doctor' hint when there's no installDocs to point at", () => {
    const how = formatMissingBinaryHow(
      { install: linuxInstall ?? null, postInstall: null, installDocs: null },
      t("es"),
      tc("es").doctor,
    );

    expect(how).not.toContain("set -euo pipefail");
    expect(how).toContain("navori doctor");
  });
});
