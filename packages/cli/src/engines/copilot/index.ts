import { type NavoriConfig } from "../../lib/config.ts";
import { renderProseFile, type ProseEngineResult } from "../shared/prose-harness.ts";

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

/** Title the first render seeds before the managed block. */
const HEADER = "# Copilot instructions\n";
/** User-owned section appended once, the first time the file is created. */
const USER_SECTION =
  "\n<!-- navori:user-section -->\n" +
  "## Reglas del repo (tuyas)\n\n" +
  "<!-- Agrega aquí lo específico de tu repo; navori no toca esta sección. -->\n";

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
    header: HEADER,
    userSection: USER_SECTION,
    dryRun: options.dryRun,
    repoRoot: options.repoRoot,
  });
}
