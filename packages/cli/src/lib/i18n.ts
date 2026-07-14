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
