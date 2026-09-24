import { describe, expect, it } from "vitest";
import { classify } from "../classify.ts";

/**
 * T0 — calibration fixtures (#1011).
 *
 * Each fixture is a real commit's touched-file list, extracted read-only with
 * `git show --name-only --format= <sha>` (never re-run at test time — the
 * lists are embedded, per the encargo). The expected level was agreed with
 * the user BEFORE these weights were written; a fixture that fails here means
 * the weights are wrong for that case, not that the fixture's expectation
 * should be adjusted.
 *
 * Covers: R2, R3, R4, R5
 */
describe("classify — T0 calibration fixtures", () => {
  it("navori-harness 4a2fc71c -> level 0 (blame-ignore file only, no source)", () => {
    const result = classify({ files: [".git-blame-ignore-revs"] });
    expect(result.level).toBe(0);
  });

  it("navori-harness 3dc5de1e -> level 1 (3 non-trivial files, 1 root dir)", () => {
    const result = classify({
      files: [
        "packages/cli/src/commands/__tests__/pinned-version-doctor.test.ts",
        "packages/cli/src/commands/doctor.ts",
        "packages/cli/src/lib/__tests__/plugins.test.ts",
        "packages/cli/src/lib/i18n.ts",
        "packages/cli/src/lib/plugins.ts",
        "packages/plugins/codegraph/plugin.json",
      ],
    });
    expect(result.level).toBe(1);
  });

  it("navori-harness 853ad0a1 -> level 1 (5 non-trivial files)", () => {
    const result = classify({
      files: [
        "docs/EXTENDING.md",
        "packages/cli/src/commands/__tests__/add.test.ts",
        "packages/cli/src/commands/__tests__/external-tools.test.ts",
        "packages/cli/src/commands/add.ts",
        "packages/cli/src/commands/doctor.ts",
        "packages/cli/src/lib/__tests__/plugins.test.ts",
        "packages/cli/src/lib/i18n.ts",
        "packages/cli/src/lib/platform.ts",
        "packages/cli/src/lib/plugins.ts",
        "packages/plugins/acli/plugin.json",
        "packages/plugins/codegraph/plugin.json",
        "packages/plugins/engram/plugin.json",
        "packages/plugins/gh/plugin.json",
        "packages/plugins/jscpd/plugin.json",
        "packages/plugins/semgrep/plugin.json",
        "packages/plugins/tgrep/plugin.json",
      ],
    });
    expect(result.level).toBe(1);
  });

  it("navori-harness a717d440 -> level 1 (critical area declared, score stays below 8)", () => {
    const result = classify({
      criticalArea: true,
      files: [
        ".agents/skills/review-diff/SKILL.md",
        ".agents/skills/verify-before-done/SKILL.md",
        ".claude/agents/implementer.md",
        ".claude/agents/orchestrator.md",
        ".claude/agents/publisher.md",
        ".claude/agents/reviewer.md",
        ".claude/context/10-orquestacion.md",
        ".claude/context/40-cierre-sesion.md",
        ".claude/settings.json",
        ".claude/skills/review-diff/SKILL.md",
        ".claude/skills/verify-before-done/SKILL.md",
        ".codex/agents/implementer.toml",
        ".codex/agents/publisher.toml",
        ".codex/agents/reviewer.toml",
        ".git-blame-ignore-revs",
        ".github/workflows/ci.yml",
        "AGENTS.md",
        "CONTRIBUTING.md",
        "navori.config.json",
        "package.json",
        "packages/cli/src/__tests__/blame-ignore-check.test.ts",
        "packages/cli/src/engines/__tests__/__golden__/claude.snap",
        "packages/cli/src/engines/__tests__/__golden__/codex.snap",
        "packages/core/core-assets/agents/implementer.md",
        "packages/core/core-assets/agents/publisher.md",
        "scripts/js/check-blame-ignore.mjs",
      ],
    });
    expect(result.level).toBe(1);
  });

  it("navori-harness 12f0c83e -> level 1 (critical area declared, 7 non-trivial files)", () => {
    const result = classify({
      criticalArea: true,
      files: [
        "apps/website/src/content/commands.ts",
        "apps/website/src/pages/en/quickstart.astro",
        "apps/website/src/pages/quickstart.astro",
        "packages/cli/src/commands/__tests__/add.test.ts",
        "packages/cli/src/commands/add.ts",
        "packages/cli/src/commands/init.ts",
        "packages/cli/src/commands/render.ts",
        "packages/cli/src/lib/i18n.ts",
      ],
    });
    expect(result.level).toBe(1);
  });

  it("navori-harness aff0ccb8 -> level 2 (critical area declared pushes score to 8)", () => {
    const result = classify({
      criticalArea: true,
      files: [
        ".claude/hooks/subagent-no-background.sh",
        ".claude/settings.json",
        ".codex/hooks/subagent-no-background.sh",
        "apps/website/src/consts.ts",
        "packages/cli/src/engines/__tests__/__golden__/claude.snap",
        "packages/cli/src/engines/__tests__/__golden__/codex.snap",
        "packages/cli/src/engines/claude/__tests__/preset-extras.test.ts",
        "packages/cli/src/engines/claude/__tests__/render-engine.test.ts",
        "packages/cli/src/engines/claude/build-settings.ts",
        "packages/cli/src/engines/shared/harness-plan.ts",
        "packages/cli/src/lib/__tests__/subagent-no-background.test.ts",
        "packages/core/core-assets/hooks/subagent-no-background.sh",
      ],
    });
    expect(result.level).toBe(2);
  });

  it("navori-harness ba6322c1 -> level 2 (critical area declared, large surface)", () => {
    // Non-source files that fall outside `source-classify`'s SOURCE_EXT/HARNESS_PROSE
    // (docs, snapshots, .git-blame-ignore-revs) are still listed here as "Archivos",
    // consistent with how the other fixtures embed the full touched-path list.
    const result = classify({
      criticalArea: true,
      files: [
        ".claude/hooks/audit-mode-trigger.sh",
        ".claude/hooks/comment-draft-confirm.sh",
        ".claude/hooks/guard-destructive.sh",
        ".claude/hooks/implementer-no-markdown.sh",
        ".claude/hooks/managed-drift-watch.sh",
        ".claude/hooks/model-advisor.sh",
        ".claude/hooks/pr-publisher-confirm.sh",
        ".claude/hooks/quality-gate-pre-commit.sh",
        ".claude/hooks/routing-watch.sh",
        ".claude/hooks/session-start-context.sh",
        ".claude/hooks/subagent-stop-handoff.sh",
        ".claude/hooks/worktree-reclaim.sh",
        ".claude/scripts/check-jscpd.sh",
        ".claude/scripts/check-semgrep.sh",
        ".codex/hooks/audit-mode-trigger.sh",
        ".codex/hooks/comment-draft-confirm.sh",
        ".codex/hooks/guard-destructive.sh",
        ".codex/hooks/implementer-no-markdown.sh",
        ".codex/hooks/managed-drift-watch.sh",
        ".codex/hooks/model-advisor.sh",
        ".codex/hooks/pr-publisher-confirm.sh",
        ".codex/hooks/quality-gate-pre-commit.sh",
        ".codex/hooks/routing-watch.sh",
        ".codex/hooks/session-start-context.sh",
        ".codex/hooks/subagent-stop-handoff.sh",
        ".codex/hooks/worktree-reclaim.sh",
        ".git-blame-ignore-revs",
        "docs/architecture.md",
        "packages/cli/scripts/check-coverage-floor.mjs",
        "packages/cli/scripts/gen-schemas.mjs",
        "packages/cli/src/commands/add.ts",
        "packages/cli/src/commands/adopt.ts",
        "packages/cli/src/commands/audit.ts",
        "packages/cli/src/commands/backup.ts",
        "packages/cli/src/commands/bench.ts",
        "packages/cli/src/commands/configure.ts",
        "packages/cli/src/commands/doctor.ts",
        "packages/cli/src/commands/dominio.ts",
        "packages/cli/src/commands/global-prompts.ts",
        "packages/cli/src/commands/global.ts",
        "packages/cli/src/commands/init-format.ts",
        "packages/cli/src/commands/init.ts",
        "packages/cli/src/commands/migrations.ts",
        "packages/cli/src/commands/preset.ts",
        "packages/cli/src/commands/receipt.ts",
        "packages/cli/src/commands/registry.ts",
        "packages/cli/src/commands/remove.ts",
        "packages/cli/src/commands/render.ts",
        "packages/cli/src/commands/scan.ts",
        "packages/cli/src/commands/status.ts",
        "packages/cli/src/commands/sync.ts",
        "packages/cli/src/commands/ticket.ts",
        "packages/cli/src/commands/update.ts",
        "packages/cli/src/commands/workspace.ts",
        "packages/cli/src/engines/agents-md/index.ts",
        "packages/cli/src/engines/claude/agent-mcp-tools.ts",
        "packages/cli/src/engines/claude/build-settings.ts",
        "packages/cli/src/engines/claude/coexist-settings.ts",
        "packages/cli/src/engines/claude/frontmatter-merge.ts",
        "packages/cli/src/engines/claude/global-plugin.ts",
        "packages/cli/src/engines/claude/global-render.ts",
        "packages/cli/src/engines/claude/index.ts",
        "packages/cli/src/engines/claude/parse-asset.ts",
        "packages/cli/src/engines/claude/prompts-loader.ts",
        "packages/cli/src/engines/codex/build-config-toml.ts",
        "packages/cli/src/engines/codex/compat.ts",
        "packages/cli/src/engines/codex/index.ts",
        "packages/cli/src/engines/copilot/index.ts",
        "packages/cli/src/engines/cursor/index.ts",
        "packages/cli/src/engines/shared/engine-capabilities.ts",
        "packages/cli/src/engines/shared/execute-plan.ts",
        "packages/cli/src/engines/shared/gitignore-harness.ts",
        "packages/cli/src/engines/shared/harness-assets.ts",
        "packages/cli/src/engines/shared/harness-plan.ts",
        "packages/cli/src/engines/shared/prettierignore-harness.ts",
        "packages/cli/src/engines/shared/prose-harness.ts",
        "packages/cli/src/engines/shared/render-managed-file.ts",
        "packages/cli/src/engines/shared/roster.ts",
        "packages/cli/src/engines/shared/skills-index.ts",
        "packages/cli/src/index.ts",
        "packages/cli/src/lib/assets/flat-skills.ts",
        "packages/cli/src/lib/assets/legacy-agents.ts",
        "packages/cli/src/lib/assets/model-profile.ts",
        "packages/cli/src/lib/assets/retired-names.ts",
        "packages/cli/src/lib/assets/skill-meta.ts",
        "packages/cli/src/lib/audit/collect.ts",
        "packages/cli/src/lib/audit/launchd.ts",
        "packages/cli/src/lib/audit/paths.ts",
        "packages/cli/src/lib/audit/signals.ts",
        "packages/cli/src/lib/config/cli-config.ts",
        "packages/cli/src/lib/config/config.ts",
        "packages/cli/src/lib/config/external-providers.ts",
        "packages/cli/src/lib/config/gate-readiness.ts",
        "packages/cli/src/lib/config/global-config.ts",
        "packages/cli/src/lib/config/platform.ts",
        "packages/cli/src/lib/config/plugins.ts",
        "packages/cli/src/lib/config/presets.ts",
        "packages/cli/src/lib/config/recommended.ts",
        "packages/cli/src/lib/config/schema-url.ts",
        "packages/cli/src/lib/config/schema.ts",
        "packages/cli/src/lib/diagnose/detect.ts",
        "packages/cli/src/lib/diagnose/disk-usage.ts",
        "packages/cli/src/lib/diagnose/distribution.ts",
        "packages/cli/src/lib/diagnose/foreign-harness.ts",
        "packages/cli/src/lib/diagnose/health.ts",
        "packages/cli/src/lib/diagnose/migrate.ts",
        "packages/cli/src/lib/diagnose/stale-harness.ts",
        "packages/cli/src/lib/i18n.ts",
        "packages/cli/src/lib/primitives/args.ts",
        "packages/cli/src/lib/primitives/atomic.ts",
        "packages/cli/src/lib/primitives/bench.ts",
        "packages/cli/src/lib/primitives/diff.ts",
        "packages/cli/src/lib/primitives/errors.ts",
        "packages/cli/src/lib/primitives/git.ts",
        "packages/cli/src/lib/primitives/home.ts",
        "packages/cli/src/lib/primitives/json-ownership.ts",
        "packages/cli/src/lib/primitives/lockfile.ts",
        "packages/cli/src/lib/primitives/log.ts",
        "packages/cli/src/lib/primitives/semver.ts",
        "packages/cli/src/lib/primitives/shell-escape.ts",
        "packages/cli/src/lib/primitives/style.ts",
        "packages/cli/src/lib/primitives/which.ts",
        "packages/cli/src/lib/primitives/zod-helpers.ts",
        "packages/cli/src/lib/render/backup.ts",
        "packages/cli/src/lib/render/bundled-assets.ts",
        "packages/cli/src/lib/render/frontmatter.ts",
        "packages/cli/src/lib/render/hook-includes.ts",
        "packages/cli/src/lib/render/interpolate.ts",
        "packages/cli/src/lib/render/interpolation-artifacts.ts",
        "packages/cli/src/lib/render/marker.ts",
        "packages/cli/src/lib/render/placeholders.ts",
        "packages/cli/src/lib/render/removable.ts",
        "packages/cli/src/lib/render/render-plan.ts",
        "packages/cli/src/lib/workspace/dominio.ts",
        "packages/cli/src/lib/workspace/global-scope.ts",
        "packages/cli/src/lib/workspace/monorepo.ts",
        "packages/cli/src/lib/workspace/registry.ts",
        "packages/cli/src/lib/workspace/tickets.ts",
        "packages/cli/src/lib/workspace/workspace-drift.ts",
        "packages/cli/src/lib/workspace/workspace.ts",
        "packages/core/core-assets/hooks/managed-drift-watch.sh",
      ],
    });
    expect(result.level).toBe(2);
  });

  it("bonum-webapp 68a0c109 -> level 0 (single test file)", () => {
    const result = classify({
      files: ["amplify.yml", "src/utilities/__tests__/amplifySecurityHeaders.test.ts"],
    });
    expect(result.level).toBe(0);
  });

  it("bonum-webapp 8dfdec4b -> level 1 (4 non-trivial files, 1 root dir)", () => {
    const result = classify({
      files: [
        "src/pages/Onboarding/Onboarding.tsx",
        "src/pages/Onboarding/components/ChooseCoach/ChooseCoach.jsx",
        "src/pages/Onboarding/components/ChooseCoach/utilities/coachMatchingError.utility.ts",
        "src/pages/Onboarding/components/Steps/Steps.tsx",
        "src/translations/es.json",
      ],
    });
    expect(result.level).toBe(1);
  });

  it("bonum-webapp 11765070 -> level 1 (7 non-trivial files, 4 root dirs)", () => {
    const result = classify({
      files: [
        "src/App.tsx",
        "src/assets/img/balance.svg",
        "src/constants/auth.constants.ts",
        "src/pages/Home/Components/BalanceSurveyModal/BalanceSurveyModal.jsx",
        "src/pages/Home/Components/BalanceSurveyModal/index.js",
        "src/pages/Home/Home.jsx",
        "src/utilities/balanceSurveyModal.utility.ts",
        "src/utilities/logout.utility.ts",
      ],
    });
    expect(result.level).toBe(1);
  });

  it("bonum-nexus 488fc34 -> level 2 (floor: credentials + two repos declared)", () => {
    const result = classify({
      moneyCredentialsPii: true,
      multiRepo: true,
      files: [
        "apps/api/src/modules/orchestrators/user-password/user-password.orchestrator.ts",
        "domains/user-domain/src/lib/dto/update-user.dto.ts",
        "domains/user-domain/src/lib/dto/user-response.dto.ts",
        "domains/user-domain/src/lib/schemas/user.schema.ts",
        "domains/user-domain/src/lib/services/users.service.ts",
        "packages/types/src/lib/schemas/entities.schemas.ts",
      ],
    });
    expect(result.level).toBe(2);
  });

  it("services--sessions ac16321 -> level 2 (floor: shared contract declared)", () => {
    const result = classify({
      sharedContract: true,
      files: [
        "src/domain/models/AlignmentFinalReport.ts",
        "src/domain/models/AlignmentInitialReport.ts",
        "src/infrastructure/middlewares/authorize.ts",
        "src/presentation/controllers/AlignmentFinalReportController.ts",
        "src/presentation/controllers/AlignmentInitialReportController.ts",
        "src/presentation/controllers/AlignmentReportController.ts",
        "src/presentation/routes/alignmentFinalReportRoutes.ts",
        "src/presentation/routes/alignmentInitialReportRoutes.ts",
        "src/presentation/routes/index.ts",
        "test/unit/alignmentReport.test.ts",
      ],
    });
    expect(result.level).toBe(2);
  });

  it("bonum-nexus 5aa63f4 -> level 2 (floor: credentials declared)", () => {
    const result = classify({
      moneyCredentialsPii: true,
      files: [
        "packages/auth-server/src/lib/auth-server.module.ts",
        "packages/auth-server/src/lib/config/service-keys.provider.ts",
        "packages/auth-server/src/lib/guards/auth.guard.ts",
      ],
    });
    expect(result.level).toBe(2);
  });

  /**
   * navori-harness `dc5d73b0` ("agrega skills project-local rebase-rerender y
   * worktree-hygiene", #1001) touches:
   *   .claude/skills/rebase-rerender/SKILL.md
   *   .claude/skills/worktree-hygiene/SKILL.md
   *   CLAUDE.md
   *   navori.config.json
   *   packages/cli/src/__tests__/asset-command-permissions.test.ts
   *
   * Was a KNOWN MISMATCH (#1011, T0, `it.todo`): `classifyPath` treated every
   * path under `.claude/` as "generated" — correct for the rendered mirror of
   * a core/plugin asset, wrong for a project-local skill, which has no
   * `core-assets` source to render from (`.claude/skills/<id>/SKILL.md` IS the
   * source). Fixed in #1011 by passing `localSkillIds` through to
   * `countNonTrivial`, so both SKILL.md files now count as source and the
   * ceiling (3) clears `LEVEL_ZERO_MAX_SCORE`.
   *
   * Covers: R4
   */
  it("navori-harness dc5d73b0 -> level 1 (two project-local SKILL.md count as source)", () => {
    const result = classify({
      localSkillIds: ["rebase-rerender", "worktree-hygiene"],
      files: [
        ".claude/skills/rebase-rerender/SKILL.md",
        ".claude/skills/worktree-hygiene/SKILL.md",
        "CLAUDE.md",
        "navori.config.json",
        "packages/cli/src/__tests__/asset-command-permissions.test.ts",
      ],
    });
    expect(result.level).toBe(1);
  });
});

describe("classify — unit behavior", () => {
  // Covers: R9
  it("matches project.criticalPaths globs without requiring the declared flag (R9)", () => {
    const result = classify({
      files: ["src/payments/checkout.ts", "src/payments/gateway.ts"],
      criticalPaths: ["src/payments/**"],
    });
    expect(result.signals).toContain("critical-area:matched(+3)");
    // Critical area alone is additive (not a floor, #1011): 2 non-trivial
    // files (+2) plus critical area (+3) clears LEVEL_ZERO_MAX_SCORE (3).
    expect(result.level).toBeGreaterThanOrEqual(1);
  });

  it("keeps the declared critical-area flag as a fallback when no glob is configured", () => {
    const result = classify({ files: ["src/foo.ts"], criticalArea: true });
    expect(result.signals).toContain("critical-area:declared(+3)");
  });

  it("truncates the score to MAX_SCORE (10)", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/module-${i}/file.ts`);
    const result = classify({ files, dataSchemaMigration: true });
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("a floor forces level 2 even with a trivial file set", () => {
    const result = classify({ files: ["src/index.ts"], dataSchemaMigration: true });
    expect(result.level).toBe(2);
  });
});
