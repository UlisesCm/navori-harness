import { type NavoriConfig } from "../../lib/config.ts";
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

/** Title the first render seeds before the managed block. */
const HEADER = "# AGENTS.md\n";
/** User-owned section appended once, the first time AGENTS.md is created. */
const USER_SECTION =
  "\n<!-- navori:user-section -->\n" +
  "## Reglas del repo (tuyas)\n\n" +
  "<!-- Agrega aquí lo específico de tu repo; navori no toca esta sección. -->\n";

export function renderAgentsMdEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): AgentsMdEngineResult {
  return renderProseFile({
    cwd,
    config: inputConfig,
    destRelPath: "AGENTS.md",
    managedId: MANAGED_ID,
    header: HEADER,
    userSection: USER_SECTION,
    dryRun: options.dryRun,
    repoRoot: options.repoRoot,
  });
}
