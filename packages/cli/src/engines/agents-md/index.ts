import { type NavoriConfig } from "../../lib/config/config.ts";
import { renderProseFile, type ProseEngineResult } from "../shared/prose-harness.ts";
import { AGENTS_MD_HEADER, AGENTS_MD_USER_SECTION } from "../../lib/render/scaffold.ts";

/**
 * AGENTS.md engine adapter. Emits a single `AGENTS.md` at the repo root — the
 * universal format Cursor, Codex, Gemini CLI and Copilot all read. A thin
 * wrapper over the shared prose engine (see `../shared/prose-harness.ts`): it
 * only supplies the destination, the managed-block id and the seed header/user
 * section. The Claude-only omissions and hybrid ownership are documented there.
 */

export type AgentsMdEngineResult = ProseEngineResult;

const MANAGED_ID = "navori-agents";

export function renderAgentsMdEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: {
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
  } = {},
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
  });
}
