//! Step 1 of `prepareClaudeEngine` (`engines/claude/index.ts`, spec 0058 T14): `CLAUDE.md` and
//! the orchestrator context files under `.claude/context/`.
//!
//! The managed region goes through [`compute_render_plan`]; orchestrator blocks and the agents
//! index leave it for their own files; the computed blocks (`contexto-proyecto`, …) are injected;
//! blocks are put back in canonical order and the user zone is re-attached. Pure over a
//! [`RepoView`]: nothing is written here. Only the root render of a repo without monorepo
//! workspaces is modelled; anything else is a [`ClaudeMdDelegate`].

use std::path::Path;

use crate::STAMP_VERSION;
use crate::config::effective_config;
use crate::i18n::{self, ProjectContext};
use crate::js_json::JsValue;
use crate::markers::{
    CommentStyle, InjectOptions, InjectStatus, MarkerMeta, emit_user_section,
    inject_managed_section, remove_managed_section, remove_managed_section_guarded,
    reorder_managed_blocks, split_user_section,
};
use crate::render::assets;
use crate::render::block_plan::{
    AssetStatus, PlanAsset, PlanOptions, RenderPlan, canonical_managed_order, compute_render_plan,
};
use crate::render::collect::{collect_managed, read_if_exists};
use crate::render::context::Lang;
use crate::render::harness_plan::{ROSTER_AGENTS, is_agent_enabled};
use crate::render::interpolate::sanitize_project_value;
use crate::render::managed_file::RenderManagedFileInput;
use crate::render::plan::{Audience, CORE_SOURCE_ID, resolve_asset_path};
use crate::semver;

pub use crate::render::collect::{PendingWrite, RepoView, SkippedFile};

/// The TS path is not modelled here (monorepo workspaces, a throwing asset, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeMdDelegate;

/// What step 1 adds to the engine's plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeMdPlan {
    /// The `CLAUDE.md` block plan, with the computed entries the engine appends.
    pub plan: RenderPlan,
    /// Context files first, `CLAUDE.md` last.
    pub pending: Vec<PendingWrite>,
    /// Files kept because of a hand edit or a newer navori.
    pub skipped: Vec<SkippedFile>,
    /// Repo-relative paths to delete.
    pub removals: Vec<String>,
    /// Warnings for the CLI.
    pub warnings: Vec<String>,
    /// Destinations inspected.
    pub inspected: usize,
}

/// `{ skipIds, forceIds }` of a root render, plus the run-wide marker floor.
pub type ClaudeMdOptions = PlanOptions;

const CONTEXT_DIR: &str = ".claude/context";
const SKILLS_INDEX_ID: &str = "skills-index";
const AGENTS_INDEX_ID: &str = "agentes-disponibles";
const CONTEXTO_PROYECTO_ID: &str = "contexto-proyecto";
const CONTEXTO_MONOREPO_ID: &str = "contexto-monorepo";

/// `CLAUDE_COMPUTED_BLOCK_IDS`.
pub const CLAUDE_COMPUTED_BLOCK_IDS: [&str; 3] =
    [AGENTS_INDEX_ID, CONTEXTO_MONOREPO_ID, CONTEXTO_PROYECTO_ID];

/// `orchestratorContextFileName`: `10-orquestacion.md`; unknown ids sort last at 90.
fn context_file_name(id: &str) -> String {
    let prefix = match id {
        "planificacion" => 5,
        "plan-maestro" => 7,
        "orquestacion" => 10,
        "agentes-disponibles" => 20,
        "arranque-sesion" => 30,
        "cierre-sesion" => 40,
        _ => 90,
    };
    format!("{prefix:02}-{id}.md")
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

/// `value ?? []` for a list of strings; anything else the TS would choke on delegates.
fn strings(value: Option<&JsValue>) -> Result<Vec<String>, ClaudeMdDelegate> {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| text(Some(item)).ok_or(ClaudeMdDelegate))
            .collect(),
        Some(_) => Err(ClaudeMdDelegate),
    }
}

/// JS truthiness of a config value.
fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => false,
        Some(JsValue::Bool(flag)) => *flag,
        Some(JsValue::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(JsValue::String(text)) => !text.units().is_empty(),
        Some(JsValue::Array(_) | JsValue::Object(_)) => true,
    }
}

/// `buildAgentsIndexBody` (through `buildAgentsIndexBlock` with the intro).
fn agents_index_body(config: &JsValue, lang: Lang) -> Option<String> {
    let rows: Vec<String> = ROSTER_AGENTS
        .iter()
        .filter(|agent| agent.id != "orchestrator" && is_agent_enabled(config, agent.harness_key))
        .filter_map(|agent| {
            i18n::agent_when(lang, agent.id).map(|when| format!("- `{}` — {when}", agent.id))
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    let (heading, intro) = i18n::agents_index(lang);
    let mut lines = vec![
        heading.to_owned(),
        String::new(),
        intro.to_owned(),
        String::new(),
    ];
    lines.extend(rows);
    lines.push(String::new());
    Some(lines.join("\n"))
}

/// `buildContextoProyectoBody`.
fn contexto_proyecto_body(
    config: &JsValue,
    lang: Lang,
) -> Result<Option<String>, ClaudeMdDelegate> {
    let project = get(config, "project");
    let field = |key: &str| project.and_then(|p| get(p, key));
    let t = ProjectContext(lang);
    let mut rows: Vec<String> = Vec::new();
    if let Some(row) = text(field("posture")).and_then(|posture| t.stage(&posture)) {
        rows.push(row.to_owned());
    }
    match field("libraryMigrations") {
        None | Some(JsValue::Undefined | JsValue::Null) => {}
        Some(JsValue::Array(items)) => {
            for item in items {
                let part = |key: &str| {
                    text(get(item, key))
                        .map(|value| sanitize_project_value(&value))
                        .ok_or(ClaudeMdDelegate)
                };
                rows.push(t.migration_row(&part("domain")?, &part("preferred")?, &part("legacy")?));
            }
        }
        Some(_) => return Err(ClaudeMdDelegate),
    }
    if let Some(row) = text(field("reviewRigor")).and_then(|rigor| t.rigor(&rigor)) {
        rows.push(row.to_owned());
    }
    let arch = match field("architectureRule") {
        None | Some(JsValue::Undefined | JsValue::Null) => String::new(),
        value => sanitize_project_value(&text(value).ok_or(ClaudeMdDelegate)?),
    };
    if !arch.is_empty() {
        rows.push(t.architecture(&arch));
    }
    let critical: Vec<String> = strings(field("criticalAreas"))?
        .iter()
        .map(|area| sanitize_project_value(area))
        .filter(|area| !area.is_empty())
        .collect();
    if !critical.is_empty() {
        rows.push(t.critical_areas(&critical.join(", ")));
    }
    let tests = text(field("testsForNewCode"));
    if let Some(row) = tests.as_deref().and_then(|policy| t.tests(policy)) {
        rows.push(row.to_owned());
    }
    if matches!(tests.as_deref(), Some("always" | "when-applicable")) {
        let excluded: Vec<String> = strings(field("testsExclude"))?
            .iter()
            .map(|entry| sanitize_project_value(entry))
            .filter(|entry| !entry.is_empty())
            .collect();
        if !excluded.is_empty() {
            rows.push(t.tests_exclude(&excluded.join(", ")));
        }
    }
    if rows.is_empty() {
        return Ok(None);
    }
    let mut lines = vec![
        t.heading().to_owned(),
        String::new(),
        t.intro().to_owned(),
        String::new(),
    ];
    lines.extend(rows);
    lines.push(String::new());
    Ok(Some(lines.join("\n")))
}

/// `enabledMonorepoWorkspaces(config).length > 0`: the root map block, not modelled.
fn has_monorepo_workspaces(config: &JsValue) -> bool {
    let monorepo = get(config, "monorepo");
    truthy(monorepo.and_then(|m| get(m, "enabled")))
        && matches!(monorepo.and_then(|m| get(m, "workspaces")), Some(JsValue::Array(items)) if !items.is_empty())
}

/// `isRemovableNavoriFile(path, id)` without options: a regular file whose `id` block carries a
/// `version=` no newer than this CLI.
fn removable(view: &dyn RepoView, rel: &str, id: &str) -> bool {
    let Some(content) = view.read_regular(rel) else {
        return false;
    };
    let opening = [
        format!("navori:managed id=\"{id}\""),
        format!("navori:managed start id=\"{id}\""),
    ]
    .iter()
    .find_map(|opener| {
        let start = content.find(opener.as_str())?;
        let end = content[start..]
            .find('\n')
            .map_or(content.len(), |i| start + i);
        Some(content[start..end].to_owned())
    });
    let Some(line) = opening else {
        return false;
    };
    let version = line.split("version=\"").nth(1).and_then(|rest| {
        let end = rest.find('"')?;
        (end > 0).then(|| rest[..end].to_owned())
    });
    match version {
        Some(version) => !semver::is_downgrade(Some(&version), Some(STAMP_VERSION)),
        None => false,
    }
}

fn core_meta() -> MarkerMeta {
    MarkerMeta {
        source: Some(CORE_SOURCE_ID.to_owned()),
        version: Some(STAMP_VERSION.to_owned()),
        ..MarkerMeta::default()
    }
}

/// Step 1 of `prepareClaudeEngine` for a root render.
///
/// # Errors
/// [`ClaudeMdDelegate`] for monorepo workspaces and wherever the TS throws.
pub fn plan_claude_md(
    view: &dyn RepoView,
    input_config: &JsValue,
    repo_root: &Path,
    options: &ClaudeMdOptions,
) -> Result<ClaudeMdPlan, ClaudeMdDelegate> {
    let config = effective_config(input_config);
    if has_monorepo_workspaces(&config) {
        return Err(ClaudeMdDelegate);
    }
    let lang = Lang::resolve(text(get(&config, "language")).as_deref());
    let language = text(get(&config, "language")).unwrap_or_else(|| "es".to_owned());
    let ambient_floor = options.ambient_floor.as_deref();

    let existing = read_if_exists(view, "CLAUDE.md")
        .map_err(|_| ClaudeMdDelegate)?
        .unwrap_or_default();
    let split = split_user_section(&existing, CommentStyle::Html);
    let plan_options = PlanOptions {
        engine: None,
        omit_root_only: false,
        ..options.clone()
    };
    let mut plan = compute_render_plan(&split.managed, &config, repo_root, &plan_options)
        .map_err(|_| ClaudeMdDelegate)?;
    let mut pending = Vec::new();
    let mut skipped = Vec::new();
    let mut removals = Vec::new();
    let mut warnings = Vec::new();
    let mut inspected = 1;

    // 1a-bis: blocks addressed to the orchestrator get their own context file.
    for entry in &plan.entries {
        let PlanAsset::Core(asset) = &entry.asset else {
            continue;
        };
        if asset.audience != Audience::Orchestrator {
            continue;
        }
        let dest = format!("{CONTEXT_DIR}/{}", context_file_name(asset.id));
        inspected += 1;
        let legacy = format!("{CONTEXT_DIR}/{}.md", asset.id);
        if removable(view, &legacy, asset.id) {
            removals.push(legacy);
        }
        if entry.new_content.is_none() {
            if removable(view, &dest, asset.id) {
                removals.push(dest);
            }
            continue;
        }
        let (path, _) = resolve_asset_path(asset, &language);
        let source = String::from_utf8(assets::core(&path).ok_or(ClaudeMdDelegate)?.to_vec())
            .map_err(|_| ClaudeMdDelegate)?;
        let current = read_if_exists(view, &dest).map_err(|_| ClaudeMdDelegate)?;
        let input = RenderManagedFileInput {
            asset: &source,
            style: CommentStyle::Html,
            existing: current.as_deref(),
            managed_id: asset.id,
            source: CORE_SOURCE_ID,
            version: STAMP_VERSION,
            config: &config,
            extra_vars: Default::default(),
            // `conditionOrchestration` as a transform for `orquestacion`: the render applies the
            // same (idempotent) resolution right after, so it is not repeated here.
            transform: None,
            engine: None,
            force_overwrite: false,
            ambient_floor,
        };
        let collected =
            collect_managed(view, &dest, &input, false, lang).map_err(|_| ClaudeMdDelegate)?;
        pending.extend(collected.write);
        skipped.extend(collected.skip);
    }

    // 1b: the retired skills index leaves CLAUDE.md only when pristine.
    let mut content = plan.next.clone();
    match remove_managed_section_guarded(
        &content,
        SKILLS_INDEX_ID,
        CommentStyle::Html,
        STAMP_VERSION,
    ) {
        Err(_) => plan.entries.push(computed_entry(
            SKILLS_INDEX_ID,
            AssetStatus::Inject(InjectStatus::DowngradeSkipped),
        )),
        Ok(next) => content = next,
    }

    // 1b-bis: the agents index lives in its own context file.
    if let Some(body) = agents_index_body(&config, lang) {
        inspected += 1;
        let file = inject_managed_section(
            "",
            AGENTS_INDEX_ID,
            &body,
            &core_meta(),
            InjectOptions::default(),
        );
        let dest = format!("{CONTEXT_DIR}/{}", context_file_name(AGENTS_INDEX_ID));
        let legacy = format!("{CONTEXT_DIR}/{AGENTS_INDEX_ID}.md");
        if removable(view, &legacy, AGENTS_INDEX_ID) {
            removals.push(legacy);
        }
        let current = read_if_exists(view, &dest).map_err(|_| ClaudeMdDelegate)?;
        let status = match current.as_deref() {
            None => InjectStatus::Created,
            Some(current) if current == file.output => InjectStatus::Unchanged,
            Some(_) => InjectStatus::Updated,
        };
        if status != InjectStatus::Unchanged {
            pending.push(PendingWrite {
                rel_path: dest,
                content: file.output,
                status,
                chmod_exec: false,
            });
        }
        content = remove_managed_section(&content, AGENTS_INDEX_ID, CommentStyle::Html);
        plan.entries
            .push(computed_entry(AGENTS_INDEX_ID, AssetStatus::Inject(status)));
    } else {
        content = remove_managed_section(&content, AGENTS_INDEX_ID, CommentStyle::Html);
    }

    // 1c: project context rules.
    if let Some(body) = contexto_proyecto_body(&config, lang)? {
        let result = inject_managed_section(
            &content,
            CONTEXTO_PROYECTO_ID,
            &body,
            &core_meta(),
            InjectOptions {
                force_overwrite: options.force_ids.contains(CONTEXTO_PROYECTO_ID),
                ambient_floor,
                ..InjectOptions::default()
            },
        );
        content = result.output;
        plan.entries.push(computed_entry(
            CONTEXTO_PROYECTO_ID,
            AssetStatus::Inject(result.status),
        ));
    } else {
        content = remove_managed_section(&content, CONTEXTO_PROYECTO_ID, CommentStyle::Html);
    }

    // 1c-bis: no monorepo map at the root of a repo without workspaces.
    content = remove_managed_section(&content, CONTEXTO_MONOREPO_ID, CommentStyle::Html);

    // 1d: canonical order.
    let order = canonical_managed_order(&config, repo_root, false, &CLAUDE_COMPUTED_BLOCK_IDS)
        .map_err(|_| ClaudeMdDelegate)?;
    let order: Vec<&str> = order.iter().map(String::as_str).collect();
    let reorder = reorder_managed_blocks(&content, &order, CommentStyle::Html);
    content = reorder.output;
    if reorder.blocked_by_interleaving {
        warnings.push(i18n::managed_blocks_out_of_order(lang).to_owned());
    }

    // 1e: the user zone goes back after the managed region.
    if split.user_body.is_some() || split.had_markers || existing.is_empty() {
        content = emit_user_section(&content, split.user_body.as_deref(), lang);
    } else if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    if content != existing {
        pending.push(PendingWrite {
            rel_path: "CLAUDE.md".to_owned(),
            status: if existing.is_empty() {
                InjectStatus::Created
            } else {
                InjectStatus::Updated
            },
            content,
            chmod_exec: false,
        });
    }
    Ok(ClaudeMdPlan {
        plan,
        pending,
        skipped,
        removals,
        warnings,
        inspected,
    })
}

fn computed_entry(id: &str, status: AssetStatus) -> crate::render::block_plan::PlanEntry {
    crate::render::block_plan::PlanEntry {
        asset: PlanAsset::Computed { id: id.to_owned() },
        source: "core".to_owned(),
        status,
        details: None,
        new_content: None,
    }
}
