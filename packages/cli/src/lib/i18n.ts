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

  projectPromptsIntro: "Ahora unas preguntas para afinar el harness a tu repo (lo que navori no puede detectar). Las respuestas se vuelven reglas activas que los agentes siguen.",
  projectPromptsAsk: "¿Quieres contestarlas ahora?",
  projectPromptsSkip: "Saltear (después con 'navori configure')",
  projectPromptsRun: "Contestar",
  projectPromptsOptional: "(opcional — deja vacío para omitir)",
  projectPromptsSkipNote: "Omití las preguntas de proyecto. Corre 'navori configure' cuando quieras llenarlas.",
  phaseGeneral: "Fase 1 · general — postura del repo",
  phaseSpecific: "Fase 2 · específica — reglas concretas",
  projectPromptSkipOption: "— sin preferencia / saltar —",

  qualityGateNotDetected: "No detecté quality gate en package.json. El harness va a mostrar 'quality gate sin configurar' donde iría el comando y el hook pre-commit no se va a generar. Corre 'navori configure quality-gate' o agrega scripts (`typecheck`, `lint`, `test`) en package.json y re-renderea.",

  roleLeader: "leader (orquestador)",
  roleImplementer: "implementer (escribe código)",
  roleReviewer: "reviewer (revisa diff)",
  roleResearcher: "researcher (lee, no escribe)",
  roleTicketAudit: "ticket-audit (análisis profundo)",
  roleCommitPrPilot: "commit-pr-pilot (commits + PRs)",
  roleExplorer: "explorer (exploración inicial)",

  existingInfraYesMode:
    "Detecté infraestructura Claude — uso modo 'coexist' (seguro)",
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
  preCommitHookPrompt: "¿Scaffoldear un pre-commit hook que corra 'navori doctor --strict'? (opt-in)",
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
  assetDefaultEs:
    "(default — cámbialo en el wizard si necesitas 'en')",
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

  projectPromptsIntro: "A few questions to tune the harness to your repo (what navori can't detect). Answers become active rules the agents follow.",
  projectPromptsAsk: "Answer them now?",
  projectPromptsSkip: "Skip (run 'navori configure' later)",
  projectPromptsRun: "Answer",
  projectPromptsOptional: "(optional — leave empty to skip)",
  projectPromptsSkipNote: "Skipped project prompts. Run 'navori configure' when you want to fill them.",
  phaseGeneral: "Phase 1 · general — repo posture",
  phaseSpecific: "Phase 2 · specific — concrete rules",
  projectPromptSkipOption: "— no preference / skip —",

  qualityGateNotDetected: "No quality gate detected in package.json. The harness will show 'quality gate sin configurar' where the command would go and the pre-commit hook will not be generated. Run 'navori configure quality-gate' or add scripts (`typecheck`, `lint`, `test`) to package.json and re-render.",

  roleLeader: "leader (orchestrator)",
  roleImplementer: "implementer (writes code)",
  roleReviewer: "reviewer (reviews diff)",
  roleResearcher: "researcher (reads, doesn't write)",
  roleTicketAudit: "ticket-audit (deep analysis)",
  roleCommitPrPilot: "commit-pr-pilot (commits + PRs)",
  roleExplorer: "explorer (initial exploration)",

  existingInfraYesMode:
    "Existing Claude infrastructure detected — using 'coexist' mode (safe)",
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
  assetDefaultEs:
    "(default — change in wizard if you need 'en' fallback)",
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
 * Command output catalog (render / sync / doctor)
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
  excludedSecurityBlocks: (n: number, lines: string) => string;
  excludedSecurityBlockRow: (id: string) => string;
  unknownExcludedBlocks: (n: number, lines: string) => string;
  unknownExcludedBlockRow: (id: string) => string;
  unknownFeatures: (n: number, lines: string) => string;
  featureExternalSkills: (n: number, lines: string) => string;
  featureInactivePresetSkills: (n: number, lines: string) => string;
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
}

/**
 * Feature activation prose shared by `navori add feature <id>` and
 * `navori init --feature <id>`. Both used to hardcode a single locale (add: es,
 * init: en) — routing them here keeps output in the config/wizard language.
 */
interface FeatureCmdStrings {
  passId: string;
  noneKnown: string;
  unknown: (id: string, known: string) => string;
  initInRepoNotBootstrap: (id: string) => string;
  addBootstrapWarning: (id: string) => string;
  alreadyActive: (id: string) => string;
  added: (id: string, configPath: string) => string;
  renderFailed: string;
  registeredRenderFailed: string;
  activatedRendered: string;
}

interface CmdStrings {
  common: CommonCmdStrings;
  render: RenderCmdStrings;
  sync: SyncCmdStrings;
  doctor: DoctorCmdStrings;
  feature: FeatureCmdStrings;
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
    excludedSecurityBlocks: (n, lines) =>
      `Bloques de SEGURIDAD excluidos (${n}) — debilita los guardrails del harness ` +
      `(force-push, --no-verify, rm destructivo). Confirma que es intencional:\n${lines}`,
    excludedSecurityBlockRow: (id) => `— '${id}' es un bloque de seguridad; excluirlo baja la protección`,
    unknownExcludedBlocks: (n, lines) =>
      `Ids en blocks.exclude que no son bloques core conocidos (${n}) — ` +
      `probablemente un typo; no excluyen nada. Corrígelos o quítalos de blocks.exclude:\n${lines}`,
    unknownExcludedBlockRow: (id) => `— '${id}' no coincide con ningún bloque core`,
    unknownFeatures: (n, lines) =>
      `Features declaradas en config sin bundle (${n}) — no existen en core-assets/features/ ni en ` +
      `.navori/features/; el render las omite. Corre 'navori add feature <id>' con un id válido o ` +
      `quítalas de features[]:\n${lines}`,
    featureExternalSkills: (n, lines) =>
      `Features que referencian skills que navori no bundlea (${n}) — asegúrate de que existan en el ` +
      `harness destino (una skill global tuya o de un CLI externo). No es un error:\n${lines}`,
    featureInactivePresetSkills: (n, lines) =>
      `Features que referencian skills bundleadas pero fuera del preset activo (${n}) — se activan con ` +
      `el preset correspondiente o como skill local. No es un error:\n${lines}`,
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
  },
  feature: {
    passId: "Pasa un id de feature (ej. 'navori add feature app-builder').",
    noneKnown: "(ninguna)",
    unknown: (id, known) => `Feature '${id}' desconocida. Conocidas: ${known}`,
    initInRepoNotBootstrap: (id) =>
      `La feature '${id}' es kind:in-repo — espera un proyecto existente. Corre 'navori init' ` +
      `primero, después 'navori add feature ${id}'. 'navori init --feature' es solo para features ` +
      `kind:bootstrap (las que crean el proyecto).`,
    addBootstrapWarning: (id) =>
      `'${id}' es una feature de bootstrap (crea el proyecto). Este repo ya está inicializado, ` +
      `así que las fases de scaffold se saltan por su gate ("ya existe"). Para un proyecto nuevo ` +
      `desde una carpeta vacía usa 'navori init --feature ${id}'.`,
    alreadyActive: (id) => `'${id}' ya está en features[] de este config`,
    added: (id, configPath) => `Añadí '${id}' a features[] en ${configPath}`,
    renderFailed: "El render falló",
    registeredRenderFailed:
      "Feature registrada, pero el render falló — corre 'navori render --apply'.",
    activatedRendered: "feature activada y renderizada",
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
    adapterMissing: (engine) =>
      `The '${engine}' engine has no navori adapter yet; skipped.`,
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
    missingPlugins: (n, lines) =>
      `Plugins declared in config but not loadable (${n}):\n${lines}`,
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
    excludedSecurityBlocks: (n, lines) =>
      `SECURITY blocks excluded (${n}) — weakens the harness guardrails ` +
      `(force-push, --no-verify, destructive rm). Confirm this is intentional:\n${lines}`,
    excludedSecurityBlockRow: (id) => `— '${id}' is a security block; excluding it lowers protection`,
    unknownExcludedBlocks: (n, lines) =>
      `Ids in blocks.exclude that are not known core blocks (${n}) — ` +
      `likely a typo; they exclude nothing. Fix or drop them from blocks.exclude:\n${lines}`,
    unknownExcludedBlockRow: (id) => `— '${id}' matches no core block`,
    unknownFeatures: (n, lines) =>
      `Features declared in config with no bundle (${n}) — they don't exist in core-assets/features/ ` +
      `nor .navori/features/; render skips them. Run 'navori add feature <id>' with a valid id or ` +
      `remove them from features[]:\n${lines}`,
    featureExternalSkills: (n, lines) =>
      `Features referencing skills navori does not bundle (${n}) — make sure they exist in the target ` +
      `harness (a user global skill or one from an external CLI). Not an error:\n${lines}`,
    featureInactivePresetSkills: (n, lines) =>
      `Features referencing skills navori bundles but outside the active preset (${n}) — activate the ` +
      `matching preset or add them as a local skill. Not an error:\n${lines}`,
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
  },
  feature: {
    passId: "Pass a feature id (e.g. 'navori add feature app-builder').",
    noneKnown: "(none)",
    unknown: (id, known) => `Unknown feature '${id}'. Known: ${known}`,
    initInRepoNotBootstrap: (id) =>
      `Feature '${id}' is kind:in-repo — it expects an existing project. Run 'navori init' ` +
      `first, then 'navori add feature ${id}'. 'navori init --feature' is only for ` +
      `kind:bootstrap features (which create the project).`,
    addBootstrapWarning: (id) =>
      `'${id}' is a bootstrap feature (it creates the project). This repo is already initialized, ` +
      `so the scaffold phases self-skip by their gate ("already exists"). For a new project from ` +
      `an empty folder use 'navori init --feature ${id}'.`,
    alreadyActive: (id) => `'${id}' is already in this config's features[]`,
    added: (id, configPath) => `Added '${id}' to features[] in ${configPath}`,
    renderFailed: "Render failed",
    registeredRenderFailed: "Feature registered, but render failed — run 'navori render --apply'.",
    activatedRendered: "feature activated and rendered",
  },
};

const CMD_DICTS: Record<Lang, CmdStrings> = { es: CMD_ES, en: CMD_EN };

/** Command-output catalog for a locale (render / sync / doctor). */
export function tc(lang: Lang): CmdStrings {
  return CMD_DICTS[lang];
}
