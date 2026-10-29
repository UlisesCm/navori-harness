//! `navori render` in preview over a solo-Claude root (spec 0058 E3 M6, D23): the plan of
//! `runRenderCore` and the two outputs of `renderCommand.run`, the human report and `--json`.
//!
//! The pipeline follows `runRenderCore`: the Claude plan, the root `.gitignore`, the nested
//! `.claude`, `.codex` and `.navori` ones, `.prettierignore` and the orphaned engine outputs
//! scan. Workspaces, other engines and `--prune` are outside the native subset (Q8), so their
//! report sections are always empty here.
//!
//! The core provenance is `(embedded)`: Rust reads no `core-assets` directory, so it never names
//! one (Q11). The oracle masks the TS side of that line and of the three `--json` keys.

use std::path::Path;

use crate::config::Config;
use crate::i18n;
use crate::js_json::{JsObject, JsValue};
use crate::markers::InjectStatus;
use crate::render::block_plan::PlanOptions;
use crate::render::claude::{ClaudeEnginePlan, plan_claude_engine};
use crate::render::collect::RepoView;
use crate::render::context::Lang;
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
}

impl IgnoreResult {
    fn from_ignore_file(file: IgnoreFile) -> Self {
        Self {
            path: file.rel_path.to_owned(),
            status: file.status,
            skipped_reason: file.skipped_reason,
            entries: file.entries,
            content: file.content,
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

/// `runRenderCore(cwd, { dryRun: true })` on the root at `repo_root`, read through `view`.
/// `native_hooks` overrides the embedded manifest's hooks, as in [`PlanOptions`].
///
/// # Errors
/// [`RenderDelegate`] when any step delegates.
pub fn plan_render(
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    native_hooks: Option<std::collections::BTreeMap<String, crate::manifest::Hook>>,
) -> Result<RenderPlan, RenderDelegate> {
    let lang = config.lang();
    let floor = config.harness_version();
    let options = PlanOptions {
        ambient_floor: floor.clone(),
        native_hooks,
        ..PlanOptions::default()
    };
    let claude =
        plan_claude_engine(view, &config.data, repo_root, &options).map_err(|_| RenderDelegate)?;
    let floor = floor.as_deref();
    let gitignore = plan_gitignore(view, &config.data, false, lang, floor)
        .map_err(|_| RenderDelegate)?
        .map(IgnoreResult::from_ignore_file);
    let engines = engines(&config.data);
    let mut nested = Vec::with_capacity(NESTED_GITIGNORE_DIRS.len());
    for dir in NESTED_GITIGNORE_DIRS {
        let enabled = (dir != ".navori").then_some(engines.as_slice());
        let file = plan_nested_gitignore(view, dir, enabled, false, lang, floor)
            .map_err(|_| RenderDelegate)?;
        nested.push(file.map(|f| IgnoreResult {
            path: f.rel_path,
            status: f.status,
            skipped_reason: f.skipped_reason,
            entries: Vec::new(),
            content: f.content,
        }));
    }
    let mut nested = nested.into_iter();
    let (claude_gitignore, codex_gitignore, navori_gitignore) = (
        nested.next().flatten(),
        nested.next().flatten(),
        nested.next().flatten(),
    );
    let prettierignore = plan_prettierignore(view, &config.data, false, lang, floor)
        .map_err(|_| RenderDelegate)?
        .map(IgnoreResult::from_ignore_file);
    Ok(RenderPlan {
        lang,
        claude,
        gitignore,
        claude_gitignore,
        codex_gitignore,
        navori_gitignore,
        prettierignore,
        orphaned_engine_outputs: scan_orphaned_engine_outputs(view, &config.data),
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

/// The preview outro of `renderCommand.run`.
fn outro(clack: Clack, plan: &RenderPlan) -> String {
    let lang = plan.lang;
    let skipped = plan.skipped_files();
    let tail = if skipped > 0 {
        format!(" \u{b7} {}", i18n::render_skipped_outro(lang, skipped))
    } else {
        String::new()
    };
    let summary = summarize(&plan.status_counts());
    let message = if plan.has_pending_writes() {
        format!(
            "{} {summary} \u{b7} {}{tail}",
            i18n::RENDER_PREVIEW_WORD,
            i18n::render_preview_hint(lang)
        )
    } else if skipped > 0 {
        format!("{} {summary}{tail}", i18n::render_skipped_word(lang))
    } else {
        format!(
            "{} {summary} \u{b7} {}",
            i18n::render_up_to_date(lang),
            i18n::render_up_to_date_hint(lang)
        )
    };
    clack.outro(&message)
}

/// The stdout of `navori render` (preview, without `--json`) on `cwd`, colorless.
#[must_use]
pub fn human_report(clack: Clack, cwd: &str, plan: &RenderPlan) -> String {
    let lang = plan.lang;
    let mut out = clack.intro("navori render");
    out.push_str(&clack.message(&format!("core: {EMBEDDED_CORE}")));
    out.push_str(&claude_md_section(
        clack,
        &format!("{cwd}/CLAUDE.md"),
        &plan.claude,
        true,
        lang,
    ));
    out.extend(engine_files_section(clack, &plan.claude));
    out.extend(lang_fallback_section(clack, &plan.claude, lang));
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
    entries.push(("backupPath", JsValue::Null));
    object(entries)
}

/// `buildRenderJson(result, true, provenance)` on `cwd`, the value `--json` prints.
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
        ("backupPath", JsValue::Null),
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
        ("mode", JsValue::string("preview")),
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
