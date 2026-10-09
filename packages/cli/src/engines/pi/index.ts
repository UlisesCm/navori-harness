import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { conditionOrchestration } from "../../lib/render/render-plan.ts";
import { join, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config/config.ts";
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import { loadPreset } from "../../lib/config/presets.ts";
import { resolveLang } from "../../lib/i18n.ts";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import {
  collectPlan,
  commitWrites,
  type AdapterCtx,
  type EngineAdapter,
  type PendingWrite,
  type SkippedFile,
} from "../shared/execute-plan.ts";
import type { ProseEngineResult } from "../shared/prose-harness.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { resolveCodexModel } from "../../lib/assets/model-profile.ts";
import { interpolate } from "../../lib/render/interpolate.ts";
import {
  ownsPiAgent,
  ownsPiManifest,
  ownsPiSource,
  serializePiAgent,
  serializePiManifest,
  serializePiSource,
} from "./owned-file.ts";
import { PI_EXTENSION_SOURCE } from "./extension-source.ts";

const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  scout: ["read", "grep", "find", "ls", "write"],
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls", "bash", "write"],
  // Admitted only with harness.scribeOwnsMarkdown; its Bash runs its own handoff preflight.
  scribe: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};
const EXTENSION = ".pi/extensions/navori.ts";

const MANIFEST = ".pi/navori.json";
const adapter: EngineAdapter = {
  id: "pi",
  label: "Pi Coding Agent",
  placeAgent: () => null,
  // Codex already owns this shared native root when both engines are enabled.
  placeSkill: (skill, ctx) =>
    ctx.config.engines.includes("codex")
      ? null
      : {
          assetPath: skill.assetPath,
          destRelPath: `.agents/skills/${skill.id}/SKILL.md`,
          managedId: skill.managedId,
          commentStyle: "html",
        },
  placeHook: () => null,
  extraFiles: () => [],
  orphanScans: () => [],
};

/** Render the opt-in Pi manifest through the shared plan and commit choke point. */
export function renderPiEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): ProseEngineResult {
  const config = effectiveConfig(inputConfig);
  const repoRoot = options.repoRoot ?? cwd;
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const preset =
    config.preset && config.preset !== "custom" ? loadPreset(config.preset, repoRoot) : null;
  const ctx: AdapterCtx = {
    cwd,
    config,
    repoRoot,
    isWorkspace: resolve(cwd) !== resolve(repoRoot),
    coreAssets,
    preset,
    plugins: [],
  };
  const plan = resolveHarnessPlan(config, coreAssets, preset);
  const collected = collectPlan(plan, adapter, ctx, { lang: resolveLang(config.language) });
  const scribeOwnsMarkdown = config.harness?.scribeOwnsMarkdown ?? false;
  // The scribe is admitted only as the Markdown producer the project policy requires.
  const admitted = (id: string): boolean =>
    Object.hasOwn(ROLE_TOOLS, id) && (id !== "scribe" || scribeOwnsMarkdown);
  const roles = plan.agents.filter((agent) => admitted(agent.id));
  const warnings = plan.agents
    .filter((agent) => !Object.hasOwn(ROLE_TOOLS, agent.id))
    .map((agent) => `Pi subagent role ${agent.id} is unsupported and was not rendered.`);
  if (scribeOwnsMarkdown && !roles.some((agent) => agent.id === "scribe")) {
    warnings.push(
      "harness.scribeOwnsMarkdown forbids implementer Markdown but the scribe role is disabled; Pi implementer dispatch is refused until harness.scribe is enabled or scribeOwnsMarkdown is turned off.",
    );
  }
  const serialized = serializePiManifest({
    schemaVersion: 1,
    agents: roles.map((r) => r.id),
    controls: {
      planTiers: config.harness?.planTiers ?? false,
      masterPlan: config.harness?.masterPlan ?? false,
      scribeOwnsMarkdown,
    },
  });
  const extension = serializePiSource(PI_EXTENSION_SOURCE);
  const resources: Array<{ relPath: string; content: string; owned: (value: string) => boolean }> =
    [
      { relPath: MANIFEST, content: serialized, owned: ownsPiManifest },
      { relPath: EXTENSION, content: extension, owned: ownsPiSource },
    ];
  for (const agent of roles) {
    const parsed = parseAsset(readFileSync(agent.assetPath, "utf-8"), "html");
    const description = interpolate(parsed.frontmatter.description ?? agent.id, config);
    // Resolve `navori:if` markers like every other engine; `onCodex` is false here.
    const instructions = interpolate(
      conditionOrchestration(parsed.managedBody, config, "pi"),
      config,
    );
    const tier = agent.modelKey ? config.models?.[agent.modelKey] : undefined;
    // codexMap values may be a Codex family (resolved against the local catalog)
    // or a full id (verbatim). The never-downgrade rule is Codex-specific (it
    // reads a rendered .codex toml), so Pi resolves catalog-or-fallback only.
    const mapped = tier ? config.models?.codexMap?.[tier] : undefined;
    const resolved = tier && mapped ? resolveCodexModel(config, tier) : undefined;
    const model =
      resolved === undefined
        ? undefined
        : resolved.source === "pin"
          ? resolved.model
          : `openai-codex/${resolved.model}`;
    if (tier && !mapped) {
      warnings.push(
        `Pi role ${agent.id} has a model tier but no concrete codexMap.${tier}; inheriting the selected Pi model.`,
      );
    }
    const content = serializePiAgent({
      name: agent.id,
      description,
      ...(model ? { model } : {}),
      tools: ROLE_TOOLS[agent.id]!,
      instructions,
    });
    resources.push({
      relPath: `.pi/agents/${agent.id}.md`,
      content,
      owned: (value) => ownsPiAgent(value, agent.id),
    });
  }
  // Complete-generation validation precedes any pending Pi write.
  for (const resource of resources) {
    if (!resource.owned(resource.content))
      throw new Error(`Generated Pi resource failed validation: ${resource.relPath}`);
  }
  // Resolutions are sync-side: Pi's ownership/symlink checks only run in its own apply.
  const skipped: SkippedFile[] = collected.skipped.map(
    ({ resolution: _resolution, ...skip }) => skip,
  );
  const piPending: PendingWrite[] = [];
  let collided = false;
  for (const relPath of [".pi", ".pi/extensions", ".pi/agents"]) {
    const path = join(cwd, relPath);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Pi resource parent is a symlink: ${relPath}`);
    }
  }
  for (const resource of resources) {
    const path = join(cwd, resource.relPath);
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        collided = true;
        skipped.push({
          path: resource.relPath,
          reason: "Pi resource is not a regular owned file.",
          status: "user-modified-skipped",
        });
        continue;
      }
      const current = readFileSync(path, "utf-8");
      if (!resource.owned(current)) {
        collided = true;
        skipped.push({
          path: resource.relPath,
          reason: "Pi resource ownership mismatch; preserved user file.",
          status: "user-modified-skipped",
        });
      } else if (current !== resource.content) {
        piPending.push({
          path,
          relPath: resource.relPath,
          content: resource.content,
          status: "updated",
        });
      }
    } else {
      piPending.push({
        path,
        relPath: resource.relPath,
        content: resource.content,
        status: "created",
      });
    }
  }

  const desiredAgents = new Set(roles.map((agent) => `${agent.id}.md`));
  const agentDir = join(cwd, ".pi/agents");
  const removals = [...collected.removals];
  if (existsSync(agentDir)) {
    for (const name of readdirSync(agentDir)) {
      if (
        !name.endsWith(".md") ||
        desiredAgents.has(name) ||
        !Object.hasOwn(ROLE_TOOLS, name.slice(0, -3))
      )
        continue;
      const path = join(agentDir, name);
      if (
        lstatSync(path).isFile() &&
        !lstatSync(path).isSymbolicLink() &&
        ownsPiAgent(readFileSync(path, "utf-8"), name.slice(0, -3))
      ) {
        removals.push({ path });
      } else {
        collided = true;
        skipped.push({
          path: `.pi/agents/${name}`,
          reason: "Pi orphan ownership mismatch; preserved user file.",
          status: "user-modified-skipped",
        });
      }
    }
  }
  if (collided) {
    warnings.push(
      "Pi generation was not committed because at least one owned destination collides or was edited.",
    );
  }
  const pending: PendingWrite[] = [...collected.pending, ...(!collided ? piPending : [])];

  const result = commitWrites({
    pending,
    removals: collided ? collected.removals : removals,
    cwd,
    dryRun: options.dryRun,
    engineLabel: adapter.label,
    lang: resolveLang(config.language),
  });
  return { ...result, skipped, warnings };
}
