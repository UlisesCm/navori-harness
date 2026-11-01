//! Codex agents (`placeAgent` and `buildAgentToml` of `engines/codex/index.ts`, spec 0059 T19):
//! one `.codex/agents/<id>.toml` per planned agent, its developer instructions adapted to Codex,
//! with plugin skills that target the agent appended and its model profile resolved.

use std::path::Path;

use crate::js_json::JsValue;
use crate::markers::CommentStyle;
use crate::render::assets;
use crate::render::codex_compat::adapt_harness_text_for_codex;
use crate::render::codex_profile::{
    planned_codex_profile_input, read_native_codex_profile, resolve_codex_profile,
};
use crate::render::collect::{Collected, RepoView, collect_body};
use crate::render::context::Lang;
use crate::render::harness_files::asset_text;
use crate::render::harness_plan::PlannedAgent;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::managed_file::parse_asset;
use crate::render::plan::condition_orchestration;
use crate::render::plugins::LoadedPlugin;

/// The TS would throw, or resolves something Rust leaves to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexDelegate;

/// `buildAgentToml`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToml {
    /// Block body.
    pub body: String,
    /// Adapted description, for the `AGENTS.md` agent catalog.
    pub description: String,
}

/// What the Codex agent placements contribute.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexAgents {
    /// One entry per placed agent, in plan order.
    pub files: Vec<Collected>,
    /// `agentCatalog`: `(id, description)` of every placed agent.
    pub catalog: Vec<(String, String)>,
    /// Warnings pushed to the sink, in order.
    pub warnings: Vec<String>,
}

/// The body of a Codex prose asset: orchestration conditions for `codex`, interpolated, adapted.
fn adapted_body(managed_body: &str, config: &JsValue) -> Result<String, CodexDelegate> {
    let conditioned =
        condition_orchestration(managed_body, config, "codex").map_err(|_| CodexDelegate)?;
    // `pluginExtraVars(config)` is `{}`.
    adapt(&interpolate(
        &conditioned,
        config,
        &InterpolateOptions::default(),
    ))
}

/// `adaptHarnessTextForCodex`.
fn adapt(text: &str) -> Result<String, CodexDelegate> {
    adapt_harness_text_for_codex(text).ok_or(CodexDelegate)
}

/// `frontmatter[key]`.
fn field<'a>(frontmatter: &'a [(String, String)], key: &str) -> Option<&'a str> {
    frontmatter
        .iter()
        .find_map(|(k, v)| (k == key).then_some(v.as_str()))
}

fn json_string(value: &str) -> String {
    JsValue::string(value)
        .stringify(None)
        .unwrap_or_else(|| "\"\"".to_owned())
}

/// `buildAgentToml(source, config, plugins, warningsSink, cwd)`; `catalog` is the model catalog.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws or the model resolution is the TS's.
pub fn build_agent_toml(
    source: &PlannedAgent,
    config: &JsValue,
    plugins: &[LoadedPlugin],
    warnings: &mut Vec<String>,
    cwd: &Path,
    catalog: Option<&Path>,
) -> Result<AgentToml, CodexDelegate> {
    let raw = asset_text(&source.asset).map_err(|_| CodexDelegate)?;
    let parsed = parse_asset(&raw, CommentStyle::Html);
    let description = adapt(&interpolate(
        field(&parsed.frontmatter, "description").unwrap_or(source.id.as_str()),
        config,
        &InterpolateOptions::default(),
    ))?;
    let mut instructions = adapted_body(&parsed.managed_body, config)?;
    let target = format!(".claude/agents/{}.md", source.id);
    for plugin in plugins {
        for skill in &plugin.skill_assets {
            if skill.inject_into.as_deref() != Some(target.as_str()) {
                continue;
            }
            let bytes = assets::plugin(&plugin.dir, &skill.path).ok_or(CodexDelegate)?;
            let text = std::str::from_utf8(bytes).map_err(|_| CodexDelegate)?;
            let extension = parse_asset(text, CommentStyle::Html);
            instructions.push_str("\n\n");
            instructions.push_str(&adapted_body(&extension.managed_body, config)?);
        }
    }

    let mut input = planned_codex_profile_input(source, config).map_err(|_| CodexDelegate)?;
    input.previous = read_native_codex_profile(cwd, &source.id).model;
    let profile = resolve_codex_profile(config, &input, catalog).map_err(|_| CodexDelegate)?;
    warnings.extend(profile.diagnostics);
    let sandbox = source.sandbox.unwrap_or("workspace-write");
    let mut lines = vec![
        format!("name = {}", json_string(&source.id)),
        format!("description = {}", json_string(&description)),
        format!(
            "developer_instructions = {}",
            json_string(crate::posix::js_trim(&instructions))
        ),
    ];
    if sandbox == "read-only" {
        lines.push("sandbox_mode = \"read-only\"".to_owned());
    }
    if let Some(model) = profile
        .model
        .would_render
        .as_deref()
        .filter(|m| !m.is_empty())
    {
        if profile.model.source == Some(crate::render::codex_catalog::CodexModelSource::Fallback) {
            let warning = format!(
                "Codex model {model} is a last-known candidate; catalog freshness/availability is unverified."
            );
            if !warnings.contains(&warning) {
                warnings.push(warning);
            }
        }
        lines.push(format!("model = {}", json_string(model)));
    }
    if let Some(effort) = profile
        .effort
        .would_render
        .as_deref()
        .filter(|e| !e.is_empty())
    {
        lines.push(format!("model_reasoning_effort = {}", json_string(effort)));
    }
    Ok(AgentToml {
        body: format!("{}\n", lines.join("\n")),
        description,
    })
}

/// `placeAgent` over the planned agents, each collected as a shell-marked body request.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws or the model resolution is the TS's.
#[allow(
    clippy::too_many_arguments,
    reason = "mirrors the adapter context the TS closes over"
)]
pub fn collect_codex_agents(
    view: &dyn RepoView,
    cwd: &Path,
    agents: &[PlannedAgent],
    config: &JsValue,
    plugins: &[LoadedPlugin],
    catalog: Option<&Path>,
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<CodexAgents, CodexDelegate> {
    let mut out = CodexAgents::default();
    for agent in agents {
        let path = format!(".codex/agents/{}.toml", agent.id);
        if view.exists(&path) && !read_native_codex_profile(cwd, &agent.id).managed {
            out.warnings.push(format!(
                "Preserved user-owned native agent at {path}; resolve the managed placement collision before rendering this role."
            ));
            continue;
        }
        let toml = build_agent_toml(agent, config, plugins, &mut out.warnings, cwd, catalog)?;
        out.catalog.push((agent.id.clone(), toml.description));
        let collected = collect_body(
            view,
            &path,
            &format!("{}-codex-base", agent.id),
            &toml.body,
            CommentStyle::Shell,
            ambient_floor,
            lang,
        )
        .map_err(|_| CodexDelegate)?;
        out.files.push(collected);
    }
    Ok(out)
}
