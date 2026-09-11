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
});
