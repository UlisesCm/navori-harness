//! The owned-path inventory of a Claude render (spec 0058 T14): `OwnedPathInventory`
//! (`engines/shared/owned-path-inventory.ts`) and the `observeDestination` calls
//! `prepareClaudeEngine` makes before rendering. Its sealed value is what `guard-destructive`
//! embeds as `navoriOwnedPaths`.
//!
//! Only the full harness scope is modeled; `accept` and `exclude` belong to `sync` and Pi.

use std::collections::BTreeMap;

use crate::js_json::{self, JsValue};
use crate::render::collect::RepoView;
use crate::render::harness_files::claude_placements;
use crate::render::harness_plan::{HarnessPlan, PresetHook};
use crate::render::plugin_scripts::{ScriptEngine, plugin_script_placements};
use crate::render::plugins::{LoadedPlugin, RETIRED_PLUGIN_SUB_BLOCKS};
use crate::render::removable::{Authorship, navori_authorship};
use crate::render::sub_blocks::CODEX_CROSS_REVIEW_ID;

/// `observe` throws on a path that is not an exact relative path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnedPathsDelegate;

/// How a destination's bytes are judged when it is a regular file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classify {
    /// `navoriAuthorship(path, managedId, { verifyHash: true })`.
    Marker,
    /// `settings.json`: any `$navori` object makes it ours.
    Settings,
    /// `.mcp.json`: a JSON object carrying the `$navori` key.
    Mcp,
}

/// `OwnedPathInventory` with `observeDestination`.
#[derive(Debug, Default)]
pub struct OwnedPaths {
    /// Path → whether some block of it is not `foreign`.
    observed: BTreeMap<String, bool>,
}

fn invalid(path: &str) -> bool {
    let drive = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    path.is_empty()
        || path == "-"
        || path.contains(['\r', '\n', '\\', '\0'])
        || path.starts_with('/')
        || drive
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn classify_json(body: &str, how: Classify) -> Authorship {
    let Some(JsValue::Object(object)) = js_json::parse(body) else {
        return Authorship::Foreign;
    };
    let ours = match how {
        Classify::Settings => matches!(object.get("$navori"), Some(JsValue::Object(_))),
        Classify::Mcp | Classify::Marker => object.has("$navori"),
    };
    if ours {
        Authorship::Ours
    } else {
        Authorship::Foreign
    }
}

impl OwnedPaths {
    /// `observeDestination(inventory, cwd, rel, managedId, classify)`.
    ///
    /// # Errors
    /// [`OwnedPathsDelegate`] where `observe` throws.
    pub fn observe(
        &mut self,
        view: &dyn RepoView,
        rel: &str,
        managed_id: &str,
        how: Classify,
    ) -> Result<(), OwnedPathsDelegate> {
        if invalid(rel) {
            return Err(OwnedPathsDelegate);
        }
        let authorship = if !view.lexists(rel) {
            None // `missing`
        } else {
            match view.read_regular(rel) {
                None => Some(Authorship::Foreign),
                // `verifyHash` only tells `ours` from `modified`; the seal keeps both.
                Some(body) => Some(match how {
                    Classify::Marker => navori_authorship(view, rel, Some(managed_id), false),
                    json => classify_json(&body, json),
                }),
            }
        };
        let owned = authorship != Some(Authorship::Foreign);
        let slot = self.observed.entry(rel.to_owned()).or_insert(false);
        *slot |= owned;
        Ok(())
    }

    /// `seal().value`: every path with a block that is not `foreign`, sorted, one per line, or
    /// `-` when there is none.
    #[must_use]
    pub fn seal(&self) -> String {
        let mut paths: Vec<&str> = self
            .observed
            .iter()
            .filter_map(|(path, owned)| owned.then_some(path.as_str()))
            .collect();
        // `Array.prototype.sort`: UTF-16 code units.
        paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        if paths.is_empty() {
            "-".to_owned()
        } else {
            paths.join("\n")
        }
    }
}

/// What a full Claude render observes, besides the repo.
pub struct ClaudeOwnedInput<'a> {
    /// `(relPath, managedId)` from step 1 (`ClaudeMdPlan::observed`).
    pub claude_md: &'a [(String, String)],
    /// The placed harness plan.
    pub plan: &'a HarnessPlan,
    /// The preset hooks this render writes.
    pub preset_hooks: &'a [PresetHook],
    /// Enabled plugins, in config order.
    pub enabled: &'a [LoadedPlugin],
    /// Disabled plugins, in config order.
    pub disabled: &'a [LoadedPlugin],
}

fn has_mcp_server(plugin: &LoadedPlugin) -> bool {
    matches!(
        &plugin.manifest,
        JsValue::Object(manifest)
            if !matches!(manifest.get("mcpServer"), None | Some(JsValue::Undefined | JsValue::Null))
    )
}

/// The sealed owned paths of a full Claude render, in the order `prepareClaudeEngine` observes.
///
/// # Errors
/// [`OwnedPathsDelegate`] where `observe` throws.
pub fn claude_owned_paths(
    view: &dyn RepoView,
    input: &ClaudeOwnedInput<'_>,
) -> Result<String, OwnedPathsDelegate> {
    let mut owned = OwnedPaths::default();
    for (rel, id) in input.claude_md {
        owned.observe(view, rel, id, Classify::Marker)?;
    }
    owned.observe(view, ".claude/settings.json", "", Classify::Settings)?;
    if input.enabled.iter().any(has_mcp_server) || view.exists(".mcp.json") {
        owned.observe(view, ".mcp.json", "", Classify::Mcp)?;
    }
    for placement in claude_placements(input.plan) {
        owned.observe(
            view,
            &placement.dest,
            &placement.managed_id,
            Classify::Marker,
        )?;
    }
    for hook in input.preset_hooks {
        owned.observe(view, &hook.dest, &hook.managed_id, Classify::Marker)?;
    }
    for plugin in input.enabled {
        for script in plugin_script_placements(plugin, ScriptEngine::Claude) {
            owned.observe(
                view,
                &script.dest_rel_path,
                &script.managed_id,
                Classify::Marker,
            )?;
        }
    }
    // `retainOverlay`: a sub-block target is observed when this render selects it or it exists.
    // A selected target that does not exist is already sealed as `missing`, so only existence
    // can change the result.
    let mut overlays: Vec<(String, String)> = Vec::new();
    for plugin in input.enabled.iter().chain(input.disabled) {
        for skill in &plugin.skill_assets {
            if let Some(target) = &skill.inject_into {
                overlays.push((target.clone(), skill.id.clone()));
            }
        }
        for extension in &plugin.hook_extension_assets {
            overlays.push((extension.target.clone(), extension.id.clone()));
        }
    }
    for (_, _, entries) in RETIRED_PLUGIN_SUB_BLOCKS {
        for (id, target) in *entries {
            overlays.push(((*target).to_owned(), (*id).to_owned()));
        }
    }
    overlays.push((
        ".claude/agents/orchestrator.md".to_owned(),
        CODEX_CROSS_REVIEW_ID.to_owned(),
    ));
    for (target, id) in &overlays {
        if view.lexists(target) {
            owned.observe(view, target, id, Classify::Marker)?;
        }
    }
    Ok(owned.seal())
}
