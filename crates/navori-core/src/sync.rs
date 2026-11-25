//! `navori sync` without prompts over a root without workspaces (`commands/sync.ts`, spec 0058
//! T29, spec 0059 T21).
//!
//! The run plans every configured engine in preview through the render's shared target
//! ([`plan_target`]), reports it, and with `--apply`/`--yes` plans again with the bulk resolution
//! (`--accept-new` overwrites every conflicting `CLAUDE.md` block through `forceIds`; `--keep-mine`
//! keeps them, which is what the engine does anyway) and commits it as `render` does: Claude, then
//! each other engine in config order. `--accept-new-files` first writes the rendered version of
//! every whole file that kept its marker (`applyFileResolutions`, with its own backup), each
//! recomposed with the plugin hook extensions that target it. Sync writes no ignore file and
//! touches no registry.
//!
//! Accepting a file the TS cannot bind to its prepared apply (a prose engine's file, or one that is
//! not an observed destination) makes the TS throw; that run is the TS's, decided before any
//! output.
//!
//! Every branch that would prompt (`p.select`, `p.confirm`) is unreachable natively: the manifest
//! entry `requires` one of `apply`, `yes`, `dry-run`, `json`, `accept-new`, `keep-mine` or
//! `accept-new-files`, and a run that still reaches a prompt returns [`SyncRun::Delegate`] before
//! any output.

use std::collections::BTreeSet;
use std::path::Path;

use crate::commit::{CommitInput, commit_writes};
use crate::config::{Config, HarnessRecord, effective_config, record_harness_version};
use crate::fs::write_file_atomic;
use crate::i18n;
use crate::js_json::{JsObject, JsValue};
use crate::markers::{CommentStyle, InjectStatus, extract_managed_content};
use crate::render::block_plan::{AssetStatus, PlanAsset};
use crate::render::claude::ClaudeEnginePlan;
use crate::render::codex_hooks::codex_hook_extension_target;
use crate::render::collect::{PendingWrite, RepoView, SkippedFile};
use crate::render::command::{
    Apply, RenderError, RenderOptions, TargetPlan, append_codex_trust_hints, commit_target,
    plan_target,
};
use crate::render::context::Lang;
use crate::render::plugins::load_enabled_plugins;
use crate::render::report::{Clack, status_symbol, written};
use crate::render::sub_blocks::{SubBlockCtx, SubBlocks, apply_hook_extension};

/// `CONFLICT_DIFF_MAX_LINES`.
pub const CONFLICT_DIFF_MAX_LINES: usize = 6;

/// The flags a native `sync` honors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SyncFlags {
    /// `--dry-run`.
    pub dry_run: bool,
    /// `--apply`.
    pub apply: bool,
    /// `--yes`.
    pub yes: bool,
    /// `--json`.
    pub json: bool,
    /// `--accept-new`.
    pub accept_new: bool,
    /// `--keep-mine`.
    pub keep_mine: bool,
    /// `--accept-new-files`.
    pub accept_new_files: bool,
}

impl SyncFlags {
    /// The bulk mode, `None` when neither flag is set.
    #[must_use]
    pub const fn bulk(&self) -> Option<&'static str> {
        if self.accept_new {
            Some("accept-new")
        } else if self.keep_mine {
            Some("keep-mine")
        } else {
            None
        }
    }
}

/// One conflict (`Conflict`), without file bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncConflict {
    /// `CLAUDE.md (<id>)` or the file's path.
    pub path: String,
    /// Why.
    pub reason: String,
    /// A `CLAUDE.md` block (`true`) or a whole file.
    pub block: bool,
    /// `resolvableOf(c) === "bulk"`.
    pub bulk: bool,
    /// A whole file only `--interactive` can replace (`markerlessResolution`).
    pub markerless: bool,
    /// The file, relative to the root (whole files only).
    pub rel_path: String,
    /// The bytes on disk the diff was shown against (`resolution.basis`).
    pub basis: Option<String>,
    /// `resolution.chmodExec`.
    pub chmod_exec: bool,
    /// The non-Claude engine that skipped the file; `None` for Claude's.
    pub engine: Option<String>,
}

/// What a native `sync` printed and how it ended, or the TS's turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncRun {
    /// The run reached a branch only the TS answers; nothing was printed or written.
    Delegate,
    /// The run finished.
    Done {
        /// Everything for stdout.
        stdout: String,
        /// Lines for stderr after the config warnings.
        stderr: String,
        /// Exit code.
        code: u8,
    },
}

fn plan(
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    force_ids: BTreeSet<String>,
) -> Result<TargetPlan, RenderError> {
    let options = RenderOptions {
        force_ids,
        ..RenderOptions::default()
    };
    plan_target(view, config, repo_root, &options)
}

/// `countTargetWrites(plan)`.
fn target_writes(plan: &TargetPlan) -> usize {
    plan.claude.as_ref().map_or(0, |c| written(c).len())
        + plan
            .extra_engines
            .iter()
            .map(|e| e.written().len())
            .sum::<usize>()
}

fn file_conflict(skip: &SkippedFile, view: &dyn RepoView, engine: Option<&str>) -> SyncConflict {
    SyncConflict {
        path: engine.map_or_else(
            || skip.rel_path.clone(),
            |engine| format!("[{engine}] {}", skip.rel_path),
        ),
        reason: skip.reason.clone(),
        block: false,
        bulk: skip.resolution.is_some(),
        markerless: skip.markerless_resolution.is_some(),
        rel_path: skip.rel_path.clone(),
        basis: view.read_regular(&skip.rel_path),
        chmod_exec: skip.chmod_exec,
        engine: engine.map(str::to_owned),
    }
}

/// `collectTargetConflicts` of the root target.
#[must_use]
pub fn conflicts(target: &TargetPlan, view: &dyn RepoView) -> Vec<SyncConflict> {
    let mut out = Vec::new();
    let Some(plan) = &target.claude else {
        return extra_conflicts(target, view, out);
    };
    for (id, status) in &plan.claude_md_entries {
        if *status == AssetStatus::Inject(InjectStatus::UserModifiedSkipped) {
            out.push(SyncConflict {
                path: format!("CLAUDE.md ({id})"),
                reason: "managed block edited".to_owned(),
                block: true,
                bulk: true,
                markerless: false,
                rel_path: String::new(),
                basis: None,
                chmod_exec: false,
                engine: None,
            });
        }
    }
    for skip in &plan.skipped {
        if skip.status == Some(InjectStatus::UserModifiedSkipped) {
            out.push(file_conflict(skip, view, None));
        }
    }
    extra_conflicts(target, view, out)
}

fn extra_conflicts(
    target: &TargetPlan,
    view: &dyn RepoView,
    mut out: Vec<SyncConflict>,
) -> Vec<SyncConflict> {
    for engine in &target.extra_engines {
        for skip in engine.skipped() {
            if skip.status == Some(InjectStatus::UserModifiedSkipped) {
                out.push(file_conflict(skip, view, Some(&engine.engine)));
            }
        }
    }
    out
}

/// The skipped files of the prepared owners `finalize()` returns (Claude, Codex, Pi), where
/// `prepareSyncApply` looks for an accepted file's proposal. Prose engines (and the `AGENTS.md` Pi
/// writes through one) render in `commit`, so their skips are not among them.
fn finalized_skips(target: &TargetPlan) -> impl Iterator<Item = &SkippedFile> {
    let claude = target.claude.iter().flat_map(|c| c.skipped.iter());
    let extra = target.extra_engines.iter().flat_map(|e| {
        let codex = e.codex.iter().flat_map(|c| c.skipped.iter());
        let pi = e.pi.iter().flat_map(|p| p.skipped.iter());
        codex.chain(pi)
    });
    claude.chain(extra)
}

/// Whether `prepareSyncApply` can bind an accepted file to the prepared apply without throwing:
/// an observed destination with its proposal among the finalized skips. Claude's own files always
/// are.
fn bindable(target: &TargetPlan, conflict: &SyncConflict) -> bool {
    conflict.engine.is_none()
        || (target.extra_destinations.contains(&conflict.rel_path)
            && finalized_skips(target)
                .any(|s| s.rel_path == conflict.rel_path && s.resolution.is_some()))
}

/// `stillMatchesBasis`: still a regular file holding exactly what the diff was shown against.
fn still_matches(view: &dyn RepoView, conflict: &SyncConflict) -> bool {
    conflict.basis.is_some() && view.read_regular(&conflict.rel_path) == conflict.basis
}

/// `summarizeConflictDiff(actual, proposed)`: positional, line against line.
fn diff_lines(lang: Lang, actual: &str, proposed: &str) -> Vec<String> {
    let a: Vec<&str> = actual.split('\n').collect();
    let b: Vec<&str> = proposed.split('\n').collect();
    let mut changed = Vec::new();
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i), b.get(i));
        if x == y {
            continue;
        }
        if let Some(x) = x {
            changed.push(format!("- {x}"));
        }
        if let Some(y) = y {
            changed.push(format!("+ {y}"));
        }
    }
    if changed.is_empty() {
        return Vec::new();
    }
    let shown = changed.len().min(CONFLICT_DIFF_MAX_LINES);
    let mut out = vec![format!(
        "      {}",
        i18n::sync_conflict_diff_summary(lang, changed.len(), shown)
    )];
    out.extend(changed[..shown].iter().map(|line| format!("      {line}")));
    if changed.len() > shown {
        out.push(format!(
            "      {}",
            i18n::sync_conflict_diff_truncated(lang, changed.len() - shown)
        ));
    }
    out
}

/// A skipped file's line and, when it carries a proposal, its bounded diff.
fn skip_lines(lang: Lang, engine: &str, skip: &SkippedFile, view: &dyn RepoView) -> Vec<String> {
    let mut lines = vec![format!(
        "  ! [{engine}] {}  (skipped: {})",
        skip.rel_path, skip.reason
    )];
    if let Some(proposal) = skip
        .resolution
        .as_deref()
        .or(skip.markerless_resolution.as_deref())
    {
        let basis = view.read(&skip.rel_path).unwrap_or_default();
        lines.extend(diff_lines(lang, &basis, proposal));
    }
    lines
}

/// A whole-file conflict the plan carries no rendered body for.
fn unresolvable(skip: &SkippedFile) -> bool {
    skip.status == Some(InjectStatus::UserModifiedSkipped)
        && skip.resolution.is_none()
        && skip.markerless_resolution.is_none()
}

/// `reportTargetPlan` of the root target, uncolored.
fn report(clack: Clack, lang: Lang, target: &TargetPlan, view: &dyn RepoView) -> String {
    let mut lines = vec![i18n::sync_plan_title("root")];
    if let Some(plan) = &target.claude {
        claude_report_lines(lang, plan, view, &mut lines);
    }
    for engine in &target.extra_engines {
        for (path, status) in engine.written() {
            lines.push(format!(
                "  {} [{}] {path}  ({status})",
                status_symbol(status),
                engine.engine
            ));
        }
        for skip in engine.skipped() {
            lines.extend(skip_lines(lang, &engine.engine, skip, view));
        }
        for warning in engine.warnings() {
            lines.push(format!("  ! [{}] {warning}", engine.engine));
        }
    }
    let has_file_conflict = target
        .claude
        .iter()
        .flat_map(|c| c.skipped.iter())
        .chain(target.extra_engines.iter().flat_map(|e| e.skipped()))
        .any(unresolvable);
    if has_file_conflict {
        lines.push(format!(
            "      {}",
            i18n::sync_conflict_diff_file_level(lang)
        ));
    }
    clack.message(&lines.join("\n"))
}

/// The Claude part of `reportTargetPlan`: `CLAUDE.md` blocks, written files, skips and updates.
fn claude_report_lines(
    lang: Lang,
    plan: &ClaudeEnginePlan,
    view: &dyn RepoView,
    lines: &mut Vec<String>,
) {
    let has_block_conflict = plan
        .claude_md_plan
        .iter()
        .any(|e| e.status == AssetStatus::Inject(InjectStatus::UserModifiedSkipped));
    let on_disk = if has_block_conflict {
        view.read("CLAUDE.md").unwrap_or_default()
    } else {
        String::new()
    };
    for entry in &plan.claude_md_plan {
        let status = entry.status.as_str();
        let condition = match &entry.asset {
            PlanAsset::Core(asset) => asset
                .condition
                .map_or_else(String::new, |c| format!(" [cond: {c}]")),
            _ => String::new(),
        };
        lines.push(format!(
            "  {} [claude] CLAUDE.md:{}  ({status}){condition}",
            status_symbol(status),
            entry.asset.id()
        ));
        if entry.status == AssetStatus::Inject(InjectStatus::UserModifiedSkipped) {
            let actual = extract_managed_content(&on_disk, entry.asset.id(), CommentStyle::Html)
                .unwrap_or_default();
            lines.extend(diff_lines(
                lang,
                &actual,
                entry.new_content.as_deref().unwrap_or_default(),
            ));
        }
    }
    for (path, status) in written(plan) {
        if path != "CLAUDE.md" {
            lines.push(format!(
                "  {} [claude] {path}  ({status})",
                status_symbol(status)
            ));
        }
    }
    for skip in &plan.skipped {
        lines.extend(skip_lines(lang, "claude", skip, view));
    }
    if !plan.updates_available.is_empty() {
        lines.push(String::new());
        lines.push(format!("  {}", i18n::SYNC_UPDATES_AVAILABLE_TITLE));
        for u in &plan.updates_available {
            lines.push(format!(
                "    \u{21e1} {}  {} \u{2192} {}",
                u.id, u.from_version, u.to_version
            ));
        }
    }
}

/// What the apply pass did: writes, backups, the accepted files, `recordHarnessVersionIfWritten`'s
/// stderr.
struct Applied {
    /// The engines' writes (`countTargetWrites` of the committed target).
    written: usize,
    /// `collectTargetBackups`: `(<engine>, path)` of each engine that took one.
    backups: Vec<(String, String)>,
    /// `applyFileResolutions`: files written (relative paths), files dropped because they
    /// changed (display paths), the backup.
    files_applied: Vec<String>,
    files_dropped: Vec<String>,
    files_backup: Option<String>,
    /// `applyFileResolutions`' `error`: the accepted files failed to write, so the run stops
    /// before the engine commit, as the TS does.
    files_error: Option<String>,
    stderr: String,
}

/// The forced render of each accepted file, recomposed with the hook extensions that target it,
/// taken out of the engine's own pending writes (`prepareSyncApply`).
fn refresh_accepted(
    view: &dyn RepoView,
    config: &Config,
    target: &mut TargetPlan,
    accepted: &[&SyncConflict],
) -> Result<Vec<PendingWrite>, RenderError> {
    let effective = effective_config(&config.data);
    let floor = config.harness_version();
    let plugins = match &config.data {
        JsValue::Object(root) => root.get("plugins").cloned(),
        _ => None,
    };
    let enabled = load_enabled_plugins(plugins.as_ref())
        .map_err(|_| RenderError::Delegate)?
        .loaded;
    let ctx = SubBlockCtx {
        view,
        config: &effective,
        lang: config.lang(),
        ambient_floor: floor.as_deref(),
    };
    let mut refreshed = Vec::new();
    for conflict in accepted {
        if !still_matches(view, conflict) {
            return Err(RenderError::Thrown(format!(
                "Sync destination changed since preview: {}",
                conflict.path
            )));
        }
        let Some(proposal) = finalized_skips(target)
            .find(|s| s.rel_path == conflict.rel_path && s.resolution.is_some())
            .and_then(|s| s.resolution.clone())
        else {
            return Err(RenderError::Thrown(format!(
                "Sync proposal no longer resolvable: {}",
                conflict.path
            )));
        };
        let mut virtual_write = vec![PendingWrite {
            rel_path: conflict.rel_path.clone(),
            content: proposal,
            status: InjectStatus::Updated,
            chmod_exec: conflict.chmod_exec,
        }];
        // `hookExtensionTarget(extension.target, engine)`, with the engine read off the path.
        let codex = conflict.rel_path.starts_with(".codex/");
        for plugin in &enabled {
            for extension in &plugin.hook_extension_assets {
                let hook_target = if codex {
                    codex_hook_extension_target(&extension.target)
                } else {
                    Some(extension.target.clone())
                };
                if hook_target.as_deref() == Some(conflict.rel_path.as_str()) {
                    apply_hook_extension(
                        &ctx,
                        plugin,
                        extension,
                        &conflict.rel_path,
                        &mut virtual_write,
                        &mut SubBlocks::default(),
                    )
                    .map_err(|_| RenderError::Delegate)?;
                }
            }
        }
        // Committed only by the checked forced-resolution writer.
        let rel = conflict.rel_path.as_str();
        if let Some(claude) = target.claude.as_mut() {
            claude.pending.retain(|w| w.rel_path != rel);
        }
        for engine in &mut target.extra_engines {
            if let Some(codex) = engine.codex.as_mut() {
                codex.pending.retain(|w| w.rel_path != rel);
            }
            if let Some(pi) = engine.pi.as_mut() {
                pi.pending.retain(|w| w.rel_path != rel);
            }
        }
        refreshed.extend(virtual_write.into_iter().take(1));
    }
    Ok(refreshed)
}

/// `prepareSyncApply(targets, accepted, resolutions)`, `applyFileResolutions` and `commit()`,
/// plus `recordHarnessVersionIfWritten`.
fn apply_pass(
    apply: &mut Apply<'_>,
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    force_ids: BTreeSet<String>,
    accepted: &[&SyncConflict],
) -> Result<Applied, RenderError> {
    let lang = config.lang();
    let mut target = plan(view, config, repo_root, force_ids)?;
    let refreshed = refresh_accepted(view, config, &mut target, accepted)?;
    // `applyFileResolutions`: re-checked right before the write; a changed file is dropped.
    let mut files_applied = Vec::new();
    let mut files_dropped = Vec::new();
    let mut pending: Vec<PendingWrite> = Vec::new();
    for (conflict, write) in accepted.iter().zip(refreshed) {
        if !still_matches(view, conflict) {
            files_dropped.push(conflict.path.clone());
            continue;
        }
        files_applied.push(conflict.rel_path.clone());
        if !pending.iter().any(|w| w.rel_path == write.rel_path) {
            pending.push(write);
        }
    }
    let mut files_backup = None;
    let mut real_writes = 0;
    if !pending.is_empty() {
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
        let committed = match commit_writes(apply.fs, apply.backups, &mut pending, &[], &input) {
            Ok(committed) => committed,
            Err(error) => {
                return Ok(Applied {
                    written: 0,
                    backups: Vec::new(),
                    files_applied: Vec::new(),
                    files_dropped,
                    files_backup: None,
                    files_error: Some(RenderError::Commit(error).message()),
                    stderr: String::new(),
                });
            }
        };
        files_backup = committed.backup_path.map(|p| p.display().to_string());
        real_writes += committed.real_writes;
    }
    let (claude_backup, engine_writes) = commit_target(apply, repo_root, &mut target, lang)?;
    real_writes += engine_writes;
    let backups = claude_backup
        .map(|path| ("claude".to_owned(), path))
        .into_iter()
        .chain(
            target
                .extra_engines
                .iter()
                .filter_map(|e| e.backup_path.clone().map(|path| (e.engine.clone(), path))),
        )
        .collect();
    let mut stderr = String::new();
    if real_writes > 0 {
        let record = view
            .read("navori.config.json")
            .map_or(HarnessRecord::Unreadable, |text| {
                record_harness_version(&text, crate::STAMP_VERSION)
            });
        match &record {
            HarnessRecord::Recorded(text) => {
                write_file_atomic(apply.fs, &repo_root.join("navori.config.json"), text)
                    .map_err(RenderError::Record)?;
            }
            HarnessRecord::NonCanonical | HarnessRecord::Unreadable => {
                stderr = format!("{}\n", i18n::harness_version_not_recorded(record.as_str()));
            }
            HarnessRecord::Unchanged => {}
        }
    }
    Ok(Applied {
        written: target_writes(&target),
        backups,
        files_applied,
        files_dropped,
        files_backup,
        files_error: None,
        stderr,
    })
}

/// `buildBulkResolutions(plans, "accept-new")`: every conflicting block id.
fn accept_new_ids(target: &TargetPlan) -> BTreeSet<String> {
    target
        .claude
        .iter()
        .flat_map(|plan| plan.claude_md_entries.iter())
        .filter(|(_, status)| *status == AssetStatus::Inject(InjectStatus::UserModifiedSkipped))
        .map(|(id, _)| id.clone())
        .collect()
}

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(key, value);
    }
    JsValue::Object(object)
}

#[allow(clippy::cast_precision_loss, reason = "counts are far below 2^53")]
fn number(n: usize) -> JsValue {
    JsValue::Number(n as f64)
}

/// `buildSyncJson` for the root target.
#[allow(
    clippy::too_many_arguments,
    reason = "the meta object of `buildSyncJson`, field for field"
)]
fn sync_json(
    target: &TargetPlan,
    conflicts: &[SyncConflict],
    resolved: &[String],
    flags: SyncFlags,
    ok: bool,
    mode: &str,
    written_total: usize,
    backups: &[(String, String)],
) -> JsValue {
    let pending = target_writes(target);
    // A skip (or conflict) whose file `--accept-new-files` just wrote is no longer one.
    let still_skipped =
        |rel: &str, resolvable: bool| !resolvable || !resolved.iter().any(|r| r == rel);
    let pair = |path: &str, status: &str| {
        object(vec![
            ("path", JsValue::string(path)),
            ("status", JsValue::string(status)),
        ])
    };
    let skips = |skipped: &mut dyn Iterator<Item = &SkippedFile>| {
        JsValue::Array(
            skipped
                .filter(|s| still_skipped(&s.rel_path, s.resolution.is_some()))
                .map(|s| {
                    object(vec![
                        ("path", JsValue::string(&s.rel_path)),
                        ("reason", JsValue::string(&s.reason)),
                        (
                            "status",
                            s.status
                                .map_or(JsValue::Undefined, |st| JsValue::string(st.as_str())),
                        ),
                    ])
                })
                .collect(),
        )
    };
    let engines = target
        .extra_engines
        .iter()
        .map(|engine| {
            object(vec![
                ("engine", JsValue::string(&engine.engine)),
                (
                    "written",
                    JsValue::Array(
                        engine
                            .written()
                            .into_iter()
                            .map(|(path, status)| pair(path, status))
                            .collect(),
                    ),
                ),
                ("skipped", skips(&mut engine.skipped().into_iter())),
                (
                    "warnings",
                    JsValue::Array(
                        engine
                            .warnings()
                            .iter()
                            .map(|w| JsValue::string(w))
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    let claude = target.claude.as_ref();
    let target = object(vec![
        ("label", JsValue::string("root")),
        (
            "claudeMd",
            JsValue::Array(
                claude
                    .iter()
                    .flat_map(|plan| plan.claude_md_entries.iter())
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
                claude
                    .map(written)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|(path, _)| *path != "CLAUDE.md")
                    .map(|(path, status)| pair(path, status))
                    .collect(),
            ),
        ),
        (
            "skipped",
            skips(&mut claude.iter().flat_map(|plan| plan.skipped.iter())),
        ),
        (
            "updatesAvailable",
            JsValue::Array(
                claude
                    .iter()
                    .flat_map(|plan| plan.updates_available.iter())
                    .map(|u| {
                        object(vec![
                            ("id", JsValue::string(&u.id)),
                            ("fromVersion", JsValue::string(&u.from_version)),
                            ("toVersion", JsValue::string(&u.to_version)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("engines", JsValue::Array(engines)),
    ]);
    let mut entries = vec![
        ("command", JsValue::string("sync")),
        ("ok", JsValue::Bool(ok)),
    ];
    if !ok {
        entries.push(("reason", JsValue::string("conflicts-detected")));
    }
    entries.extend([
        ("mode", JsValue::string(mode)),
        (
            "resolution",
            flags.bulk().map_or(JsValue::Null, JsValue::string),
        ),
        ("acceptNewFiles", JsValue::Bool(flags.accept_new_files)),
        ("targets", JsValue::Array(vec![target])),
        (
            "conflicts",
            JsValue::Array(
                conflicts
                    .iter()
                    .filter(|c| c.block || still_skipped(&c.rel_path, c.bulk))
                    .map(|c| {
                        object(vec![
                            ("path", JsValue::string(&c.path)),
                            ("reason", JsValue::string(&c.reason)),
                            (
                                "kind",
                                JsValue::string(if c.block { "block" } else { "file" }),
                            ),
                            (
                                "resolvable",
                                JsValue::string(if c.bulk { "bulk" } else { "none" }),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("orphanedWorkspaces", JsValue::Array(Vec::new())),
        ("pending", number(pending)),
        ("written", number(written_total)),
        (
            "backups",
            JsValue::Array(
                backups
                    .iter()
                    .map(|(label, path)| {
                        object(vec![
                            ("label", JsValue::string(label)),
                            ("path", JsValue::string(path)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    object(entries)
}

/// `syncCommand.run` on a solo-Claude root without workspaces, after the config was read.
/// `apply` is used only when the run writes.
///
/// # Errors
/// [`RenderError`] where a step delegates before any write, or the TS throws.
#[allow(
    clippy::too_many_lines,
    reason = "one function per `syncCommand.run`, branch for branch"
)]
pub fn run_sync(
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    flags: SyncFlags,
    clack: Clack,
    apply: &mut Apply<'_>,
) -> Result<SyncRun, RenderError> {
    let lang = config.lang();
    // `renderSyncTarget(target, true)`: the dry-run commit appends the Codex trust hint too.
    let mut preview = plan(view, config, repo_root, BTreeSet::new())?;
    append_codex_trust_hints(config, repo_root, &mut preview.extra_engines)?;
    let conflicts = conflicts(&preview, view);
    let pending = target_writes(&preview);
    let accept_files = flags.accept_new_files;
    // Accepting a file `prepareSyncApply` cannot bind throws in the TS: its run, before any output.
    if accept_files
        && (flags.apply || flags.yes)
        && conflicts
            .iter()
            .any(|c| !c.block && c.bulk && !bindable(&preview, c))
    {
        return Ok(SyncRun::Delegate);
    }
    // `conflictsBlockYes`: a bulk mode answers everything; `--accept-new-files` only the files.
    let blocked_yes =
        flags.yes && flags.bulk().is_none() && conflicts.iter().any(|c| c.block || !accept_files);
    let force_ids = if flags.accept_new {
        accept_new_ids(&preview)
    } else {
        BTreeSet::new()
    };
    let resolvable_files: Vec<&SyncConflict> =
        conflicts.iter().filter(|c| !c.block && c.bulk).collect();

    if flags.json {
        let auto_apply = (flags.apply || flags.yes) && !flags.dry_run;
        let mut written_total = 0;
        let mut backups: Vec<(String, String)> = Vec::new();
        let mut resolved = Vec::new();
        let mut stderr = String::new();
        if auto_apply && !blocked_yes {
            let accepted: &[&SyncConflict] = if accept_files { &resolvable_files } else { &[] };
            let applied = apply_pass(apply, view, config, repo_root, force_ids, accepted)?;
            if let Some(detail) = applied.files_error {
                // `{ command, ok: false, reason: "write-failed", detail, backups }`, compact.
                let value = object(vec![
                    ("command", JsValue::string("sync")),
                    ("ok", JsValue::Bool(false)),
                    ("reason", JsValue::string("write-failed")),
                    ("detail", JsValue::string(&detail)),
                    ("backups", JsValue::Array(Vec::new())),
                ]);
                let text = value.stringify(None).ok_or_else(|| {
                    RenderError::Thrown("sync: cannot serialize the --json result".to_owned())
                })?;
                return Ok(SyncRun::Done {
                    stdout: format!("{text}\n"),
                    stderr: String::new(),
                    code: 1,
                });
            }
            backups.extend(applied.files_backup.map(|p| ("root:sync".to_owned(), p)));
            backups.extend(
                applied
                    .backups
                    .into_iter()
                    .map(|(engine, p)| (format!("root:{engine}"), p)),
            );
            written_total = applied.files_applied.len() + applied.written;
            resolved = applied.files_applied;
            stderr = applied.stderr;
        }
        let mode = if flags.dry_run {
            "dry-run"
        } else if auto_apply {
            "apply"
        } else {
            "plan"
        };
        let value = sync_json(
            &preview,
            &conflicts,
            &resolved,
            flags,
            !blocked_yes,
            mode,
            written_total,
            &backups,
        );
        // Never a delegation here: the apply above may already have written, and a delegated
        // run would sync the repo a second time.
        let text = value.stringify(Some(2)).ok_or_else(|| {
            RenderError::Thrown("sync: cannot serialize the --json result".to_owned())
        })?;
        return Ok(SyncRun::Done {
            stdout: format!("{text}\n"),
            stderr,
            code: u8::from(blocked_yes),
        });
    }

    let mut out = clack.intro("navori sync");
    out.push_str(&report(clack, lang, &preview, view));
    let done = |stdout: String, stderr: String, code: u8| {
        Ok(SyncRun::Done {
            stdout,
            stderr,
            code,
        })
    };
    if pending == 0 && conflicts.is_empty() {
        out.push_str(&clack.outro(i18n::sync_up_to_date(lang)));
        return done(out, String::new(), 0);
    }
    if flags.dry_run {
        let mut parts = Vec::new();
        if !conflicts.is_empty() {
            parts.push(format!("{} conflict(s)", conflicts.len()));
        }
        if pending > 0 {
            parts.push(format!("{pending} pending"));
        }
        out.push_str(&clack.outro(&i18n::sync_dry_run_complete(lang, &parts.join(", "))));
        return done(out, String::new(), 0);
    }
    let auto_apply = flags.yes || flags.apply;
    if blocked_yes {
        let lines: Vec<String> = conflicts
            .iter()
            .map(|c| format!("  - {}: {}", c.path, c.reason))
            .collect();
        out.push_str(&clack.cancel(&i18n::sync_conflicts_with_yes(
            lang,
            conflicts.len(),
            &lines.join("\n"),
        )));
        return done(out, String::new(), 1);
    }
    let block_conflicts = conflicts.iter().filter(|c| c.block).count();
    let mut accepted: Vec<&SyncConflict> = Vec::new();
    if accept_files {
        if auto_apply {
            accepted.clone_from(&resolvable_files);
            out.push_str(&clack.info(&i18n::sync_accept_new_files_applied(
                lang,
                resolvable_files.len(),
            )));
        } else {
            let preview_note = i18n::sync_accept_new_files_preview(lang, resolvable_files.len());
            if flags.bulk().is_none() {
                out.push_str(&clack.outro(&preview_note));
                return done(out, String::new(), 0);
            }
            out.push_str(&clack.info(&preview_note));
        }
    }
    match flags.bulk() {
        Some(mode) if !auto_apply => {
            out.push_str(&clack.outro(&i18n::sync_bulk_preview(
                lang,
                &format!("--{mode}"),
                block_conflicts,
            )));
            return done(out, String::new(), 0);
        }
        Some(mode) => {
            out.push_str(&clack.info(&i18n::sync_bulk_applied(
                lang,
                &format!("--{mode}"),
                block_conflicts,
            )));
        }
        // A bare apply-less run would prompt.
        None if !auto_apply => return Ok(SyncRun::Delegate),
        None => {}
    }
    let file_conflicts: Vec<&SyncConflict> = conflicts.iter().filter(|c| !c.block).collect();
    let resolvable = file_conflicts.iter().filter(|c| c.bulk).count();
    let remain = file_conflicts.len() - resolvable;
    if remain > 0 {
        out.push_str(&clack.warn(&i18n::sync_file_conflicts_remain(lang, remain)));
    }
    let markerless = file_conflicts.iter().filter(|c| c.markerless).count();
    if markerless > 0 {
        out.push_str(&clack.warn(&i18n::sync_markerless_files_interactive_only(
            lang, markerless,
        )));
    }
    let kept_resolvable = resolvable - accepted.len();
    if kept_resolvable > 0 {
        out.push_str(&clack.warn(&i18n::sync_file_conflicts_kept(lang, kept_resolvable)));
    }
    let applied = match apply_pass(apply, view, config, repo_root, force_ids, &accepted) {
        Ok(applied) => applied,
        // Before any write: still the TS's run.
        Err(RenderError::Delegate) => return Ok(SyncRun::Delegate),
        // The engine commit threw: the TS has printed everything up to here and the error
        // escapes as an uncaught exception.
        Err(error) => return done(out, format!("{}\n", error.message()), 1),
    };
    for path in &applied.files_dropped {
        out.push_str(&clack.warn(&i18n::sync_file_changed_since_diff(lang, path)));
    }
    if let Some(error) = &applied.files_error {
        out.push_str(&clack.cancel(error));
        return done(out, String::new(), 1);
    }
    if let Some(backup) = &applied.files_backup {
        out.push_str(&clack.message(&format!("{} [root:sync] {backup}", i18n::BACKUP_LABEL)));
    }
    for (engine, backup) in &applied.backups {
        out.push_str(&clack.message(&format!("{} [root:{engine}] {backup}", i18n::BACKUP_LABEL)));
    }
    let written_total = applied.files_applied.len() + applied.written;
    let kept = if flags.accept_new {
        file_conflicts.len()
    } else {
        conflicts.len()
    } - applied.files_applied.len();
    out.push_str(&clack.success(&i18n::sync_wrote_files(lang, written_total)));
    let (written_token, kept_token) = i18n::sync_tokens(written_total, kept);
    let mut parts = Vec::new();
    if written_total > 0 {
        parts.push(written_token);
    }
    if kept > 0 {
        parts.push(kept_token);
    }
    let summary = if parts.is_empty() {
        String::new()
    } else {
        format!("\u{2014} {}", parts.join(", "))
    };
    out.push_str(&clack.outro(&format!("{} {summary}", i18n::RENDER_DONE_WORD)));
    done(out, applied.stderr, 0)
}
