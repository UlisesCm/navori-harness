import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnHelp } from "./script-help.mjs";
import { isMain } from "./is-main.mjs";

/**
 * Spec 0062 T10: `bun run test:assets`, the TS tests that stay after the cutover because they read
 * what ships as content (the `packages/core/core-assets` hooks, skills, agents and managed blocks,
 * the plugin assets, the docs and the website copy), the shell bodies of the shipped hooks, and
 * the repo tooling that stays live (scripts/js and the workflows), not the frozen TS commands,
 * engines and libraries. The list is
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
  // The shell bodies of the shipped hooks: they still decide in Codex, for the permanent shell
  // hooks, on platforms without a binary and when the native runtime falls through (R83).
  "src/__tests__/hook-audit-instrumentation.test.ts",
  "src/__tests__/hook-context-noise.test.ts",
  "src/__tests__/hook-matcher-wiring.test.ts",
  "src/__tests__/hook-output-contract.test.ts",
  "src/__tests__/quality-gate-native.test.ts",
  "src/__tests__/session-start-hook.test.ts",
  "src/lib/__tests__/audit-log-owner.test.ts",
  "src/lib/__tests__/codex-hook-payloads.test.ts",
  "src/lib/__tests__/comment-draft-confirm.test.ts",
  "src/lib/__tests__/gate-exit-contract.test.ts",
  "src/lib/__tests__/gate-hook-kill.test.ts",
  "src/lib/__tests__/general-purpose-confirm.test.ts",
  "src/lib/__tests__/guard-destructive-progress.test.ts",
  "src/lib/__tests__/guard-destructive.test.ts",
  "src/lib/__tests__/guard-search-routing.test.ts",
  "src/lib/__tests__/hook-claims-vs-scripts.test.ts",
  "src/lib/__tests__/managed-drift-watch.test.ts",
  "src/lib/__tests__/pr-publisher-confirm.test.ts",
  "src/lib/__tests__/quality-gate-foreign.test.ts",
  "src/lib/__tests__/quality-gate-hook.test.ts",
  "src/lib/__tests__/quality-gate-worktree-resolve.test.ts",
  "src/lib/__tests__/role-guard.test.ts",
  "src/lib/__tests__/routing-watch.test.ts",
  "src/lib/__tests__/session-start-hook.test.ts",
  "src/lib/__tests__/subagent-stop-handoff.test.ts",
  // Hooks whose shell body is their only runtime (not in crates/ported.json), the shell cases of
  // plan-gate and model-advisor, the evidence capture of routing-watch/bash-outcome-watch and the
  // shipped `_partials`.
  "src/engines/claude/__tests__/master-accept-confirm.test.ts",
  "src/engines/claude/__tests__/master-plan-context.test.ts",
  "src/engines/claude/__tests__/model-advisor.test.ts",
  "src/lib/__tests__/engram-write-guard.test.ts",
  "src/lib/__tests__/expected-capture.test.ts",
  "src/lib/plan/__tests__/plan-gate.test.ts",
  "src/lib/render/__tests__/hook-includes.test.ts",
  // Shipped content read as such: docs, the website copy, agent and asset contracts.
  "src/__tests__/doctrine-contracts.test.ts",
  "src/__tests__/primary-document-locales.test.ts",
  "src/__tests__/website-i18n.test.ts",
  "src/engines/shared/__tests__/retired-plugin-assets.test.ts",
  "src/lib/__tests__/agent-descriptions.test.ts",
  "src/lib/__tests__/agents-assets.test.ts",
  "src/lib/__tests__/branch-base-assets.test.ts",
  "src/lib/__tests__/handoff-wiring.test.ts",
  "src/lib/__tests__/publisher-contract.test.ts",
  // The repo tooling that stays live after the cutover: scripts/js, the workflows and the gates
  // (release, check-pin, cutover:check, manifest, hooks sync, replay and fuzz).
  "src/__tests__/activation-verify.test.ts",
  "src/__tests__/bench-scripts.test.ts",
  "src/__tests__/blame-ignore-check.test.ts",
  "src/__tests__/ci-workflow.test.ts",
  "src/__tests__/cutover-check.test.ts",
  "src/__tests__/deps-sync-check.test.ts",
  "src/__tests__/dist-e2e.test.ts",
  "src/__tests__/dist-launcher.test.ts",
  "src/__tests__/dist-probe.test.ts",
  "src/__tests__/ensure-dist.test.ts",
  "src/__tests__/hook-fuzz.test.ts",
  "src/__tests__/hook-shadow-report.test.ts",
  "src/__tests__/hooks-zsh-parity.test.ts",
  "src/__tests__/pre-commit-probe.test.ts",
  "src/__tests__/render-drift-check.test.ts",
  "src/__tests__/repo-config-gate.test.ts",
  "src/__tests__/repo-gate-config.test.ts",
  "src/__tests__/rust-areas.test.ts",
  "src/__tests__/rust-hooks-sync.test.ts",
  "src/__tests__/rust-manifest-check.test.ts",
  "src/__tests__/rust-oracle.test.ts",
  "src/__tests__/rust-sync-age.test.ts",
  "src/__tests__/rust-tarball.test.ts",
  "src/__tests__/scripts-help.test.ts",
  "src/__tests__/toolchain-pins.test.ts",
  "src/lib/diagnose/__tests__/source-classify.test.ts",
];

/**
 * Suites that seed files inside the real `packages/core/core-assets` roots (on purpose: they test
 * the production sweep). They run after ASSET_SUITES, alone, so no suite scanning those roots in
 * parallel reads a half-seeded fixture.
 */
export const SERIAL_ASSET_SUITES = ["src/lib/assets/__tests__/retired-names.test.ts"];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const USAGE =
  "usage: node scripts/js/asset-suites.mjs\n  Runs the asset and docs test suites of packages/cli with vitest (no coverage).\n  -h, --help  print this text and exit";

if (isMain(import.meta.url)) {
  exitOnHelp(process.argv.slice(2), USAGE);
  const cwd = join(REPO_ROOT, "packages", "cli");
  const run = (suites) => spawnSync("bun", ["run", "vitest", "run", ...suites], { cwd, stdio: "inherit" }).status ?? 1;
  const parallel = run(ASSET_SUITES);
  const serial = run(SERIAL_ASSET_SUITES);
  process.exitCode = parallel !== 0 ? parallel : serial;
}
