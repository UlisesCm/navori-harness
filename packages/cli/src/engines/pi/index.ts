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
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { ENGINE_CAPABILITIES } from "../shared/engine-capabilities.ts";
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
import {
  buildLocalSkillPointerContent,
  classifyLocalSkills,
  localSkillPointerDestRel,
  localSkillPointerMarkerId,
  localSkillSourceAbs,
} from "../shared/local-skill-pointer.ts";
import { loadEnabledPlugins } from "../../lib/config/plugins.ts";
import { deriveMcpTools } from "../claude/agent-mcp-tools.ts";
import { tc } from "../../lib/i18n.ts";

const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  scout: ["read", "grep", "find", "ls", "write"],
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls", "bash", "write"],
  // Admitted only with harness.scribeOwnsMarkdown; its Bash runs its own handoff preflight.
  scribe: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};
const EXTENSION = ".pi/extensions/navori.ts";

const MANIFEST = ".pi/navori.json";
/** Plan-skill ids plus the local-skill pointers Pi may own in the shared `.agents/skills` root. */
interface PiSkillRoot {
  /** Local ids with a safe-to-write pointer (`emit`). */
  emit: readonly string[];
  /** Local ids whose destination is a foreign file (protected from pruning). */
  foreign: readonly string[];
}

/**
 * Pi adapter. Codex already owns the shared `.agents/skills` root when both engines are
 * enabled, so Pi writes (and prunes) nothing there then: one writer, one marker.
 */
function buildAdapter(local: PiSkillRoot): EngineAdapter {
  return {
    id: "pi",
    label: "Pi Coding Agent",
    placeAgent: () => null,
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
    // Same transform/marker/destination as the Codex pointer: the body stays in the user's
    // `.claude/skills/<id>/SKILL.md`, this entry only makes it discoverable (spec 0047 R9).
    extraFiles: (ctx) => {
      if (ctx.config.engines.includes("codex")) return [];
      return local.emit.flatMap((id) => {
        const sourceAbs = localSkillSourceAbs(ctx.cwd, id);
        if (sourceAbs === null) return [];
        return [
          {
            assetPath: sourceAbs,
            transform: (text: string) => buildLocalSkillPointerContent(text, id),
            destRelPath: localSkillPointerDestRel(id),
            managedId: localSkillPointerMarkerId(id),
            commentStyle: "html" as const,
          },
        ];
      });
    },
    orphanScans: (plan, ctx) =>
      ctx.config.engines.includes("codex")
        ? []
        : [
            {
              dir: ".agents/skills",
              match: () => true,
              desired: new Set([
                ...plan.skills.map(({ id }) => `.agents/skills/${id}/SKILL.md`),
                ...[...local.emit, ...local.foreign].map((id) => localSkillPointerDestRel(id)),
              ]),
              shape: "skill-dir",
            },
          ],
  };
}

/**
 * Pi discovers the repo-root context file natively (docs/configuration.md "Context files").
 * Pi delegates it to the agents-md adapter only when no other configured engine already owns
 * it (Codex, agents-md): one writer and one `navori-agents` block across every transition.
 */
function piNeedsContextWriter(config: NavoriConfig): boolean {
  return !config.engines.some(
    (engine) =>
      engine !== "pi" &&
      engine in ENGINE_CAPABILITIES &&
      ENGINE_CAPABILITIES[engine as keyof typeof ENGINE_CAPABILITIES].ownsAgentsMd,
  );
}

/**
 * Spec 0047 R10 (fail-closed): Pi children always run with `--no-mcp` (Pi 1.1.0 connects every
 * enabled server and lists them all in the child prompt, so per-server limiting is not
 * verifiable). An enabled plugin that injects MCP prose into a rendered Pi role therefore cannot
 * work there: direct, discovery and codemode access are all unavailable. Name each one.
 */
function mcpRoleDiagnostics(config: NavoriConfig, roles: ReadonlyArray<{ id: string }>): string[] {
  const roleIds = new Set(roles.map((role) => role.id));
  const out: string[] = [];
  for (const plugin of loadEnabledPlugins(config.plugins).loaded) {
    if (!plugin.manifest.mcpServer) continue;
    for (const skill of plugin.manifest.skills ?? []) {
      const role = skill.injectInto?.match(/^\.claude\/agents\/([a-z0-9-]+)\.md$/)?.[1];
      if (role === undefined || !roleIds.has(role)) continue;
      const tools = deriveMcpTools(plugin, skill.mcpTools).join(", ");
      out.push(
        `Pi role ${role} needs MCP tools from plugin ${plugin.manifest.id} (${tools}) but is unavailable for them in children: ` +
          "Pi children run with --no-mcp, so direct, discovery and codemode MCP access are all off. " +
          `Run that work from the parent session, or disable plugin ${plugin.manifest.id} for Pi.`,
      );
    }
  }
  return out;
}

/**
 * Who wrote a `.pi/**` file, judged ONLY by Pi's own validators (spec 0047 R11). The generic
 * prune test reads `navori:managed ... version=` or a `$navori` key, neither of which Pi's
 * strict JSON / `navori:managed-file` headers carry, so it cannot answer for them. `ours` needs
 * the exact canonical content and digest of a resource Pi writes; a recognizable Navori header
 * that no longer validates is `modified`; anything else (user settings, foreign agents,
 * symlinks) is `foreign`. A path Pi never writes is never `ours`.
 */
export function piOwnershipVerdict(cwd: string, rel: string): "ours" | "modified" | "foreign" {
  const path = join(cwd, rel);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) return "foreign";
  const content = readFileSync(path, "utf-8");
  const agent = /^\.pi\/agents\/([a-z-]+)\.md$/.exec(rel)?.[1];
  const owned =
    rel === MANIFEST
      ? ownsPiManifest(content)
      : rel === EXTENSION
        ? ownsPiSource(content)
        : agent !== undefined && Object.hasOwn(ROLE_TOOLS, agent) && ownsPiAgent(content, agent);
  if (owned) return "ours";
  const claimsNavori =
    content.includes('navori:managed-file id="pi-') ||
    /"_navori"\s*:\s*{\s*"id": "pi-runtime"/.test(content);
  return claimsNavori ? "modified" : "foreign";
}

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
  const lang = resolveLang(config.language);
  const localSkills = classifyLocalSkills(
    cwd,
    config.project?.localSkills ?? [],
    new Set(plan.skills.map((s) => s.id)),
  );
  const adapter = buildAdapter(localSkills);
  const collected = collectPlan(plan, adapter, ctx, { lang });
  const scribeOwnsMarkdown = config.harness?.scribeOwnsMarkdown ?? false;
  // The scribe is admitted only as the Markdown producer the project policy requires.
  const admitted = (id: string): boolean =>
    Object.hasOwn(ROLE_TOOLS, id) && (id !== "scribe" || scribeOwnsMarkdown);
  const roles = plan.agents.filter((agent) => admitted(agent.id));
  const warnings: string[] = plan.agents
    .filter((agent) => !Object.hasOwn(ROLE_TOOLS, agent.id))
    .map((agent) => `Pi subagent role ${agent.id} is unsupported and was not rendered.`);
  if (!config.engines.includes("codex")) {
    for (const id of localSkills.foreign) {
      warnings.push(tc(lang).engine.localSkillForeignCodex(localSkillPointerDestRel(id)));
    }
  }
  warnings.push(...mcpRoleDiagnostics(config, roles));
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
  if (!piNeedsContextWriter(config)) return { ...result, skipped, warnings };
  // Foreign content outside the managed block and a hand-edited block are preserved by the
  // shared prose renderer. Its Claude-parity advisories do not apply to Pi and are dropped.
  const context = renderAgentsMdEngine(cwd, config, options);
  return {
    written: [...result.written, ...context.written],
    skipped: [...skipped, ...context.skipped],
    warnings,
    backupPath: result.backupPath ?? context.backupPath,
  };
}
