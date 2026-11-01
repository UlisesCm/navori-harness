//! Codex skills (`placeSkill`, `codexSkillRequest`, the `agents/openai.yaml` requests of
//! `extraFiles` and the skill sub-block loops of `finalize` in `engines/codex/index.ts`, spec 0059
//! T19): each planned skill under `.agents/skills/<id>/SKILL.md` adapted to Codex, the policy
//! sidecar of a manual-only skill, and the plugin sub-blocks aimed at a skill.

use std::collections::BTreeMap;

use crate::STAMP_VERSION;
use crate::js_json::JsValue;
use crate::markers::{
    CommentStyle, InjectOptions, InjectStatus, Kept, MarkerMeta, inject_managed_section,
    remove_managed_section, remove_managed_section_guarded,
};
use crate::render::codex_agents::CodexDelegate;
use crate::render::codex_compat::adapt_harness_text_for_codex;
use crate::render::collect::{
    Collected, PendingWrite, RepoView, collect_body, collect_managed, read_if_exists,
};
use crate::render::context::Lang;
use crate::render::frontmatter::{
    get_frontmatter_field, remove_frontmatter_field, split_frontmatter, strip_frontmatter,
};
use crate::render::harness_files::asset_text;
use crate::render::harness_plan::PlannedUnit;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::managed_file::RenderManagedFileInput;
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::plugins::{LoadedPlugin, PluginSkill, RETIRED_PLUGIN_SUB_BLOCKS};

/// `OPENAI_MANUAL_ONLY_POLICY`: Codex's native `allow_implicit_invocation: false` (#823).
pub const OPENAI_MANUAL_ONLY_POLICY: &str = "policy:\n  allow_implicit_invocation: false\n";

/// `.agents/skills/<id>/SKILL.md`.
#[must_use]
pub fn codex_skill_dest(id: &str) -> String {
    format!(".agents/skills/{id}/SKILL.md")
}

/// `SKILL_INJECT_RE`: `/^\.claude\/skills\/([a-z0-9-]+)(?:\/SKILL)?\.md$/`, the target skill id.
#[must_use]
pub fn skill_inject_target(inject_into: &str) -> Option<&str> {
    let rest = inject_into.strip_prefix(".claude/skills/")?;
    let id = rest
        .strip_suffix("/SKILL.md")
        .or_else(|| rest.strip_suffix(".md"))?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    .then_some(id)
}

/// `isManualOnlySkill`: the skill's own frontmatter says `disable-model-invocation: true`.
#[must_use]
pub fn is_manual_only(raw: &str) -> bool {
    get_frontmatter_field(
        split_frontmatter(raw).frontmatter,
        "disable-model-invocation",
    )
    .is_some_and(|value| value == "true")
}

/// What the skill placements contribute.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexSkills {
    /// One entry per planned skill, in plan order.
    pub files: Vec<Collected>,
    /// `manualOnlySkillIds`, in plan order.
    pub manual_only: Vec<String>,
}

/// `placeSkill` over the planned skills: the asset rendered with the Codex transform.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws.
pub fn collect_codex_skills(
    view: &dyn RepoView,
    skills: &[PlannedUnit],
    config: &JsValue,
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<CodexSkills, CodexDelegate> {
    adapt_harness_text_for_codex("").ok_or(CodexDelegate)?;
    // `adaptHarnessTextForCodex`, then `disable-model-invocation` dropped (#823).
    let transform = |text: &str| {
        remove_frontmatter_field(
            &adapt_harness_text_for_codex(text).unwrap_or_default(),
            "disable-model-invocation",
        )
    };
    let mut out = CodexSkills::default();
    for skill in skills {
        let raw = asset_text(&skill.asset).map_err(|_| CodexDelegate)?;
        if is_manual_only(&raw) {
            out.manual_only.push(skill.id.clone());
        }
        let dest = codex_skill_dest(&skill.id);
        let existing = read_if_exists(view, &dest).map_err(|_| CodexDelegate)?;
        let input = RenderManagedFileInput {
            asset: &raw,
            style: CommentStyle::Html,
            existing: existing.as_deref(),
            managed_id: &skill.managed_id,
            source: CORE_SOURCE_ID,
            version: STAMP_VERSION,
            config,
            extra_vars: BTreeMap::new(),
            transform: Some(&transform),
            engine: Some("codex"),
            force_overwrite: false,
            ambient_floor,
        };
        out.files
            .push(collect_managed(view, &dest, &input, false, lang).map_err(|_| CodexDelegate)?);
    }
    Ok(out)
}

/// The `agents/openai.yaml` requests of `extraFiles`, one per manual-only skill.
///
/// # Errors
/// [`CodexDelegate`] when a destination cannot be read.
pub fn collect_openai_policies(
    view: &dyn RepoView,
    ids: &[String],
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<Vec<Collected>, CodexDelegate> {
    ids.iter()
        .map(|id| {
            collect_body(
                view,
                &format!(".agents/skills/{id}/agents/openai.yaml"),
                &format!("{id}-openai-policy"),
                OPENAI_MANUAL_ONLY_POLICY,
                CommentStyle::Shell,
                ambient_floor,
                lang,
            )
            .map_err(|_| CodexDelegate)
        })
        .collect()
}

/// `codexSubBlockBody`: the plugin skill without frontmatter, interpolated and adapted.
fn sub_block_body(
    plugin: &LoadedPlugin,
    skill: &PluginSkill,
    config: &JsValue,
) -> Result<String, CodexDelegate> {
    let raw = crate::render::assets::plugin(&plugin.dir, &skill.path)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .ok_or(CodexDelegate)?;
    adapt_harness_text_for_codex(&interpolate(
        strip_frontmatter(raw),
        config,
        &InterpolateOptions::default(),
    ))
    .ok_or(CodexDelegate)
}

/// The content a finalize loop edits: the pending write, else the file on disk.
fn current(
    view: &dyn RepoView,
    pending: &[PendingWrite],
    rel: &str,
) -> Result<(Option<usize>, Option<String>), CodexDelegate> {
    if let Some(index) = pending.iter().position(|write| write.rel_path == rel) {
        return Ok((Some(index), Some(pending[index].content.clone())));
    }
    Ok((None, read_if_exists(view, rel).map_err(|_| CodexDelegate)?))
}

fn store(
    pending: &mut Vec<PendingWrite>,
    at: Option<usize>,
    rel: &str,
    content: String,
    status: InjectStatus,
) {
    match at {
        Some(index) => pending[index].content = content,
        None => pending.push(PendingWrite {
            rel_path: rel.to_owned(),
            content,
            status,
            chmod_exec: false,
        }),
    }
}

/// The three skill sub-block loops of `finalize`: plugin skills injected into their target
/// skill, those of disabled plugins stripped, then retired ones stripped when pristine. Returns
/// the warnings, in order.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws.
pub fn apply_codex_skill_sub_blocks(
    view: &dyn RepoView,
    pending: &mut Vec<PendingWrite>,
    enabled: &[LoadedPlugin],
    disabled: &[LoadedPlugin],
    config: &JsValue,
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<Vec<String>, CodexDelegate> {
    let mut warnings = Vec::new();
    for plugin in enabled {
        let plugin_id = plugin.manifest_id();
        for skill in &plugin.skill_assets {
            let Some(id) = skill.inject_into.as_deref().and_then(skill_inject_target) else {
                continue;
            };
            let target = codex_skill_dest(id);
            let (at, base) = current(view, pending, &target)?;
            let Some(base) = base else {
                warnings.push(crate::i18n::plugin_skill_not_injected(
                    lang, &skill.id, &plugin_id, &target,
                ));
                continue;
            };
            let meta = MarkerMeta {
                source: Some(format!("@navori/plugin-{plugin_id}")),
                version: Some(STAMP_VERSION.to_owned()),
                ..MarkerMeta::default()
            };
            let injected = inject_managed_section(
                &base,
                &skill.id,
                &sub_block_body(plugin, skill, config)?,
                &meta,
                InjectOptions {
                    ambient_floor,
                    ..InjectOptions::default()
                },
            );
            if at.is_some()
                || matches!(
                    injected.status,
                    InjectStatus::Created | InjectStatus::Updated
                )
            {
                store(pending, at, &target, injected.output, injected.status);
            }
        }
    }
    for plugin in disabled {
        for skill in &plugin.skill_assets {
            let Some(id) = skill.inject_into.as_deref().and_then(skill_inject_target) else {
                continue;
            };
            let target = codex_skill_dest(id);
            let (at, Some(content)) = current(view, pending, &target)? else {
                continue;
            };
            let stripped = remove_managed_section(&content, &skill.id, CommentStyle::Html);
            if stripped != content {
                store(pending, at, &target, stripped, InjectStatus::Updated);
            }
        }
    }
    for (_, _, entries) in RETIRED_PLUGIN_SUB_BLOCKS {
        for (block, path) in *entries {
            let Some(id) = skill_inject_target(path) else {
                continue;
            };
            let target = codex_skill_dest(id);
            let (at, Some(content)) = current(view, pending, &target)? else {
                continue;
            };
            match remove_managed_section_guarded(&content, block, CommentStyle::Html, STAMP_VERSION)
            {
                Ok(stripped) if stripped != content => {
                    store(pending, at, &target, stripped, InjectStatus::Updated);
                }
                Ok(_) => {}
                Err(kept) => warnings.push(format!(
                    "kept {target} \u{2014} retired block {block} is {}",
                    match kept {
                        Kept::Newer => "from a newer navori",
                        Kept::Modified => "edited by hand",
                    }
                )),
            }
        }
    }
    Ok(warnings)
}
