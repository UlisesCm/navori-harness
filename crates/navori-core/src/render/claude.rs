//! `prepareClaudeEngine(...).finalize()` of a full root render (spec 0058 T14): every ported step
//! assembled in the TS order into one pure plan.
//!
//! Pending writes follow the TS array: step 1 (context files, then `CLAUDE.md`), step 2
//! (`settings.json`), step 2.5 (`.mcp.json`), the shared spine (agents, skills, hooks), then
//! `progress/`, preset hooks and plugin scripts, with sub-blocks edited in place or appended.
//! Skips follow the TS too: steps 1–2.5, steps 5–7, the spine, then the sub-blocks.
//!
//! `force` is outside the native subset (T17), so every step plans without it.
//!
//! The native hook wiring runs last, as in `finalize`: ported hooks are wrapped and signed, and
//! `settings.json` registers them natively.
//!
//! Not modeled yet, so absent from the plan: the warnings outside the ported steps (T16).

use std::path::Path;

use crate::config::effective_config;
use crate::i18n;
use crate::js_json::JsValue;
use crate::render::block_plan::{AssetStatus, PlanOptions, UpdateAvailable};
use crate::render::claude_files::collect_claude_files;
use crate::render::claude_md::plan_claude_md;
use crate::render::claude_settings::build_claude_settings;
use crate::render::collect::{PendingWrite, RepoView, SkippedFile, read_if_exists};
use crate::render::context::Lang;
use crate::render::harness_files::{collect_harness_files, filter_inventory};
use crate::render::harness_plan::{preset_hooks, resolve_harness_plan};
use crate::render::library_skills::unknown_libraries;
use crate::render::mcp_file::{MCP_PATH, declares_mcp_server, plan_mcp_registration};
use crate::render::native_hooks::{
    NativeHooksInput, apply_native_claude_settings, embedded_native_hooks, finalize_native_hooks,
};
use crate::render::owned_paths::{ClaudeOwnedInput, claude_owned_paths};
use crate::render::plugins::{load_disabled_plugins, load_enabled_plugins};
use crate::render::presets::load_preset;
use crate::render::retirements::{PendingRemoval, RetirementInput, plan_retirements};
use crate::render::settings_file::{SETTINGS_PATH, SettingsPlan, plan_settings};
use crate::render::sub_blocks::{SubBlockCtx, apply_sub_blocks};

/// Some step delegates: the invocation goes to the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeEngineDelegate;

/// The finalized plan of a Claude render (`CollectedPlan` plus the report fields).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaudeEnginePlan {
    /// Files to write, in the TS order.
    pub pending: Vec<PendingWrite>,
    /// Paths to delete, in the TS order.
    pub removals: Vec<PendingRemoval>,
    /// Files kept, in the TS order.
    pub skipped: Vec<SkippedFile>,
    /// The warnings of the ported steps, in step order.
    pub warnings: Vec<String>,
    /// `(relPath, overwrittenKeys)` of markerless destinations adopted by name.
    pub collisions: Vec<(String, Vec<String>)>,
    /// Blocks whose version on disk is older (`CLAUDE.md` plan, then sub-blocks).
    pub updates_available: Vec<UpdateAvailable>,
    /// Blocks written by a newer navori.
    pub downgrades: Vec<UpdateAvailable>,
    /// The sealed owned paths `guard-destructive` embeds.
    pub owned_paths: String,
    /// `inspected`: destinations the engine looked at, written or not.
    pub inspected: usize,
    /// `claudeMdEntries`: `(asset id, status)` of every `CLAUDE.md` block, in plan order.
    pub claude_md_entries: Vec<(String, AssetStatus)>,
    /// `languageFallbacks`.
    pub language_fallbacks: Vec<String>,
}

fn text(config: &JsValue, key: &str) -> Option<String> {
    match config {
        JsValue::Object(object) => match object.get(key) {
            Some(JsValue::String(value)) => value.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

/// `config.project?.[key] ?? []`, its strings.
fn project_list(config: &JsValue, key: &str) -> Vec<String> {
    let JsValue::Object(root) = config else {
        return Vec::new();
    };
    let Some(JsValue::Object(project)) = root.get("project") else {
        return Vec::new();
    };
    match project.get(key) {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `config.qualityGate?.fast` is truthy.
fn quality_gate_fast(config: &JsValue) -> bool {
    let JsValue::Object(root) = config else {
        return false;
    };
    match root.get("qualityGate") {
        Some(JsValue::Object(gate)) => gate
            .get("fast")
            .is_some_and(crate::render::block_plan::truthy),
        _ => false,
    }
}

/// `resolveLocalSkillPath(cwd, id) !== null`: a plain id whose directory form exists.
fn local_skill_present(view: &dyn RepoView, id: &str) -> bool {
    let trimmed =
        crate::integrity::js_trim_end(id.trim_start_matches(crate::integrity::is_js_whitespace));
    if id.is_empty() || trimmed != id || id.contains(['/', '\\']) || id.contains("..") {
        return false;
    }
    view.exists(&format!(".claude/skills/{id}/SKILL.md"))
}

fn delegate<T, E>(result: Result<T, E>) -> Result<T, ClaudeEngineDelegate> {
    result.map_err(|_| ClaudeEngineDelegate)
}

/// Pushes a JSON file's plan onto the plan arrays; whether it was skipped.
fn place(
    plan: SettingsPlan,
    rel_path: &str,
    pending: &mut Vec<PendingWrite>,
    skipped: &mut Vec<SkippedFile>,
) -> bool {
    match plan {
        SettingsPlan::Noop => false,
        SettingsPlan::Skip { reason, status } => {
            skipped.push(SkippedFile {
                rel_path: rel_path.to_owned(),
                reason,
                status,
                resolution: None,
                markerless_resolution: None,
            });
            true
        }
        SettingsPlan::Write { content, status } => {
            pending.push(PendingWrite {
                rel_path: rel_path.to_owned(),
                content,
                status,
                chmod_exec: false,
            });
            false
        }
    }
}

/// Plans a full Claude render of the repo at `repo_root` (read through `view`).
///
/// # Errors
/// [`ClaudeEngineDelegate`] when any step delegates (monorepo workspaces, a preset or plugin
/// the TS rejects, an unreadable destination, a retired plugin's asset on disk, …).
pub fn plan_claude_engine(
    view: &dyn RepoView,
    input_config: &JsValue,
    repo_root: &Path,
    options: &PlanOptions,
) -> Result<ClaudeEnginePlan, ClaudeEngineDelegate> {
    let config = effective_config(input_config);
    let lang = Lang::resolve(text(&config, "language").as_deref());
    let floor = options.ambient_floor.as_deref();

    // 1–1e.
    let step1 = delegate(plan_claude_md(view, input_config, repo_root, options))?;

    // The inventory `resolveClaudeInventory` produces.
    let preset_id = text(&config, "preset");
    let preset = match preset_id.as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => delegate(load_preset(id, repo_root))?,
    };
    let preset_loaded = match preset_id.as_deref() {
        None | Some("" | "custom") => true,
        Some(id) => preset
            .as_ref()
            .is_some_and(|p| text(&p.def, "id").as_deref() == Some(id)),
    };
    let plugins = match &config {
        JsValue::Object(object) => object.get("plugins").cloned(),
        _ => None,
    };
    let enabled = delegate(load_enabled_plugins(plugins.as_ref()))?.loaded;
    let disabled = delegate(load_disabled_plugins(plugins.as_ref()))?.loaded;
    let plan = filter_inventory(resolve_harness_plan(
        &config,
        preset.as_ref(),
        true,
        Some("claude"),
    ));
    let hooks = preset_hooks(preset.as_ref(), &config);
    let owned_paths = delegate(claude_owned_paths(
        view,
        &ClaudeOwnedInput {
            claude_md: &step1.observed,
            plan: &plan,
            preset_hooks: &hooks,
            enabled: &enabled,
            disabled: &disabled,
        },
    ))?;

    // 3–6.6 (the spine) and 5–7.
    let harness = delegate(collect_harness_files(
        view,
        &plan,
        &config,
        lang,
        floor,
        Some(&owned_paths),
    ))?;
    let own = delegate(collect_claude_files(
        view,
        &config,
        lang,
        preset.as_ref(),
        &enabled,
        floor,
    ))?;

    // 2. `settings.json`, stamped against the config's `harnessVersion`.
    let settings = delegate(build_claude_settings(&config, &plan, &enabled))?;
    let harness_version = text(&config, "harnessVersion");
    let settings_plan = delegate(plan_settings(
        view,
        &settings,
        harness_version.as_deref(),
        false,
        lang,
    ))?;

    // 2.5. `.mcp.json`.
    let mcp_plan = delegate(plan_mcp_registration(
        view,
        &enabled,
        &disabled,
        harness_version.as_deref(),
        false,
        lang,
    ))?;

    let mut pending = step1.pending;
    let mut skipped = step1.skipped;
    let settings_skipped = place(settings_plan, SETTINGS_PATH, &mut pending, &mut skipped);
    let skipped_settings = if settings_skipped {
        delegate(read_if_exists(view, SETTINGS_PATH))?
    } else {
        None
    };
    place(mcp_plan, MCP_PATH, &mut pending, &mut skipped);
    pending.extend(harness.pending);
    pending.extend(own.pending);
    skipped.extend(own.skipped);
    skipped.extend(harness.skipped);

    // 8–8.5-ter, then the retirements.
    let ctx = SubBlockCtx {
        view,
        config: &config,
        lang,
        ambient_floor: floor,
    };
    let sub_blocks = delegate(apply_sub_blocks(&ctx, &enabled, &disabled, &mut pending))?;
    skipped.extend(sub_blocks.skipped);
    let retirements = delegate(plan_retirements(
        view,
        &RetirementInput {
            config: &config,
            lang,
            plan: &plan,
            preset_loaded,
            disabled: &disabled,
            skipped_settings: skipped_settings.as_deref(),
        },
    ))?;

    // The native wiring, over the finished pending writes.
    let native_manifest = options
        .native_hooks
        .clone()
        .unwrap_or_else(embedded_native_hooks);
    let eligible = delegate(finalize_native_hooks(
        &NativeHooksInput {
            view,
            config: &config,
            hooks: &plan.hooks,
            plugins: &enabled,
            manifest: &native_manifest,
            ambient_floor: floor,
            owned_paths: Some(&owned_paths),
        },
        &mut pending,
    ))?;
    delegate(apply_native_claude_settings(
        view,
        &mut pending,
        &eligible,
        settings_skipped,
        harness_version.as_deref(),
    ))?;

    let mut removals: Vec<PendingRemoval> = step1
        .removals
        .into_iter()
        .map(|rel_path| PendingRemoval {
            rel_path,
            recursive: false,
        })
        .collect();
    removals.extend(retirements.removals);
    let mut warnings = step1.warnings;
    // `loadActivePreset`, `unknownLibraries` and the quality-gate note, before the spine.
    if let Some(id) = preset_id
        .as_deref()
        .filter(|id| !id.is_empty() && *id != "custom")
    {
        match &preset {
            None => warnings.push(format!(
                "preset '{id}' not found (no .navori/presets/{id}/ nor bundled). Workspace will render with the core baseline only."
            )),
            Some(loaded) => warnings.extend(loaded.dropped_libraries.iter().map(|lib| {
                format!(
                    "preset '{}' declares library '{lib}', unknown to this CLI's registry; skipped.",
                    text(&loaded.def, "id").unwrap_or_default()
                )
            })),
        }
    }
    let mut libraries = project_list(&config, "libraries");
    libraries.extend(project_list(&config, "extraLibraries"));
    for (id, removed, successors) in unknown_libraries(&libraries) {
        warnings.push(if removed {
            i18n::library_removed_from_registry(lang, &id, successors)
        } else {
            i18n::library_unknown_in_registry(lang, &id)
        });
    }
    if !quality_gate_fast(&config) {
        warnings.push(i18n::quality_gate_hook_skipped(lang).to_owned());
    }
    warnings.extend(sub_blocks.warnings);
    warnings.extend(retirements.script_warnings);
    warnings.extend(sub_blocks.retired_warnings);
    warnings.extend(retirements.warnings);
    // `collisionWarnings` at commit, without a backup in a preview.
    warnings.extend(
        harness
            .collisions
            .iter()
            .map(|(path, keys)| i18n::markerless_collision(lang, path, keys, None)),
    );
    // `reportMissingLocalSkills`, which `runRenderCore` appends to the engine's warnings.
    for id in project_list(&config, "localSkills") {
        if plan.skills.iter().any(|s| s.id == id) {
            continue;
        }
        if !local_skill_present(view, &id) {
            warnings.push(i18n::local_skill_missing(lang, &id));
        }
    }
    let mut updates_available = step1.plan.updates_available;
    updates_available.extend(sub_blocks.updates_available);
    let mut downgrades = step1.plan.downgrades;
    downgrades.extend(sub_blocks.downgrades);

    // `inspected`, step by step: 1 to 1e, settings, `.mcp.json` when there is one to manage, the
    // spine, `progress/`, preset hooks, plugin scripts, the sub-blocks and the retirements.
    let has_mcp = enabled.iter().any(declares_mcp_server) || view.exists(MCP_PATH);
    let scripts: usize = enabled.iter().map(|p| p.script_assets.len()).sum();
    let inspected = step1.inspected
        + 1
        + usize::from(has_mcp)
        + plan.agents.len()
        + plan.skills.len()
        + plan.hooks.len()
        + 2
        + hooks.len()
        + scripts
        + sub_blocks.inspected
        + retirements.inspected;

    Ok(ClaudeEnginePlan {
        pending,
        removals,
        skipped,
        warnings,
        collisions: harness.collisions,
        updates_available,
        downgrades,
        owned_paths,
        inspected,
        claude_md_entries: step1
            .plan
            .entries
            .iter()
            .map(|e| (e.asset.id().to_owned(), e.status))
            .collect(),
        language_fallbacks: step1.plan.language_fallbacks,
    })
}
