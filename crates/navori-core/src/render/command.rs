//! `navori render` over a solo-Claude root (spec 0058 E3 M6 and M8, D23): `runRenderCore` and
//! the two outputs of `renderCommand.run`, the human report and `--json`.
//!
//! The pipeline follows `runRenderCore`: the Claude plan, the root `.gitignore`, the nested
//! `.claude`, `.codex` and `.navori` ones, `.prettierignore` and the orphaned engine outputs
//! scan. With [`Apply`] each step commits through the `Fs` layer (one `commitWrites` each, so
//! one backup each) before the next one reads the disk, as the TS does; then `harnessVersion` is
//! recorded when something was really written. Workspaces, other engines and `--prune` are
//! outside the native subset (Q8), so their report sections are always empty here.
//!
//! The core provenance is `(embedded)`: Rust reads no `core-assets` directory, so it never names
//! one (Q11). The oracle masks the TS side of that line and of the three `--json` keys.

use std::path::Path;

use jiff::Zoned;

use crate::backup::BackupStore;
use crate::commit::{CommitError, CommitInput, commit_writes};
use crate::config::{Config, HarnessRecord, record_harness_version};
use crate::fs::{Fs, FsError, write_file_atomic};
use crate::i18n;
use crate::js_json::{JsObject, JsValue};
use crate::markers::InjectStatus;
use crate::render::block_plan::PlanOptions;
use crate::render::claude::{ClaudeEnginePlan, plan_claude_engine};
use crate::render::collect::{PendingWrite, RepoView};
use crate::render::context::Lang;
use crate::render::doc_budget::{DocBudget, measure_doc_budget};
use crate::render::ignore_files::{
    IgnoreFile, plan_gitignore, plan_prettierignore, scan_orphaned_engine_outputs,
};
use crate::render::nested_gitignore::{NESTED_GITIGNORE_DIRS, plan_nested_gitignore};
use crate::render::report::{
    Clack, claude_md_section, downgrade_section, engine_files_section, lang_fallback_section,
    status_symbol, unchanged_engine_files, written,
};

/// What Rust prints where the TS names the `core-assets` root it read.
pub const EMBEDDED_CORE: &str = "(embedded)";

/// Some step delegates: the invocation goes to the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderDelegate;

/// Why a render stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// A step delegates. With [`Apply`], only possible before the first commit.
    Delegate,
    /// A commit failed: the TS throws this out of the command.
    Commit(CommitError),
    /// Recording `harnessVersion` failed to write.
    Record(FsError),
}

/// What a real (`--apply`) render writes through.
pub struct Apply<'a> {
    /// The filesystem.
    pub fs: &'a mut dyn Fs,
    /// The backup store of this process.
    pub backups: &'a mut BackupStore,
    /// The current time, for backup names and the purge.
    pub now: &'a Zoned,
}

/// What an applied render did beyond its plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// The Claude commit's backup.
    pub backup_path: Option<String>,
    /// `noteRealWrite()` calls across every commit.
    pub real_writes: usize,
    /// `recordHarnessVersion`'s outcome, when something was really written.
    pub harness: Option<HarnessRecord>,
    /// `CLAUDE.md`'s budget after the render, when it crossed from within to over.
    pub budget_crossed: Option<DocBudget>,
}

/// One reconciled ignore file (`GitignoreRenderResult`/`PrettierIgnoreResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IgnoreResult {
    /// `path`, relative to the root.
    pub path: String,
    /// What the inject did.
    pub status: InjectStatus,
    /// Why a kept block was not touched.
    pub skipped_reason: Option<String>,
    /// `.prettierignore` only: the entries its block protects.
    pub entries: Vec<String>,
    /// The file after the inject.
    pub content: String,
    /// The snapshot its commit took, when it overwrote an existing file.
    pub backup_path: Option<String>,
}

impl IgnoreResult {
    fn from_ignore_file(file: IgnoreFile) -> Self {
        Self {
            path: file.rel_path.to_owned(),
            status: file.status,
            skipped_reason: file.skipped_reason,
            entries: file.entries,
            content: file.content,
            backup_path: None,
        }
    }

    fn pending(&self) -> bool {
        matches!(self.status, InjectStatus::Created | InjectStatus::Updated)
    }

    fn skipped(&self) -> bool {
        matches!(
            self.status,
            InjectStatus::UserModifiedSkipped | InjectStatus::DowngradeSkipped
        )
    }
}

/// The result of `runRenderCore` on a solo-Claude root without workspaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPlan {
    /// `resolveLang(config.language)`.
    pub lang: Lang,
    /// The Claude engine's plan.
    pub claude: ClaudeEnginePlan,
    /// The root `.gitignore`; `None` in mode `off`.
    pub gitignore: Option<IgnoreResult>,
    /// `.claude/.gitignore`.
    pub claude_gitignore: Option<IgnoreResult>,
    /// `.codex/.gitignore`.
    pub codex_gitignore: Option<IgnoreResult>,
    /// `.navori/.gitignore`.
    pub navori_gitignore: Option<IgnoreResult>,
    /// `.prettierignore`; `None` without prettier.
    pub prettierignore: Option<IgnoreResult>,
    /// `scanOrphanedEngineOutputs`: `(engine, paths)`.
    pub orphaned_engine_outputs: Vec<(String, Vec<String>)>,
    /// `Some` for a real render.
    pub applied: Option<Applied>,
}

impl RenderPlan {
    /// The ignore files in the order the TS reports and counts them.
    fn ignore_files(&self) -> [Option<&IgnoreResult>; 5] {
        [
            self.gitignore.as_ref(),
            self.claude_gitignore.as_ref(),
            self.codex_gitignore.as_ref(),
            self.navori_gitignore.as_ref(),
            self.prettierignore.as_ref(),
        ]
    }

    /// `result.written`: the Claude engine has something to write or delete.
    #[must_use]
    pub fn claude_changed(&self) -> bool {
        !written(&self.claude).is_empty()
    }

    /// `resultHasPendingWrites(result)`.
    #[must_use]
    pub fn has_pending_writes(&self) -> bool {
        self.claude_changed()
            || self
                .ignore_files()
                .into_iter()
                .flatten()
                .any(IgnoreResult::pending)
    }

    /// `countSkippedFiles(result)`.
    #[must_use]
    pub fn skipped_files(&self) -> usize {
        self.claude.skipped.len()
            + self
                .ignore_files()
                .into_iter()
                .flatten()
                .filter(|f| f.skipped())
                .count()
    }

    /// `countRenderStatuses(result)`, in the key order of its object.
    #[must_use]
    pub fn status_counts(&self) -> Vec<(&'static str, usize)> {
        let mut counts: Vec<(&'static str, usize)> = Vec::new();
        let mut bump = |status: &'static str, n: usize| {
            if n == 0 {
                return;
            }
            match counts.iter_mut().find(|(s, _)| *s == status) {
                Some((_, count)) => *count += n,
                None => counts.push((status, n)),
            }
        };
        for (_, status) in &self.claude.claude_md_entries {
            bump(status.as_str(), 1);
        }
        for (path, status) in written(&self.claude) {
            if path != "CLAUDE.md" {
                bump(status, 1);
            }
        }
        bump("unchanged", unchanged_engine_files(&self.claude));
        for file in self.ignore_files().into_iter().flatten() {
            if !file.skipped() {
                bump(file.status.as_str(), 1);
            }
        }
        counts
    }
}

/// `config.engines ?? ["claude"]`, its strings.
fn engines(config: &JsValue) -> Vec<String> {
    let JsValue::Object(root) = config else {
        return vec!["claude".to_owned()];
    };
    match root.get("engines") {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        _ => vec!["claude".to_owned()],
    }
}

/// The render's options besides apply.
#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
    /// Overrides the embedded manifest's hooks, as in [`PlanOptions`].
    pub native_hooks: Option<std::collections::BTreeMap<String, crate::manifest::Hook>>,
    /// `--force`.
    pub force: bool,
}

/// `runRenderCore(cwd, { dryRun: true, force })` on the root at `repo_root`, read through
/// `view`.
///
/// # Errors
/// [`RenderDelegate`] when any step delegates.
pub fn plan_render(
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    options: &RenderOptions,
) -> Result<RenderPlan, RenderDelegate> {
    run_render(view, config, repo_root, options, None).map_err(|_| RenderDelegate)
}

/// One ignore file's `commitWrites` (no `writeLast`, no removals): its backup path.
fn commit_ignore_file(
    apply: &mut Apply<'_>,
    repo_root: &Path,
    file: &IgnoreResult,
    lang: Lang,
) -> Result<(Option<String>, usize), RenderError> {
    let mut pending = [PendingWrite {
        rel_path: file.path.clone(),
        content: file.content.clone(),
        status: file.status,
        chmod_exec: false,
    }];
    let input = CommitInput {
        cwd: repo_root,
        backup_exclude: &[],
        dry_run: false,
        write_last: None,
        engine_label: None,
        removals_best_effort: false,
        lang,
        now: apply.now,
    };
    let committed = commit_writes(apply.fs, apply.backups, &mut pending, &[], &input)
        .map_err(RenderError::Commit)?;
    Ok((
        committed.backup_path.map(|p| p.display().to_string()),
        committed.real_writes,
    ))
}

/// `prepareClaudeEngine(...).commit()`: one `commitWrites` with `CLAUDE.md` last and removals
/// best-effort, then the collision warnings rewritten with the backup path. Returns the backup
/// and the real writes; `claude.pending` is left in commit order.
///
/// # Errors
/// [`RenderError::Commit`] where the TS throws.
pub fn commit_claude(
    apply: &mut Apply<'_>,
    repo_root: &Path,
    claude: &mut ClaudeEnginePlan,
    lang: Lang,
) -> Result<(Option<String>, usize), RenderError> {
    let claude_md = |w: &PendingWrite| w.rel_path == "CLAUDE.md";
    let input = CommitInput {
        cwd: repo_root,
        backup_exclude: &[],
        dry_run: false,
        write_last: Some(&claude_md),
        engine_label: None,
        removals_best_effort: true,
        lang,
        now: apply.now,
    };
    let committed = commit_writes(
        apply.fs,
        apply.backups,
        &mut claude.pending,
        &claude.removals,
        &input,
    )
    .map_err(RenderError::Commit)?;
    let backup_path = committed.backup_path.map(|p| p.display().to_string());
    if let Some(backup) = &backup_path {
        // `collisionWarnings(collisions, backupPath, lang)`, now with the backup.
        for (offset, (path, keys)) in claude.collisions.iter().enumerate() {
            if let Some(slot) = claude
                .warnings
                .get_mut(claude.collision_warnings_at + offset)
            {
                let original = Path::new(backup).join(path).display().to_string();
                *slot = i18n::markerless_collision(lang, path, keys, Some(&original));
            }
        }
    }
    Ok((backup_path, committed.real_writes))
}

/// `readFileOrEmpty` + `measureDocBudget` on the root `CLAUDE.md`.
fn claude_md_budget(view: &dyn RepoView) -> DocBudget {
    measure_doc_budget(&view.read("CLAUDE.md").unwrap_or_default())
}

/// `runRender(cwd, { dryRun: apply.is_none() })` on the root at `repo_root`, read through
/// `view`, which must show the disk `apply` writes to.
///
/// # Errors
/// [`RenderError`] where a step delegates or the TS throws.
pub fn run_render(
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    options: &RenderOptions,
    mut apply: Option<&mut Apply<'_>>,
) -> Result<RenderPlan, RenderError> {
    let lang = config.lang();
    let floor = config.harness_version();
    let force = options.force;
    let budget_before = apply.is_some().then(|| claude_md_budget(view));
    let plan_options = PlanOptions {
        ambient_floor: floor.clone(),
        native_hooks: options.native_hooks.clone(),
        force,
        ..PlanOptions::default()
    };
    let mut claude = plan_claude_engine(view, &config.data, repo_root, &plan_options)
        .map_err(|_| RenderError::Delegate)?;
    let mut applied = None;
    if let Some(apply) = apply.as_deref_mut() {
        let (backup_path, real_writes) = commit_claude(apply, repo_root, &mut claude, lang)?;
        applied = Some(Applied {
            backup_path,
            real_writes,
            harness: None,
            budget_crossed: None,
        });
    }
    let floor = floor.as_deref();
    let mut ignore = |file: Option<IgnoreResult>,
                      applied: &mut Option<Applied>|
     -> Result<Option<IgnoreResult>, RenderError> {
        let (Some(apply), Some(applied)) = (apply.as_deref_mut(), applied.as_mut()) else {
            return Ok(file);
        };
        let Some(mut file) = file else {
            return Ok(None);
        };
        if file.pending() {
            let (backup, writes) = commit_ignore_file(apply, repo_root, &file, lang)?;
            file.backup_path = backup;
            applied.real_writes += writes;
        }
        Ok(Some(file))
    };
    let gitignore = plan_gitignore(view, &config.data, force, lang, floor)
        .map_err(|_| RenderError::Delegate)?
        .map(IgnoreResult::from_ignore_file);
    let gitignore = ignore(gitignore, &mut applied)?;
    let engines = engines(&config.data);
    let mut nested = Vec::with_capacity(NESTED_GITIGNORE_DIRS.len());
    for dir in NESTED_GITIGNORE_DIRS {
        let enabled = (dir != ".navori").then_some(engines.as_slice());
        let file = plan_nested_gitignore(view, dir, enabled, force, lang, floor)
            .map_err(|_| RenderError::Delegate)?
            .map(|f| IgnoreResult {
                path: f.rel_path,
                status: f.status,
                skipped_reason: f.skipped_reason,
                entries: Vec::new(),
                content: f.content,
                backup_path: None,
            });
        nested.push(ignore(file, &mut applied)?);
    }
    let mut nested = nested.into_iter();
    let (claude_gitignore, codex_gitignore, navori_gitignore) = (
        nested.next().flatten(),
        nested.next().flatten(),
        nested.next().flatten(),
    );
    let prettierignore = plan_prettierignore(view, &config.data, force, lang, floor)
        .map_err(|_| RenderError::Delegate)?
        .map(IgnoreResult::from_ignore_file);
    let prettierignore = ignore(prettierignore, &mut applied)?;
    let orphaned_engine_outputs = scan_orphaned_engine_outputs(view, &config.data);
    if let (Some(apply), Some(applied)) = (apply, applied.as_mut()) {
        if applied.real_writes > 0 {
            let record = view
                .read("navori.config.json")
                .map_or(HarnessRecord::Unreadable, |text| {
                    record_harness_version(&text, crate::STAMP_VERSION)
                });
            if let HarnessRecord::Recorded(text) = &record {
                write_file_atomic(apply.fs, &repo_root.join("navori.config.json"), text)
                    .map_err(RenderError::Record)?;
            }
            applied.harness = Some(record);
        }
        let after = claude_md_budget(view);
        if budget_before.is_some_and(|before| before.over_by == 0) && after.over_by > 0 {
            applied.budget_crossed = Some(after);
        }
    }
    Ok(RenderPlan {
        lang,
        claude,
        gitignore,
        claude_gitignore,
        codex_gitignore,
        navori_gitignore,
        prettierignore,
        orphaned_engine_outputs,
        applied,
    })
}

// --- human report -------------------------------------------------------------------------------

/// `reportGitignore` (`title` is `gitignoreTitle`) and `reportPrettierIgnore`.
fn ignore_section(
    clack: Clack,
    title: &str,
    file: &IgnoreResult,
    prettier: bool,
    lang: Lang,
) -> String {
    let mut lines = vec![title.to_owned()];
    if file.skipped() {
        lines.push(format!("  ! {}  (skipped)", file.path));
        if let Some(reason) = &file.skipped_reason {
            lines.push(format!("      {reason}"));
        }
    } else if prettier && file.status == InjectStatus::Unchanged && file.entries.is_empty() {
        lines.push(format!(
            "  {} {}",
            status_symbol("unchanged"),
            i18n::prettier_ignore_already_covered(lang)
        ));
    } else {
        let status = file.status.as_str();
        lines.push(format!(
            "  {} {}  ({status})",
            status_symbol(status),
            file.path
        ));
    }
    if let Some(backup) = &file.backup_path {
        lines.push(format!("  {} {backup}", i18n::BACKUP_LABEL));
    }
    clack.message(&lines.join("\n"))
}

/// `summarize(counts)`, uncolored.
fn summarize(counts: &[(&str, usize)]) -> String {
    let count = |status: &str| {
        counts
            .iter()
            .find(|(s, _)| *s == status)
            .map_or(0, |(_, n)| *n)
    };
    let mut parts = Vec::new();
    for (status, label) in [
        ("created", "created"),
        ("updated", "updated"),
        ("user-modified-skipped", "conflict"),
        ("downgrade-skipped", "downgrade-skip"),
        ("retired-kept", "retired-kept"),
    ] {
        let n = count(status);
        if n > 0 {
            parts.push(format!("{n} {label}"));
        }
    }
    let removed = count("removed-condition-false") + count("removed-trimmed");
    if removed > 0 {
        parts.push(format!("{removed} removed"));
    }
    let unchanged = count("unchanged");
    if unchanged > 0 {
        parts.push(format!("{unchanged} unchanged"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("\u{2014} {}", parts.join(", "))
    }
}

/// The outro of `renderCommand.run`.
fn outro(clack: Clack, plan: &RenderPlan) -> String {
    let preview = plan.applied.is_none();
    let lang = plan.lang;
    let skipped = plan.skipped_files();
    let tail = if skipped > 0 {
        format!(" \u{b7} {}", i18n::render_skipped_outro(lang, skipped))
    } else {
        String::new()
    };
    let summary = summarize(&plan.status_counts());
    let message = if plan.has_pending_writes() {
        if preview {
            format!(
                "{} {summary} \u{b7} {}{tail}",
                i18n::RENDER_PREVIEW_WORD,
                i18n::render_preview_hint(lang)
            )
        } else {
            format!("{} {summary}{tail}", i18n::RENDER_DONE_WORD)
        }
    } else if skipped > 0 {
        format!("{} {summary}{tail}", i18n::render_skipped_word(lang))
    } else if preview {
        format!(
            "{} {summary} \u{b7} {}",
            i18n::render_up_to_date(lang),
            i18n::render_up_to_date_hint(lang)
        )
    } else {
        format!("{} {summary}", i18n::render_up_to_date(lang))
    };
    clack.outro(&message)
}

/// The stdout of `navori render` (without `--json`) on `cwd`, colorless.
#[must_use]
pub fn human_report(clack: Clack, cwd: &str, plan: &RenderPlan) -> String {
    let lang = plan.lang;
    let mut out = clack.intro("navori render");
    out.push_str(&clack.message(&format!("core: {EMBEDDED_CORE}")));
    out.push_str(&claude_md_section(
        clack,
        &format!("{cwd}/CLAUDE.md"),
        &plan.claude,
        plan.applied.is_none(),
        lang,
    ));
    out.extend(engine_files_section(clack, &plan.claude));
    out.extend(lang_fallback_section(clack, &plan.claude, lang));
    if let Some(backup) = plan.applied.as_ref().and_then(|a| a.backup_path.as_ref()) {
        out.push_str(&clack.message(&format!("{} {backup}", i18n::BACKUP_LABEL)));
    }
    let gitignore_title = i18n::render_gitignore_title(lang);
    for file in [
        &plan.gitignore,
        &plan.claude_gitignore,
        &plan.codex_gitignore,
        &plan.navori_gitignore,
    ]
    .into_iter()
    .flatten()
    {
        out.push_str(&ignore_section(clack, gitignore_title, file, false, lang));
    }
    if let Some(file) = &plan.prettierignore {
        out.push_str(&ignore_section(
            clack,
            i18n::render_prettier_ignore_title(lang),
            file,
            true,
            lang,
        ));
    }
    if !plan.orphaned_engine_outputs.is_empty() {
        let lines: Vec<String> = plan
            .orphaned_engine_outputs
            .iter()
            .flat_map(|(engine, paths)| {
                paths
                    .iter()
                    .map(move |path| format!("  \u{21e1} {path} ({engine})"))
            })
            .collect();
        out.push_str(&clack.warn(&i18n::render_orphaned_engine_outputs(
            lang,
            lines.len(),
            &lines.join("\n"),
        )));
    }
    out.extend(downgrade_section(clack, &plan.claude, lang));
    if let Some(after) = plan.applied.as_ref().and_then(|a| a.budget_crossed) {
        out.push_str(&clack.warn(&i18n::render_doc_budget_crossed(
            lang,
            "CLAUDE.md",
            after.managed_words - after.unbudgeted_words,
            after.ceiling,
        )));
    }
    out.push_str(&outro(clack, plan));
    out
}

// --- --json -------------------------------------------------------------------------------------

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(key, value);
    }
    JsValue::Object(object)
}

fn strings<'a>(items: impl IntoIterator<Item = &'a str>) -> JsValue {
    JsValue::Array(items.into_iter().map(JsValue::string).collect())
}

fn number(n: usize) -> JsValue {
    JsValue::Number(n as f64)
}

fn ignore_json(file: Option<&IgnoreResult>, prettier: bool) -> JsValue {
    let Some(file) = file else {
        return JsValue::Null;
    };
    let mut entries = vec![
        ("path", JsValue::string(&file.path)),
        ("status", JsValue::string(file.status.as_str())),
    ];
    if prettier {
        entries.push(("entries", strings(file.entries.iter().map(String::as_str))));
    }
    entries.push(("backupPath", nullable(file.backup_path.as_deref())));
    object(entries)
}

fn nullable(text: Option<&str>) -> JsValue {
    text.map_or(JsValue::Null, JsValue::string)
}

/// `buildRenderJson(result, preview, provenance)` on `cwd`, the value `--json` prints.
#[must_use]
pub fn render_json(cwd: &str, plan: &RenderPlan) -> JsValue {
    let claude = &plan.claude;
    let root = object(vec![
        ("filePath", JsValue::string(&format!("{cwd}/CLAUDE.md"))),
        ("changed", JsValue::Bool(plan.claude_changed())),
        (
            "entries",
            JsValue::Array(
                claude
                    .claude_md_entries
                    .iter()
                    .map(|(id, status)| {
                        object(vec![
                            ("id", JsValue::string(id)),
                            ("status", JsValue::string(status.as_str())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "written",
            JsValue::Array(
                written(claude)
                    .into_iter()
                    .map(|(path, status)| {
                        object(vec![
                            ("path", JsValue::string(path)),
                            ("status", JsValue::string(status)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "skipped",
            JsValue::Array(
                claude
                    .skipped
                    .iter()
                    .map(|s| {
                        object(vec![
                            ("path", JsValue::string(&s.rel_path)),
                            ("reason", JsValue::string(&s.reason)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("unchangedFiles", number(unchanged_engine_files(claude))),
        (
            "languageFallbacks",
            strings(claude.language_fallbacks.iter().map(String::as_str)),
        ),
        (
            "backupPath",
            nullable(plan.applied.as_ref().and_then(|a| a.backup_path.as_deref())),
        ),
    ]);
    let orphaned = JsValue::Array(
        plan.orphaned_engine_outputs
            .iter()
            .map(|(engine, paths)| {
                object(vec![
                    ("engine", JsValue::string(engine)),
                    ("paths", strings(paths.iter().map(String::as_str))),
                ])
            })
            .collect(),
    );
    let downgrades = JsValue::Array(
        claude
            .downgrades
            .iter()
            .map(|d| {
                object(vec![
                    ("id", JsValue::string(&d.id)),
                    ("fromVersion", JsValue::string(&d.from_version)),
                    ("toVersion", JsValue::string(&d.to_version)),
                ])
            })
            .collect(),
    );
    let summary = object(
        plan.status_counts()
            .into_iter()
            .map(|(status, n)| (status, number(n)))
            .collect(),
    );
    object(vec![
        ("command", JsValue::string("render")),
        ("ok", JsValue::Bool(true)),
        (
            "mode",
            JsValue::string(if plan.applied.is_some() {
                "apply"
            } else {
                "preview"
            }),
        ),
        ("coreRoot", JsValue::string(EMBEDDED_CORE)),
        ("bundled", JsValue::Bool(true)),
        ("staleCore", JsValue::Null),
        ("root", root),
        ("workspaces", JsValue::Array(Vec::new())),
        ("extraEngines", JsValue::Array(Vec::new())),
        ("orphanedWorkspaces", JsValue::Array(Vec::new())),
        ("orphanedEngineOutputs", orphaned),
        ("prunedEngineOutputs", JsValue::Array(Vec::new())),
        ("keptEngineOutputs", JsValue::Array(Vec::new())),
        ("gitignore", ignore_json(plan.gitignore.as_ref(), false)),
        (
            "claudeGitignore",
            ignore_json(plan.claude_gitignore.as_ref(), false),
        ),
        (
            "codexGitignore",
            ignore_json(plan.codex_gitignore.as_ref(), false),
        ),
        (
            "navoriGitignore",
            ignore_json(plan.navori_gitignore.as_ref(), false),
        ),
        (
            "prettierignore",
            ignore_json(plan.prettierignore.as_ref(), true),
        ),
        ("downgrades", downgrades),
        ("summary", summary),
        ("pending", JsValue::Bool(plan.has_pending_writes())),
    ])
}
