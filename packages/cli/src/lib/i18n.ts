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

  // Errors / status
  dirNotFound: (dir: string) => string;
  configExists: (path: string) => string;
  cancelled: string;
  projectNameRequired: string;
  detectionFailedYes: string;
  wroteConfig: (path: string) => string;
  recPluginsEnabled: (list: string) => string;

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
  pickLanguage: "¿En qué idioma querés el wizard?",
  pickLanguageEs: "Español (default)",
  pickLanguageEn: "English",
  useTheseValues: "¿Usar estos valores?",
  projectNameUndetectedAdjust: "No detecté el nombre del proyecto. ¿Ajustar?",
  whatToChange: "¿Qué querés cambiar?",

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
  previewAction: "¿Qué hacés con esto?",
  saveAndContinue: "Guardar y continuar",
  cancelAndExit: "Cancelar y salir",
  editField: (label) => `Editar ${label}`,
  pluginsValueLabel: (list) => list,
  pluginsNone: "(ninguno)",
  assignmentsValueLabel: (n) => `${n} override(s)`,
  assignmentsNone: "(defaults)",

  projectPromptsIntro: "Ahora podés personalizar el harness con info específica del proyecto (paths legacy, áreas críticas, test runner). Las respuestas se guardan en `project.*` del config y los agents las interpolan.",
  projectPromptsAsk: "¿Querés contestarlas ahora?",
  projectPromptsSkip: "Saltear (después con 'navori configure')",
  projectPromptsRun: "Contestar",
  projectPromptsOptional: "(opcional — dejá vacío para skipear)",
  projectPromptsSkipNote: "Skipeé las preguntas de proyecto. Corré 'navori configure' cuando quieras llenarlas.",

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
  howToAdopt: "¿Cómo querés adoptar navori?",
  coexistLabel: "Coexistir (recomendado)",
  coexistHint: "agrega lo que falta, no modifica lo existente",
  replaceLabel: "Reemplazar",
  replaceHint: "respalda todo a ~/.navori/migrations/<ts>/ y arranca limpio",
  replaceConfirm:
    "Esto moverá .claude/, CLAUDE.md, AGENTS.md, CHECKPOINTS.md, feature_list.json, progress/, specs/ a ~/.navori/migrations/. ¿Continuar?",
  backedUp: (n, path) => `Respaldé ${n} elemento(s) en ${path}`,
  removedOriginals: (cwd) => `Borré los originales de ${cwd}`,

  doneExistingUntouched:
    "Listo — archivos existentes intactos. Corré 'navori render' cuando quieras.",
  done: "Listo",
  doneSkippedRender: "Listo (skipeé el render)",
  doneRunLater: "Listo (corré 'navori render' cuando quieras)",
  harnessReady: "Tu harness está listo",

  dirNotFound: (dir) => `Directorio no encontrado: ${dir}`,
  configExists: (path) => `navori.config.json ya existe en ${path}.`,
  cancelled: "Cancelado",
  projectNameRequired: "Hace falta el nombre del proyecto",
  detectionFailedYes:
    "No detecté el nombre del proyecto. Corré sin --yes/--recommended para darlo.",
  wroteConfig: (path) => `Escribí ${path}`,
  recPluginsEnabled: (list) => `Plugins recomendados activados: ${list}`,

  workspaceDefaultsTitle: (name) => `Defaults del workspace · ${name}`,
  detectedTitle: "Detectado en este repo",
  filesFoundTitle: "Archivos encontrados",

  notDetectedAsk: "(no detectado — voy a preguntar)",
  defaultNoGit: "(default — no detecté git)",
  foundInRepo: "(encontrado en el repo)",
  defaultNothing: "(default — no detecté nada)",
  suggested: "(sugerido)",
  assetDefaultEs:
    "(default — cambialo en el wizard si necesitás 'en')",
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
  previewAction: "What do you want to do?",
  saveAndContinue: "Save and continue",
  cancelAndExit: "Cancel and exit",
  editField: (label) => `Edit ${label}`,
  pluginsValueLabel: (list) => list,
  pluginsNone: "(none)",
  assignmentsValueLabel: (n) => `${n} override(s)`,
  assignmentsNone: "(defaults)",

  projectPromptsIntro: "You can now personalize the harness with project-specific info (legacy paths, critical areas, test runner). Answers are saved under `project.*` and interpolated into agent prompts.",
  projectPromptsAsk: "Answer them now?",
  projectPromptsSkip: "Skip (run 'navori configure' later)",
  projectPromptsRun: "Answer",
  projectPromptsOptional: "(optional — leave empty to skip)",
  projectPromptsSkipNote: "Skipped project prompts. Run 'navori configure' when you want to fill them.",

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
    "Done — existing files not touched. Run 'navori render' when ready.",
  done: "Done",
  doneSkippedRender: "Done (skipped render)",
  doneRunLater: "Done (run 'navori render' when ready)",
  harnessReady: "Your harness is ready",

  dirNotFound: (dir) => `Directory not found: ${dir}`,
  configExists: (path) => `navori.config.json already exists at ${path}.`,
  cancelled: "Cancelled",
  projectNameRequired: "Project name is required",
  detectionFailedYes:
    "Could not detect project name. Run without --yes/--recommended to provide one.",
  wroteConfig: (path) => `Wrote ${path}`,
  recPluginsEnabled: (list) => `Recommended plugins enabled: ${list}`,

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
