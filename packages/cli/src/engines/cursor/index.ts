import { type NavoriConfig } from "../../lib/config.ts";
import { renderProseFile, type ProseEngineResult } from "../shared/prose-harness.ts";

/**
 * Cursor engine adapter. Emits a single project rule at
 * `.cursor/rules/navori.mdc` — Cursor's current rules format (an `.mdc` file
 * with a YAML frontmatter). `alwaysApply: true` makes navori's harness context
 * part of every request, the closest analogue to a root CLAUDE.md.
 *
 * A thin wrapper over the shared prose engine (see `../shared/prose-harness.ts`):
 * same harness body as AGENTS.md, different path/id, plus the `.mdc` frontmatter
 * as the seed header. HTML managed-block markers are valid in an `.mdc` body
 * (it's markdown), so hybrid ownership works unchanged. The frontmatter is
 * seeded once, before the managed marker, and preserved verbatim on re-render.
 * Claude-only concerns are dropped there; the parity gap surfaces via warnings.
 */

export type CursorEngineResult = ProseEngineResult;

const MANAGED_ID = "navori-cursor";

/**
 * `.mdc` frontmatter + title seeded before the managed block on first render.
 * `alwaysApply: true` means Cursor injects this rule into every request (no glob
 * scoping) — the harness context should always be present.
 */
const HEADER =
  "---\n" +
  "description: Contexto y reglas del proyecto generados por navori.\n" +
  "alwaysApply: true\n" +
  "---\n\n" +
  "# Navori — reglas del proyecto\n";
/** User-owned section appended once, the first time the file is created. */
const USER_SECTION =
  "\n<!-- navori:user-section -->\n" +
  "## Reglas del repo (tuyas)\n\n" +
  "<!-- Agrega aquí lo específico de tu repo; navori no toca esta sección. -->\n";

export function renderCursorEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): CursorEngineResult {
  return renderProseFile({
    cwd,
    config: inputConfig,
    destRelPath: ".cursor/rules/navori.mdc",
    managedId: MANAGED_ID,
    header: HEADER,
    userSection: USER_SECTION,
    dryRun: options.dryRun,
    repoRoot: options.repoRoot,
  });
}
