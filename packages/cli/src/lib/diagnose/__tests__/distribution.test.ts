import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "../../schema.ts";
import { scanDistribution } from "../distribution.ts";
import { distributionLines } from "../../../commands/doctor.ts";
import { distributionSummary } from "../../../commands/status.ts";
import { tc } from "../../i18n.ts";

/**
 * Rendered output with its ANSI colour codes removed, for asserting on the
 * SENTENCE rather than on the terminal's escape sequences.
 *
 * Not a nicety — it is the fix for a green gate that did not predict CI (#780).
 * picocolors enables colour when `env.CI` is set (its `|| !!env.CI` arm), which
 * GitHub Actions sets on its own; `ci.yml` exports no `FORCE_COLOR` at all. So
 * these rows come out uncoloured on a developer's piped stdout and coloured in
 * CI, and an assert on a raw literal silently depends on which machine runs it.
 *
 * What broke was the one assert whose literal STRADDLES a coloured span:
 * `distributionVsBase` wraps the ref in `accent()`, so `git diff --stat
 * origin/main` arrives as `git diff --stat <ESC>[36morigin/main<ESC>[39m`. The
 * neighbouring asserts on `origin/main` alone passed either way — the codes sit
 * around that substring instead of inside it — which is exactly the accident
 * this removes: they were right by luck, not by construction.
 *
 * Applied to EVERY assert over rendered output in this file, not only the one
 * that failed. The alternative (asserting on fragments no colour can touch)
 * would mean giving up on asserting the sentence, and the sentence is the whole
 * reason `distributionLines` is exported and tested at all.
 *
 * Deliberately local to this file: one consumer today, and a shared helper for a
 * single caller is the speculative kind of abstraction. Promote it to
 * `helpers/` the day a second suite needs it.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function plain(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * #778 — the git axis, over REAL repositories.
 *
 * These fixtures build actual repos (a bare "origin" plus clones) rather than
 * mocking `execFileSync`, on purpose: every defect this scan exists to catch is
 * a property of git's own state machine — what `@{u}` resolves to on a branch
 * with no upstream, what `git show <ref>:<path>` answers when the ref does not
 * ship that file, how `status --porcelain` spells a rename. A mocked git would
 * assert the shape of commands we chose to run, which is the one thing already
 * visible in the diff, and would have been green for the exact park state that
 * motivated the issue.
 */

/** `git` in a fixture: quiet, and loud only when the fixture itself is broken. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `navori-distribution-${prefix}-`));
}

/** A bare repo to act as `origin`, with `main` as its HEAD. */
function bareOrigin(): string {
  const cwd = temp("origin");
  execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", cwd], { stdio: "ignore" });
  return cwd;
}

function clone(origin: string, prefix = "clone"): string {
  const cwd = temp(prefix);
  rmSync(cwd, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin, cwd], { stdio: "ignore" });
  git(cwd, "config", "user.email", "t@example.com");
  git(cwd, "config", "user.name", "t");
  return cwd;
}

/** Write a harness whose `.claude/settings.json` stamps `version`. */
function writeHarness(cwd: string, version: string, extra = "x"): void {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude/settings.json"),
    `${JSON.stringify({ $navori: { managed: true, version }, hooks: {} }, null, 2)}\n`,
  );
  writeFileSync(join(cwd, "CLAUDE.md"), `# harness ${version}\n${extra}\n`);
  writeFileSync(join(cwd, "navori.config.json"), `{ "name": "fx", "version": "${version}" }\n`);
}

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", message);
}

/** A repo whose `main` is published on `origin` carrying harness `version`. */
function publishedRepo(version = "0.7.7"): { origin: string; cwd: string } {
  const origin = bareOrigin();
  const seed = clone(origin, "seed");
  writeHarness(seed, version);
  commitAll(seed, "harness");
  git(seed, "push", "-q", "-u", "origin", "main");
  // `origin/HEAD` is what `resolveBaseRef` falls back to, and a bare repo does
  // not hand it to a clone automatically.
  git(seed, "remote", "set-head", "origin", "main");
  return { origin, cwd: seed };
}

function config(overrides: Partial<NavoriConfigInput> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "fx",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...overrides,
  });
}

describe("scanDistribution — the gates that must stay silent", () => {
  it("returns null outside a git work tree", () => {
    const cwd = temp("nogit");
    writeHarness(cwd, "0.8.6");
    expect(scanDistribution(cwd, config())).toBeNull();
  });

  it("returns null when gitignoreHarness is not 'off' — navori ignores it by design", () => {
    const { cwd } = publishedRepo();
    writeHarness(cwd, "0.8.6");
    expect(scanDistribution(cwd, config({ gitignoreHarness: "full" }))).toBeNull();
  });

  it("returns null in a repo that keeps the harness out of git by hand (the Bonum case)", () => {
    const origin = bareOrigin();
    const cwd = clone(origin, "ignored");
    writeFileSync(join(cwd, ".gitignore"), ".claude/\nCLAUDE.md\nnavori.config.json\n");
    writeFileSync(join(cwd, "README.md"), "app\n");
    commitAll(cwd, "app");
    git(cwd, "push", "-q", "-u", "origin", "main");
    // The harness exists on disk and is dirty — and git tracks none of it, so
    // there is nothing for git to share and nothing to report.
    writeHarness(cwd, "0.8.6");
    expect(scanDistribution(cwd, config())).toBeNull();
  });

  it("returns null when the harness is committed, pushed and identical to the base", () => {
    const { cwd } = publishedRepo("0.8.6");
    expect(scanDistribution(cwd, config())).toBeNull();
  });
});

describe("scanDistribution — the four divergences", () => {
  it("(1+3) reports the alertaciudadana_backend state: a render staged, the base three minors behind", () => {
    const { cwd } = publishedRepo("0.7.7");
    // Its exact shape: the 0.8.6 render sits in the INDEX, on a branch pointing
    // at the same commit as the base. Every HEAD-to-HEAD comparison called that
    // identical, which is how it survived two weeks of measurement.
    writeHarness(cwd, "0.8.6");
    git(cwd, "add", "-A");

    const report = scanDistribution(cwd, config());
    expect(report).not.toBeNull();
    expect(report?.uncommitted).toEqual([
      ".claude/settings.json",
      "CLAUDE.md",
      "navori.config.json",
    ]);
    // Nothing was committed, so the unpushed half stays quiet...
    expect(report?.unpushed).toBeNull();
    // ...but the base comparison is against the WORKING TREE, and it is the one
    // that names the two versions.
    expect(report?.base?.localVersion).toBe("0.8.6");
    expect(report?.base?.baseVersion).toBe("0.7.7");
    expect(report?.base?.files).toBe(3);
  });

  it("does not repeat the uncommitted list as a base row when the versions agree", () => {
    // HEAD is the base and the harness version did not move: the base row would
    // restate the uncommitted row file for file and add nothing.
    const { cwd } = publishedRepo("0.8.6");
    writeFileSync(join(cwd, "CLAUDE.md"), "# hand edit\n");
    const report = scanDistribution(cwd, config());
    expect(report?.uncommitted).toEqual(["CLAUDE.md"]);
    expect(report?.base).toBeNull();
  });

  it("(1) reports an unstaged change too — staged is not the distinction", () => {
    const { cwd } = publishedRepo("0.7.7");
    writeFileSync(join(cwd, "CLAUDE.md"), "# hand edit\n");
    expect(scanDistribution(cwd, config())?.uncommitted).toEqual(["CLAUDE.md"]);
  });

  it("(2) reports harness commits that never reached the upstream", () => {
    const { cwd } = publishedRepo("0.7.7");
    writeHarness(cwd, "0.8.6");
    commitAll(cwd, "chore(harness): navori 0.8.6");

    const report = scanDistribution(cwd, config());
    expect(report?.unpushed?.commits).toBe(1);
    expect(report?.unpushed?.upstream).toBe("origin/main");
    expect(report?.uncommitted).toEqual([]);
  });

  it("(2) stays quiet about unpushed work on a branch with no upstream", () => {
    const { cwd } = publishedRepo("0.7.7");
    git(cwd, "checkout", "-q", "-b", "chore/harness-navori-0.8.6");
    writeHarness(cwd, "0.8.6");
    commitAll(cwd, "chore(harness): navori 0.8.6");

    const report = scanDistribution(cwd, config());
    // `@{u}` resolves to nothing here, and a branch nobody pushed yet is normal
    // work in progress — the divergence worth naming is the base comparison.
    expect(report?.unpushed).toBeNull();
    expect(report?.base?.files).toBeGreaterThan(0);
  });

  it("(3) names both versions when the base branch shares a different harness", () => {
    // The alertaciudadana_app state: 0.8.6 on a pushed branch, `origin/main`
    // still on 0.7.7. This is the comparison nobody ran for two weeks.
    const { cwd } = publishedRepo("0.7.7");
    git(cwd, "checkout", "-q", "-b", "chore/harness-navori-0.8.6");
    writeHarness(cwd, "0.8.6");
    commitAll(cwd, "chore(harness): navori 0.8.6");

    const base = scanDistribution(cwd, config())?.base;
    expect(base?.ref).toBe("origin/main");
    expect(base?.files).toBe(3);
    expect(base?.localVersion).toBe("0.8.6");
    expect(base?.baseVersion).toBe("0.7.7");
    expect(base?.behind).toBe(0);
  });

  it("(4) reports a checkout the base left behind on harness files", () => {
    // navori-harness's own state at audit time: the session ran agents from
    // before the merge, and nothing said so.
    const { origin, cwd } = publishedRepo("0.7.7");
    const other = clone(origin, "other");
    writeHarness(other, "0.8.6");
    commitAll(other, "chore(harness): navori 0.8.6");
    git(other, "push", "-q", "origin", "main");
    git(cwd, "fetch", "-q", "origin");

    const base = scanDistribution(cwd, config())?.base;
    expect(base?.behind).toBe(1);
    expect(base?.files).toBe(3);
    expect(base?.localVersion).toBe("0.7.7");
    expect(base?.baseVersion).toBe("0.8.6");
  });

  it("falls back to origin/HEAD when the config declares no branchBase", () => {
    const { cwd } = publishedRepo("0.7.7");
    git(cwd, "checkout", "-q", "-b", "feat/x");
    writeHarness(cwd, "0.8.6");
    commitAll(cwd, "harness");

    // `branchBase` is required by the schema, so the fallback is exercised by
    // pointing it at a branch that does not exist: `origin/HEAD` is what a repo
    // with a stale or wrong `branchBase` lands on, and it must still resolve.
    const base = scanDistribution(cwd, config({ branchBase: "nonexistent-branch" }))?.base;
    expect(base?.ref).toBe("origin/main");
    expect(base?.baseVersion).toBe("0.7.7");
  });

  it("reports '?' material — a null version — when a side ships no settings stamp", () => {
    const origin = bareOrigin();
    const seed = clone(origin, "nostamp");
    writeFileSync(join(seed, "navori.config.json"), `{ "name": "fx" }\n`);
    commitAll(seed, "config only");
    git(seed, "push", "-q", "-u", "origin", "main");
    git(seed, "remote", "set-head", "origin", "main");
    git(seed, "checkout", "-q", "-b", "feat/x");
    writeFileSync(join(seed, "navori.config.json"), `{ "name": "fx", "v": 2 }\n`);
    commitAll(seed, "change");

    const base = scanDistribution(seed, config())?.base;
    expect(base?.files).toBe(1);
    expect(base?.localVersion).toBeNull();
    expect(base?.baseVersion).toBeNull();
  });

  it("renders the sentence that names both versions — the claim, not the count", () => {
    const { cwd } = publishedRepo("0.7.7");
    git(cwd, "checkout", "-q", "-b", "chore/harness-navori-0.8.6");
    writeHarness(cwd, "0.8.6");
    commitAll(cwd, "chore(harness): navori 0.8.6");

    const report = scanDistribution(cwd, config());
    expect(report).not.toBeNull();
    const rows = plain(distributionLines(report!, tc("es").doctor).join("\n"));
    // The whole product of this section: "0.8.6 here, 0.7.7 there". A row that
    // only counted files is the report alertaciudadana already had.
    expect(rows).toContain("0.8.6");
    expect(rows).toContain("0.7.7");
    expect(rows).toContain("origin/main");
    expect(rows).toContain("git diff --stat origin/main");
    // `status`'s one-liner defers the sentence but must state the question.
    // `plain` here too: `distributionSummary` returns raw text today, and the
    // colour is added by its caller in `status.ts` — an arrangement no assert
    // should have to know about, and one nobody would remember to re-check.
    expect(plain(distributionSummary(report!, tc("es").status))).toContain(
      "difieren vs origin/main",
    );
  });

  it("caps the uncommitted sample instead of printing 55 paths", () => {
    const { cwd } = publishedRepo("0.7.7");
    const report = {
      uncommitted: ["a", "b", "c", "d", "e"],
      unpushed: null,
      base: null,
    };
    expect(scanDistribution(cwd, config())).toBeNull(); // fixture sanity
    const rows = plain(distributionLines(report, tc("en").doctor).join("\n"));
    expect(rows).toContain("a, b, c, +2");
    expect(rows).toContain("5 harness file(s)");
  });

  it("never touches the network: the scan works with the remote deleted", () => {
    // The no-fetch rule, asserted rather than promised: an unreachable `origin`
    // must not turn an inspection command into a hang or a failure.
    const { origin, cwd } = publishedRepo("0.7.7");
    writeHarness(cwd, "0.8.6");
    commitAll(cwd, "harness");
    rmSync(origin, { recursive: true, force: true });

    const report = scanDistribution(cwd, config());
    expect(report?.unpushed?.commits).toBe(1);
    expect(report?.base?.baseVersion).toBe("0.7.7");
  });
});
