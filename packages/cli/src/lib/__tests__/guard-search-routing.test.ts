import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { injectManagedSection } from "../render/marker.ts";
import { renderManagedFile } from "../../engines/shared/render-managed-file.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for the tgrep search lane (spec 0039 D6).
 *
 * The lane is a managed sub-block in `guard-destructive.sh` that sources
 * `plugins/tgrep/scripts/guard-search-routing.sh` in a subshell, so every case
 * drives the REAL composition: the core hook, the plugin's sub-block injected the
 * way the render does it, the script copied beside it, and a stub `tgrep` on PATH.
 *
 * The table is the suite ported from `7c6930dc^`, whose shapes came from the
 * park's audited transcripts. The allow-cases matter more than the block-cases: a
 * guard that blocks a legitimate extraction teaches the model to route AROUND it.
 */

const runsBash = process.platform !== "win32";

const pluginRoot = resolve(import.meta.dirname, "../../../../plugins/tgrep");
const SUB_BLOCK_ID = "tgrep-search-lane";

type TgrepStub = "running" | "not-running" | "no-index" | "absent";

const STUB_STATUS: Record<Exclude<TgrepStub, "absent">, string> = {
  running: "Index status for /x\n  Server:     running\n",
  "not-running": "Index status for /x\n  Server:     not running\n",
  "no-index": "No index found at /x/.tgrep\n",
};

interface Fixture {
  repo: string;
  hook: string;
  path: string;
}

/** A repo with the hook, the sub-block, the script and (optionally) a stub tgrep. */
function buildFixture(stub: TgrepStub, scriptOverride?: string): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "navori-search-lane-"));
  mkdirSync(join(repo, ".claude/hooks"), { recursive: true });
  mkdirSync(join(repo, ".claude/scripts"), { recursive: true });
  mkdirSync(join(repo, "bin"), { recursive: true });

  // Render the hook the way the engine does, so the base block carries its
  // markers and the sub-block lands where a real render puts it.
  const rendered = renderManagedFile({
    assetPath: resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh"),
    existingContent: null,
    managedId: "guard-destructive-base",
    meta: { source: "@navori/core", version: "0.0.0" },
    config: NavoriConfigSchema.parse({
      name: "search-lane",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "true", full: "true" },
    }),
  }).content;
  const body = readFileSync(join(pluginRoot, "managed/guard-destructive-search-lane.sh"), "utf-8");
  const withLane = injectManagedSection(
    rendered,
    SUB_BLOCK_ID,
    body,
    { source: "@navori/plugin-tgrep", version: "0.0.0" },
    "shell",
  ).output;
  const hook = join(repo, ".claude/hooks/guard-destructive.sh");
  writeFileSync(hook, withLane);
  chmodSync(hook, 0o755);

  const script = join(repo, ".claude/scripts/guard-search-routing.sh");
  if (scriptOverride === undefined) {
    copyFileSync(join(pluginRoot, "scripts/guard-search-routing.sh"), script);
  } else {
    writeFileSync(script, scriptOverride);
  }

  if (stub !== "absent") {
    const tgrep = join(repo, "bin/tgrep");
    writeFileSync(tgrep, `#!/bin/sh\nprintf '${STUB_STATUS[stub]}'\n`);
    chmodSync(tgrep, 0o755);
  }
  // `/opt/homebrew/bin` is left out on purpose: a real tgrep there must not leak in.
  return { repo, hook, path: `${join(repo, "bin")}:/usr/bin:/bin` };
}

const fixtures: Record<TgrepStub, Fixture> = {
  running: buildFixture("running"),
  "not-running": buildFixture("not-running"),
  "no-index": buildFixture("no-index"),
  absent: buildFixture("absent"),
};

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

function envFor(f: Fixture): NodeJS.ProcessEnv {
  return { ...process.env, PATH: f.path, CLAUDE_PROJECT_DIR: f.repo };
}

/** Run the composed hook with `command` on stdin; returns its exit code (2 = blocked). */
function runGuard(command: string, fixture: Fixture = fixtures.running): number {
  const payload = JSON.stringify({ tool_input: { command } });
  return acrossShells((shell) => {
    const r = spawnSync(resolveBin(shell), [fixture.hook], {
      input: payload,
      env: envFor(fixture),
      cwd: fixture.repo,
    });
    return r.status ?? -1;
  });
}

function stderrOf(command: string, fixture: Fixture = fixtures.running): string {
  const r = spawnSync(resolveBin("bash"), [fixture.hook], {
    input: JSON.stringify({ tool_input: { command } }),
    env: envFor(fixture),
    cwd: fixture.repo,
    encoding: "utf-8",
  });
  return r.stderr ?? "";
}

// Covers: R29, R30
describe.runIf(runsBash)("guard-search-routing", () => {
  describe("blocks content search that the wrapper replaces", () => {
    const blocked = [
      ['grep -rn "allByMenteeId" src/', "the everyday recursive form"],
      ['grep -r "foo" .', "short -r over the current directory"],
      ['grep -Rn "foo" src/', "uppercase -R follows symlinks, same class"],
      ['grep -n -r "foo" src/', "the flag need not be adjacent to the verb"],
      ['grep -rn "x" --include=*.ts src/', "--include does not make it extraction"],
      ["rg 'appealWindow'", "rg recurses with no target at all"],
      ["rg -l -i 'appeal|apelaci' app/ --type ts", "rg with a directory target"],
      ['cd /tmp && grep -rn "foo" src/', "a compound command is split per segment"],
      [
        'echo hi && grep -n "a" f.ts && grep -rn "b" src/',
        "one offending segment is enough, even after a legitimate one",
      ],
      [
        'grep -rn "pkg.json" src/',
        "the PATTERN is not a target — what it names is what it looks FOR",
      ],
      ['grep -rn "x" --include=*.ts src/', "a glob inside a flag is not a concrete file"],
    ] as const;
    for (const [cmd, why] of blocked) {
      it(`blocks \`${cmd}\` — ${why}`, () => {
        expect(runGuard(cmd)).toBe(2);
      });
    }
  });

  describe("never blocks what the wrapper cannot replace", () => {
    const allowed = [
      ["cat file.txt | grep foo", "filtering another command's output"],
      ['git ls-files | grep -i "drift-stamp"', "a pipe filter that even carries -i"],
      ["ls -R | grep -r foo", "a recursive flag AFTER a pipe is still reading stdin, not the repo"],
      ['grep -n "validate" src/routes.ts', "extraction from an already known file"],
      ['grep -c "mongodb-memory-server" package.json', "counting inside one file"],
      [
        'grep -n "x" pnpm-lock.yaml 2>/dev/null',
        "a redirection is not an operand — this is the bug that mislabelled 145 extractions",
      ],
      ["rg -n 'termsAccepted' app/screens/RegisterScreen.tsx", "rg aimed at a single file"],
      ['grep -E "Found', "an unbalanced quote cannot be parsed — unsure means allow"],
      ['grep --color=never -n "x" file.ts', "a long flag with no r/R in its name"],
      [
        'grep -rn "oxlint" apps/a/package.json apps/b/package.json',
        "-r is inert once you hand grep concrete files — this exact shape cost a live session a round-trip",
      ],
      [
        'grep -rn "types:" node_modules/@keystone-6/core/dist/system.js',
        "reading one file under node_modules, the most common shape of the -r habit",
      ],
    ] as const;
    for (const [cmd, why] of allowed) {
      it(`allows \`${cmd}\` — ${why}`, () => {
        expect(runGuard(cmd)).toBe(0);
      });
    }
  });

  it("waves through an empty payload instead of dying on it", () => {
    expect(runGuard("")).toBe(0);
  });

  it("treats a heredoc body as data, not as a call", () => {
    // Not hypothetical: this fired on the very session adding these tests,
    // because one of the cases above IS the string `grep -rn "..." src/`. A
    // guard that cannot be written about is a guard nobody can maintain.
    const writingAboutASearch = ["python3 - <<PY", 'x = "grep -rn foo src/"', "PY"].join("\n");
    expect(runGuard(writingAboutASearch)).toBe(0);
  });

  it("names the replacement command, not just the rule that fired", () => {
    const err = stderrOf('grep -rn "foo" src/');
    // A block that only says "no" gets worked around; the message has to carry
    // the command the model should have run.
    expect(err).toContain("tgrep search -n -- PATTERN ROOT");
    expect(err).not.toMatch(/codegraph|tgrep-search\.sh/);
    expect(err).toContain("BLOCKED by guard-search-routing");
    expect(err).toContain("-i -l -w -F");
    // The two legitimate shapes are spelled out so the model does not conclude
    // that every grep is now forbidden.
    expect(err).toContain("| grep");
  });

  it("allows a command too large to inspect rather than blocking it", () => {
    // Opposite trade-off to guard-destructive, and deliberate: that guard denies
    // what it cannot read because the cost is data loss. This one redirects a
    // search, so failing open costs a single unmeasured call.
    expect(runGuard(`grep -rn "${"x".repeat(25_000)}" src/`)).toBe(0);
  });

  /**
   * #724 B2 — an environment prefix sat one token to the right of the verb
   * anchor, and every rule anchors the verb at the segment start. Verified
   * before the fix: `LC_ALL=C grep -rn foo src/` exited 0 while the same
   * command without the prefix exited 2.
   *
   * Inside the guard's own "seatbelt, not sandbox" philosophy this is not an
   * adversary case — it is the shape a real command takes when someone pins a
   * locale — but the peel was already written twice in this repo
   * (`guard-destructive.sh`, `parse.ts`'s `leadingBinary`), so the gap was in
   * this file and nowhere else.
   */
  describe("sees through an environment prefix (#724)", () => {
    const blocked = [
      "LC_ALL=C grep -rn foo src/",
      "LC_ALL=C rg patron",
      "FOO=1 BAR=2 rg patron",
      "  GIT_PAGER=cat grep -R needle lib/",
    ];
    for (const command of blocked) {
      it(`blocks ${command}`, () => {
        expect(runGuard(command)).toBe(2);
      });
    }

    // The peel may not invent a verb where there is none, and it may not reach
    // inside a quoted span: both would be the false block this guard's own
    // header calls worse than the search it stops.
    const allowed = [
      "LC_ALL=C grep -n x known-file.ts",
      "LC_ALL=C echo hola",
      "git commit -m 'LC_ALL=C grep -rn algo'",
      "FOO=bar",
    ];
    for (const command of allowed) {
      it(`allows ${command}`, () => {
        expect(runGuard(command)).toBe(0);
      });
    }
  });

  /**
   * #721 A3 — the two false-positive classes, both verified in the wild before
   * the fix. The guard's own header calls this the worst failure it can have:
   * "a false block teaches the model to route AROUND the guard — which is
   * worse". The suite claimed ZERO false positives, which was true of its
   * corpus and false as a property.
   */
  describe("does not block an extraction from a file with no extension (#721)", () => {
    // `rg foo Makefile` and friends were blocked because "file" was defined as
    // "has an extension". Every one of these names ONE file and searches
    // nothing.
    const allowed = [
      "rg foo Makefile",
      "rg TODO Dockerfile",
      'grep -rn "foo" LICENSE',
      "grep -rn x CODEOWNERS",
      "rg patron Gemfile",
    ];
    for (const command of allowed) {
      it(`allows ${command}`, () => {
        expect(runGuard(command)).toBe(0);
      });
    }

    // The line the fix may not cross: a directory is still a search, with or
    // without its trailing slash.
    const blocked = ["rg foo src/", "rg foo src", "grep -rn foo .", "rg patron"];
    for (const command of blocked) {
      it(`still blocks ${command}`, () => {
        expect(runGuard(command)).toBe(2);
      });
    }
  });

  describe("does not split on a separator inside quotes (#721)", () => {
    // The segment splitter cut on `&&`/`;`/`|` anywhere, so a command that
    // merely QUOTED a search produced a fake segment starting with the verb.
    // This fired on the session that was writing this very test.
    const allowed = [
      'git commit -m "arregla el guard && rg ya no bloquea"',
      'git commit -m "a && rg y"',
      "git commit -m 'a ; rg y'",
      'echo "usa rg -l foo src/" ; echo fin',
    ];
    for (const command of allowed) {
      it(`allows ${command}`, () => {
        expect(runGuard(command)).toBe(0);
      });
    }

    // And a real separator OUTSIDE the quotes still splits, which is the whole
    // reason the splitter exists.
    const blocked = ["grep -rn foo src/ && echo listo", "cd x ; grep -rn foo src/"];
    for (const command of blocked) {
      it(`still blocks ${command}`, () => {
        expect(runGuard(command)).toBe(2);
      });
    }
  });
});

describe.runIf(runsBash)("guard-search-routing: D6 composition", () => {
  // Covers: R29
  it("redirects to `tgrep search -n --` with the PATTERN ROOT shape and never to codegraph", () => {
    const err = stderrOf('grep -rn "foo" src/');
    expect(err).toContain("tgrep search -n -- PATTERN ROOT");
    expect(err).not.toContain("--no-index");
    expect(err.toLowerCase()).not.toContain("codegraph");
  });

  // Covers: R29
  it("leaves the lane's source free of any codegraph reference", () => {
    for (const file of [
      "scripts/guard-search-routing.sh",
      "managed/guard-destructive-search-lane.sh",
    ]) {
      expect(readFileSync(join(pluginRoot, file), "utf-8").toLowerCase()).not.toContain(
        "codegraph",
      );
    }
  });

  // Covers: R29
  it("does not redirect `git grep` (D6 drops that rule)", () => {
    expect(runGuard("git grep patron")).toBe(0);
  });

  // Covers: R30
  describe("lets through what is not a repo search", () => {
    const allowed = [
      "rg --files",
      "rg --files src/",
      "rg --version",
      "rg --help",
      'grep -rn "foo" ~/.claude/skills',
      'grep -rn "foo" /tmp/scratch',
      "rg foo /tmp/out",
    ];
    for (const command of allowed) {
      it(`allows ${command}`, () => {
        expect(runGuard(command)).toBe(0);
      });
    }

    it("still blocks an absolute path INSIDE the repo", () => {
      expect(runGuard(`grep -rn "foo" ${fixtures.running.repo}/src`)).toBe(2);
    });
  });

  // Covers: R29
  it("keeps the destructive rules in front of the lane", () => {
    expect(runGuard("rm -rf /")).toBe(2);
  });

  // Covers: R31
  describe("falls open when tgrep cannot answer", () => {
    it("with the server off, the remedy uses --no-index", () => {
      const f = fixtures["not-running"];
      expect(runGuard('grep -rn "foo" src/', f)).toBe(2);
      expect(stderrOf('grep -rn "foo" src/', f)).toContain(
        "tgrep search -n --no-index -- PATTERN ROOT",
      );
    });

    it("without the binary, the search is allowed", () => {
      expect(runGuard('grep -rn "foo" src/', fixtures.absent)).toBe(0);
    });

    it("without an index, the search is allowed", () => {
      expect(runGuard('grep -rn "foo" src/', fixtures["no-index"])).toBe(0);
    });

    it("runs `tgrep status` only on the branch that blocks", () => {
      // An absent binary would fail open on the very first call if it ran early.
      expect(runGuard("cat f.txt | grep foo", fixtures.absent)).toBe(0);
    });
  });

  // Covers: R29, R31
  describe("a broken script cannot take the destructive rules down", () => {
    const broken = buildFixture("running", "if then fi (\nexit 42\n");
    it("a syntax error lets the command pass", () => {
      expect(runGuard('grep -rn "foo" src/', broken)).toBe(0);
    });

    it("the destructive rules still block", () => {
      expect(runGuard("rm -rf /", broken)).toBe(2);
      expect(runGuard("git commit --no-verify -m x", broken)).toBe(2);
    });

    it("any other exit code lets the command pass", () => {
      expect(runGuard('grep -rn "foo" src/', buildFixture("running", "exit 7\n"))).toBe(0);
    });
  });
});

describe.runIf(runsBash)("guard-search-routing: render wiring", () => {
  function config(tgrepEnabled: boolean): NavoriConfig {
    return NavoriConfigSchema.parse({
      name: "search-lane",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "true", full: "true" },
      plugins: { tgrep: { enabled: tgrepEnabled } },
    });
  }

  // Covers: R29
  it("installs the sub-block before the closing `exit 0` and the script beside it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-search-lane-render-"));
    try {
      renderClaudeEngine(cwd, config(true), { dryRun: false });
      const hook = readFileSync(join(cwd, ".claude/hooks/guard-destructive.sh"), "utf-8");
      expect(hook).toContain(`navori:managed start id="${SUB_BLOCK_ID}"`);
      // The sub-block runs after the base block and before the hook's final `exit 0`.
      const closeAt = hook.indexOf(`navori:managed end id="${SUB_BLOCK_ID}"`);
      expect(closeAt).toBeGreaterThan(
        hook.indexOf('navori:managed end id="guard-destructive-base"'),
      );
      expect(closeAt).toBeLessThan(hook.lastIndexOf("\nexit 0"));
      expect(existsSync(join(cwd, ".claude/scripts/guard-search-routing.sh"))).toBe(true);

      // A second render over the result is a no-op for the sub-block.
      renderClaudeEngine(cwd, config(true), { dryRun: false });
      expect(readFileSync(join(cwd, ".claude/hooks/guard-destructive.sh"), "utf-8")).toBe(hook);

      // Disabling the plugin strips the sub-block and the script.
      renderClaudeEngine(cwd, config(false), { dryRun: false });
      const after = readFileSync(join(cwd, ".claude/hooks/guard-destructive.sh"), "utf-8");
      expect(after).not.toContain(SUB_BLOCK_ID);
      expect(existsSync(join(cwd, ".claude/scripts/guard-search-routing.sh"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
