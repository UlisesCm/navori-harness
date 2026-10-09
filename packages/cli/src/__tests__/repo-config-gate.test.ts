import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config/config.ts";
import { DEFAULT_LANG } from "../lib/i18n.ts";
import { placeholderFallback } from "../lib/render/placeholders.ts";

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
const PRE_COMMIT_HOOK = resolve(REPO_ROOT, "scripts", "git-hooks", "pre-commit");
const HOOK_INSTALLER = resolve(REPO_ROOT, "scripts", "js", "install-git-hooks.mjs");
// Loaded by path: the script lives outside this package's tsconfig `rootDir`.
const { REPO_LOCAL_GIT_VARS, withoutRepoGitEnv } = (await import(
  pathToFileURL(resolve(REPO_ROOT, "scripts", "js", "git-env.mjs")).href
)) as {
  REPO_LOCAL_GIT_VARS: string[];
  withoutRepoGitEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

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
  [
    "@navori/website build",
    // #820 part A: CI's `quality:` job already runs this (see the "CI builds
    // the website" test below, `#508.4`) and CI is a strict superset of the
    // local gate for this step — nothing is skipped, only NOT repeated on
    // every local `bun check`. Measured cost in isolation was ~2.8s (warm
    // cache), so this is about not paying it twice per push, not about speed.
    "CI's `quality:` job already builds the website (#508.4); running it again locally repeats a check CI is a strict superset for",
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
]);

/**
 * Env for child git/installer calls: a commit from a linked worktree exports
 * `GIT_DIR`/`GIT_INDEX_FILE` into the hook, and `cwd` does not override them.
 * `inject` simulates that leak for the regression.
 */
function cleanGitEnv(inject: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...withoutRepoGitEnv(process.env), ...inject };
}

/**
 * The hook-fixture flow: `git init` + the installer, both under the scrubbed
 * env. Takes no env on purpose, so the leak regression exercises the real scrub.
 */
function initAndInstallHook(repo: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repo, env: cleanGitEnv() });
  execFileSync(process.execPath, [HOOK_INSTALLER], { cwd: repo, env: cleanGitEnv() });
}

/** Absolute path of a hook in `repo`'s git dir. */
function hookTarget(repo: string, name: string, env: NodeJS.ProcessEnv = cleanGitEnv()): string {
  const path = execFileSync("git", ["rev-parse", "--git-path", `hooks/${name}`], {
    cwd: repo,
    encoding: "utf-8",
    env,
  }).trim();
  return resolve(repo, path);
}

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
 * reaches the CLI's scripts as `cd packages/cli && bun <s>` and CI as
 * `bun run --filter navori <s>`, so both must reduce to `<s>`. A script in any
 * OTHER workspace package keeps its filter, because running it is a genuinely
 * distinct command — collapsing it would let `--filter @navori/website build`
 * hide behind the CLI's own `build` and stay out of the gate unnoticed.
 */
function checkKey(match: RegExpMatchArray): string {
  const filter = match[1];
  const script = match[2] ?? "";
  return !filter || filter === "navori" ? script : `${filter} ${script}`;
}

// bun puts `--filter` AFTER `run` (unlike pnpm, which put it before the
// script and needed no `run` at all): `bun run --filter navori <s>` vs the old
// `pnpm --filter navori <s>`. This repo is bun-only now (detect.ts's pnpm
// support is a SEPARATE concern — navori still detects pnpm in repos it
// scaffolds for), so the pattern targets bun directly instead of staying
// generic over every package manager it could ever see here.
const BUN_INVOCATION = /\bbun\s+(?:run\s+(?:--filter\s+(\S+)\s+)?)?([a-z][\w:.-]*)/g;

/** A job's body, sliced out of the workflow by indentation. */
function jobBody(job: string): string {
  const yaml = readFileSync(CI_WORKFLOW, "utf-8");
  const start = yaml.indexOf(`\n  ${job}:\n`);
  expect(start, `ci.yml no longer declares a \`${job}:\` job`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every check a CI job invokes (the full `quality` one by default), as `checkKey` identities. */
function ciChecks(job = "quality"): Set<string> {
  const runs = [...jobBody(job).matchAll(/^\s*run: (.+)$/gm)].flatMap((m) => m[1] ?? []);
  const checks = new Set<string>();
  for (const run of runs) {
    for (const m of run.matchAll(BUN_INVOCATION)) checks.add(checkKey(m));
  }
  return checks;
}

/** The checks an `&&`-chained gate command actually invokes. */
function gateChecks(command: string): Set<string> {
  const checks = new Set<string>();
  for (const segment of command.split("&&")) {
    for (const m of segment.trim().matchAll(BUN_INVOCATION)) checks.add(checkKey(m));
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
    const fake = gateChecks("bun run format:check && bun run sast:scan");
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
    // gate and CI. One string, two consumers (humans type `bun check`, agents
    // read the gate) — so they must be the same string.
    const rootPkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
    ) as RootPackageJson;
    expect(rootPkg.scripts?.check).toBe(declaredGate);
  });

  it("installs the tracked pre-commit hook and drops the old navori pre-push", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "navori-pre-commit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo, env: cleanGitEnv() });
      const legacy = hookTarget(repo, "pre-push");
      writeFileSync(legacy, "#!/usr/bin/env bash\n# navori pre-push gate\nexec bun check\n");
      execFileSync(process.execPath, [HOOK_INSTALLER], { cwd: repo, env: cleanGitEnv() });
      const target = hookTarget(repo, "pre-commit");

      expect(readFileSync(target, "utf-8")).toBe(readFileSync(PRE_COMMIT_HOOK, "utf-8"));
      expect(statSync(target).mode & 0o111).not.toBe(0);
      expect(existsSync(legacy)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Covers: fix/precommit-git-env — inherited GIT_DIR/GIT_INDEX_FILE must not
  // reach the parent repo (core.bare flipped, real .git/hooks overwritten).
  it("withoutRepoGitEnv drops every repo-local git var and keeps the rest", () => {
    const leaked = Object.fromEntries(REPO_LOCAL_GIT_VARS.map((v) => [v, "/x"]));
    const clean = withoutRepoGitEnv({
      ...leaked,
      GIT_CONFIG_KEY_0: "a",
      GIT_CONFIG_VALUE_0: "b",
      KEEP_ME: "1",
    });
    expect(clean).toEqual({ KEEP_ME: "1" });
  });

  // Covers: fix/precommit-git-env
  it("REPO_LOCAL_GIT_VARS covers everything `git rev-parse --local-env-vars` reports", () => {
    const reported = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf-8",
      env: cleanGitEnv(),
    })
      .split("\n")
      .filter(Boolean);
    expect(REPO_LOCAL_GIT_VARS).toEqual(expect.arrayContaining(reported));
  });

  // Covers: fix/precommit-git-env
  it("a leaked GIT_DIR/GIT_INDEX_FILE cannot make the fixture flow touch the parent repo", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "navori-parent-"));
    const repo = mkdtempSync(resolve(tmpdir(), "navori-pre-commit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: parent, env: cleanGitEnv() });
      const parentGit = resolve(parent, ".git");
      const parentHooks = resolve(parentGit, "hooks");
      const before = readdirSync(parentHooks).sort();
      // Leak into the process env, as a hook run does; the fixture flow must
      // scrub it by itself (this fails if it stops using cleanGitEnv()).
      const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
      process.env.GIT_DIR = parentGit;
      process.env.GIT_INDEX_FILE = resolve(parentGit, "index");
      try {
        initAndInstallHook(repo);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }

      const bare = execFileSync("git", ["config", "core.bare"], {
        cwd: parent,
        encoding: "utf-8",
        env: cleanGitEnv(),
      }).trim();
      expect(bare).toBe("false");
      expect(readdirSync(parentHooks).sort()).toEqual(before);
      expect(existsSync(resolve(parentHooks, "pre-commit"))).toBe(false);
      expect(existsSync(hookTarget(repo, "pre-commit"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a non-navori pre-commit hook and keeps a custom pre-push", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "navori-pre-commit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo, env: cleanGitEnv() });
      const target = hookTarget(repo, "pre-commit");
      writeFileSync(target, "#!/usr/bin/env bash\necho custom\n");

      const result = spawnSync(process.execPath, [HOOK_INSTALLER], {
        cwd: repo,
        encoding: "utf-8",
        env: cleanGitEnv(),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing to overwrite non-navori hook");
      expect(readFileSync(target, "utf-8")).toContain("echo custom");

      rmSync(target);
      const prePush = hookTarget(repo, "pre-push");
      writeFileSync(prePush, "#!/usr/bin/env bash\necho mine\n");
      execFileSync(process.execPath, [HOOK_INSTALLER], { cwd: repo, env: cleanGitEnv() });
      expect(readFileSync(prePush, "utf-8")).toContain("echo mine");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The fast tier: what runs before every commit and on `dev`.
 *
 * Locally the pre-commit runs `check:fast`; CI's `fast` job runs the same set
 * (format, duplication, ast-grep, lint, typecheck) for `dev` and PRs into it. Neither runs tests: those run only
 * on `main` (`quality`). The pass must be a strict subset of
 * `qualityGate.full`, or `dev` would block on a check `main` never runs.
 */
describe("pre-commit and CI's dev tier run no tests", () => {
  const rootPkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
  ) as RootPackageJson;
  const fast = gateChecks(rootPkg.scripts?.["check:fast"] ?? "");
  const full = gateChecks(readConfig(CONFIG_PATH).qualityGate?.full ?? "");

  it("check:fast runs the scans, lint, format and typecheck (anti-false-green)", () => {
    expect([...fast].sort()).toEqual(
      ["check:ast", "check:dup", "format:check", "lint", "typecheck"].sort(),
    );
  });

  it("every check:fast step is also part of qualityGate.full", () => {
    expect([...fast].filter((c) => !full.has(c))).toEqual([]);
  });

  it("the versioned pre-commit runs check:fast and no tests", () => {
    const hook = readFileSync(PRE_COMMIT_HOOK, "utf-8");
    expect(hook).toContain("bun run check:fast");
    expect(hook).not.toMatch(/test:coverage|bun test|bun run test/);
    expect(hook).toContain("NAVORI_PRE_COMMIT_RUNNING");
  });

  it("CI's fast job runs only the check:fast set, no tests", () => {
    const checks = [...ciChecks("fast")].filter((c) => c !== "install");
    expect(checks.sort()).toEqual(["check:ast", "check:dup", "format:check", "lint", "typecheck"]);
    expect(jobBody("fast")).not.toMatch(/\btest\b/);
  });

  it("the quality job still runs the tests with coverage", () => {
    expect([...ciChecks("quality")]).toContain("test:coverage");
  });

  it("main runs the full job and everything else the fast one", () => {
    expect(jobBody("quality")).toContain("github.base_ref == 'main'");
    expect(jobBody("fast")).toContain("github.base_ref != 'main'");
  });

  it("the semgrep job is main-only, digest-pinned and blocks only on new findings", () => {
    const semgrep = jobBody("semgrep");
    expect(semgrep).toContain("github.ref == 'refs/heads/main' || github.base_ref == 'main'");
    expect(semgrep).toMatch(/image: semgrep\/semgrep:[\w.]+@sha256:[0-9a-f]{64}/);
    expect(semgrep).toContain("--error");
    expect(semgrep).toContain("--baseline-commit");
    expect(semgrep, "a scan that cannot run must fail the job").not.toContain("|| true");
  });
});

/**
 * The scans run BEFORE the approval, not after it (#777).
 *
 * The reviewer's Pass 2 runs exactly `qualityGate.full`, and the pilot trusts
 * that evidence instead of re-running it. A scan that lives outside the gate
 * first shows the diff to a tool AFTER `APPROVED` — rework past the point where
 * catching it was cheap. Duplication (jscpd) and the structural rules (ast-grep)
 * are lockfile devDependencies invoked by root scripts, so a missing tool is a
 * red step, never a skipped one.
 */
describe("the gate runs the scans before the approval (#777)", () => {
  const config = readConfig(CONFIG_PATH);
  const gate = gateChecks(config.qualityGate?.full ?? "");
  const fast = gateChecks(
    (JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as RootPackageJson)
      .scripts?.["check:fast"] ?? "",
  );
  const rootPkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
  ) as RootPackageJson;
  const scans = [
    ["check:dup", "jscpd"],
    ["check:ast", "ast-grep"],
  ] as const;

  it.each(scans)("%s is in qualityGate.full and check:fast", (name) => {
    expect([...gate], `\`bun run ${name}\` is missing from qualityGate.full`).toContain(name);
    expect([...fast], `\`bun run ${name}\` is missing from check:fast`).toContain(name);
  });

  it.each(scans)("%s invokes its pinned binary (%s)", (name, binary) => {
    expect(rootPkg.scripts?.[name] ?? "").toContain(binary);
  });

  it("the plugin scan scripts are gone from the root scripts", () => {
    expect(Object.keys(rootPkg.scripts ?? {})).not.toContain("jscpd:check");
    expect(Object.keys(rootPkg.scripts ?? {})).not.toContain("semgrep:check");
  });
});

/**
 * Guard for the committed duplication baseline and the exact tool pins (R3).
 * The baseline stores content fingerprints, so regenerating it can silently
 * absorb a new clone; growing it must take two visible edits (the JSON and the
 * constant below, with a reason).
 */
// Ceiling = the clone count when the baseline was introduced; lower it whenever a
// baselined clone is removed, raise it only with a justification in the PR.
const DUP_BASELINE_CEILING = 22;

describe("the duplication baseline and tool pins stay strict (R3)", () => {
  const jscpdConfig = JSON.parse(readFileSync(resolve(REPO_ROOT, ".jscpd.json"), "utf-8")) as {
    baseline?: string;
    failOnNewClones?: number;
    failOnEmpty?: boolean;
  };
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as {
    devDependencies?: Record<string, string>;
  };

  it("the baseline holds at most DUP_BASELINE_CEILING fingerprints and is not vacuous", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, jscpdConfig.baseline ?? ".jscpd-baseline.json"), "utf-8"),
    ) as { fingerprints?: Record<string, number> };
    // Each fingerprint maps to how many clones share it: the sum is the clone count.
    const count = Object.values(baseline.fingerprints ?? {}).reduce((n, c) => n + c, 0);
    expect(count).toBeGreaterThan(0);
    expect(
      count,
      "baseline grew: dedupe the new clone instead of regenerating",
    ).toBeLessThanOrEqual(DUP_BASELINE_CEILING);
  });

  it("jscpd blocks any new clone and refuses to scan nothing", () => {
    expect(jscpdConfig.failOnNewClones).toBe(0);
    expect(jscpdConfig.failOnEmpty).toBe(true);
  });

  it("jscpd and @ast-grep/cli are pinned exactly (a bump regenerates the baseline)", () => {
    expect(pkg.devDependencies?.jscpd).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies?.["@ast-grep/cli"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * Every action in every workflow is pinned to a full commit SHA (supply chain):
 * a mutable tag can be re-pointed. The tag survives as a trailing comment.
 */
describe("workflow actions are pinned to commit SHAs", () => {
  const dir = resolve(REPO_ROOT, ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it("finds the workflows it polices (anti-false-green)", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("%s: every `uses:` is owner/repo@<40-hex sha>", (file) => {
    const uses = [
      ...readFileSync(resolve(dir, file), "utf-8").matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm),
    ].map((m) => m[1] ?? "");
    const loose = uses.filter((u) => !u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u));
    expect(loose, "pin these to a commit SHA, keeping the tag as a trailing comment").toEqual([]);
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

describe("this repo's models/effort tiers (spec 0027-scribe-agent T1)", () => {
  // Covers: R3
  it("sets orchestrator to opus/medium", () => {
    const config = readConfig(CONFIG_PATH);
    expect(config.models?.orchestrator).toBe("opus");
    expect(config.effort?.orchestrator).toBe("medium");
  });

  // Spec 0032 (#1011), R29/R34: the architect renders unconditionally now, so
  // this repo relies on core's default (opus/xhigh, `recommended.ts`) instead
  // of overriding it — an explicit `models.architect`/`effort.architect` here
  // would just repeat the default.
  it("leaves models.architect and effort.architect unset — core's opus/xhigh default applies", () => {
    const config = readConfig(CONFIG_PATH);
    expect(config.models?.architect).toBeUndefined();
    expect(config.effort?.architect).toBeUndefined();
  });
});
