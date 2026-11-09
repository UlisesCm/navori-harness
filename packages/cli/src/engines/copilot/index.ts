import { type NavoriConfig } from "../../lib/config/config.ts";
import { renderProseFile, type ProseEngineResult } from "../shared/prose-harness.ts";
import { COPILOT_HEADER, COPILOT_USER_SECTION } from "../../lib/render/scaffold.ts";

/**
 * GitHub Copilot engine adapter. Emits a single `.github/copilot-instructions.md`
 * — the repo-wide custom-instructions file Copilot (chat, coding agent, review)
 * loads automatically. A thin wrapper over the shared prose engine (see
 * `../shared/prose-harness.ts`): same harness body as AGENTS.md, different path
 * and managed-block id. Claude-only concerns are dropped there; the parity gap
 * is surfaced via `warnings[]`.
 */

export type CopilotEngineResult = ProseEngineResult;

const MANAGED_ID = "navori-copilot";

export function renderCopilotEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): CopilotEngineResult {
  return renderProseFile({
    cwd,
    config: inputConfig,
    destRelPath: ".github/copilot-instructions.md",
    managedId: MANAGED_ID,
    engine: "copilot",
    header: COPILOT_HEADER,
    userSection: COPILOT_USER_SECTION,
    dryRun: options.dryRun,
    repoRoot: options.repoRoot,
  });
}
