//! Steps 5, 6.5-bis and 7 of `prepareClaudeEngine` (spec 0058 T14): the one-shot `progress/`
//! files, the preset hooks and the plugin scripts under `.claude/scripts/`, each through
//! `planManagedFile`/`planBootstrapFile` (`engines/claude/index.ts`) rather than the shared spine.
//!
//! Only the full harness scope is modeled; workspace renders are delegated upstream.

use std::collections::BTreeMap;

use crate::STAMP_VERSION;
use crate::i18n;
use crate::js_json::JsValue;
use crate::markers::{CommentStyle, InjectStatus};
use crate::render::assets;
use crate::render::collect::{
    PendingWrite, RepoView, SkippedFile, collect_managed, read_if_exists,
};
use crate::render::context::Lang;
use crate::render::harness_files::asset_text;
use crate::render::harness_plan::{normalize_rel, preset_hooks};
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::managed_file::{RenderManagedFileInput, render_managed_file};
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::plugin_scripts::{
    ScriptEngine, ScriptPlacement, legacy_script_content, matches_legacy_fingerprint,
    plugin_script_placements,
};
use crate::render::plugins::LoadedPlugin;
use crate::render::presets::LoadedPreset;

/// The TS would throw (an unreadable asset or destination, a missing include, …), or the path
/// is one Rust does not model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeFilesDelegate;

/// What these steps add to the plan.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaudeFiles {
    /// Files to write, in step order.
    pub pending: Vec<PendingWrite>,
    /// Files kept.
    pub skipped: Vec<SkippedFile>,
}

fn text_at(config: &JsValue, path: &[&str]) -> Option<String> {
    let mut value = config;
    for key in path {
        let JsValue::Object(object) = value else {
            return None;
        };
        value = object.get(key)?;
    }
    match value {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

/// `relative(cwd, join(cwd, rel))`; a trailing slash (which `existsSync` reads differently)
/// is not modeled.
fn dest_path(rel: &str) -> Result<String, ClaudeFilesDelegate> {
    let normalized = normalize_rel(rel);
    if rel.ends_with('/') || normalized.is_empty() {
        return Err(ClaudeFilesDelegate);
    }
    Ok(normalized)
}

/// A destination recorded in the owned-path inventory: `OwnedPathInventory.observe` throws on
/// anything but an exact, normalized relative path.
fn owned_dest(rel: &str) -> Result<String, ClaudeFilesDelegate> {
    let drive = rel.as_bytes().get(1) == Some(&b':')
        && rel.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    let invalid = rel.is_empty()
        || rel == "-"
        || rel.contains(['\r', '\n', '\\', '\0'])
        || rel.starts_with('/')
        || drive
        || rel
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..");
    if invalid {
        return Err(ClaudeFilesDelegate);
    }
    Ok(rel.to_owned())
}

/// `existsSync ? readFileSync : null`.
fn on_disk(view: &dyn RepoView, rel: &str) -> Result<Option<String>, ClaudeFilesDelegate> {
    read_if_exists(view, rel).map_err(|_| ClaudeFilesDelegate)
}

/// `inferCommentStyle`.
fn style_of(path: &str) -> CommentStyle {
    if path.ends_with(".sh") {
        CommentStyle::Shell
    } else {
        CommentStyle::Html
    }
}

/// Step 5: `progress/current.md` and `progress/history.md`, written once and never again.
fn bootstrap(
    view: &dyn RepoView,
    config: &JsValue,
    files: &mut ClaudeFiles,
) -> Result<(), ClaudeFilesDelegate> {
    let dir = text_at(config, &["progress", "dir"]).unwrap_or_else(|| "progress".to_owned());
    for (asset, key, default) in [
        ("current.md", "currentFile", "current.md"),
        ("history.md", "historyFile", "history.md"),
    ] {
        let file = text_at(config, &["progress", key]).unwrap_or_else(|| default.to_owned());
        let rel = dest_path(&format!("{dir}/{file}"))?;
        if view.exists(&rel) {
            continue;
        }
        let raw = assets::core(&format!("core-assets/progress/{asset}"))
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or(ClaudeFilesDelegate)?;
        files.pending.push(PendingWrite {
            rel_path: rel,
            content: interpolate(raw, config, &InterpolateOptions::default()),
            status: InjectStatus::Created,
            chmod_exec: false,
        });
    }
    Ok(())
}

struct ManagedTarget<'a> {
    rel: &'a str,
    asset: &'a str,
    style: CommentStyle,
    existing: Option<&'a str>,
    managed_id: &'a str,
    source: &'a str,
    chmod_exec: bool,
}

/// `applyManagedFilePlan(planManagedFile(…))`.
fn apply_managed(
    view: &dyn RepoView,
    target: &ManagedTarget<'_>,
    config: &JsValue,
    lang: Lang,
    ambient_floor: Option<&str>,
    files: &mut ClaudeFiles,
) -> Result<(), ClaudeFilesDelegate> {
    let input = managed_input(target, config, ambient_floor);
    let collected = collect_managed(view, target.rel, &input, target.chmod_exec, lang)
        .map_err(|_| ClaudeFilesDelegate)?;
    files.pending.extend(collected.write);
    files.skipped.extend(collected.skip);
    Ok(())
}

fn managed_input<'a>(
    target: &ManagedTarget<'a>,
    config: &'a JsValue,
    ambient_floor: Option<&'a str>,
) -> RenderManagedFileInput<'a> {
    RenderManagedFileInput {
        asset: target.asset,
        style: target.style,
        existing: target.existing,
        managed_id: target.managed_id,
        source: target.source,
        version: STAMP_VERSION,
        config,
        extra_vars: BTreeMap::new(),
        transform: None,
        engine: None,
        force_overwrite: false,
        ambient_floor,
    }
}

/// Step 6.5-bis: the preset's `extras.hooks`, executable, stamped as core.
fn preset_hook_files(
    view: &dyn RepoView,
    preset: Option<&LoadedPreset>,
    config: &JsValue,
    lang: Lang,
    ambient_floor: Option<&str>,
    files: &mut ClaudeFiles,
) -> Result<(), ClaudeFilesDelegate> {
    for hook in preset_hooks(preset, config) {
        let rel = owned_dest(&hook.dest)?;
        let asset = asset_text(&hook.asset).map_err(|_| ClaudeFilesDelegate)?;
        let existing = on_disk(view, &rel)?;
        let target = ManagedTarget {
            rel: &rel,
            asset: &asset,
            style: style_of(&hook.asset.rel),
            existing: existing.as_deref(),
            managed_id: &hook.managed_id,
            source: CORE_SOURCE_ID,
            chmod_exec: true,
        };
        apply_managed(view, &target, config, lang, ambient_floor, files)?;
    }
    Ok(())
}

/// `attachMarkerlessResolution` for a markerless script: the whole-file replace, when the file
/// is regular, mentions no marker and the fresh render is exactly one block that changes it.
fn markerless_resolution(
    view: &dyn RepoView,
    target: &ManagedTarget<'_>,
    basis: &str,
    config: &JsValue,
    ambient_floor: Option<&str>,
) -> Option<String> {
    if basis.contains("navori:managed") {
        return None;
    }
    view.read_regular(target.rel)?;
    let fresh = render_managed_file(&managed_input(target, config, ambient_floor)).ok()?;
    let writes = !matches!(
        fresh.status,
        InjectStatus::Unchanged
            | InjectStatus::UserModifiedSkipped
            | InjectStatus::DowngradeSkipped
    );
    (writes && fresh.content.matches("navori:managed start").count() == 1 && fresh.content != basis)
        .then_some(fresh.content)
}

/// Step 7 for one placement, with the #637 migration of markerless scripts.
fn script_file(
    view: &dyn RepoView,
    placement: &ScriptPlacement,
    config: &JsValue,
    lang: Lang,
    ambient_floor: Option<&str>,
    files: &mut ClaudeFiles,
) -> Result<(), ClaudeFilesDelegate> {
    let rel = owned_dest(&placement.dest_rel_path)?;
    let template = placement.template().ok_or(ClaudeFilesDelegate)?;
    let disk = on_disk(view, &rel)?;
    let marker = format!("navori:managed start id=\"{}\"", placement.managed_id);
    let legacy = disk.as_deref().filter(|text| !text.contains(&marker));
    let target = ManagedTarget {
        rel: &rel,
        asset: template,
        style: style_of(placement.file_name()),
        existing: if legacy.is_some() {
            None
        } else {
            disk.as_deref()
        },
        managed_id: &placement.managed_id,
        source: &placement.source,
        chmod_exec: placement.script.exec,
    };
    if let Some(basis) = legacy {
        let pristine = legacy_script_content(template, config).ok_or(ClaudeFilesDelegate)?;
        if basis != pristine && !matches_legacy_fingerprint(placement.file_name(), basis) {
            let resolution = markerless_resolution(view, &target, basis, config, ambient_floor);
            files.skipped.push(SkippedFile {
                rel_path: rel.clone(),
                reason: if resolution.is_some() {
                    i18n::markerless_file_edited_resolvable(lang)
                } else {
                    i18n::managed_block_edited_by_hand(lang)
                }
                .to_owned(),
                status: Some(InjectStatus::UserModifiedSkipped),
                resolution: None,
                markerless_resolution: resolution,
            });
            return Ok(());
        }
    }
    apply_managed(view, &target, config, lang, ambient_floor, files)
}

/// Steps 5, 6.5-bis and 7 over `enabled` plugins, in that order.
///
/// # Errors
/// [`ClaudeFilesDelegate`] where the TS throws or the paths are not modeled.
pub fn collect_claude_files(
    view: &dyn RepoView,
    config: &JsValue,
    lang: Lang,
    preset: Option<&LoadedPreset>,
    enabled: &[LoadedPlugin],
    ambient_floor: Option<&str>,
) -> Result<ClaudeFiles, ClaudeFilesDelegate> {
    let mut files = ClaudeFiles::default();
    bootstrap(view, config, &mut files)?;
    preset_hook_files(view, preset, config, lang, ambient_floor, &mut files)?;
    for plugin in enabled {
        for placement in plugin_script_placements(plugin, ScriptEngine::Claude) {
            script_file(view, &placement, config, lang, ambient_floor, &mut files)?;
        }
    }
    Ok(files)
}
