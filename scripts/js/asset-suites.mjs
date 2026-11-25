import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnHelp } from "./script-help.mjs";

/**
 * Spec 0062 T10: `bun run test:assets`, the TS tests that stay after the cutover because they read
 * what ships as content (the `packages/core/core-assets` hooks, skills, agents and managed blocks,
 * the plugin assets, the docs and the website copy), not the frozen TS commands. The list is
 * explicit on purpose: a glob would bring the whole TS suite back. Each entry imports from the
 * source tree only the asset readers (`bundled-assets`, `hook-includes`, `harness-assets`, the
 * roster and the skill parsers). Paths are relative to `packages/cli`. The artifact suites run in
 * `check:post-cutover` (`ARTIFACT_SUITES`) and are not repeated here.
 */
export const ASSET_SUITES = [
  "src/__tests__/asset-command-permissions.test.ts",
  "src/__tests__/asset-commands-check.test.ts",
  "src/__tests__/audit-gating.test.ts",
  "src/__tests__/audit-hooks.test.ts",
  "src/__tests__/catalog.test.ts",
  "src/__tests__/command-docs-inventory.test.ts",
  "src/__tests__/direction-claude-first.test.ts",
  "src/__tests__/doc-budgets-check.test.ts",
  "src/__tests__/hook-payload-fields.test.ts",
  "src/__tests__/hook-verdict-replay.test.ts",
  "src/__tests__/landing-inventory.test.ts",
  "src/__tests__/payload-cache.test.ts",
  "src/__tests__/session-hooks-corpus.test.ts",
  "src/commands/__tests__/render-provenance.test.ts",
  "src/commands/__tests__/render-prune-orphans.test.ts",
  "src/engines/shared/__tests__/scoped-gate.test.ts",
  "src/engines/shared/__tests__/skill-security-quality.test.ts",
  "src/lib/__tests__/always-on-delta-wiring.test.ts",
  "src/lib/__tests__/analysis-cascade-wiring.test.ts",
  "src/lib/__tests__/bash-outcome-watch.test.ts",
  "src/lib/__tests__/bundled-assets-freshness.test.ts",
  "src/lib/__tests__/claude-md-read-mandate.test.ts",
  "src/lib/__tests__/closeout-asset.test.ts",
  "src/lib/__tests__/commit-pr-pilot-contract.test.ts",
  "src/lib/__tests__/copy-dest.test.ts",
  "src/lib/__tests__/core-lean.test.ts",
  "src/lib/__tests__/core-package-contract.test.ts",
  "src/lib/__tests__/core-templates.test.ts",
  "src/lib/__tests__/direction-doc.test.ts",
  "src/lib/__tests__/failure-attribution.test.ts",
  "src/lib/__tests__/follow-up-prs-wiring.test.ts",
  "src/lib/__tests__/guard-destructive-timeout.test.ts",
  "src/lib/__tests__/handoff-namespaces.test.ts",
  "src/lib/__tests__/hook-runtime-english.test.ts",
  "src/lib/__tests__/implementer-no-markdown.test.ts",
  "src/lib/__tests__/intake-close-wiring.test.ts",
  "src/lib/__tests__/lifecycle-hooks.test.ts",
  "src/lib/__tests__/memory-ceremony-wiring.test.ts",
  "src/lib/__tests__/no-voseo.test.ts",
  "src/lib/__tests__/pii-egress-guard.test.ts",
  "src/lib/__tests__/r1-lean-close-wiring.test.ts",
  "src/lib/__tests__/receipt-wiring.test.ts",
  "src/lib/__tests__/review-checklist-invariants.test.ts",
  "src/lib/__tests__/search-v2-policy.test.ts",
  "src/lib/__tests__/skills-assets.test.ts",
  "src/lib/__tests__/solutioning-wiring.test.ts",
  "src/lib/__tests__/subagent-no-background.test.ts",
  "src/lib/__tests__/verify-before-done-asset.test.ts",
  "src/lib/__tests__/worktree-reclaim.test.ts",
  "src/lib/assets/__tests__/library-skills.test.ts",
  "src/lib/assets/__tests__/skill-caps.test.ts",
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const USAGE =
  "usage: node scripts/js/asset-suites.mjs\n  Runs the asset and docs test suites of packages/cli with vitest (no coverage).\n  -h, --help  print this text and exit";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exitOnHelp(process.argv.slice(2), USAGE);
  const run = spawnSync("bun", ["run", "vitest", "run", ...ASSET_SUITES], {
    cwd: join(REPO_ROOT, "packages", "cli"),
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
}
