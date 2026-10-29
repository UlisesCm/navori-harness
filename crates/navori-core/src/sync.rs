//! `navori sync` without prompts over a solo-Claude root (`commands/sync.ts`, spec 0058 T29).
//!
//! The run plans the Claude engine in preview, reports it, and with `--apply`/`--yes` plans again
//! with the bulk resolution (`--accept-new` overwrites every conflicting `CLAUDE.md` block through
//! `forceIds`; `--keep-mine` keeps them, which is what the engine does anyway) and commits it as
//! `render` does. Sync writes no ignore file and touches no registry.
//!
//! Every branch that would prompt (`p.select`, `p.confirm`) is unreachable natively: the manifest
//! entry `requires` one of `apply`, `yes`, `dry-run`, `json`, `accept-new` or `keep-mine`, and a
//! run that still reaches a prompt returns [`SyncRun::Delegate`] before any output.

use std::collections::BTreeSet;
use std::path::Path;

use crate::config::{Config, HarnessRecord, record_harness_version};
use crate::fs::write_file_atomic;
use crate::i18n;
use crate::js_json::{JsObject, JsValue};
use crate::markers::{CommentStyle, InjectStatus, extract_managed_content};
use crate::render::block_plan::{AssetStatus, PlanAsset, PlanOptions};
use crate::render::claude::{ClaudeEnginePlan, plan_claude_engine};
use crate::render::collect::RepoView;
use crate::render::command::{Apply, RenderError, commit_claude};
use crate::render::context::Lang;
use crate::render::report::{Clack, status_symbol, written};

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
) -> Result<ClaudeEnginePlan, RenderError> {
    let options = PlanOptions {
        ambient_floor: config.harness_version(),
        force_ids,
        ..PlanOptions::default()
    };
    plan_claude_engine(view, &config.data, repo_root, &options).map_err(|_| RenderError::Delegate)
}

/// `collectTargetConflicts` of the root target.
#[must_use]
pub fn conflicts(plan: &ClaudeEnginePlan) -> Vec<SyncConflict> {
    let mut out = Vec::new();
    for (id, status) in &plan.claude_md_entries {
        if *status == AssetStatus::Inject(InjectStatus::UserModifiedSkipped) {
            out.push(SyncConflict {
                path: format!("CLAUDE.md ({id})"),
                reason: "managed block edited".to_owned(),
                block: true,
                bulk: true,
                markerless: false,
            });
        }
    }
    for skip in &plan.skipped {
        if skip.status == Some(InjectStatus::UserModifiedSkipped) {
            out.push(SyncConflict {
                path: skip.rel_path.clone(),
                reason: skip.reason.clone(),
                block: false,
                bulk: skip.resolution.is_some(),
                markerless: skip.markerless_resolution.is_some(),
            });
        }
    }
    out
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

/// `reportTargetPlan` of the root target, uncolored.
fn report(clack: Clack, lang: Lang, plan: &ClaudeEnginePlan, view: &dyn RepoView) -> String {
    let mut lines = vec![i18n::sync_plan_title("root")];
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
        lines.push(format!(
            "  ! [claude] {}  (skipped: {})",
            skip.rel_path, skip.reason
        ));
        if let Some(proposal) = skip
            .resolution
            .as_deref()
            .or(skip.markerless_resolution.as_deref())
        {
            let basis = view.read(&skip.rel_path).unwrap_or_default();
            lines.extend(diff_lines(lang, &basis, proposal));
        }
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
    let unresolvable = plan.skipped.iter().any(|s| {
        s.status == Some(InjectStatus::UserModifiedSkipped)
            && s.resolution.is_none()
            && s.markerless_resolution.is_none()
    });
    if unresolvable {
        lines.push(format!(
            "      {}",
            i18n::sync_conflict_diff_file_level(lang)
        ));
    }
    clack.message(&lines.join("\n"))
}

/// What the apply pass did: writes, backup, `recordHarnessVersionIfWritten`'s stderr.
struct Applied {
    written: usize,
    backup: Option<String>,
    stderr: String,
}

/// `prepareSyncApply(targets, [], resolutions).commit()` plus `recordHarnessVersionIfWritten`.
fn apply_pass(
    apply: &mut Apply<'_>,
    view: &dyn RepoView,
    config: &Config,
    repo_root: &Path,
    force_ids: BTreeSet<String>,
) -> Result<Applied, RenderError> {
    let mut claude = plan(view, config, repo_root, force_ids)?;
    let (backup, real_writes) = commit_claude(apply, repo_root, &mut claude, config.lang())?;
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
        written: written(&claude).len(),
        backup,
        stderr,
    })
}

/// `buildBulkResolutions(plans, "accept-new")`: every conflicting block id.
fn accept_new_ids(plan: &ClaudeEnginePlan) -> BTreeSet<String> {
    plan.claude_md_entries
        .iter()
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
fn sync_json(
    plan: &ClaudeEnginePlan,
    conflicts: &[SyncConflict],
    flags: SyncFlags,
    ok: bool,
    mode: &str,
    written_total: usize,
    backup: Option<&str>,
) -> JsValue {
    let pair = |path: &str, status: &str| {
        object(vec![
            ("path", JsValue::string(path)),
            ("status", JsValue::string(status)),
        ])
    };
    let target = object(vec![
        ("label", JsValue::string("root")),
        (
            "claudeMd",
            JsValue::Array(
                plan.claude_md_entries
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
                written(plan)
                    .into_iter()
                    .filter(|(path, _)| *path != "CLAUDE.md")
                    .map(|(path, status)| pair(path, status))
                    .collect(),
            ),
        ),
        (
            "skipped",
            JsValue::Array(
                plan.skipped
                    .iter()
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
            ),
        ),
        (
            "updatesAvailable",
            JsValue::Array(
                plan.updates_available
                    .iter()
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
        ("engines", JsValue::Array(Vec::new())),
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
        ("acceptNewFiles", JsValue::Bool(false)),
        ("targets", JsValue::Array(vec![target])),
        (
            "conflicts",
            JsValue::Array(
                conflicts
                    .iter()
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
        ("pending", number(written(plan).len())),
        ("written", number(written_total)),
        (
            "backups",
            JsValue::Array(
                backup
                    .map(|path| {
                        object(vec![
                            ("label", JsValue::string("root:claude")),
                            ("path", JsValue::string(path)),
                        ])
                    })
                    .into_iter()
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
    let preview = plan(view, config, repo_root, BTreeSet::new())?;
    let conflicts = conflicts(&preview);
    let pending = written(&preview).len();
    let blocked_yes = flags.yes && flags.bulk().is_none() && !conflicts.is_empty();
    let force_ids = if flags.accept_new {
        accept_new_ids(&preview)
    } else {
        BTreeSet::new()
    };

    if flags.json {
        let auto_apply = (flags.apply || flags.yes) && !flags.dry_run;
        let mut written_total = 0;
        let mut backup = None;
        let mut stderr = String::new();
        if auto_apply && !blocked_yes {
            let applied = apply_pass(apply, view, config, repo_root, force_ids)?;
            written_total = applied.written;
            backup = applied.backup;
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
            flags,
            !blocked_yes,
            mode,
            written_total,
            backup.as_deref(),
        );
        let text = value.stringify(Some(2)).ok_or(RenderError::Delegate)?;
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
    if resolvable > 0 {
        out.push_str(&clack.warn(&i18n::sync_file_conflicts_kept(lang, resolvable)));
    }
    let applied = apply_pass(apply, view, config, repo_root, force_ids)?;
    if let Some(backup) = &applied.backup {
        out.push_str(&clack.message(&format!("{} [root:claude] {backup}", i18n::BACKUP_LABEL)));
    }
    let kept = if flags.accept_new {
        file_conflicts.len()
    } else {
        conflicts.len()
    };
    out.push_str(&clack.success(&i18n::sync_wrote_files(lang, applied.written)));
    let (written_token, kept_token) = i18n::sync_tokens(applied.written, kept);
    let mut parts = Vec::new();
    if applied.written > 0 {
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
