//! Steps 3–6.6 of `prepareClaudeEngine` (spec 0058 T14): the harness inventory placed by the
//! Claude adapter (`engines/claude/adapter.ts`) and collected through the shared spine
//! (`collectPlan` of `execute-plan.ts`): agents, skills and hooks under `.claude/`.
//!
//! `guard-destructive` embeds the sealed inventory of every path the render owns
//! (`withOwnedGuard`), which only the whole engine knows; the caller passes it, and without it
//! the hook is left out of this step.

use std::collections::BTreeMap;

use crate::STAMP_VERSION;
use crate::js_json::JsValue;
use crate::markers::CommentStyle;
use crate::render::assets;
use crate::render::collect::{PendingWrite, RepoView, SkippedFile, collect_managed};
use crate::render::context::Lang;
use crate::render::harness_plan::{AssetRef, HarnessPlan};
use crate::render::managed_file::RenderManagedFileInput;
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::presets::AssetRoot;

/// The TS would throw (an unreadable asset, a missing include, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HarnessDelegate;

/// `OVERLAP_ROWS` units native on Claude (`kind:id`): none today, so `filterInventory` keeps
/// every unit. `harness_files_parity` fails when the TS matrix gains one.
pub const CLAUDE_NATIVE_UNITS: [&str; 0] = [];

/// `filterInventory(…, "claude")`.
#[must_use]
pub fn filter_inventory(plan: HarnessPlan) -> HarnessPlan {
    let native =
        |kind: &str, id: &str| CLAUDE_NATIVE_UNITS.contains(&format!("{kind}:{id}").as_str());
    HarnessPlan {
        agents: plan
            .agents
            .into_iter()
            .filter(|a| !native("agent", &a.id))
            .collect(),
        skills: plan
            .skills
            .into_iter()
            .filter(|s| !native("skill", &s.id))
            .collect(),
        hooks: plan
            .hooks
            .into_iter()
            .filter(|h| !native("hook", &h.id))
            .collect(),
    }
}

/// `claudeSkillDest`.
#[must_use]
pub fn claude_skill_dest(id: &str) -> String {
    format!(".claude/skills/{id}/SKILL.md")
}

/// A placement of the Claude adapter (`PlacementRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// Source asset.
    pub asset: AssetRef,
    /// Destination, relative to the repo root.
    pub dest: String,
    /// Managed-block id.
    pub managed_id: String,
    /// Shell markers for hooks, html otherwise.
    pub style: CommentStyle,
    /// `chmodExec`.
    pub chmod_exec: bool,
}

/// `createClaudeAdapter()` over a plan: agents, then skills, then hooks.
#[must_use]
pub fn claude_placements(plan: &HarnessPlan) -> Vec<Placement> {
    let html = |asset: &AssetRef, dest: String, managed_id: &str| Placement {
        asset: asset.clone(),
        dest,
        managed_id: managed_id.to_owned(),
        style: CommentStyle::Html,
        chmod_exec: false,
    };
    plan.agents
        .iter()
        .map(|a| {
            html(
                &a.asset,
                format!(".claude/agents/{}.md", a.id),
                &a.managed_id,
            )
        })
        .chain(
            plan.skills
                .iter()
                .map(|s| html(&s.asset, claude_skill_dest(&s.id), &s.managed_id)),
        )
        .chain(plan.hooks.iter().map(|h| Placement {
            asset: h.asset.clone(),
            dest: format!(".claude/hooks/{}.sh", h.id),
            managed_id: h.managed_id.clone(),
            style: CommentStyle::Shell,
            chmod_exec: true,
        }))
        .collect()
}

/// The asset text a placement renders from.
///
/// # Errors
/// [`HarnessDelegate`] when it is missing or not UTF-8.
pub fn asset_text(asset: &AssetRef) -> Result<String, HarnessDelegate> {
    let bytes = match &asset.root {
        AssetRoot::Bundled => assets::core(&format!("core-assets/{}", asset.rel))
            .ok_or(HarnessDelegate)?
            .to_vec(),
        AssetRoot::Local(dir) => {
            std::fs::read(dir.join(&asset.rel)).map_err(|_| HarnessDelegate)?
        }
    };
    String::from_utf8(bytes).map_err(|_| HarnessDelegate)
}

/// What the shared spine adds for the harness inventory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HarnessFiles {
    /// Files to write, in placement order.
    pub pending: Vec<PendingWrite>,
    /// Files kept.
    pub skipped: Vec<SkippedFile>,
    /// `(relPath, overwrittenKeys)` of markerless destinations adopted by name.
    pub collisions: Vec<(String, Vec<String>)>,
}

/// Collects every placement of `plan` (`collectPlan` with `prune: false`).
///
/// # Errors
/// [`HarnessDelegate`] where the TS throws.
pub fn collect_harness_files(
    view: &dyn RepoView,
    plan: &HarnessPlan,
    config: &JsValue,
    lang: Lang,
    ambient_floor: Option<&str>,
    owned_paths: Option<&str>,
) -> Result<HarnessFiles, HarnessDelegate> {
    let mut files = HarnessFiles::default();
    for placement in claude_placements(plan) {
        let is_guard = placement.dest == ".claude/hooks/guard-destructive.sh";
        let extra_vars = match (is_guard, owned_paths) {
            (true, None) => continue,
            (true, Some(paths)) => {
                BTreeMap::from([("navoriOwnedPaths".to_owned(), paths.to_owned())])
            }
            (false, _) => BTreeMap::new(),
        };
        let text = asset_text(&placement.asset)?;
        let existing = view.read(&placement.dest);
        let input = RenderManagedFileInput {
            asset: &text,
            style: placement.style,
            existing: existing.as_deref(),
            managed_id: &placement.managed_id,
            source: CORE_SOURCE_ID,
            version: STAMP_VERSION,
            config,
            extra_vars,
            transform: None,
            engine: Some("claude"),
            force_overwrite: false,
            ambient_floor,
        };
        let collected = collect_managed(view, &placement.dest, &input, placement.chmod_exec, lang)
            .map_err(|_| HarnessDelegate)?;
        files.pending.extend(collected.write);
        files.skipped.extend(collected.skip);
        if let Some(keys) = collected.collision {
            files.collisions.push((placement.dest, keys));
        }
    }
    Ok(files)
}
