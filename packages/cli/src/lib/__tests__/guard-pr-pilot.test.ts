import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for `core-assets/hooks/guard-pr-pilot.sh` (#705).
 *
 * The measurement behind the hook: the `commit-pr-pilot` owns commit+PR by
 * doctrine and is invoked on 37 of 232 PRs across 58 audited sessions — and 0
 * of 101 in navori's own repo, while `alertaciudadana-backend` reaches 48%. So
 * the pilot works when a cycle reaches its end; what fails is reaching it. The
 * doctrine ties the pilot to "after the reviewer approves", a state these
 * sessions never enter, and nothing intercepted `gh pr create`.
 *
 * The rule has to hold three cases apart, and the tests are one per case:
 * a PR from a sidechain (fine), a PR that declares why there was none (fine),
 * and a PR from the main thread with neither (the 101).
 */

const runsBash = process.platform !== "win32";

const hookPath = (() => {
  // Expanded once, exactly like `navori render` inlines the includes: the tests
  // must drive what a rendered repo runs, not the source with directives in it.
  const source = resolve(getCoreRoot(), "core-assets/hooks/guard-pr-pilot.sh");
  const dir = mkdtempSync(join(tmpdir(), "navori-pr-pilot-src-"));
  const p = join(dir, "guard-pr-pilot.sh");
  writeFileSync(p, expandHookIncludes(readFileSync(source, "utf-8")));
  chmodSync(p, 0o755);
  return p;
})();

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

/** Exit code, agreed across every available shell (#391). */
function run(command: string, extra: Record<string, unknown> = {}): number {
  const payload = JSON.stringify({ tool_input: { command }, ...extra });
  return acrossShells((shell) => {
    const r = spawnSync(resolveBin(shell), [hookPath], { input: payload, encoding: "utf-8" });
    return r.status ?? -1;
  });
}

function stderrOf(command: string, extra: Record<string, unknown> = {}): string {
  const r = spawnSync(resolveBin("bash"), [hookPath], {
    input: JSON.stringify({ tool_input: { command }, ...extra }),
    encoding: "utf-8",
  });
  return r.stderr ?? "";
}

describe.runIf(runsBash)("guard-pr-pilot (#705)", () => {
  it("blocks a PR opened from the main thread with no declaration", () => {
    // This is the 101: the work was done by hand and the PR opens as its
    // natural continuation, with nothing in between.
    expect(run('gh pr create --title "fix: x" --body "## Summary\n- arregla x"')).toBe(2);
  });

  it("names both ways out when it blocks", () => {
    const err = stderrOf('gh pr create --title "fix: x" --body "algo"');
    // A gate that only says no teaches people to route around it. The pilot is
    // the default route; the declaration is the escape the doctrine already
    // defines for when delegation is genuinely impossible.
    expect(err).toContain("commit-pr-pilot");
    expect(err).toContain("navori:no-pilot");
  });

  it("lets through a PR opened from a subagent", () => {
    // `agent_id` is empty in the main thread and set inside a sidechain — the
    // only signal the payload carries about who is running. It cannot say WHICH
    // subagent, and the hook does not pretend otherwise.
    expect(run('gh pr create --title "fix: x" --body "y"', { agent_id: "agt_123" })).toBe(0);
  });

  it("lets through a PR whose body declares navori:no-pilot", () => {
    expect(
      run(
        'gh pr create --title "fix: x" --body "## Notas\nnavori:no-pilot — el operador prohibió subagentes"',
      ),
    ).toBe(0);
  });

  it("ignores every command that is not opening a PR", () => {
    // It runs on EVERY Bash call, so the common case must be free and silent.
    for (const cmd of ["git status", "gh pr list", "gh pr view 42 --comments", "pnpm test"]) {
      expect(run(cmd)).toBe(0);
    }
  });

  it("does not fire on a command that merely mentions the phrase in prose", () => {
    // The raw payload is the cheap gate; the COMMAND is what decides. A message
    // quoting `gh pr create` must not be blocked as if it ran it.
    const payload = JSON.stringify({
      tool_input: { command: "git status" },
      prompt: "explain what gh pr create does",
    });
    const r = spawnSync(resolveBin("bash"), [hookPath], { input: payload, encoding: "utf-8" });
    expect(r.status).toBe(0);
  });

  it("survives a payload with no command at all", () => {
    // Fail-open on shapes it does not understand: a gate that dies under
    // `set -euo pipefail` is indistinguishable from one that approved.
    const r = spawnSync(resolveBin("bash"), [hookPath], { input: "{}", encoding: "utf-8" });
    expect(r.status).toBe(0);
  });
});
