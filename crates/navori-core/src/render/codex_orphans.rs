//! The Codex orphan scans (`orphanScans` of `engines/codex/index.ts` run by `collectOrphans` of
//! `engines/shared/execute-plan.ts`, spec 0059 T19): agents, skill directories, skill policy
//! sidecars, hooks and scripts the render no longer plans, removed when navori wrote them
//! untouched and kept, with the reason, otherwise.
//!
//! Not modeled, and delegated: a retired plugin's script still under `.codex/scripts/`
//! (`retiredAssetKeepReason` needs the hook-source scan), local skills and workspace scopes.

use std::collections::BTreeMap;
use std::path::Path;

use crate::STAMP_VERSION;
use crate::js_json::JsValue;
use crate::markers::CommentStyle;
use crate::render::assets;
use crate::render::codex_agents::CodexDelegate;
use crate::render::codex_policies::{build_engram_policy_shell, build_role_policy_shell};
use crate::render::codex_skills::is_manual_only;
use crate::render::collect::RepoView;
use crate::render::harness_files::asset_text;
use crate::render::harness_plan::{AssetRef, HarnessPlan};
use crate::render::managed_file::{RenderManagedFileInput, render_managed_file};
use crate::render::native_hooks::strip_signature;
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::plugin_scripts::{ScriptEngine, plugin_script_placements};
use crate::render::plugins::{LoadedPlugin, retired_script_basenames};
use crate::render::presets::AssetRoot;
use crate::render::removable::{
    Authorship, Pristine, is_removable_navori_file, navori_authorship_pristine,
};
use crate::render::retirements::PendingRemoval;

/// `KeptOrphan`: a path a scan matched but did not remove, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptOrphan {
    /// Path relative to the repo root.
    pub rel_path: String,
    /// `newer`, `foreign` or `modified`.
    pub reason: Authorship,
}

/// What the scans found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexOrphans {
    /// Paths to delete, in scan order.
    pub removals: Vec<PendingRemoval>,
    /// Paths kept, in scan order.
    pub kept: Vec<KeptOrphan>,
}

/// What a directory entry is, as a `Dirent` reports it (symlinks are neither).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
    Other,
}

/// `readDirSafe`: entry names in `readdir` order (libuv sorts them bytewise), `[]` on error.
fn read_dir_safe(cwd: &Path, rel: &str) -> Vec<(String, Kind)> {
    let Ok(entries) = std::fs::read_dir(cwd.join(rel)) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Kind)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let kind = match entry.file_type() {
                Ok(t) if t.is_file() => Kind::File,
                Ok(t) if t.is_dir() => Kind::Dir,
                _ => Kind::Other,
            };
            Some((name, kind))
        })
        .collect();
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    out
}

/// `freshRender`: a placement rendered into an empty destination.
fn fresh_render(
    asset: &str,
    managed_id: &str,
    source: &str,
    config: &JsValue,
    extra_vars: BTreeMap<String, String>,
) -> Result<String, CodexDelegate> {
    let input = RenderManagedFileInput {
        asset,
        style: CommentStyle::Shell,
        existing: None,
        managed_id,
        source,
        version: STAMP_VERSION,
        config,
        extra_vars,
        transform: None,
        engine: Some("codex"),
        force_overwrite: false,
        ambient_floor: None,
    };
    render_managed_file(&input)
        .map(|rendered| rendered.content)
        .map_err(|_| CodexDelegate)
}

/// `hookRequest(hook).extraVars`: the policies `role-guard` and `engram-write-guard` compile.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws.
pub fn codex_hook_extra_vars(
    id: &str,
    config: &JsValue,
) -> Result<BTreeMap<String, String>, CodexDelegate> {
    Ok(match id {
        "role-guard" => {
            BTreeMap::from([("rolePolicy".to_owned(), build_role_policy_shell(config))])
        }
        "engram-write-guard" => BTreeMap::from([(
            "engramPolicy".to_owned(),
            build_engram_policy_shell().ok_or(CodexDelegate)?,
        )]),
        _ => BTreeMap::new(),
    })
}

/// Whether an asset exists (`existsSync(assetPath)`).
fn asset_exists(asset: &AssetRef) -> bool {
    match &asset.root {
        AssetRoot::Bundled => assets::core(&format!("core-assets/{}", asset.rel)).is_some(),
        AssetRoot::Local(dir) => dir.join(&asset.rel).exists(),
    }
}

/// The `expected` of the hooks scan: the hook's fresh render, from its plan entry or its core
/// asset, or `None` when no asset backs it.
fn hook_expected(
    rel: &str,
    plan: &HarnessPlan,
    config: &JsValue,
) -> Result<Option<String>, CodexDelegate> {
    // `rel.slice(".codex/hooks/".length, -".sh".length)`, in UTF-16 units.
    let name: Vec<u16> = rel[".codex/hooks/".len()..].encode_utf16().collect();
    let Some(id) = name
        .len()
        .checked_sub(3)
        .and_then(|end| String::from_utf16(&name[..end]).ok())
    else {
        return Ok(None);
    };
    let (asset, managed_id) = match plan.hooks.iter().find(|hook| hook.id == id) {
        Some(hook) => (hook.asset.clone(), hook.managed_id.clone()),
        None => (
            AssetRef {
                root: AssetRoot::Bundled,
                rel: format!("hooks/{id}.sh"),
            },
            format!("{id}-base"),
        ),
    };
    if !asset_exists(&asset) {
        return Ok(None);
    }
    let text = asset_text(&asset).map_err(|_| CodexDelegate)?;
    fresh_render(
        &text,
        &managed_id,
        CORE_SOURCE_ID,
        config,
        codex_hook_extra_vars(&id, config)?,
    )
    .map(Some)
}

/// The `expected` of the scripts scan: an enabled plugin's script, rendered fresh.
fn script_expected(
    rel: &str,
    plugins: &[LoadedPlugin],
    config: &JsValue,
) -> Result<Option<String>, CodexDelegate> {
    for plugin in plugins {
        for placement in plugin_script_placements(plugin, ScriptEngine::Codex) {
            if placement.dest_rel_path != rel {
                continue;
            }
            let text = assets::plugin(&placement.plugin_dir, &placement.script.src)
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .ok_or(CodexDelegate)?;
            return fresh_render(
                text,
                &placement.managed_id,
                &placement.source,
                config,
                BTreeMap::new(),
            )
            .map(Some);
        }
    }
    Ok(None)
}

/// The `file` shape: a hand-edited block or a copy carrying the user's text is kept.
fn scan_file(
    view: &dyn RepoView,
    rel: &str,
    expected: Option<&str>,
    normalize: Option<&dyn Fn(&str) -> String>,
    out: &mut CodexOrphans,
) {
    let pristine = expected.map(|expected| Pristine {
        expected,
        normalize,
    });
    match navori_authorship_pristine(view, rel, None, true, pristine.as_ref()) {
        Authorship::Ours => out.removals.push(PendingRemoval {
            rel_path: rel.to_owned(),
            recursive: false,
        }),
        reason => out.kept.push(KeptOrphan {
            rel_path: rel.to_owned(),
            reason,
        }),
    }
}

/// A removable file inside a skill directory: the directory goes when it is the only child.
fn remove_nested(cwd: &Path, dir: &str, file_rel: &str, file_name: &str, out: &mut CodexOrphans) {
    let children = read_dir_safe(cwd, dir);
    let only = children.len() == 1 && children[0].0 == file_name;
    out.removals.push(PendingRemoval {
        rel_path: if only {
            dir.to_owned()
        } else {
            file_rel.to_owned()
        },
        recursive: only,
    });
}

/// Every Codex orphan scan, in the adapter's order.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws or the scan is not modeled.
pub fn collect_codex_orphans(
    view: &dyn RepoView,
    cwd: &Path,
    plan: &HarnessPlan,
    installed: &[String],
    config: &JsValue,
    plugins: &[LoadedPlugin],
) -> Result<CodexOrphans, CodexDelegate> {
    let mut out = CodexOrphans::default();

    // Agents.
    let agents: Vec<String> = plan
        .agents
        .iter()
        .map(|a| format!(".codex/agents/{}.toml", a.id))
        .collect();
    for (name, kind) in read_dir_safe(cwd, ".codex/agents") {
        let rel = format!(".codex/agents/{name}");
        if kind != Kind::File || !name.ends_with(".toml") || agents.contains(&rel) {
            continue;
        }
        scan_file(view, &rel, None, None, &mut out);
    }

    // Skill directories (no unit to judge against outside a workspace: the marker test).
    let skills: Vec<String> = plan
        .skills
        .iter()
        .map(|s| format!(".agents/skills/{}/SKILL.md", s.id))
        .collect();
    for (name, kind) in read_dir_safe(cwd, ".agents/skills") {
        let dir = format!(".agents/skills/{name}");
        let rel = format!("{dir}/SKILL.md");
        if kind != Kind::Dir || skills.contains(&rel) || !view.exists(&rel) {
            continue;
        }
        if is_removable_navori_file(view, &rel, None) {
            remove_nested(cwd, &dir, &rel, "SKILL.md", &mut out);
        } else {
            let reason = navori_authorship_pristine(view, &rel, None, false, None);
            out.kept.push(KeptOrphan {
                rel_path: rel,
                reason,
            });
        }
    }

    // Skill policy sidecars.
    let mut manual: Vec<String> = Vec::new();
    for skill in &plan.skills {
        if is_manual_only(&asset_text(&skill.asset).map_err(|_| CodexDelegate)?) {
            manual.push(format!(".agents/skills/{}/agents/openai.yaml", skill.id));
        }
    }
    for (name, kind) in read_dir_safe(cwd, ".agents/skills") {
        let rel = format!(".agents/skills/{name}/agents/openai.yaml");
        if kind != Kind::Dir || manual.contains(&rel) || !view.exists(&rel) {
            continue;
        }
        if is_removable_navori_file(view, &rel, None) {
            remove_nested(
                cwd,
                &format!(".agents/skills/{name}/agents"),
                &rel,
                "openai.yaml",
                &mut out,
            );
        } else {
            let reason = navori_authorship_pristine(view, &rel, None, false, None);
            out.kept.push(KeptOrphan {
                rel_path: rel,
                reason,
            });
        }
    }

    // Hooks: judged against their fresh render, past navori's signature line.
    let normalize = |on_disk: &str| strip_signature(on_disk).to_owned();
    for (name, kind) in read_dir_safe(cwd, ".codex/hooks") {
        let rel = format!(".codex/hooks/{name}");
        if kind != Kind::File || installed.contains(&rel) {
            continue;
        }
        let expected = hook_expected(&rel, plan, config)?;
        scan_file(view, &rel, expected.as_deref(), Some(&normalize), &mut out);
    }

    // Scripts: a retired plugin's asset is the TS's to judge.
    let retired = retired_script_basenames();
    for (name, kind) in read_dir_safe(cwd, ".codex/scripts") {
        let rel = format!(".codex/scripts/{name}");
        if kind != Kind::File || !name.ends_with(".sh") || installed.contains(&rel) {
            continue;
        }
        if retired.contains(&name.as_str()) {
            return Err(CodexDelegate);
        }
        let expected = script_expected(&rel, plugins, config)?;
        scan_file(view, &rel, expected.as_deref(), None, &mut out);
    }
    Ok(out)
}
