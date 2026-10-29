import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeManagedHash } from "../lib/render/marker.ts";

/**
 * Spec 0057 R8-R10 / D5 - the differential oracle (`scripts/js/rust-oracle.mjs`). The real
 * TS-vs-Rust run is `bun run oracle:rust`; here only stub runners and fixed strings, so nothing
 * needs `dist/` or a Rust build.
 */

interface Runner {
  cmd: string;
  args: string[];
  version: string;
}
interface Difference {
  kind: string;
  detail: string;
}
interface OracleCase {
  id: string;
  fixture: string;
  args: string[];
  mask?: string[];
  files?: Record<string, string>;
}
interface Rule {
  name: string;
  token: string;
}
interface Oracle {
  RULES: Rule[];
  EMBEDDED_CORE: string;
  FIXTURES_DIR: string;
  CASES_PATH: string;
  normalizeText: (text: string) => string;
  maskSide: (
    text: string,
    side: "ts" | "rust",
    ctx: { tsVersion: string; rustVersion: string; tsCli: string },
    where: { stream: "stdout" | "stderr" | "file"; mask: string[] },
  ) => string;
  loadCases: () => OracleCase[];
  antiRollbackCases: (cliVersion: string) => OracleCase[];
  ANTI_ROLLBACK_LEVELS: string[];
  ANTI_ROLLBACK_OPS: string[];
  runCase: (
    testCase: OracleCase,
    opts: { ts: Runner; rust: Runner; tsCli: string; base: string },
  ) => { id: string; exit: number | null; differences: Difference[] };
}

const here = dirname(fileURLToPath(import.meta.url));
const oracle = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "rust-oracle.mjs")).href
)) as Oracle;

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "navori-oracle-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A runner that executes `body` with `sh`, in the case's repo dir. */
function stub(dir: string, name: string, body: string): Runner {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { cmd: path, args: [], version: "1.0.0" };
}

describe("rust oracle", () => {
  // Covers: R8
  it("una diferencia de un byte en el árbol se reporta", () => {
    const dir = tmp();
    const base = tmp();
    const testCase: OracleCase = { id: "stub", fixture: "empty", args: [] };
    const run = (rustBody: string) =>
      oracle.runCase(testCase, {
        ts: stub(dir, "ts.sh", `printf 'out\\n'; printf 'abc' > result.txt`),
        rust: stub(dir, "rust.sh", rustBody),
        tsCli: "/unused/index.js",
        base,
      });

    const same = run(`printf 'out\\n'; printf 'abc' > result.txt`);
    expect(same.differences).toEqual([]);

    const oneByte = run(`printf 'out\\n'; printf 'abd' > result.txt`);
    expect(oneByte.differences).toHaveLength(1);
    expect(oneByte.differences[0]).toMatchObject({ kind: "tree:repo" });
    expect(oneByte.differences[0]?.detail).toContain("result.txt");
    expect(oneByte.differences[0]?.detail).toContain("byte 2");

    // exit code, stdout and stderr are compared as well
    expect(run(`printf 'out\\n'; printf 'abc' > result.txt; exit 3`).differences).toMatchObject([
      { kind: "exit" },
    ]);
    expect(run(`printf 'OUT\\n'; printf 'abc' > result.txt`).differences).toMatchObject([
      { kind: "stdout" },
    ]);
    expect(
      run(`printf 'out\\n'; printf 'abc' > result.txt; echo oops >&2`).differences,
    ).toMatchObject([{ kind: "stderr" }]);
    // a mode difference is a difference
    expect(
      run(`printf 'out\\n'; printf 'abc' > result.txt; chmod 600 result.txt`).differences,
    ).toMatchObject([{ kind: "tree:repo", detail: expect.stringContaining("mode") }]);
  });

  // Covers: R8
  it("lo escrito en los roots de backup y auditoría también se compara", () => {
    const dir = tmp();
    const base = tmp();
    const testCase: OracleCase = { id: "roots", fixture: "empty", args: [] };
    const run = (body: string) =>
      oracle.runCase(testCase, {
        ts: stub(
          dir,
          "ts.sh",
          `printf 'x' > "$NAVORI_BACKUP_ROOT/b"; printf 'y' > "$NAVORI_AUDITS_ROOT/a"`,
        ),
        rust: stub(dir, "rust.sh", body),
        tsCli: "/unused/index.js",
        base,
      });
    expect(
      run(`printf 'x' > "$NAVORI_BACKUP_ROOT/b"; printf 'y' > "$NAVORI_AUDITS_ROOT/a"`).differences,
    ).toEqual([]);
    expect(
      run(`printf 'x' > "$NAVORI_BACKUP_ROOT/b"; printf 'Y' > "$NAVORI_AUDITS_ROOT/a"`).differences,
    ).toMatchObject([{ kind: "tree:audits" }]);
    expect(run(`printf 'y' > "$NAVORI_AUDITS_ROOT/a"`).differences).toMatchObject([
      { kind: "tree:backups" },
    ]);
  });

  // One entry per rule of the closed table: values of the same format, a change outside the
  // pattern, and a format variant that must stay visible.
  const mutations: Record<
    string,
    { a: string; b: string; outside: string; variantA: string; variantB: string }
  > = {
    ISO: {
      a: "at 2026-01-02T03:04:05.678Z end",
      b: "at 2027-05-06T07:08:09.111Z end",
      outside: "at 2026-01-02T03:04:05.678Z enD",
      variantA: "at 2026-01-02T03:04:05.678+00:00 end",
      variantB: "at 2027-05-06T07:08:09.111+00:00 end",
    },
    EPOCHMS: {
      a: '{"tsMs":1700000000000,"n":1}',
      b: '{"tsMs":1800000000123,"n":1}',
      outside: '{"tsMs":1700000000000,"n":2}',
      variantA: '{"tsMs":170000000000,"n":1}',
      variantB: '{"tsMs":180000000000,"n":1}',
    },
    UUID: {
      a: "id 3f2b8c1e-1a2b-4c3d-8e4f-0123456789ab.",
      b: "id 9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d.",
      outside: "id 3f2b8c1e-1a2b-4c3d-8e4f-0123456789ab!",
      variantA: "id 3F2B8C1E-1A2B-4C3D-8E4F-0123456789AB.",
      variantB: "id 9A8B7C6D-5E4F-4A3B-9C2D-1E0F9A8B7C6D.",
    },
    BACKUP: {
      a: "backups/repo-2026-01-02T03-04-05-678-p123-0/x",
      b: "backups/repo-2027-05-06T07-08-09-111-p123-0/x",
      outside: "backups/repo-2026-01-02T03-04-05-678-p123-1/x",
      variantA: "backups/repo-2026-01-02T03-04-05-67-p123-0/x",
      variantB: "backups/repo-2027-05-06T07-08-09-11-p123-0/x",
    },
    PID: {
      a: '{"pid":123,"n":1}',
      b: '{"pid":45678,"n":1}',
      outside: '{"pid":123,"n":2}',
      variantA: '{"ppid":123,"n":1}',
      variantB: '{"ppid":456,"n":1}',
    },
    MS: {
      a: "p95    1.2ms",
      b: "p95    97.5ms",
      outside: "p96    1.2ms",
      variantA: "took 1.2ms",
      variantB: "took 97.5ms",
    },
  };

  // Covers: R8, R9
  it("cada regla de normalización tiene una mutación que la rompe", () => {
    expect(oracle.RULES.map((rule) => rule.name).sort()).toEqual(Object.keys(mutations).sort());
    for (const rule of oracle.RULES) {
      const m = mutations[rule.name];
      expect(m, `mutation entry for ${rule.name}`).toBeDefined();
      if (!m) continue;
      const n = oracle.normalizeText;
      // the rule recognises its exact format and hides only the value
      expect(n(m.a), `${rule.name} replaces its token`).toContain(rule.token);
      expect(n(m.a), `${rule.name}: values of the same format are equal`).toBe(n(m.b));
      // a difference outside the pattern still fails
      expect(n(m.a), `${rule.name}: a byte outside the pattern`).not.toBe(n(m.outside));
      // a format variant does not match, so the difference stays visible
      expect(n(m.variantA), `${rule.name}: format variant`).not.toBe(n(m.variantB));
      expect(n(m.variantA)).not.toContain(rule.token);
    }
  });

  // Covers: R8
  it("una diferencia dentro de un marker sigue fallando tras normalizar", () => {
    const marker = (hash: string): string =>
      `<!-- navori:managed id="x" hash="${hash}" version="0.12.2" source="@navori/core" -->\nbody 2026-01-02T03:04:05.678Z\n`;
    expect(oracle.normalizeText(marker("5d83b387"))).not.toBe(
      oracle.normalizeText(marker("5d83b388")),
    );
  });

  // Covers: R5, R8
  it("las máscaras de lado son literales y no tocan lo demás", () => {
    const ctx = { tsVersion: "0.12.2", rustVersion: "0.13.0-rust.1", tsCli: "/w/dist/index.js" };
    const notice = `navori-rust: warning: delegating to TS navori 0.12.2 at /w/dist/index.js (navori-rust is 0.13.0-rust.1)\n`;
    const stderr = { stream: "stderr" as const, mask: [] };
    expect(oracle.maskSide(`${notice}real error\n`, "rust", ctx, stderr)).toBe("real error\n");
    // other formats, other paths and the TS side are never dropped
    expect(oracle.maskSide(notice.replace("0.12.2", "0.12.3"), "rust", ctx, stderr)).toContain(
      "warning",
    );
    expect(oracle.maskSide(notice.replace("/w/", "/x/"), "rust", ctx, stderr)).toContain("warning");
    expect(oracle.maskSide(notice, "ts", ctx, stderr)).toBe(notice);
    // the version mask applies only to stdout of the cases that ask for it
    const stdout = { stream: "stdout" as const, mask: ["version"] };
    expect(oracle.maskSide("(navori v0.13.0-rust.1)\n", "rust", ctx, stdout)).toBe(
      "(navori v@VERSION@)\n",
    );
    expect(oracle.maskSide("(navori v0.12.2)\n", "ts", ctx, stdout)).toBe("(navori v@VERSION@)\n");
    expect(oracle.maskSide("0.13.0-rust.1\n", "rust", ctx, { stream: "stdout", mask: [] })).toBe(
      "0.13.0-rust.1\n",
    );
    expect(oracle.maskSide("v0.13.0-rust.10\n", "rust", ctx, stdout)).toBe("v0.13.0-rust.10\n");
  });

  // Covers: R41
  it("la máscara de procedencia solo toca su línea literal", () => {
    const ctx = { tsVersion: "0.12.2", rustVersion: "0.13.0-rust.1", tsCli: "/w/dist/index.js" };
    const stdout = { stream: "stdout" as const, mask: ["provenance"] };
    const embedded = `│  core: ${oracle.EMBEDDED_CORE}\n`;
    const mask = (
      text: string,
      side: "ts" | "rust" = "ts",
      where: { stream: "stdout" | "stderr" | "file"; mask: string[] } = stdout,
    ): string => oracle.maskSide(text, side, ctx, where);
    // the bundled TS line, in both languages, becomes the Rust one
    expect(mask("│  core: /w/dist/assets/core (build copy)\n│  next\n")).toBe(
      `${embedded}│  next\n`,
    );
    expect(mask("│  core: /w/dist/assets/core (copia del build)\n")).toBe(embedded);
    expect(mask(`  "coreRoot": "/w/dist/assets/core",\n  "bundled": true,\n`)).toBe(
      `  "coreRoot": "(embedded)",\n  "bundled": true,\n`,
    );
    // mutations: another root, the dev sources, a stale core, another key or another
    // place in the line stay visible
    for (const visible of [
      "│  core: /x/dist/assets/core (build copy)\n",
      "│  core: /w/dist/assets/core (dev sources)\n",
      "│  core: /w/dist/assets/core (build copy) stale\n",
      `  "pluginRoot": "/w/dist/assets/core",\n`,
      `  "coreRoot": "/w/dist/assets/core/x",\n`,
    ]) {
      expect(mask(visible), visible).toBe(visible);
    }
    // only the TS side, only stdout, only the cases that ask for it
    const line = "│  core: /w/dist/assets/core (build copy)\n";
    expect(mask(line, "rust")).toBe(line);
    expect(mask(line, "ts", { stream: "stderr", mask: ["provenance"] })).toBe(line);
    expect(mask(line, "ts", { stream: "stdout", mask: [] })).toBe(line);
  });

  // Covers: R41, R49
  it("cada comando portado tiene caso en cada fixture aplicable", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(here, "..", "..", "..", "..", "crates", "ported.json"), "utf8"),
    ) as {
      commands: Array<{ path: string[]; flags?: string[]; when?: { engines?: string[] } }>;
    };
    const cases = oracle.loadCases();
    const fixtures = readdirSync(oracle.FIXTURES_DIR);
    const ported = manifest.commands.filter((c) => c.when?.engines);
    expect(ported.map((c) => c.path.join(" "))).toContain("render");
    for (const command of ported) {
      const engines = command.when?.engines ?? [];
      const languages = new Set<string>();
      for (const fixture of fixtures) {
        const configPath = join(oracle.FIXTURES_DIR, fixture, "navori.config.json");
        if (!existsSync(configPath)) continue;
        const config = JSON.parse(readFileSync(configPath, "utf8")) as {
          engines?: string[];
          language?: string;
          monorepo?: { enabled?: boolean; workspaces?: unknown[] };
        };
        const workspaces =
          config.monorepo?.enabled === true && (config.monorepo.workspaces ?? []).length > 0;
        const applicable =
          !workspaces && (config.engines ?? ["claude"]).every((e) => engines.includes(e));
        if (!applicable) continue;
        // Cases inside the native subset: the command, then only its declared flags.
        const declared = (args: string[]): boolean =>
          args.every(
            (arg, i) =>
              (arg.startsWith("--") && (command.flags ?? []).includes(arg.slice(2))) ||
              args[i - 1] === "--cwd",
          );
        const mine = cases.filter(
          (c) =>
            c.fixture === fixture &&
            command.path.every((part, i) => c.args[i] === part) &&
            declared(c.args.slice(command.path.length)),
        );
        const label = `${command.path.join(" ")} on ${fixture}`;
        expect(
          mine.some((c) => !c.args.includes("--json")),
          label,
        ).toBe(true);
        if (command.flags?.includes("json")) {
          expect(
            mine.some((c) => c.args.includes("--json")),
            `${label} --json`,
          ).toBe(true);
        }
        for (const c of mine) expect(c.mask, c.id).toContain("provenance");
        languages.add(config.language ?? "es");
      }
      expect([...languages].sort(), command.path.join(" ")).toEqual(["en", "es"]);
    }
  });

  // Covers: R37, R49
  it("la matriz anti-rollback tiene cada celda y su bloque se lee como de navori", () => {
    const cells = oracle.antiRollbackCases("0.12.3");
    const levels = oracle.ANTI_ROLLBACK_LEVELS;
    expect(levels).toEqual(["absent", "lower", "equal", "higher"]);
    expect(oracle.ANTI_ROLLBACK_OPS).toEqual(["inject", "hook", "settings"]);
    const ids = new Set(cells.map((c) => c.id));
    for (const op of oracle.ANTI_ROLLBACK_OPS)
      for (const floor of levels)
        for (const marker of levels)
          expect(ids.has(`anti-rollback:${op}:floor-${floor}:marker-${marker}`)).toBe(true);
    expect(cells).toHaveLength(oracle.ANTI_ROLLBACK_OPS.length * levels.length ** 2);
    // every cell runs in the oracle, natively and masked like any render
    const loaded = new Set(oracle.loadCases().map((c) => c.id));
    for (const c of cells) {
      expect(loaded.has(c.id), c.id).toBe(true);
      expect(c.args).toEqual(["render", "--apply"]);
      expect(c.mask).toEqual(["provenance"]);
    }
    // the floor lands in the config, the stamp on the block, and the block hash matches its body
    const cell = (id: string): OracleCase => {
      const found = cells.find((c) => c.id === id);
      if (!found) throw new Error(id);
      return found;
    };
    const higher = cell("anti-rollback:inject:floor-higher:marker-lower").files ?? {};
    expect(JSON.parse(higher["navori.config.json"] ?? "{}").harnessVersion).toBe("999.0.0");
    expect(higher["CLAUDE.md"]).toContain('version="0.1.0"');
    const absent = cell("anti-rollback:inject:floor-absent:marker-absent").files ?? {};
    expect(JSON.parse(absent["navori.config.json"] ?? "{}")).not.toHaveProperty("harnessVersion");
    expect(absent["CLAUDE.md"]).not.toContain("version=");
    expect(absent["CLAUDE.md"]).toContain(`hash="${computeManagedHash("Older body.")}"`);
    const hook = cell("anti-rollback:hook:floor-equal:marker-equal").files ?? {};
    expect(hook[".claude/hooks/implementer-no-markdown.sh"]).toContain(
      `hash="${computeManagedHash("#!/usr/bin/env bash\nexit 0")}" version="0.12.3"`,
    );
  });

  // Covers: R9
  it("los casos cubren el repo con contenido de usuario y la superficie del golden", () => {
    const cases = oracle.loadCases();
    const user = cases.find((c) => c.id === "user-content-outside-markers");
    expect(user, "case user-content-outside-markers").toBeDefined();
    for (const c of cases) {
      expect(existsSync(join(oracle.FIXTURES_DIR, c.fixture)), `fixture of ${c.id}`).toBe(true);
    }
    // the fixture really has hand-written content outside the markers
    const claude = readFileSync(
      join(oracle.FIXTURES_DIR, "user-content", "CLAUDE.md.fixture"),
      "utf8",
    );
    expect(claude.startsWith("# Project notes (hand-written")).toBe(true);
    expect(claude).toContain("Hand-written note between two managed blocks.");
    expect(claude).toContain("Trailing hand-written footer.");
    // one surface case per entry of cli-surface.golden.json
    const golden = JSON.parse(
      readFileSync(resolve(here, "fixtures", "cli-surface.golden.json"), "utf8"),
    ) as { cases: Array<{ args: string[] }> };
    const surface = cases.filter((c) => c.id.startsWith("surface:"));
    expect(surface.map((c) => c.args)).toEqual(golden.cases.map((c) => c.args));
    // natively ported commands mask the Rust version; delegated ones mask nothing
    expect(surface.find((c) => c.id === "surface:--version")?.mask).toEqual(["version"]);
    expect(surface.find((c) => c.id === "surface:init_--help")?.mask).toBeUndefined();
  });
});
