/**
 * Lightweight i18n for the `init` wizard prompts and supporting summaries.
 *
 * Keeps both locales here in one literal so a missing key is a TS error,
 * not a silent fallback to English. New strings: add to BOTH `es` and `en`.
 *
 * The wizard asks for the locale up-front; everything after that prompt
 * pulls strings via `t(lang).<key>`.
 */

// Type-only (erased at build time): this file stays runtime-dependency-free,
// but the prune's reason union is defined once, where the prune decides it.
import type { KeepReason } from "./removable.ts";

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

  // Quality-gate fallback + monorepo scan prompts (init wizard)
  qualityGateFallbackApplied: (command: string) => string;
  monorepoNoWorkspaces: string;
  monorepoDetectedYes: (n: number, list: string) => string;
  monorepoDetectedTitle: string;
  monorepoAddPrompt: (n: number) => string;
  monorepoUseSuggested: string;
  monorepoPresetFor: (path: string) => string;

  // Prettier prevention (#523). `prettier --write .` reformats CLAUDE.md
  // (emphasis quotes, blank lines), which invalidates every managed block's
  // hash and freezes the harness. init writes the harness paths into
  // `.prettierignore` and reports the outcome with these.
  prettierIgnoreWritten: (entries: string) => string;
  prettierIgnoreAlreadyCovered: string;
  prettierIgnoreSkipped: string;
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

  qualityGateFallbackApplied: (command) => `Quality gate fallback aplicado: ${command}`,
  monorepoNoWorkspaces:
    "Monorepo detectado pero no se encontraron workspaces en pnpm-workspace.yaml/package.json#workspaces.",
  monorepoDetectedYes: (n, list) => `Detectados ${n} workspace(s) en monorepo: ${list}`,
  monorepoDetectedTitle: "Workspaces detectados en el monorepo:",
  monorepoAddPrompt: (n) => `¿Agregar ${n} workspace(s) a monorepo.workspaces[]?`,
  monorepoUseSuggested: "¿Usar el preset sugerido en cada workspace?",
  monorepoPresetFor: (path) => `Preset para ${path}`,

  prettierIgnoreWritten: (entries) =>
    `Prettier detectado: agregué ${entries} a .prettierignore. Si el formateador reescribe esos ` +
    `archivos invalida el hash de cada bloque managed y el harness se congela (#523).`,
  prettierIgnoreAlreadyCovered:
    "Prettier detectado: tu .prettierignore ya cubre los archivos del harness — no toqué nada.",
  prettierIgnoreSkipped:
    "El bloque managed de .prettierignore está editado a mano: lo conservé. Verifica que siga " +
    "ignorando los archivos del harness o el formateador puede congelarlo (#523).",
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

  qualityGateFallbackApplied: (command) => `Quality gate fallback applied: ${command}`,
  monorepoNoWorkspaces:
    "Monorepo detected but no workspaces found in pnpm-workspace.yaml/package.json#workspaces.",
  monorepoDetectedYes: (n, list) => `Detected ${n} workspace(s) in monorepo: ${list}`,
  monorepoDetectedTitle: "Workspaces detected in the monorepo:",
  monorepoAddPrompt: (n) => `Add ${n} workspace(s) to monorepo.workspaces[]?`,
  monorepoUseSuggested: "Use the suggested preset for every workspace?",
  monorepoPresetFor: (path) => `Preset for ${path}`,

  prettierIgnoreWritten: (entries) =>
    `Prettier detected: added ${entries} to .prettierignore. If the formatter rewrites those ` +
    `files it invalidates every managed block's hash and freezes the harness (#523).`,
  prettierIgnoreAlreadyCovered:
    "Prettier detected: your .prettierignore already covers the harness files — left untouched.",
  prettierIgnoreSkipped:
    "The managed block in .prettierignore was hand-edited: it was preserved. Check that it still " +
    "ignores the harness files or the formatter can freeze it (#523).",
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
  // lib/config.ts soft warnings (stderr) — localized off config.language.
  unknownConfigValues: (list: string) => string;
  deadProgressKeys: (list: string) => string;
  // lib/marker.ts user-zone placeholder (emitted into a fresh CLAUDE.md).
  userSectionPlaceholder: string;
  // lib/placeholders.ts soft fallback for `{{qualityGate.fast|full}}` — published
  // INLINE in the rendered prose of ~82 asset sites when no gate is configured,
  // so it follows the repo's language like every other user-facing string (#445).
  qualityGateNotConfigured: string;
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
  orphanedEngineOutputs: (count: number, list: string) => string;
  prunedEngineOutputs: (count: number, list: string) => string;
  /** Same list, before anything is deleted: `--prune` without `--apply` (#521). */
  prunePreviewEngineOutputs: (count: number, list: string) => string;
  keptEngineOutputs: (count: number, list: string) => string;
  /** The spared half of that same preview plan (#521). */
  keptEngineOutputsPreview: (count: number, list: string) => string;
  keptEngineOutputReason: (reason: KeepReason) => string;
  downgradeWarning: (args: { count: number; newest: string; ids: string }) => string;
  previewWord: string;
  previewHint: string;
  upToDate: string;
  upToDateHint: string;
  doneWord: string;
  /** Provenance: WHICH core tree this render read its assets from. */
  coreSource: (root: string, bundled: boolean) => string;
  /** Freshness hint: the bundled asset copy is older than `source` (dev-only). */
  staleCoreBundle: (source: string) => string;
  /** Outro lead when the only thing that happened is a refusal to overwrite. */
  skippedWord: string;
  /** Outro tail naming how many files render refused to write. */
  skippedOutro: (count: number) => string;
  /** Report section title for the harness-managed `.gitignore` block. */
  gitignoreTitle: string;
  /** Comment seeded at the top of a freshly-created `.gitignore` (respects
   *  `language`); the managed block is appended right after it. */
  gitignoreHeader: string;
  /** Comment seeded at the top of a freshly-created `.prettierignore` (#523);
   *  the managed block is appended right after it. */
  prettierIgnoreHeader: string;
  /** Report section title for the harness-managed `.prettierignore` block. */
  prettierIgnoreTitle: string;
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
  // Bulk (non-interactive) conflict resolution — #523.
  /** `--accept-new` and `--keep-mine` contradict each other. */
  bulkFlagsConflict: string;
  /** A bulk flag cannot be combined with `--interactive` (prompt vs no prompt). */
  bulkFlagsInteractive: string;
  /** Bulk flag passed without `--apply`/`--yes`: preview only, nothing written. */
  bulkPreview: (mode: string, count: number) => string;
  /** Bulk resolution actually applied to N CLAUDE.md block conflicts. */
  bulkApplied: (mode: string, count: number) => string;
  /** Header above a conflicting block's diff in the plan preview. */
  conflictDiffSummary: (changed: number, shown: number) => string;
  /** Tail line naming how many diff lines the preview left out. */
  conflictDiffTruncated: (hidden: number) => string;
  /** Whole-file conflicts carry no block-level diff — say so, don't stay silent. */
  conflictDiffFileLevel: string;
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
  nameMismatch: (configName: string, dirName: string, suggestedName: string) => string;
  orphanedEngineOutputsTitle: (n: number) => string;
  orphanedEngineOutputRow: (engine: string) => string;
  missingPresetFiles: (preset: string, n: number, lines: string) => string;
  missingPresetFileRow: (path: string) => string;
  missingLocalSkills: (n: number, lines: string) => string;
  missingLocalSkillRow: (id: string) => string;
  unknownLibraries: (n: number, lines: string) => string;
  unknownLibraryRemovedRow: (successors: string) => string;
  unknownLibraryUnknownRow: string;
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
  driftDowngradeRow: (source: string) => string;
  driftHintDowngrade: string;
  corruptedSettings: (n: number, lines: string) => string;
  corruptedSettingsRow: (error: string) => string;
  missingInvariants: (n: number, lines: string) => string;
  missingInvariantRow: (source: string) => string;
  malformedMarkers: (n: number, lines: string) => string;
  malformedMarkerRowUnterminated: string;
  malformedMarkerRowMissingId: string;
  duplicateMarkers: (n: number, lines: string) => string;
  duplicateMarkerRow: (count: number) => string;
  claudeHookScriptsMissing: (n: number, lines: string) => string;
  claudeHookScriptMissingRow: string;
  claudeHookScriptsNotExecutable: (n: number, lines: string) => string;
  claudeHookScriptNotExecutableRow: string;
  legacyAgents: (n: number, lines: string) => string;
  legacyAgentRow: (canonical: string) => string;
  externalTools: (n: number, lines: string) => string;
  externalToolRow: (binary: string, how: string) => string;
  externalToolFallbackHow: string;
  optionalTools: (n: number, lines: string) => string;
  optionalToolRow: (binaries: string, how: string) => string;
  /** #368 — the declared quality gate can't run on this machine. */
  gateNotRunnable: (n: number, lines: string) => string;
  gateMissingBinaryRow: (binary: string) => string;
  gateMissingScriptRow: (script: string) => string;
  gateMissingDepsRow: (dir: string) => string;
  /** #369 — an installed skill whose user-section is still the template. */
  emptyUserSections: (n: number, lines: string) => string;
  emptyUserSectionRow: (path: string) => string;
  /** #440 — interpolation artifacts frozen into the rendered tree. */
  interpolationArtifacts: (n: number, lines: string) => string;
  interpolationArtifactUnresolvedRow: (token: string) => string;
  interpolationArtifactGateRow: string;
  interpolationArtifactsMore: (n: number) => string;
  /** #393 — a growth directory (backups / agent worktrees) over its threshold. */
  diskUsage: (n: number, lines: string) => string;
  diskBackupsRow: (size: string) => string;
  diskWorktreesRow: (size: string) => string;
  /** #522 — nested agent worktrees with their own install break eslint's
   *  upward config resolution, so no agent can commit from one. */
  nestedWorktrees: (n: number, eslintConfig: string, lines: string) => string;
  nestedWorktreeRow: string;
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
  codegraphNotIgnored: string;
  codegraphTracked: string;
  codegraphIndexMissing: string;
  codegraphStale: string;
  /** Note title for the `.gitignore` harness-block health section. */
  gitignoreTitle: string;
  /** The managed block is absent (file missing or block removed). */
  gitignoreMissing: string;
  /** The managed block exists but its body drifted from the config. */
  gitignoreDrift: string;
  /** Note title for the `.prettierignore` harness-block health section. */
  prettierIgnoreTitle: string;
  /** The repo runs prettier and nothing protects the harness files from it. */
  prettierIgnoreMissing: string;
  /** The managed block exists but its body drifted from the config. */
  prettierIgnoreDrift: string;
  /** Note title for the git-hygiene section (#325). */
  gitHygieneTitle: string;
  /** The specs dir is ignored while the `sdd` block is active. */
  gitHygieneSpecsIgnored: (dir: string) => string;
  /** An ephemeral agent path git doesn't ignore. */
  gitHygieneEphemeralNotIgnored: (path: string) => string;
  /** Note title for the workspace config-drift section (#326). */
  workspaceDriftTitle: (workspace: string, siblings: number) => string;
  /** A key diverging from the workspace manifest's declared default. */
  workspaceDriftDefaultRow: (key: string, local: string, expected: string) => string;
  /** A key diverging from what most sibling repos declare. */
  workspaceDriftSiblingRow: (
    key: string,
    local: string,
    expected: string,
    agree: number,
    total: number,
  ) => string;
  /** How to adopt the divergence (never auto-applied). */
  workspaceDriftHint: string;
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
  // Shared plan (Claude + Codex): project.libraries ids the registry doesn't know (audit A1)
  libraryRemovedFromRegistry: (id: string, successors: readonly string[]) => string;
  libraryUnknownInRegistry: (id: string) => string;
  // Claude adapter
  managedBlocksOutOfOrder: string;
  qualityGateHookSkipped: string;
  settingsParseFailed: (detail: string) => string;
  settingsNotObject: string;
  mcpJsonParseFailed: (detail: string) => string;
  mcpJsonNotObject: string;
  pluginSkillNotInjected: (skillId: string, pluginId: string, target: string) => string;
  // Codex adapter
  pluginLoadFailedCodex: (id: string, reason: string) => string;
  codexTrustHint: string;
  presetNotFoundCodex: (preset: string) => string;
  presetInvalid: (preset: string, detail: string) => string;
  // Prose-engine dispatch (render.ts)
  agentsMdRedundantWithCodex: string;
  // Global baseline (Spec 0010)
  globalBaselineIntro: string;
}

/**
 * Static prose for the four computed CLAUDE.md blocks (skills index, agents
 * index, monorepo map, project context). Before #289 this prose was hardcoded
 * in English inside the Claude engine builders (and duplicated for the Codex
 * "## Available agents" heading), so a `language:"es"` repo got Spanish rule
 * blocks but English computed blocks. The dynamic rows are still assembled in
 * TS from config; only the fixed sentences/headings live here so both engines
 * pull the same localized text via `tc(resolveLang(config.language)).blocks.*`.
 */
interface BlocksCmdStrings {
  skillsIndex: {
    heading: string;
    intro: string;
    localNote: string;
  };
  agentsIndex: {
    heading: string;
    intro: string;
    /** "When to reach for each agent", keyed by CORE_AGENTS id (leader excluded). */
    when: Record<string, string>;
  };
  monorepo: {
    workspaceHeading: (name: string) => string;
    workspaceIntro: (name: string, path: string, tool: string) => string;
    siblingsLead: string;
    onlyWorkspace: string;
    scopedTaskHint: (name: string) => string;
    rootHeading: string;
    rootIntro: (tool: string) => string;
    workspacesLead: string;
  };
  projectContext: {
    heading: string;
    intro: string;
    stageGreenfield: string;
    stageProduction: string;
    stageMigration: string;
    migrationRow: (domain: string, preferred: string, legacy: string) => string;
    rigorStrict: string;
    rigorPragmatic: string;
    architecture: (rule: string) => string;
    criticalAreas: (list: string) => string;
    testsAlways: string;
    testsWhenApplicable: string;
    testsNone: string;
    /** Suites the tests policy does not reach (#529). */
    testsExclude: (list: string) => string;
  };
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
  nextDowngradeDrift: string;
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
  permsMerged: (count: number) => string;
  permsNotMerged: string;
  versionOk: (v: string) => string;
  versionDrift: (found: string, expected: string) => string;
  hooksDisabledHint: string;
  uninstallNothing: string;
  uninstallDone: (dir: string) => string;
  uninstallSettingsUnreadable: (path: string) => string;
  /**
   * #497 — the machine-wide settings.json exists but cannot be merged into.
   * Separate from `engine.settingsParseFailed` (the repo-scoped twin) because
   * the remediation differs: git can restore `.claude/settings.json`, so there
   * the answer is `render --force`; nothing can restore `~/.claude/settings.json`,
   * so the only answer is fixing the JSON by hand.
   */
  settingsParseFailed: (path: string, detail: string) => string;
  settingsNotObject: (path: string) => string;
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
  // DOMINIO.md artifact (buildIndex) + validateDominio findings (localized so an
  // es/en repo gets a consistent index and warnings).
  indexTitle: (ws: string) => string;
  indexGenerated: string;
  indexEmpty: string;
  findingUnknownType: (type: string) => string;
  findingUnknownStatus: (status: string) => string;
  findingMissingTitle: string;
  findingSupersedesUnknown: (target: string) => string;
  findingSupersededNoTarget: string;
  findingIndexMissing: string;
  findingIndexStale: string;
}

interface MigrationsCmdStrings {
  listEmpty: string;
  total: (total: number, shown: number) => string;
  more: (n: number) => string;
  done: string;
  notFound: (dir: string) => string;
  empty: (dir: string) => string;
  willRestore: (n: number, from: string, to: string) => string;
  moreFiles: (n: number) => string;
  overwriteConfirm: string;
  restored: (n: number) => string;
}

interface BackupCmdStrings {
  listEmpty: string;
  total: (total: number, shown: number) => string;
  more: (n: number) => string;
  done: string;
  ageJustNow: string;
  ageMinutes: (n: number) => string;
  ageHours: (n: number) => string;
  ageDays: (n: number) => string;
  notFound: (dir: string) => string;
  empty: (dir: string) => string;
  repoMismatch: (backupRepo: string, dest: string) => string;
  willRestore: (n: number, from: string, to: string) => string;
  overwriteConfirm: string;
  restored: (n: number) => string;
  /** #393 — explicit prune: age first, then oldest-first down to the size cap. */
  pruneNothing: string;
  pruned: (n: number) => string;
}

interface TicketCmdStrings {
  listEmpty: (ws: string) => string;
  archiveBadge: string;
  count: (n: number) => string;
  done: string;
  notFound: (id: string, ws: string) => string;
  contentTitle: string;
  noReferences: string;
  referencedLabel: string;
  invalidId: (id: string) => string;
  titlePrompt: string;
  cancelled: string;
  wrote: (path: string) => string;
  referenceHint: (id: string) => string;
  archived: (path: string) => string;
  unarchived: (path: string) => string;
  deleteConfirm: (id: string, ws: string) => string;
  deleted: string;
}

interface RegistryCmdStrings {
  lsEmpty: string;
  unknownName: string;
  missingTag: string;
  lsSummary: (total: number, missing: number) => string;
  dirNotFound: string;
  addedBadge: string;
  knownBadge: string;
  doneWord: string;
  scanSummary: (added: number, unchanged: number) => string;
  notNavoriRepo: (path: string) => string;
  registeredVerb: string;
  alreadyRegisteredVerb: string;
  removedVerb: string;
  notInRegistry: (path: string) => string;
  nothingToPrune: (kept: number) => string;
  prunedVerb: string;
  pruneSummary: (removed: number, kept: number) => string;
}

interface RemoveCmdStrings {
  engramAlwaysOn: string;
  notDeclared: (id: string) => string;
  done: string;
  confirm: (id: string) => string;
  renderCrashed: string;
  renderFailedConfig: string;
  removed: (id: string) => string;
}

interface PresetCmdStrings {
  reservedId: string;
  invalidId: (id: string) => string;
  alreadyExists: (id: string) => string;
  created: (id: string) => string;
  configSet: (id: string) => string;
  doneEdit: (renderCmd: string) => string;
  noConfig: (cwd: string, id: string, initCmd: string) => string;
  doneScaffold: string;
  stackTemplate: (id: string) => string;
  skillTemplate: (skillId: string) => string;
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
  blocks: BlocksCmdStrings;
  global: GlobalCmdStrings;
  dominio: DominioCmdStrings;
  migrations: MigrationsCmdStrings;
  backup: BackupCmdStrings;
  ticket: TicketCmdStrings;
  registry: RegistryCmdStrings;
  remove: RemoveCmdStrings;
  preset: PresetCmdStrings;
}

const CMD_ES: CmdStrings = {
  common: {
    dirNotFound: (dir) => `Directorio no encontrado: ${dir}`,
    noConfig: (path) => `No hay navori.config.json en ${path}. Corre 'navori init' primero.`,
    backupLabel: "Backup:",
    aborted: "Abortado",
    unknownConfigValues: (list) =>
      `navori: valores de config desconocidos ignorados (¿config de un navori más nuevo? actualiza el CLI): ${list}`,
    deadProgressKeys: (list) =>
      `navori: claves obsoletas ignoradas en "progress" (puedes borrarlas del navori.config.json): ${list}`,
    userSectionPlaceholder:
      "<!-- Escribe aquí el dominio y las convenciones específicas de tu repo. " +
      "navori preserva intacto todo lo que esté entre estos marcadores en cada render. -->",
    qualityGateNotConfigured:
      "(quality gate sin configurar — corre 'navori configure quality-gate')",
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
    orphanedEngineOutputs: (count, list) =>
      `Outputs huérfanos de engines desactivados (${count}) — quedaron de un engine que ya ` +
      `no está en config.engines; render no los toca. Corre 'navori render --prune --apply' para borrarlos:\n${list}`,
    prunedEngineOutputs: (count, list) =>
      `Borré archivos huérfanos de engines desactivados (${count}) — solo los que escribió ` +
      `navori (llevan su marcador), respaldados antes de borrar:\n${list}`,
    prunePreviewEngineOutputs: (count, list) =>
      `Con --apply borraría ${count} archivo(s) huérfanos de engines desactivados — solo los ` +
      `que escribió navori (llevan su marcador), y los respalda antes de borrar. Este preview ` +
      `no tocó nada:\n${list}`,
    keptEngineOutputs: (count, list) =>
      `Dejé intacto lo que no me tocaba borrar (${count}) — el prune borra archivo por archivo, ` +
      `nunca el directorio completo. La razón va junto a cada uno; bórralos tú si ya no los ` +
      `quieres:\n${list}`,
    keptEngineOutputsPreview: (count, list) =>
      `Conservaría lo que no me toca borrar (${count}) — el prune borra archivo por archivo, ` +
      `nunca el directorio completo. La razón va junto a cada uno; bórralos tú si ya no los ` +
      `quieres:\n${list}`,
    keptEngineOutputReason: (reason) => {
      switch (reason) {
        case "ephemeral":
          return "estado local efímero; navori nunca lo versiona";
        case "symlink":
          // The prune leaving a link in place is a deliberate change of
          // behaviour, not a failure: say so, or the user reads the surviving
          // `.cursor` as a prune that did not work.
          return "es un enlace simbólico: no lo seguimos ni lo desenlazamos; bórralo tú si ya no lo quieres";
        case "newer":
          // NOT `foreign`: navori sí lo escribió, sólo que una versión más nueva
          // que este CLI. Decir "no lo escribimos nosotros" era mentira (#538).
          return "lo escribió una navori más nueva que tu CLI: no lo degradamos; actualiza con 'npm i -g navori@latest'";
        // No `default`: a new reason must fail to compile in BOTH locales
        // instead of silently rendering as "we did not write it".
        case "foreign":
          // Afirma el HECHO (no lleva marcador), no la inferencia (es tuyo): un
          // JSON que escribió una navori vieja, de antes de que estampara
          // `$navori`, tampoco lo lleva y el mensaje lo daba por ajeno (#538).
          return "sin marcador de navori: no puedo confirmar que sea nuestro, así que no lo toco";
      }
    },
    downgradeWarning: ({ count, newest, ids }) =>
      `Tu CLI está detrás del repo: ${count} bloque(s) los escribió una navori más nueva ` +
      `(hasta ${newest}). Los preservé sin tocar para no degradarlos. ` +
      `Actualiza tu CLI para volver a gestionarlos: npm i -g navori@latest\n  ${ids}`,
    previewWord: "Preview",
    previewHint: "corre 'navori render --apply' para escribir",
    upToDate: "Al día",
    upToDateHint: "nada que aplicar",
    doneWord: "Done",
    coreSource: (root, bundled) =>
      `core: ${root} ${bundled ? "(copia del build)" : "(fuentes de dev)"}`,
    // Solo se emite dentro del monorepo de navori, así que nombrar sus scripts
    // es correcto aquí (en un repo consumidor este aviso nunca aparece).
    staleCoreBundle: (source) =>
      `Tu dist/ es más viejo que ${source}: este render comparó contra los assets del último ` +
      `build, no contra tu árbol de trabajo — puede decir 'unchanged' de más, y un --apply ` +
      `llega a revertir el espejo. Corre 'pnpm --filter navori build' (o 'pnpm render:apply', ` +
      `que ya lo encadena) y vuelve a renderizar.`,
    skippedWord: "Con omisiones",
    skippedOutro: (count) =>
      `${count} archivo(s) que render se negó a sobrescribir — el espejo NO está al día; ` +
      `resuélvelos con 'navori sync'`,
    gitignoreTitle: ".gitignore del harness:",
    gitignoreHeader:
      "# .gitignore gestionado por navori. El bloque de abajo se regenera con 'navori render';\n" +
      "# edita fuera de él con libertad.\n",
    prettierIgnoreHeader:
      "# .prettierignore gestionado por navori. El bloque de abajo evita que el formateador\n" +
      "# reescriba los archivos del harness e invalide el hash de sus bloques managed.\n" +
      "# Edita fuera del bloque con libertad.\n",
    prettierIgnoreTitle: ".prettierignore del harness:",
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
    bulkFlagsConflict:
      "--accept-new y --keep-mine son excluyentes: elige uno. --accept-new sobrescribe tus " +
      "ediciones con la versión renderizada; --keep-mine las conserva y aplica todo lo demás.",
    bulkFlagsInteractive:
      "--interactive no se combina con --accept-new/--keep-mine: uno pregunta bloque por bloque " +
      "y los otros deciden en bloque sin preguntar. Elige uno.",
    bulkPreview: (mode, count) =>
      `${mode} resolvería ${count} conflicto(s) de bloques en CLAUDE.md. No escribí nada: ` +
      `vuelve a correrlo con --apply (o --yes) para aplicarlo.`,
    bulkApplied: (mode, count) => `${mode}: resolví ${count} conflicto(s) de bloques en CLAUDE.md`,
    conflictDiffSummary: (changed, shown) =>
      `${changed} línea(s) de diff (mostrando ${shown}; - tu versión, + la renderizada)`,
    conflictDiffTruncated: (hidden) =>
      `… +${hidden} línea(s) de diff sin mostrar — 'navori sync --interactive' trae el diff completo`,
    conflictDiffFileLevel:
      "(conflicto de archivo completo: el preview no trae diff — compáralo contra el backup o " +
      "resuélvelo a mano)",
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
    nameMismatch: (configName, dirName, suggestedName) =>
      `El name '${configName}' en navori.config.json no coincide con el directorio del repo ` +
      `('${dirName}') — probablemente un harness copiado de otro repo sin actualizar el nombre. ` +
      `Edita "name" a '${suggestedName}' (la forma kebab-case del directorio, la única que ` +
      `acepta el esquema) si no es intencional.`,
    orphanedEngineOutputsTitle: (n) =>
      `Outputs huérfanos de engines desactivados · ${n} ('navori render --prune --apply' borra ` +
      `de ahí solo los archivos que escribió navori)`,
    // NUNCA "seguro de borrar" (#496): doctor reporta rutas de un mapa estático
    // por engine sin haber leído su contenido, y esa recomendación llevó a
    // borrar el `.cursor/` del usuario. Que diga lo que sabe: de quién es la
    // ruta y qué hará el prune — la decisión archivo por archivo la toma él.
    orphanedEngineOutputRow: (engine) =>
      `— del engine '${engine}' (no está en engines); el prune solo borra lo que lleve marcador de navori`,
    missingPresetFiles: (preset, n, lines) =>
      `Extras del preset '${preset}' sin archivo (${n}) — el render ` +
      `fallará al leerlos; créalos o quítalos del manifest:\n${lines}`,
    missingPresetFileRow: (path) => `— falta ${path}`,
    missingLocalSkills: (n, lines) =>
      `Skills project-local declarados sin archivo (${n}) — crea el .md (o <id>/SKILL.md) o quita el id de project.localSkills:\n${lines}`,
    missingLocalSkillRow: (id) => `— falta .claude/skills/${id}.md o ${id}/SKILL.md`,
    unknownLibraries: (n, lines) =>
      `Ids en project.libraries que el registro no conoce (${n}) — su guía no se renderiza ` +
      `y el render borra su skill de disco. Corre 'navori update' para re-detectar:\n${lines}`,
    unknownLibraryRemovedRow: (successors) =>
      successors ? `— retirada del registro; sucesoras: ${successors}` : "— retirada del registro",
    unknownLibraryUnknownRow: "— desconocida para esta versión del CLI",
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
    driftDowngradeRow: (source) => `(${source}, disco adelantado)`,
    driftHintDowngrade:
      "el bloque en disco es más nuevo que tu CLI; render lo preserva (anti-retroceso), así que actualiza navori (p.ej. 'npm i -g navori@latest')",
    corruptedSettings: (n, lines) =>
      `Settings.json corrupto (${n}) — corre 'navori render --force --apply' para regenerar desde el bundle (el archivo actual se respalda):\n${lines}`,
    corruptedSettingsRow: (error) => `— JSON inválido: ${error}`,
    missingInvariants: (n, lines) =>
      `Invariantes ausentes en el output (${n}) — una regla load-bearing desapareció; corre 'navori render --apply' o revisa el template:\n${lines}`,
    missingInvariantRow: (source) => `— declarado por ${source}`,
    malformedMarkers: (n, lines) =>
      `Markers managed malformados (${n}) — navori ya no reconoce esta(s) línea(s) como ` +
      `marcador; el próximo render appendearía un bloque duplicado y dejaría la línea rota. ` +
      `Arréglalas a mano (o bórralas):\n${lines}`,
    malformedMarkerRowUnterminated: `— falta el cierre '-->'`,
    malformedMarkerRowMissingId: `— sin id="…" justo tras el nombre del marcador`,
    duplicateMarkers: (n, lines) =>
      `Bloques managed duplicados (${n}) — un mismo id aparece más de una vez en el archivo; ` +
      `navori solo ve la PRIMERA copia, así que la sobrante queda invisible a render/sync/doctor ` +
      `con contenido posiblemente stale. Elimina la copia sobrante a mano:\n${lines}`,
    duplicateMarkerRow: (count) => `— aparece ${count} veces`,
    claudeHookScriptsMissing: (n, lines) =>
      `Scripts de hooks ausentes (${n}) — un hook activo de .claude/settings.json referencia un archivo que no existe, ` +
      `así que el hook truena o no hace nada en cada Bash; corre 'navori render --apply' para regenerarlos:\n${lines}`,
    claudeHookScriptMissingRow: "— referenciado por un hook activo pero no existe en disco",
    claudeHookScriptsNotExecutable: (n, lines) =>
      `Scripts de hooks sin permiso de ejecución (${n}) — Claude no dispara un hook cuyo script no es ejecutable; ` +
      `corre 'navori render --apply' para restaurar el bit +x:\n${lines}`,
    claudeHookScriptNotExecutableRow: "— sin bit de ejecución (+x)",
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
    gateNotRunnable: (n, lines) =>
      `Quality gate declarado pero no ejecutable (${n}) — el gate es lo que sostiene ` +
      `el cierre de cada tarea; si no corre, las fases que dependen de él quedan sin red:\n${lines}`,
    gateMissingBinaryRow: (binary) => `— falta '${binary}' en PATH`,
    gateMissingScriptRow: (script) =>
      `— el script '${script}' no existe en el package.json de ese directorio`,
    gateMissingDepsRow: (dir) =>
      `— sin node_modules en '${dir}'; instala dependencias antes de apoyarte en el gate`,
    emptyUserSections: (n, lines) =>
      `Skills instaladas con su user-section sin llenar (${n}) — cuestan una lectura ` +
      `y solo cubren la capa universal; lo específico de tu stack va en esa sección:\n${lines}`,
    emptyUserSectionRow: (path) => `— plantilla sin tocar en ${path}`,
    interpolationArtifacts: (n, lines) =>
      `Restos de interpolación en el árbol renderizado (${n}) — 'render' reescribe ` +
      `solo la zona managed, así que lo que cayó en la zona de usuario se queda ahí ` +
      `aunque arregles el interpolador. Edita esas líneas a mano; borrar el archivo ` +
      `también lo regenera limpio, pero pierdes todo lo que hayas escrito en su zona ` +
      `de usuario:\n${lines}`,
    interpolationArtifactUnresolvedRow: (token) =>
      `— '${token}' publicado en la prosa; declara ese campo en navori.config.json`,
    interpolationArtifactGateRow:
      "— prosa de 'quality gate sin configurar'; corre 'navori configure quality-gate' " +
      "y vuelve a renderizar",
    interpolationArtifactsMore: (n) => `  … y ${n} más`,
    diskUsage: (n, lines) =>
      `Uso de disco por encima del umbral (${n}) — nada acota estos directorios ` +
      `en automático; límpialos tú:\n${lines}`,
    diskBackupsRow: (size) => `— ${size} en backups; corre 'navori backup prune' para podarlos`,
    diskWorktreesRow: (size) =>
      `— ${size} en worktrees de agente; revisa 'git worktree list' y quita los que ` +
      `sobren con 'git worktree remove <ruta>' (pueden tener trabajo sin commitear; ` +
      `navori nunca los borra solo)`,
    nestedWorktrees: (n, eslintConfig, lines) =>
      `Worktrees anidados con node_modules propio y eslint en el repo (${n}) — eslint ` +
      `resuelve su configuración subiendo por el árbol, así que una corrida dentro del ` +
      `worktree carga también '${eslintConfig}' del repo padre y falla con "couldn't ` +
      `determine the plugin uniquely". Si eslint corre en un hook de pre-commit, ningún ` +
      `agente puede commitear desde ahí: su rama nunca se publica y lo único que se ve ` +
      `es un worktree abandonado. Cierra el ciclo desde el árbol principal y quita el ` +
      `worktree con 'git worktree remove <ruta>' al terminar:\n${lines}`,
    nestedWorktreeRow: "— checkout anidado con node_modules propio",
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
    codegraphNotIgnored:
      "'.codegraph/' no está en .gitignore — el índice SQLite genera churn y conflictos de merge; agrégalo a '.gitignore'",
    codegraphTracked:
      "'.codegraph/' está versionado en git — el índice binario no debe commitearse; quítalo del árbol ('git rm -r --cached .codegraph') y agrégalo a '.gitignore'",
    codegraphIndexMissing:
      "índice de codegraph sin construir — corre 'codegraph init' para generar '.codegraph/'",
    codegraphStale:
      "índice de codegraph posiblemente desactualizado (según 'codegraph status') — corre 'codegraph sync'",
    gitignoreTitle: ".gitignore",
    gitignoreMissing:
      "falta el bloque managed del '.gitignore' (gitignoreHarness ≠ off) — corre 'navori render --apply'",
    gitignoreDrift:
      "el bloque managed del '.gitignore' difiere de la config actual — corre 'navori render --apply'",
    prettierIgnoreTitle: ".prettierignore",
    prettierIgnoreMissing:
      "este repo corre prettier y nada protege los archivos del harness: un 'prettier --write .' " +
      "reescribe CLAUDE.md, invalida el hash de sus bloques managed y navori deja de actualizarlos " +
      "— corre 'navori render --apply'",
    prettierIgnoreDrift:
      "el bloque managed del '.prettierignore' difiere de la config actual — corre 'navori render --apply'",
    gitHygieneTitle: "Higiene de git",
    gitHygieneSpecsIgnored: (dir) =>
      `'${dir}/' está en .gitignore pero el bloque 'sdd' está activo — las specs se pierden al cambiar de rama y la traza R<n>↔test nunca llega al PR; quítalo del .gitignore o desactiva el SDD ("sdd": { "enabled": false })`,
    gitHygieneEphemeralNotIgnored: (path) =>
      `'${path}' no está ignorado — son artefactos efímeros de agentes; agrégalo al .gitignore (o usa gitignoreHarness)`,
    workspaceDriftTitle: (workspace, siblings) =>
      `Drift respecto al workspace '${workspace}'${siblings > 0 ? ` (${siblings} repos hermanos)` : ""}:`,
    workspaceDriftDefaultRow: (key, local, expected) =>
      `${key}: ${local} (el workspace declara ${expected})`,
    workspaceDriftSiblingRow: (key, local, expected, agree, total) =>
      `${key}: ${local} (${agree}/${total} repos usan ${expected})`,
    workspaceDriftHint:
      "Informativo: navori nunca lo aplica solo. Adóptalo con 'navori configure', o promuévelo al workspace con 'navori workspace set-default'.",
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
    nextDowngradeDrift:
      "Tu CLI navori está desactualizado (los bloques en disco son más nuevos): actualízalo con 'npm i -g navori@latest'. Render no los retrocede.",
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
    libraryRemovedFromRegistry: (id, successors) =>
      successors.length > 0
        ? `project.libraries: '${id}' fue retirada del registro (ahora: ${successors.join(", ")}) y su skill se elimina de disco. Corre 'navori update' para re-detectar las sucesoras.`
        : `project.libraries: '${id}' fue retirada del registro y su skill se elimina de disco. Corre 'navori update' para limpiar la selección.`,
    libraryUnknownInRegistry: (id) =>
      `project.libraries: '${id}' no existe en el registro de esta versión del CLI; se omite. Corre 'navori update' para re-detectar librerías.`,
    managedBlocksOutOfOrder:
      "CLAUDE.md: los bloques managed están fuera del orden canónico, pero hay texto tuyo intercalado " +
      "entre bloques, así que no los reordené. Mueve ese texto arriba del primer bloque managed o abajo " +
      "del último para que navori pueda ordenarlos.",
    qualityGateHookSkipped: "quality-gate hook omitido: config.qualityGate.fast no está definido",
    settingsParseFailed: (detail) =>
      `settings.json no se pudo parsear como JSON: ${detail}. Corre 'navori render --force --apply' para regenerar.`,
    settingsNotObject:
      "settings.json no es un objeto JSON — no se puede fusionar. Corre 'navori render --force --apply' para regenerar.",
    mcpJsonParseFailed: (detail) =>
      `.mcp.json no se pudo parsear como JSON: ${detail}. Se dejó intacto; corrígelo o corre 'navori render --force --apply' para regenerar.`,
    mcpJsonNotObject:
      ".mcp.json no es un objeto JSON — no se puede fusionar. Se dejó intacto; corre 'navori render --force --apply' para regenerar.",
    pluginSkillNotInjected: (id, pid, target) =>
      `skill '${id}' (de @navori/plugin-${pid}) no inyectado: target ${target} ausente (¿agente disabled en config.harness?)`,
    pluginLoadFailedCodex: (id, reason) => `Plugin '${id}' no pudo cargarse para Codex: ${reason}.`,
    codexTrustHint:
      "Requiere Codex CLI >= 0.145.0. Codex solo carga `.codex/` en repos confiables; revisa y autoriza " +
      "los hooks nuevos con `/hooks`.",
    presetNotFoundCodex: (preset) => `Preset '${preset}' no encontrado; Codex usará solo el core.`,
    presetInvalid: (preset, detail) => `Preset '${preset}' inválido: ${detail}`,
    agentsMdRedundantWithCodex:
      "El engine 'agents-md' es redundante junto a 'codex'; Codex será el único dueño de AGENTS.md.",
    globalBaselineIntro:
      "Lo siguiente es tu baseline navori de máquina (doctrina agnóstica al repo). " +
      "Un proyecto con su propio harness navori lo reemplaza.",
  },
  blocks: {
    skillsIndex: {
      heading: "## Skills disponibles",
      intro:
        "Skills que los agentes pueden aplicar; las propias de navori viven en `.claude/skills/<id>/SKILL.md` (una skill que hayas agregado tú puede ser un `<id>.md` plano). La nota tras el `·` dice cuándo usar cada una.",
      localNote: "Las `project-local` son tuyas — navori las indexa pero nunca toca su contenido.",
    },
    agentsIndex: {
      heading: "## Agentes disponibles",
      intro:
        'Subagentes que puedes lanzar con la herramienta `Agent` (tú eres el orquestador; ve "## Role: orchestrator"). La investigación y la revisión son de solo lectura → paraleliza sin miedo.',
      when: {
        implementer: "Escribe código y tests para UNA tarea bien acotada.",
        reviewer: "Valida un diff contra la spec y la calidad (APPROVED / CHANGES_REQUESTED).",
        researcher:
          "Responde una pregunta concreta sobre el repo (¿pasa Y? ¿qué consume X?) con evidencia citada.",
        explorer: "Mapea un área o módulo amplio: estructura, puntos de entrada, dependencias.",
        "ticket-audit":
          "Analiza a fondo un ticket complejo (bug crítico, migración, feature multicapa) antes de descomponerlo.",
        "commit-pr-pilot":
          "Escribe commits Conventional y abre el PR tras la aprobación del reviewer.",
        auditor:
          "Auditoría profunda de solo lectura (seguridad, rendimiento, SOLID, casos borde); escribe un reporte + plan priorizado en disco.",
      },
    },
    monorepo: {
      workspaceHeading: (name) => `## Monorepo — workspace \`${name}\``,
      workspaceIntro: (name, path, tool) =>
        `Eres el workspace **\`${name}\`** (\`${path}\`) de un monorepo \`${tool}\`. Tienes tu propio harness (este \`CLAUDE.md\` + \`.claude/\`); la config raíz y los archivos transversales (\`turbo.json\`, \`pnpm-workspace.yaml\`, tsconfig/eslint base) viven en la raíz del repo.`,
      siblingsLead:
        "Workspaces hermanos — no los edites desde aquí; el trabajo en un hermano se hace desde su propio harness:",
      onlyWorkspace: "Por ahora es el único workspace declarado.",
      scopedTaskHint: (name) =>
        `Corre tareas acotadas con \`--filter=${name}\`. No importes el código de un hermano por ruta relativa; consúmelo como paquete (\`workspace:*\`).`,
      rootHeading: "## Monorepo — root",
      rootIntro: (tool) =>
        `Este repo es un monorepo \`${tool}\`. El código real vive en los workspaces, cada uno con su propio harness (\`CLAUDE.md\` + \`.claude/\`). Al orquestar, **enruta cada tarea al workspace dueño** y trabaja desde su \`CLAUDE.md\`, no desde aquí.`,
      workspacesLead: "Workspaces:",
    },
    projectContext: {
      heading: "## Contexto del proyecto",
      intro: "Reglas activas derivadas de tu config (`project.*`). Aplican a todos los agentes.",
      stageGreenfield:
        "- **Etapa:** greenfield — favorece velocidad y menos ceremonia, pero el quality gate igual debe pasar.",
      stageProduction:
        "- **Etapa:** en producción — favorece NO romper con regresiones. Los cambios de alto radio de impacto necesitan validación humana antes de mergear.",
      stageMigration:
        "- **Etapa:** migración legacy — cuida la compatibilidad legacy↔nuevo. El reviewer marca CRITICAL cuando un cambio lee de un lado y escribe en el otro.",
      migrationRow: (domain, preferred, legacy) =>
        `- **${domain} (migración):** en código nuevo usa \`${preferred}\`. \`${legacy}\` es legacy — no lo agregues; si tocas un módulo que lo usa, migra ese módulo completo (no mezcles ambos en el mismo archivo). El reviewer marca HIGH cualquier uso nuevo de \`${legacy}\`.`,
      rigorStrict:
        "- **Rigor de revisión:** estricto — el reviewer bloquea APPROVED también con issues de confianza 65-79, no solo ≥80.",
      rigorPragmatic:
        "- **Rigor de revisión:** pragmático — el reviewer bloquea solo issues ≥80; el resto queda como nota informativa.",
      architecture: (rule) =>
        `- **Arquitectura:** el código nuevo DEBE seguir \`${rule}\`. El reviewer marca las desviaciones como HIGH.`,
      criticalAreas: (list) => `- **Áreas críticas** (revisión extra, severidad +1): ${list}.`,
      testsAlways:
        "- **Tests:** el código nuevo DEBE incluir tests. El reviewer bloquea APPROVED si faltan.",
      testsWhenApplicable:
        "- **Tests:** exige tests para lógica no trivial; opcionales para código simple.",
      testsNone: "- **Tests:** el repo no exige tests para código nuevo.",
      testsExclude: (list) =>
        `- **Suites fuera de esa regla:** ${list}. Se mantienen a mano — un cambio de código no exige actualizarlas, y el reviewer no bloquea por ellas.`,
    },
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
    permsMerged: (count) => `${count} permiso(s) personales presentes en settings.json`,
    permsNotMerged:
      "permisos configurados ausentes en settings.json — corre 'navori global render --apply'",
    versionOk: (v) => `versión ${v}`,
    versionDrift: (found, expected) =>
      `versión ${found} < ${expected} del CLI — corre 'navori global render --apply'`,
    hooksDisabledHint:
      "recuerda: si deshabilitaste los hooks de Claude Code, el baseline no se inyecta",
    uninstallNothing: "No hay harness global que desinstalar.",
    uninstallDone: (dir) => `Harness global desinstalado de ${dir}.`,
    uninstallSettingsUnreadable: (path) =>
      `No se pudo parsear ${path}, así que quedó intacto: se borró el archivo del hook, ` +
      `pero su registro sigue en settings.json. Arregla el JSON y vuelve a correr 'navori global uninstall'.`,
    settingsParseFailed: (path, detail) =>
      `El settings.json global (${path}) no se pudo parsear como JSON: ${detail}. ` +
      `No se escribió nada: es tu archivo, no lo versiona git y navori no puede regenerarlo. ` +
      `Arregla el JSON a mano y vuelve a correr el comando.`,
    settingsNotObject: (path) =>
      `El settings.json global (${path}) no es un objeto JSON — no se puede fusionar. ` +
      `No se escribió nada: arréglalo a mano y vuelve a correr el comando.`,
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
    indexTitle: (ws) => `# Dominio — workspace: ${ws}`,
    indexGenerated:
      "> Generado por `navori dominio reindex` — no editar a mano (edita las entradas `<id>.md`).",
    indexEmpty:
      "_(sin entradas todavía — el harness las agrega al descubrir hechos durables y transversales)_",
    findingUnknownType: (type) => `tipo desconocido '${type}' (se usó 'gotcha' como fallback)`,
    findingUnknownStatus: (status) =>
      `estado desconocido '${status}' (se usó 'canonical' como fallback)`,
    findingMissingTitle: "falta 'title' en el frontmatter",
    findingSupersedesUnknown: (target) => `supersedes apunta a una entrada inexistente '${target}'`,
    findingSupersededNoTarget: "estado 'superseded' pero sin objetivo en 'supersedes'",
    findingIndexMissing: "falta el índice — corre `navori dominio reindex`",
    findingIndexStale: "índice desactualizado — corre `navori dominio reindex`",
  },
  migrations: {
    listEmpty:
      "No hay migraciones. Se crean cuando 'init' adopta navori en modo replace (el wizard interactivo) en un repo con infraestructura Claude previa.",
    total: (total, shown) => `${total} migración(es) en total. Mostrando ${shown}:`,
    more: (n) => `  ... ${n} más (usa --limit para mostrarlas)`,
    done: "Listo",
    notFound: (dir) => `Migración no encontrada: ${dir}`,
    empty: (dir) => `La migración está vacía: ${dir}`,
    willRestore: (n, from, to) => `Se restaurarán ${n} archivo(s) de ${from} en ${to}:`,
    moreFiles: (n) => `  ... ${n} más`,
    overwriteConfirm:
      "Los archivos existentes se SOBRESCRIBIRÁN con el snapshot de la migración. ¿Continuar?",
    restored: (n) => `Restauré ${n} archivo(s)`,
  },
  backup: {
    listEmpty:
      "No hay backups. Se crean automáticamente antes de cada 'sync' o 'render' que modifica archivos.",
    total: (total, shown) => `${total} backup(s) en total. Mostrando ${shown}:`,
    more: (n) => `  ... ${n} más (usa --limit para mostrarlos)`,
    done: "Listo",
    ageJustNow: "(recién)",
    ageMinutes: (n) => `(hace ${n} min)`,
    ageHours: (n) => `(hace ${n} h)`,
    ageDays: (n) => `(hace ${n} d)`,
    notFound: (dir) => `Backup no encontrado: ${dir}`,
    empty: (dir) => `El backup está vacío: ${dir}`,
    repoMismatch: (backupRepo, dest) =>
      `Este backup es del repo '${backupRepo}' pero el destino es '${dest}'. ` +
      `Verifica que sea el correcto antes de continuar.`,
    willRestore: (n, from, to) => `Se restaurarán ${n} archivo(s) de ${from} en ${to}:`,
    overwriteConfirm: "Los archivos existentes se sobrescribirán. ¿Continuar?",
    restored: (n) => `Restauré ${n} archivo(s)`,
    pruneNothing: "Nada que podar — los backups están dentro de la retención y del tope de tamaño",
    pruned: (n) => `Limpié ${n} backup(s)`,
  },
  ticket: {
    listEmpty: (ws) => `No hay tickets. Crea uno con 'navori ticket new ${ws} <id>'.`,
    archiveBadge: " [archive]",
    count: (n) => `${n} ticket${n === 1 ? "" : "s"}`,
    done: "Listo",
    notFound: (id, ws) =>
      `El ticket '${id}' no existe en el workspace '${ws}'.\n` +
      `Créalo con: navori ticket new ${ws} ${id}\n`,
    contentTitle: "Contenido",
    noReferences:
      "Referenciado en: (ningún repo del workspace referencia este ticket en su archivo de sesión)",
    referencedLabel: "Referenciado en:",
    invalidId: (id) =>
      `Id de ticket inválido '${id}'. Usa letras, dígitos, guiones y guiones bajos (debe empezar con alfanumérico).`,
    titlePrompt: "Título del ticket",
    cancelled: "Cancelado",
    wrote: (path) => `Escribí ${path}`,
    referenceHint: (id) =>
      `Referéncialo desde el progress/current.md de un repo con:\n  ticket: ${id}`,
    archived: (path) => `Archivado → ${path}`,
    unarchived: (path) => `Desarchivado → ${path}`,
    deleteConfirm: (id, ws) => `¿Borrar permanentemente el ticket '${id}' del workspace '${ws}'?`,
    deleted: "Borrado",
  },
  registry: {
    lsEmpty: "No hay repos registrados. Arranca con 'navori registry scan <dir>'.",
    unknownName: "(desconocido)",
    missingTag: "  faltante",
    lsSummary: (total, missing) =>
      `${total} repo(s)${missing > 0 ? ` · ${missing} faltante(s) (corre 'registry prune')` : ""}`,
    dirNotFound: "(no encontrado)",
    addedBadge: "+ agregado",
    knownBadge: "· conocido",
    doneWord: "Listo",
    scanSummary: (added, unchanged) => `${added} agregado(s) · ${unchanged} ya registrado(s)`,
    notNavoriRepo: (path) => `No es un repo navori (sin navori.config.json): ${path}`,
    registeredVerb: "Registré",
    alreadyRegisteredVerb: "Ya estaba registrado",
    removedVerb: "Quité",
    notInRegistry: (path) => `No está en el registry: ${path}`,
    nothingToPrune: (kept) => `Nada que limpiar · ${kept} repo(s) registrado(s)`,
    prunedVerb: "Limpié",
    pruneSummary: (removed, kept) => `${removed} quitado(s) · ${kept} conservado(s)`,
  },
  remove: {
    engramAlwaysOn: "engram es always-on con navori; no se puede quitar.",
    notDeclared: (id) => `El plugin '${id}' no está en el config de este repo; nada que quitar.`,
    done: "Listo",
    confirm: (id) =>
      `¿Quitar '${id}'? Se desactiva y se limpian sus bloques, sub-bloques y scripts.`,
    renderCrashed:
      "La limpieza falló durante el render — el plugin quedó como enabled:false. Corre 'navori render --apply'.",
    renderFailedConfig: "El plugin quedó como enabled:false pero el render falló.",
    removed: (id) => `'${id}' quitado y limpiado.`,
  },
  preset: {
    reservedId: "'custom' es un id reservado (es el baseline sin extras). Elige otro nombre.",
    invalidId: (id) =>
      `Id inválido '${id}': usa kebab-case — minúsculas, números y guiones, empezando con alfanumérico.`,
    alreadyExists: (id) =>
      `Ya existe .navori/presets/${id}/ — bórralo o usa otro id si quieres regenerarlo.`,
    created: (id) => `Creado .navori/presets/${id}/`,
    configSet: (id) => `navori.config.json → preset: ${id}`,
    doneEdit: (renderCmd) => `Listo. Edita la plantilla y corre ${renderCmd} para materializarla.`,
    noConfig: (cwd, id, initCmd) =>
      `No hay navori.config.json en ${cwd}. Corre ${initCmd} y elige el preset '${id}' para activarlo.`,
    doneScaffold: "Preset local scaffoldeado. Inicializa navori para activarlo.",
    stackTemplate: (id) =>
      [
        `## Stack — ${id}`,
        "",
        "> Plantilla generada por `navori preset init`. Edítala: describe el stack,",
        "> las capas por las que fluye una petición/feature, y las reglas de oro que",
        "> el código nuevo debe seguir. Este bloque se inyecta en CLAUDE.md.",
        "",
        "### Qué es",
        "",
        "Describe en 1-2 líneas qué hace este proyecto y sobre qué stack corre.",
        "",
        "### Reglas",
        "",
        "- Regla de oro 1 (p.ej. validación siempre en el boundary).",
        "- Regla de oro 2 (p.ej. nada de `console.log`; usa el logger).",
        "",
        "Aplica las skills de este preset según la capa que toques.",
        "",
      ].join("\n"),
    skillTemplate: (skillId) =>
      [
        "---",
        `name: ${skillId}`,
        "description: Skill de ejemplo del preset. Reemplaza esta descripción por cuándo aplicarla (el frontmatter es lo que los agentes leen para descubrirla).",
        "type: reference",
        "---",
        "",
        `# ${skillId}`,
        "",
        "## Cuándo usar este skill",
        "",
        "Describe el disparador concreto (qué archivos/capa, qué tarea).",
        "",
        "## Patrón",
        "",
        "Documenta el patrón con un ejemplo mínimo. Borra este skill o renómbralo",
        "cuando agregues los reales en `skills/` y los declares en el manifest.",
        "",
      ].join("\n"),
  },
};

const CMD_EN: CmdStrings = {
  common: {
    dirNotFound: (dir) => `Directory not found: ${dir}`,
    noConfig: (path) => `No navori.config.json at ${path}. Run 'navori init' first.`,
    backupLabel: "Backup:",
    aborted: "Aborted",
    unknownConfigValues: (list) =>
      `navori: unknown config values ignored (config from a newer navori? update the CLI): ${list}`,
    deadProgressKeys: (list) =>
      `navori: obsolete keys ignored in "progress" (you can delete them from navori.config.json): ${list}`,
    userSectionPlaceholder:
      "<!-- Write your repo's domain and specific conventions here. " +
      "navori preserves everything between these markers verbatim on every render. -->",
    qualityGateNotConfigured: "(quality gate not configured — run 'navori configure quality-gate')",
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
    orphanedEngineOutputs: (count, list) =>
      `Orphaned outputs from disabled engines (${count}) — left over from an engine no longer ` +
      `in config.engines; render never touches them. Run 'navori render --prune --apply' to delete them:\n${list}`,
    prunedEngineOutputs: (count, list) =>
      `Deleted orphaned files from disabled engines (${count}) — only the ones navori wrote ` +
      `(they carry its marker), backed up before deletion:\n${list}`,
    prunePreviewEngineOutputs: (count, list) =>
      `With --apply this would delete ${count} orphaned file(s) from disabled engines — only ` +
      `the ones navori wrote (they carry its marker), backed up before deletion. This preview ` +
      `touched nothing:\n${list}`,
    keptEngineOutputs: (count, list) =>
      `Left in place what was not mine to delete (${count}) — the prune deletes file by file, ` +
      `never the whole directory. Each one carries its reason; delete them yourself if you no ` +
      `longer want them:\n${list}`,
    keptEngineOutputsPreview: (count, list) =>
      `Would keep what is not mine to delete (${count}) — the prune deletes file by file, ` +
      `never the whole directory. Each one carries its reason; delete them yourself if you no ` +
      `longer want them:\n${list}`,
    keptEngineOutputReason: (reason) => {
      switch (reason) {
        case "ephemeral":
          return "ephemeral local state; navori never versions it";
        case "symlink":
          // See the es-MX twin: a surviving link is a deliberate decision the
          // user must be able to tell apart from a prune that failed.
          return "it is a symlink: we neither follow nor unlink it; delete it yourself if you no longer want it";
        case "newer":
          // See the es-MX twin: navori DID write it, just a newer one than this
          // CLI, so `foreign`'s "we did not write it" was false (#538).
          return "written by a navori newer than your CLI: we do not roll it back; update with 'npm i -g navori@latest'";
        case "foreign":
          // See the es-MX twin: states the FACT (no marker), not the inference
          // (it is yours). A JSON written by an older navori, from before it
          // stamped `$navori`, carries none either (#538).
          return "no navori marker: we cannot confirm it is ours, so we leave it alone";
      }
    },
    downgradeWarning: ({ count, newest, ids }) =>
      `Your CLI is behind the repo: ${count} block(s) were written by a newer navori ` +
      `(up to ${newest}). They were preserved untouched to avoid downgrading them. ` +
      `Update your CLI to manage them again: npm i -g navori@latest\n  ${ids}`,
    previewWord: "Preview",
    previewHint: "run 'navori render --apply' to write",
    upToDate: "Up to date",
    upToDateHint: "nothing to apply",
    doneWord: "Done",
    coreSource: (root, bundled) => `core: ${root} ${bundled ? "(build copy)" : "(dev sources)"}`,
    // Only emitted inside navori's own monorepo, so naming its scripts is
    // correct here (a consumer repo never sees this warning).
    staleCoreBundle: (source) =>
      `Your dist/ is older than ${source}: this render compared against the assets of the last ` +
      `build, not against your working tree — it can report 'unchanged' wrongly, and an --apply ` +
      `can even revert the mirror. Run 'pnpm --filter navori build' (or 'pnpm render:apply', ` +
      `which chains both) and render again.`,
    skippedWord: "Files skipped",
    skippedOutro: (count) =>
      `${count} file(s) render refused to overwrite — the mirror is NOT up to date; ` +
      `resolve them with 'navori sync'`,
    gitignoreTitle: "Harness .gitignore:",
    gitignoreHeader:
      "# .gitignore managed by navori. The block below is regenerated by 'navori render';\n" +
      "# edit freely outside it.\n",
    prettierIgnoreTitle: "Harness .prettierignore:",
    prettierIgnoreHeader:
      "# .prettierignore managed by navori. The block below keeps the formatter from\n" +
      "# rewriting the harness files and invalidating their managed blocks' hashes.\n" +
      "# Edit freely outside the block.\n",
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
    bulkFlagsConflict:
      "--accept-new and --keep-mine are mutually exclusive: pick one. --accept-new overwrites " +
      "your edits with the rendered version; --keep-mine keeps them and applies everything else.",
    bulkFlagsInteractive:
      "--interactive cannot be combined with --accept-new/--keep-mine: one asks block by block, " +
      "the others decide in bulk without asking. Pick one.",
    bulkPreview: (mode, count) =>
      `${mode} would resolve ${count} CLAUDE.md block conflict(s). Nothing was written: ` +
      `re-run it with --apply (or --yes) to apply it.`,
    bulkApplied: (mode, count) => `${mode}: resolved ${count} CLAUDE.md block conflict(s)`,
    conflictDiffSummary: (changed, shown) =>
      `${changed} diff line(s) (showing ${shown}; - yours, + rendered)`,
    conflictDiffTruncated: (hidden) =>
      `… +${hidden} diff line(s) not shown — 'navori sync --interactive' has the full diff`,
    conflictDiffFileLevel:
      "(whole-file conflict: the preview carries no diff — compare it against the backup or " +
      "resolve it by hand)",
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
    nameMismatch: (configName, dirName, suggestedName) =>
      `The name '${configName}' in navori.config.json doesn't match the repo directory ` +
      `('${dirName}') — likely a harness copied from another repo without updating the name. ` +
      `Edit "name" to '${suggestedName}' (the directory's kebab-case form, the only shape the ` +
      `schema accepts) if it isn't intentional.`,
    orphanedEngineOutputsTitle: (n) =>
      `Orphaned outputs from disabled engines · ${n} ('navori render --prune --apply' deletes ` +
      `only the files navori wrote in there)`,
    // NEVER "safe to delete" (#496): doctor reports paths from a static
    // per-engine map without having read a byte of their contents, and that
    // recommendation is what deleted a user's own `.cursor/`. It says what it
    // knows — whose path it is and what the prune will do — and leaves the
    // file-by-file decision to the prune.
    orphanedEngineOutputRow: (engine) =>
      `— from disabled engine '${engine}' (not in engines); the prune only deletes what carries navori's marker`,
    missingPresetFiles: (preset, n, lines) =>
      `Extras of preset '${preset}' with no file (${n}) — render ` +
      `will fail reading them; create or remove them from the manifest:\n${lines}`,
    missingPresetFileRow: (path) => `— missing ${path}`,
    missingLocalSkills: (n, lines) =>
      `Project-local skills declared with no file (${n}) — create the .md (or <id>/SKILL.md) or remove the id from project.localSkills:\n${lines}`,
    missingLocalSkillRow: (id) => `— missing .claude/skills/${id}.md or ${id}/SKILL.md`,
    unknownLibraries: (n, lines) =>
      `Ids in project.libraries the registry doesn't know (${n}) — their guidance is not ` +
      `rendered and render deletes their skill from disk. Run 'navori update' to re-detect:\n${lines}`,
    unknownLibraryRemovedRow: (successors) =>
      successors
        ? `— retired from the registry; successors: ${successors}`
        : "— retired from the registry",
    unknownLibraryUnknownRow: "— unknown to this CLI version",
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
    driftDowngradeRow: (source) => `(${source}, disk ahead)`,
    driftHintDowngrade:
      "the on-disk block is newer than your CLI; render preserves it (anti-rollback), so update navori instead (e.g. 'npm i -g navori@latest')",
    corruptedSettings: (n, lines) =>
      `Corrupted settings.json (${n}) — run 'navori render --force --apply' to regenerate from the bundle (the current file is backed up):\n${lines}`,
    corruptedSettingsRow: (error) => `— invalid JSON: ${error}`,
    missingInvariants: (n, lines) =>
      `Invariants missing from the output (${n}) — a load-bearing rule disappeared; run 'navori render --apply' or check the template:\n${lines}`,
    missingInvariantRow: (source) => `— declared by ${source}`,
    malformedMarkers: (n, lines) =>
      `Malformed managed markers (${n}) — navori no longer recognizes these line(s) as a ` +
      `marker; the next render would append a duplicate block and leave the line broken. ` +
      `Fix them (or delete them) by hand:\n${lines}`,
    malformedMarkerRowUnterminated: `— missing the closing '-->'`,
    malformedMarkerRowMissingId: `— no id="…" right after the marker name`,
    duplicateMarkers: (n, lines) =>
      `Duplicate managed blocks (${n}) — the same id appears more than once in the file; ` +
      `navori only sees the FIRST copy, so the extra one is invisible to render/sync/doctor ` +
      `with possibly stale content. Remove the extra copy by hand:\n${lines}`,
    duplicateMarkerRow: (count) => `— appears ${count} times`,
    claudeHookScriptsMissing: (n, lines) =>
      `Missing hook scripts (${n}) — an active hook in .claude/settings.json references a file that ` +
      `doesn't exist, so the hook breaks or no-ops on every Bash; run 'navori render --apply' to regenerate them:\n${lines}`,
    claudeHookScriptMissingRow: "— referenced by an active hook but missing on disk",
    claudeHookScriptsNotExecutable: (n, lines) =>
      `Non-executable hook scripts (${n}) — Claude won't fire a hook whose script lacks the exec bit; ` +
      `run 'navori render --apply' to restore the +x bit:\n${lines}`,
    claudeHookScriptNotExecutableRow: "— missing the executable (+x) bit",
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
    gateNotRunnable: (n, lines) =>
      `Quality gate declared but not runnable (${n}) — the gate is what closes every ` +
      `task; if it can't run, the phases that lean on it have no net:\n${lines}`,
    gateMissingBinaryRow: (binary) => `— missing '${binary}' in PATH`,
    gateMissingScriptRow: (script) =>
      `— script '${script}' is not in that directory's package.json`,
    gateMissingDepsRow: (dir) =>
      `— no node_modules in '${dir}'; install dependencies before relying on the gate`,
    emptyUserSections: (n, lines) =>
      `Installed skills with an unfilled user-section (${n}) — they cost a read and ` +
      `only cover the universal layer; your stack's rules belong in that section:\n${lines}`,
    emptyUserSectionRow: (path) => `— untouched template in ${path}`,
    interpolationArtifacts: (n, lines) =>
      `Interpolation leftovers in the rendered tree (${n}) — 'render' only rewrites ` +
      `the managed zone, so whatever landed in the user zone stays there even after ` +
      `the interpolator is fixed. Edit those lines by hand; deleting the file also ` +
      `regenerates it clean, but you lose everything you wrote in its user zone:\n${lines}`,
    interpolationArtifactUnresolvedRow: (token) =>
      `— '${token}' published in the prose; declare that field in navori.config.json`,
    interpolationArtifactGateRow:
      "— 'quality gate not configured' prose; run 'navori configure quality-gate' " +
      "and render again",
    interpolationArtifactsMore: (n) => `  … and ${n} more`,
    diskUsage: (n, lines) =>
      `Disk usage over threshold (${n}) — nothing bounds these directories ` +
      `automatically; clean them yourself:\n${lines}`,
    diskBackupsRow: (size) => `— ${size} in backups; run 'navori backup prune' to trim them`,
    diskWorktreesRow: (size) =>
      `— ${size} in agent worktrees; review 'git worktree list' and drop stale ones ` +
      `with 'git worktree remove <path>' (they may hold uncommitted work; ` +
      `navori never deletes them itself)`,
    nestedWorktrees: (n, eslintConfig, lines) =>
      `Nested worktrees with their own node_modules while the repo runs eslint (${n}) — ` +
      `eslint resolves its config by walking up the tree, so a run started inside the ` +
      `worktree also loads the parent repo's '${eslintConfig}' and fails with "couldn't ` +
      `determine the plugin uniquely". With eslint in a pre-commit hook no agent can ` +
      `commit from there: its branch is never pushed and all you see is an abandoned ` +
      `worktree. Close the cycle from the main tree and drop the worktree with ` +
      `'git worktree remove <path>' when it's done:\n${lines}`,
    nestedWorktreeRow: "— nested checkout with its own node_modules",
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
    codegraphNotIgnored:
      "'.codegraph/' is not in .gitignore — the SQLite index churns and causes merge conflicts; add it to '.gitignore'",
    codegraphTracked:
      "'.codegraph/' is tracked by git — the binary index must not be committed; remove it ('git rm -r --cached .codegraph') and add it to '.gitignore'",
    codegraphIndexMissing:
      "codegraph index not built — run 'codegraph init' to generate '.codegraph/'",
    codegraphStale: "codegraph index may be stale (per 'codegraph status') — run 'codegraph sync'",
    gitignoreTitle: ".gitignore",
    gitignoreMissing:
      "'.gitignore' managed block is missing (gitignoreHarness ≠ off) — run 'navori render --apply'",
    gitignoreDrift:
      "'.gitignore' managed block differs from the current config — run 'navori render --apply'",
    prettierIgnoreTitle: ".prettierignore",
    prettierIgnoreMissing:
      "this repo runs prettier and nothing protects the harness files from it: a 'prettier --write .' " +
      "rewrites CLAUDE.md, invalidates the hash of its managed blocks and navori stops updating them " +
      "— run 'navori render --apply'",
    prettierIgnoreDrift:
      "'.prettierignore' managed block differs from the current config — run 'navori render --apply'",
    gitHygieneTitle: "Git hygiene",
    gitHygieneSpecsIgnored: (dir) =>
      `'${dir}/' is in .gitignore but the 'sdd' block is active — specs are lost on a branch switch and the R<n>↔test trace never reaches the PR; remove it from .gitignore or turn SDD off ("sdd": { "enabled": false })`,
    gitHygieneEphemeralNotIgnored: (path) =>
      `'${path}' is not ignored — these are ephemeral agent artifacts; add it to .gitignore (or use gitignoreHarness)`,
    workspaceDriftTitle: (workspace, siblings) =>
      `Drift from workspace '${workspace}'${siblings > 0 ? ` (${siblings} sibling repos)` : ""}:`,
    workspaceDriftDefaultRow: (key, local, expected) =>
      `${key}: ${local} (the workspace declares ${expected})`,
    workspaceDriftSiblingRow: (key, local, expected, agree, total) =>
      `${key}: ${local} (${agree}/${total} repos use ${expected})`,
    workspaceDriftHint:
      "Informational: navori never applies it for you. Adopt it with 'navori configure', or promote it to the workspace with 'navori workspace set-default'.",
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
    nextDowngradeDrift:
      "Your navori CLI is out of date (on-disk blocks are newer): update it with 'npm i -g navori@latest'. Render won't roll them back.",
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
    libraryRemovedFromRegistry: (id, successors) =>
      successors.length > 0
        ? `project.libraries: '${id}' was retired from the registry (now: ${successors.join(", ")}) and its skill is removed from disk. Run 'navori update' to re-detect the successors.`
        : `project.libraries: '${id}' was retired from the registry and its skill is removed from disk. Run 'navori update' to clean the selection.`,
    libraryUnknownInRegistry: (id) =>
      `project.libraries: '${id}' is unknown to this CLI version's registry; skipped. Run 'navori update' to re-detect libraries.`,
    managedBlocksOutOfOrder:
      "CLAUDE.md: the managed blocks are out of canonical order, but there's text of yours interleaved " +
      "between blocks, so I didn't reorder them. Move that text above the first managed block or below " +
      "the last one so navori can order them.",
    qualityGateHookSkipped: "quality-gate hook skipped: config.qualityGate.fast is not set",
    settingsParseFailed: (detail) =>
      `settings.json could not be parsed as JSON: ${detail}. Run 'navori render --force --apply' to regenerate.`,
    settingsNotObject:
      "settings.json is not a JSON object — can't merge. Run 'navori render --force --apply' to regenerate.",
    mcpJsonParseFailed: (detail) =>
      `.mcp.json could not be parsed as JSON: ${detail}. Left untouched; fix it or run 'navori render --force --apply' to regenerate.`,
    mcpJsonNotObject:
      ".mcp.json is not a JSON object — cannot merge. Left untouched; run 'navori render --force --apply' to regenerate.",
    pluginSkillNotInjected: (id, pid, target) =>
      `skill '${id}' (from @navori/plugin-${pid}) not injected: target ${target} missing (agent disabled in config.harness?)`,
    pluginLoadFailedCodex: (id, reason) =>
      `Plugin '${id}' couldn't be loaded for Codex: ${reason}.`,
    codexTrustHint:
      "Requires Codex CLI >= 0.145.0. Codex only loads `.codex/` in trusted repos; review and authorize " +
      "the new hooks with `/hooks`.",
    presetNotFoundCodex: (preset) => `Preset '${preset}' not found; Codex will use the core only.`,
    presetInvalid: (preset, detail) => `Preset '${preset}' invalid: ${detail}`,
    agentsMdRedundantWithCodex:
      "The 'agents-md' engine is redundant alongside 'codex'; Codex will be the sole owner of AGENTS.md.",
    globalBaselineIntro:
      "The following is your machine-wide navori baseline (repo-agnostic doctrine). " +
      "A project with its own navori harness supersedes it.",
  },
  blocks: {
    skillsIndex: {
      heading: "## Available skills",
      intro:
        "Skills the agents can apply; navori's own live in `.claude/skills/<id>/SKILL.md` (a skill you added yourself may be a flat `<id>.md` instead). The `·` note says when to reach for each.",
      localNote:
        "The `project-local` ones are yours — navori indexes them but never touches their content.",
    },
    agentsIndex: {
      heading: "## Available agents",
      intro:
        'Subagents you can spawn via the `Agent` tool (you are the orchestrator; see "## Role: orchestrator"). Research and review are read-only → parallelize them freely.',
      when: {
        implementer: "Writes code and tests for ONE well-scoped task.",
        reviewer: "Validates a diff against spec and quality (APPROVED / CHANGES_REQUESTED).",
        researcher:
          "Answers a concrete question about the repo (does Y happen? what consumes X?) with cited evidence.",
        explorer: "Maps a broad area or module: structure, entry points, dependencies.",
        "ticket-audit":
          "Deeply analyzes a complex ticket (critical bug, migration, multi-layer feature) before decomposing.",
        "commit-pr-pilot":
          "Writes Conventional commits and opens the PR after the reviewer's approval.",
        auditor:
          "Deep read-only audit (security, performance, SOLID, edge cases); writes a report + prioritized plan to disk.",
      },
    },
    monorepo: {
      workspaceHeading: (name) => `## Monorepo — workspace \`${name}\``,
      workspaceIntro: (name, path, tool) =>
        `You are the **\`${name}\`** workspace (\`${path}\`) of a \`${tool}\` monorepo. You have your own harness (this \`CLAUDE.md\` + \`.claude/\`); the root config and cross-cutting files (\`turbo.json\`, \`pnpm-workspace.yaml\`, base tsconfig/eslint) live at the repo root.`,
      siblingsLead:
        "Sibling workspaces — don't edit them from here; work on a sibling happens from its own harness:",
      onlyWorkspace: "For now it's the only declared workspace.",
      scopedTaskHint: (name) =>
        `Run scoped tasks with \`--filter=${name}\`. Don't import a sibling's code by relative path; consume it as a package (\`workspace:*\`).`,
      rootHeading: "## Monorepo — root",
      rootIntro: (tool) =>
        `This repo is a \`${tool}\` monorepo. The real code lives in the workspaces, each with its own harness (\`CLAUDE.md\` + \`.claude/\`). When orchestrating, **route each task to the owning workspace** and work from its \`CLAUDE.md\`, not from here.`,
      workspacesLead: "Workspaces:",
    },
    projectContext: {
      heading: "## Project context",
      intro: "Active rules derived from your config (`project.*`). They apply to all agents.",
      stageGreenfield:
        "- **Stage:** greenfield — favor speed and less ceremony, but the quality gate must still pass.",
      stageProduction:
        "- **Stage:** in production — favor NOT breaking regressions. High-blast-radius changes need human validation before merging.",
      stageMigration:
        "- **Stage:** legacy migration — watch legacy↔new compatibility. The reviewer flags CRITICAL when a change reads from one side and writes to the other.",
      migrationRow: (domain, preferred, legacy) =>
        `- **${domain} (migration):** in new code use \`${preferred}\`. \`${legacy}\` is legacy — don't add it; if you touch a module that uses it, migrate that whole module (don't mix both in the same file). The reviewer flags HIGH any new use of \`${legacy}\`.`,
      rigorStrict:
        "- **Review rigor:** strict — the reviewer blocks APPROVED on confidence 65-79 issues too, not only ≥80.",
      rigorPragmatic:
        "- **Review rigor:** pragmatic — the reviewer blocks only ≥80 issues; the rest stays as an informative note.",
      architecture: (rule) =>
        `- **Architecture:** new code MUST follow \`${rule}\`. The reviewer flags deviations as HIGH.`,
      criticalAreas: (list) => `- **Critical areas** (extra review, severity +1): ${list}.`,
      testsAlways:
        "- **Tests:** new code MUST ship with tests. The reviewer blocks APPROVED if they're missing.",
      testsWhenApplicable:
        "- **Tests:** require tests for non-trivial logic; optional for simple code.",
      testsNone: "- **Tests:** the repo doesn't require tests for new code.",
      testsExclude: (list) =>
        `- **Suites outside that rule:** ${list}. They are maintained by hand — a code change does not require updating them, and the reviewer does not block on them.`,
    },
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
    permsMerged: (count) => `${count} personal permission(s) present in settings.json`,
    permsNotMerged:
      "configured permissions missing from settings.json — run 'navori global render --apply'",
    versionOk: (v) => `version ${v}`,
    versionDrift: (found, expected) =>
      `version ${found} < CLI ${expected} — run 'navori global render --apply'`,
    hooksDisabledHint: "note: if you disabled Claude Code hooks, the baseline won't be injected",
    uninstallNothing: "No global harness to uninstall.",
    uninstallDone: (dir) => `Global harness uninstalled from ${dir}.`,
    uninstallSettingsUnreadable: (path) =>
      `Could not parse ${path}, so it was left untouched: the hook file is gone, but its ` +
      `registration is still in settings.json. Fix the JSON and run 'navori global uninstall' again.`,
    settingsParseFailed: (path, detail) =>
      `The global settings.json (${path}) could not be parsed as JSON: ${detail}. ` +
      `Nothing was written: it is your file, git does not track it and navori cannot regenerate it. ` +
      `Fix the JSON by hand and run the command again.`,
    settingsNotObject: (path) =>
      `The global settings.json (${path}) is not a JSON object — can't merge. ` +
      `Nothing was written: fix it by hand and run the command again.`,
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
    indexTitle: (ws) => `# Dominio — workspace: ${ws}`,
    indexGenerated:
      "> Generated by `navori dominio reindex` — do not edit by hand (edit the `<id>.md` entries).",
    indexEmpty:
      "_(no entries yet — the harness adds them as it discovers durable, cross-cutting facts)_",
    findingUnknownType: (type) => `unknown type '${type}' (fell back to 'gotcha')`,
    findingUnknownStatus: (status) => `unknown status '${status}' (fell back to 'canonical')`,
    findingMissingTitle: "missing 'title' in frontmatter",
    findingSupersedesUnknown: (target) => `supersedes unknown entry '${target}'`,
    findingSupersededNoTarget: "status 'superseded' but no 'supersedes' target",
    findingIndexMissing: "index missing — run `navori dominio reindex`",
    findingIndexStale: "index out of date — run `navori dominio reindex`",
  },
  migrations: {
    listEmpty:
      "No migrations found. They are created when 'init' adopts navori in replace mode (the interactive wizard) on a repo with existing Claude infrastructure.",
    total: (total, shown) => `${total} migration(s) total. Showing ${shown}:`,
    more: (n) => `  ... ${n} more (use --limit to show)`,
    done: "Done",
    notFound: (dir) => `Migration not found: ${dir}`,
    empty: (dir) => `Migration is empty: ${dir}`,
    willRestore: (n, from, to) => `Will restore ${n} file(s) from ${from} into ${to}:`,
    moreFiles: (n) => `  ... ${n} more`,
    overwriteConfirm: "Existing files will be OVERWRITTEN by the migration's snapshot. Proceed?",
    restored: (n) => `Restored ${n} file(s)`,
  },
  backup: {
    listEmpty:
      "No backups found. They are created automatically before each 'sync' or 'render' that modifies files.",
    total: (total, shown) => `${total} backup(s) total. Showing ${shown}:`,
    more: (n) => `  ... ${n} more (use --limit to show)`,
    done: "Done",
    ageJustNow: "(just now)",
    ageMinutes: (n) => `(${n} min ago)`,
    ageHours: (n) => `(${n} h ago)`,
    ageDays: (n) => `(${n} d ago)`,
    notFound: (dir) => `Backup not found: ${dir}`,
    empty: (dir) => `Backup is empty: ${dir}`,
    repoMismatch: (backupRepo, dest) =>
      `This backup is from repo '${backupRepo}' but the destination is '${dest}'. ` +
      `Make sure it's the right one before continuing.`,
    willRestore: (n, from, to) => `Will restore ${n} file(s) from ${from} into ${to}:`,
    overwriteConfirm: "Existing files will be overwritten. Proceed?",
    restored: (n) => `Restored ${n} file(s)`,
    pruneNothing: "Nothing to prune — backups are within retention and the size cap",
    pruned: (n) => `Pruned ${n} backup(s)`,
  },
  ticket: {
    listEmpty: (ws) => `No tickets. Create one with 'navori ticket new ${ws} <id>'.`,
    archiveBadge: " [archive]",
    count: (n) => `${n} ticket${n === 1 ? "" : "s"}`,
    done: "Done",
    notFound: (id, ws) =>
      `Ticket '${id}' not found in workspace '${ws}'.\n` +
      `Create it with: navori ticket new ${ws} ${id}\n`,
    contentTitle: "Content",
    noReferences:
      "Referenced in: (no repo in the workspace references this ticket in its session file)",
    referencedLabel: "Referenced in:",
    invalidId: (id) =>
      `Invalid ticket id '${id}'. Use letters, digits, hyphens, underscores (must start alphanumeric).`,
    titlePrompt: "Ticket title",
    cancelled: "Cancelled",
    wrote: (path) => `Wrote ${path}`,
    referenceHint: (id) => `Reference it from a repo's progress/current.md with:\n  ticket: ${id}`,
    archived: (path) => `Archived → ${path}`,
    unarchived: (path) => `Unarchived → ${path}`,
    deleteConfirm: (id, ws) => `Permanently delete ticket '${id}' from workspace '${ws}'?`,
    deleted: "Deleted",
  },
  registry: {
    lsEmpty: "No repos registered. Bootstrap with 'navori registry scan <dir>'.",
    unknownName: "(unknown)",
    missingTag: "  missing",
    lsSummary: (total, missing) =>
      `${total} repo(s)${missing > 0 ? ` · ${missing} missing (run 'registry prune')` : ""}`,
    dirNotFound: "(not found)",
    addedBadge: "+ added",
    knownBadge: "· known",
    doneWord: "Done",
    scanSummary: (added, unchanged) => `${added} added · ${unchanged} already registered`,
    notNavoriRepo: (path) => `Not a navori repo (no navori.config.json): ${path}`,
    registeredVerb: "Registered",
    alreadyRegisteredVerb: "Already registered",
    removedVerb: "Removed",
    notInRegistry: (path) => `Not in registry: ${path}`,
    nothingToPrune: (kept) => `Nothing to prune · ${kept} repo(s) registered`,
    prunedVerb: "Pruned",
    pruneSummary: (removed, kept) => `${removed} removed · ${kept} kept`,
  },
  remove: {
    engramAlwaysOn: "engram is always-on with navori; it can't be removed.",
    notDeclared: (id) => `Plugin '${id}' is not in this repo's config; nothing to remove.`,
    done: "Done",
    confirm: (id) =>
      `Remove '${id}'? It's disabled and its blocks, sub-blocks and scripts are cleaned up.`,
    renderCrashed:
      "Cleanup failed during render — the plugin was left as enabled:false. Run 'navori render --apply'.",
    renderFailedConfig: "The plugin was left as enabled:false but the render failed.",
    removed: (id) => `'${id}' removed and cleaned up.`,
  },
  preset: {
    reservedId: "'custom' is a reserved id (it's the baseline with no extras). Pick another name.",
    invalidId: (id) =>
      `Invalid id '${id}': use kebab-case — lowercase, digits and hyphens, starting alphanumeric.`,
    alreadyExists: (id) =>
      `.navori/presets/${id}/ already exists — delete it or use another id to regenerate it.`,
    created: (id) => `Created .navori/presets/${id}/`,
    configSet: (id) => `navori.config.json → preset: ${id}`,
    doneEdit: (renderCmd) => `Done. Edit the template and run ${renderCmd} to materialize it.`,
    noConfig: (cwd, id, initCmd) =>
      `No navori.config.json at ${cwd}. Run ${initCmd} and pick preset '${id}' to activate it.`,
    doneScaffold: "Local preset scaffolded. Initialize navori to activate it.",
    stackTemplate: (id) =>
      [
        `## Stack — ${id}`,
        "",
        "> Template generated by `navori preset init`. Edit it: describe the stack,",
        "> the layers a request/feature flows through, and the golden rules new code",
        "> must follow. This block is injected into CLAUDE.md.",
        "",
        "### What it is",
        "",
        "Describe in 1-2 lines what this project does and what stack it runs on.",
        "",
        "### Rules",
        "",
        "- Golden rule 1 (e.g. always validate at the boundary).",
        "- Golden rule 2 (e.g. no `console.log`; use the logger).",
        "",
        "Apply this preset's skills according to the layer you touch.",
        "",
      ].join("\n"),
    skillTemplate: (skillId) =>
      [
        "---",
        `name: ${skillId}`,
        "description: Example preset skill. Replace this description with when to apply it (the frontmatter is what agents read to discover it).",
        "type: reference",
        "---",
        "",
        `# ${skillId}`,
        "",
        "## When to use this skill",
        "",
        "Describe the concrete trigger (which files/layer, which task).",
        "",
        "## Pattern",
        "",
        "Document the pattern with a minimal example. Delete this skill or rename it",
        "when you add the real ones under `skills/` and declare them in the manifest.",
        "",
      ].join("\n"),
  },
};

const CMD_DICTS: Record<Lang, CmdStrings> = { es: CMD_ES, en: CMD_EN };

/** Command-output catalog for a locale. */
export function tc(lang: Lang): CmdStrings {
  return CMD_DICTS[lang];
}
