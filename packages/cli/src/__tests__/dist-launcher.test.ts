import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Spec 0062 T6 (R21, R22): the `navori` npm package's launcher, postinstall and assembly. */

type Env = Record<string, string | undefined>;
type Step = { program: string; args: string[]; env: Env } | { exit: number };
interface Launcher {
  PLATFORMS: string[];
  NO_NATIVE_HOOK: number;
  platformPackage: (platform?: string, arch?: string) => string | undefined;
  callerEnv: (env: Env) => Env;
  plan: (
    name: "navori" | "navori-native-hook",
    options: { root: string; binary?: string; argv: string[]; env: Env },
  ) => Step;
}
interface Install {
  linkBinary: (options: { root: string; binary?: string; env: Env }) => string;
}
interface Assemble {
  PLATFORMS: string[];
  integrityOf: (file: string) => string;
  unpackLegacy: (
    tarball: string,
    pin: { version: string; integrity: string },
    target: string,
  ) => void;
  mainManifest: (
    version: string,
    ts: Record<string, unknown>,
  ) => {
    bin: Record<string, string>;
    optionalDependencies: Record<string, string>;
    scripts: Record<string, string>;
    files: string[];
  };
  platformManifest: (
    platform: string,
    version: string,
    ts: Record<string, unknown>,
  ) => { name: string; os: string[]; cpu: string[] };
}

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
const npmDir = join(repo, "packaging", "npm");
const require = createRequire(import.meta.url);
const launcher = require(join(npmDir, "lib", "launcher.js")) as Launcher;
const install = require(join(npmDir, "lib", "install.js")) as Install;
const assemble = (await import(
  pathToFileURL(join(repo, "scripts", "js", "dist-assemble.mjs")).href
)) as Assemble;

const host = `${process.platform}-${process.arch}`;
const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  // Canonical, so paths the bins compute (macOS: /private/var) match the ones expected here.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-dist-launcher-")));
  dirs.push(dir);
  return dir;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** An installed `navori` package: the real JS bins, a fake frozen TS and, optionally, a binary. */
function installed(binaryBody?: string): string {
  const root = join(scratch(), "node_modules", "navori");
  cpSync(npmDir, root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "navori", version: "9.9.9" })}\n`,
  );
  mkdirSync(join(root, "legacy", "dist"), { recursive: true });
  writeFileSync(
    join(root, "legacy", "dist", "index.js"),
    "console.log(['legacy', ...process.argv.slice(2)].join(' ')); process.exitCode = 3;\n",
  );
  const pkg = launcher.platformPackage();
  if (binaryBody !== undefined && pkg !== undefined) {
    const binDir = join(root, "..", ...pkg.split("/"), "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "..", "package.json"),
      `${JSON.stringify({ name: pkg, version: "9.9.9" })}\n`,
    );
    executable(join(binDir, "navori"), binaryBody);
  }
  return root;
}

function bin(
  root: string,
  name: string,
  args: string[] = [],
  env: Env = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [join(root, "bin", name), ...args], {
    encoding: "utf8",
    env: { ...process.env, NAVORI_TS_CLI: undefined, ...env },
  });
}

describe("lanzador del paquete navori", () => {
  // Covers: R22
  it("sin binario corre legacy y sin postinstall corre el binario por Node", () => {
    const legacy = (root: string): string => join(root, "legacy", "dist", "index.js");
    const env = {
      PATH: "/usr/bin",
      NODE_PATH: "/p/node_modules/.bin/../.pnpm/x/node_modules:/mine",
    };
    const viaNode = launcher.plan("navori", { root: "/pkg", binary: "/bin/nv", argv: ["a"], env });
    expect(viaNode).toEqual({
      program: "/bin/nv",
      args: ["a"],
      // pnpm's shim prefix is dropped; the caller's own entry stays
      env: { PATH: "/usr/bin", NODE_PATH: "/mine", NAVORI_TS_CLI: legacy("/pkg") },
    });
    expect(
      launcher.plan("navori", {
        root: "/pkg",
        binary: "/bin/nv",
        argv: [],
        env: { NAVORI_TS_CLI: "/x.js" },
      }),
    ).toMatchObject({ env: { NAVORI_TS_CLI: "/x.js" } });
    expect(launcher.plan("navori", { root: "/pkg", argv: ["a"], env })).toEqual({
      program: process.execPath,
      args: [legacy("/pkg"), "a"],
      env,
    });
    expect(launcher.plan("navori-native-hook", { root: "/pkg", argv: [], env })).toEqual({
      exit: 127,
    });
    expect(launcher.callerEnv({ NODE_PATH: "/a/.pnpm/b:/a/.pnpm" })).toEqual({});
    expect(launcher.platformPackage("linux", "x64")).toBe("@navori/linux-x64");
    expect(launcher.platformPackage("win32", "x64")).toBeUndefined();
    expect(launcher.PLATFORMS).toEqual(assemble.PLATFORMS);
  });

  // Covers: R22
  it.runIf(launcher.PLATFORMS.includes(host))(
    "los bins JS ejecutan el binario, el TS congelado o salen con 127, y reproducen su salida",
    () => {
      const withBinary = installed('echo "binary $* ts=$NAVORI_TS_CLI"; exit 7');
      const run = bin(withBinary, "navori", ["x", "y"]);
      expect(run.status).toBe(7);
      expect(run.stdout).toBe(`binary x y ts=${join(withBinary, "legacy", "dist", "index.js")}\n`);
      expect(bin(withBinary, "navori-native-hook", ["hook"]).stdout).toMatch(/^binary hook /);

      const killed = installed("kill -TERM $$");
      expect(bin(killed, "navori").signal).toBe("SIGTERM");

      const without = installed();
      const legacy = bin(without, "navori", ["--version"]);
      expect(legacy.stdout).toBe("legacy --version\n");
      expect(legacy.status).toBe(3);
      expect(bin(without, "navori-native-hook", ["hook"]).status).toBe(launcher.NO_NATIVE_HOOK);
    },
  );
});

describe("postinstall", () => {
  // Covers: R22
  it("pone el binario en ambos bins solo si --version coincide, y nunca bajo pnpm", () => {
    const root = installed();
    const binary = join(scratch(), "navori");
    const original = readFileSync(join(root, "bin", "navori"), "utf8");
    const npmAgent = { npm_config_user_agent: "npm/11.20.0 node/v24" };

    executable(binary, "echo 1.0.0");
    expect(install.linkBinary({ root, binary, env: npmAgent })).toMatch(/expected 9\.9\.9/);
    expect(readFileSync(join(root, "bin", "navori"), "utf8")).toBe(original);
    expect(install.linkBinary({ root, env: npmAgent })).toMatch(/no binary/);

    executable(binary, "echo 9.9.9");
    expect(
      install.linkBinary({ root, binary, env: { npm_config_user_agent: "pnpm/12.16.1" } }),
    ).toMatch(/pnpm/);
    expect(readFileSync(join(root, "bin", "navori"), "utf8")).toBe(original);

    expect(install.linkBinary({ root, binary, env: npmAgent })).toBe(`linked ${binary}`);
    for (const name of ["navori", "navori-native-hook"])
      expect(readFileSync(join(root, "bin", name), "utf8")).toBe(readFileSync(binary, "utf8"));

    // the entry point reports and never fails the install
    const run = spawnSync(process.execPath, [join(root, "postinstall.js")], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^navori postinstall: /);
  });
});

describe("ensamblado", () => {
  // Covers: R21, R22
  it("declara los cuatro paquetes @navori y rechaza un legacy que no coincide con su integrity", () => {
    const ts = { license: "MIT", engines: { node: ">=22.12" } };
    const main = assemble.mainManifest("1.2.3", ts);
    expect(main.optionalDependencies).toEqual({
      "@navori/darwin-arm64": "1.2.3",
      "@navori/darwin-x64": "1.2.3",
      "@navori/linux-arm64": "1.2.3",
      "@navori/linux-x64": "1.2.3",
    });
    expect(main.bin).toEqual({
      navori: "bin/navori",
      "navori-native-hook": "bin/navori-native-hook",
    });
    expect(main.scripts).toEqual({ postinstall: "node postinstall.js" });
    expect(main.files).toContain("legacy");
    expect(assemble.platformManifest("linux-arm64", "1.2.3", ts)).toMatchObject({
      name: "@navori/linux-arm64",
      os: ["linux"],
      cpu: ["arm64"],
    });

    const dir = scratch();
    mkdirSync(join(dir, "package", "dist"), { recursive: true });
    writeFileSync(join(dir, "package", "package.json"), '{"name":"navori","version":"0.12.3"}\n');
    writeFileSync(join(dir, "package", "dist", "index.js"), "// frozen\n");
    const tarball = join(dir, "navori-0.12.3.tgz");
    expect(spawnSync("tar", ["-czf", tarball, "-C", dir, "package"]).status).toBe(0);
    const pin = { version: "0.12.3", integrity: assemble.integrityOf(tarball) };
    expect(() =>
      assemble.unpackLegacy(tarball, { ...pin, integrity: "sha512-AAAA" }, join(dir, "bad")),
    ).toThrow("does not match the pinned");
    expect(() =>
      assemble.unpackLegacy(tarball, { ...pin, version: "0.12.2" }, join(dir, "old")),
    ).toThrow("expected navori@0.12.2");
    assemble.unpackLegacy(tarball, pin, join(dir, "legacy"));
    expect(readFileSync(join(dir, "legacy", "dist", "index.js"), "utf8")).toBe("// frozen\n");
    expect(readFileSync(join(dir, "legacy", "package.json"), "utf8")).toContain('"0.12.3"');
  });
});
