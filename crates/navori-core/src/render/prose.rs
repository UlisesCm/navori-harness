//! The prose engines (`engines/shared/prose-harness.ts` and the `agents-md`, `cursor` and
//! `copilot` adapters, spec 0059 T18, D36): one managed markdown file per engine with the core
//! rule blocks, the preset stack block, the skills index and a short workflow summary.
//!
//! Pure over a [`RepoView`]: the plan says what the file becomes; backups and writes belong to
//! the multi-engine commit. Only the root render is modelled: a workspace render is the caller's
//! delegate.

use std::path::Path;

use crate::STAMP_VERSION;
use crate::config::effective_config;
use crate::integrity::is_js_whitespace;
use crate::js_json::JsValue;
use crate::markers::{InjectOptions, InjectStatus, MarkerMeta, inject_managed_section};
use crate::render::assets;
use crate::render::block_plan::{AssetStatus, PlanOptions, compute_render_plan};
use crate::render::collect::{PendingWrite, RepoView, SkippedFile, read_if_exists};
use crate::render::context::Lang;
use crate::render::frontmatter::{get_frontmatter_field, split_frontmatter};
use crate::render::harness_plan::{
    CORE_SKILLS, WORKFLOW_SKILLS, effective_libraries, extra_condition_met, extras,
    in_engine_scope, normalize_rel,
};
use crate::render::interpolate::sanitize_project_value;
use crate::render::library_skills::library_skill_label;
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::presets::{AssetRoot, LoadedPreset, load_preset};
use crate::{i18n, posix};

/// The TS path is not modelled here (a throwing preset or plan, an unreadable destination).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProseDelegate;

/// One prose adapter: destination, managed-block id and the seeds of a first render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProseSpec {
    /// Engine id; resolves the `onCodex` / `onClaude` condition keys.
    pub engine: &'static str,
    /// Destination, relative to the repo root.
    pub dest: &'static str,
    /// Managed-block id, stable across releases.
    pub managed_id: &'static str,
    /// Written before the managed block when the file is created.
    pub header: &'static str,
    /// User-owned section appended once, when the file is created.
    pub user_section: &'static str,
}

/// `USER_SECTION` of the three adapters.
const USER_SECTION: &str = "\n<!-- navori:user-section -->\n## Reglas del repo (tuyas)\n\n<!-- Add your repo-specific rules here; navori doesn't touch this section. -->\n";

/// `renderAgentsMdEngine`.
pub const AGENTS_MD: ProseSpec = ProseSpec {
    engine: "agents-md",
    dest: "AGENTS.md",
    managed_id: "navori-agents",
    header: "# AGENTS.md\n",
    user_section: USER_SECTION,
};

/// `renderCursorEngine`.
pub const CURSOR: ProseSpec = ProseSpec {
    engine: "cursor",
    dest: ".cursor/rules/navori.mdc",
    managed_id: "navori-cursor",
    header: "---\ndescription: Contexto y reglas del proyecto generados por navori.\nalwaysApply: true\n---\n\n# Navori — reglas del proyecto\n",
    user_section: USER_SECTION,
};

/// `renderCopilotEngine`.
pub const COPILOT: ProseSpec = ProseSpec {
    engine: "copilot",
    dest: ".github/copilot-instructions.md",
    managed_id: "navori-copilot",
    header: "# Copilot instructions\n",
    user_section: USER_SECTION,
};

/// The adapter of a prose engine id.
#[must_use]
pub fn prose_spec(engine: &str) -> Option<ProseSpec> {
    [AGENTS_MD, CURSOR, COPILOT]
        .into_iter()
        .find(|spec| spec.engine == engine)
}

/// `buildHarnessProse` options.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProseOptions<'a> {
    /// Keep the `orquestacion` block (Codex has native subagents).
    pub include_orchestration: bool,
    /// Keep plugin protocol blocks (Pi backs them with MCP).
    pub include_plugin_blocks: bool,
    /// Omit the "Available skills" index (Codex lists `.agents/skills` natively).
    pub omit_skills_index: bool,
    /// `setMarkerFloorVersion`.
    pub ambient_floor: Option<&'a str>,
}

/// What one prose file contributes to the render.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProsePlan {
    /// The write, when the file changes.
    pub write: Option<PendingWrite>,
    /// The skip, when the file is kept.
    pub skipped: Vec<SkippedFile>,
    /// Parity warnings (`collectOmissionWarnings`).
    pub warnings: Vec<String>,
    /// The destination did not exist: the write takes no backup.
    pub first_render: bool,
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

fn strings(value: Option<&JsValue>) -> Vec<String> {
    match value {
        Some(JsValue::Array(items)) => items.iter().filter_map(|item| text(Some(item))).collect(),
        _ => Vec::new(),
    }
}

// --- skills index ---------------------------------------------------------------------------

/// `TRIGGER_MAX`, in UTF-16 units.
const TRIGGER_MAX: usize = 120;
/// `TRIGGER_MIN_CLAUSE`.
const TRIGGER_MIN_CLAUSE: usize = 25;
/// `ASIDE_MAX`.
const ASIDE_MAX: usize = 40;

/// `\s` of a JS regex without the `u` flag, on one UTF-16 unit.
fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

/// `.replace(/\s+/g, " ")`.
fn collapse_spaces(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut in_run = false;
    for &unit in units {
        if is_space(unit) {
            if !in_run {
                out.push(u16::from(b' '));
            }
            in_run = true;
        } else {
            out.push(unit);
            in_run = false;
        }
    }
    out
}

/// `String.prototype.trim`.
fn trim(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|&u| !is_space(u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|&u| !is_space(u))
        .map_or(start, |i| i + 1);
    &units[start..end]
}

/// `String.prototype.trimEnd`.
fn trim_end(units: &[u16]) -> &[u16] {
    let end = units
        .iter()
        .rposition(|&u| !is_space(u))
        .map_or(0, |i| i + 1);
    &units[..end]
}

/// `indexOf` of a UTF-16 needle.
fn index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `/ [—–] /` at `at`.
fn is_dash_separator(text: &[u16], at: usize) -> bool {
    text.len() >= at + 3
        && text[at] == u16::from(b' ')
        && (text[at + 1] == 0x2014 || text[at + 1] == 0x2013)
        && text[at + 2] == u16::from(b' ')
}

/// `dropDashAsides`: splice out a short aside between a pair of dashes.
fn drop_dash_asides(text: &[u16]) -> Vec<u16> {
    let mut separators = Vec::new();
    let mut at = 0;
    while at < text.len() {
        if is_dash_separator(text, at) {
            separators.push(at);
            at += 3;
        } else {
            at += 1;
        }
    }
    let mut out = Vec::new();
    let mut from = 0;
    for &[open, close] in separators.as_chunks::<2>().0 {
        if close - open - 3 > ASIDE_MAX {
            continue;
        }
        out.extend_from_slice(&text[from..open]);
        out.push(u16::from(b' '));
        from = close + 3;
    }
    out.extend_from_slice(&text[from..]);
    trim(&collapse_spaces(&out)).to_vec()
}

/// `summarizeTrigger`: the first clause of a skill `description`, capped.
#[must_use]
pub fn summarize_trigger(description: Option<&str>) -> Option<String> {
    let description = description.filter(|d| !d.is_empty())?;
    let flat = drop_dash_asides(trim(&collapse_spaces(&units(description))));
    if flat.is_empty() {
        return None;
    }
    let mut cut = flat.len();
    for separator in [". ", "; "] {
        if let Some(at) = index_of(&flat, &units(separator))
            && at > 0
            && at < cut
        {
            cut = at;
        }
    }
    for separator in [" — ", " – "] {
        if let Some(at) = index_of(&flat, &units(separator))
            && at >= TRIGGER_MIN_CLAUSE
            && at < cut
        {
            cut = at;
        }
    }
    let mut out = trim(&flat[..cut]).to_vec();
    if out
        .last()
        .is_some_and(|&u| u == u16::from(b'.') || u == u16::from(b';') || u == u16::from(b','))
    {
        out.pop();
    }
    if out.len() > TRIGGER_MAX {
        let mut capped = trim_end(&out[..TRIGGER_MAX - 1]).to_vec();
        capped.push(0x2026);
        out = capped;
    }
    // A cut inside a surrogate pair leaves a lone surrogate, which Node writes as U+FFFD.
    (!out.is_empty()).then(|| String::from_utf16_lossy(&out))
}

/// `readSkillTrigger` over bytes already read.
fn skill_trigger(bytes: Option<Vec<u8>>) -> Option<String> {
    let raw = String::from_utf8_lossy(&bytes?).into_owned();
    let description = get_frontmatter_field(split_frontmatter(&raw).frontmatter, "description");
    summarize_trigger(description.as_deref())
}

fn core_trigger(rel: &str) -> Option<String> {
    skill_trigger(assets::core(&format!("core-assets/{rel}")).map(<[u8]>::to_vec))
}

fn preset_trigger(preset: &LoadedPreset, rel: &str) -> Option<String> {
    let bytes = match &preset.asset_root {
        AssetRoot::Bundled => {
            assets::core(&format!("core-assets/{}", normalize_rel(rel))).map(<[u8]>::to_vec)
        }
        AssetRoot::Local(dir) => std::fs::read(dir.join(rel)).ok(),
    };
    skill_trigger(bytes)
}

/// `buildSkillRows` for a prose engine: no project-local or hoisted skills, triggers included.
fn skill_rows(
    config: &JsValue,
    repo_root: &Path,
    engine: &str,
) -> Result<Vec<String>, ProseDelegate> {
    let mut rows: Vec<String> = Vec::new();
    let mut listed: Vec<String> = Vec::new();
    let push = |rows: &mut Vec<String>,
                listed: &mut Vec<String>,
                id: &str,
                tag: &str,
                trigger: Option<String>| {
        rows.push(match trigger {
            Some(trigger) => format!("- `{id}` — {tag} · {trigger}"),
            None => format!("- `{id}` — {tag}"),
        });
        listed.push(id.to_owned());
    };
    for id in CORE_SKILLS {
        push(
            &mut rows,
            &mut listed,
            id,
            "navori",
            core_trigger(&format!("skills/{id}.md")),
        );
    }
    for id in WORKFLOW_SKILLS {
        if in_engine_scope(id, Some(engine)) {
            push(
                &mut rows,
                &mut listed,
                id,
                "navori (workflow)",
                core_trigger(&format!("skills/{id}.md")),
            );
        }
    }
    let preset_id = text(get(config, "preset"));
    let loaded = match preset_id.as_deref() {
        Some(id) if !id.is_empty() && id != "custom" => {
            load_preset(id, repo_root).map_err(|_| ProseDelegate)?
        }
        _ => None,
    };
    if let (Some(preset), Some(preset_id)) = (loaded.as_ref(), preset_id.as_deref()) {
        let tag = format!("preset (`{}`)", sanitize_project_value(preset_id));
        for extra in extras(Some(preset), "skills") {
            if !extra_condition_met(extra, config) {
                continue;
            }
            let (Some(id), Some(rel)) = (text(get(extra, "id")), text(get(extra, "relPath")))
            else {
                return Err(ProseDelegate);
            };
            if listed.contains(&id) {
                continue;
            }
            push(
                &mut rows,
                &mut listed,
                &id,
                &tag,
                preset_trigger(preset, &rel),
            );
        }
    }
    let project = get(config, "project");
    let detected = strings(project.and_then(|p| get(p, "libraries")));
    let extra = strings(project.and_then(|p| get(p, "extraLibraries")));
    for id in effective_libraries(config, loaded.as_ref()) {
        if listed.contains(&id) || library_skill_label(&id).is_none() {
            continue;
        }
        let origin = if detected.contains(&id) {
            "library (detected)".to_owned()
        } else if extra.contains(&id) {
            "library (extra)".to_owned()
        } else {
            format!(
                "library (preset `{}`)",
                sanitize_project_value(preset_id.as_deref().unwrap_or(""))
            )
        };
        push(
            &mut rows,
            &mut listed,
            &id,
            &origin,
            core_trigger(&format!("lib-skills/{id}.md")),
        );
    }
    Ok(rows)
}

/// `buildWorkflowSection`.
const WORKFLOW_SECTION: &str = "## Workflow\n\n- For non-trivial tasks: analysis → plan → implementation. One at a time.\n- Before coding: is it the simplest option? readable in 6 months? does it keep the existing pattern?\n- Search with read-only tools (don't read the whole repo); cite `file:line`.\n- Close with the project's quality gate green before calling it done.\n";

/// `buildHarnessProse` for a root render, over an already effective config.
///
/// # Errors
/// [`ProseDelegate`] wherever the TS throws or Rust does not model the plan.
pub fn build_harness_prose(
    config: &JsValue,
    repo_root: &Path,
    engine: &str,
    options: ProseOptions<'_>,
) -> Result<String, ProseDelegate> {
    let plan_options = PlanOptions {
        engine: Some(engine.to_owned()),
        ambient_floor: options.ambient_floor.map(str::to_owned),
        ..PlanOptions::default()
    };
    let plan =
        compute_render_plan("", config, repo_root, &plan_options).map_err(|_| ProseDelegate)?;
    let preset = text(get(config, "preset"));
    let mut sections = vec![
        "> Project context generated by navori. Read by Cursor, Codex, Gemini and Copilot."
            .to_owned(),
    ];
    sections.extend(
        plan.entries
            .iter()
            .filter(|entry| {
                entry.status != AssetStatus::RemovedConditionFalse
                    && (options.include_orchestration || entry.asset.id() != "orquestacion")
                    && (options.include_plugin_blocks
                        || entry.source == "core"
                        || preset.as_deref() == Some(entry.source.as_str()))
            })
            .filter_map(|entry| entry.new_content.as_deref())
            .map(|body| posix::js_trim(body).to_owned()),
    );
    if !options.omit_skills_index {
        let rows = skill_rows(config, repo_root, engine)?;
        if !rows.is_empty() {
            let mut lines = vec!["## Available skills".to_owned(), String::new()];
            lines.extend(rows);
            lines.push(String::new());
            sections.push(lines.join("\n"));
        }
    }
    sections.push(WORKFLOW_SECTION.to_owned());
    Ok(format!("{}\n", posix::js_trim(&sections.join("\n\n"))))
}

/// `collectOmissionWarnings`.
#[must_use]
pub fn omission_warnings(config: &JsValue, lang: Lang) -> Vec<String> {
    let mut warnings = vec![i18n::prose_no_claude_infra(lang).to_owned()];
    let enabled: Vec<String> = match get(config, "plugins") {
        Some(JsValue::Object(plugins)) => plugins
            .ordered()
            .into_iter()
            .filter(|(_, state)| get(state, "enabled") == Some(&JsValue::Bool(true)))
            .map(|(id, _)| String::from_utf16_lossy(id.units()))
            .collect(),
        _ => Vec::new(),
    };
    if !enabled.is_empty() {
        warnings.push(i18n::prose_plugin_blocks_omitted(lang, &enabled.join(", ")));
    }
    if matches!(get(config, "models"), Some(JsValue::Object(models)) if !models.is_empty()) {
        warnings.push(i18n::prose_model_assignment_omitted(lang).to_owned());
    }
    warnings
}

fn core_meta() -> MarkerMeta {
    MarkerMeta {
        source: Some(CORE_SOURCE_ID.to_owned()),
        version: Some(STAMP_VERSION.to_owned()),
        ..MarkerMeta::default()
    }
}

/// `renderProseFile` for a root render, without the write: what the file becomes.
///
/// `extend_body` appends engine-owned sub-blocks (Pi's plugin extensions) to the body.
///
/// # Errors
/// [`ProseDelegate`] wherever the TS throws or Rust does not model the plan.
pub fn plan_prose_file(
    view: &dyn RepoView,
    input_config: &JsValue,
    repo_root: &Path,
    spec: ProseSpec,
    options: ProseOptions<'_>,
    extend_body: Option<&dyn Fn(String) -> String>,
) -> Result<ProsePlan, ProseDelegate> {
    let config = effective_config(input_config);
    let lang = Lang::resolve(text(get(&config, "language")).as_deref());
    let current = read_if_exists(view, spec.dest).map_err(|_| ProseDelegate)?;
    let first_render = current.is_none();
    let existing = current.unwrap_or_else(|| spec.header.to_owned());
    let harness = build_harness_prose(&config, repo_root, spec.engine, options)?;
    let body = match extend_body {
        Some(extend) => extend(harness),
        None => harness,
    };
    let inject = |force_overwrite: bool| {
        inject_managed_section(
            &existing,
            spec.managed_id,
            &body,
            &core_meta(),
            InjectOptions {
                force_overwrite,
                ambient_floor: options.ambient_floor,
                ..InjectOptions::default()
            },
        )
    };
    let result = inject(false);
    let mut plan = ProsePlan {
        warnings: omission_warnings(&config, lang),
        first_render,
        ..ProsePlan::default()
    };
    match result.status {
        InjectStatus::UserModifiedSkipped => {
            // `attachResolution` with `forcedInjectContent`: only a regular file whose forced
            // render differs, and never past a newer block.
            let forced = inject(true);
            let resolution = view
                .read_regular(spec.dest)
                .filter(|_| forced.details.downgrade != Some(true))
                .map(|_| forced.output)
                .filter(|content| *content != existing);
            plan.skipped.push(SkippedFile {
                rel_path: spec.dest.to_owned(),
                reason: if resolution.is_some() {
                    i18n::managed_file_edited_resolvable(lang)
                } else {
                    i18n::managed_block_edited_by_hand(lang)
                }
                .to_owned(),
                status: Some(result.status),
                resolution,
                markerless_resolution: None,
                chmod_exec: false,
            });
        }
        InjectStatus::DowngradeSkipped => plan.skipped.push(SkippedFile {
            rel_path: spec.dest.to_owned(),
            reason: i18n::block_from_newer_navori(lang, result.details.existing_version.as_deref()),
            status: Some(result.status),
            resolution: None,
            markerless_resolution: None,
            chmod_exec: false,
        }),
        InjectStatus::Unchanged => {}
        status => {
            let mut content = result.output;
            if first_render {
                content.push_str(spec.user_section);
            }
            plan.write = Some(PendingWrite {
                rel_path: spec.dest.to_owned(),
                content,
                status,
                chmod_exec: false,
            });
        }
    }
    Ok(plan)
}
