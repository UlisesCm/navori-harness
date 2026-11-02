import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Spec 0059 D39 (R19): the tree `navori-rust` renders is byte-identical to the TS's (the oracle
 * proves it per fixture); this smoke proves the Rust tree also loads where it runs. The `pi`
 * fixture rendered with `navori-rust render --apply` loads in Pi's real `DefaultResourceLoader`
 * with the same handlers and tools as the TS render, and the Codex config it writes reads with
 * the TOML parser the trust suites use.
 *
 * Needs `target/debug/navori-rust` (or `NAVORI_RUST_BIN`) and `dist/`, as `bun run oracle:rust`
 * leaves them. Without them the suite is skipped, unless `NAVORI_RUST_TREE=1` (the `oracle` job of
 * `rust.yml`), where a missing binary fails.
 */

interface Oracle {
  FIXTURES_DIR: string;
  copyFixture: (from: string, to: string) => void;
}

const PKG = resolve(import.meta.dirname, "../../../..");
const ROOT = resolve(PKG, "../..");
const RUST_BIN = process.env.NAVORI_RUST_BIN ?? join(ROOT, "target", "debug", "navori-rust");
const TS_CLI = join(PKG, "dist", "index.js");
const REQUIRED = process.env.NAVORI_RUST_TREE === "1";
const ready = existsSync(RUST_BIN) && existsSync(TS_CLI);
const oracle = (await import(
  pathToFileURL(join(ROOT, "scripts", "js", "rust-oracle.mjs")).href
)) as Oracle;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Copies `fixture` to a fresh repo, renders it with `cli` and returns the repo. */
function render(fixture: string, cli: { cmd: string; args: string[] }): string {
  const work = mkdtempSync(join(tmpdir(), "navori-rust-tree-"));
  dirs.push(work);
  const repo = join(work, "repo");
  oracle.copyFixture(join(oracle.FIXTURES_DIR, fixture), repo);
  for (const dir of ["home", "backups"]) mkdirSync(join(work, dir));
  // A delegated run reaches this decoy instead of the TS, so only a native render passes.
  const decoy = join(work, "decoy.js");
  writeFileSync(decoy, "process.stderr.write('delegated to the TS\\n');\nprocess.exitCode = 97;\n");
  const run = spawnSync(cli.cmd, [...cli.args, "render", "--apply"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(work, "home"),
      NAVORI_BACKUP_ROOT: join(work, "backups"),
      NAVORI_TS_CLI: decoy,
      NO_COLOR: "1",
    },
  });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  return repo;
}

/** What Pi's real loader makes of the repo's project extensions. */
async function load(repo: string): Promise<LoadExtensionsResult> {
  const agentDir = join(repo, "..", "agent");
  mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({ cwd: repo, agentDir });
  await loader.reload({ resolveProjectTrust: async () => true });
  return loader.getExtensions();
}

describe.skipIf(!ready && !REQUIRED)("árbol de navori-rust", () => {
  // Covers: R19, R62
  it("la extensión Pi que escribe navori-rust carga en el cargador real de Pi", async () => {
    expect(existsSync(RUST_BIN), `${RUST_BIN}: run bun run oracle:rust`).toBe(true);
    const rust = render("pi", { cmd: RUST_BIN, args: [] });
    const ts = render("pi", { cmd: process.execPath, args: [TS_CLI] });
    expect(readFileSync(join(rust, ".pi/extensions/navori.ts"), "utf8")).toBe(
      readFileSync(join(ts, ".pi/extensions/navori.ts"), "utf8"),
    );
    const loaded = await load(rust);
    expect(loaded.errors).toEqual([]);
    const navori = loaded.extensions.find((e) => e.path.endsWith(".pi/extensions/navori.ts"));
    expect(navori, loaded.extensions.map((e) => e.path).join(", ")).toBeDefined();
    expect(navori?.handlers.size).toBeGreaterThan(0);
    expect(navori?.tools.size).toBeGreaterThan(0);
    // The same registrations as the TS render, loaded the same way.
    const reference = (await load(ts)).extensions.find((e) =>
      e.path.endsWith(".pi/extensions/navori.ts"),
    );
    expect([...(navori?.handlers.keys() ?? [])].sort()).toEqual(
      [...(reference?.handlers.keys() ?? [])].sort(),
    );
    expect([...(navori?.tools.keys() ?? [])].sort()).toEqual(
      [...(reference?.tools.keys() ?? [])].sort(),
    );
  });

  // Covers: R19
  it("el config.toml de Codex que escribe navori-rust lo lee el parser de las suites de trust", () => {
    const repo = render("codex", { cmd: RUST_BIN, args: [] });
    const config = parseToml(readFileSync(join(repo, ".codex/config.toml"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    expect(Object.keys(config.hooks ?? {}).length).toBeGreaterThan(0);
  });
});
