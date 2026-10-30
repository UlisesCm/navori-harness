//! `computeRenderPlan` and `canonicalManagedOrder` of `render-plan.ts` (spec 0058 T14): the
//! managed-block plan of `CLAUDE.md` — core assets, preset extras, then declared plugins.
//!
//! Pure over the embedded bundle; only a local preset reads the repo. Every path where the TS
//! throws, or reports a message Rust does not reproduce, returns [`PlanDelegate`].

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::STAMP_VERSION;
use crate::config::effective_config;
use crate::js_json::JsValue;
use crate::markers::{
    CommentStyle, InjectDetails, InjectOptions, InjectResult, InjectStatus, Kept, MarkerMeta,
    inject_managed_section, remove_managed_section, remove_managed_section_guarded,
};
use crate::render::assets;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::plan::{
    Audience, CORE_MANAGED_ASSETS, CORE_SOURCE_ID, CoreManagedAsset, EXCLUDABLE_BLOCK_IDS,
    condition_orchestration, resolve_asset_path,
};
use crate::render::plugins::{PluginLoadError, RETIRED_PLUGIN_BLOCKS, load_plugin, retired_plugin};
use crate::render::presets::{AssetRoot, load_preset};
use crate::semver;

/// The TS would throw, or report a message Rust does not reproduce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanDelegate;

/// `AssetStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetStatus {
    /// An `injectManagedSection` status.
    Inject(InjectStatus),
    /// Removed because its condition turned false (or the block was opted out / retired).
    RemovedConditionFalse,
    /// A retired block the user edited, kept.
    RetiredKept,
}

impl AssetStatus {
    /// The TS status string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inject(status) => status.as_str(),
            Self::RemovedConditionFalse => "removed-condition-false",
            Self::RetiredKept => "retired-kept",
        }
    }
}

/// `AssetPlanEntry.asset`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanAsset {
    /// A `CORE_MANAGED_ASSETS` entry.
    Core(CoreManagedAsset),
    /// A preset extra: `relPath` under the preset's asset root.
    Preset {
        /// Block id.
        id: String,
        /// `extras.managed[].relPath`, verbatim.
        rel_path: String,
    },
    /// A plugin `managed[]` entry; the TS `relPath` is the absolute path of this file.
    Plugin {
        /// Block id.
        id: String,
        /// Plugin directory under `packages/plugins/`.
        dir: String,
        /// File under the plugin root.
        path: String,
    },
    /// A block the engine computes from config; the TS `relPath` is `(computed)`.
    Computed {
        /// Block id.
        id: String,
    },
    /// A retired plugin block; the TS `relPath` is `@navori/plugin-<id>`.
    Retired {
        /// Block id.
        id: String,
        /// `@navori/plugin-<plugin id>`.
        rel_path: String,
    },
}

impl PlanAsset {
    /// Block id.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Core(asset) => asset.id,
            Self::Preset { id, .. }
            | Self::Plugin { id, .. }
            | Self::Computed { id }
            | Self::Retired { id, .. } => id,
        }
    }
}

/// `AssetPlanEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanEntry {
    /// The asset.
    pub asset: PlanAsset,
    /// `"core"`, the preset id or the plugin id.
    pub source: String,
    /// What happened to the block.
    pub status: AssetStatus,
    /// `injectManagedSection` details, when it ran.
    pub details: Option<InjectDetails>,
    /// Rendered body, `None` when the block is absent from the plan.
    pub new_content: Option<String>,
}

/// `classifyVersionDrift`: a drifted block on disk is an update, or a downgrade when its
/// version is newer than this CLI's.
pub fn classify_version_drift(
    details: &InjectDetails,
    id: &str,
    source: &str,
    updates_available: &mut Vec<UpdateAvailable>,
    downgrades: &mut Vec<UpdateAvailable>,
) {
    let Some(existing) = details
        .existing_version
        .as_deref()
        .filter(|v| !v.is_empty())
    else {
        return;
    };
    if details.version_drift != Some(true) {
        return;
    }
    let entry = UpdateAvailable {
        id: id.to_owned(),
        source: source.to_owned(),
        from_version: existing.to_owned(),
        to_version: STAMP_VERSION.to_owned(),
    };
    if semver::compare(Some(existing), Some(STAMP_VERSION)) == Some(Ordering::Greater) {
        downgrades.push(entry);
    } else {
        updates_available.push(entry);
    }
}

/// `UpdateAvailable`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateAvailable {
    /// Block id.
    pub id: String,
    /// Marker source.
    pub source: String,
    /// Version on disk.
    pub from_version: String,
    /// Version this CLI ships.
    pub to_version: String,
}

/// `RenderPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPlan {
    /// The document the plan started from.
    pub existing: String,
    /// The document after the plan.
    pub next: String,
    /// Every block, in emission order.
    pub entries: Vec<PlanEntry>,
    /// `(id, reason)` of the preset or plugins that could not load.
    pub missing_plugins: Vec<(String, String)>,
    /// Core ids served from a Spanish base the repo did not ask for.
    pub language_fallbacks: Vec<String>,
    /// Markers older than this CLI.
    pub updates_available: Vec<UpdateAvailable>,
    /// Markers newer than this CLI, preserved.
    pub downgrades: Vec<UpdateAvailable>,
}

impl RenderPlan {
    /// `changed`.
    #[must_use]
    pub fn changed(&self) -> bool {
        self.next != self.existing
    }
}

/// The `options` of `computeRenderPlan`, plus the run-wide marker floor the TS keeps ambient.
#[derive(Debug, Clone, Default)]
pub struct PlanOptions {
    /// Blocks the caller leaves alone.
    pub skip_ids: BTreeSet<String>,
    /// Blocks overwritten even when hand-edited.
    pub force_ids: BTreeSet<String>,
    /// Workspace render: drop root-only blocks.
    pub omit_root_only: bool,
    /// Engine being rendered (`"claude"` when `None`).
    pub engine: Option<String>,
    /// `setMarkerFloorVersion`.
    pub ambient_floor: Option<String>,
    /// `loadNativeHooks()` override; `None` reads the embedded `crates/ported.json`.
    pub native_hooks: Option<BTreeMap<String, crate::manifest::Hook>>,
    /// `render --force`: the engine's JSON files overwrite what the user left.
    pub force: bool,
}

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn text(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

/// JS `Boolean(value)`.
pub(crate) fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(flag) => *flag,
        JsValue::Number(number) => *number != 0.0 && !number.is_nan(),
        JsValue::String(text) => !text.units().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

/// `resolveCondition` (`marker.ts`): walks a dotted path; anything but an object stops at false.
pub(crate) fn resolve_condition(config: &JsValue, path: &str) -> bool {
    let mut cursor = config.clone();
    for segment in path.split('.') {
        cursor = match &cursor {
            JsValue::Object(object) => object.get(segment).cloned().unwrap_or(JsValue::Undefined),
            // No `CORE_MANAGED_ASSETS` condition names an index or `length`.
            JsValue::Array(_) => JsValue::Undefined,
            _ => return false,
        };
    }
    truthy(&cursor)
}

/// `.` and `//` collapse as `path.resolve` does; `..` never appears (`safeRelPath`).
fn normalize(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn utf8(bytes: &[u8]) -> Result<String, PlanDelegate> {
    String::from_utf8(bytes.to_vec()).map_err(|_| PlanDelegate)
}

struct Planner<'a> {
    config: JsValue,
    options: &'a PlanOptions,
    working: String,
    entries: Vec<PlanEntry>,
    updates_available: Vec<UpdateAvailable>,
    downgrades: Vec<UpdateAvailable>,
}

impl Planner<'_> {
    fn interpolate(&self, raw: &str) -> String {
        interpolate(raw, &self.config, &InterpolateOptions::default())
    }

    fn remove(&mut self, id: &str) -> bool {
        let before = std::mem::take(&mut self.working);
        self.working = remove_managed_section(&before, id, CommentStyle::Html);
        before != self.working
    }

    fn removal_entry(&mut self, asset: PlanAsset, source: &str) {
        let changed = self.remove(asset.id());
        let status = if changed {
            AssetStatus::RemovedConditionFalse
        } else {
            AssetStatus::Inject(InjectStatus::Unchanged)
        };
        self.push(asset, source, status, None, None);
    }

    fn push(
        &mut self,
        asset: PlanAsset,
        source: &str,
        status: AssetStatus,
        details: Option<InjectDetails>,
        new_content: Option<String>,
    ) {
        self.entries.push(PlanEntry {
            asset,
            source: source.to_owned(),
            status,
            details,
            new_content,
        });
    }

    /// `injectManagedSection` + `classifyVersionDrift` + the entry.
    fn inject(
        &mut self,
        asset: PlanAsset,
        entry_source: &str,
        marker_source: &str,
        content: String,
    ) {
        let id = asset.id().to_owned();
        let meta = MarkerMeta {
            source: Some(marker_source.to_owned()),
            version: Some(STAMP_VERSION.to_owned()),
            ..MarkerMeta::default()
        };
        let options = InjectOptions {
            force_overwrite: self.options.force_ids.contains(&id),
            ambient_floor: self.options.ambient_floor.as_deref(),
            ..InjectOptions::default()
        };
        let InjectResult {
            output,
            status,
            details,
        } = inject_managed_section(&self.working, &id, &content, &meta, options);
        self.classify_drift(&details, &id, marker_source);
        self.working = output;
        self.push(
            asset,
            entry_source,
            AssetStatus::Inject(status),
            Some(details),
            Some(content),
        );
    }

    /// `classifyVersionDrift`.
    fn classify_drift(&mut self, details: &InjectDetails, id: &str, source: &str) {
        classify_version_drift(
            details,
            id,
            source,
            &mut self.updates_available,
            &mut self.downgrades,
        );
    }

    /// A retired block, removed only when pristine (`removeManagedSectionGuarded`).
    fn guarded_removal(&mut self, block: &str, plugin: &str, report_unchanged: bool) {
        let asset = PlanAsset::Retired {
            id: block.to_owned(),
            rel_path: format!("@navori/plugin-{plugin}"),
        };
        match remove_managed_section_guarded(
            &self.working,
            block,
            CommentStyle::Html,
            STAMP_VERSION,
        ) {
            Err(kept) => {
                let status = match kept {
                    Kept::Newer => AssetStatus::Inject(InjectStatus::DowngradeSkipped),
                    Kept::Modified => AssetStatus::RetiredKept,
                };
                self.push(asset, plugin, status, None, None);
            }
            Ok(content) => {
                let changed = content != self.working;
                self.working = content;
                if changed {
                    self.push(
                        asset,
                        plugin,
                        AssetStatus::RemovedConditionFalse,
                        None,
                        None,
                    );
                } else if report_unchanged {
                    self.push(
                        asset,
                        plugin,
                        AssetStatus::Inject(InjectStatus::Unchanged),
                        None,
                        None,
                    );
                }
            }
        }
    }

    fn core(&mut self, language_fallbacks: &mut Vec<String>) -> Result<(), PlanDelegate> {
        let exclude: BTreeSet<String> =
            match get(&self.config, "blocks").and_then(|b| get(b, "exclude")) {
                Some(JsValue::Array(ids)) => ids
                    .iter()
                    .filter_map(|id| text(Some(id)))
                    .filter(|id| EXCLUDABLE_BLOCK_IDS.contains(&id.as_str()))
                    .collect(),
                _ => BTreeSet::new(),
            };
        let language = text(get(&self.config, "language")).unwrap_or_else(|| "es".to_owned());
        let engine = self
            .options
            .engine
            .clone()
            .unwrap_or_else(|| "claude".to_owned());
        for asset in CORE_MANAGED_ASSETS.iter() {
            if self.options.skip_ids.contains(asset.id) {
                continue;
            }
            let gated_off = exclude.contains(asset.id)
                || (self.options.omit_root_only && asset.root_only)
                || asset
                    .condition
                    .is_some_and(|condition| !resolve_condition(&self.config, condition));
            if gated_off {
                self.removal_entry(PlanAsset::Core(*asset), "core");
                continue;
            }
            let (path, fallback) = resolve_asset_path(asset, &language);
            if fallback {
                language_fallbacks.push(asset.id.to_owned());
            }
            let raw = utf8(assets::core(&path).ok_or(PlanDelegate)?)?;
            let conditioned =
                condition_orchestration(&raw, &self.config, &engine).map_err(|_| PlanDelegate)?;
            let content = self.interpolate(&conditioned);
            if asset.audience == Audience::Orchestrator {
                let changed = self.remove(asset.id);
                let status = if changed {
                    InjectStatus::Updated
                } else {
                    InjectStatus::Unchanged
                };
                self.push(
                    PlanAsset::Core(*asset),
                    "core",
                    AssetStatus::Inject(status),
                    None,
                    Some(content),
                );
                continue;
            }
            self.inject(PlanAsset::Core(*asset), "core", CORE_SOURCE_ID, content);
        }
        Ok(())
    }

    fn preset(
        &mut self,
        repo_root: &Path,
        missing: &mut Vec<(String, String)>,
    ) -> Result<(), PlanDelegate> {
        let Some(preset) = text(get(&self.config, "preset")) else {
            return Ok(());
        };
        if preset.is_empty() || preset == "custom" {
            return Ok(());
        }
        let Some(loaded) = load_preset(&preset, repo_root).map_err(|_| PlanDelegate)? else {
            missing.push((
                preset.clone(),
                format!("preset '{preset}' not found (no .navori/presets/{preset}/ nor bundled)"),
            ));
            return Ok(());
        };
        let preset_id = text(get(&loaded.def, "id")).ok_or(PlanDelegate)?;
        let extras = match get(&loaded.def, "extras").and_then(|e| get(e, "managed")) {
            Some(JsValue::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        for extra in &extras {
            let id = text(get(extra, "id")).ok_or(PlanDelegate)?;
            if self.options.skip_ids.contains(&id) {
                continue;
            }
            let rel_path = text(get(extra, "relPath")).ok_or(PlanDelegate)?;
            let raw = match &loaded.asset_root {
                AssetRoot::Local(dir) => {
                    utf8(&std::fs::read(dir.join(normalize(&rel_path))).map_err(|_| PlanDelegate)?)?
                }
                AssetRoot::Bundled => utf8(
                    assets::core(&format!("core-assets/{}", normalize(&rel_path)))
                        .ok_or(PlanDelegate)?,
                )?,
            };
            let content = self.interpolate(&raw);
            self.inject(
                PlanAsset::Preset { id, rel_path },
                &preset_id,
                CORE_SOURCE_ID,
                content,
            );
        }
        Ok(())
    }

    fn plugins(&mut self, missing: &mut Vec<(String, String)>) -> Result<(), PlanDelegate> {
        let declared = match get(&self.config, "plugins") {
            None | Some(JsValue::Undefined | JsValue::Null) => Vec::new(),
            Some(JsValue::Object(object)) => object
                .ordered()
                .into_iter()
                .map(|(key, value)| Ok((key.to_rust().ok_or(PlanDelegate)?, value.clone())))
                .collect::<Result<Vec<_>, PlanDelegate>>()?,
            Some(_) => return Err(PlanDelegate),
        };
        for (declared_id, settings) in declared {
            let plugin = match load_plugin(&declared_id) {
                Ok(plugin) => plugin,
                Err(PluginLoadError::Delegate) => return Err(PlanDelegate),
                Err(PluginLoadError::NotFound) => {
                    if let Some(retired) = retired_plugin(&declared_id) {
                        for block in retired.block_ids {
                            if !self.options.skip_ids.contains(*block) {
                                self.guarded_removal(block, &declared_id, true);
                            }
                        }
                    } else {
                        missing.push((declared_id, "unknown plugin id".to_owned()));
                    }
                    continue;
                }
            };
            if let Some((_, _, blocks)) = RETIRED_PLUGIN_BLOCKS
                .iter()
                .find(|(id, _, _)| *id == declared_id)
            {
                for block in *blocks {
                    if !self.options.skip_ids.contains(*block) {
                        self.guarded_removal(block, &declared_id, false);
                    }
                }
            }
            let enabled = match &settings {
                JsValue::Object(object) => object.get("enabled") == Some(&JsValue::Bool(true)),
                JsValue::Undefined | JsValue::Null => return Err(PlanDelegate),
                _ => false,
            };
            let manifest_id = plugin.manifest_id();
            for entry in &plugin.managed_assets {
                if self.options.skip_ids.contains(&entry.id) {
                    continue;
                }
                let asset = PlanAsset::Plugin {
                    id: entry.id.clone(),
                    dir: plugin.dir.clone(),
                    path: entry.path.clone(),
                };
                if enabled {
                    let raw = utf8(assets::plugin(&plugin.dir, &entry.path).ok_or(PlanDelegate)?)?;
                    let content = self.interpolate(&raw);
                    let source = format!("@navori/plugin-{manifest_id}");
                    self.inject(asset, &manifest_id, &source, content);
                } else {
                    self.removal_entry(asset, &manifest_id);
                }
            }
        }
        Ok(())
    }
}

/// `computeRenderPlan`.
///
/// # Errors
/// [`PlanDelegate`] wherever the TS throws or reports a message Rust does not reproduce.
pub fn compute_render_plan(
    existing: &str,
    input_config: &JsValue,
    repo_root: &Path,
    options: &PlanOptions,
) -> Result<RenderPlan, PlanDelegate> {
    let mut planner = Planner {
        config: effective_config(input_config),
        options,
        working: existing.to_owned(),
        entries: Vec::new(),
        updates_available: Vec::new(),
        downgrades: Vec::new(),
    };
    let mut language_fallbacks = Vec::new();
    let mut missing = Vec::new();
    planner.core(&mut language_fallbacks)?;
    planner.preset(repo_root, &mut missing)?;
    planner.plugins(&mut missing)?;
    Ok(RenderPlan {
        existing: existing.to_owned(),
        next: planner.working,
        entries: planner.entries,
        missing_plugins: missing,
        language_fallbacks,
        updates_available: planner.updates_available,
        downgrades: planner.downgrades,
    })
}

/// `canonicalManagedOrder`: emission order of the blocks present, planned against an empty file,
/// then the engine's computed block ids.
///
/// # Errors
/// As [`compute_render_plan`].
pub fn canonical_managed_order(
    config: &JsValue,
    repo_root: &Path,
    omit_root_only: bool,
    computed_block_ids: &[&str],
) -> Result<Vec<String>, PlanDelegate> {
    let options = PlanOptions {
        omit_root_only,
        ..PlanOptions::default()
    };
    let plan = compute_render_plan("", config, repo_root, &options)?;
    Ok(plan
        .entries
        .iter()
        .filter(|entry| entry.new_content.is_some())
        .map(|entry| entry.asset.id().to_owned())
        .chain(computed_block_ids.iter().map(|id| (*id).to_owned()))
        .collect())
}
