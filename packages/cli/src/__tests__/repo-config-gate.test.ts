import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config.ts";
import { DEFAULT_LANG } from "../lib/i18n.ts";
import { placeholderFallback } from "../lib/placeholders.ts";

/**
 * This repo dogfoods navori: its own `navori.config.json` is what renders the
 * harness the agents working on it obey. Two fields of it were quietly wrong
 * and nothing noticed, because a config is data — no compiler reads it (#508).
 *
 *  1. `qualityGate.full` is the command the prose orders an agent to run before
 *     a PR. It listed fewer checks than CI gates on, so a green local gate
 *     could still land a red CI (it did: `check:render` red, `full` green).
 *  2. `project.criticalAreas` was undeclared, so every asset rendered the
 *     generic placeholder `auth, permissions, payments, data integrity`. A CLI
 *     scaffolder has none of the first three, so the harness escalated on
 *     signals that can never fire and stayed quiet on the ones that can — a
 *     change deleting files in the user's repo did not count as critical.
 *
 * The CI half DERIVES its expectations from `.github/workflows/ci.yml` instead
 * of restating them: a hand-written gate checked against a hand-written list is
 * exactly the pair that already drifted. Add a step to CI and this suite fails
 * until the gate covers it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "ci.yml");
const CONFIG_PATH = resolve(REPO_ROOT, "navori.config.json");
const PRE_PUSH_HOOK = resolve(REPO_ROOT, "scripts", "git-hooks", "pre-push");
const HOOK_INSTALLER = resolve(REPO_ROOT, "scripts", "install-git-hooks.mjs");

interface RootPackageJson {
  scripts?: Record<string, string>;
}

/**
 * CI checks the local gate is NOT expected to repeat. Every entry needs a
 * reason; an unexplained one is how a check quietly leaves the gate. Anything
 * CI adds that is NOT listed here must show up in the gate.
 */
const EXEMPT_FROM_LOCAL_GATE = new Map<string, string>([
  ["install", "dependency install, not a check"],
  ["build", "`check:render` rebuilds before rendering, so the gate builds anyway"],
  [
    "check:assets:ci",
    // The gate runs `check:assets`, the SAME check: `:ci` only adds `--strict`,
    // which turns its "could not run" outcome red. That outcome depends on tags
    // being present, and CI fetches them on purpose (`fetch-depth`/tags in the
    // checkout) precisely so the strict form can compare against one. A fresh
    // local clone usually has none, so demanding `:ci` here would fail the gate
    // for an environmental reason while the substance — do the assets cite a
    // released subcommand — is already covered locally. What the strict form
    // adds is detection of a CI-SETUP regression, which a local run cannot
    // observe by construction.
    "same check as `check:assets`; `--strict` only guards CI's own tag setup, which a local clone cannot observe",
  ],
]);

/**
 * The MIRROR map (#777): gate checks CI is not expected to repeat.
 *
 * The CI→gate direction above has existed since #508; this one did not, and the
 * comment that skipped it called a gate wider than CI "otherwise fine". It stops
 * being fine the moment a check exists ONLY in the gate: the gate is what agents
 * run, so such a check never sees a PR opened by hand, and nothing says so.
 * Same contract as its mirror — every entry needs a reason, and an entry whose
 * check left the gate is stale and fails below.
 */
const EXEMPT_FROM_CI = new Map<string, string>([
  [
    "check:assets",
    // The inverse of the `check:assets:ci` exemption above, and the same pair of
    // checks: CI runs the STRICTER `:ci` variant, which is this one plus
    // `--strict`. Listing it as missing would demand CI run both.
    "CI runs `check:assets:ci`, the same check with `--strict` on top — a strict superset, not a gap",
  ],
  [
    "jscpd:check",
    // See `semgrep:check` below — same reasoning, same ceiling. jscpd is not in
    // the lockfile either (the hook resolves `node_modules/.bin/jscpd` first and
    // falls back to a global install), so a CI step would skip itself too.
    "the tool is not a repo dependency, so a CI step would skip itself and read green — the false-green this suite exists to kill",
  ],
  [
    "semgrep:check",
    // Three reasons, in order of weight:
    //  1. semgrep is a python package, not a repo dependency. Both scan hooks
    //     exit 0 with `⊘ not installed` when the tool is absent — correct for an
    //     optional local gate, fatal for CI: the step would report green having
    //     scanned nothing, which is exactly the failure #777 is about.
    //  2. `p/default` is fetched from a remote registry per run, so the step
    //     would put a third-party network dependency in front of every PR. Same
    //     class as `check:assets:ci`'s exemption, pointing the other way: a red
    //     for an environmental reason instead of for the diff.
    //  3. The substance runs three times before a merge in the agent cycle: the
    //     reviewer's Pass 2 (this gate), the commit hook and the push hook.
    // TODO(ci): ceiling — a PR opened by hand, by someone who never runs the
    // gate and has no harness hooks, is scanned by nothing. Upgrade trigger: the
    // first such PR, or the first external contributor. The fix is an install
    // step plus a pinned ruleset, not merely adding the check here.
    "the tool is not a repo dependency and `p/default` is fetched per run; a CI step would skip itself (green over an unscanned diff) or fail on a registry outage",
  ],
]);

/** The versioned pre-push delegates to pnpm check, so no gate step is exempt. */
const EXEMPT_FROM_PRE_PUSH = new Map<string, string>();

/** Checks in `required` that `covered` lacks and no exemption excuses. */
function uncovered(
  required: Iterable<string>,
  covered: Set<string>,
  exempt: Map<string, string>,
): string[] {
  return [...required].filter((c) => !exempt.has(c) && !covered.has(c)).sort();
}

/**
 * Identify a check independently of WHICH package script carries it: the gate
 * reaches the CLI's scripts as `cd packages/cli && pnpm <s>` and CI as
 * `pnpm --filter navori <s>`, so both must reduce to `<s>`. A script in any
 * OTHER workspace package keeps its filter, because running it is a genuinely
 * distinct command — collapsing it would let `--filter @navori/website build`
 * hide behind the CLI's own `build` and stay out of the gate unnoticed.
 */
function checkKey(match: RegExpMatchArray): string {
  const filter = match[1];
  const script = match[2] ?? "";
  return !filter || filter === "navori" ? script : `${filter} ${script}`;
}

const PNPM_INVOCATION = /\bpnpm\s+(?:--filter\s+(\S+)\s+)?(?:run\s+)?([a-z][\w:.-]*)/g;

/** The `quality:` job's body, sliced out of the workflow by indentation. */
function qualityJobBody(): string {
  const yaml = readFileSync(CI_WORKFLOW, "utf-8");
  const start = yaml.indexOf("\n  quality:\n");
  expect(start, "ci.yml no longer declares a `quality:` job").toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every check the quality job invokes, as `checkKey` identities. */
function ciChecks(): Set<string> {
  const runs = [...qualityJobBody().matchAll(/^\s*run: (.+)$/gm)].flatMap((m) => m[1] ?? []);
  const checks = new Set<string>();
  for (const run of runs) {
    for (const m of run.matchAll(PNPM_INVOCATION)) checks.add(checkKey(m));
  }
  return checks;
}

/** The checks an `&&`-chained gate command actually invokes. */
function gateChecks(command: string): Set<string> {
  const checks = new Set<string>();
  for (const segment of command.split("&&")) {
    for (const m of segment.trim().matchAll(PNPM_INVOCATION)) checks.add(checkKey(m));
  }
  return checks;
}

describe("qualityGate.full covers what CI gates on (#508.1)", () => {
  const ci = ciChecks();
  const config = readConfig(CONFIG_PATH);
  const declaredGate = config.qualityGate?.full ?? "";
  const gate = gateChecks(declaredGate);

  it("the ci.yml parser finds the steps it is meant to police (anti-false-green)", () => {
    // A parser that silently matched nothing would report "the gate covers
    // everything" — the exact false green this suite exists to prevent.
    expect([...ci]).toEqual(
      expect.arrayContaining(["check:render", "check:assets:ci", "format:check", "lint"]),
    );
    expect(ci.size).toBeGreaterThanOrEqual(7);
  });

  it("the gate parser reads the declared command (anti-false-green)", () => {
    expect(declaredGate).not.toBe("");
    expect([...gate]).toContain("lint");
    expect(gate.size).toBeGreaterThanOrEqual(5);
  });

  it("every non-exempt CI check appears in qualityGate.full", () => {
    expect(
      uncovered(ci, gate, EXEMPT_FROM_LOCAL_GATE),
      "add these to navori.config.json qualityGate.full, or exempt them here with a reason",
    ).toEqual([]);
  });

  it("no exemption is stale (each still names a check CI runs)", () => {
    const unused = [...EXEMPT_FROM_LOCAL_GATE.keys()].filter((c) => !ci.has(c)).sort();
    expect(unused, "CI stopped running these — drop the exemption").toEqual([]);
  });

  // --- the mirror direction (#777) -----------------------------------------

  it("every non-exempt qualityGate.full check appears in ci.yml", () => {
    expect(
      uncovered(gate, ci, EXEMPT_FROM_CI),
      "add these to .github/workflows/ci.yml, or exempt them in EXEMPT_FROM_CI with a reason",
    ).toEqual([]);
  });

  it("no CI exemption is stale (each still names a check the gate runs)", () => {
    const unused = [...EXEMPT_FROM_CI.keys()].filter((c) => !gate.has(c)).sort();
    expect(unused, "the gate stopped running these — drop the exemption").toEqual([]);
  });

  it("the mirror check really reports an uncovered step (test of the test)", () => {
    // Without this, a comparison that silently matched everything would report
    // "CI covers the gate" forever — the vacuous green both directions guard
    // against. The fake gate names a check no workflow runs.
    const fake = gateChecks("pnpm format:check && pnpm sast:scan");
    expect(uncovered(fake, ci, EXEMPT_FROM_CI)).toEqual(["sast:scan"]);
    // …and an exemption silences exactly that one, nothing else.
    expect(uncovered(fake, ci, new Map([["sast:scan", "fixture"]]))).toEqual([]);
  });

  it.each([
    ["EXEMPT_FROM_LOCAL_GATE", EXEMPT_FROM_LOCAL_GATE],
    ["EXEMPT_FROM_CI", EXEMPT_FROM_CI],
  ])("%s: every entry carries a reason, not a placeholder", (_name, map) => {
    // An exemption is a decision; an unexplained one is how a check quietly
    // leaves a pipeline and nobody can tell whether that was deliberate.
    const thin = [...map].filter(([, why]) => why.trim().length < 30).map(([check]) => check);
    expect(thin, "write why this check is exempt, not just that it is").toEqual([]);
  });

  it("CI builds the website, so a broken site fails the PR and not the deploy (#508.4)", () => {
    // `apps/website` used to be built only by deploy-website.yml, which runs
    // after the merge. This is the one CI step nothing else would notice
    // leaving, because the gate being a superset of CI is otherwise fine.
    expect([...ci]).toContain("@navori/website build");
  });

  it("the root `check` script runs the same thing the gate declares", () => {
    // Before #508 this was a THIRD hand-written list, shorter than both the
    // gate and CI. One string, two consumers (humans type `pnpm check`, agents
    // read the gate) — so they must be the same string.
    const rootPkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
    ) as RootPackageJson;
    expect(rootPkg.scripts?.check).toBe(declaredGate);
  });

  it("the versioned pre-push runs every non-exempt gate step (#777)", () => {
    const hook = readFileSync(PRE_PUSH_HOOK, "utf-8");
    const rootPkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
    ) as RootPackageJson;
    const prePush = gateChecks(rootPkg.scripts?.check ?? "");

    expect(hook).toContain("exec pnpm check");
    expect(hook).toContain("NAVORI_PRE_PUSH_RUNNING");
    expect(
      uncovered(gate, prePush, EXEMPT_FROM_PRE_PUSH),
      "add every missing qualityGate.full step to the versioned pre-push, or document its exemption",
    ).toEqual([]);
    expect(EXEMPT_FROM_PRE_PUSH).toEqual(new Map());
  });

  it("installs the tracked pre-push hook", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "navori-pre-push-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync(process.execPath, [HOOK_INSTALLER], { cwd: repo });
      const target = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], {
        cwd: repo,
        encoding: "utf-8",
      }).trim();

      expect(readFileSync(resolve(repo, target), "utf-8")).toBe(
        readFileSync(PRE_PUSH_HOOK, "utf-8"),
      );
      expect(statSync(resolve(repo, target)).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a non-navori pre-push hook", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "navori-pre-push-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const target = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], {
        cwd: repo,
        encoding: "utf-8",
      }).trim();
      writeFileSync(resolve(repo, target), "#!/usr/bin/env bash\necho custom\n");

      const result = spawnSync(process.execPath, [HOOK_INSTALLER], {
        cwd: repo,
        encoding: "utf-8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing to overwrite non-navori hook");
      expect(readFileSync(resolve(repo, target), "utf-8")).toContain("echo custom");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The security layer runs BEFORE the approval, not after it (#777).
 *
 * The reviewer's Pass 2 runs exactly `qualityGate.full`, and the pilot trusts
 * that evidence instead of re-running it. So for a whole cycle the first thing
 * that ever showed the diff to semgrep or jscpd was the `git commit` hook —
 * AFTER `APPROVED` and after the content receipt was signed. A red there is not
 * a caught bug, it is rework past the point where catching it was cheap, and it
 * happened: an approved diff with a green gate died in the semgrep hook.
 *
 * Putting the scans in the gate is what fixes it, and the assertion is DERIVED
 * from the rendered harness rather than restated: every `check-*.sh` in
 * `.claude/scripts/` is a gate scanner, so each must be reachable from a root
 * script the gate actually invokes. A third scanner added later inherits the
 * rule without anyone remembering to extend a list.
 *
 * The commit hook stays as the backstop — nothing here retires it. Its cost
 * after a green gate is the cache hit (#402), not a second scan.
 */
describe("the gate runs the scans before the approval (#777)", () => {
  const config = readConfig(CONFIG_PATH);
  const gate = gateChecks(config.qualityGate?.full ?? "");
  const rootPkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
  ) as RootPackageJson;
  const scanners = readdirSync(resolve(REPO_ROOT, ".claude", "scripts"))
    .filter((f) => /^check-.+\.sh$/.test(f))
    .sort();

  it("finds the rendered scanners it is meant to police (anti-false-green)", () => {
    // An empty listing would make the cases below vacuous — "every scanner is
    // wired" is trivially true of no scanners.
    expect(scanners).toEqual(["check-jscpd.sh", "check-semgrep.sh"]);
  });

  it.each(scanners)("%s is invoked by a root script that qualityGate.full runs", (scanner) => {
    const runners = Object.entries(rootPkg.scripts ?? {}).filter(([, body]) =>
      body.includes(scanner),
    );
    expect(
      runners.map(([name]) => name),
      `no script in the root package.json runs ${scanner} — the gate cannot reach it`,
    ).toHaveLength(1);
    const name = runners[0]?.[0] ?? "";
    expect(
      [...gate],
      `\`pnpm ${name}\` is missing from qualityGate.full: ${scanner} would first see the diff at commit time, after APPROVED`,
    ).toContain(name);
  });

  it("the scan steps read stdin from /dev/null (the hooks block on a TTY)", () => {
    // These scripts are PreToolUse hooks: they open with `payload=$(cat)`. Run
    // from a terminal without the redirect, that `cat` waits for input and the
    // gate hangs with no output — a stall that reads like a slow scan.
    for (const scanner of scanners) {
      const body = Object.values(rootPkg.scripts ?? {}).find((s) => s.includes(scanner)) ?? "";
      expect(body, `${scanner} must be invoked with stdin closed`).toContain("/dev/null");
    }
  });
});

describe("project.criticalAreas describes THIS product (#508.2)", () => {
  const config = readConfig(CONFIG_PATH);
  const declared = config.project?.criticalAreas ?? [];

  it("the generic placeholder is still what an undeclared config renders (anti-false-green)", () => {
    // The comparison below is only meaningful while this is the fallback. If
    // the fallback text changes, this fails first and says so, instead of
    // letting the real assertion pass against a value nothing produces.
    expect(placeholderFallback("project.criticalAreas", DEFAULT_LANG)).toBe(
      "auth, permissions, payments, data integrity",
    );
  });

  it("is declared, so no asset renders the placeholder", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("is not the placeholder list restated", () => {
    const placeholder = placeholderFallback("project.criticalAreas", DEFAULT_LANG);
    expect(declared.join(", ")).not.toBe(placeholder);
    const generic = new Set(placeholder.split(", "));
    const restated = declared.filter((area) => generic.has(area.trim().toLowerCase()));
    expect(
      restated,
      "these are the generic placeholder's areas, not this repo's — a CLI scaffolder has no auth or payments",
    ).toEqual([]);
  });
});
