//! Strings of `packages/cli/src/lib/i18n.ts` emitted by native code, per locale. Only the entries
//! the ported commands print live here; each one is checked against the TS by the parity tests.

use crate::render::context::Lang;

/// `common.unknownConfigValues`.
#[must_use]
pub fn unknown_config_values(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: valores de config desconocidos ignorados (¿config de un navori más nuevo? actualiza el CLI): {list}"
        ),
        Lang::En => format!(
            "navori: unknown config values ignored (config from a newer navori? update the CLI): {list}"
        ),
    }
}

/// `common.unknownConfigKeys`.
#[must_use]
pub fn unknown_config_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: claves de config desconocidas (no se rechazan para mantener compatibilidad futura): {list}"
        ),
        Lang::En => format!(
            "navori: unknown config keys (not rejected to preserve forward compatibility): {list}"
        ),
    }
}

/// `common.deadProgressKeys`.
#[must_use]
pub fn dead_progress_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: claves obsoletas ignoradas en \"progress\" (puedes borrarlas del navori.config.json): {list}"
        ),
        Lang::En => format!(
            "navori: obsolete keys ignored in \"progress\" (you can delete them from navori.config.json): {list}"
        ),
    }
}

/// `common.deprecatedConfigKeys`.
#[must_use]
pub fn deprecated_config_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: perillas obsoletas sin efecto completo en runtime (puedes borrarlas del navori.config.json): {list}"
        ),
        Lang::En => format!(
            "navori: deprecated knobs without a complete runtime effect (you can delete them from navori.config.json): {list}"
        ),
    }
}

/// `engine.managedBlockEditedByHand`.
#[must_use]
pub const fn managed_block_edited_by_hand(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "bloque managed editado por el usuario; en bloques de CLAUDE.md/AGENTS.md resuelve con 'navori sync'; en archivos completos ajusta el destino a mano o muévelo aparte y corre 'navori render --apply'"
        }
        Lang::En => {
            "managed block edited by hand; for CLAUDE.md/AGENTS.md blocks resolve with 'navori sync'; for whole files adjust the destination manually or move it aside and run 'navori render --apply'"
        }
    }
}

/// `engine.managedFileEditedResolvable`.
#[must_use]
pub const fn managed_file_edited_resolvable(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "bloque managed editado por el usuario; resuélvelo con 'navori sync --interactive' (o 'navori sync --accept-new-files --apply' para aceptar la versión renderizada)"
        }
        Lang::En => {
            "managed block edited by hand; resolve it with 'navori sync --interactive' (or 'navori sync --accept-new-files --apply' to accept the rendered version)"
        }
    }
}

/// `engine.markerlessFileEditedResolvable`.
#[must_use]
pub const fn markerless_file_edited_resolvable(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "archivo sin marcador de navori (editado por el usuario o ajeno); solo 'navori sync --interactive' puede reemplazarlo completo (con backup); ningún flag masivo lo toca. Si solo conserva parte del marcador o lo menciona en un comentario, muévelo aparte y corre 'navori render --apply'"
        }
        Lang::En => {
            "file without a navori marker (edited by hand or not navori's); only 'navori sync --interactive' can replace it whole (with a backup); no bulk flag touches it. If it keeps only part of the marker or mentions it in a comment, move it aside and run 'navori render --apply'"
        }
    }
}

/// `engine.subBlockEditedByHand`.
#[must_use]
pub fn sub_block_edited_by_hand(lang: Lang, id: &str, plugin: &str) -> String {
    match lang {
        Lang::Es => format!(
            "sub-bloque '{id}' (de @navori/plugin-{plugin}) editado por el usuario; ajusta el destino a mano"
        ),
        Lang::En => format!(
            "sub-block '{id}' (from @navori/plugin-{plugin}) edited by hand; adjust the destination manually"
        ),
    }
}

/// `engine.subBlockFromNewerNavori`.
#[must_use]
pub fn sub_block_from_newer_navori(lang: Lang, id: &str, version: Option<&str>) -> String {
    let version = version.unwrap_or("?");
    match lang {
        Lang::Es => format!(
            "sub-bloque '{id}' escrito por una navori m\u{e1}s nueva ({version}); no lo toqu\u{e9}. Actualiza tu CLI"
        ),
        Lang::En => format!(
            "sub-block '{id}' written by a newer navori ({version}); left untouched. Update your CLI"
        ),
    }
}

/// `engine.pluginSkillNotInjected`.
#[must_use]
pub fn plugin_skill_not_injected(lang: Lang, id: &str, plugin: &str, target: &str) -> String {
    match lang {
        Lang::Es => format!(
            "skill '{id}' (de @navori/plugin-{plugin}) no inyectado: target {target} ausente (\u{bf}agente disabled en config.harness?)"
        ),
        Lang::En => format!(
            "skill '{id}' (from @navori/plugin-{plugin}) not injected: target {target} missing (agent disabled in config.harness?)"
        ),
    }
}

/// `engine.claudeResidualPluginHook`.
#[must_use]
pub fn claude_residual_plugin_hook(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!(
            "ALERTA: {path} puede seguir registrado en .claude/settings.json, que no se pudo actualizar; el hook puede seguir activo y no es confiable. Revisa ambos archivos manualmente."
        ),
        Lang::En => format!(
            "WARNING: {path} may remain registered in .claude/settings.json, which could not be updated; the hook may remain active and is untrusted. Review both files manually."
        ),
    }
}

/// `render.gitignoreHeader`.
#[must_use]
pub const fn gitignore_header(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "# .gitignore gestionado por navori. El bloque de abajo se regenera con 'navori render';\n# edita fuera de \u{e9}l con libertad.\n"
        }
        Lang::En => {
            "# .gitignore managed by navori. The block below is regenerated by 'navori render';\n# edit freely outside it.\n"
        }
    }
}

/// `render.prettierIgnoreHeader`.
#[must_use]
pub const fn prettier_ignore_header(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "# .prettierignore gestionado por navori. El bloque de abajo evita que el formateador\n# reescriba los archivos del harness e invalide el hash de sus bloques managed.\n# Edita fuera del bloque con libertad.\n"
        }
        Lang::En => {
            "# .prettierignore managed by navori. The block below keeps the formatter from\n# rewriting the harness files and invalidating their managed blocks' hashes.\n# Edit freely outside the block.\n"
        }
    }
}

/// `engine.settingsNotObject`.
#[must_use]
pub const fn settings_not_object(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "settings.json no es un objeto JSON \u{2014} no se puede fusionar. Corre 'navori render --force --apply' para regenerar."
        }
        Lang::En => {
            "settings.json is not a JSON object \u{2014} can't merge. Run 'navori render --force --apply' to regenerate."
        }
    }
}

/// `render.wouldWrite`.
#[must_use]
pub const fn render_would_write(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "\u{2192} preview (se escribir\u{ed}a)",
        Lang::En => "\u{2192} preview (would write)",
    }
}

/// `render.noChangePreview`.
#[must_use]
pub const fn render_no_change_preview(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "\u{2192} sin cambios",
        Lang::En => "\u{2192} no changes",
    }
}

/// `render.written`.
pub const RENDER_WRITTEN: &str = "\u{2192} written";

/// `render.noChanges`.
pub const RENDER_NO_CHANGES: &str = "\u{2192} no changes";

/// `render.engineFilesTitle`.
pub const RENDER_ENGINE_FILES_TITLE: &str = "Engine files:";

/// `render.previewWord`, the same in both languages.
pub const RENDER_PREVIEW_WORD: &str = "Preview";

/// `render.doneWord`, the same in both languages.
pub const RENDER_DONE_WORD: &str = "Done";

/// `common.backupLabel`, the same in both languages.
pub const BACKUP_LABEL: &str = "Backup:";

/// `render.docBudgetCrossed(file, managed, ceiling)`.
#[must_use]
pub fn render_doc_budget_crossed(lang: Lang, file: &str, managed: usize, ceiling: usize) -> String {
    match lang {
        Lang::Es => format!(
            "Este render cruz\u{f3} el presupuesto de arranque: '{file}' queda con {managed} palabras de bloques con techo contra un techo derivado de {ceiling}. Corre 'navori doctor' para ver qu\u{e9} bloque lo cruz\u{f3} y con qu\u{e9} palanca se recorta."
        ),
        Lang::En => format!(
            "This render crossed the startup budget: '{file}' now carries {managed} words of budgeted blocks against a derived ceiling of {ceiling}. Run 'navori doctor' to see which block crossed it and which lever trims it."
        ),
    }
}

/// The stderr line of `recordHarnessVersionIfWritten` when the config is left untouched.
#[must_use]
pub fn harness_version_not_recorded(outcome: &str) -> String {
    format!(
        "navori: harnessVersion not recorded in navori.config.json ({outcome}); the file is left untouched."
    )
}

/// `sync.planTitle(label)`, the same in both languages.
#[must_use]
pub fn sync_plan_title(label: &str) -> String {
    format!("Plan [{label}]:")
}

/// `sync.updatesAvailableTitle`, the same in both languages.
pub const SYNC_UPDATES_AVAILABLE_TITLE: &str = "Updates available:";

/// `sync.writtenToken(n)` and `sync.conflictKeptToken(n)`, the same in both languages.
#[must_use]
pub fn sync_tokens(written: usize, kept: usize) -> (String, String) {
    (
        format!("{written} written"),
        format!("{kept} conflict kept"),
    )
}

/// `sync.upToDate`.
#[must_use]
pub const fn sync_up_to_date(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "Al d\u{ed}a \u{2014} sin cambios",
        Lang::En => "Up to date \u{2014} no changes",
    }
}

/// `sync.dryRunComplete(summary)`.
#[must_use]
pub fn sync_dry_run_complete(lang: Lang, summary: &str) -> String {
    let tail = if summary.is_empty() {
        String::new()
    } else {
        format!(" \u{2014} {summary}")
    };
    match lang {
        Lang::Es => format!("Dry-run completo{tail}"),
        Lang::En => format!("Dry-run complete{tail}"),
    }
}

/// `sync.conflictsWithYes(count, lines)`.
#[must_use]
pub fn sync_conflicts_with_yes(lang: Lang, count: usize, lines: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Se detectaron {count} conflict(s) con --yes. Resu\u{e9}lvelos a mano o corre 'sync --apply' sin --yes para el flujo interactivo.\n{lines}"
        ),
        Lang::En => format!(
            "{count} conflict(s) detected with --yes. Resolve them by hand or run 'sync --apply' without --yes for the interactive flow.\n{lines}"
        ),
    }
}

/// `sync.bulkPreview(mode, count)`.
#[must_use]
pub fn sync_bulk_preview(lang: Lang, mode: &str, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "{mode} resolver\u{ed}a {count} conflicto(s) de bloques en CLAUDE.md. No escrib\u{ed} nada: vuelve a correrlo con --apply (o --yes) para aplicarlo."
        ),
        Lang::En => format!(
            "{mode} would resolve {count} CLAUDE.md block conflict(s). Nothing was written: re-run it with --apply (or --yes) to apply it."
        ),
    }
}

/// `sync.bulkApplied(mode, count)`.
#[must_use]
pub fn sync_bulk_applied(lang: Lang, mode: &str, count: usize) -> String {
    match lang {
        Lang::Es => format!("{mode}: resolv\u{ed} {count} conflicto(s) de bloques en CLAUDE.md"),
        Lang::En => format!("{mode}: resolved {count} CLAUDE.md block conflict(s)"),
    }
}

/// `sync.fileConflictsRemain(count)`.
#[must_use]
pub fn sync_file_conflicts_remain(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "{count} conflicto(s) en archivos completos se mantienen \u{2014} sync no los resuelve; aj\u{fa}stalos a mano o mueve el archivo aparte y corre 'navori render --apply' (lo regenera con el marcador)."
        ),
        Lang::En => format!(
            "{count} whole-file conflict(s) remain \u{2014} sync does not resolve them; edit by hand or move the file aside and run 'navori render --apply' (it regenerates the file with the marker)."
        ),
    }
}

/// `sync.markerlessFilesInteractiveOnly(count)`.
#[must_use]
pub fn sync_markerless_files_interactive_only(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "{count} archivo(s) sin marcador de navori quedan intactos: solo 'navori sync --interactive' puede reemplazarlos, ning\u{fa}n flag masivo los toca."
        ),
        Lang::En => format!(
            "{count} file(s) without a navori marker stay untouched: only 'navori sync --interactive' can replace them, no bulk flag touches them."
        ),
    }
}

/// `sync.fileConflictsKept(count)`.
#[must_use]
pub fn sync_file_conflicts_kept(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "{count} archivo(s) con tu edici\u{f3}n se mantienen. Corre 'navori sync --interactive' para resolverlos."
        ),
        Lang::En => format!(
            "{count} file(s) with your edit stay as they are. Run 'navori sync --interactive' to resolve them."
        ),
    }
}

/// `sync.acceptNewFilesPreview(count)`.
#[must_use]
pub fn sync_accept_new_files_preview(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "--accept-new-files sobrescribir\u{ed}a {count} archivo(s) completo(s) con tu edici\u{f3}n. No escrib\u{ed} nada: vuelve a correrlo con --apply (o --yes) para aplicarlo."
        ),
        Lang::En => format!(
            "--accept-new-files would overwrite {count} whole file(s) carrying your edit. Nothing was written: re-run it with --apply (or --yes) to apply it."
        ),
    }
}

/// `sync.acceptNewFilesApplied(count)`.
#[must_use]
pub fn sync_accept_new_files_applied(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "--accept-new-files: acept\u{e9} la versi\u{f3}n renderizada en {count} archivo(s) completo(s)"
        ),
        Lang::En => {
            format!("--accept-new-files: accepted the rendered version in {count} whole file(s)")
        }
    }
}

/// `sync.fileChangedSinceDiff(path)`.
#[must_use]
pub fn sync_file_changed_since_diff(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!(
            "{path} cambi\u{f3} en disco desde que se mostr\u{f3} el diff \u{2014} lo dej\u{e9} intacto. Vuelve a correr sync."
        ),
        Lang::En => format!(
            "{path} changed on disk since the diff was shown \u{2014} left untouched. Run sync again."
        ),
    }
}

/// `sync.wroteFiles(n)`.
#[must_use]
pub fn sync_wrote_files(lang: Lang, n: usize) -> String {
    match lang {
        Lang::Es => format!("Escrib\u{ed} {n} archivo(s)"),
        Lang::En => format!("Wrote {n} file(s)"),
    }
}

/// `sync.conflictDiffSummary(changed, shown)`.
#[must_use]
pub fn sync_conflict_diff_summary(lang: Lang, changed: usize, shown: usize) -> String {
    match lang {
        Lang::Es => format!(
            "{changed} l\u{ed}nea(s) de diff (mostrando {shown}; - tu versi\u{f3}n, + la renderizada)"
        ),
        Lang::En => format!("{changed} diff line(s) (showing {shown}; - yours, + rendered)"),
    }
}

/// `sync.conflictDiffTruncated(hidden)`.
#[must_use]
pub fn sync_conflict_diff_truncated(lang: Lang, hidden: usize) -> String {
    match lang {
        Lang::Es => format!(
            "\u{2026} +{hidden} l\u{ed}nea(s) de diff sin mostrar \u{2014} 'navori sync --interactive' trae el diff completo"
        ),
        Lang::En => format!(
            "\u{2026} +{hidden} diff line(s) not shown \u{2014} 'navori sync --interactive' has the full diff"
        ),
    }
}

/// `sync.conflictDiffFileLevel`.
#[must_use]
pub const fn sync_conflict_diff_file_level(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "(conflicto de archivo completo: el preview no trae diff \u{2014} resu\u{e9}lvelo a mano o mueve el archivo aparte y corre 'navori render --apply')"
        }
        Lang::En => {
            "(whole-file conflict: the preview carries no diff \u{2014} resolve it by hand or move the file aside and run 'navori render --apply')"
        }
    }
}

/// `remove.notDeclared(id)`.
#[must_use]
pub fn remove_not_declared(lang: Lang, id: &str) -> String {
    match lang {
        Lang::Es => {
            format!("El plugin '{id}' no est\u{e1} en el config de este repo; nada que quitar.")
        }
        Lang::En => format!("Plugin '{id}' is not in this repo's config; nothing to remove."),
    }
}

/// `remove.done`.
#[must_use]
pub const fn remove_done(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "Listo",
        Lang::En => "Done",
    }
}

/// `remove.removed(id)`.
#[must_use]
pub fn remove_removed(lang: Lang, id: &str) -> String {
    match lang {
        Lang::Es => format!("'{id}' quitado y limpiado."),
        Lang::En => format!("'{id}' removed and cleaned up."),
    }
}

/// `remove.renderCrashed`.
#[must_use]
pub const fn remove_render_crashed(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "La limpieza fall\u{f3} durante el render \u{2014} el plugin qued\u{f3} como enabled:false. Corre 'navori render --apply'."
        }
        Lang::En => {
            "Cleanup failed during render \u{2014} the plugin was left as enabled:false. Run 'navori render --apply'."
        }
    }
}

/// `adopt.refused[reason](path)`.
#[must_use]
pub fn adopt_refused(lang: Lang, reason: crate::adopt::AdoptRefusal, path: &str) -> String {
    use crate::adopt::AdoptRefusal as R;
    match (lang, reason) {
        (Lang::Es, R::OutsideRepo) => format!(
            "'{path}' est\u{e1} fuera del repo. navori solo escribe dentro del repositorio: lo de afuera se resuelve a mano, o se asume."
        ),
        (Lang::En, R::OutsideRepo) => format!(
            "'{path}' is outside the repo. navori only writes inside the repository: what lives out there you resolve yourself, or live with."
        ),
        (Lang::Es, R::Missing) => format!("'{path}' no existe."),
        (Lang::En, R::Missing) => format!("'{path}' does not exist."),
        (Lang::Es, R::NotAFile) => format!("'{path}' no es un archivo."),
        (Lang::En, R::NotAFile) => format!("'{path}' is not a file."),
        (Lang::Es, R::NotAdoptablePath) => format!(
            "'{path}' no es un asset del harness. Adoptar solo aplica a archivos .md bajo .claude/ \u{2014} escribir un marcador en cualquier otro archivo es un riesgo sin beneficio."
        ),
        (Lang::En, R::NotAdoptablePath) => format!(
            "'{path}' is not a harness asset. Adoption only applies to .md files under .claude/ \u{2014} writing a marker into any other file is risk with no upside."
        ),
        (Lang::Es, R::AlreadyManaged) => format!(
            "'{path}' ya lleva un bloque managed, as\u{ed} que no es un archivo hecho a mano. Si el bloque es de otra herramienta, resu\u{e9}lvelo t\u{fa} antes."
        ),
        (Lang::En, R::AlreadyManaged) => format!(
            "'{path}' already carries a managed block, so it is not a hand-made file. If the block belongs to another tool, resolve that first."
        ),
    }
}

/// `adopt.alreadyAdopted(path)`.
#[must_use]
pub fn adopt_already_adopted(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!("'{path}' ya estaba adoptado \u{2014} sin cambios."),
        Lang::En => format!("'{path}' was already adopted \u{2014} no changes."),
    }
}

/// `adopt.preview(path, id)`.
#[must_use]
pub fn adopt_preview(lang: Lang, path: &str, id: &str) -> String {
    match lang {
        Lang::Es => format!(
            "envolver\u{ed}a '{path}' en un bloque managed id=\"{id}\", dejando su contenido intacto"
        ),
        Lang::En => format!(
            "would wrap '{path}' in a managed block id=\"{id}\", leaving its content untouched"
        ),
    }
}

/// `adopt.previewHint`.
#[must_use]
pub const fn adopt_preview_hint(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "Preview: no se escribi\u{f3} nada. Vuelve a correrlo con --apply.",
        Lang::En => "Preview: nothing was written. Run it again with --apply.",
    }
}

/// `adopt.adopted(path, id)`.
#[must_use]
pub fn adopt_adopted(lang: Lang, path: &str, id: &str) -> String {
    match lang {
        Lang::Es => format!("'{path}' adoptado (bloque managed id=\"{id}\")."),
        Lang::En => format!("'{path}' adopted (managed block id=\"{id}\")."),
    }
}

/// `adopt.backupAt(path)`.
#[must_use]
pub fn adopt_backup_at(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!("Backup en {path}"),
        Lang::En => format!("Backup at {path}"),
    }
}

/// `render.gitignoreTitle`.
#[must_use]
pub const fn render_gitignore_title(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => ".gitignore del harness:",
        Lang::En => "Harness .gitignore:",
    }
}

/// `render.prettierIgnoreTitle`.
#[must_use]
pub const fn render_prettier_ignore_title(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => ".prettierignore del harness:",
        Lang::En => "Harness .prettierignore:",
    }
}

/// `prettierIgnoreAlreadyCovered`.
#[must_use]
pub const fn prettier_ignore_already_covered(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "Prettier detectado: tu .prettierignore ya cubre los archivos del harness \u{2014} no toqu\u{e9} nada."
        }
        Lang::En => {
            "Prettier detected: your .prettierignore already covers the harness files \u{2014} left untouched."
        }
    }
}

/// `render.orphanedEngineOutputs(count, list)`.
#[must_use]
pub fn render_orphaned_engine_outputs(lang: Lang, count: usize, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Outputs hu\u{e9}rfanos de engines desactivados ({count}) \u{2014} quedaron de un engine que ya no est\u{e1} en config.engines; render no los toca. Corre 'navori render --prune --apply' para borrarlos:\n{list}"
        ),
        Lang::En => format!(
            "Orphaned outputs from disabled engines ({count}) \u{2014} left over from an engine no longer in config.engines; render never touches them. Run 'navori render --prune --apply' to delete them:\n{list}"
        ),
    }
}

/// `render.previewHint`.
#[must_use]
pub const fn render_preview_hint(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "corre 'navori render --apply' para escribir",
        Lang::En => "run 'navori render --apply' to write",
    }
}

/// `render.upToDate`.
#[must_use]
pub const fn render_up_to_date(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "Al d\u{ed}a",
        Lang::En => "Up to date",
    }
}

/// `render.upToDateHint`.
#[must_use]
pub const fn render_up_to_date_hint(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "nada que aplicar",
        Lang::En => "nothing to apply",
    }
}

/// `render.skippedWord`.
#[must_use]
pub const fn render_skipped_word(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "Con omisiones",
        Lang::En => "Files skipped",
    }
}

/// `render.skippedOutro(count)`.
#[must_use]
pub fn render_skipped_outro(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Es => format!(
            "{count} archivo(s) que render se neg\u{f3} a sobrescribir \u{2014} el espejo NO est\u{e1} al d\u{ed}a; aj\u{fa}stalos a mano o mu\u{e9}velos aparte y corre 'navori render --apply'"
        ),
        Lang::En => format!(
            "{count} file(s) render refused to overwrite \u{2014} the mirror is NOT up to date; adjust them by hand or move them aside and run 'navori render --apply'"
        ),
    }
}

/// `render.langFallback(list)`.
#[must_use]
pub fn render_lang_fallback(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Fallback a espa\u{f1}ol para: {list} (versi\u{f3}n en ingl\u{e9}s a\u{fa}n no disponible)"
        ),
        Lang::En => {
            format!("Language fallback to Spanish for: {list} (English version not available yet)")
        }
    }
}

/// `render.downgradeWarning({ count, newest, ids })`.
#[must_use]
pub fn render_downgrade_warning(lang: Lang, count: usize, newest: &str, ids: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Tu CLI est\u{e1} detr\u{e1}s del repo: {count} bloque(s) los escribi\u{f3} una navori m\u{e1}s nueva (hasta {newest}). Los preserv\u{e9} sin tocar para no degradarlos. Actualiza tu CLI para volver a gestionarlos: npm i -g navori@latest\n  {ids}"
        ),
        Lang::En => format!(
            "Your CLI is behind the repo: {count} block(s) were written by a newer navori (up to {newest}). They were preserved untouched to avoid downgrading them. Update your CLI to manage them again: npm i -g navori@latest\n  {ids}"
        ),
    }
}

/// `engine.qualityGateHookSkipped`.
#[must_use]
pub const fn quality_gate_hook_skipped(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => "quality-gate hook omitido: config.qualityGate.fast no est\u{e1} definido",
        Lang::En => "quality-gate hook skipped: config.qualityGate.fast is not set",
    }
}

/// `engine.libraryRemovedFromRegistry`.
#[must_use]
pub fn library_removed_from_registry(lang: Lang, id: &str, successors: &[&str]) -> String {
    let now = successors.join(", ");
    match (lang, successors.is_empty()) {
        (Lang::Es, false) => format!(
            "project.libraries/extraLibraries: '{id}' fue retirada del registro (ahora: {now}) y su skill se elimina de disco. Corre 'navori refresh' para re-detectar las sucesoras."
        ),
        (Lang::Es, true) => format!(
            "project.libraries/extraLibraries: '{id}' fue retirada del registro y su skill se elimina de disco. Corre 'navori refresh' para limpiar la selecci\u{f3}n."
        ),
        (Lang::En, false) => format!(
            "project.libraries/extraLibraries: '{id}' was retired from the registry (now: {now}) and its skill is removed from disk. Run 'navori refresh' to re-detect the successors."
        ),
        (Lang::En, true) => format!(
            "project.libraries/extraLibraries: '{id}' was retired from the registry and its skill is removed from disk. Run 'navori refresh' to clean the selection."
        ),
    }
}

/// `engine.libraryUnknownInRegistry`.
#[must_use]
pub fn library_unknown_in_registry(lang: Lang, id: &str) -> String {
    match lang {
        Lang::Es => format!(
            "project.libraries/extraLibraries: '{id}' no existe en el registro de esta versi\u{f3}n del CLI; se omite. Corre 'navori refresh' para re-detectar librer\u{ed}as."
        ),
        Lang::En => format!(
            "project.libraries/extraLibraries: '{id}' is unknown to this CLI version's registry; skipped. Run 'navori refresh' to re-detect libraries."
        ),
    }
}

/// `engine.markerlessCollision(path, keys, backup)`.
#[must_use]
pub fn markerless_collision(
    lang: Lang,
    path: &str,
    keys: &[String],
    backup: Option<&str>,
) -> String {
    let list = keys.join(", ");
    match lang {
        Lang::Es => format!(
            "{path} ya exist\u{ed}a sin marcador de navori: navori lo adopta por nombre. {}Tu cuerpo y las keys ajenas se conservan.{}",
            if keys.is_empty() {
                "No sobrescribe keys de frontmatter existentes. ".to_owned()
            } else {
                format!("Sobrescribe las keys de frontmatter: {list}. ")
            },
            backup.map_or_else(String::new, |b| format!(" Respaldo del original: {b}")),
        ),
        Lang::En => format!(
            "{path} already existed without a navori marker: navori adopts it by name. {}Your body and unrelated keys are preserved.{}",
            if keys.is_empty() {
                "It overwrites no existing frontmatter keys. ".to_owned()
            } else {
                format!("It overwrites the frontmatter keys: {list}. ")
            },
            backup.map_or_else(String::new, |b| format!(" Original backed up at: {b}")),
        ),
    }
}

/// `engine.localSkillMissing`.
#[must_use]
pub fn local_skill_missing(lang: Lang, id: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Skill project-local '{id}' declarada en project.localSkills, pero ausente de .claude/skills/{id}/SKILL.md."
        ),
        Lang::En => format!(
            "Project-local skill '{id}' declared in project.localSkills, but absent from .claude/skills/{id}/SKILL.md."
        ),
    }
}

/// `engine.mcpJsonNotObject`.
#[must_use]
pub const fn mcp_json_not_object(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            ".mcp.json no es un objeto JSON \u{2014} no se puede fusionar. Se dejó intacto; corre 'navori render --force --apply' para regenerar."
        }
        Lang::En => {
            ".mcp.json is not a JSON object \u{2014} cannot merge. Left untouched; run 'navori render --force --apply' to regenerate."
        }
    }
}

/// `engine.blockFromNewerNavori`.
#[must_use]
pub fn block_from_newer_navori(lang: Lang, version: Option<&str>) -> String {
    let version = version.unwrap_or("?");
    match lang {
        Lang::Es => format!(
            "bloque escrito por una navori más nueva ({version}); no lo toqué. Actualiza tu CLI: npm i -g navori@latest"
        ),
        Lang::En => format!(
            "block written by a newer navori ({version}); left untouched. Update your CLI: npm i -g navori@latest"
        ),
    }
}

/// `engine.proseNoClaudeInfra`.
#[must_use]
pub const fn prose_no_claude_infra(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "No replica la infraestructura específica de Claude Code: orquestación de subagentes (Agent tool), hooks (quality-gate/guard-destructive) y reglas de permisos. Configúralos en tu herramienta si las necesitas."
        }
        Lang::En => {
            "Does not replicate Claude Code-specific infrastructure: subagent orchestration (Agent tool), hooks (quality-gate/guard-destructive) and permission rules. Configure them in your tool if you need them."
        }
    }
}

/// `engine.prosePluginBlocksOmitted(list)`.
#[must_use]
pub fn prose_plugin_blocks_omitted(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Bloques de plugins omitidos por asumir infraestructura de Claude Code: {list}."
        ),
        Lang::En => {
            format!("Plugin blocks omitted because they assume Claude Code infrastructure: {list}.")
        }
    }
}

/// `engine.proseModelAssignmentOmitted`.
#[must_use]
pub const fn prose_model_assignment_omitted(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "La asignación de modelo por agente (config.models) no aplica fuera de Claude Code; se omitió."
        }
        Lang::En => {
            "Per-agent model assignment (config.models) doesn't apply outside Claude Code; omitted."
        }
    }
}

/// `engine.renderFailedWriting(label, path, detail)`.
#[must_use]
pub fn render_failed_writing(lang: Lang, label: Option<&str>, path: &str, detail: &str) -> String {
    match (lang, label) {
        (Lang::Es, Some(label)) => {
            format!("El render {label} fall\u{f3} escribiendo {path}: {detail}")
        }
        (Lang::Es, None) => format!("El render fall\u{f3} escribiendo {path}: {detail}"),
        (Lang::En, Some(label)) => format!("The {label} render failed writing {path}: {detail}"),
        (Lang::En, None) => format!("The render failed writing {path}: {detail}"),
    }
}

/// `engine.backupAvailableAt(path)`.
#[must_use]
pub fn backup_available_at(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!(" Backup pre-escritura disponible en: {path}"),
        Lang::En => format!(" Backup available (pre-write) at: {path}"),
    }
}

/// `engine.managedBlocksOutOfOrder`.
#[must_use]
pub const fn managed_blocks_out_of_order(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "CLAUDE.md: los bloques managed están fuera del orden canónico, pero hay texto tuyo intercalado entre bloques, así que no los reordené. Mueve ese texto arriba del primer bloque managed o abajo del último para que navori pueda ordenarlos."
        }
        Lang::En => {
            "CLAUDE.md: the managed blocks are out of canonical order, but there's text of yours interleaved between blocks, so I didn't reorder them. Move that text above the first managed block or below the last one so navori can order them."
        }
    }
}

/// `blocks.agentsIndex`: `(heading, intro)`.
#[must_use]
pub const fn agents_index(lang: Lang) -> (&'static str, &'static str) {
    match lang {
        Lang::Es => (
            "## Agentes disponibles",
            "Subagentes que puedes lanzar con la herramienta `Agent` (tú eres el orquestador; ve \"## Role: orchestrator\"). La investigación y la revisión son de solo lectura → paraleliza sin miedo.",
        ),
        Lang::En => (
            "## Available agents",
            "Subagents you can spawn via the `Agent` tool (you are the orchestrator; see \"## Role: orchestrator\"). Research and review are read-only → parallelize them freely.",
        ),
    }
}

/// `blocks.agentsIndex.when[id]`.
#[must_use]
pub fn agent_when(lang: Lang, id: &str) -> Option<&'static str> {
    let es = lang == Lang::Es;
    Some(match id {
        "implementer" if es => {
            "Escribe código y tests para UNA tarea bien acotada. Úsalo proactivamente cuando el cambio toque 4+ archivos o 2+ no triviales."
        }
        "implementer" => {
            "Writes code and tests for ONE well-scoped task. Use proactively when a change touches 4+ files or 2+ non-trivial ones."
        }
        "reviewer" if es => {
            "Valida un diff (APPROVED / CHANGES_REQUESTED). Úsalo tras cada implementer y antes de cualquier commit, push o PR con código."
        }
        "reviewer" => {
            "Validates a diff (APPROVED / CHANGES_REQUESTED). Use after every implementer run and before any commit, push or PR."
        }
        "scout" if es => {
            "Reconocimiento de solo lectura: mapea un área o responde una pregunta acotada, con evidencia citada. Úsalo cuando una sub-pregunta convenga correr en paralelo, o una lectura convenga aislar del contexto de quien coordina."
        }
        "scout" => {
            "Read-only reconnaissance: maps an area or answers a scoped question, with cited evidence. Use when a sub-question is worth running in parallel, or a read is worth isolating from the coordinator context."
        }
        "auditor" if es => {
            "Auditoría de solo lectura con veredicto: área (seguridad, rendimiento, SOLID), ticket complejo o challenge de una propuesta, sin veredicto en el challenge. Úsalo cuando toque auditar un área o un ticket crítico, o antes de refactorizar sin ticket."
        }
        "auditor" => {
            "Read-only audit with a verdict: an area (security, performance, SOLID), a complex ticket, or a challenge of a proposed solution, no verdict on a challenge. Use when auditing an area or a critical ticket, or before refactoring one with no ticket."
        }
        "publisher" if es => {
            "Escribe commits Conventional y abre el PR. Úsalo tras la aprobación del reviewer."
        }
        "publisher" => {
            "Writes Conventional commits and opens the PR. Use after the reviewer approves."
        }
        "scribe" if es => {
            "Serializa evidencia estructurada en artefactos Markdown de handoff. Úsalo después de que un productor termine y antes de que su consumidor lea el artefacto."
        }
        "scribe" => {
            "Serializes structured evidence into Markdown handoff artifacts. Use after a producer completes and before its consumer reads the artifact."
        }
        "architect" if es => {
            "Propone qué construir y por qué, aplicando `solution-design`; no emite veredicto ni descompone. Úsalo cuando se dispare la fila arquitectónica, antes de descomponer en tareas."
        }
        "architect" => {
            "Proposes what to build and why, applying `solution-design`; issues no verdict and doesn't decompose. Use when the architectural row fires, before decomposing into tasks."
        }
        _ => return None,
    })
}

/// `tc(lang).blocks.projectContext`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectContext(pub Lang);

impl ProjectContext {
    fn es(self) -> bool {
        self.0 == Lang::Es
    }

    /// `heading`.
    #[must_use]
    pub fn heading(self) -> &'static str {
        if self.es() {
            "## Contexto del proyecto"
        } else {
            "## Project context"
        }
    }

    /// `intro`.
    #[must_use]
    pub fn intro(self) -> &'static str {
        if self.es() {
            "Reglas activas derivadas de tu config (`project.*`). Aplican a todos los agentes."
        } else {
            "Active rules derived from your config (`project.*`). They apply to all agents."
        }
    }

    /// `stageGreenfield`, `stageProduction` or `stageMigration`.
    #[must_use]
    pub fn stage(self, posture: &str) -> Option<&'static str> {
        let es = self.es();
        Some(match posture {
            "greenfield" if es => {
                "- **Etapa:** greenfield — favorece velocidad y menos ceremonia, pero el quality gate igual debe pasar."
            }
            "greenfield" => {
                "- **Stage:** greenfield — favor speed and less ceremony, but the quality gate must still pass."
            }
            "production" if es => {
                "- **Etapa:** en producción — favorece NO romper con regresiones. Los cambios de alto radio de impacto necesitan validación humana antes de mergear."
            }
            "production" => {
                "- **Stage:** in production — favor NOT breaking regressions. High-blast-radius changes need human validation before merging."
            }
            "migration" if es => {
                "- **Etapa:** migración legacy — cuida la compatibilidad legacy↔nuevo. El reviewer marca CRITICAL cuando un cambio lee de un lado y escribe en el otro."
            }
            "migration" => {
                "- **Stage:** legacy migration — watch legacy↔new compatibility. The reviewer flags CRITICAL when a change reads from one side and writes to the other."
            }
            _ => return None,
        })
    }

    /// `migrationRow`.
    #[must_use]
    pub fn migration_row(self, domain: &str, preferred: &str, legacy: &str) -> String {
        if self.es() {
            format!(
                "- **{domain} (migración):** en código nuevo usa `{preferred}`. `{legacy}` es legacy — no lo agregues; si tocas un módulo que lo usa, migra ese módulo completo (no mezcles ambos en el mismo archivo). El reviewer marca HIGH cualquier uso nuevo de `{legacy}`."
            )
        } else {
            format!(
                "- **{domain} (migration):** in new code use `{preferred}`. `{legacy}` is legacy — don't add it; if you touch a module that uses it, migrate that whole module (don't mix both in the same file). The reviewer flags HIGH any new use of `{legacy}`."
            )
        }
    }

    /// `rigorStrict` or `rigorPragmatic`.
    #[must_use]
    pub fn rigor(self, rigor: &str) -> Option<&'static str> {
        let es = self.es();
        Some(match rigor {
            "strict" if es => {
                "- **Rigor de revisión:** estricto — el reviewer bloquea APPROVED también con issues de confianza 65-79, no solo ≥80."
            }
            "strict" => {
                "- **Review rigor:** strict — the reviewer blocks APPROVED on confidence 65-79 issues too, not only ≥80."
            }
            "pragmatic" if es => {
                "- **Rigor de revisión:** pragmático — el reviewer bloquea solo issues ≥80; el resto queda como nota informativa."
            }
            "pragmatic" => {
                "- **Review rigor:** pragmatic — the reviewer blocks only ≥80 issues; the rest stays as an informative note."
            }
            _ => return None,
        })
    }

    /// `architecture`.
    #[must_use]
    pub fn architecture(self, rule: &str) -> String {
        if self.es() {
            format!(
                "- **Arquitectura:** el código nuevo DEBE seguir `{rule}`. El reviewer marca las desviaciones como HIGH."
            )
        } else {
            format!(
                "- **Architecture:** new code MUST follow `{rule}`. The reviewer flags deviations as HIGH."
            )
        }
    }

    /// `criticalAreas`.
    #[must_use]
    pub fn critical_areas(self, list: &str) -> String {
        if self.es() {
            format!("- **Áreas críticas** (revisión extra, severidad +1): {list}.")
        } else {
            format!("- **Critical areas** (extra review, severity +1): {list}.")
        }
    }

    /// `testsAlways`, `testsWhenApplicable` or `testsNone`.
    #[must_use]
    pub fn tests(self, policy: &str) -> Option<&'static str> {
        let es = self.es();
        Some(match policy {
            "always" if es => {
                "- **Tests:** el código nuevo DEBE incluir tests. El reviewer bloquea APPROVED si faltan."
            }
            "always" => {
                "- **Tests:** new code MUST ship with tests. The reviewer blocks APPROVED if they're missing."
            }
            "when-applicable" if es => {
                "- **Tests:** exige tests para lógica no trivial; opcionales para código simple."
            }
            "when-applicable" => {
                "- **Tests:** require tests for non-trivial logic; optional for simple code."
            }
            "none" if es => "- **Tests:** el repo no exige tests para código nuevo.",
            "none" => "- **Tests:** the repo doesn't require tests for new code.",
            _ => return None,
        })
    }

    /// `testsExclude`.
    #[must_use]
    pub fn tests_exclude(self, list: &str) -> String {
        if self.es() {
            format!(
                "- **Suites fuera de esa regla:** {list}. Se mantienen a mano — un cambio de código no exige actualizarlas, y el reviewer no bloquea por ellas."
            )
        } else {
            format!(
                "- **Suites outside that rule:** {list}. They are maintained by hand — a code change does not require updating them, and the reviewer does not block on them."
            )
        }
    }
}

/// `engine.pluginLoadFailedCodex(id, reason)`.
#[must_use]
pub fn plugin_load_failed_codex(lang: Lang, id: &str, reason: &str) -> String {
    match lang {
        Lang::Es => format!("Plugin '{id}' no pudo cargarse para Codex: {reason}."),
        Lang::En => format!("Plugin '{id}' couldn't be loaded for Codex: {reason}."),
    }
}

/// `engine.presetNotFoundCodex(preset)`.
#[must_use]
pub fn preset_not_found_codex(lang: Lang, preset: &str) -> String {
    match lang {
        Lang::Es => format!("Preset '{preset}' no encontrado; Codex usar\u{e1} solo el core."),
        Lang::En => format!("Preset '{preset}' not found; Codex will use the core only."),
    }
}

/// `engine.keptOrphanCodex(path, reason)` for the reasons an orphan scan gives.
#[must_use]
pub fn kept_orphan_codex(lang: Lang, path: &str, reason: &str) -> String {
    let (prefix, why) = match lang {
        Lang::Es => (
            "conservado",
            match reason {
                "newer" => {
                    "lo escribi\u{f3} una versi\u{f3}n de navori m\u{e1}s nueva que este CLI; no se revierte"
                }
                "modified" => "archivo managed editado; se conserva para no perder cambios",
                "hook-referenced" => {
                    "un hook de git, un script o un workflow a\u{fa}n lo invoca; se conserva"
                }
                "settings-referenced" => {
                    "un config.toml/settings.json que este render no reescribi\u{f3} a\u{fa}n lo registra; se conserva"
                }
                "native-hook-declared" => {
                    "el plugin declara nativeHook: true; se conserva por si tu hook nativo lo llama"
                }
                _ => {
                    "no lleva marcador de navori (ajeno); nunca se borra sin probar que navori lo escribi\u{f3}"
                }
            },
        ),
        Lang::En => (
            "kept",
            match reason {
                "newer" => "written by a navori newer than this CLI; not rolled back",
                "modified" => "user-edited managed file; kept to avoid losing changes",
                "hook-referenced" => "a git hook, a script or a workflow still invokes it; kept",
                "settings-referenced" => {
                    "a config.toml/settings.json this render did not rewrite still registers it; kept"
                }
                "native-hook-declared" => {
                    "the plugin declares nativeHook: true; kept in case your native hook calls it"
                }
                _ => {
                    "carries no navori marker (foreign); never deleted without proof navori wrote it"
                }
            },
        ),
    };
    format!("{prefix} {path} \u{2014} {why}")
}

/// `engine.codexResidualPluginHook(path)`.
#[must_use]
pub fn codex_residual_plugin_hook(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!(
            "ALERTA: {path} conserva un registro de plugin deshabilitado en .codex/config.toml; el hook puede seguir activo y no es confiable. Revisa el archivo y el script manualmente."
        ),
        Lang::En => format!(
            "WARNING: {path} retains a disabled plugin registration in .codex/config.toml; the hook may remain active and is untrusted. Review the config and script manually."
        ),
    }
}

/// `engine.codexPluginScriptChanged(path)`.
#[must_use]
pub fn codex_plugin_script_changed(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!(
            "REVISAR TRUST: cambi\u{f3} el contenido de {path}; el hash del registro Codex no cubre el script. Revisa el script antes de ejecutar o aprobar el hook."
        ),
        Lang::En => format!(
            "TRUST REVIEW: {path} content changed; the Codex registration hash does not cover script bytes. Review the script before running or approving the hook."
        ),
    }
}

/// `engine.codexTrustCommandHint(minVersion)`.
#[must_use]
pub fn codex_trust_command_hint(lang: Lang, min_version: &str) -> String {
    match lang {
        Lang::Es => format!(
            "Requiere Codex CLI >= {min_version}. Corre 'navori codex trust' para revisar y aprobar los hooks."
        ),
        Lang::En => format!(
            "Requires Codex CLI >= {min_version}. Run 'navori codex trust' to review and approve the hooks."
        ),
    }
}

/// `engine.codexRulesSummary(notBash, innerWildcard, narrowed)`.
#[must_use]
pub fn codex_rules_summary(
    lang: Lang,
    not_bash: usize,
    inner_wildcard: usize,
    narrowed: usize,
) -> String {
    let dropped = not_bash + inner_wildcard;
    match lang {
        Lang::Es => format!(
            ".codex/rules/navori.rules: {dropped} regla(s) omitida(s) ({not_bash} no-Bash, {inner_wildcard} con comod\u{ed}n interno) y {narrowed} acotada(s) en prompt/forbidden (comod\u{ed}n pegado al \u{fa}ltimo token) \u{2014} lista completa en 'navori render --json'."
        ),
        Lang::En => format!(
            ".codex/rules/navori.rules: {dropped} rule(s) dropped ({not_bash} non-Bash, {inner_wildcard} with an inner wildcard) and {narrowed} narrowed on prompt/forbidden (wildcard glued to the last token) \u{2014} full list in 'navori render --json'."
        ),
    }
}

/// `engine.agentsMdRedundantWithCodex`.
#[must_use]
pub const fn agents_md_redundant_with_codex(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "El engine 'agents-md' es redundante junto a 'codex'; Codex ser\u{e1} el \u{fa}nico due\u{f1}o de AGENTS.md."
        }
        Lang::En => {
            "The 'agents-md' engine is redundant alongside 'codex'; Codex will be the sole owner of AGENTS.md."
        }
    }
}

/// `common.noConfig(path)`.
#[must_use]
pub fn common_no_config(lang: Lang, path: &str) -> String {
    match lang {
        Lang::Es => format!("No hay navori.config.json en {path}. Corre 'navori init' primero."),
        Lang::En => format!("No navori.config.json at {path}. Run 'navori init' first."),
    }
}

/// `tc(lang).status`: the strings `status` (and `doctor`'s footer) print.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status(pub Lang);

impl Status {
    fn es(self) -> bool {
        self.0 == Lang::Es
    }

    fn pick(self, es: &'static str, en: &'static str) -> &'static str {
        if self.es() { es } else { en }
    }

    /// `nextRender`.
    #[must_use]
    pub fn next_render(self) -> &'static str {
        self.pick(
            "Corre 'navori render --apply' para generar los archivos de los engines configurados.",
            "Run 'navori render --apply' to generate files for the configured engines.",
        )
    }

    /// `nextMissingPlugins(count)`.
    #[must_use]
    pub fn next_missing_plugins(self, count: usize) -> String {
        if self.es() {
            format!("Resuelve {count} plugin(s) faltante(s): instálalos o quítalos del config.")
        } else {
            format!(
                "Resolve {count} missing plugin(s): install them or remove them from the config."
            )
        }
    }

    /// `nextContentDrift`.
    #[must_use]
    pub fn next_content_drift(self) -> &'static str {
        self.pick(
            "Corre 'navori sync --interactive' para resolver bloques editados a mano.",
            "Run 'navori sync --interactive' to resolve manually edited blocks.",
        )
    }

    /// `nextDowngradeDrift`.
    #[must_use]
    pub fn next_downgrade_drift(self) -> &'static str {
        self.pick(
            "Tu CLI navori está desactualizado (los bloques en disco son más nuevos): actualízalo con 'npm i -g navori@latest'. Render no los retrocede.",
            "Your navori CLI is out of date (on-disk blocks are newer): update it with 'npm i -g navori@latest'. Render won't roll them back.",
        )
    }

    /// `nextReorder`.
    #[must_use]
    pub fn next_reorder(self) -> &'static str {
        self.pick(
            "Corre 'navori render --apply' para reordenar los bloques de CLAUDE.md al orden canónico.",
            "Run 'navori render --apply' to reorder CLAUDE.md blocks into canonical order.",
        )
    }

    /// `nextInterleaved(lead)`.
    #[must_use]
    pub fn next_interleaved(self, lead: &str) -> String {
        if self.es() {
            format!(
                "Mueve el texto que tienes entre bloques managed de CLAUDE.md arriba del primer bloque o abajo del último{lead}; luego corre 'navori render --apply' para reordenarlos."
            )
        } else {
            format!(
                "Move your text between managed CLAUDE.md blocks above the first block or below the last{lead}; then run 'navori render --apply' to reorder them."
            )
        }
    }

    /// `nextInterleavedLead(id, pos, total)`.
    #[must_use]
    pub fn next_interleaved_lead(self, id: &str, pos: usize, total: usize) -> String {
        if self.es() {
            format!(" (p.ej. '{id}' está en posición {pos} de {total} y debería ir 1º)")
        } else {
            format!(" (e.g. '{id}' is at position {pos} of {total} and should be 1st)")
        }
    }

    /// `nextLegacyAgents(count, names)`.
    #[must_use]
    pub fn next_legacy_agents(self, count: usize, names: &str) -> String {
        if self.es() {
            format!(
                "Archiva o borra {count} agente(s) legacy ({names}); navori ya provee sus equivalentes canónicos."
            )
        } else {
            format!(
                "Archive or delete {count} legacy agent(s) ({names}); navori already provides their canonical replacements."
            )
        }
    }

    /// `nextRenderPending(count)`.
    #[must_use]
    pub fn next_render_pending(self, count: usize) -> String {
        if self.es() {
            format!(
                "Un render cambiaría {count} archivo(s)/bloque(s): corre 'navori render' para previsualizar y 'navori render --apply' para aplicar."
            )
        } else {
            format!(
                "A render would change {count} file(s)/block(s): run 'navori render' to preview and 'navori render --apply' to apply."
            )
        }
    }

    /// `renderPendingRow(count)`.
    #[must_use]
    pub fn render_pending_row(self, count: usize) -> String {
        if self.es() {
            format!("{count} por escribir/borrar (ver 'navori render')")
        } else {
            format!("{count} to write/remove (see 'navori render')")
        }
    }

    /// `allCurrent`.
    #[must_use]
    pub fn all_current(self) -> &'static str {
        self.pick(
            "Todo al día — sin acciones pendientes.",
            "Everything is up to date — no pending actions.",
        )
    }

    /// `none`.
    #[must_use]
    pub fn none(self) -> &'static str {
        self.pick("(ninguno)", "(none)")
    }

    /// `present`.
    #[must_use]
    pub fn present(self) -> &'static str {
        self.pick("presente", "present")
    }

    /// `missing`.
    #[must_use]
    pub fn missing(self) -> &'static str {
        self.pick("faltante", "missing")
    }

    /// `statusTitle(cwd)`.
    #[must_use]
    pub fn status_title(self, cwd: &str) -> String {
        if self.es() {
            format!("Estado · {cwd}")
        } else {
            format!("Status · {cwd}")
        }
    }

    /// `nextStepsTitle`.
    #[must_use]
    pub fn next_steps_title(self) -> &'static str {
        self.pick("Próximos pasos", "Next steps")
    }

    /// `issuesFound`.
    #[must_use]
    pub fn issues_found(self) -> &'static str {
        self.pick("Se encontraron problemas", "Issues found")
    }

    /// `ok`.
    #[must_use]
    pub const fn ok(self) -> &'static str {
        "OK"
    }

    /// `distributionRow(parts)`.
    #[must_use]
    pub fn distribution_row(self, parts: &str) -> String {
        if self.es() {
            format!("{parts} — detalle en 'navori doctor'")
        } else {
            format!("{parts} — details in 'navori doctor'")
        }
    }

    /// `distributionRowUncommitted(files)`.
    #[must_use]
    pub fn distribution_row_uncommitted(self, files: usize) -> String {
        if self.es() {
            format!("{files} sin commitear")
        } else {
            format!("{files} uncommitted")
        }
    }

    /// `distributionRowUnpushed(commits)`.
    #[must_use]
    pub fn distribution_row_unpushed(self, commits: u64) -> String {
        if self.es() {
            format!("{commits} sin pushear")
        } else {
            format!("{commits} unpushed")
        }
    }

    /// `distributionRowVsBase(files, ref)`.
    #[must_use]
    pub fn distribution_row_vs_base(self, files: usize, base: &str) -> String {
        if self.es() {
            format!("{files} difieren vs {base}")
        } else {
            format!("{files} differ vs {base}")
        }
    }

    /// `distributionRowBehind(commits, ref)`.
    #[must_use]
    pub fn distribution_row_behind(self, commits: u64, base: &str) -> String {
        if self.es() {
            format!("{commits} commit(s) detrás de {base}")
        } else {
            format!("{commits} commit(s) behind {base}")
        }
    }
}

/// A JS-truthy string: `Some` and not empty.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// `tc(lang).doctor` (and the one `tc(lang).engine` string `doctor` prints): only the keys the
/// native `doctor` sections use, copied from `lib/i18n.ts` by a generator so both languages stay
/// byte-identical to the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Doctor(pub Lang);

impl Doctor {
    fn es(self) -> bool {
        self.0 == Lang::Es
    }

    fn pick(self, es: &'static str, en: &'static str) -> &'static str {
        if self.es() { es } else { en }
    }

    /// `doctor.noConfigRunInit`.
    #[must_use]
    pub fn no_config_run_init(self, a: &str) -> String {
        if self.es() {
            format!("No hay navori.config.json en {a}. Corre 'navori init' primero.")
        } else {
            format!("No navori.config.json at {a}. Run 'navori init' first.")
        }
    }

    /// `doctor.configNoteTitle`.
    #[must_use]
    pub fn config_note_title(self, a: &str) -> String {
        let _ = self;
        format!("Config · {a}")
    }

    /// `doctor.fsChecksTitle`.
    #[must_use]
    pub fn fs_checks_title(self) -> &'static str {
        self.pick("Filesystem checks", "Filesystem checks")
    }

    /// `doctor.managedBlocksTitle`.
    #[must_use]
    pub fn managed_blocks_title(self, a: &str) -> String {
        if self.es() {
            format!("Bloques managed en CLAUDE.md · {a}")
        } else {
            format!("Managed blocks in CLAUDE.md · {a}")
        }
    }

    /// `doctor.noVersion`.
    #[must_use]
    pub fn no_version(self) -> &'static str {
        self.pick("(sin versión)", "(no version)")
    }

    /// `doctor.unknownSource`.
    #[must_use]
    pub fn unknown_source(self) -> &'static str {
        self.pick("(fuente desconocida)", "(unknown source)")
    }

    /// `doctor.missingPlugins`.
    #[must_use]
    pub fn missing_plugins(self, a: &str, b: &str) -> String {
        if self.es() {
            format!("Plugins declarados en config pero no cargables ({a}):\n{b}")
        } else {
            format!("Plugins declared in config but not loadable ({a}):\n{b}")
        }
    }

    /// `doctor.missingPreset`.
    #[must_use]
    pub fn missing_preset(self, a: &str) -> String {
        if self.es() {
            format!(
                "Preset '{a}' declarado en config pero no existe (ni local en .navori/presets/{a}/ ni bundled) — el render cae al baseline (sin los extras del preset). Corre 'navori preset init {a}', 'navori configure', o usa un preset válido / 'custom'."
            )
        } else {
            format!(
                "Preset '{a}' declared in config but does not exist (neither local in .navori/presets/{a}/ nor bundled) — render falls back to the baseline (without the preset extras). Run 'navori preset init {a}', 'navori configure', or use a valid preset / 'custom'."
            )
        }
    }

    /// `doctor.presetOverride`.
    #[must_use]
    pub fn preset_override(self, a: &str) -> String {
        if self.es() {
            format!(
                "Preset local '{a}' (.navori/presets/{a}/) sombrea el preset oficial del mismo nombre — se usa el local. Renómbralo si el override no es intencional."
            )
        } else {
            format!(
                "Local preset '{a}' (.navori/presets/{a}/) shadows the official preset of the same name — the local one is used. Rename it if the override is unintentional."
            )
        }
    }

    /// `doctor.placeholderName`.
    #[must_use]
    pub fn placeholder_name(self, a: &str) -> String {
        if self.es() {
            format!(
                "El name '{a}' parece un placeholder de scaffold (probablemente heredado del package.json sin renombrar). Edita \"name\" en navori.config.json si no es el nombre real del repo."
            )
        } else {
            format!(
                "The name '{a}' looks like a scaffold placeholder (probably carried over from an un-renamed package.json). Edit \"name\" in navori.config.json if it isn't the repo's real name."
            )
        }
    }

    /// `doctor.nameMismatch`.
    #[must_use]
    pub fn name_mismatch(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!(
                "El name '{a}' en navori.config.json no coincide con el directorio del repo ('{b}') — probablemente un harness copiado de otro repo sin actualizar el nombre. Edita \"name\" a '{c}' (la forma kebab-case del directorio, la única que acepta el esquema) si no es intencional."
            )
        } else {
            format!(
                "The name '{a}' in navori.config.json doesn't match the repo directory ('{b}') — likely a harness copied from another repo without updating the name. Edit \"name\" to '{c}' (the directory's kebab-case form, the only shape the schema accepts) if it isn't intentional."
            )
        }
    }

    /// `doctor.orphanedEngineOutputsTitle`.
    #[must_use]
    pub fn orphaned_engine_outputs_title(self, a: &str) -> String {
        if self.es() {
            format!(
                "Outputs huérfanos de engines desactivados · {a} ('navori render --prune --apply' borra de ahí solo los archivos que escribió navori)"
            )
        } else {
            format!(
                "Orphaned outputs from disabled engines · {a} ('navori render --prune --apply' deletes only the files navori wrote in there)"
            )
        }
    }

    /// `doctor.orphanedEngineOutputRow`.
    #[must_use]
    pub fn orphaned_engine_output_row(self, a: &str) -> String {
        if self.es() {
            format!(
                "— del engine '{a}' (no está en engines); el prune solo borra lo que lleve marcador de navori"
            )
        } else {
            format!(
                "— from disabled engine '{a}' (not in engines); the prune only deletes what carries navori's marker"
            )
        }
    }

    /// `doctor.retiredAssetsTitle`.
    #[must_use]
    pub fn retired_assets_title(self, a: &str) -> String {
        if self.es() {
            format!(
                "Archivos de ids retirados en disco · {a} ('navori render --apply' borra los que sean de navori; los ajenos, editados o de una versión más nueva se conservan)"
            )
        } else {
            format!(
                "Retired-id files still on disk · {a} ('navori render --apply' deletes the ones navori wrote; foreign, modified or newer-version ones are kept)"
            )
        }
    }

    /// `doctor.retiredPluginsTitle`.
    #[must_use]
    pub fn retired_plugins_title(self, a: &str) -> String {
        if self.es() {
            format!("Restos de plugins retirados · {a} (avisos; no afectan el veredicto de doctor)")
        } else {
            format!(
                "Retired plugin leftovers · {a} (warnings; they do not affect the doctor verdict)"
            )
        }
    }

    /// `doctor.retiredPluginBlockRow`.
    #[must_use]
    pub fn retired_plugin_block_row(self, a: &str) -> String {
        if self.es() {
            format!(
                "— bloque '{a}' de un plugin retirado; 'render --apply' lo quita si no lo editaste"
            )
        } else {
            format!(
                "— block '{a}' from a retired plugin; 'render --apply' removes it if you did not edit it"
            )
        }
    }

    /// `doctor.retiredAssetRow`.
    #[must_use]
    pub fn retired_asset_row_delete(self, a: &str) -> String {
        if self.es() {
            format!("— sucesor: {a} (se borra en el próximo 'render --apply')")
        } else {
            format!("— successor: {a} (removed on the next 'render --apply')")
        }
    }

    /// `doctor.retiredAssetRow`.
    #[must_use]
    pub fn retired_asset_row_newer(self, a: &str) -> String {
        if self.es() {
            format!("— sucesor: {a} (se conserva: escrito por una versión más nueva)")
        } else {
            format!("— successor: {a} (kept: written by a newer version)")
        }
    }

    /// `doctor.retiredAssetRow`.
    #[must_use]
    pub fn retired_asset_row_modified(self, a: &str) -> String {
        if self.es() {
            format!("— sucesor: {a} (se conserva: archivo managed editado)")
        } else {
            format!("— successor: {a} (kept: user-edited managed file)")
        }
    }

    /// `doctor.retiredAssetRow`.
    #[must_use]
    pub fn retired_asset_row_foreign(self, a: &str) -> String {
        if self.es() {
            format!("— sucesor: {a} (se conserva: ajeno, sin marcador de navori)")
        } else {
            format!("— successor: {a} (kept: foreign, no navori marker)")
        }
    }

    /// `doctor.missingPresetFiles`.
    #[must_use]
    pub fn missing_preset_files(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!(
                "Extras del preset '{a}' sin archivo ({b}) — el render fallará al leerlos; créalos o quítalos del manifest:\n{c}"
            )
        } else {
            format!(
                "Extras of preset '{a}' with no file ({b}) — render will fail reading them; create or remove them from the manifest:\n{c}"
            )
        }
    }

    /// `doctor.missingPresetFileRow`.
    #[must_use]
    pub fn missing_preset_file_row(self, a: &str) -> String {
        if self.es() {
            format!("— falta {a}")
        } else {
            format!("— missing {a}")
        }
    }

    /// `doctor.missingLocalSkills`.
    #[must_use]
    pub fn missing_local_skills(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Skills project-local declarados sin archivo ({a}) — crea el .md (o <id>/SKILL.md) o quita el id de project.localSkills:\n{b}"
            )
        } else {
            format!(
                "Project-local skills declared with no file ({a}) — create the .md (or <id>/SKILL.md) or remove the id from project.localSkills:\n{b}"
            )
        }
    }

    /// `doctor.missingLocalSkillRow`.
    #[must_use]
    pub fn missing_local_skill_row(self, a: &str) -> String {
        if self.es() {
            format!(
                "— falta .claude/skills/{a}/SKILL.md (el directorio no es opcional: un .md suelto no carga)"
            )
        } else {
            format!(
                "— missing .claude/skills/{a}/SKILL.md (the directory is not optional: a loose .md never loads)"
            )
        }
    }

    /// `doctor.unknownLibraries`.
    #[must_use]
    pub fn unknown_libraries(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Ids en project.libraries que el registro no conoce ({a}) — su guía no se renderiza y el render borra su skill de disco. Corre 'navori refresh' para re-detectar:\n{b}"
            )
        } else {
            format!(
                "Ids in project.libraries the registry doesn't know ({a}) — their guidance is not rendered and render deletes their skill from disk. Run 'navori refresh' to re-detect:\n{b}"
            )
        }
    }

    /// `doctor.unknownLibraryRemovedRow`.
    #[must_use]
    pub fn unknown_library_removed_row(self, a: &str) -> String {
        if self.es() {
            format!("— retirada del registro; sucesoras: {a}")
        } else {
            format!("— retired from the registry; successors: {a}")
        }
    }

    /// `doctor.unknownLibraryRemovedRow`.
    #[must_use]
    pub fn unknown_library_removed_row_bare(self) -> &'static str {
        self.pick("— retirada del registro", "— retired from the registry")
    }

    /// `doctor.unknownLibraryUnknownRow`.
    #[must_use]
    pub fn unknown_library_unknown_row(self) -> &'static str {
        self.pick(
            "— desconocida para esta versión del CLI",
            "— unknown to this CLI version",
        )
    }

    /// `doctor.excludedBlocksTitle`.
    #[must_use]
    pub fn excluded_blocks_title(self, a: &str) -> String {
        if self.es() {
            format!("Bloques core excluidos · {a} (blocks.exclude)")
        } else {
            format!("Excluded core blocks · {a} (blocks.exclude)")
        }
    }

    /// `doctor.excludedBlockRow`.
    #[must_use]
    pub fn excluded_block_row(self) -> &'static str {
        self.pick(
            "— no se renderiza; si existía, se quita en el próximo render",
            "— not rendered; removed on next render if it was present",
        )
    }

    /// `doctor.nonExcludableBlocks`.
    #[must_use]
    pub fn non_excludable_blocks(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Ids en blocks.exclude que NO son excluibles ({a}) — solo 'orquestacion' y 'sdd' pueden excluirse; estos bloques se siguen renderizando. Quítalos de blocks.exclude:\n{b}"
            )
        } else {
            format!(
                "Ids in blocks.exclude that are NOT excludable ({a}) — only 'orquestacion' and 'sdd' can be excluded; these blocks still render. Drop them from blocks.exclude:\n{b}"
            )
        }
    }

    /// `doctor.nonExcludableBlockRow`.
    #[must_use]
    pub fn non_excludable_block_row(self, a: &str) -> String {
        if self.es() {
            format!("— '{a}' no es excluible; el bloque permanece")
        } else {
            format!("— '{a}' is not excludable; the block stays")
        }
    }

    /// `doctor.unknownExcludedBlocks`.
    #[must_use]
    pub fn unknown_excluded_blocks(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Ids en blocks.exclude que no son bloques core conocidos ({a}) — probablemente un typo; no excluyen nada. Corrígelos o quítalos de blocks.exclude:\n{b}"
            )
        } else {
            format!(
                "Ids in blocks.exclude that are not known core blocks ({a}) — likely a typo; they exclude nothing. Fix or drop them from blocks.exclude:\n{b}"
            )
        }
    }

    /// `doctor.unknownExcludedBlockRow`.
    #[must_use]
    pub fn unknown_excluded_block_row(self, a: &str) -> String {
        if self.es() {
            format!("— '{a}' no coincide con ningún bloque core")
        } else {
            format!("— '{a}' matches no core block")
        }
    }

    /// `doctor.driftContentRow`.
    #[must_use]
    pub fn drift_content_row(self, a: &str) -> String {
        let _ = self;
        format!("({a}, content edited)")
    }

    /// `doctor.driftHarnessRow`.
    #[must_use]
    pub fn drift_harness_row(self) -> &'static str {
        self.pick(
            "(harnessVersion en navori.config.json, adelantado)",
            "(harnessVersion in navori.config.json, ahead)",
        )
    }

    /// `doctor.drift`.
    #[must_use]
    pub fn drift(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!("Drift detectado ({a}) — {b}:\n{c}")
        } else {
            format!("Drift detected ({a}) — {b}:\n{c}")
        }
    }

    /// `doctor.driftHintContent`.
    #[must_use]
    pub fn drift_hint_content(self) -> &'static str {
        self.pick(
            "corre 'navori sync' para resolver conflicts; 'navori render --apply' para restaurar los bloques editados o distintos del asset incluido",
            "run 'navori sync' to resolve conflicts; 'navori render --apply' to restore blocks that were edited or differ from the bundled asset",
        )
    }

    /// `doctor.driftDowngradeRow`.
    #[must_use]
    pub fn drift_downgrade_row(self, a: &str) -> String {
        if self.es() {
            format!("({a}, disco adelantado)")
        } else {
            format!("({a}, disk ahead)")
        }
    }

    /// `doctor.driftHintDowngrade`.
    #[must_use]
    pub fn drift_hint_downgrade(self) -> &'static str {
        self.pick(
            "el bloque en disco es más nuevo que tu CLI; render lo preserva (anti-retroceso), así que actualiza navori (p.ej. 'npm i -g navori@latest')",
            "the on-disk block is newer than your CLI; render preserves it (anti-rollback), so update navori instead (e.g. 'npm i -g navori@latest')",
        )
    }

    /// `doctor.corruptedSettings`.
    #[must_use]
    pub fn corrupted_settings(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Settings.json corrupto ({a}) — corre 'navori render --force --apply' para regenerar desde el bundle (el archivo actual se respalda):\n{b}"
            )
        } else {
            format!(
                "Corrupted settings.json ({a}) — run 'navori render --force --apply' to regenerate from the bundle (the current file is backed up):\n{b}"
            )
        }
    }

    /// `doctor.corruptedSettingsRow`.
    #[must_use]
    pub fn corrupted_settings_row(self, a: &str) -> String {
        if self.es() {
            format!("— JSON inválido: {a}")
        } else {
            format!("— invalid JSON: {a}")
        }
    }

    /// `doctor.missingInvariants`.
    #[must_use]
    pub fn missing_invariants(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Invariantes ausentes en el output ({a}) — una regla load-bearing desapareció; corre 'navori render --apply' o revisa el template:\n{b}"
            )
        } else {
            format!(
                "Invariants missing from the output ({a}) — a load-bearing rule disappeared; run 'navori render --apply' or check the template:\n{b}"
            )
        }
    }

    /// `doctor.missingInvariantRow`.
    #[must_use]
    pub fn missing_invariant_row(self, a: &str) -> String {
        if self.es() {
            format!("— declarado por {a}")
        } else {
            format!("— declared by {a}")
        }
    }

    /// `doctor.malformedMarkers`.
    #[must_use]
    pub fn malformed_markers(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Markers managed malformados ({a}) — navori ya no reconoce esta(s) línea(s) como marcador; el próximo render appendearía un bloque duplicado y dejaría la línea rota. Arréglalas a mano (o bórralas):\n{b}"
            )
        } else {
            format!(
                "Malformed managed markers ({a}) — navori no longer recognizes these line(s) as a marker; the next render would append a duplicate block and leave the line broken. Fix them (or delete them) by hand:\n{b}"
            )
        }
    }

    /// `doctor.malformedMarkerRowUnterminated`.
    #[must_use]
    pub fn malformed_marker_row_unterminated(self) -> &'static str {
        self.pick("— falta el cierre '-->'", "— missing the closing '-->'")
    }

    /// `doctor.malformedMarkerRowMissingId`.
    #[must_use]
    pub fn malformed_marker_row_missing_id(self) -> &'static str {
        self.pick(
            "— sin id=\"…\" justo tras el nombre del marcador",
            "— no id=\"…\" right after the marker name",
        )
    }

    /// `doctor.duplicateMarkers`.
    #[must_use]
    pub fn duplicate_markers(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Bloques managed duplicados ({a}) — un mismo id aparece más de una vez en el archivo; navori solo ve la PRIMERA copia, así que la sobrante queda invisible a render/sync/doctor con contenido posiblemente stale. Elimina la copia sobrante a mano:\n{b}"
            )
        } else {
            format!(
                "Duplicate managed blocks ({a}) — the same id appears more than once in the file; navori only sees the FIRST copy, so the extra one is invisible to render/sync/doctor with possibly stale content. Remove the extra copy by hand:\n{b}"
            )
        }
    }

    /// `doctor.duplicateMarkerRow`.
    #[must_use]
    pub fn duplicate_marker_row(self, a: &str) -> String {
        if self.es() {
            format!("— aparece {a} veces")
        } else {
            format!("— appears {a} times")
        }
    }

    /// `doctor.claudeHookScriptsMissing`.
    #[must_use]
    pub fn claude_hook_scripts_missing(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Scripts de hooks ausentes ({a}) — un hook activo de .claude/settings.json referencia un archivo que no existe, así que el hook truena o no hace nada en cada Bash; corre 'navori render --apply' para regenerarlos:\n{b}"
            )
        } else {
            format!(
                "Missing hook scripts ({a}) — an active hook in .claude/settings.json references a file that doesn't exist, so the hook breaks or no-ops on every Bash; run 'navori render --apply' to regenerate them:\n{b}"
            )
        }
    }

    /// `doctor.claudeHookScriptMissingRow`.
    #[must_use]
    pub fn claude_hook_script_missing_row(self) -> &'static str {
        self.pick(
            "— referenciado por un hook activo pero no existe en disco",
            "— referenced by an active hook but missing on disk",
        )
    }

    /// `doctor.claudeHookScriptsNotExecutable`.
    #[must_use]
    pub fn claude_hook_scripts_not_executable(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Scripts de hooks sin permiso de ejecución ({a}) — Claude no dispara un hook cuyo script no es ejecutable; corre 'navori render --apply' para restaurar el bit +x:\n{b}"
            )
        } else {
            format!(
                "Non-executable hook scripts ({a}) — Claude won't fire a hook whose script lacks the exec bit; run 'navori render --apply' to restore the +x bit:\n{b}"
            )
        }
    }

    /// `doctor.claudeHookScriptNotExecutableRow`.
    #[must_use]
    pub fn claude_hook_script_not_executable_row(self) -> &'static str {
        self.pick(
            "— sin bit de ejecución (+x)",
            "— missing the executable (+x) bit",
        )
    }

    /// `doctor.legacyAgents`.
    #[must_use]
    pub fn legacy_agents(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Agentes legacy ({a}) — de un harness previo; navori ya provee sus equivalentes canónicos. No los toco (son tuyos), pero conviene archivarlos o borrarlos para no quedar con dos rosters en paralelo:\n{b}"
            )
        } else {
            format!(
                "Legacy agents ({a}) — from a previous harness; navori already provides their canonical equivalents. It doesn't touch them (they're yours), but archiving or deleting them avoids running two parallel rosters:\n{b}"
            )
        }
    }

    /// `doctor.legacyAgentRow`.
    #[must_use]
    pub fn legacy_agent_row(self, a: &str) -> String {
        if self.es() {
            format!("→ superado por '{a}'")
        } else {
            format!("→ superseded by '{a}'")
        }
    }

    /// `doctor.availableExternalProviders`.
    #[must_use]
    pub fn available_external_providers(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Proveedores externos disponibles, no habilitados ({a}) — existen pero nadie los pidió:\n{b}"
            )
        } else {
            format!(
                "Available external providers, not enabled ({a}) — they exist but nobody asked for them:\n{b}"
            )
        }
    }

    /// `doctor.availableProviderRow`.
    #[must_use]
    pub fn available_provider_row(self, a: &str) -> String {
        if self.es() {
            format!("— habilítalo con 'navori add {a}'")
        } else {
            format!("— enable it with 'navori add {a}'")
        }
    }

    /// `doctor.externalProviderSetupHint`.
    #[must_use]
    pub fn external_provider_setup_hint(self, a: &str) -> String {
        if self.es() {
            format!("Guía de setup de codegraph/tgrep (índice + aprobación del MCP): {a}")
        } else {
            format!("codegraph/tgrep setup recipe (index + MCP approval): {a}")
        }
    }

    /// `doctor.missingModelProfile`.
    #[must_use]
    pub fn missing_model_profile(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Agentes sin perfil de modelo/effort ({a}) — la clave no está en navori.config.json, así que el render omite la línea en silencio y el agente hereda el modelo/effort de la sesión. Válido como default, pero si buscabas el perfil de costo, declara 'models.<agente>' / 'effort.<agente>' (ver RECOMMENDED_MODELS/RECOMMENDED_EFFORT):\n{b}"
            )
        } else {
            format!(
                "Agents with no model/effort profile ({a}) — the key is absent from navori.config.json, so render silently drops the line and the agent inherits the session's model/effort. That's a valid default, but if you meant to set the cost profile, declare 'models.<agent>' / 'effort.<agent>' (see RECOMMENDED_MODELS/RECOMMENDED_EFFORT):\n{b}"
            )
        }
    }

    /// `doctor.missingModelProfileRow`.
    #[must_use]
    pub fn missing_model_profile_row(self, a: &str) -> String {
        if self.es() {
            format!("— falta: {a}")
        } else {
            format!("— missing: {a}")
        }
    }

    /// `doctor.controlGaps`.
    #[must_use]
    pub fn control_gaps(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Controles del harness no enforced ({a}) — cada engine configurado declara su estado en un único registro (engine-capabilities.ts); esto lista los que no bloquean:\n{b}"
            )
        } else {
            format!(
                "Harness controls not enforced ({a}) — each configured engine declares its state in one registry (engine-capabilities.ts); these are the ones that don't block:\n{b}"
            )
        }
    }

    /// `doctor.controlGapsWarn`.
    #[must_use]
    pub fn control_gaps_warn(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "Controles con su flag activo pero no enforced ({a}) — activaste la condición y este engine no la aplica:\n{b}"
            )
        } else {
            format!(
                "Controls with their flag on but not enforced ({a}) — you turned the condition on and this engine doesn't apply it:\n{b}"
            )
        }
    }

    /// `doctor.orderInterleaved`.
    #[must_use]
    pub fn order_interleaved(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!(
                "Bloques managed de CLAUDE.md fuera del orden canónico — NO se pueden reordenar automáticamente porque hay texto tuyo entre bloques. Mueve ese texto arriba del primer bloque managed o abajo del último; luego corre 'navori render --apply'.\n  orden actual:   {a}\n  orden canónico: {b}{c}"
            )
        } else {
            format!(
                "CLAUDE.md managed blocks out of canonical order — they can NOT be reordered automatically because there is text of yours between blocks. Move that text above the first managed block or below the last; then run 'navori render --apply'.\n  current order:   {a}\n  canonical order: {b}{c}"
            )
        }
    }

    /// `doctor.orderReorderable`.
    #[must_use]
    pub fn order_reorderable(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!(
                "Bloques managed de CLAUDE.md fuera del orden canónico — corre 'navori render --apply' o 'navori sync' para reordenarlos (el primer bloque marca el centro de gravedad del harness).\n  orden actual:   {a}\n  orden canónico: {b}{c}"
            )
        } else {
            format!(
                "CLAUDE.md managed blocks out of canonical order — run 'navori render --apply' or 'navori sync' to reorder them (the first block marks the harness's center of gravity).\n  current order:   {a}\n  canonical order: {b}{c}"
            )
        }
    }

    /// `doctor.orderSpotlight`.
    #[must_use]
    pub fn order_spotlight(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!("\n  → '{a}' (centro de gravedad) está en posición {b} de {c}, debería ir 1º.")
        } else {
            format!("\n  → '{a}' (center of gravity) is at position {b} of {c}, should be 1st.")
        }
    }

    /// `doctor.nextStepsTitle`.
    #[must_use]
    pub fn next_steps_title(self) -> &'static str {
        self.pick("Próximos pasos", "Next steps")
    }

    /// `doctor.outroIssues`.
    #[must_use]
    pub fn outro_issues(self) -> &'static str {
        self.pick("Issues found", "Issues found")
    }

    /// `doctor.outroDriftStrict`.
    #[must_use]
    pub fn outro_drift_strict(self) -> &'static str {
        self.pick("Drift detected (--strict)", "Drift detected (--strict)")
    }

    /// `doctor.outroOk`.
    #[must_use]
    pub fn outro_ok(self) -> &'static str {
        self.pick("OK", "OK")
    }

    /// `engine.localSkillForeignPointer`.
    #[must_use]
    pub fn local_skill_foreign_pointer(self, a: &str) -> String {
        if self.es() {
            format!(
                "'{a}' no lo escribió navori; se conserva intacto. Bórralo para recibir el puntero generado hacia .claude/skills/<id>/SKILL.md."
            )
        } else {
            format!(
                "'{a}' wasn't written by navori; kept intact. Delete it to receive the generated pointer to .claude/skills/<id>/SKILL.md."
            )
        }
    }

    /// `doctor.nativeHooksTitle`.
    #[must_use]
    pub fn native_hooks_title(self) -> &'static str {
        self.pick("Hooks nativos de git", "Native git hooks")
    }

    /// `doctor.nativeHooksPluginOnlyGuarantee`.
    #[must_use]
    pub fn native_hooks_plugin_only_guarantee(self, a: &str) -> String {
        if self.es() {
            format!(
                "plugins.{a}.nativeHook: el hook nativo es la única garantía de ese chequeo si no está en qualityGate.full"
            )
        } else {
            format!(
                "plugins.{a}.nativeHook: the native hook is the only guarantee of that check unless it is in qualityGate.full"
            )
        }
    }

    /// `doctor.nativeHooksWorktreeMissing`.
    #[must_use]
    pub fn native_hooks_worktree_missing(self, a: &str) -> String {
        if self.es() {
            format!(
                "el worktree {a} no tiene un pre-commit nativo activo; ahí el commit no corre el gate"
            )
        } else {
            format!(
                "worktree {a} has no active native pre-commit; commits there do not run the gate"
            )
        }
    }

    /// `doctor.docBudgetTitle`.
    #[must_use]
    pub fn doc_budget_title(self) -> &'static str {
        self.pick(
            "Presupuesto de arranque (lo que cada sesión paga antes del primer prompt)",
            "Startup budget (what every session pays before its first prompt)",
        )
    }

    /// `doctor.docBudgetSummary`.
    #[must_use]
    pub fn doc_budget_summary(self, a: &str, b: &str, c: &str, d: &str) -> String {
        if self.es() {
            format!(
                "CLAUDE.md: {a} palabras — {b} managed contra un techo derivado de {c}, {d} de prosa tuya (se reporta, no se capea)"
            )
        } else {
            format!(
                "CLAUDE.md: {a} words — {b} managed against a derived ceiling of {c}, {d} of your own prose (reported, not capped)"
            )
        }
    }

    /// `doctor.docBudgetSubagents`.
    #[must_use]
    pub fn doc_budget_subagents(self, a: &str) -> String {
        if self.es() {
            format!(
                "en Claude, cada subagente recarga CLAUDE.md entero ({a} palabras): un ciclo implementer→reviewer→publisher lo paga una vez por agente, además de la sesión principal (no hay multiplicador fijo: los agentes los pone el ticket). No aplica a Codex, cuyos subagentes llevan sus propias 'developer_instructions'"
            )
        } else {
            format!(
                "on Claude, every subagent reloads the whole CLAUDE.md ({a} words): an implementer→reviewer→publisher cycle pays it once per agent, on top of the main session (no fixed multiplier: the ticket decides how many agents run). Not true of Codex, whose subagents carry their own 'developer_instructions'"
            )
        }
    }

    /// `doctor.docBudgetUnbudgeted`.
    #[must_use]
    pub fn doc_budget_unbudgeted(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "{a} palabras en bloques sin techo ({b}): se cuentan en el total pero quedan FUERA de la comparación — navori no envía techo para ellos, y casi siempre son bloques retirados que un 'navori render --apply' quita solo"
            )
        } else {
            format!(
                "{a} words in blocks with no ceiling ({b}): counted in the total but kept OUT of the comparison — navori ships no ceiling for them, and they are almost always retired blocks a 'navori render --apply' removes on its own"
            )
        }
    }

    /// `doctor.docBudgetMcpServers`.
    #[must_use]
    pub fn doc_budget_mcp_servers(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "{a} servidor(es) MCP activos ({b}): cada uno puede inyectar sus propias instrucciones desde el arranque — costo real, APARTE de las cifras de arriba, y no medible desde aquí sin levantar el servidor (navori no lo hace)"
            )
        } else {
            format!(
                "{a} active MCP server(s) ({b}): each can inject its own instructions from startup — a real cost, ON TOP of the figures above, and not measurable from here without starting the server (navori never does)"
            )
        }
    }

    /// `doctor.docBudgetMcpAlwaysLoad`.
    #[must_use]
    pub fn doc_budget_mcp_always_load(self, a: &str) -> String {
        if self.es() {
            format!(
                "'alwaysLoad' en {a}: fuerza carga eager de los ESQUEMAS de sus tools en vez de diferirlos vía Tool Search — no determina el costo de instrucciones de la línea anterior"
            )
        } else {
            format!(
                "'alwaysLoad' on {a}: forces eager load of their tool SCHEMAS instead of deferring via Tool Search — it does not determine the instructions cost the line above just named"
            )
        }
    }

    /// `doctor.docBudgetAgentsMd`.
    #[must_use]
    pub fn doc_budget_agents_md(self, a: &str, b: &str, c: &str, d: &str) -> String {
        if self.es() {
            format!(
                "AGENTS.md: {a} palabras ({b} bytes, {c}% del cap de {d} que Codex concatena) — se reporta, no se capea: navori ve su parte, no la cadena completa"
            )
        } else {
            format!(
                "AGENTS.md: {a} words ({b} bytes, {c}% of the {d} cap Codex concatenates against) — reported, not capped: navori sees its share, not the whole chain"
            )
        }
    }

    /// `doctor.docBudgetAgentsMdNear`.
    #[must_use]
    pub fn doc_budget_agents_md_near(self, a: &str, b: &str, c: &str, d: &str) -> String {
        if self.es() {
            format!(
                "AGENTS.md: {a} palabras ({b} bytes, {c}% del cap de {d} de Codex). Al llegar al tope Codex DEJA DE AGREGAR archivos sin avisar, y la cadena suma además tu ~/.codex/AGENTS.md y los AGENTS.md anidados — sube 'project_doc_max_bytes' o parte las instrucciones en directorios anidados"
            )
        } else {
            format!(
                "AGENTS.md: {a} words ({b} bytes, {c}% of Codex's {d} cap). At the limit Codex STOPS ADDING files with no warning, and the chain also carries your ~/.codex/AGENTS.md and any nested AGENTS.md — raise 'project_doc_max_bytes' or split the instructions across nested directories"
            )
        }
    }

    /// `doctor.docBudgetAgentsMdOverCeiling`.
    #[must_use]
    pub fn doc_budget_agents_md_over_ceiling(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!(
                "AGENTS.md ('navori-agents'): {a} palabras contra un techo de {b} ({c} de más) — se reporta, no se capea: navori no tiene standing sobre el AGENTS.md de otro repo"
            )
        } else {
            format!(
                "AGENTS.md ('navori-agents'): {a} words against a {b} ceiling ({c} over) — reported, not capped: navori has no standing over another repo's AGENTS.md"
            )
        }
    }

    /// `doctor.docBudgetCursorRules`.
    #[must_use]
    pub fn doc_budget_cursor_rules(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                ".cursor/rules/navori.mdc: {a} palabras ({b} bytes) — Cursor no publica un cap equivalente al 'project_doc_max_bytes' de Codex, así que solo se reporta el peso"
            )
        } else {
            format!(
                ".cursor/rules/navori.mdc: {a} words ({b} bytes) — Cursor publishes no equivalent of Codex's 'project_doc_max_bytes', so only the weight is reported"
            )
        }
    }

    /// `doctor.docBudgetCopilotInstructions`.
    #[must_use]
    pub fn doc_budget_copilot_instructions(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                ".github/copilot-instructions.md: {a} palabras ({b} bytes) — Copilot no publica un cap equivalente al 'project_doc_max_bytes' de Codex, así que solo se reporta el peso"
            )
        } else {
            format!(
                ".github/copilot-instructions.md: {a} words ({b} bytes) — Copilot publishes no equivalent of Codex's 'project_doc_max_bytes', so only the weight is reported"
            )
        }
    }

    /// `doctor.docBudgetContext`.
    #[must_use]
    pub fn doc_budget_context(self, a: &str, b: &str, c: &str, d: &str) -> String {
        if self.es() {
            format!(
                ".claude/context/: {a} archivo(s), {b} palabras ({c} caracteres) que entrega el hook SessionStart — se reporta, no se capea; su límite real es de ENTREGA ({d} caracteres), pasado el cual el hook manda un puntero en vez del cuerpo"
            )
        } else {
            format!(
                ".claude/context/: {a} file(s), {b} words ({c} chars) delivered by the SessionStart hook — reported, not capped; its real limit is DELIVERY ({d} chars), past which the hook sends a pointer instead of the body"
            )
        }
    }

    /// `doctor.docBudgetContextPointer`.
    #[must_use]
    pub fn doc_budget_context_pointer(self, a: &str, b: &str, c: &str) -> String {
        if self.es() {
            format!(
                "{a}: llega como PUNTERO, no inline — los archivos anteriores en el orden de entrega ya sumaban {b}/{c} caracteres. El culpable casi nunca es este archivo: es el que creció ANTES en el orden de '.claude/context/'"
            )
        } else {
            format!(
                "{a}: arrives as a POINTER, not inline — files ahead of it in delivery order already used {b}/{c} chars. The culprit is almost never this file: it's whichever one grew EARLIER in '.claude/context/'s order"
            )
        }
    }

    /// `doctor.docBudgetOverBlock`.
    #[must_use]
    pub fn doc_budget_over_block(self, a: &str, b: &str, c: &str, d: &str) -> String {
        if self.es() {
            format!("'{a}': {b} palabras contra un techo de {c} — {d}")
        } else {
            format!("'{a}': {b} words against a {c} ceiling — {d}")
        }
    }

    /// `doctor.distributionTitle`.
    #[must_use]
    pub fn distribution_title(self) -> &'static str {
        self.pick(
            "Distribución (lo que git comparte vs lo que hay en disco)",
            "Distribution (what git shares vs what is on disk)",
        )
    }

    /// `doctor.distributionUncommitted`.
    #[must_use]
    pub fn distribution_uncommitted(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "{a} archivo(s) del harness con cambios sin commitear ({b}) — el render existe solo en esta máquina: quien clone, y el CI, reciben el harness anterior"
            )
        } else {
            format!(
                "{a} harness file(s) with uncommitted changes ({b}) — the render exists only on this machine: whoever clones, and CI, get the previous harness"
            )
        }
    }

    /// `doctor.distributionUnpushed`.
    #[must_use]
    pub fn distribution_unpushed(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "{a} commit(s) del harness sin pushear a '{b}' — están commiteados pero nadie más los tiene"
            )
        } else {
            format!(
                "{a} harness commit(s) not pushed to '{b}' — they are committed, but nobody else has them"
            )
        }
    }

    /// `doctor.distributionVsBase`.
    #[must_use]
    pub fn distribution_vs_base(self, a: &str, b: &str, c: &str, d: &str) -> String {
        if self.es() {
            format!(
                "la rama base '{a}' comparte un harness distinto del que tienes en disco: {b} archivo(s) difieren, versión {c} aquí contra {d} allá — revísalo con 'git diff --stat {a} -- .claude CLAUDE.md navori.config.json'"
            )
        } else {
            format!(
                "the base branch '{a}' shares a different harness than the one on disk: {b} file(s) differ, version {c} here against {d} there — inspect it with 'git diff --stat {a} -- .claude CLAUDE.md navori.config.json'"
            )
        }
    }

    /// `doctor.distributionBehindBase`.
    #[must_use]
    pub fn distribution_behind_base(self, a: &str, b: &str) -> String {
        if self.es() {
            format!(
                "'{a}' tiene {b} commit(s) sobre archivos del harness que este checkout no tiene — la sesión está corriendo con un harness más viejo que el de la base; actualiza con 'git merge --ff-only {a}' (o el pull que uses)"
            )
        } else {
            format!(
                "'{a}' has {b} commit(s) on harness files this checkout does not have — the session is running an older harness than the base ships; catch up with 'git merge --ff-only {a}' (or your usual pull)"
            )
        }
    }

    /// `doctor.distributionHint`.
    #[must_use]
    pub fn distribution_hint(self) -> &'static str {
        self.pick(
            "Informativo: navori no commitea, pushea ni mergea por ti, y una rama de trabajo con cambios de harness que la base aún no tiene es un estado normal. Se reporta porque ninguna otra verificación mira git, y medir una sesión sobre un harness que solo existe en esta máquina es el error que esta sección existe para evitar.",
            "Informational: navori does not commit, push or merge for you, and a working branch carrying harness changes the base has not merged yet is a normal state. It is reported because no other check looks at git, and measuring a session against a harness that exists only on this machine is the mistake this section exists to prevent.",
        )
    }

    /// `doctor.docBudgetLever`.
    #[must_use]
    pub fn doc_budget_lever_project_context(self) -> &'static str {
        self.pick(
            "recorta 'project.criticalAreas' / 'legacyPaths' / 'libraryMigrations' en navori.config.json",
            "trim 'project.criticalAreas' / 'legacyPaths' / 'libraryMigrations' in navori.config.json",
        )
    }

    /// `doctor.docBudgetLever`.
    #[must_use]
    pub fn doc_budget_lever_preset(self) -> &'static str {
        self.pick(
            "cambia o quita el preset ('preset' en navori.config.json)",
            "change or drop the preset ('preset' in navori.config.json)",
        )
    }

    /// `doctor.docBudgetLever`.
    #[must_use]
    pub fn doc_budget_lever_plugins(self) -> &'static str {
        self.pick(
            "deshabilita los plugins que no uses ('plugins' en navori.config.json)",
            "disable the plugins you don't use ('plugins' in navori.config.json)",
        )
    }

    /// `doctor.docBudgetLever`.
    #[must_use]
    pub fn doc_budget_lever_core(self) -> &'static str {
        self.pick(
            "es un bloque core de navori: repórtalo como issue, no es tuyo de recortar",
            "this is a navori core block: report it as an issue, it isn't yours to trim",
        )
    }

    /// `doctor.nativeHooksFound(event, manager, path, absence)`.
    #[must_use]
    pub fn native_hooks_found(
        self,
        event: &str,
        manager: Option<&str>,
        path: Option<&str>,
        absence: Option<&str>,
    ) -> String {
        if let Some(manager) = non_empty(manager) {
            return if self.es() {
                format!("{event}: activo ({manager}) en {}", path.unwrap_or("null"))
            } else {
                format!("{event}: active ({manager}) at {}", path.unwrap_or("null"))
            };
        }
        let word = self.pick("ausente", "absent");
        let absence = non_empty(absence).map_or_else(String::new, |a| format!(" ({a})"));
        let path = non_empty(path).map_or_else(String::new, |p| format!(" \u{2014} {p}"));
        format!("{event}: {word}{absence}{path}")
    }

    /// `doctor.nativeHooksGateMissing(manager, absence, gitVersion)`.
    #[must_use]
    pub fn native_hooks_gate_missing(
        self,
        manager: Option<&str>,
        absence: Option<&str>,
        git_version: Option<&str>,
    ) -> String {
        let manager = non_empty(manager).map_or_else(String::new, |m| {
            if self.es() {
                format!(" (gestor: {m})")
            } else {
                format!(" (manager: {m})")
            }
        });
        let absence = non_empty(absence).map_or_else(String::new, |a| {
            if self.es() {
                format!(" \u{2014} cuenta como ausente: {a}")
            } else {
                format!(" \u{2014} counts as absent: {a}")
            }
        });
        let version = non_empty(git_version).map_or_else(String::new, |v| format!(" [{v}]"));
        if self.es() {
            format!(
                "qualityGate.nativeHooks est\u{e1} declarado pero no hay un pre-commit nativo activo en este clone o worktree{manager}{absence}{version}; navori ya no corre el gate en el commit, instala el hook (p. ej. 'bun run hooks:install') o quita la declaraci\u{f3}n"
            )
        } else {
            format!(
                "qualityGate.nativeHooks is declared but no native pre-commit is active in this clone or worktree{manager}{absence}{version}; navori no longer runs the gate on commit, install the hook (e.g. 'bun run hooks:install') or drop the declaration"
            )
        }
    }

    /// `doctor.nativeHooksPluginMissing(plugin, gitVersion)`.
    #[must_use]
    pub fn native_hooks_plugin_missing(self, plugin: &str, git_version: Option<&str>) -> String {
        let version = git_version
            .filter(|v| !v.is_empty())
            .map_or_else(String::new, |v| format!(" [{v}]"));
        if self.es() {
            format!(
                "plugins.{plugin}.nativeHook est\u{e1} declarado pero no hay pre-commit ni pre-push nativo activo en este clone o worktree{version}; el chequeo de '{plugin}' ya no corre en ning\u{fa}n lado"
            )
        } else {
            format!(
                "plugins.{plugin}.nativeHook is declared but no native pre-commit or pre-push is active in this clone or worktree{version}; the '{plugin}' check now runs nowhere"
            )
        }
    }

    /// `doctor.nativeHooksDuplicate(manager, path)`.
    #[must_use]
    pub fn native_hooks_duplicate(self, manager: Option<&str>, path: Option<&str>) -> String {
        let manager = non_empty(manager).map_or_else(String::new, |m| format!(" ({m})"));
        let path = non_empty(path).map_or_else(String::new, |p| {
            if self.es() {
                format!(" en {p}")
            } else {
                format!(" at {p}")
            }
        });
        if self.es() {
            format!(
                "hay un pre-commit nativo activo{manager}{path} y qualityGate.nativeHooks no est\u{e1} declarado: los checks mec\u{e1}nicos corren duplicados; declara \"qualityGate\": {{ \"nativeHooks\": true }} si el hook corre qualityGate.fast"
            )
        } else {
            format!(
                "a native pre-commit is active{manager}{path} and qualityGate.nativeHooks is not declared: mechanical checks run twice; declare \"qualityGate\": {{ \"nativeHooks\": true }} if the hook runs qualityGate.fast"
            )
        }
    }
}
