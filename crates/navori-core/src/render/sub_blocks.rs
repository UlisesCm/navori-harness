//! Steps 8 to 8.4 and the sub-block halves of 8.5 and 8.5-ter of `prepareClaudeEngine` (spec
//! 0058 T14): sub-blocks that plugins (and the Codex engine) add to files other steps own, and
//! their removal once the plugin is disabled or the block retired. `applySubBlockInject`,
//! `removeSubBlock` and `applyCodexCrossReview` (`engines/claude/index.ts`) and
//! `applyHookExtension`/`removeHookExtension` (`engines/shared/hook-extension.ts`), over the
//! pending writes collected so far. Script removals (8.5, 8.5-bis) belong to the retirements.

use crate::STAMP_VERSION;
use crate::i18n;
use crate::js_json::JsValue;
use crate::markers::{
    CommentStyle, InjectOptions, InjectResult, InjectStatus, Kept, MarkerMeta,
    inject_managed_section, remove_managed_section, remove_managed_section_guarded,
};
use crate::render::agent_mcp_tools::{with_agent_mcp_tools, without_agent_mcp_tools};
use crate::render::assets;
use crate::render::block_plan::{UpdateAvailable, classify_version_drift};
use crate::render::collect::{PendingWrite, RepoView, SkippedFile, read_if_exists};
use crate::render::context::Lang;
use crate::render::frontmatter::strip_frontmatter;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::plugins::{
    LoadedPlugin, PluginHookExtension, PluginSkill, RETIRED_PLUGIN_SUB_BLOCKS,
};

/// The TS would throw (an unreadable target or asset), or Rust does not model the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubBlocksDelegate;

/// `CODEX_CROSS_REVIEW_ID`.
pub const CODEX_CROSS_REVIEW_ID: &str = "codex-cross-review";

/// Where the Codex cross-review advisory lands.
const ORCHESTRATOR: &str = ".claude/agents/orchestrator.md";

/// What these steps report besides the pending writes they edit in place.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SubBlocks {
    /// Targets kept.
    pub skipped: Vec<SkippedFile>,
    /// `pluginSkillNotInjected` notes (step 8).
    pub warnings: Vec<String>,
    /// Retired blocks kept (step 8.5-ter), which the TS reports after the disabled scripts.
    pub retired_warnings: Vec<String>,
    /// Sub-blocks whose version on disk is older.
    pub updates_available: Vec<UpdateAvailable>,
    /// Sub-blocks written by a newer navori.
    pub downgrades: Vec<UpdateAvailable>,
}

/// What a target holds before the sub-block lands.
enum Current {
    /// `pending[index]`, the first write queued for it.
    Pending(usize),
    /// The file on disk.
    Disk(String),
    /// Neither.
    Absent,
}

impl Current {
    fn content<'a>(&'a self, pending: &'a [PendingWrite]) -> Option<&'a str> {
        match self {
            Self::Pending(index) => pending.get(*index).map(|w| w.content.as_str()),
            Self::Disk(text) => Some(text),
            Self::Absent => None,
        }
    }
}

/// `OwnedPathInventory.observe` rejects anything but an exact relative path (`retainOverlay`
/// observes every target before these steps).
fn check_target(rel: &str) -> Result<(), SubBlocksDelegate> {
    let invalid = rel.is_empty()
        || rel.contains(['\r', '\n', '\\', '\0'])
        || rel.starts_with('/')
        || rel
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..");
    if invalid {
        Err(SubBlocksDelegate)
    } else {
        Ok(())
    }
}

/// `pending.find(p => p.path === target)`, then `existsSync ? readFileSync : absent`.
fn current(
    view: &dyn RepoView,
    pending: &[PendingWrite],
    rel: &str,
) -> Result<Current, SubBlocksDelegate> {
    if let Some(index) = pending.iter().position(|w| w.rel_path == rel) {
        return Ok(Current::Pending(index));
    }
    Ok(read_if_exists(view, rel)
        .map_err(|_| SubBlocksDelegate)?
        .map_or(Current::Absent, Current::Disk))
}

/// Replaces the pending write or queues a new one.
fn store(
    pending: &mut Vec<PendingWrite>,
    at: &Current,
    rel: &str,
    content: String,
    status: InjectStatus,
    chmod_exec: bool,
) {
    if let Current::Pending(index) = at
        && let Some(write) = pending.get_mut(*index)
    {
        write.content = content;
        return;
    }
    pending.push(PendingWrite {
        rel_path: rel.to_owned(),
        content,
        status,
        chmod_exec,
    });
}

fn inject(
    existing: &str,
    id: &str,
    body: &str,
    source: &str,
    shell: bool,
    ambient_floor: Option<&str>,
) -> InjectResult {
    let meta = MarkerMeta {
        source: Some(source.to_owned()),
        version: Some(STAMP_VERSION.to_owned()),
        fm_keys: None,
        floor_version: None,
    };
    inject_managed_section(
        existing,
        id,
        body,
        &meta,
        InjectOptions {
            shell,
            ambient_floor,
            ..InjectOptions::default()
        },
    )
}

fn plugin_text(plugin: &LoadedPlugin, path: &str) -> Result<&'static str, SubBlocksDelegate> {
    assets::plugin(&plugin.dir, path)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .ok_or(SubBlocksDelegate)
}

/// Shared tail of the two plugin sub-block kinds: a kept block is a skip.
fn skip_kept(
    result: &InjectResult,
    rel: &str,
    id: &str,
    plugin_id: &str,
    lang: Lang,
    out: &mut SubBlocks,
) -> bool {
    let reason = match result.status {
        InjectStatus::UserModifiedSkipped => i18n::sub_block_edited_by_hand(lang, id, plugin_id),
        InjectStatus::DowngradeSkipped => {
            i18n::sub_block_from_newer_navori(lang, id, result.details.existing_version.as_deref())
        }
        _ => return false,
    };
    out.skipped.push(SkippedFile {
        rel_path: rel.to_owned(),
        reason,
        status: result.status,
        resolution: None,
        markerless_resolution: None,
    });
    true
}

/// Everything a step reads besides its own unit.
pub struct SubBlockCtx<'a> {
    /// The repo.
    pub view: &'a dyn RepoView,
    /// Effective config.
    pub config: &'a JsValue,
    /// Message language.
    pub lang: Lang,
    /// The run-wide anti-rollback floor.
    pub ambient_floor: Option<&'a str>,
}

/// Step 8 for one `injectInto` skill (`applySubBlockInject`, full harness scope).
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws or the path is not modeled.
pub fn apply_sub_block_inject(
    ctx: &SubBlockCtx<'_>,
    plugin: &LoadedPlugin,
    skill: &PluginSkill,
    pending: &mut Vec<PendingWrite>,
    out: &mut SubBlocks,
) -> Result<(), SubBlocksDelegate> {
    let Some(target) = skill.inject_into.as_deref() else {
        return Ok(());
    };
    check_target(target)?;
    let plugin_id = plugin.manifest_id();
    let at = current(ctx.view, pending, target)?;
    let Some(existing) = at.content(pending) else {
        out.warnings.push(i18n::plugin_skill_not_injected(
            ctx.lang, &skill.id, &plugin_id, target,
        ));
        return Ok(());
    };
    let body = interpolate(
        strip_frontmatter(plugin_text(plugin, &skill.path)?),
        ctx.config,
        &InterpolateOptions::default(),
    );
    let source = format!("@navori/plugin-{plugin_id}");
    let result = inject(
        existing,
        &skill.id,
        &body,
        &source,
        false,
        ctx.ambient_floor,
    );
    let final_content =
        with_agent_mcp_tools(&result.output, plugin, target, skill.mcp_tools.as_deref())
            .ok_or(SubBlocksDelegate)?;
    classify_version_drift(
        &result.details,
        &skill.id,
        &source,
        &mut out.updates_available,
        &mut out.downgrades,
    );
    if skip_kept(&result, target, &skill.id, &plugin_id, ctx.lang, out) {
        return Ok(());
    }
    let status = if result.status == InjectStatus::Unchanged {
        // The prose is current, but the `tools:` grant may still be missing.
        if final_content == existing {
            return Ok(());
        }
        InjectStatus::Updated
    } else {
        result.status
    };
    store(pending, &at, target, final_content, status, false);
    Ok(())
}

/// Step 8.3 for one hook extension (`applyHookExtension` with the Claude target).
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws or the path is not modeled.
pub fn apply_hook_extension(
    ctx: &SubBlockCtx<'_>,
    plugin: &LoadedPlugin,
    extension: &PluginHookExtension,
    pending: &mut Vec<PendingWrite>,
    out: &mut SubBlocks,
) -> Result<(), SubBlocksDelegate> {
    let target = extension.target.as_str();
    check_target(target)?;
    let at = current(ctx.view, pending, target)?;
    let Some(existing) = at.content(pending) else {
        return Ok(());
    };
    let plugin_id = plugin.manifest_id();
    let source = format!("@navori/plugin-{plugin_id}");
    let body = plugin_text(plugin, &extension.path)?;
    let result = inject(
        existing,
        &extension.id,
        body,
        &source,
        true,
        ctx.ambient_floor,
    );
    classify_version_drift(
        &result.details,
        &extension.id,
        &source,
        &mut out.updates_available,
        &mut out.downgrades,
    );
    if skip_kept(&result, target, &extension.id, &plugin_id, ctx.lang, out) {
        return Ok(());
    }
    if result.output == existing {
        return Ok(());
    }
    let status = if result.status == InjectStatus::Unchanged {
        InjectStatus::Updated
    } else {
        result.status
    };
    store(pending, &at, target, result.output, status, true);
    Ok(())
}

fn renders_codex(config: &JsValue) -> bool {
    let JsValue::Object(object) = config else {
        return false;
    };
    match object.get("engines") {
        Some(JsValue::Array(engines)) => engines
            .iter()
            .any(|engine| matches!(engine, JsValue::String(s) if s.to_rust().as_deref() == Some("codex"))),
        _ => false,
    }
}

/// Step 8.4 (`applyCodexCrossReview`): the advisory in `orchestrator.md` exists exactly when
/// the repo also renders Codex.
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws.
pub fn apply_codex_cross_review(
    ctx: &SubBlockCtx<'_>,
    pending: &mut Vec<PendingWrite>,
) -> Result<(), SubBlocksDelegate> {
    let at = current(ctx.view, pending, ORCHESTRATOR)?;
    let Some(existing) = at.content(pending) else {
        return Ok(());
    };
    let next = if renders_codex(ctx.config) {
        let raw = assets::core("core-assets/managed/codex-cross-review.md")
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or(SubBlocksDelegate)?;
        let body = interpolate(raw, ctx.config, &InterpolateOptions::default());
        inject(
            existing,
            CODEX_CROSS_REVIEW_ID,
            &body,
            CORE_SOURCE_ID,
            false,
            ctx.ambient_floor,
        )
        .output
    } else {
        remove_managed_section(existing, CODEX_CROSS_REVIEW_ID, CommentStyle::Html)
    };
    if next == existing {
        return Ok(());
    }
    store(
        pending,
        &at,
        ORCHESTRATOR,
        next,
        InjectStatus::Updated,
        false,
    );
    Ok(())
}

/// A disabled plugin's sub-block stripped from its target (`removeSubBlock`), with its
/// `tools:` grant.
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws or the path is not modeled.
pub fn remove_sub_block(
    ctx: &SubBlockCtx<'_>,
    plugin: &LoadedPlugin,
    skill: &PluginSkill,
    pending: &mut Vec<PendingWrite>,
) -> Result<(), SubBlocksDelegate> {
    let Some(target) = skill.inject_into.as_deref() else {
        return Ok(());
    };
    check_target(target)?;
    let at = current(ctx.view, pending, target)?;
    let Some(existing) = at.content(pending) else {
        return Ok(());
    };
    let stripped = without_agent_mcp_tools(
        &remove_managed_section(existing, &skill.id, CommentStyle::Html),
        plugin,
        target,
        skill.mcp_tools.as_deref(),
    )
    .ok_or(SubBlocksDelegate)?;
    if stripped == existing {
        return Ok(());
    }
    store(pending, &at, target, stripped, InjectStatus::Updated, false);
    Ok(())
}

/// A disabled plugin's hook extension stripped from its hook (`removeHookExtension`).
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws or the path is not modeled.
pub fn remove_hook_extension(
    ctx: &SubBlockCtx<'_>,
    extension: &PluginHookExtension,
    pending: &mut Vec<PendingWrite>,
) -> Result<(), SubBlocksDelegate> {
    let target = extension.target.as_str();
    check_target(target)?;
    let at = current(ctx.view, pending, target)?;
    let Some(existing) = at.content(pending) else {
        return Ok(());
    };
    let stripped = remove_managed_section(existing, &extension.id, CommentStyle::Shell);
    if stripped == existing {
        return Ok(());
    }
    store(pending, &at, target, stripped, InjectStatus::Updated, true);
    Ok(())
}

/// Step 8.5-ter: sub-blocks a live plugin's manifest no longer declares, stripped only when
/// pristine; the `tools:` grant is left alone, since an active sub-block may still need it.
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws.
pub fn strip_retired_sub_blocks(
    ctx: &SubBlockCtx<'_>,
    pending: &mut Vec<PendingWrite>,
    out: &mut SubBlocks,
) -> Result<(), SubBlocksDelegate> {
    for (_, _, entries) in RETIRED_PLUGIN_SUB_BLOCKS {
        for (id, target) in *entries {
            let at = current(ctx.view, pending, target)?;
            let Some(existing) = at.content(pending) else {
                continue;
            };
            let stripped = match remove_managed_section_guarded(
                existing,
                id,
                CommentStyle::Html,
                STAMP_VERSION,
            ) {
                Ok(stripped) => stripped,
                Err(kept) => {
                    let why = match kept {
                        Kept::Newer => "from a newer navori",
                        Kept::Modified => "edited by hand",
                    };
                    out.retired_warnings.push(format!(
                        "kept {target} \u{2014} retired block {id} is {why}"
                    ));
                    continue;
                }
            };
            if stripped == existing {
                continue;
            }
            store(pending, &at, target, stripped, InjectStatus::Updated, false);
        }
    }
    Ok(())
}

/// The sub-block steps in the TS order: 8, 8.3 and 8.4 over `enabled`, the sub-block half of
/// 8.5 over `disabled`, then 8.5-ter, editing `pending` in place.
///
/// # Errors
/// [`SubBlocksDelegate`] where the TS throws or the paths are not modeled.
pub fn apply_sub_blocks(
    ctx: &SubBlockCtx<'_>,
    enabled: &[LoadedPlugin],
    disabled: &[LoadedPlugin],
    pending: &mut Vec<PendingWrite>,
) -> Result<SubBlocks, SubBlocksDelegate> {
    let mut out = SubBlocks::default();
    for plugin in enabled {
        for skill in plugin
            .skill_assets
            .iter()
            .filter(|s| s.inject_into.is_some())
        {
            apply_sub_block_inject(ctx, plugin, skill, pending, &mut out)?;
        }
    }
    for plugin in enabled {
        for extension in &plugin.hook_extension_assets {
            apply_hook_extension(ctx, plugin, extension, pending, &mut out)?;
        }
    }
    apply_codex_cross_review(ctx, pending)?;
    for plugin in disabled {
        for skill in plugin
            .skill_assets
            .iter()
            .filter(|s| s.inject_into.is_some())
        {
            remove_sub_block(ctx, plugin, skill, pending)?;
        }
        for extension in &plugin.hook_extension_assets {
            remove_hook_extension(ctx, extension, pending)?;
        }
    }
    strip_retired_sub_blocks(ctx, pending, &mut out)?;
    Ok(out)
}
