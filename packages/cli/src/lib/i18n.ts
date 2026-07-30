/**
 * Lightweight i18n for the `init` wizard prompts and supporting summaries.
 *
 * Keeps both locales here in one literal so a missing key is a TS error,
 * not a silent fallback to English. New strings: add to BOTH `es` and `en`.
 *
 * The wizard asks for the locale up-front; everything after that prompt
 * pulls strings via `t(lang).<key>`.
 */

export type Lang = "es" | "en";

interface Strings {
  // Wizard top-level
  pickLanguage: string;
  pickLanguageEs: string;
  pickLanguageEn: string;
  useTheseValues: string;
  projectNameUndetectedAdjust: string;
  whatToChange: string;

  // Adjust labels
  labelProjectName: string;
  labelLanguage: string;
  labelWorkspace: string;
  labelEngines: string;
  labelPreset: string;
  labelBranchBase: string;
  labelQualityGate: string;
  notDetectedParen: string;
  defaultParen: string;

  // Prompts
  projectNameKebab: string;
  mustBeKebab: string;
  languageForAssets: string;
  assetEsLabel: string;
  assetEnLabel: string;
  workspaceOptional: string;
  leaveEmpty: string;
  enginesToTarget: string;
  stackPresetFreeText: string;
  baseBranch: string;
  qualityGateFast: string;
  qualityGateFull: string;
  pluginsToEnable: string;
  renderNow: string;
  useAssignments: string;
  recommendedAssignments: string;
  agentFor: (id: string, plugin: string) => string;

  // Preview + edit loop
  previewTitle: string;
  previewAction: string;
  saveAndContinue: string;
  adjustSomething: string;
  whatToEdit: string;
  backToPreview: string;
  cancelAndExit: string;
  editField: (label: string) => string;
  pluginsValueLabel: (list: string) => string;
  pluginsNone: string;
  assignmentsValueLabel: (n: number) => string;
  assignmentsNone: string;

  // Project prompts (E4)
  projectPromptsIntro: string;
  projectPromptsAsk: string;
  projectPromptsSkip: string;
  projectPromptsRun: string;
  projectPromptsOptional: string;
  projectPromptsSkipNote: string;
  phaseGeneral: string;
  phaseSpecific: string;
  projectPromptSkipOption: string;

  // Init completeness warnings (P0-fix)
  qualityGateNotDetected: string;
  claudeEngineMissingWarning: string;

  // Agent role descriptions
  roleLeader: string;
  roleImplementer: string;
  roleReviewer: string;
  roleResearcher: string;
  roleTicketAudit: string;
  roleCommitPrPilot: string;
  roleExplorer: string;

  // Adoption mode
  existingInfraYesMode: string;
  existingInfraDetected: string;
  howToAdopt: string;
  coexistLabel: string;
  coexistHint: string;
  replaceLabel: string;
  replaceHint: string;
  replaceConfirm: string;
  backedUp: (n: number, path: string) => string;
  removedOriginals: (cwd: string) => string;

  // Outcomes
  doneExistingUntouched: string;
  done: string;
  doneSkippedRender: string;
  doneRunLater: string;
  harnessReady: string;
  preCommitHookPrompt: string;
  preCommitHookWritten: (path: string) => string;
  preCommitHookExists: (path: string) => string;

  // Errors / status
  dirNotFound: (dir: string) => string;
  configExists: (path: string) => string;
  cancelled: string;
  projectNameRequired: string;
  detectionFailedYes: string;
  wroteConfig: (path: string) => string;
  recPluginsEnabled: (list: string) => string;
  pluginsAlwaysOn: (list: string) => string;
  fullModeEnabled: string;
  fullBinariesToInstall: (list: string) => string;
  presetGapNotice: (stack: string) => string;
  placeholderNameNotice: (name: string) => string;

  // Workspace link (#76)
  wsLinkNoName: string;
  wsLinkCreated: (name: string) => string;
  wsLinkAdded: (repo: string, ws: string) => string;
  wsLinkUpdatedPath: (repo: string, from: string, to: string) => string;
  wsLinkUnchanged: (repo: string, ws: string) => string;
  wsLinkConfigSet: (name: string) => string;
  wsLinkConfigMismatch: (configWs: string, name: string) => string;
  workspaceNotFoundInit: (name: string) => string;

  // Note titles
  workspaceDefaultsTitle: (name: string) => string;
  detectedTitle: string;
  filesFoundTitle: string;

  // Detection summary (init-format)
  notDetectedAsk: string;
  defaultNoGit: string;
  foundInRepo: string;
  defaultNothing: string;
  suggested: string;
  assetDefaultEs: string;
  fromScripts: string;
  from: (src: string) => string;
  present: string;
  presentGitignored: string;
  filesCount: (n: number) => string;
  featuresCount: (n: number) => string;
  wsNoDefaults: string;
  noneEnabled: string;
}

const ES: Strings = {
  pickLanguage: "¿En qué idioma quieres el wizard?",
  pickLanguageEs: "Español (default)",
  pickLanguageEn: "English",
  useTheseValues: "¿Usar estos valores?",
  projectNameUndetectedAdjust: "No detecté el nombre del proyecto. ¿Ajustar?",
  whatToChange: "¿Qué quieres cambiar?",

  labelProjectName: "Nombre del proyecto",
  labelLanguage: "Idioma",
  labelWorkspace: "Workspace",
  labelEngines: "Engines",
  labelPreset: "Preset",
  labelBranchBase: "Branch base",
  labelQualityGate: "Quality gate",
  notDetectedParen: "(no detectado)",
  defaultParen: "default",

  projectNameKebab: "Nombre del proyecto (kebab-case)",
  mustBeKebab: "Debe ser kebab-case (minúsculas y guiones)",
  languageForAssets: "Idioma de los managed assets del core",
  assetEsLabel: "Español (default — cobertura completa)",
  assetEnLabel: "English (limitado — cae a español si el asset no está localizado)",
  workspaceOptional: "Workspace (opcional, ej: bonum, navori)",
  leaveEmpty: "vacío = ninguno",
  enginesToTarget: "Engines a generar",
  stackPresetFreeText: "Preset del stack (texto libre por ahora)",
  baseBranch: "Branch base",
  qualityGateFast: "Quality gate (fast — corre en Stop hook)",
  qualityGateFull: "Quality gate (full — corre antes de cerrar sesión)",
  pluginsToEnable: "Plugins a activar",
  renderNow: "¿Renderizar CLAUDE.md ahora?",
  useAssignments: "¿Usar estas asignaciones?",
  recommendedAssignments: "Asignaciones recomendadas skill → agente:",
  agentFor: (id, plugin) => `Agente para '${id}' (${plugin})`,

  previewTitle: "Resumen del config",
  previewAction: "¿Está bien?",
  saveAndContinue: "Sí, continuar",
  adjustSomething: "Ajustar algo",
  whatToEdit: "¿Qué quieres ajustar?",
  backToPreview: "← volver al resumen",
  cancelAndExit: "Cancelar y salir",
  editField: (label) => `Editar ${label}`,
  pluginsValueLabel: (list) => list,
  pluginsNone: "(ninguno)",
  assignmentsValueLabel: (n) => `${n} override(s)`,
  assignmentsNone: "(defaults)",

  projectPromptsIntro:
    "Ahora unas preguntas para afinar el harness a tu repo (lo que navori no puede detectar). Las respuestas se vuelven reglas activas que los agentes siguen.",
  projectPromptsAsk: "¿Quieres contestarlas ahora?",
  projectPromptsSkip: "Saltear (después con 'navori configure')",
  projectPromptsRun: "Contestar",
  projectPromptsOptional: "(opcional — deja vacío para omitir)",
  projectPromptsSkipNote:
    "Omití las preguntas de proyecto. Corre 'navori configure' cuando quieras llenarlas.",
  phaseGeneral: "Fase 1 · general — postura del repo",
  phaseSpecific: "Fase 2 · específica — reglas concretas",
  projectPromptSkipOption: "— sin preferencia / saltar —",

  qualityGateNotDetected:
    "No detecté quality gate en package.json. El harness va a mostrar 'quality gate sin configurar' donde iría el comando y el hook pre-commit no se va a generar. Corre 'navori configure quality-gate' o agrega scripts (`typecheck`, `lint`, `test`) en package.json y re-renderea.",
  claudeEngineMissingWarning:
    "Los engines elegidos no incluyen 'claude' — el harness no va a cargar en sesiones de Claude Code (CLAUDE.md/.claude/ no se generan). Agrega 'claude' a los engines si vas a usar Claude Code.",

  roleLeader: "leader (orquestador)",
  roleImplementer: "implementer (escribe código)",
  roleReviewer: "reviewer (revisa diff)",
  roleResearcher: "researcher (lee, no escribe)",
  roleTicketAudit: "ticket-audit (análisis profundo)",
  roleCommitPrPilot: "commit-pr-pilot (commits + PRs)",
  roleExplorer: "explorer (exploración inicial)",

  existingInfraYesMode: "Detecté infraestructura Claude — uso modo 'coexist' (seguro)",
  existingInfraDetected: "Detecté infraestructura Claude:",
  howToAdopt: "¿Cómo quieres adoptar navori?",
  coexistLabel: "Coexistir (recomendado)",
  coexistHint: "agrega lo que falta, no modifica lo existente",
  replaceLabel: "Reemplazar",
  replaceHint: "respalda todo a ~/.navori/migrations/<ts>/ y arranca limpio",
  replaceConfirm:
    "Esto moverá .claude/, CLAUDE.md, AGENTS.md, CHECKPOINTS.md, feature_list.json, progress/, specs/ a ~/.navori/migrations/. ¿Continuar?",
  backedUp: (n, path) => `Respaldé ${n} elemento(s) en ${path}`,
  removedOriginals: (cwd) => `Borré los originales de ${cwd}`,

  doneExistingUntouched:
    "Listo — archivos existentes intactos. Corre 'navori render --apply' cuando quieras.",
  done: "Listo",
  doneSkippedRender: "Listo (omití el render)",
  doneRunLater: "Listo (corre 'navori render --apply' cuando quieras)",
  harnessReady: "Tu harness está listo",
  preCommitHookPrompt:
    "¿Scaffoldear un pre-commit hook que corra 'navori doctor --strict'? (opt-in)",
  preCommitHookWritten: (path) =>
    `Pre-commit hook escrito en ${path} — sáltalo con 'git commit --no-verify'`,
  preCommitHookExists: (path) => `Ya existe un pre-commit hook en ${path} — no lo piso`,

  dirNotFound: (dir) => `Directorio no encontrado: ${dir}`,
  configExists: (path) =>
    `navori.config.json ya existe en ${path}. Para ponerte al día corre 'navori update'; ` +
    `para ajustar la config 'navori configure'; para re-renderizar 'navori render --apply'; ` +
    `para revisar el estado 'navori doctor'.`,
  cancelled: "Cancelado",
  projectNameRequired: "Hace falta el nombre del proyecto",
  detectionFailedYes:
    "No detecté el nombre del proyecto. Corre sin --yes/--recommended para darlo.",
  wroteConfig: (path) => `Escribí ${path}`,
  recPluginsEnabled: (list) => `Plugins recomendados activados: ${list}`,
  pluginsAlwaysOn: (list) => `Incluidos siempre con navori: ${list} (no hace falta elegirlos)`,
  fullModeEnabled:
    "Modo full: todos los plugins + pre-commit hook + scan-monorepo + project block estricto (posture/reviewRigor/testsForNewCode).",
  fullBinariesToInstall: (list) =>
    `Faltan binarios de plugins activados (los hooks de esos plugins no corren hasta instalarlos; 'navori doctor' los reporta como advertencia): ${list}`,
  presetGapNotice: (stack) =>
    `Detecté un proyecto '${stack}', pero todavía no hay un preset oficial para ese stack. ` +
    `Se instala el harness completo (agentes, gates, protocolo, SDD) y funciona desde ya; ` +
    `lo único que falta son skills específicas de '${stack}'. Quedas con el baseline (preset: custom). ` +
    `Para cubrir el hueco: crea tu preset local con 'navori preset init ${stack}', o agrega skills ` +
    `sueltas en project.localSkills.`,
  placeholderNameNotice: (name) =>
    `El name '${name}' parece un placeholder de scaffold (heredado del package.json sin renombrar). ` +
    `Renómbralo en package.json o edita "name" en navori.config.json si no es el nombre real del repo.`,

  wsLinkNoName:
    "Este repo no tiene 'workspace' en navori.config.json. Pasa el nombre: 'navori workspace link <name>'.",
  wsLinkCreated: (name) =>
    `El workspace '${name}' no existía en esta máquina — lo creé en ~/.navori/workspaces/${name}/.`,
  wsLinkAdded: (repo, ws) => `Registré '${repo}' en el workspace '${ws}'.`,
  wsLinkUpdatedPath: (repo, from, to) =>
    `Actualicé la ruta de '${repo}': ${from} → ${to} (la anterior era de otra máquina o quedó vieja).`,
  wsLinkUnchanged: (repo, ws) =>
    `'${repo}' ya estaba registrado en '${ws}' con esta ruta — nada que hacer.`,
  wsLinkConfigSet: (name) => `workspace → '${name}' guardado en navori.config.json`,
  wsLinkConfigMismatch: (configWs, name) =>
    `El config apunta al workspace '${configWs}' pero vinculaste '${name}'. Si el cambio es ` +
    `permanente corre 'navori configure workspace ${name}'.`,
  workspaceNotFoundInit: (name) =>
    `El workspace '${name}' no existe en esta máquina. Créalo con 'navori workspace init ${name}', ` +
    `o corre el init sin --workspace y después 'navori workspace link ${name}' para crearlo y ` +
    `registrar este repo.`,

  workspaceDefaultsTitle: (name) => `Defaults del workspace · ${name}`,
  detectedTitle: "Detectado en este repo",
  filesFoundTitle: "Archivos encontrados",

  notDetectedAsk: "(no detectado — voy a preguntar)",
  defaultNoGit: "(default — no detecté git)",
  foundInRepo: "(encontrado en el repo)",
  defaultNothing: "(default — no detecté nada)",
  suggested: "(sugerido)",
  assetDefaultEs: "(default — cámbialo en el wizard si necesitas 'en')",
  fromScripts: "(de scripts en package.json)",
  from: (src) => `(de ${src})`,
  present: "presente",
  presentGitignored: "presente (gitignored)",
  filesCount: (n) => `${n} archivo(s)`,
  featuresCount: (n) => `${n} feature(s)`,
  wsNoDefaults: "(el workspace no tiene defaults configurados)",
  noneEnabled: "(ninguno activado)",
};

const EN: Strings = {
  pickLanguage: "Which language do you want the wizard in?",
  pickLanguageEs: "Español",
  pickLanguageEn: "English (default)",
  useTheseValues: "Use these values?",
  projectNameUndetectedAdjust: "Project name could not be detected. Adjust?",
  whatToChange: "What do you want to change?",

  labelProjectName: "Project name",
  labelLanguage: "Language",
  labelWorkspace: "Workspace",
  labelEngines: "Engines",
  labelPreset: "Preset",
  labelBranchBase: "Base branch",
  labelQualityGate: "Quality gate",
  notDetectedParen: "(not detected)",
  defaultParen: "default",

  projectNameKebab: "Project name (kebab-case)",
  mustBeKebab: "Must be kebab-case (lowercase, hyphens)",
  languageForAssets: "Language for managed Core assets",
  assetEsLabel: "Español (full coverage)",
  assetEnLabel: "English (limited — falls back to es if asset not localized)",
  workspaceOptional: "Workspace (optional, e.g. bonum, navori)",
  leaveEmpty: "leave empty for none",
  enginesToTarget: "Engines to target",
  stackPresetFreeText: "Stack preset (free text for v1)",
  baseBranch: "Base branch",
  qualityGateFast: "Quality gate (fast — runs on Stop hook)",
  qualityGateFull: "Quality gate (full — runs before close session)",
  pluginsToEnable: "Plugins to enable",
  renderNow: "Render CLAUDE.md now?",
  useAssignments: "Use these assignments?",
  recommendedAssignments: "Recommended skill → agent assignments:",
  agentFor: (id, plugin) => `Agent for '${id}' (${plugin})`,

  previewTitle: "Config summary",
  previewAction: "Does this look right?",
  saveAndContinue: "Yes, continue",
  adjustSomething: "Adjust something",
  whatToEdit: "What do you want to adjust?",
  backToPreview: "← back to summary",
  cancelAndExit: "Cancel and exit",
  editField: (label) => `Edit ${label}`,
  pluginsValueLabel: (list) => list,
  pluginsNone: "(none)",
  assignmentsValueLabel: (n) => `${n} override(s)`,
  assignmentsNone: "(defaults)",

  projectPromptsIntro:
    "A few questions to tune the harness to your repo (what navori can't detect). Answers become active rules the agents follow.",
  projectPromptsAsk: "Answer them now?",
  projectPromptsSkip: "Skip (run 'navori configure' later)",
  projectPromptsRun: "Answer",
  projectPromptsOptional: "(optional — leave empty to skip)",
  projectPromptsSkipNote:
    "Skipped project prompts. Run 'navori configure' when you want to fill them.",
  phaseGeneral: "Phase 1 · general — repo posture",
  phaseSpecific: "Phase 2 · specific — concrete rules",
  projectPromptSkipOption: "— no preference / skip —",

  qualityGateNotDetected:
    "No quality gate detected in package.json. The harness will show 'quality gate sin configurar' where the command would go and the pre-commit hook will not be generated. Run 'navori configure quality-gate' or add scripts (`typecheck`, `lint`, `test`) to package.json and re-render.",
  claudeEngineMissingWarning:
    "Selected engines don't include 'claude' — the harness will not load in Claude Code sessions (CLAUDE.md/.claude/ won't be generated). Add 'claude' to engines if you plan to use Claude Code.",

  roleLeader: "leader (orchestrator)",
  roleImplementer: "implementer (writes code)",
  roleReviewer: "reviewer (reviews diff)",
  roleResearcher: "researcher (reads, doesn't write)",
  roleTicketAudit: "ticket-audit (deep analysis)",
  roleCommitPrPilot: "commit-pr-pilot (commits + PRs)",
  roleExplorer: "explorer (initial exploration)",

  existingInfraYesMode: "Existing Claude infrastructure detected — using 'coexist' mode (safe)",
  existingInfraDetected: "Existing Claude infrastructure detected:",
  howToAdopt: "How do you want to adopt navori?",
  coexistLabel: "Coexist (recommended)",
  coexistHint: "add what's missing, never modify existing files",
  replaceLabel: "Replace",
  replaceHint: "backup everything to ~/.navori/migrations/<ts>/ and start fresh",
  replaceConfirm:
    "This will move .claude/, CLAUDE.md, AGENTS.md, CHECKPOINTS.md, feature_list.json, progress/, specs/ to ~/.navori/migrations/. Continue?",
  backedUp: (n, path) => `Backed up ${n} item(s) to ${path}`,
  removedOriginals: (cwd) => `Removed originals from ${cwd}`,

  doneExistingUntouched:
    "Done — existing files not touched. Run 'navori render --apply' when ready.",
  done: "Done",
  doneSkippedRender: "Done (skipped render)",
  doneRunLater: "Done (run 'navori render --apply' when ready)",
  harnessReady: "Your harness is ready",
  preCommitHookPrompt: "Scaffold a pre-commit hook that runs 'navori doctor --strict'? (opt-in)",
  preCommitHookWritten: (path) =>
    `Pre-commit hook written to ${path} — bypass with 'git commit --no-verify'`,
  preCommitHookExists: (path) => `A pre-commit hook already exists at ${path} — leaving it alone`,

  dirNotFound: (dir) => `Directory not found: ${dir}`,
  configExists: (path) =>
    `navori.config.json already exists at ${path}. Run 'navori update' to catch up; ` +
    `'navori configure' to tweak config; 'navori render --apply' to re-render; ` +
    `'navori doctor' to inspect state.`,
  cancelled: "Cancelled",
  projectNameRequired: "Project name is required",
  detectionFailedYes:
    "Could not detect project name. Run without --yes/--recommended to provide one.",
  wroteConfig: (path) => `Wrote ${path}`,
  recPluginsEnabled: (list) => `Recommended plugins enabled: ${list}`,
  pluginsAlwaysOn: (list) => `Always included with navori: ${list} (no need to pick them)`,
  fullModeEnabled:
    "Full mode: all plugins + pre-commit hook + monorepo scan + strict project block (posture/reviewRigor/testsForNewCode).",
  fullBinariesToInstall: (list) =>
    `Enabled plugins are missing their binaries (their hooks won't run until installed; 'navori doctor' reports them as a warning): ${list}`,
  presetGapNotice: (stack) =>
    `Detected a '${stack}' project, but there's no official preset for that stack yet. ` +
    `The full harness installs (agents, gates, protocol, SDD) and works right away; ` +
    `the only thing missing are '${stack}'-specific skills. You stay on the baseline (preset: custom). ` +
    `To cover the gap: scaffold your local preset with 'navori preset init ${stack}', or add ` +
    `individual skills via project.localSkills.`,
  placeholderNameNotice: (name) =>
    `The name '${name}' looks like a scaffold placeholder (carried over from an un-renamed package.json). ` +
    `Rename it in package.json or edit "name" in navori.config.json if it isn't the repo's real name.`,

  wsLinkNoName:
    "This repo has no 'workspace' in navori.config.json. Pass the name: 'navori workspace link <name>'.",
  wsLinkCreated: (name) =>
    `Workspace '${name}' did not exist on this machine — created it at ~/.navori/workspaces/${name}/.`,
  wsLinkAdded: (repo, ws) => `Registered '${repo}' in workspace '${ws}'.`,
  wsLinkUpdatedPath: (repo, from, to) =>
    `Updated path for '${repo}': ${from} → ${to} (the previous one belonged to another machine or went stale).`,
  wsLinkUnchanged: (repo, ws) =>
    `'${repo}' was already registered in '${ws}' with this path — nothing to do.`,
  wsLinkConfigSet: (name) => `workspace → '${name}' saved to navori.config.json`,
  wsLinkConfigMismatch: (configWs, name) =>
    `The config points at workspace '${configWs}' but you linked '${name}'. If the change is ` +
    `permanent, run 'navori configure workspace ${name}'.`,
  workspaceNotFoundInit: (name) =>
    `Workspace '${name}' does not exist on this machine. Create it with 'navori workspace init ${name}', ` +
    `or run init without --workspace and then 'navori workspace link ${name}' to create it and ` +
    `register this repo.`,

  workspaceDefaultsTitle: (name) => `Workspace defaults · ${name}`,
  detectedTitle: "Detected from this repo",
  filesFoundTitle: "Files found",

  notDetectedAsk: "(not detected — will ask)",
  defaultNoGit: "(default — no git detected)",
  foundInRepo: "(found in repo)",
  defaultNothing: "(default — nothing detected)",
  suggested: "(suggested)",
  assetDefaultEs: "(default — change in wizard if you need 'en' fallback)",
  fromScripts: "(from package.json scripts)",
  from: (src) => `(from ${src})`,
  present: "present",
  presentGitignored: "present (gitignored)",
  filesCount: (n) => `${n} file(s)`,
  featuresCount: (n) => `${n} feature(s)`,
  wsNoDefaults: "(workspace has no defaults configured)",
  noneEnabled: "(none enabled)",
};

const DICTS: Record<Lang, Strings> = { es: ES, en: EN };

export function t(lang: Lang): Strings {
  return DICTS[lang];
}

export const SUPPORTED_LANGS: readonly Lang[] = ["es", "en"];

/** Default locale when a config has none (or an unknown forward-compat value). */
export const DEFAULT_LANG: Lang = "es";

/**
 * Coerce an arbitrary value (typically `config.language`) into a supported
 * `Lang`, falling back to `DEFAULT_LANG`. `config.language` is normally already
 * `"es" | "en"`, but the tolerant schema preserves a forward-compat string a
 * newer navori may have written (e.g. `"fr"`) — this keeps runtime output on a
 * locale we actually ship instead of indexing an undefined catalog.
 */
export function resolveLang(value: unknown): Lang {
  return value === "es" || value === "en" ? value : DEFAULT_LANG;
}

/* ------------------------------------------------------------------------- *
 * Command output catalog
 *
 * Separate from the wizard `Strings` above so each concern stays small. Same
 * rule: every key lives in BOTH locales, so a missing translation is a compile
 * error, never a silent English fallback. Callers resolve the locale from
 * `config.language` via `tc(resolveLang(config.language))`.
 *
 * What is deliberately NOT here: short status tokens (created / updated /
 * unchanged / written) and structural labels (`Plan [root]`, field names) — a
 * compact, language-neutral vocabulary shared across locales (see lib/style.ts
 * renderStatusLabel). The `--json` output also bypasses this catalog entirely:
 * its keys are machine-readable and stable in English.
 * ------------------------------------------------------------------------- */

interface CommonCmdStrings {
  dirNotFound: (dir: string) => string;
  noConfig: (configPath: string) => string;
  backupLabel: string;
  aborted: string;
}

interface RenderCmdStrings {
  renderFailed: string;
  rootLabel: string;
  workspaceLabel: string;
  engineLabel: string;
  engineFilesTitle: string;
  langFallback: (list: string) => string;
  langFallbackWs: (ws: string, list: string) => string;
  wouldWrite: string;
  noChangePreview: string;
  written: string;
  noChanges: string;
  adapterMissing: (engine: string) => string;
  orphanedWorkspaces: (count: number, list: string) => string;
  downgradeWarning: (args: { count: number; newest: string; ids: string }) => string;
  previewWord: string;
  previewHint: string;
  upToDate: string;
  upToDateHint: string;
  doneWord: string;
}

interface SyncCmdStrings {
  workspaceRequiresMonorepo: string;
  workspaceNotFound: (name: string, known: string) => string;
  upToDate: string;
  dryRunComplete: (summary: string) => string;
  conflictsWithYes: (count: number, lines: string) => string;
  fileConflictsRemain: (count: number) => string;
  conflictPrompt: (count: number) => string;
  optSkipConflicts: string;
  optInteractive: string;
  optAbort: string;
  applyChanges: string;
  planTitle: (label: string) => string;
  updatesAvailableTitle: string;
  conflictHeader: (label: string, id: string) => string;
  conflictDiffLegend: string;
  conflictChoice: (id: string) => string;
  optKeepMine: string;
  optAcceptNew: string;
  wroteFiles: (n: number) => string;
  doneWord: string;
  writtenToken: (n: number) => string;
  conflictKeptToken: (n: number) => string;
}

interface DoctorCmdStrings {
  noConfigRunInit: (configPath: string) => string;
  configNoteTitle: (configPath: string) => string;
  fsChecksTitle: string;
  managedBlocksTitle: (n: number) => string;
  noVersion: string;
  unknownSource: string;
  assignmentsTitle: (n: number) => string;
  overridden: string;
  missingPlugins: (n: number, lines: string) => string;
  missingPreset: (preset: string) => string;
  presetOverride: (preset: string) => string;
  placeholderName: (name: string) => string;
  missingPresetFiles: (preset: string, n: number, lines: string) => string;
  missingPresetFileRow: (path: string) => string;
  missingLocalSkills: (n: number, lines: string) => string;
  missingLocalSkillRow: (id: string) => string;
  excludedBlocksTitle: (n: number) => string;
  excludedBlockRow: (id: string) => string;
  nonExcludableBlocks: (n: number, lines: string) => string;
  nonExcludableBlockRow: (id: string) => string;
  unknownExcludedBlocks: (n: number, lines: string) => string;
  unknownExcludedBlockRow: (id: string) => string;
  driftContentRow: (source: string) => string;
  driftVersionSuffix: (source: string) => string;
  drift: (n: number, hint: string, lines: string) => string;
  driftHintContent: string;
  driftHintVersion: string;
  corruptedSettings: (n: number, lines: string) => string;
  corruptedSettingsRow: (error: string) => string;
  missingInvariants: (n: number, lines: string) => string;
  missingInvariantRow: (source: string) => string;
  malformedMarkers: (n: number, lines: string) => string;
  legacyAgents: (n: number, lines: string) => string;
  legacyAgentRow: (canonical: string) => string;
  externalTools: (n: number, lines: string) => string;
  externalToolRow: (binary: string, how: string) => string;
  externalToolFallbackHow: string;
  optionalTools: (n: number, lines: string) => string;
  optionalToolRow: (binaries: string, how: string) => string;
  monorepoEmptyDeclared: string;
  monorepoAddedRow: string;
  monorepoOrphanRow: string;
  monorepoDrift: (n: number, lines: string) => string;
  wsLinkMissing: (workspace: string) => string;
  wsLinkNotRegistered: (workspace: string) => string;
  wsLinkPathMismatch: (repoName: string, workspace: string, registeredPath: string) => string;
  orderInterleaved: (current: string, expected: string, spotlight: string) => string;
  orderReorderable: (current: string, expected: string, spotlight: string) => string;
  orderSpotlight: (id: string, pos: number, total: number) => string;
  nextStepsTitle: string;
  outroIssues: string;
  outroDriftStrict: string;
  outroOk: string;
  codexConfigMalformed: string;
  codexHookNotExecutable: (hook: string) => string;
  codexVersionWarning: (found: string, min: string) => string;
  codexHookTrustHint: string;
  codexGuardNotVersioned: (guards: string) => string;
}

/**
 * Warnings and skip-reasons surfaced by the engine adapters (claude / codex /
 * prose spine). Before C5 these were hardcoded in Spanish, so a `language:"en"`
 * repo got an English CLAUDE.md but Spanish warnings. Routed through
 * `tc(resolveLang(config.language)).engine.*` at every call site.
 */
interface EngineCmdStrings {
  // Skip reasons (shared spine + adapter overrides)
  managedBlockEditedByHand: string;
  blockFromNewerNavori: (version: string | undefined) => string;
  subBlockEditedByHand: (skillId: string, pluginId: string) => string;
  subBlockFromNewerNavori: (skillId: string, version: string | undefined) => string;
  // Write failures
  renderFailedWriting: (
    engineLabel: string | undefined,
    destPath: string,
    detail: string,
  ) => string;
  backupAvailableAt: (path: string) => string;
  // Prose spine omissions (non-Claude engines)
  proseNoClaudeInfra: string;
  prosePluginBlocksOmitted: (list: string) => string;
  proseModelAssignmentOmitted: string;
  // Claude adapter
  managedBlocksOutOfOrder: string;
  qualityGateHookSkipped: string;
  settingsParseFailed: (detail: string) => string;
  settingsNotObject: string;
  pluginSkillNotInjected: (skillId: string, pluginId: string, target: string) => string;
  // Codex adapter
  pluginLoadFailedCodex: (id: string, reason: string) => string;
  codexTrustHint: string;
  presetNotFoundCodex: (preset: string) => string;
  presetInvalid: (preset: string, detail: string) => string;
}

interface UpdateCmdStrings {
  detectedMigrationSuggestion: (legacy: string, preferred: string) => string;
  manualMigrationOverride: (detail: string) => string;
  upToDate: string;
  configDrift: (count: number, lines: string) => string;
  configInSync: string;
  rehomedLibraries: string;
  deadProgressKeys: (keys: string) => string;
  filesToUpdate: (count: number, lines: string, more: string) => string;
  moreFiles: (count: number) => string;
  managedUpdates: (count: number, lines: string) => string;
  conflicts: (count: number) => string;
  libraryPreviewNote: string;
  dryRunComplete: string;
  applyChanges: string;
  configUpdated: (path: string) => string;
  configOnlyDone: string;
  renderAfterConfigFailed: string;
  renderFailed: string;
  doneRenderFailed: string;
  conflictsKept: (count: number) => string;
  rerendered: (count: number) => string;
  noRenderNeeded: string;
  done: string;
}

interface AddCmdStrings {
  pluginRequired: string;
  none: string;
  unknownPlugin: (id: string, known: string) => string;
  alreadyEnabled: (id: string) => string;
  added: (id: string, path: string) => string;
  doneRender: string;
  externalAlreadyInstalled: (name: string) => string;
  externalSkipped: (name: string) => string;
  doneInstallLater: string;
  noInstallCommand: (platform: string, name: string) => string;
  done: string;
  installPrompt: (name: string, command: string) => string;
  externalNotInstalled: (name: string) => string;
  installing: (name: string, command: string) => string;
  postInstall: (command: string) => string;
  installed: (name: string) => string;
  installFailed: (message: string) => string;
  registeredInstallFailed: string;
  installTimeout: (seconds: number) => string;
  commandKilled: (signal: string) => string;
  commandExited: (status: number | null) => string;
  suggestedPreset: (stack: string, preset: string, current: string) => string;
  suggestedEngram: string;
  nothingToSuggest: string;
  suggestionsTitle: string;
  suggestionsOutro: string;
}

interface ScanCmdStrings {
  noConfig: (path: string) => string;
  notMonorepo: (path: string) => string;
  noPatterns: string;
  nothingToScan: string;
  orphaned: (count: number) => string;
  configCurrent: string;
  addWorkspaces: (count: number) => string;
  cancelled: string;
  unexpectedResult: (kind: string) => string;
  added: (count: number, path: string) => string;
  renderHint: string;
  summaryTitle: string;
  newWorkspacesTitle: string;
  orphanedTitle: string;
  useSuggestedPresets: string;
  presetFor: (path: string) => string;
  inheritRoot: string;
}

interface ConfigureCmdStrings {
  pluginsPrompt: string;
  cancelled: string;
  enabled: (ids: string) => string;
  disabled: (ids: string) => string;
  engramAlwaysOn: string;
  noChanges: string;
  renderOrSyncHint: string;
  fastGatePrompt: string;
  fullGatePrompt: string;
  bothGatesRequired: string;
  qualityGateUpdated: string;
  done: string;
  languagePrompt: string;
  languageEs: string;
  languageEn: string;
  invalidLanguage: (value: string) => string;
  languageUpdated: (value: string) => string;
  languageRenderHint: string;
  branchBasePrompt: string;
  branchRequired: string;
  branchBaseUpdated: (value: string) => string;
  branchBaseRenderHint: string;
  prTargetPrompt: string;
  prTargetUpdated: (value: string) => string;
  prTargetSame: (value: string) => string;
  prTargetRenderHint: string;
  enginesPrompt: string;
  enginesUpdated: (values: string) => string;
  noWorkspace: string;
  removeWorkspacePrompt: (name: string) => string;
  aborted: string;
  workspaceRemoved: string;
  workspaceRemovedDone: string;
  workspaceUpdated: (value: string) => string;
  workspaceLinkHint: string;
  blocksPrompt: string;
  blocksUpdated: (values: string) => string;
  blocksCleared: string;
  blocksRenderHint: string;
}

interface WorkspaceCmdStrings {
  invalidName: (name: string) => string;
  alreadyExistsAt: (name: string, path: string) => string;
  descriptionPrompt: string;
  descriptionPlaceholder: string;
  cancelled: string;
  wrote: (path: string) => string;
  ticketsDirectory: (path: string) => string;
  initHint: (name: string) => string;
  noneFound: string;
  done: string;
  repoCount: (count: number) => string;
  invalidManifest: string;
  workspaceCount: (count: number) => string;
  notFoundAt: (name: string, path: string) => string;
  createHint: (name: string) => string;
  listHint: string;
  reposTitle: string;
  nameCollision: (lines: string) => string;
  placeholderNames: (lines: string) => string;
  sameName: string;
  notFound: (name: string) => string;
  alreadyExists: (name: string) => string;
  renameSummary: (count: number) => string;
  renameRepoWarning: (from: string, to: string) => string;
  renamePrompt: (from: string, to: string) => string;
  aborted: string;
  renamed: (path: string) => string;
  deleteSummary: (path: string, count: number) => string;
  deletePrompt: (name: string) => string;
  movedToTrash: (path: string) => string;
  repoAlreadyRegistered: (repo: string, workspace: string) => string;
  existingDirectoryHint: (message: string) => string;
  registeredRepo: (repo: string, path: string) => string;
  defaultApplyFailed: string;
  defaultSet: (key: string, path: string) => string;
  noRepos: string;
  doneWithErrors: string;
  preview: string;
}

interface StatusCmdStrings {
  nextRender: string;
  nextMissingPlugins: (count: number) => string;
  nextContentDrift: string;
  nextVersionDrift: string;
  nextReorder: string;
  nextInterleaved: (lead: string) => string;
  nextInterleavedLead: (id: string, pos: number, total: number) => string;
  nextLegacyAgents: (count: number, names: string) => string;
  allCurrent: string;
  none: string;
  present: string;
  missing: string;
  statusTitle: (cwd: string) => string;
  nextStepsTitle: string;
  issuesFound: string;
  ok: string;
}

interface GlobalCmdStrings {
  notInstalled: string;
  initReinit: (dir: string) => string;
  initDone: (dir: string) => string;
  renderApplied: (dir: string) => string;
  previewTitle: string;
  previewHint: string;
  wroteHook: (path: string) => string;
  wroteSettings: (path: string) => string;
  baselineBlocks: (ids: string) => string;
  doctorTitle: (dir: string) => string;
  hookPresent: string;
  hookMissing: string;
  settingsRegistered: string;
  settingsNotRegistered: string;
  versionOk: (v: string) => string;
  versionDrift: (found: string, expected: string) => string;
  hooksDisabledHint: string;
  uninstallNothing: string;
  uninstallDone: (dir: string) => string;
  outroOk: string;
  outroIssues: string;
}

interface DominioCmdStrings {
  noWorkspace: string;
  ambiguous: (names: string) => string;
  initDone: (dir: string) => string;
  initExists: (dir: string) => string;
  listEmpty: (ws: string) => string;
  listTitle: (ws: string, count: number) => string;
  readHint: string;
  showNotFound: (id: string) => string;
  reindexDone: (count: number, path: string) => string;
  doctorTitle: (ws: string) => string;
  doctorClean: string;
  outroOk: string;
  outroIssues: (count: number) => string;
  injectHeader: (ws: string) => string;
  injectHint: string;
}

interface CmdStrings {
  common: CommonCmdStrings;
  render: RenderCmdStrings;
  sync: SyncCmdStrings;
  doctor: DoctorCmdStrings;
  update: UpdateCmdStrings;
  add: AddCmdStrings;
  scan: ScanCmdStrings;
  configure: ConfigureCmdStrings;
  workspace: WorkspaceCmdStrings;
  status: StatusCmdStrings;
  engine: EngineCmdStrings;
  global: GlobalCmdStrings;
  dominio: DominioCmdStrings;
}

const CMD_ES: CmdStrings = {
  common: {
    dirNotFound: (dir) => `Directorio no encontrado: ${dir}`,
    noConfig: (path) => `No hay navori.config.json en ${path}. Corre 'navori init' primero.`,
    backupLabel: "Backup:",
    aborted: "Abortado",
  },
  render: {
    renderFailed: "El render falló",
    rootLabel: "root",
    workspaceLabel: "workspace",
    engineLabel: "engine",
    engineFilesTitle: "Engine files:",
    langFallback: (list) =>
      `Fallback a español para: ${list} (versión en inglés aún no disponible)`,
    langFallbackWs: (ws, list) =>
      `[${ws}] Fallback a español para: ${list} (versión en inglés aún no disponible)`,
    wouldWrite: "→ preview (se escribiría)",
    noChangePreview: "→ sin cambios",
    written: "→ written",
    noChanges: "→ no changes",
    adapterMissing: (engine) =>
      `El engine '${engine}' todavía no tiene adapter en navori; se omitió.`,
    orphanedWorkspaces: (count, list) =>
      `Workspaces declarados en config pero ausentes en disco (${count}) — ` +
      `no se renderizaron (evita resucitar dirs borrados). Corre 'navori scan' o quita del config:\n${list}`,
    downgradeWarning: ({ count, newest, ids }) =>
      `Tu CLI está detrás del repo: ${count} bloque(s) los escribió una navori más nueva ` +
      `(hasta ${newest}). Los preservé sin tocar para no degradarlos. ` +
      `Actualiza tu CLI para volver a gestionarlos: npm i -g navori@latest\n  ${ids}`,
    previewWord: "Preview",
    previewHint: "corre 'navori render --apply' para escribir",
    upToDate: "Al día",
    upToDateHint: "nada que aplicar",
    doneWord: "Done",
  },
  sync: {
    workspaceRequiresMonorepo:
      "--workspace requiere un monorepo con workspaces declarados; este config no tiene. Corre 'navori scan' primero.",
    workspaceNotFound: (name, known) => `Workspace '${name}' no encontrado. Conocidos: ${known}`,
    upToDate: "Al día — sin cambios",
    dryRunComplete: (summary) => `Dry-run completo${summary ? ` — ${summary}` : ""}`,
    conflictsWithYes: (count, lines) =>
      `Se detectaron ${count} conflict(s) con --yes. Resuélvelos a mano o corre 'sync --apply' sin --yes para el flujo interactivo.\n${lines}`,
    fileConflictsRemain: (count) =>
      `${count} conflicto(s) en archivos .claude/ se mantienen — la resolución interactiva cubre CLAUDE.md; resuelve los de .claude/ a mano y vuelve a correr sync.`,
    conflictPrompt: (count) => `Encontré ${count} conflict(s). ¿Qué hago?`,
    optSkipConflicts: "Aplicar los cambios sin conflict, dejar mis ediciones intactas",
    optInteractive: "Resolver uno por uno (ver diff, keep/accept)",
    optAbort: "Abortar — no escribir nada",
    applyChanges: "Aplicar cambios?",
    planTitle: (label) => `Plan [${label}]:`,
    updatesAvailableTitle: "Updates available:",
    conflictHeader: (label, id) => `Conflict [${label}] CLAUDE.md:${id}`,
    conflictDiffLegend: "(- tu edición, + renderizado)",
    conflictChoice: (id) => `${id}: ¿mantener tu edición o aceptar la nueva versión?`,
    optKeepMine: "Mantener la mía — se salta, tu edición queda",
    optAcceptNew: "Aceptar la nueva — sobrescribe con la versión renderizada",
    wroteFiles: (n) => `Escribí ${n} archivo(s)`,
    doneWord: "Done",
    writtenToken: (n) => `${n} written`,
    conflictKeptToken: (n) => `${n} conflict kept`,
  },
  doctor: {
    noConfigRunInit: (path) => `No hay navori.config.json en ${path}. Corre 'navori init' primero.`,
    configNoteTitle: (path) => `Config · ${path}`,
    fsChecksTitle: "Filesystem checks",
    managedBlocksTitle: (n) => `Bloques managed en CLAUDE.md · ${n}`,
    noVersion: "(sin versión)",
    unknownSource: "(fuente desconocida)",
    assignmentsTitle: (n) => `Skill → agente · ${n}`,
    overridden: "(override)",
    missingPlugins: (n, lines) =>
      `Plugins declarados en config pero no cargables (${n}):\n${lines}`,
    missingPreset: (preset) =>
      `Preset '${preset}' declarado en config pero no existe (ni local en ` +
      `.navori/presets/${preset}/ ni bundled) — el render cae al baseline (sin los ` +
      `extras del preset). Corre 'navori preset init ${preset}', 'navori configure', ` +
      `o usa un preset válido / 'custom'.`,
    presetOverride: (preset) =>
      `Preset local '${preset}' (.navori/presets/${preset}/) sombrea el preset ` +
      `oficial del mismo nombre — se usa el local. Renómbralo si el override no es intencional.`,
    placeholderName: (name) =>
      `El name '${name}' parece un placeholder de scaffold (probablemente heredado del ` +
      `package.json sin renombrar). Edita "name" en navori.config.json si no es el nombre real del repo.`,
    missingPresetFiles: (preset, n, lines) =>
      `Extras del preset '${preset}' sin archivo (${n}) — el render ` +
      `fallará al leerlos; créalos o quítalos del manifest:\n${lines}`,
    missingPresetFileRow: (path) => `— falta ${path}`,
    missingLocalSkills: (n, lines) =>
      `Skills project-local declarados sin archivo (${n}) — crea el .md (o <id>/SKILL.md) o quita el id de project.localSkills:\n${lines}`,
    missingLocalSkillRow: (id) => `— falta .claude/skills/${id}.md o ${id}/SKILL.md`,
    excludedBlocksTitle: (n) => `Bloques core excluidos · ${n} (blocks.exclude)`,
    excludedBlockRow: (_id) => `— no se renderiza; si existía, se quita en el próximo render`,
    nonExcludableBlocks: (n, lines) =>
      `Ids en blocks.exclude que NO son excluibles (${n}) — solo 'orquestacion' y ` +
      `'sdd' pueden excluirse; estos bloques se siguen renderizando. Quítalos de blocks.exclude:\n${lines}`,
    nonExcludableBlockRow: (id) => `— '${id}' no es excluible; el bloque permanece`,
    unknownExcludedBlocks: (n, lines) =>
      `Ids en blocks.exclude que no son bloques core conocidos (${n}) — ` +
      `probablemente un typo; no excluyen nada. Corrígelos o quítalos de blocks.exclude:\n${lines}`,
    unknownExcludedBlockRow: (id) => `— '${id}' no coincide con ningún bloque core`,
    driftContentRow: (source) => `(${source}, content edited)`,
    driftVersionSuffix: (source) => `(${source})`,
    drift: (n, hint, lines) => `Drift detectado (${n}) — ${hint}:\n${lines}`,
    driftHintContent:
      "corre 'navori sync' para resolver conflicts; 'navori render --apply' para actualizar versiones",
    driftHintVersion: "corre 'navori render --apply' o 'navori sync'",
    corruptedSettings: (n, lines) =>
      `Settings.json corrupto (${n}) — corre 'navori render --force --apply' para regenerar desde el bundle (el archivo actual se respalda):\n${lines}`,
    corruptedSettingsRow: (error) => `— JSON inválido: ${error}`,
    missingInvariants: (n, lines) =>
      `Invariantes ausentes en el output (${n}) — una regla load-bearing desapareció; corre 'navori render --apply' o revisa el template:\n${lines}`,
    missingInvariantRow: (source) => `— declarado por ${source}`,
    malformedMarkers: (n, lines) =>
      `Markers managed malformados (${n}) — a esta(s) línea(s) les falta el ` +
      `cierre '-->', así que navori ya no las reconoce; el próximo render appendearía un bloque ` +
      `duplicado y dejaría la línea rota. Restaura el '-->' (o borra la línea) a mano:\n${lines}`,
    legacyAgents: (n, lines) =>
      `Agentes legacy (${n}) — de un harness previo; navori ya provee sus ` +
      `equivalentes canónicos. No los toco (son tuyos), pero conviene archivarlos o borrarlos ` +
      `para no quedar con dos rosters en paralelo:\n${lines}`,
    legacyAgentRow: (canonical) => `→ superado por '${canonical}'`,
    externalTools: (n, lines) =>
      `Plugins habilitados con herramienta externa no instalada (${n}) — ` +
      `su protocolo/scan referencia algo que no está disponible en esta máquina:\n${lines}`,
    externalToolRow: (binary, how) => `— falta '${binary}' en PATH; ${how}`,
    externalToolFallbackHow: "instala la herramienta y reinicia Claude Code",
    optionalTools: (n, lines) =>
      `Herramientas opcionales no instaladas (${n}) — el harness funciona con fallback, ` +
      `pero pierde precisión en estos flujos:\n${lines}`,
    optionalToolRow: (binaries, how) =>
      `— falta ${binaries} en PATH; ${how}. Mientras tanto, structural-search cae a Grep`,
    monorepoEmptyDeclared:
      "monorepo declarado pero workspaces[] vacío — corre 'navori scan' para poblarlo",
    monorepoAddedRow: "— en disco, falta en config (corre 'navori scan')",
    monorepoOrphanRow: "— en config, ausente en disco (quítalo del config)",
    monorepoDrift: (n, lines) => `Monorepo desincronizado con el disco (${n}):\n${lines}`,
    wsLinkMissing: (workspace) =>
      `Workspace '${workspace}' referenciado en config pero no existe en ` +
      `~/.navori/workspaces/ — el registro de workspaces es local por máquina y no viaja ` +
      `con el repo. Corre 'navori workspace link' para crearlo y registrar este repo.`,
    wsLinkNotRegistered: (workspace) =>
      `Este repo no está registrado en el workspace '${workspace}' — corre ` +
      `'navori workspace link' para registrarlo.`,
    wsLinkPathMismatch: (repoName, workspace, registeredPath) =>
      `El repo '${repoName}' está registrado en el workspace '${workspace}' con ` +
      `otra ruta (${registeredPath}) — probablemente de otra máquina o una ruta vieja. ` +
      `Corre 'navori workspace link' para actualizarla.`,
    orderInterleaved: (current, expected, spotlight) =>
      `Bloques managed de CLAUDE.md fuera del orden canónico — NO se pueden reordenar ` +
      `automáticamente porque hay texto tuyo entre bloques. Mueve ese texto arriba del ` +
      `primer bloque managed o abajo del último; luego corre 'navori render --apply'.\n` +
      `  orden actual:   ${current}\n  orden canónico: ${expected}${spotlight}`,
    orderReorderable: (current, expected, spotlight) =>
      `Bloques managed de CLAUDE.md fuera del orden canónico — corre 'navori render --apply' ` +
      `o 'navori sync' para reordenarlos (el primer bloque marca el centro de gravedad del ` +
      `harness).\n  orden actual:   ${current}\n  orden canónico: ${expected}${spotlight}`,
    orderSpotlight: (id, pos, total) =>
      `\n  → '${id}' (centro de gravedad) está en posición ${pos} de ${total}, debería ir 1º.`,
    nextStepsTitle: "Próximos pasos",
    outroIssues: "Issues found",
    outroDriftStrict: "Drift detected (--strict)",
    outroOk: "OK",
    codexConfigMalformed:
      ".codex/config.toml: bloque managed desbalanceado (corre 'navori render --apply')",
    codexHookNotExecutable: (hook) => `${hook} sin bit ejecutable — Codex no lo dispara (chmod +x)`,
    codexVersionWarning: (found, min) => `codex ${found} < ${min} requerido`,
    codexHookTrustHint:
      "Codex solo dispara hooks en repos confiables: revísalos y autorízalos con '/hooks'",
    codexGuardNotVersioned: (guards) =>
      `${guards} sin versionar en git — en una sesión Codex abierta dentro de un git worktree el guard no corre; versiona '.codex/hooks/' (o '.codex/')`,
  },
  update: {
    detectedMigrationSuggestion: (legacy, preferred) =>
      `(detección sugiere ${legacy}→${preferred})`,
    manualMigrationOverride: (detail) =>
      `project.libraryMigrations: respeto tu override manual — ${detail}. No lo sobrescribo; edítalo a mano si quieres adoptar la sugerencia.`,
    upToDate: "Al día — nada que actualizar",
    configDrift: (count, lines) => `Drift de config detectado (${count}):\n${lines}`,
    configInSync: "El config está sincronizado con el repo",
    rehomedLibraries:
      "Moví las library skills por workspace a monorepo.workspaces[] (migración de scope)",
    deadProgressKeys: (keys) => `Claves obsoletas en "progress" que se limpiarán: ${keys}`,
    filesToUpdate: (count, lines, more) =>
      `Archivos que se actualizarían (${count}):\n${lines}${more}`,
    moreFiles: (count) => `… +${count} más`,
    managedUpdates: (count, lines) =>
      `Actualizaciones de bloques managed disponibles (${count}):\n${lines}`,
    conflicts: (count) =>
      `${count} archivo(s) con ediciones tuyas — 'navori sync' los resuelve interactivamente`,
    libraryPreviewNote:
      "Nota: aplicar el diff de project.libraries materializa las library skills (el preview de arriba refleja el config actual).",
    dryRunComplete: "Dry-run completo (no se escribió ningún archivo)",
    applyChanges: "¿Aplicar cambios de config y volver a renderizar?",
    configUpdated: (path) => `Config actualizado: ${path}`,
    configOnlyDone:
      "Config actualizado. Corre 'navori sync' para refrescar los archivos de los engines configurados.",
    renderAfterConfigFailed:
      "El render falló tras actualizar el config — revisa el backup y corre 'navori render --apply'",
    renderFailed: "El render falló",
    doneRenderFailed: "Listo (config actualizado, pero el render falló)",
    conflictsKept: (count) =>
      `${count} archivo(s) con ediciones tuyas no se tocaron — corre 'navori sync' para resolver`,
    rerendered: (count) =>
      `Volví a renderizar ${count} archivo(s) de los engines configurados, incluidos workspaces`,
    noRenderNeeded: "No fue necesario volver a renderizar",
    done: "Listo",
  },
  add: {
    pluginRequired:
      "Pasa un plugin id (ej. 'navori add engram') o usa --suggest para ver recomendaciones.",
    none: "(ninguno)",
    unknownPlugin: (id, known) => `Plugin desconocido '${id}'. Conocidos: ${known}`,
    alreadyEnabled: (id) => `'${id}' ya está habilitado en este config`,
    added: (id, path) => `Agregué '${id}' a ${path}`,
    doneRender: "Listo — corre 'navori render --apply' para aplicar",
    externalAlreadyInstalled: (name) => `La herramienta externa '${name}' ya está instalada`,
    externalSkipped: (name) =>
      `La herramienta externa '${name}' no está instalada. Se pidió --skip-install.`,
    doneInstallLater: "Listo — instálala manualmente después",
    noInstallCommand: (platform, name) =>
      `No hay comando de instalación para '${platform}'. Instala '${name}' manualmente.`,
    done: "Listo",
    installPrompt: (name, command) => `¿Instalar '${name}'? Se ejecutará: ${command}`,
    externalNotInstalled: (name) =>
      `La herramienta externa '${name}' no se instaló. Los hooks la omitirán sin ruido.`,
    installing: (name, command) => `Instalando ${name} — ${command}`,
    postInstall: (command) => `Post-instalación — ${command}`,
    installed: (name) => `Instalado ${name}`,
    installFailed: (message) => `Falló la instalación: ${message}`,
    registeredInstallFailed:
      "El plugin quedó registrado, pero falló la instalación de la herramienta externa. Instálala manualmente.",
    installTimeout: (seconds) =>
      `El comando de instalación agotó el tiempo después de ${seconds}s. Puede estar esperando entrada interactiva (ejecútalo en una TTY) o haberse colgado. Instala la herramienta manualmente y vuelve a correr navori con --skip-install.`,
    commandKilled: (signal) => `El comando terminó por la señal ${signal}`,
    commandExited: (status) => `El comando terminó con status ${status}`,
    suggestedPreset: (stack, preset, current) =>
      `Preset: detecté ${stack} → sugerido ${preset} (actual: ${current}) — cámbialo con 'navori configure' o edita navori.config.json.`,
    suggestedEngram: "Plugin engram: memoria persistente entre sesiones — 'navori add engram'.",
    nothingToSuggest:
      "Nada que sugerir — el preset coincide con el stack y engram ya está habilitado.",
    suggestionsTitle: "Sugerencias",
    suggestionsOutro: "Sugerencias, no aplicadas — corre 'navori add <id>' o 'navori configure'.",
  },
  scan: {
    noConfig: (path) => `No encontré navori.config.json en ${path}. Corre 'navori init' primero.`,
    notMonorepo: (path) =>
      `${path} no declara 'monorepo'. Edita el config para agregar { monorepo: { enabled: true, tool: '...' } } y vuelve a correr scan.`,
    noPatterns:
      "No encontré patrones de workspace en pnpm-workspace.yaml ni en package.json#workspaces.",
    nothingToScan: "Nada que escanear",
    orphaned: (count) =>
      `${count} workspace(s) en config ya no existen en disco. Edita navori.config.json para removerlos.`,
    configCurrent: "Config al día",
    addWorkspaces: (count) => `¿Agregar ${count} workspace(s) a navori.config.json?`,
    cancelled: "Cancelado",
    unexpectedResult: (kind) => `Resultado inesperado: ${kind}`,
    added: (count, path) => `Agregué ${count} workspace(s) a ${path}`,
    renderHint:
      "Corre 'navori render --apply' para generar los archivos de los engines por workspace",
    summaryTitle: "resumen",
    newWorkspacesTitle: "Workspaces nuevos:",
    orphanedTitle: "Huérfanos (en config, no existen en disco):",
    useSuggestedPresets: "¿Usar el preset sugerido en cada workspace nuevo?",
    presetFor: (path) => `Preset para ${path}`,
    inheritRoot: "(heredar del root)",
  },
  configure: {
    pluginsPrompt: "Plugins habilitados en este repo",
    cancelled: "Cancelado",
    enabled: (ids) => `Habilitados: ${ids}`,
    disabled: (ids) => `Deshabilitados: ${ids}`,
    engramAlwaysOn: "engram siempre está activo con navori — se mantuvo habilitado.",
    noChanges: "Sin cambios",
    renderOrSyncHint: "Corre 'navori render --apply' o 'navori sync' para aplicar.",
    fastGatePrompt: "Comando del gate rápido (corre en el hook Stop)",
    fullGatePrompt: "Comando del gate completo (corre antes de cerrar la sesión)",
    bothGatesRequired: "Se requieren los comandos fast y full",
    qualityGateUpdated: "qualityGate actualizado",
    done: "Listo",
    languagePrompt: "Idioma de los assets Core administrados",
    languageEs: "Español (predeterminado — cobertura completa)",
    languageEn: "Inglés (limitado — usa español como fallback)",
    invalidLanguage: (value) => `Idioma inválido '${value}'. Debe ser 'es' o 'en'.`,
    languageUpdated: (value) => `language → ${value}`,
    languageRenderHint:
      "Corre 'navori render --apply' para volver a renderizar los bloques managed en el nuevo idioma.",
    branchBasePrompt: "Rama base contra la que comparan los gates (semgrep / jscpd)",
    branchRequired: "El nombre de la rama no puede estar vacío",
    branchBaseUpdated: (value) => `branchBase → ${value}`,
    branchBaseRenderHint: "Corre 'navori render --apply' para actualizar los scripts de gates.",
    prTargetPrompt: "Rama destino de los PR (gh pr create --base)",
    prTargetUpdated: (value) => `prTarget → ${value}`,
    prTargetSame: (value) => `Igual que branchBase — los PR siguen apuntando a ${value}.`,
    prTargetRenderHint: "Corre 'navori render --apply' para actualizar las skills de PR.",
    enginesPrompt: "Engines objetivo",
    enginesUpdated: (values) => `engines → ${values}`,
    noWorkspace: "No hay workspace asociado. Nada que quitar.",
    removeWorkspacePrompt: (name) =>
      `¿Quitar la asociación con el workspace '${name}'? Esto solo desconecta el repo de los comandos de workspace (tickets cross-repo, 'navori workspace render'); no afecta los archivos renderizados.`,
    aborted: "Abortado",
    workspaceRemoved: "Asociación con workspace eliminada",
    workspaceRemovedDone: "Listo. Los archivos renderizados no cambiaron.",
    workspaceUpdated: (value) => `workspace → ${value}`,
    workspaceLinkHint:
      "Corre 'navori workspace link' para registrar este repo en el registro local del workspace.",
    blocksPrompt: "Bloques Core managed a EXCLUIR (marcado = fuera de CLAUDE.md)",
    blocksUpdated: (values) => `blocks.exclude → ${values}`,
    blocksCleared: "blocks.exclude limpio — se renderizan todos los bloques Core",
    blocksRenderHint:
      "Corre 'navori render --apply' o 'navori sync' para aplicar (los bloques excluidos se eliminan).",
  },
  workspace: {
    invalidName: (name) => `El nombre del workspace debe estar en kebab-case: ${name}`,
    alreadyExistsAt: (name, path) => `El workspace '${name}' ya existe en ${path}`,
    descriptionPrompt: "Descripción del workspace (opcional)",
    descriptionPlaceholder: "ej. Plataforma Bonum — multi-repo",
    cancelled: "Cancelado",
    wrote: (path) => `Escribí ${path}`,
    ticketsDirectory: (path) => `Directorio de tickets: ${path}`,
    initHint: (name) =>
      `Corre 'navori workspace show ${name}' para inspeccionarlo, o agrégalo a un repo con 'navori init --workspace ${name}'.`,
    noneFound: "No encontré workspaces. Crea uno con 'navori workspace init <name>'.",
    done: "Listo",
    repoCount: (count) => `${count} repo${count === 1 ? "" : "s"}`,
    invalidManifest: "(manifest inválido)",
    workspaceCount: (count) => `${count} workspace${count === 1 ? "" : "s"}`,
    notFoundAt: (name, path) => `Workspace '${name}' no encontrado en ${path}.`,
    createHint: (name) => `Créalo con: navori workspace init ${name}`,
    listHint: "O lista los workspaces conocidos: navori workspace ls",
    reposTitle: "Repos:",
    nameCollision: (lines) =>
      `Colisión de name entre repos (mismo config.name) — renómbralos en su package.json / navori.config.json para que cada repo tenga identidad única:\n${lines}`,
    placeholderNames: (lines) => `Names placeholder (scaffold sin renombrar):\n${lines}`,
    sameName: "Los nombres de origen y destino son iguales",
    notFound: (name) => `Workspace '${name}' no encontrado`,
    alreadyExists: (name) =>
      `El workspace '${name}' ya existe. Elige otro nombre o elimínalo primero.`,
    renameSummary: (count) =>
      `Se renombrará el directorio del workspace y el campo 'name' del manifest. Se conservarán ${count} registro(s) de repo y sus tickets.`,
    renameRepoWarning: (from, to) =>
      `Los repos con 'workspace: ${from}' en navori.config.json deben actualizarse manualmente: entra a cada repo y corre 'navori configure workspace ${to}'.`,
    renamePrompt: (from, to) => `¿Renombrar el workspace '${from}' a '${to}'?`,
    aborted: "Abortado",
    renamed: (path) => `Renombrado. Nueva ruta: ${path}`,
    deleteSummary: (path, count) =>
      `Se moverá ${path} a ~/.navori/.trash/. Incluye ${count} registro(s) de repo y sus tickets.`,
    deletePrompt: (name) => `¿Eliminar el workspace '${name}'?`,
    movedToTrash: (path) => `Movido a ${path}. Restáuralo manualmente si hace falta.`,
    repoAlreadyRegistered: (repo, workspace) =>
      `El repo '${repo}' ya está registrado en el workspace '${workspace}'`,
    existingDirectoryHint: (message) =>
      `${message}. Pasa un directorio existente (absoluto o relativo al cwd).`,
    registeredRepo: (repo, path) => `Registré '${repo}' (${path})`,
    defaultApplyFailed: "No se pudo aplicar el default",
    defaultSet: (key, path) => `Definí ${key} (${path})`,
    noRepos: "No hay repos registrados. Agrega uno con 'navori workspace add-repo'.",
    doneWithErrors: "Listo con errores",
    preview: "Preview",
  },
  status: {
    nextRender:
      "Corre 'navori render --apply' para generar los archivos de los engines configurados.",
    nextMissingPlugins: (count) =>
      `Resuelve ${count} plugin(s) faltante(s): instálalos o quítalos del config.`,
    nextContentDrift: "Corre 'navori sync --interactive' para resolver bloques editados a mano.",
    nextVersionDrift: "Corre 'navori render --apply' para traer los bloques a la última versión.",
    nextReorder:
      "Corre 'navori render --apply' para reordenar los bloques de CLAUDE.md al orden canónico.",
    nextInterleaved: (lead) =>
      `Mueve el texto que tienes entre bloques managed de CLAUDE.md arriba del primer bloque o abajo del último${lead}; luego corre 'navori render --apply' para reordenarlos.`,
    nextInterleavedLead: (id, pos, total) =>
      ` (p.ej. '${id}' está en posición ${pos} de ${total} y debería ir 1º)`,
    nextLegacyAgents: (count, names) =>
      `Archiva o borra ${count} agente(s) legacy (${names}); navori ya provee sus equivalentes canónicos.`,
    allCurrent: "Todo al día — sin acciones pendientes.",
    none: "(ninguno)",
    present: "presente",
    missing: "faltante",
    statusTitle: (cwd) => `Estado · ${cwd}`,
    nextStepsTitle: "Próximos pasos",
    issuesFound: "Se encontraron problemas",
    ok: "OK",
  },
  engine: {
    managedBlockEditedByHand:
      "bloque managed editado por el usuario; resuelve con 'navori sync' o ajusta el destino a mano",
    blockFromNewerNavori: (v) =>
      `bloque escrito por una navori más nueva (${v ?? "?"}); no lo toqué. Actualiza tu CLI: npm i -g navori@latest`,
    subBlockEditedByHand: (id, pid) =>
      `sub-bloque '${id}' (de @navori/plugin-${pid}) editado por el usuario; resuelve con 'navori sync'`,
    subBlockFromNewerNavori: (id, v) =>
      `sub-bloque '${id}' escrito por una navori más nueva (${v ?? "?"}); no lo toqué. Actualiza tu CLI`,
    renderFailedWriting: (label, path, detail) =>
      `${label ? `El render ${label} falló` : "El render falló"} escribiendo ${path}: ${detail}`,
    backupAvailableAt: (path) => ` Backup pre-escritura disponible en: ${path}`,
    proseNoClaudeInfra:
      "No replica la infraestructura específica de Claude Code: orquestación de subagentes " +
      "(Agent tool), hooks (quality-gate/guard-destructive) y reglas de permisos. Configúralos en " +
      "tu herramienta si las necesitas.",
    prosePluginBlocksOmitted: (list) =>
      `Bloques de plugins omitidos por asumir infraestructura de Claude Code: ${list}.`,
    proseModelAssignmentOmitted:
      "La asignación de modelo por agente (config.models) no aplica fuera de Claude Code; se omitió.",
    managedBlocksOutOfOrder:
      "CLAUDE.md: los bloques managed están fuera del orden canónico, pero hay texto tuyo intercalado " +
      "entre bloques, así que no los reordené. Mueve ese texto arriba del primer bloque managed o abajo " +
      "del último para que navori pueda ordenarlos.",
    qualityGateHookSkipped: "quality-gate hook omitido: config.qualityGate.fast no está definido",
    settingsParseFailed: (detail) =>
      `settings.json no se pudo parsear como JSON: ${detail}. Corre 'navori render --force --apply' para regenerar.`,
    settingsNotObject:
      "settings.json no es un objeto JSON — no se puede fusionar. Corre 'navori render --force --apply' para regenerar.",
    pluginSkillNotInjected: (id, pid, target) =>
      `skill '${id}' (de @navori/plugin-${pid}) no inyectado: target ${target} ausente (¿agente disabled en config.harness?)`,
    pluginLoadFailedCodex: (id, reason) => `Plugin '${id}' no pudo cargarse para Codex: ${reason}.`,
    codexTrustHint:
      "Requiere Codex CLI >= 0.145.0. Codex solo carga `.codex/` en repos confiables; revisa y autoriza " +
      "los hooks nuevos con `/hooks`.",
    presetNotFoundCodex: (preset) => `Preset '${preset}' no encontrado; Codex usará solo el core.`,
    presetInvalid: (preset, detail) => `Preset '${preset}' inválido: ${detail}`,
  },
  global: {
    notInstalled: "El harness global no está instalado. Corre 'navori global init'.",
    initReinit: (dir) => `Harness global ya inicializado en ${dir}; regenerando.`,
    initDone: (dir) => `Harness global instalado en ${dir}.`,
    renderApplied: (dir) => `Baseline global renderizado en ${dir}.`,
    previewTitle: "Se escribiría",
    previewHint: "Corre con --apply para escribir.",
    wroteHook: (path) => `hook: ${path}`,
    wroteSettings: (path) => `settings: ${path}`,
    baselineBlocks: (ids) => `Bloques del baseline: ${ids}`,
    doctorTitle: (dir) => `Harness global en ${dir}`,
    hookPresent: "hook de baseline presente",
    hookMissing: "hook de baseline ausente — corre 'navori global render --apply'",
    settingsRegistered: "registrado en settings.json (SessionStart)",
    settingsNotRegistered: "no registrado en settings.json — corre 'navori global render --apply'",
    versionOk: (v) => `versión ${v}`,
    versionDrift: (found, expected) =>
      `versión ${found} < ${expected} del CLI — corre 'navori global render --apply'`,
    hooksDisabledHint:
      "recuerda: si deshabilitaste los hooks de Claude Code, el baseline no se inyecta",
    uninstallNothing: "No hay harness global que desinstalar.",
    uninstallDone: (dir) => `Harness global desinstalado de ${dir}.`,
    outroOk: "OK",
    outroIssues: "Revisa lo anterior",
  },
  dominio: {
    noWorkspace:
      "Este directorio no pertenece a ningún workspace. Pasa --workspace <nombre> o corre desde un repo registrado.",
    ambiguous: (names) =>
      `El directorio pertenece a varios workspaces (${names}). Especifica --workspace <nombre>.`,
    initDone: (dir) => `Dominio creado en ${dir}.`,
    initExists: (dir) => `El Dominio ya existe en ${dir}.`,
    listEmpty: (ws) => `El Dominio de '${ws}' no tiene entradas todavía.`,
    listTitle: (ws, count) => `Dominio de '${ws}' — ${count} entrada(s)`,
    readHint: "Lee una entrada completa con 'navori dominio show <id>'.",
    showNotFound: (id) => `No existe la entrada '${id}' en el Dominio.`,
    reindexDone: (count, path) => `Índice reconstruido (${count} entrada(s)): ${path}`,
    doctorTitle: (ws) => `Dominio de '${ws}'`,
    doctorClean: "Dominio consistente.",
    outroOk: "OK",
    outroIssues: (count) => `${count} aviso(s) — revisa lo anterior`,
    injectHeader: (ws) =>
      `## Dominio del workspace '${ws}' — conocimiento canónico transversal a los repos`,
    injectHint:
      "Consulta estas entradas antes de asumir modelo de datos o reglas de negocio; abre el archivo completo cuando necesites el detalle.",
  },
};

const CMD_EN: CmdStrings = {
  common: {
    dirNotFound: (dir) => `Directory not found: ${dir}`,
    noConfig: (path) => `No navori.config.json at ${path}. Run 'navori init' first.`,
    backupLabel: "Backup:",
    aborted: "Aborted",
  },
  render: {
    renderFailed: "Render failed",
    rootLabel: "root",
    workspaceLabel: "workspace",
    engineLabel: "engine",
    engineFilesTitle: "Engine files:",
    langFallback: (list) =>
      `Language fallback to Spanish for: ${list} (English version not available yet)`,
    langFallbackWs: (ws, list) =>
      `[${ws}] Language fallback to Spanish for: ${list} (English version not available yet)`,
    wouldWrite: "→ preview (would write)",
    noChangePreview: "→ no changes",
    written: "→ written",
    noChanges: "→ no changes",
    adapterMissing: (engine) => `The '${engine}' engine has no navori adapter yet; skipped.`,
    orphanedWorkspaces: (count, list) =>
      `Workspaces declared in config but missing on disk (${count}) — ` +
      `not rendered (avoids resurrecting deleted dirs). Run 'navori scan' or remove them from config:\n${list}`,
    downgradeWarning: ({ count, newest, ids }) =>
      `Your CLI is behind the repo: ${count} block(s) were written by a newer navori ` +
      `(up to ${newest}). They were preserved untouched to avoid downgrading them. ` +
      `Update your CLI to manage them again: npm i -g navori@latest\n  ${ids}`,
    previewWord: "Preview",
    previewHint: "run 'navori render --apply' to write",
    upToDate: "Up to date",
    upToDateHint: "nothing to apply",
    doneWord: "Done",
  },
  sync: {
    workspaceRequiresMonorepo:
      "--workspace requires a monorepo with declared workspaces; this config has none. Run 'navori scan' first.",
    workspaceNotFound: (name, known) => `Workspace '${name}' not found. Known: ${known}`,
    upToDate: "Up to date — no changes",
    dryRunComplete: (summary) => `Dry-run complete${summary ? ` — ${summary}` : ""}`,
    conflictsWithYes: (count, lines) =>
      `${count} conflict(s) detected with --yes. Resolve them by hand or run 'sync --apply' without --yes for the interactive flow.\n${lines}`,
    fileConflictsRemain: (count) =>
      `${count} conflict(s) in .claude/ files remain — interactive resolution covers CLAUDE.md; resolve the .claude/ ones by hand and re-run sync.`,
    conflictPrompt: (count) => `Found ${count} conflict(s). What do you want to do?`,
    optSkipConflicts: "Apply the non-conflicting changes, keep my edits intact",
    optInteractive: "Resolve one by one (see diff, keep/accept)",
    optAbort: "Abort — write nothing",
    applyChanges: "Apply changes?",
    planTitle: (label) => `Plan [${label}]:`,
    updatesAvailableTitle: "Updates available:",
    conflictHeader: (label, id) => `Conflict [${label}] CLAUDE.md:${id}`,
    conflictDiffLegend: "(- your edit, + rendered)",
    conflictChoice: (id) => `${id}: keep your edit or accept the new version?`,
    optKeepMine: "Keep mine — skip, your edit stays",
    optAcceptNew: "Accept new — overwrite with the rendered version",
    wroteFiles: (n) => `Wrote ${n} file(s)`,
    doneWord: "Done",
    writtenToken: (n) => `${n} written`,
    conflictKeptToken: (n) => `${n} conflict kept`,
  },
  doctor: {
    noConfigRunInit: (path) => `No navori.config.json at ${path}. Run 'navori init' first.`,
    configNoteTitle: (path) => `Config · ${path}`,
    fsChecksTitle: "Filesystem checks",
    managedBlocksTitle: (n) => `Managed blocks in CLAUDE.md · ${n}`,
    noVersion: "(no version)",
    unknownSource: "(unknown source)",
    assignmentsTitle: (n) => `Skill → agent assignments · ${n}`,
    overridden: "(overridden)",
    missingPlugins: (n, lines) => `Plugins declared in config but not loadable (${n}):\n${lines}`,
    missingPreset: (preset) =>
      `Preset '${preset}' declared in config but does not exist (neither local in ` +
      `.navori/presets/${preset}/ nor bundled) — render falls back to the baseline (without the ` +
      `preset extras). Run 'navori preset init ${preset}', 'navori configure', ` +
      `or use a valid preset / 'custom'.`,
    presetOverride: (preset) =>
      `Local preset '${preset}' (.navori/presets/${preset}/) shadows the official preset ` +
      `of the same name — the local one is used. Rename it if the override is unintentional.`,
    placeholderName: (name) =>
      `The name '${name}' looks like a scaffold placeholder (probably carried over from an ` +
      `un-renamed package.json). Edit "name" in navori.config.json if it isn't the repo's real name.`,
    missingPresetFiles: (preset, n, lines) =>
      `Extras of preset '${preset}' with no file (${n}) — render ` +
      `will fail reading them; create or remove them from the manifest:\n${lines}`,
    missingPresetFileRow: (path) => `— missing ${path}`,
    missingLocalSkills: (n, lines) =>
      `Project-local skills declared with no file (${n}) — create the .md (or <id>/SKILL.md) or remove the id from project.localSkills:\n${lines}`,
    missingLocalSkillRow: (id) => `— missing .claude/skills/${id}.md or ${id}/SKILL.md`,
    excludedBlocksTitle: (n) => `Excluded core blocks · ${n} (blocks.exclude)`,
    excludedBlockRow: (_id) => `— not rendered; removed on next render if it was present`,
    nonExcludableBlocks: (n, lines) =>
      `Ids in blocks.exclude that are NOT excludable (${n}) — only 'orquestacion' ` +
      `and 'sdd' can be excluded; these blocks still render. Drop them from blocks.exclude:\n${lines}`,
    nonExcludableBlockRow: (id) => `— '${id}' is not excludable; the block stays`,
    unknownExcludedBlocks: (n, lines) =>
      `Ids in blocks.exclude that are not known core blocks (${n}) — ` +
      `likely a typo; they exclude nothing. Fix or drop them from blocks.exclude:\n${lines}`,
    unknownExcludedBlockRow: (id) => `— '${id}' matches no core block`,
    driftContentRow: (source) => `(${source}, content edited)`,
    driftVersionSuffix: (source) => `(${source})`,
    drift: (n, hint, lines) => `Drift detected (${n}) — ${hint}:\n${lines}`,
    driftHintContent:
      "run 'navori sync' to resolve conflicts; 'navori render --apply' to update versions",
    driftHintVersion: "run 'navori render --apply' or 'navori sync'",
    corruptedSettings: (n, lines) =>
      `Corrupted settings.json (${n}) — run 'navori render --force --apply' to regenerate from the bundle (the current file is backed up):\n${lines}`,
    corruptedSettingsRow: (error) => `— invalid JSON: ${error}`,
    missingInvariants: (n, lines) =>
      `Invariants missing from the output (${n}) — a load-bearing rule disappeared; run 'navori render --apply' or check the template:\n${lines}`,
    missingInvariantRow: (source) => `— declared by ${source}`,
    malformedMarkers: (n, lines) =>
      `Malformed managed markers (${n}) — these line(s) are missing the ` +
      `closing '-->', so navori no longer recognizes them; the next render would append a ` +
      `duplicate block and leave the line broken. Restore the '-->' (or delete the line) by hand:\n${lines}`,
    legacyAgents: (n, lines) =>
      `Legacy agents (${n}) — from a previous harness; navori already provides their ` +
      `canonical equivalents. It doesn't touch them (they're yours), but archiving or deleting them ` +
      `avoids running two parallel rosters:\n${lines}`,
    legacyAgentRow: (canonical) => `→ superseded by '${canonical}'`,
    externalTools: (n, lines) =>
      `Enabled plugins with an uninstalled external tool (${n}) — ` +
      `their protocol/scan references something not available on this machine:\n${lines}`,
    externalToolRow: (binary, how) => `— missing '${binary}' in PATH; ${how}`,
    externalToolFallbackHow: "install the tool and restart Claude Code",
    optionalTools: (n, lines) =>
      `Optional tools not installed (${n}) — the harness keeps working with a fallback, ` +
      `but loses precision in these flows:\n${lines}`,
    optionalToolRow: (binaries, how) =>
      `— missing ${binaries} in PATH; ${how}. Until then, structural-search falls back to Grep`,
    monorepoEmptyDeclared:
      "monorepo declared but workspaces[] empty — run 'navori scan' to populate it",
    monorepoAddedRow: "— on disk, missing in config (run 'navori scan')",
    monorepoOrphanRow: "— in config, missing on disk (remove it from config)",
    monorepoDrift: (n, lines) => `Monorepo out of sync with disk (${n}):\n${lines}`,
    wsLinkMissing: (workspace) =>
      `Workspace '${workspace}' referenced in config but does not exist in ` +
      `~/.navori/workspaces/ — the workspace registry is machine-local and does not travel ` +
      `with the repo. Run 'navori workspace link' to create it and register this repo.`,
    wsLinkNotRegistered: (workspace) =>
      `This repo is not registered in workspace '${workspace}' — run ` +
      `'navori workspace link' to register it.`,
    wsLinkPathMismatch: (repoName, workspace, registeredPath) =>
      `Repo '${repoName}' is registered in workspace '${workspace}' with ` +
      `a different path (${registeredPath}) — probably from another machine or a stale path. ` +
      `Run 'navori workspace link' to update it.`,
    orderInterleaved: (current, expected, spotlight) =>
      `CLAUDE.md managed blocks out of canonical order — they can NOT be reordered ` +
      `automatically because there is text of yours between blocks. Move that text above the ` +
      `first managed block or below the last; then run 'navori render --apply'.\n` +
      `  current order:   ${current}\n  canonical order: ${expected}${spotlight}`,
    orderReorderable: (current, expected, spotlight) =>
      `CLAUDE.md managed blocks out of canonical order — run 'navori render --apply' ` +
      `or 'navori sync' to reorder them (the first block marks the harness's center of ` +
      `gravity).\n  current order:   ${current}\n  canonical order: ${expected}${spotlight}`,
    orderSpotlight: (id, pos, total) =>
      `\n  → '${id}' (center of gravity) is at position ${pos} of ${total}, should be 1st.`,
    nextStepsTitle: "Next steps",
    outroIssues: "Issues found",
    outroDriftStrict: "Drift detected (--strict)",
    outroOk: "OK",
    codexConfigMalformed:
      ".codex/config.toml: unbalanced managed block (run 'navori render --apply')",
    codexHookNotExecutable: (hook) =>
      `${hook} missing executable bit — Codex won't fire it (chmod +x)`,
    codexVersionWarning: (found, min) => `codex ${found} < ${min} required`,
    codexHookTrustHint:
      "Codex only fires hooks in trusted repos: review them and authorize with '/hooks'",
    codexGuardNotVersioned: (guards) =>
      `${guards} not versioned in git — in a Codex session opened inside a git worktree the guard won't run; version '.codex/hooks/' (or '.codex/')`,
  },
  update: {
    detectedMigrationSuggestion: (legacy, preferred) =>
      `(detection suggests ${legacy}→${preferred})`,
    manualMigrationOverride: (detail) =>
      `project.libraryMigrations: keeping your manual override — ${detail}. It will not be overwritten; edit it manually to adopt the detected suggestion.`,
    upToDate: "Up to date — nothing to update",
    configDrift: (count, lines) => `Config drift detected (${count}):\n${lines}`,
    configInSync: "Config is in sync with the repo",
    rehomedLibraries:
      "Re-homed per-workspace library skills onto monorepo.workspaces[] (scoping migration)",
    deadProgressKeys: (keys) => `Obsolete "progress" keys to remove: ${keys}`,
    filesToUpdate: (count, lines, more) =>
      `Files that would be updated (${count}):\n${lines}${more}`,
    moreFiles: (count) => `… +${count} more`,
    managedUpdates: (count, lines) => `Managed block updates available (${count}):\n${lines}`,
    conflicts: (count) =>
      `${count} file(s) have your edits — 'navori sync' resolves them interactively`,
    libraryPreviewNote:
      "Note: applying the project.libraries diff materializes library skills (the preview above reflects the current config).",
    dryRunComplete: "Dry-run complete (no files written)",
    applyChanges: "Apply config changes and re-render?",
    configUpdated: (path) => `Updated ${path}`,
    configOnlyDone:
      "Config updated. Run 'navori sync' to refresh files for the configured engines.",
    renderAfterConfigFailed:
      "Render failed after updating the config — inspect the backup and run 'navori render --apply'",
    renderFailed: "Render failed",
    doneRenderFailed: "Done (config updated, but render failed)",
    conflictsKept: (count) =>
      `${count} file(s) with your edits were left untouched — run 'navori sync' to resolve`,
    rerendered: (count) => `Re-rendered ${count} configured-engine file(s), including workspaces`,
    noRenderNeeded: "No re-render needed",
    done: "Done",
  },
  add: {
    pluginRequired:
      "Pass a plugin id (e.g. 'navori add engram') or use --suggest to see recommendations.",
    none: "(none)",
    unknownPlugin: (id, known) => `Unknown plugin '${id}'. Known: ${known}`,
    alreadyEnabled: (id) => `'${id}' is already enabled in this config`,
    added: (id, path) => `Added '${id}' to ${path}`,
    doneRender: "Done — run 'navori render --apply' to apply",
    externalAlreadyInstalled: (name) => `External tool '${name}' is already installed`,
    externalSkipped: (name) =>
      `External tool '${name}' is not installed. --skip-install was requested.`,
    doneInstallLater: "Done — install it manually later",
    noInstallCommand: (platform, name) =>
      `No install command for platform '${platform}'. Install '${name}' manually.`,
    done: "Done",
    installPrompt: (name, command) => `Install '${name}'? This will run: ${command}`,
    externalNotInstalled: (name) =>
      `External tool '${name}' was not installed. Hooks will skip it silently.`,
    installing: (name, command) => `Installing ${name} — ${command}`,
    postInstall: (command) => `Post-install — ${command}`,
    installed: (name) => `Installed ${name}`,
    installFailed: (message) => `Install failed: ${message}`,
    registeredInstallFailed:
      "The plugin was registered, but the external tool installation failed. Install it manually.",
    installTimeout: (seconds) =>
      `Install command timed out after ${seconds}s. It may be waiting for interactive input (run it from a TTY) or be hung. Install the tool manually and re-run navori with --skip-install.`,
    commandKilled: (signal) => `Command killed by signal ${signal}`,
    commandExited: (status) => `Command exited with status ${status}`,
    suggestedPreset: (stack, preset, current) =>
      `Preset: detected ${stack} → suggested ${preset} (current: ${current}) — change it with 'navori configure' or edit navori.config.json.`,
    suggestedEngram: "Plugin engram: persistent memory across sessions — 'navori add engram'.",
    nothingToSuggest:
      "Nothing to suggest — the preset matches the stack and engram is already enabled.",
    suggestionsTitle: "Suggestions",
    suggestionsOutro:
      "Suggestions only, not applied — run 'navori add <id>' or 'navori configure'.",
  },
  scan: {
    noConfig: (path) => `No navori.config.json found at ${path}. Run 'navori init' first.`,
    notMonorepo: (path) =>
      `${path} does not declare 'monorepo'. Add { monorepo: { enabled: true, tool: '...' } } to the config and run scan again.`,
    noPatterns: "No workspace patterns found in pnpm-workspace.yaml or package.json#workspaces.",
    nothingToScan: "Nothing to scan",
    orphaned: (count) =>
      `${count} workspace(s) in config no longer exist on disk. Edit navori.config.json to remove them.`,
    configCurrent: "Config is up to date",
    addWorkspaces: (count) => `Add ${count} workspace(s) to navori.config.json?`,
    cancelled: "Cancelled",
    unexpectedResult: (kind) => `Unexpected result: ${kind}`,
    added: (count, path) => `Added ${count} workspace(s) to ${path}`,
    renderHint: "Run 'navori render --apply' to generate engine files for each workspace",
    summaryTitle: "summary",
    newWorkspacesTitle: "New workspaces:",
    orphanedTitle: "Orphans (in config, missing on disk):",
    useSuggestedPresets: "Use the suggested preset for every new workspace?",
    presetFor: (path) => `Preset for ${path}`,
    inheritRoot: "(inherit from root)",
  },
  configure: {
    pluginsPrompt: "Plugins enabled in this repo",
    cancelled: "Cancelled",
    enabled: (ids) => `Enabled: ${ids}`,
    disabled: (ids) => `Disabled: ${ids}`,
    engramAlwaysOn: "engram is always on with navori — kept enabled.",
    noChanges: "No changes",
    renderOrSyncHint: "Run 'navori render --apply' or 'navori sync' to apply.",
    fastGatePrompt: "Fast gate command (runs on the Stop hook)",
    fullGatePrompt: "Full gate command (runs before closing the session)",
    bothGatesRequired: "Both fast and full commands are required",
    qualityGateUpdated: "qualityGate updated",
    done: "Done",
    languagePrompt: "Language for managed Core assets",
    languageEs: "Spanish (default — full coverage)",
    languageEn: "English (limited — falls back to Spanish)",
    invalidLanguage: (value) => `Invalid language '${value}'. Must be 'es' or 'en'.`,
    languageUpdated: (value) => `language → ${value}`,
    languageRenderHint:
      "Run 'navori render --apply' to re-render managed blocks in the new language.",
    branchBasePrompt: "Base branch that gates (semgrep / jscpd) diff against",
    branchRequired: "Branch name cannot be empty",
    branchBaseUpdated: (value) => `branchBase → ${value}`,
    branchBaseRenderHint: "Run 'navori render --apply' to update the gate scripts.",
    prTargetPrompt: "Branch PRs open against (gh pr create --base)",
    prTargetUpdated: (value) => `prTarget → ${value}`,
    prTargetSame: (value) => `Same as branchBase — PRs still target ${value}.`,
    prTargetRenderHint: "Run 'navori render --apply' to update the PR skills.",
    enginesPrompt: "Target engines",
    enginesUpdated: (values) => `engines → ${values}`,
    noWorkspace: "No workspace associated. Nothing to remove.",
    removeWorkspacePrompt: (name) =>
      `Remove workspace association '${name}'? This only detaches the repo from workspace commands (cross-repo tickets, 'navori workspace render'); rendered files are not affected.`,
    aborted: "Aborted",
    workspaceRemoved: "Workspace association removed",
    workspaceRemovedDone: "Done. Rendered files are unaffected.",
    workspaceUpdated: (value) => `workspace → ${value}`,
    workspaceLinkHint:
      "Run 'navori workspace link' to register this repo in the workspace's local registry.",
    blocksPrompt: "Core managed blocks to EXCLUDE (checked = omitted from CLAUDE.md)",
    blocksUpdated: (values) => `blocks.exclude → ${values}`,
    blocksCleared: "blocks.exclude cleared — all Core blocks render",
    blocksRenderHint:
      "Run 'navori render --apply' or 'navori sync' to apply (excluded blocks are removed).",
  },
  workspace: {
    invalidName: (name) => `Workspace name must be kebab-case: ${name}`,
    alreadyExistsAt: (name, path) => `Workspace '${name}' already exists at ${path}`,
    descriptionPrompt: "Workspace description (optional)",
    descriptionPlaceholder: "e.g. Bonum platform — multi-repo",
    cancelled: "Cancelled",
    wrote: (path) => `Wrote ${path}`,
    ticketsDirectory: (path) => `Tickets directory: ${path}`,
    initHint: (name) =>
      `Run 'navori workspace show ${name}' to inspect it, or add it to a repo with 'navori init --workspace ${name}'.`,
    noneFound: "No workspaces found. Create one with 'navori workspace init <name>'.",
    done: "Done",
    repoCount: (count) => `${count} repo${count === 1 ? "" : "s"}`,
    invalidManifest: "(invalid manifest)",
    workspaceCount: (count) => `${count} workspace${count === 1 ? "" : "s"}`,
    notFoundAt: (name, path) => `Workspace '${name}' not found at ${path}.`,
    createHint: (name) => `Create it with: navori workspace init ${name}`,
    listHint: "Or list known workspaces: navori workspace ls",
    reposTitle: "Repos:",
    nameCollision: (lines) =>
      `Repo name collision (same config.name) — rename them in package.json / navori.config.json so every repo has a unique identity:\n${lines}`,
    placeholderNames: (lines) => `Placeholder names (scaffold not renamed):\n${lines}`,
    sameName: "Source and destination names are the same",
    notFound: (name) => `Workspace '${name}' not found`,
    alreadyExists: (name) =>
      `Workspace '${name}' already exists. Choose a different name or delete it first.`,
    renameSummary: (count) =>
      `The workspace directory and manifest 'name' field will be renamed. ${count} repo registration(s) and all tickets will be preserved.`,
    renameRepoWarning: (from, to) =>
      `Repos with 'workspace: ${from}' in navori.config.json must be updated manually: enter each repo and run 'navori configure workspace ${to}'.`,
    renamePrompt: (from, to) => `Rename workspace '${from}' to '${to}'?`,
    aborted: "Aborted",
    renamed: (path) => `Renamed. New path: ${path}`,
    deleteSummary: (path, count) =>
      `This will move ${path} to ~/.navori/.trash/. It includes ${count} repo registration(s) and all tickets.`,
    deletePrompt: (name) => `Delete workspace '${name}'?`,
    movedToTrash: (path) => `Moved to ${path}. Restore it manually if needed.`,
    repoAlreadyRegistered: (repo, workspace) =>
      `Repo '${repo}' is already registered in workspace '${workspace}'`,
    existingDirectoryHint: (message) =>
      `${message}. Pass an existing directory (absolute or relative to cwd).`,
    registeredRepo: (repo, path) => `Registered '${repo}' (${path})`,
    defaultApplyFailed: "Could not apply default",
    defaultSet: (key, path) => `Set ${key} (${path})`,
    noRepos: "No repos registered. Add one with 'navori workspace add-repo'.",
    doneWithErrors: "Done with errors",
    preview: "Preview",
  },
  status: {
    nextRender: "Run 'navori render --apply' to generate files for the configured engines.",
    nextMissingPlugins: (count) =>
      `Resolve ${count} missing plugin(s): install them or remove them from the config.`,
    nextContentDrift: "Run 'navori sync --interactive' to resolve manually edited blocks.",
    nextVersionDrift: "Run 'navori render --apply' to update blocks to the latest version.",
    nextReorder: "Run 'navori render --apply' to reorder CLAUDE.md blocks into canonical order.",
    nextInterleaved: (lead) =>
      `Move your text between managed CLAUDE.md blocks above the first block or below the last${lead}; then run 'navori render --apply' to reorder them.`,
    nextInterleavedLead: (id, pos, total) =>
      ` (e.g. '${id}' is at position ${pos} of ${total} and should be 1st)`,
    nextLegacyAgents: (count, names) =>
      `Archive or delete ${count} legacy agent(s) (${names}); navori already provides their canonical replacements.`,
    allCurrent: "Everything is up to date — no pending actions.",
    none: "(none)",
    present: "present",
    missing: "missing",
    statusTitle: (cwd) => `Status · ${cwd}`,
    nextStepsTitle: "Next steps",
    issuesFound: "Issues found",
    ok: "OK",
  },
  engine: {
    managedBlockEditedByHand:
      "managed block edited by hand; resolve with 'navori sync' or adjust the destination manually",
    blockFromNewerNavori: (v) =>
      `block written by a newer navori (${v ?? "?"}); left untouched. Update your CLI: npm i -g navori@latest`,
    subBlockEditedByHand: (id, pid) =>
      `sub-block '${id}' (from @navori/plugin-${pid}) edited by hand; resolve with 'navori sync'`,
    subBlockFromNewerNavori: (id, v) =>
      `sub-block '${id}' written by a newer navori (${v ?? "?"}); left untouched. Update your CLI`,
    renderFailedWriting: (label, path, detail) =>
      `${label ? `The ${label} render failed` : "The render failed"} writing ${path}: ${detail}`,
    backupAvailableAt: (path) => ` Backup available (pre-write) at: ${path}`,
    proseNoClaudeInfra:
      "Does not replicate Claude Code-specific infrastructure: subagent orchestration (Agent tool), " +
      "hooks (quality-gate/guard-destructive) and permission rules. Configure them in your tool if you " +
      "need them.",
    prosePluginBlocksOmitted: (list) =>
      `Plugin blocks omitted because they assume Claude Code infrastructure: ${list}.`,
    proseModelAssignmentOmitted:
      "Per-agent model assignment (config.models) doesn't apply outside Claude Code; omitted.",
    managedBlocksOutOfOrder:
      "CLAUDE.md: the managed blocks are out of canonical order, but there's text of yours interleaved " +
      "between blocks, so I didn't reorder them. Move that text above the first managed block or below " +
      "the last one so navori can order them.",
    qualityGateHookSkipped: "quality-gate hook skipped: config.qualityGate.fast is not set",
    settingsParseFailed: (detail) =>
      `settings.json could not be parsed as JSON: ${detail}. Run 'navori render --force --apply' to regenerate.`,
    settingsNotObject:
      "settings.json is not a JSON object — can't merge. Run 'navori render --force --apply' to regenerate.",
    pluginSkillNotInjected: (id, pid, target) =>
      `skill '${id}' (from @navori/plugin-${pid}) not injected: target ${target} missing (agent disabled in config.harness?)`,
    pluginLoadFailedCodex: (id, reason) =>
      `Plugin '${id}' couldn't be loaded for Codex: ${reason}.`,
    codexTrustHint:
      "Requires Codex CLI >= 0.145.0. Codex only loads `.codex/` in trusted repos; review and authorize " +
      "the new hooks with `/hooks`.",
    presetNotFoundCodex: (preset) => `Preset '${preset}' not found; Codex will use the core only.`,
    presetInvalid: (preset, detail) => `Preset '${preset}' invalid: ${detail}`,
  },
  global: {
    notInstalled: "The global harness isn't installed. Run 'navori global init'.",
    initReinit: (dir) => `Global harness already initialized at ${dir}; regenerating.`,
    initDone: (dir) => `Global harness installed at ${dir}.`,
    renderApplied: (dir) => `Global baseline rendered to ${dir}.`,
    previewTitle: "Would write",
    previewHint: "Run with --apply to write.",
    wroteHook: (path) => `hook: ${path}`,
    wroteSettings: (path) => `settings: ${path}`,
    baselineBlocks: (ids) => `Baseline blocks: ${ids}`,
    doctorTitle: (dir) => `Global harness at ${dir}`,
    hookPresent: "baseline hook present",
    hookMissing: "baseline hook missing — run 'navori global render --apply'",
    settingsRegistered: "registered in settings.json (SessionStart)",
    settingsNotRegistered: "not registered in settings.json — run 'navori global render --apply'",
    versionOk: (v) => `version ${v}`,
    versionDrift: (found, expected) =>
      `version ${found} < CLI ${expected} — run 'navori global render --apply'`,
    hooksDisabledHint: "note: if you disabled Claude Code hooks, the baseline won't be injected",
    uninstallNothing: "No global harness to uninstall.",
    uninstallDone: (dir) => `Global harness uninstalled from ${dir}.`,
    outroOk: "OK",
    outroIssues: "Check the above",
  },
  dominio: {
    noWorkspace:
      "This directory isn't part of any workspace. Pass --workspace <name> or run from a registered repo.",
    ambiguous: (names) =>
      `This directory belongs to several workspaces (${names}). Specify --workspace <name>.`,
    initDone: (dir) => `Dominio created at ${dir}.`,
    initExists: (dir) => `Dominio already exists at ${dir}.`,
    listEmpty: (ws) => `The Dominio for '${ws}' has no entries yet.`,
    listTitle: (ws, count) => `Dominio for '${ws}' — ${count} entr${count === 1 ? "y" : "ies"}`,
    readHint: "Read a full entry with 'navori dominio show <id>'.",
    showNotFound: (id) => `No entry '${id}' in the Dominio.`,
    reindexDone: (count, path) =>
      `Index rebuilt (${count} entr${count === 1 ? "y" : "ies"}): ${path}`,
    doctorTitle: (ws) => `Dominio for '${ws}'`,
    doctorClean: "Dominio is consistent.",
    outroOk: "OK",
    outroIssues: (count) => `${count} warning(s) — check the above`,
    injectHeader: (ws) => `## Workspace Dominio for '${ws}' — canonical cross-repo knowledge`,
    injectHint:
      "Consult these entries before assuming a data model or business rule; open the full file when you need the detail.",
  },
};

const CMD_DICTS: Record<Lang, CmdStrings> = { es: CMD_ES, en: CMD_EN };

/** Command-output catalog for a locale. */
export function tc(lang: Lang): CmdStrings {
  return CMD_DICTS[lang];
}
