import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for plugins/tgrep/scripts/guard-search-routing.sh.
 *
 * The guard moves ONE doctrine from advisory prose to mechanism: content search
 * goes through the tgrep wrapper. The prose version shipped in 0.7.8 and is
 * measured at 7.4% adoption over 2,761 real searches, so the bet here is the
 * same one `guard-destructive` already won — in this harness the layers that
 * block hold, and the layers that suggest do not.
 *
 * THE TABLE BELOW IS NOT INVENTED. Every shape in it was taken from the 5,544
 * distinct grep/rg commands in the park's audited transcripts, where the guard
 * was measured at 91.7% coverage of genuine content searches and ZERO false
 * positives. The allow-cases matter more than the block-cases: a guard that
 * blocks a legitimate extraction teaches the model to route AROUND it, which is
 * strictly worse than the search it would have stopped.
 */

const runsBash = process.platform !== "win32";

const guardPath = (() => {
  const src = resolve(
    import.meta.dirname,
    "../../../../plugins/tgrep/scripts/guard-search-routing.sh",
  );
  const dir = mkdtempSync(join(tmpdir(), "navori-search-guard-"));
  const p = join(dir, "guard-search-routing.sh");
  writeFileSync(p, expandHookIncludes(readFileSync(src, "utf-8")));
  chmodSync(p, 0o755);
  return p;
})();

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

/** Run the guard with `command` on stdin; returns its exit code (2 = blocked). */
function runGuard(command: string): number {
  const payload = JSON.stringify({ tool_input: { command } });
  return acrossShells((shell) => {
    try {
      execFileSync(resolveBin(shell), [guardPath], {
        input: payload,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  });
}

function stderrOf(command: string): string {
  const payload = JSON.stringify({ tool_input: { command } });
  try {
    execFileSync(resolveBin("bash"), [guardPath], {
      input: payload,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "";
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? "");
  }
}

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
      [
        'bash .claude/scripts/tgrep-search.sh -rn "foo" src/',
        "the wrapper itself, which runs grep -rn internally on its fallback path",
      ],
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
    expect(err).toContain("tgrep-search.sh");
    expect(err).toContain("BLOCKED by guard-search-routing");
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

  it("says that the remedy's path is relative to the repo root (#724)", () => {
    // The path in the message is relative BECAUSE the allow rule is a literal;
    // any other spelling buys a prompt. `$CLAUDE_PROJECT_DIR` is NOT set in the
    // agent's shell — only in a hook's — so the obvious "make it absolute" fix
    // would expand to empty and turn an occasional exit 127 into a permanent
    // one. Naming the constraint is what removes the surprise.
    const err = stderrOf('grep -rn "foo" src/');
    expect(err).toContain("repo root");
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
