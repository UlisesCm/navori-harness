import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath } from "../bundled-assets.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/**
 * Covers: R1, R2, R3, R4, R5, R6 — the tgrep wrapper (spec 0017).
 *
 * The wrapper is the whole design: because `SessionStart` hooks never reach
 * subagents, the engine choice cannot live in doctrine, so this script is what
 * makes one command correct in every agent, mode and machine. Each case below
 * pins one of the properties that claim rests on — and the staleness case (R2)
 * is the non-negotiable one: without the reindex, tgrep answers exit 1 with no
 * warning for content added after the last build, which reads exactly like
 * "no match".
 *
 * Fixture paths contain a space on purpose (R6): the team's own workspace is
 * `Dev - Docs/…`, so an unquoted expansion anywhere in the script fails here.
 */

const WRAPPER = resolve(getPluginPath("tgrep"), "scripts/tgrep-search.sh");
const runsBash = process.platform !== "win32";
const hasTgrep = spawnSync("bash", ["-c", "command -v tgrep"]).status === 0;

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

/** Utilities the wrapper itself calls; a shim PATH must carry all of them. */
const SHIM_TOOLS = ["bash", "zsh", "git", "grep", "sed", "cut", "tail", "tr", "mkdir", "shasum"];

interface Fixture {
  /** Repo root — its path contains a space. */
  root: string;
  /** Value handed to the wrapper as XDG_CACHE_HOME. */
  cache: string;
  base: string;
}

/** A committed git repo (so `git status --porcelain` starts empty) at a path with a space. */
function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "navori-tgrep-"));
  const root = join(base, "repo con espacio");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "alpha token_uno\n");
  writeFileSync(join(root, "sub", "b.txt"), "beta token_uno\n");
  writeFileSync(join(root, "otro.txt"), "nothing to see\n");
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  return { root, cache: join(base, "cache"), base };
}

/** A PATH containing only the wrapper's own utilities — never tgrep. */
function makeShim(fx: Fixture, name: string): string {
  const bin = join(fx.base, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  for (const tool of SHIM_TOOLS) {
    try {
      symlinkSync(resolveBin(tool), join(bin, tool));
    } catch {
      // zsh (or any optional tool) missing on this machine: the shells helper
      // already skips those rows, and the wrapper doesn't need it.
    }
  }
  return bin;
}

interface RunOpts {
  args: string[];
  cwd?: string;
  path?: string;
  cache?: string;
  shell?: HookShell;
}

function run(fx: Fixture, opts: RunOpts) {
  const r = spawnSync(resolveBin(opts.shell ?? "bash"), [WRAPPER, ...opts.args], {
    cwd: opts.cwd ?? fx.root,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: opts.path ?? process.env.PATH,
      XDG_CACHE_HOME: opts.cache ?? fx.cache,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Matched file paths, order-independent (engines don't agree on ordering). */
function filesOf(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

describe.runIf(runsBash && hasTgrep)("tgrep-search.sh — the indexed path (spec 0017)", () => {
  it("finds every file holding the literal, from a path with a space (R1, R6)", () => {
    const fx = makeFixture();
    const r = acrossShells((shell) => {
      const out = run(fx, { args: ["-l", "token_uno", "."], shell });
      return { status: out.status, files: filesOf(out.stdout) };
    });
    expect(r.status).toBe(0);
    expect(r.files).toEqual(["./a.txt", "./sub/b.txt"]);
  });

  it("returns what rg returns for the same pattern and root (R1)", () => {
    // rg is not installed everywhere (on the team's machines it is a shell
    // function, not a binary), so this parity check runs only where a real rg
    // exists; the case above pins the same property against the fixture itself.
    const hasRgBinary = spawnSync("bash", ["-c", "command -v rg"]).status === 0;
    if (!hasRgBinary) return;
    const fx = makeFixture();
    const wrapper = filesOf(run(fx, { args: ["-l", "token_uno", "."] }).stdout);
    const rg = filesOf(
      spawnSync(resolveBin("rg"), ["-l", "token_uno", "."], {
        cwd: fx.root,
        encoding: "utf-8",
      }).stdout,
    );
    expect(wrapper).toEqual(rg);
  });

  // THE case. A stale index makes tgrep exit 1 without a warning, which is
  // indistinguishable from "no match" — a silent false negative on exactly the
  // content an agent just wrote. The wrapper reindexes before every search.
  it("finds content appended AFTER the index was built (R2)", () => {
    const fx = makeFixture();
    expect(run(fx, { args: ["-l", "token_uno", "."] }).status).toBe(0); // builds the index
    appendFileSync(join(fx.root, "a.txt"), "token_recien_escrito\n");
    const r = run(fx, { args: ["-n", "token_recien_escrito", "."] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("token_recien_escrito");
  });

  it("finds a file created AFTER the index was built (R2)", () => {
    const fx = makeFixture();
    expect(run(fx, { args: ["-l", "token_uno", "."] }).status).toBe(0);
    writeFileSync(join(fx.root, "nuevo.txt"), "token_de_archivo_nuevo\n");
    const r = run(fx, { args: ["-l", "token_de_archivo_nuevo", "."] });
    expect(r.status).toBe(0);
    expect(filesOf(r.stdout)).toEqual(["./nuevo.txt"]);
  });

  it("works from a subdirectory, resolving the repo root itself (R6)", () => {
    const fx = makeFixture();
    const r = run(fx, { args: ["-n", "beta"], cwd: join(fx.root, "sub") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("beta token_uno");
  });

  it("keeps the index outside the repo and leaves the tree untouched (R5)", () => {
    const fx = makeFixture();
    run(fx, { args: ["-l", "token_uno", "."] });
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: fx.root,
      encoding: "utf-8",
    });
    expect(porcelain.trim()).toBe("");
    expect(existsSync(join(fx.root, ".tgrep"))).toBe(false);
    expect(readdirSync(join(fx.cache, "navori", "tgrep")).length).toBeGreaterThan(0);
  });

  it("degrades to a full scan when the cache is not writable (R2)", () => {
    const fx = makeFixture();
    const ro = join(fx.base, "read-only-cache");
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    const r = run(fx, { args: ["-l", "token_uno", "."], cache: ro });
    expect(r.status).toBe(0);
    expect(filesOf(r.stdout)).toEqual(["./a.txt", "./sub/b.txt"]);
  });

  // Two sessions on the same repo reindex the same cache path. Whatever the
  // collision does to the index, the NEXT search still has to be right — the
  // wrapper's `--no-index` retry is what makes that true by construction.
  it("survives two concurrent reindexes of the same cache (failure mode)", () => {
    const fx = makeFixture();
    const both = spawnSync(
      resolveBin("bash"),
      ["-c", `bash "$0" -q -F token_uno . & bash "$0" -q -F token_uno . & wait`, WRAPPER],
      {
        cwd: fx.root,
        encoding: "utf-8",
        env: { ...process.env, XDG_CACHE_HOME: fx.cache },
      },
    );
    expect(both.status).toBe(0);
    const after = run(fx, { args: ["-l", "token_uno", "."] });
    expect(after.status).toBe(0);
    expect(filesOf(after.stdout)).toEqual(["./a.txt", "./sub/b.txt"]);
  });

  it("exits 1 on a pattern with no match (R3)", () => {
    const fx = makeFixture();
    const r = acrossShells((shell) => run(fx, { args: ["-n", "patron_inexistente", "."], shell }));
    expect(r.status).toBe(1);
  });
});

describe.runIf(runsBash)("tgrep-search.sh — the fallbacks (spec 0017)", () => {
  /** A fake rg that records its argv and returns a chosen exit code. */
  function installFakeRg(bin: string, argsFile: string, exitCode: number): void {
    const p = join(bin, "rg");
    writeFileSync(
      p,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n` +
        `echo "fake-rg: match"\nexit ${exitCode}\n`,
    );
    chmodSync(p, 0o755);
  }

  it("hands the search to rg verbatim and warns once on stderr (R3, R4)", () => {
    const fx = makeFixture();
    const bin = makeShim(fx, "rg");
    const argsFile = join(fx.base, "rg-args.txt");
    installFakeRg(bin, argsFile, 0);

    const r = run(fx, { args: ["-l", "token_uno", "."], path: bin });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("fake-rg: match");
    // Verbatim passthrough: the wrapper adds nothing on this path (--index-path
    // is a tgrep flag and rg would reject it).
    expect(readFileSync(argsFile, "utf-8").split("\n").filter(Boolean)).toEqual([
      "-l",
      "token_uno",
      ".",
    ]);
    // R4: ONE line, naming the engine and how to get the fast one back.
    const warnings = r.stderr.split("\n").filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("rg");
    expect(warnings[0]).toContain("brew install tgrep");
  });

  it("preserves rg's no-match exit code (R3)", () => {
    const fx = makeFixture();
    const bin = makeShim(fx, "rg-nomatch");
    installFakeRg(bin, join(fx.base, "rg-args-2.txt"), 1);
    expect(run(fx, { args: ["-l", "nada", "."], path: bin }).status).toBe(1);
  });

  it("falls all the way to grep -rn, matching and warning (R3, R4)", () => {
    const fx = makeFixture();
    const bin = makeShim(fx, "bare");
    const r = acrossShells((shell) => {
      const out = run(fx, { args: ["-n", "token_uno", "."], path: bin, shell });
      return { status: out.status, files: filesOf(out.stdout), stderr: out.stderr };
    });
    expect(r.status).toBe(0);
    expect(r.files.join("\n")).toContain("a.txt");
    const warnings = r.stderr.split("\n").filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("grep");
    expect(warnings[0]).toContain("brew install tgrep");
  });

  it("exits 1 from grep when nothing matches (R3)", () => {
    const fx = makeFixture();
    const bin = makeShim(fx, "bare-nomatch");
    const r = acrossShells((shell) =>
      run(fx, { args: ["-n", "patron_inexistente", "."], path: bin, shell }),
    );
    expect(r.status).toBe(1);
  });

  it("drops the flags grep cannot take, says so, and still matches (R3, R4)", () => {
    const fx = makeFixture();
    const bin = makeShim(fx, "bare-flags");
    // `-g` has no grep equivalent; the pattern and the path must survive it.
    const r = run(fx, { args: ["-g", "*.txt", "token_uno", "."], path: bin });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("token_uno");
    expect(r.stderr).toContain("dropped");
  });

  it("exits 2 — not 1 — when no pattern survives the flag dropping (R3)", () => {
    // The one documented exception to "0 = match, 1 = no match", and the
    // dangerous one: 2 means NOTHING WAS SEARCHED. Read as "no match" it is the
    // silent false negative the reindex-per-search exists to prevent, so the
    // code has to be distinguishable and the message has to say so.
    //
    // Found reviewing an independent report of the wrapper written in another
    // repo: it restated the contract as absolute, faithfully — because both of
    // navori's own tgrep assets did. Doctrine that overstates a contract is the
    // #647 class, and nothing pinned this branch until now.
    const fx = makeFixture();
    const bin = makeShim(fx, "bare-nopattern");
    // Every argument is a value-taking flag, so the pattern slot stays empty.
    const r = acrossShells((shell) => run(fx, { args: ["-g", "*.txt"], path: bin, shell }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("nothing was searched");
  });

  it("honours `-e PATTERN` on the grep path (R3)", () => {
    const fx = makeFixture();
    const bin = makeShim(fx, "bare-e");
    const r = run(fx, { args: ["-e", "token_uno", "."], path: bin });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("token_uno");
  });
});
