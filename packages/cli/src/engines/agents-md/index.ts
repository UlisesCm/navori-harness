import { type NavoriConfig } from "../../lib/config/config.ts";
import { resolveLang } from "../../lib/i18n.ts";
import { type Layer } from "../../lib/render/layers.ts";
import { AGENTS_MD_HEADER, AGENTS_MD_USER_SECTION } from "../../lib/render/scaffold.ts";
import { buildContextoProyectoBody } from "../shared/project-context.ts";
import { renderProseFile, type ProseEngineResult } from "../shared/prose-harness.ts";

/**
 * AGENTS.md engine adapter. Emits a single `AGENTS.md` at the repo root — the
 * universal format Cursor, Codex, Gemini CLI and Copilot all read. A thin
 * wrapper over the shared prose engine (see `../shared/prose-harness.ts`): it
 * only supplies the destination, the managed-block id and the seed header/user
 * section. The Claude-only omissions and hybrid ownership are documented there.
 */

export type AgentsMdEngineResult = ProseEngineResult;

const MANAGED_ID = "navori-agents";

/** Options of the single-file writer, which Pi also drives with its own vocabulary and layers. */
export interface AgentsMdFileOptions {
  dryRun?: boolean;
  repoRoot?: string;
  /** Pi only (spec 0048 D13): the plugin blocks and sub-blocks it owns in the shared file. */
  includePluginBlocks?: boolean;
  /** Pi only: as the sole writer it carries the orchestration Codex would (#1512). */
  includeOrchestration?: boolean;
  /** Pi only: Pi discovers `.agents/skills` natively, like Codex. */
  omitSkillsIndex?: boolean;
  /** Engine whose `onX` conditions the prose resolves; defaults to `agents-md`. */
  engine?: string;
  extendBody?: (body: string) => string;
  /** Pi only: its vocabulary adapter, applied before interpolation. */
  transform?: (text: string) => string;
  /** Pi only: rule assets it carries in its own file instead of this one. */
  omitAssetIds?: ReadonlySet<string>;
  /** The `agents-md` engine only: keep exactly these layers (spec 0064). */
  layers?: ReadonlySet<Layer>;
}

/** Write `AGENTS.md` from the given composition; the caller (Pi, or the layered engine) picks its shape. */
export function renderAgentsMdFile(
  cwd: string,
  inputConfig: NavoriConfig,
  options: AgentsMdFileOptions = {},
): AgentsMdEngineResult {
  return renderProseFile({
    cwd,
    config: inputConfig,
    destRelPath: "AGENTS.md",
    managedId: MANAGED_ID,
    engine: options.engine ?? "agents-md",
    header: AGENTS_MD_HEADER,
    userSection: AGENTS_MD_USER_SECTION,
    dryRun: options.dryRun,
    repoRoot: options.repoRoot,
    includePluginBlocks: options.includePluginBlocks,
    includeOrchestration: options.includeOrchestration,
    omitSkillsIndex: options.omitSkillsIndex,
    extendBody: options.extendBody,
    transform: options.transform,
    omitAssetIds: options.omitAssetIds,
    layers: options.layers,
  });
}

/**
 * The `agents-md` engine: the layered, neutral `AGENTS.md` (spec 0064). It carries the shared layer
 * (core rules, the preset stack, the plugin blocks that declare themselves shared) plus the
 * project's own rules (`contexto-proyecto`). The orchestrator layer leaves it when Pi is also
 * configured, because Pi hands that doctrine to its parent through `.pi/navori/orchestrator.md`;
 * without Pi it stays, as no other engine would carry it. Whatever is Claude-specific is never
 * written here.
 */
export function renderAgentsMdEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): AgentsMdEngineResult {
  const lang = resolveLang(inputConfig.language);
  const layers: ReadonlySet<Layer> = new Set<Layer>(
    inputConfig.engines.includes("pi") ? ["shared"] : ["shared", "orchestrator"],
  );
  return renderAgentsMdFile(cwd, inputConfig, {
    ...options,
    layers,
    extendBody: (body) =>
      [body, buildContextoProyectoBody(inputConfig, lang)]
        .filter((part): part is string => part !== null)
        .join("\n"),
  });
}
