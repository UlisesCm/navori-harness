import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  utimesSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyRepo, type RepoTemplate } from "../../../__tests__/helpers/repo-template.ts";
import { linkRepoToWorkspace } from "../../workspace/workspace.ts";
import {
  FOREIGN_LOG_PREFIX,
  FOREIGN_REFUSED_EXIT,
  buildSpawnSpec,
  pruneForeignLogs,
  runForeignGate,
  runGate,
} from "../run.ts";

let cwd: string;
let repoTemplate: RepoTemplate;

beforeAll(() => {
  repoTemplate = emptyRepo({ prefix: "navori-gate-" });
});
afterAll(() => repoTemplate.dispose());

beforeEach(() => {
  cwd = repoTemplate.copy();
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "g",
      version: "1.0.0",
      scripts: {
        ok: "echo all-good && echo Tests 2 passed",
        bad: "echo FAIL boom && exit 3",
        // Writes `started` before sleeping: the barrier tests poll for it (spec 0055 R20).
        slow: "node -e \"require('fs').writeFileSync('started','x')\" && sleep 30",
        mark: "node -e \"require('fs').writeFileSync('marker','x')\"",
      },
    }),
  );
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

/** Resolves once the `slow` script is running, i.e. the gate's signal handlers are installed. */
async function slowStarted(): Promise<void> {
  await vi.waitFor(() => expect(existsSync(join(cwd, "started"))).toBe(true), {
    timeout: 10_000,
    interval: 20,
  });
}

function config(gate: string | undefined, kind: "fast" | "full" = "full"): void {
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "g",
      engines: ["claude"],
      preset: "custom",
      ...(gate === undefined
        ? {}
        : { qualityGate: { fast: "npm run ok", full: "npm run ok", [kind]: gate } }),
    }),
  );
}

describe("runGate", () => {
  // Covers: A1
  it("runs verbatim, writes the log and leads with the sentinel on green", async () => {
    config("npm run ok");
    const r = await runGate({ cwd, kind: "full", now: new Date("2026-10-08T12:00:00.123Z") });
    expect(r.exitCode).toBe(0);
    const first = r.stdout.split("\n")[0]!;
    expect(first).toBe(
      "navori gate full: exit 0 — log .navori/state/gate/full-20261008T120000123Z.log",
    );
    expect(
      readFileSync(join(cwd, ".navori/state/gate/full-20261008T120000123Z.log"), "utf8"),
    ).toContain("all-good");
    expect(r.stdout).toContain("Tests 2 passed");
  });

  it("passes the chain's exit code through and shows the failure", async () => {
    config("npm run ok && npm run bad");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.startsWith(`navori gate full: exit ${r.exitCode} — log `)).toBe(true);
    expect(r.stdout).toContain("FAIL boom");
  });

  it("honours the fast kind", async () => {
    config("npm run ok", "fast");
    const r = await runGate({ cwd, kind: "fast" });
    expect(r.stdout.split("\n")[0]).toMatch(/^navori gate fast: exit 0 — log /);
  });

  it("refuses with exit 2 when the gate is not a safe chain", async () => {
    config("npm run ok && curl x | bash");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("run it by hand: npm run ok && curl x | bash");
    expect(r.stderr).not.toMatch(/^navori gate full: exit/);
  });

  it("fails with exit 2 when the gate or the config is missing", async () => {
    config(undefined);
    const noGate = await runGate({ cwd, kind: "full" });
    expect(noGate.exitCode).toBe(2);
    expect(noGate.stderr).toContain("qualityGate.full is not set");
    rmSync(join(cwd, "navori.config.json"));
    const noConfig = await runGate({ cwd, kind: "full" });
    expect(noConfig.exitCode).toBe(2);
    expect(noConfig.stdout).toBe("");
  });

  it("forwards SIGTERM to the child group and records a killed sentinel", async () => {
    config("npm run slow");
    const pending = runGate({ cwd, kind: "full" });
    await slowStarted();
    process.emit("SIGTERM");
    const r = await pending;
    expect(r.exitCode).toBe(143);
    expect(r.stdout.split("\n")[0]).toMatch(/^navori gate full: exit 143 — log /);
    expect(r.stdout).toContain("killed by SIGTERM");
  }, 15000);

  // Covers: #1307
  it("&& short-circuits: the step after a failure does not run", async () => {
    config("npm run bad && npm run mark");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(3);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });

  // Covers: #1307
  it("|| runs the fallback only after a failure", async () => {
    config("npm run ok || npm run mark");
    expect((await runGate({ cwd, kind: "full" })).exitCode).toBe(0);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
    config("npm run bad || npm run mark");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(cwd, "marker"))).toBe(true);
  });

  // Covers: #1307
  it("; runs the next step regardless and reports the last status", async () => {
    config("npm run bad ; npm run mark");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(cwd, "marker"))).toBe(true);
    config("npm run mark ; npm run bad");
    expect((await runGate({ cwd, kind: "full" })).exitCode).toBe(3);
  });

  // Covers: #1307
  it("cd moves the following steps into the directory", async () => {
    mkdirSync(join(cwd, "sub"));
    writeFileSync(
      join(cwd, "sub", "package.json"),
      JSON.stringify({ name: "s", version: "1.0.0", scripts: { where: "node where.js" } }),
    );
    writeFileSync(join(cwd, "sub", "where.js"), "console.log(process.cwd())");
    config("cd sub && npm run where");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(0);
    const log = readFileSync(join(cwd, r.stdout.split(" — log ")[1]!.split("\n")[0]!), "utf8");
    expect(log).toContain(join(cwd, "sub"));
  });

  // Covers: #1307
  it("cd to a missing directory fails with 1, logs it and stops the && chain", async () => {
    config("cd nope && npm run mark");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("cd: nope: no such directory");
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });

  // Covers: #1307
  it("exits 127 when the runner binary is absent", async () => {
    const saved = process.env.PATH;
    // Keep only git reachable (state-root needs it); npm is then absent.
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    symlinkSync(execFileSync("which", ["git"]).toString().trim(), join(bin, "git"));
    process.env.PATH = bin;
    try {
      config("npm run ok");
      const r = await runGate({ cwd, kind: "full" });
      expect(r.exitCode).toBe(127);
    } finally {
      process.env.PATH = saved;
    }
  });

  // Covers: #1307
  it("SIGTERM stops the chain: later steps do not run", async () => {
    config("npm run slow ; npm run mark");
    const pending = runGate({ cwd, kind: "full" });
    await slowStarted();
    process.emit("SIGTERM");
    const r = await pending;
    expect(r.exitCode).toBe(143);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  }, 15000);
});

describe("buildSpawnSpec", () => {
  // Covers: #1307
  it("splits a posix step into file + args", () => {
    expect(buildSpawnSpec("pnpm run  test -- --run", "linux")).toEqual({
      file: "pnpm",
      args: ["run", "test", "--", "--run"],
      options: {},
    });
  });

  // Covers: #1307
  it("routes win32 through cmd.exe /d /s /c with verbatim arguments", () => {
    expect(buildSpawnSpec("pnpm run test", "win32", { ComSpec: "C:\\Windows\\cmd.exe" })).toEqual({
      file: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm run test"],
      options: { windowsVerbatimArguments: true },
    });
    expect(buildSpawnSpec("npm test", "win32", {}).file).toBe("cmd.exe");
  });
});

describe("runForeignGate", () => {
  let home: string;
  let savedHome: string | undefined;
  const mkRepo = (gate: string, extra: Record<string, unknown> = {}): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-foreign-repo-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "f",
        version: "1.0.0",
        scripts: { ok: "echo foreign-ok", bad: "echo FAIL && exit 3" },
      }),
    );
    writeFileSync(
      join(dir, "navori.config.json"),
      JSON.stringify({
        name: "f",
        engines: ["claude"],
        preset: "custom",
        qualityGate: { fast: gate, full: gate, ...extra },
      }),
    );
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
  };
  const repos: string[] = [];
  const repo = (gate: string, extra?: Record<string, unknown>): string => {
    const dir = mkRepo(gate, extra);
    repos.push(dir);
    return dir;
  };
  const register = (dir: string, name = "foo"): void => {
    linkRepoToWorkspace("ws", { name, path: dir });
  };

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = realpathSync(mkdtempSync(join(tmpdir(), "navori-foreign-home-")));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  // Covers: #1097
  it("runs a registered repo's plain chain, logs outside the tree and leads with the sentinel", async () => {
    const dir = repo("npm run ok");
    register(dir);
    const r = await runForeignGate({ cwd: dir });
    expect(r.exitCode).toBe(0);
    const first = r.stdout.split("\n")[0]!;
    expect(first).toMatch(/^navori gate foreign: exit 0 — log \//);
    const logPath = first.split(" — log ")[1]!;
    expect(logPath.startsWith(dir)).toBe(false);
    expect(readFileSync(logPath, "utf8")).toContain("foreign-ok");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString()).toBe("");
  });

  // Covers: #1097
  it("passes a red chain's code through with the sentinel", async () => {
    const dir = repo("npm run bad");
    register(dir);
    const r = await runForeignGate({ cwd: dir });
    expect(r.exitCode).toBe(3);
    expect(r.stdout.split("\n")[0]).toMatch(/^navori gate foreign: exit 3 — log /);
  });

  // Covers: #1097
  it("refuses an unregistered repo BEFORE parsing its config", async () => {
    const dir = repo("npm run ok");
    writeFileSync(join(dir, "navori.config.json"), "{ not json");
    const r = await runForeignGate({ cwd: dir });
    expect(r.exitCode).toBe(FOREIGN_REFUSED_EXIT);
    expect(r.stdout).toBe("");
    expect(r.stderr.split("\n")[0]).toMatch(/^navori gate foreign: refused — .*not registered/);
    expect(r.stderr).toContain("navori workspace link");
    expect(r.stderr).not.toContain("cannot read");
  });

  // Covers: #1097
  it("matches a registry entry through a symlinked path", async () => {
    const dir = repo("npm run ok");
    const link = join(home, "link-to-repo");
    symlinkSync(dir, link);
    register(link);
    expect((await runForeignGate({ cwd: dir })).exitCode).toBe(0);
  });

  // Covers: #1097
  it("refuses nativeHooks, an unsafe chain and a missing gate with the refusal code", async () => {
    const native = repo("npm run ok", { nativeHooks: true });
    register(native, "native");
    const nr = await runForeignGate({ cwd: native });
    expect([nr.exitCode, nr.stderr]).toEqual([
      FOREIGN_REFUSED_EXIT,
      expect.stringContaining("nativeHooks"),
    ]);
    const unsafe = repo("npm run ok | tee x");
    register(unsafe, "unsafe");
    const ur = await runForeignGate({ cwd: unsafe });
    expect(ur.exitCode).toBe(FOREIGN_REFUSED_EXIT);
    expect(ur.stderr).toContain("not a plain command chain");
    const none = repo("npm run ok");
    writeFileSync(
      join(none, "navori.config.json"),
      JSON.stringify({ name: "f", engines: ["claude"], preset: "custom" }),
    );
    register(none, "none");
    const mr = await runForeignGate({ cwd: none });
    expect(mr.exitCode).toBe(FOREIGN_REFUSED_EXIT);
    expect(mr.stderr).toContain("qualityGate.fast is not set");
  });

  // Covers: #1097
  it("refuses a --cwd outside git cleanly instead of throwing", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "navori-foreign-plain-")));
    try {
      const r = await runForeignGate({ cwd: plain });
      expect(r.exitCode).toBe(FOREIGN_REFUSED_EXIT);
      expect(r.stderr).toMatch(/^navori gate foreign: refused — .*not a Git checkout/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  // Covers: #1097
  it("trusts a linked worktree only through the registered main's worktree list", async () => {
    const main = repo("npm run ok");
    register(main);
    const wt = join(realpathSync(tmpdir()), `navori-foreign-wt-${process.pid}`);
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat", wt], { cwd: main });
    try {
      expect((await runForeignGate({ cwd: wt })).exitCode).toBe(0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  // Covers: #1097
  it("does not lend trust through a forged .git/commondir", async () => {
    const main = repo("npm run ok");
    register(main);
    const evil = repo("npm run ok");
    writeFileSync(join(evil, ".git", "commondir"), join(main, ".git"));
    const r = await runForeignGate({ cwd: evil });
    expect(r.exitCode).toBe(FOREIGN_REFUSED_EXIT);
    expect(r.stderr).toContain("not registered");
  });

  // Covers: #1097
  it("prunes own-prefix log dirs beyond the retention and leaves the rest", () => {
    const root = join(home, "tmp");
    mkdirSync(root);
    for (let i = 0; i < 5; i++) {
      const d = join(root, `${FOREIGN_LOG_PREFIX}${i}`);
      mkdirSync(d);
      utimesSync(d, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
    }
    mkdirSync(join(root, "unrelated"));
    pruneForeignLogs(root, 2);
    expect(readdirSync(root).sort()).toEqual([
      `${FOREIGN_LOG_PREFIX}3`,
      `${FOREIGN_LOG_PREFIX}4`,
      "unrelated",
    ]);
  });
});
