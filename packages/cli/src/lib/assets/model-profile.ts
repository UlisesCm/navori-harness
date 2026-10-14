import { readFileSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { NavoriConfig } from "../config/config.ts";
import {
  defaultCodexCatalogPath,
  inspectCodexCatalog,
  resolveCodexModelValue,
  type CodexModelSource,
  type CodexCatalogEvidence,
  type CatalogProvenance,
} from "../codex/model-catalog.ts";
import { CORE_AGENTS, isAgentEnabled } from "../../engines/shared/harness-assets.ts";
import { resolveHarnessPlan, type PlannedAgent } from "../../engines/shared/harness-plan.ts";
import { loadPreset } from "../config/presets.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { parseAsset } from "../../engines/claude/parse-asset.ts";
import { removeManagedSection } from "../render/marker.ts";

/** Which per-agent tier(s) render frontmatter omits for this agent. */
export type MissingTier = "model" | "effort";

export interface MissingModelProfile {
  /** Core agent id (e.g. "researcher"), matching `.claude/agents/<id>.md`. */
  agent: string;
  /** The harness key this agent is assigned in navori.config.json (e.g. "researcher"). */
  harnessKey: string;
  missing: MissingTier[];
}

/** The configured tier is not evidence of a host-resolved model identity. */
export type ProfileOrigin = "explicit" | "mapped" | "inherited";

export interface ProfileValue {
  configured: string | null;
  origin: ProfileOrigin;
  /** Config projection only; doctor does not inspect rendered files here. */
  wouldRender: string | null;
  /** Static doctor cannot observe the model/effort actually used by the host. */
  effectiveObserved: null;
  mapping?: "configured" | "built-in";
  /** Codex only: whether the id came from a family lookup, a pinned id or the last-known fallback. */
  source?: CodexModelSource;
}

/** One renderable core subagent; main-thread orchestrator and preset extras are excluded. */
export interface ModelProfileProvenance {
  engine: "claude" | "codex";
  agent: string;
  model: ProfileValue;
  effort: ProfileValue;
}

// Shared by the Codex renderer and doctor. Tier names describe routing, not
// equivalent quality across hosts (Spec 0037 R12). Values are model FAMILIES
// (spec 0041 R32), resolved against the local Codex catalog at render time.
const CODEX_MODEL_BY_CLAUDE_TIER = {
  opus: "sol",
  sonnet: "luna",
  haiku: "luna",
} as const;

export interface CodexModelChoice {
  model: string;
  mapping: "configured" | "built-in";
  source: CodexModelSource;
  /** Set when `source` is `fallback`: the family missing from the local catalog. */
  family?: string;
}

/** Independent input fields used by the native Codex renderer and diagnostics. */
export interface CodexProfileInput {
  name: string;
  tier?: string;
  effort?: string;
  previous?: string | null;
}

/** Resolved pair; missing fields deliberately retain native inheritance. */
export interface CodexProfileChoice {
  model: ProfileValue;
  effort: ProfileValue;
  diagnostics: string[];
}

/** Resolve fields independently. Claude effort is input, never a Codex override. */
export function resolveCodexProfile(
  config: NavoriConfig,
  input: CodexProfileInput,
  catalogPath: string | null = defaultCodexCatalogPath(),
): CodexProfileChoice {
  const override = config.models?.codexProfiles?.[input.name];
  const tier = input.tier;
  const diagnostics: string[] = [];
  const validTier = tier === "opus" || tier === "sonnet" || tier === "haiku";
  if (tier && !validTier) diagnostics.push(`unknown Claude model tier: ${tier}`);
  const choice = override?.model
    ? {
        ...resolveCodexModelValue(override.model, catalogPath, input.previous),
        mapping: "configured" as const,
      }
    : validTier
      ? resolveCodexModel(config, tier, catalogPath, input.previous)
      : null;
  const effort =
    override?.effort ?? (tier === "sonnet" && input.effort === "medium" ? "high" : input.effort);
  const inherited: ProfileValue = {
    configured: null,
    origin: "inherited",
    wouldRender: null,
    effectiveObserved: null,
  };
  return {
    model: choice
      ? {
          configured: override?.model ?? tier ?? null,
          origin: override?.model ? "explicit" : "mapped",
          wouldRender: choice.model,
          effectiveObserved: null,
          mapping: choice.mapping,
          source: choice.source,
        }
      : { ...inherited },
    effort: effort
      ? {
          configured: override?.effort ?? input.effort ?? null,
          origin: override?.effort || effort === input.effort ? "explicit" : "mapped",
          wouldRender: effort,
          effectiveObserved: null,
        }
      : { ...inherited },
    diagnostics,
  };
}

/** Use the source frontmatter for preset extras, with explicit core-role config first. */
export function plannedCodexProfileInput(
  source: PlannedAgent,
  config: NavoriConfig,
): CodexProfileInput {
  const frontmatter = parseAsset(readFileSync(source.assetPath, "utf-8"), "html").frontmatter;
  return {
    name: source.id,
    tier: source.modelKey ? config.models?.[source.modelKey] : frontmatter.model,
    effort: source.modelKey ? config.effort?.[source.modelKey] : frontmatter.effort,
  };
}

/** A known host report must identify the exact native context and selection request. */
export interface CodexHostProfileEvidence {
  nativeName: string;
  context: string;
  evidenceRef: string;
  requestedModel: string | null;
  requestedEffort: string | null;
  selection: "observed" | "unsupported-model" | "unsupported-effort" | "rejected";
  model?: string;
  effort?: string;
}

/** Project inventory/projection only; no native gate, dispatch, or session mutation. */
export interface CodexProfileProjection extends ModelProfileProvenance {
  engine: "codex";
  nativeName: string;
  role: string | null;
  scope: "principal" | "subagent";
  origin: "main" | "core" | "extra" | "local";
  path: string;
  hostOwned: boolean;
  rendered: { model: string | null; effort: string | null } | null;
  catalog: CodexCatalogEvidence;
  diagnostics: string[];
  application: { status: "pending" | "observed"; remedy: string | null };
  observed: { model: string; effort: string | null; evidenceRef: string; context: string } | null;
}

/** Optional native evidence is an input from a host boundary, never generated by render. */
export interface CodexProjectionOptions {
  catalogPath?: string | null;
  plannedAgents?: readonly PlannedAgent[];
  catalogProvenance?: CatalogProvenance;
  context?: string;
  hostEvidence?: readonly CodexHostProfileEvidence[];
}

/** Parse native TOML defensively; filename is a location, never a dispatch identity. */
function nativeFields(
  path: string,
  cwd: string,
): {
  name: string | null;
  model: string | null;
  effort: string | null;
  managed: boolean;
  userModel?: string;
  userEffort?: string;
  diagnostic?: string;
} {
  try {
    const rel = relative(realpathSync(cwd), realpathSync(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return {
        name: null,
        model: null,
        effort: null,
        managed: false,
        diagnostic: "native path escapes project",
      };
    }
    const text = readFileSync(path, "utf-8");
    const value = parseToml(text);
    const user = path.endsWith(`${sep}config.toml`)
      ? parseToml(removeManagedSection(text, "codex-config-base", "shell"))
      : {};
    const model = value.model;
    const effort = value.model_reasoning_effort;
    const name =
      typeof value.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value.name)
        ? value.name
        : null;
    const invalid =
      (model !== undefined && typeof model !== "string") ||
      (effort !== undefined &&
        (typeof effort !== "string" ||
          !["low", "medium", "high", "xhigh", "max"].includes(effort)));
    return {
      name,
      model: typeof model === "string" ? model : null,
      effort: typeof effort === "string" ? effort : null,
      managed: /^# navori:managed start id="[^"]+-codex-base" /m.test(text),
      ...(typeof user.model === "string" ? { userModel: user.model } : {}),
      ...(typeof user.model_reasoning_effort === "string"
        ? { userEffort: user.model_reasoning_effort }
        : {}),
      ...(invalid ? { diagnostic: "invalid native model/effort" } : {}),
    };
  } catch {
    return {
      name: null,
      model: null,
      effort: null,
      managed: false,
      diagnostic: "missing or malformed native TOML",
    };
  }
}

/** Resolve enabled managed inventory and read-only project-native agents in one projection. */
export function projectCodexProfiles(
  cwd: string,
  config: NavoriConfig,
  options: CodexProjectionOptions = {},
): CodexProfileProjection[] {
  const catalogPath =
    options.catalogPath === undefined ? defaultCodexCatalogPath() : options.catalogPath;
  const catalog = inspectCodexCatalog(catalogPath, options.catalogProvenance, options.context);
  const diagnostics: string[] = [];
  let agents = options.plannedAgents;
  if (!agents) {
    let preset: ReturnType<typeof loadPreset> = null;
    try {
      if (config.preset !== "custom") preset = loadPreset(config.preset, cwd);
    } catch {
      diagnostics.push("preset inventory unavailable");
    }
    agents = resolveHarnessPlan(config, join(getCoreRoot(), "core-assets"), preset, {
      engine: "codex",
    }).agents;
  }
  const rows: CodexProfileProjection[] = [];
  const add = (
    input: CodexProfileInput,
    origin: CodexProfileProjection["origin"],
    path: string,
    role: string | null,
    rendered: CodexProfileProjection["rendered"],
  ): CodexProfileProjection => {
    const choice = resolveCodexProfile(config, input, catalogPath);
    const row: CodexProfileProjection = {
      engine: "codex",
      agent: input.name,
      nativeName: input.name,
      role,
      scope: origin === "main" ? "principal" : "subagent",
      origin,
      path,
      hostOwned: origin === "main",
      ...choice,
      rendered,
      catalog,
      diagnostics: [...diagnostics, ...choice.diagnostics],
      application: {
        status: "pending",
        remedy:
          "Start a new native Codex context with the requested project profile; verify model and effort support in that host.",
      },
      observed: null,
    };
    rows.push(row);
    return row;
  };
  const mainPath = ".codex/config.toml";
  const main = nativeFields(join(cwd, mainPath), cwd);
  const principal = add(
    {
      name: "orchestrator",
      tier: config.models?.orchestrator,
      effort: config.effort?.orchestrator,
      previous: main.model,
    },
    "main",
    mainPath,
    "orchestrator",
    main.diagnostic ? null : { model: main.model, effort: main.effort },
  );
  if (main.userModel || main.userEffort)
    principal.diagnostics.push(
      "user-owned main profile preserved; project intent requires a human decision",
    );
  const ownedPaths = new Set<string>();
  for (const agent of agents) {
    const path = `.codex/agents/${agent.id}.toml`;
    const native = nativeFields(join(cwd, path), cwd);
    if (native.managed) ownedPaths.add(path);
    const row = add(
      { ...plannedCodexProfileInput(agent, config), previous: native.model },
      agent.modelKey ? "core" : "extra",
      path,
      agent.modelKey ?? null,
      native.diagnostic ? null : { model: native.model, effort: native.effort },
    );
    if (!native.managed && existsSync(join(cwd, path)))
      row.diagnostics.push("managed placement collides with a user-owned native path");
    if (native.name && native.name !== agent.id)
      row.diagnostics.push(`managed native name mismatch: ${native.name}`);
  }
  let files: string[] = [];
  try {
    const directory = join(cwd, ".codex/agents");
    const rel = relative(realpathSync(cwd), realpathSync(directory));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      diagnostics.push("native agents directory escapes project");
    else
      files = readdirSync(directory)
        .filter((file) => file.endsWith(".toml"))
        .sort();
  } catch {
    /* No project-native inventory yet. */
  }
  for (const file of files) {
    const path = `.codex/agents/${file}`;
    if (ownedPaths.has(path)) continue;
    const native = nativeFields(join(cwd, path), cwd);
    if (native.managed) {
      diagnostics.push(`disabled or unplanned managed native agent: ${path}`);
      continue;
    }
    const row = add({ name: native.name ?? `unknown:${file}` }, "local", path, null, {
      model: native.model,
      effort: native.effort,
    });
    if (!native.name) row.diagnostics.push("missing or unknown native name");
    if (native.diagnostic) row.diagnostics.push(native.diagnostic);
    const override = config.models?.codexProfiles?.[native.name ?? ""];
    for (const [field, value] of [
      ["model", native.model],
      ["effort", native.effort],
    ] as const) {
      if (value !== null) {
        if (override?.[field] && row[field].wouldRender !== value)
          row.diagnostics.push(
            `local ${field} conflicts with project override; human decision required`,
          );
        row[field] = {
          configured: value,
          origin: "explicit",
          wouldRender: value,
          effectiveObserved: null,
        };
      } else if (override?.[field])
        row.diagnostics.push(
          `local ${field} override requires a supported native request; file remains inherited`,
        );
    }
  }
  for (const row of rows) {
    row.diagnostics.push(
      ...diagnostics.filter((diagnostic) => !row.diagnostics.includes(diagnostic)),
    );
    if (rows.filter((other) => other.nativeName === row.nativeName).length > 1)
      row.diagnostics.push(`duplicate native name: ${row.nativeName}`);
    const host = options.hostEvidence?.find(
      (entry) =>
        entry.nativeName === row.nativeName &&
        entry.context === options.context &&
        entry.context &&
        entry.evidenceRef &&
        entry.requestedModel === row.model.wouldRender &&
        entry.requestedEffort === row.effort.wouldRender,
    );
    if (host?.selection === "observed" && host.model && row.diagnostics.length === 0) {
      row.observed = {
        model: host.model,
        effort: host.effort ?? null,
        context: host.context,
        evidenceRef: host.evidenceRef,
      };
      row.application = { status: "observed", remedy: null };
    } else if (host && host.selection !== "observed") {
      row.diagnostics.push(`native host ${host.selection}; selection stopped`);
      row.application.remedy =
        "Choose a model/effort pair demonstrated as supported by the native host, or start a compatible host; no automatic substitution.";
    }
  }
  const names = new Set(rows.map((row) => row.nativeName));
  for (const name of Object.keys(config.models?.codexProfiles ?? {})) {
    if (!names.has(name))
      for (const row of rows) row.diagnostics.push(`override for unknown native name: ${name}`);
  }
  return rows;
}

/**
 * Resolve a configured tier to a concrete Codex model id (spec 0041 R32).
 * `models.codexMap[tier]` (or the built-in family) is a family name or a full
 * id: an id is a pin, a family resolves to the highest-version catalog model.
 * Never throws; `catalogPath` is injectable so tests never read `~/.codex`.
 */
export function resolveCodexModel(
  config: NavoriConfig,
  tier: keyof typeof CODEX_MODEL_BY_CLAUDE_TIER,
  catalogPath?: string | null,
  previous: string | null = null,
): CodexModelChoice {
  const configured = config.models?.codexMap?.[tier];
  const value = configured ?? CODEX_MODEL_BY_CLAUDE_TIER[tier];
  const resolved =
    catalogPath === undefined
      ? resolveCodexModelValue(value, undefined, previous)
      : resolveCodexModelValue(value, catalogPath, previous);
  return { ...resolved, mapping: configured !== undefined ? "configured" : "built-in" };
}

/** Model id currently rendered in `.codex/agents/<agent>.toml`, or null (absent, unreadable, none). */
export function readRenderedCodexModel(cwd: string, agentId: string): string | null {
  return readNativeCodexProfile(cwd, agentId).model;
}

/** Read project-native fields within the checkout; never follow an agent name into another path. */
export function readNativeCodexProfile(
  cwd: string,
  agentId: string,
): ReturnType<typeof nativeFields> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agentId))
    return {
      name: null,
      model: null,
      effort: null,
      managed: false,
      diagnostic: "unknown native name",
    };
  return nativeFields(
    join(cwd, agentId === "orchestrator" ? ".codex/config.toml" : `.codex/agents/${agentId}.toml`),
    cwd,
  );
}

/** A rendered `.codex/agents/<agent>.toml` model that its family no longer resolves to. */
export interface StaleCodexModel {
  agent: string;
  rendered: string;
  current: string;
}

/**
 * Compare the model rendered in each `.codex/agents/*.toml` against the current
 * resolution of its tier (spec 0041 R32). Pinned ids and matching models are
 * silent; an agent without a rendered model, or an unreadable file, is skipped.
 * Never throws; `catalogPath` is injectable like `resolveCodexModel`.
 */
export function scanStaleCodexModels(
  cwd: string,
  config: NavoriConfig,
  catalogPath?: string | null,
): StaleCodexModel[] {
  const stale: StaleCodexModel[] = [];
  for (const row of projectCodexProfiles(cwd, config, { catalogPath })) {
    if (row.origin === "local") continue;
    const rendered = row.rendered?.model;
    const current = row.model.wouldRender;
    if (!rendered || !current || row.model.source === "pin" || rendered === current) continue;
    stale.push({ agent: row.nativeName, rendered, current });
  }
  return stale;
}

/** Project core-subagent profiles without guessing host inheritance or file state. */
export function scanModelProfileProvenance(
  config: NavoriConfig,
  cwd?: string,
): ModelProfileProvenance[] {
  const rows: ModelProfileProvenance[] = [];
  for (const engine of config.engines) {
    if (engine !== "claude" && engine !== "codex") continue;
    if (engine === "codex" && cwd !== undefined) {
      rows.push(...projectCodexProfiles(cwd, config));
      continue;
    }
    for (const agent of CORE_AGENTS) {
      // The main thread embodies orchestrator; there is no spawned agent model.
      // Claude's effort.orchestrator may seed settings.json effortLevel (except
      // max), but that root setting belongs to T16's separate evaluation.
      if (agent.id === "orchestrator" || !isAgentEnabled(config, agent.harnessKey)) continue;
      const tier = config.models?.[agent.harnessKey];
      const configuredEffort = config.effort?.[agent.harnessKey];
      const codex =
        engine === "codex"
          ? resolveCodexProfile(config, { name: agent.id, tier, effort: configuredEffort })
          : null;
      rows.push({
        engine,
        agent: agent.id,
        model:
          codex?.model ??
          (tier
            ? {
                configured: tier,
                origin: "explicit",
                wouldRender: tier,
                effectiveObserved: null,
              }
            : {
                configured: null,
                origin: "inherited",
                wouldRender: null,
                effectiveObserved: null,
              }),
        effort:
          codex?.effort ??
          (configuredEffort
            ? {
                configured: configuredEffort,
                origin: "explicit",
                wouldRender: configuredEffort,
                effectiveObserved: null,
              }
            : {
                configured: null,
                origin: "inherited",
                wouldRender: null,
                effectiveObserved: null,
              }),
      });
    }
  }
  return rows;
}

/**
 * Core agents whose source template declares `model: {{models.<agent>}}` /
 * `effort: {{effort.<agent>}}` (issue #817) but whose tier is unset in
 * `navori.config.json`.
 *
 * Both fields are OPTIONAL by design (see `ModelsSchema`/`EffortSchema` in
 * `schema.ts`): a repo that never sets them is not misconfigured — every agent
 * simply inherits the session's model/effort, and `renderManagedFile` reflects
 * that by DROPPING the frontmatter line (`omitUnresolvedKeyLines`) rather than
 * emitting a broken YAML value or a frozen placeholder. That is correct and
 * deliberate, but it also means nothing in the rendered file signals the gap —
 * a repo that MEANT to set a cost-aware profile (see `RECOMMENDED_MODELS` /
 * `RECOMMENDED_EFFORT` in `recommended.ts`) and forgot has no way to notice.
 * This scan is the human advisory signal; `scanModelProfileProvenance` adds
 * machine-readable provenance. Advisory only: it never flips `doctor`'s `ok`,
 * the same treatment as the sibling `gateReadiness` / `emptyUserSections`
 * checks — an unset tier is a valid default, not a hard failure.
 */
export function scanMissingModelProfile(config: NavoriConfig): MissingModelProfile[] {
  // Only the disk engines (claude, codex) ever read `models`/`effort` per
  // agent — a repo rendering only prose engines (agents-md, cursor, copilot)
  // never emits a per-agent model tier, so there is nothing to warn about.
  const hasDiskEngine = config.engines.some((e) => e === "claude" || e === "codex");
  if (!hasDiskEngine) return [];

  const out: MissingModelProfile[] = [];
  for (const agent of CORE_AGENTS) {
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    const missing: MissingTier[] = [];
    if (!config.models?.[agent.harnessKey]) missing.push("model");
    if (!config.effort?.[agent.harnessKey]) missing.push("effort");
    if (missing.length > 0) out.push({ agent: agent.id, harnessKey: agent.harnessKey, missing });
  }
  return out;
}
