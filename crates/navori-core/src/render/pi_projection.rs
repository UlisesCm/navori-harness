//! What the Pi engine derives from config and plugins (spec 0059 T20): the hook binding table
//! (`engines/pi/hook-bindings.ts`), the plugin projection (`engines/pi/plugin-projection.ts`),
//! the guard's permission rules (`buildPiPermissionRules`), the MCP diagnostics
//! (`engines/pi/mcp-diagnosis.ts`) and the `piMap` migration notice (`lib/diagnose/pi-health.ts`).
//!
//! A plugin that declares `hooks` delegates (its Pi bindings are not modeled); no bundled plugin
//! is native on Pi, so `piLivePlugins` keeps every plugin.

use std::path::Path;

use crate::STAMP_VERSION;
use crate::js_json::{self, JsValue};
use crate::markers::{
    CommentStyle, InjectOptions, InjectStatus, MarkerMeta, inject_managed_section,
    remove_managed_section,
};
use crate::render::agent_mcp_tools::derive_mcp_tools;
use crate::render::assets;
use crate::render::codex_rules::translate_shell_pattern;
use crate::render::codex_skills::skill_inject_target;
use crate::render::collect::{PendingWrite, RepoView, read_if_exists};
use crate::render::context::Lang;
use crate::render::frontmatter::strip_frontmatter;
use crate::render::harness_plan::{is_agent_enabled, is_hook_enabled};
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::managed_file::parse_asset;
use crate::render::pi_roles::{
    PI_KNOWLEDGE_READONLY, PiKnowledgeGrants, is_pi_child_role, pi_knowledge_tool_name,
};
use crate::render::plan::{condition_orchestration, engines_include};
use crate::render::plugins::LoadedPlugin;

/// The TS would throw, or resolves something Rust leaves to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PiDelegate;

/// `PiHookBinding` without `when` (already applied).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiHookBinding {
    /// Script id.
    pub script: &'static str,
    /// Bridge event.
    pub on: &'static str,
    /// Pi tools the row matches.
    pub tools: Option<&'static [&'static str]>,
    /// `parent`, `child` or `all`.
    pub scope: &'static str,
    /// `enforced`, `advisory` or `lifecycle`.
    pub class: &'static str,
    /// May answer `ask`.
    pub interactive: bool,
    /// Deadline.
    pub timeout_ms: u32,
    /// `skipOnError`.
    pub skip_on_error: bool,
}

/// When a binding row is installed.
#[derive(Clone, Copy)]
enum When {
    Always,
    /// `isHookEnabled(config, id)` (`hook-bindings.ts:115/163/181`).
    Hook(&'static str),
    QualityGateFast,
    Publisher,
    ScribeOwnsMarkdown,
    VerifyOnStop,
}

const BASH: Option<&[&str]> = Some(&["bash"]);
const WRITES: Option<&[&str]> = Some(&["bash", "edit", "write"]);

/// `PI_HOOK_BINDINGS`, in table order.
const BINDINGS: [(PiHookBinding, When); 12] = [
    (
        row(
            "guard-destructive",
            "tool_call",
            BASH,
            "all",
            "enforced",
            true,
            15_000,
            false,
        ),
        When::Always,
    ),
    (
        row(
            "quality-gate-pre-commit",
            "tool_call",
            BASH,
            "all",
            "enforced",
            true,
            600_000,
            false,
        ),
        When::QualityGateFast,
    ),
    (
        row(
            "pr-publisher-confirm",
            "tool_call",
            BASH,
            "all",
            "enforced",
            true,
            10_000,
            false,
        ),
        When::Publisher,
    ),
    (
        row(
            "comment-draft-confirm",
            "tool_call",
            BASH,
            "all",
            "enforced",
            true,
            10_000,
            false,
        ),
        When::Always,
    ),
    (
        row(
            "master-accept-confirm",
            "tool_call",
            BASH,
            "all",
            "enforced",
            true,
            10_000,
            false,
        ),
        When::Hook("master-accept-confirm"),
    ),
    (
        row(
            "subagent-no-background",
            "tool_call",
            BASH,
            "child",
            "enforced",
            false,
            10_000,
            false,
        ),
        When::Always,
    ),
    (
        row(
            "implementer-no-markdown",
            "tool_call",
            WRITES,
            "child",
            "enforced",
            false,
            10_000,
            false,
        ),
        When::ScribeOwnsMarkdown,
    ),
    (
        row(
            "managed-drift-watch",
            "tool_result",
            WRITES,
            "all",
            "advisory",
            false,
            10_000,
            false,
        ),
        When::Always,
    ),
    (
        row(
            "routing-watch",
            "tool_result",
            Some(&["bash", "edit", "write", "navori_subagent"]),
            "parent",
            "advisory",
            false,
            10_000,
            true,
        ),
        When::Hook("routing-watch"),
    ),
    (
        row(
            "worktree-reclaim",
            "session_shutdown",
            None,
            "parent",
            "lifecycle",
            false,
            12_000,
            false,
        ),
        When::Always,
    ),
    (
        row(
            "audit-mode-close",
            "session_shutdown",
            None,
            "parent",
            "lifecycle",
            false,
            3_000,
            false,
        ),
        When::Hook("audit-mode-close"),
    ),
    (
        row(
            "stop-verify-reminder",
            "agent_before_settle",
            None,
            "parent",
            "advisory",
            false,
            10_000,
            false,
        ),
        When::VerifyOnStop,
    ),
];

#[allow(
    clippy::too_many_arguments,
    clippy::fn_params_excessive_bools,
    reason = "one table row, field for field"
)]
const fn row(
    script: &'static str,
    on: &'static str,
    tools: Option<&'static [&'static str]>,
    scope: &'static str,
    class: &'static str,
    interactive: bool,
    timeout_ms: u32,
    skip_on_error: bool,
) -> PiHookBinding {
    PiHookBinding {
        script,
        on,
        tools,
        scope,
        class,
        interactive,
        timeout_ms,
        skip_on_error,
    }
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

/// JS truthiness.
fn truthy(value: Option<&JsValue>) -> bool {
    crate::render::block_plan::truthy(value.unwrap_or(&JsValue::Undefined))
}

/// `activePiHookBindings(config)`.
#[must_use]
pub fn active_pi_hook_bindings(config: &JsValue) -> Vec<PiHookBinding> {
    BINDINGS
        .iter()
        .filter(|(_, when)| match when {
            When::Always => true,
            When::Hook(id) => is_hook_enabled(config, id, None),
            When::QualityGateFast => {
                truthy(get(config, "qualityGate").and_then(|g| get(g, "fast")))
            }
            When::Publisher => is_agent_enabled(config, "publisher"),
            When::ScribeOwnsMarkdown => {
                truthy(get(config, "harness").and_then(|h| get(h, "scribeOwnsMarkdown")))
            }
            When::VerifyOnStop => truthy(get(config, "hooks").and_then(|h| get(h, "verifyOnStop"))),
        })
        .map(|(binding, _)| binding.clone())
        .collect()
}

/// `piHookPath`.
#[must_use]
pub fn pi_hook_path(script: &str) -> String {
    format!(".pi/navori/hooks/{script}.sh")
}

/// `hookExtensionTarget(target, "pi")`.
#[must_use]
pub fn pi_hook_extension_target(target: &str) -> Option<String> {
    target
        .strip_prefix(".claude/hooks/")
        .map(|hook| format!(".pi/navori/hooks/{hook}"))
}

/// `piInstalledPluginScripts(plugins, [], coreHookPaths)`: a plugin's scripts install when one of
/// its hook extensions rides inside an installed core hook.
#[must_use]
pub fn pi_installed_plugin_scripts(plugins: &[LoadedPlugin], core_hooks: &[String]) -> Vec<String> {
    let mut installed: Vec<String> = Vec::new();
    for plugin in plugins {
        let hosted = plugin.hook_extension_assets.iter().any(|extension| {
            pi_hook_extension_target(&extension.target).is_some_and(|t| core_hooks.contains(&t))
        });
        if !hosted {
            continue;
        }
        for script in &plugin.script_assets {
            let path = format!(".pi/navori/scripts/{}", script.dest);
            if !installed.contains(&path) {
                installed.push(path);
            }
        }
    }
    installed
}

/// `buildPiPermissionRules(rules)`: `deny` lines, then `ask` lines, each distinct; `-` when none.
#[must_use]
pub fn build_pi_permission_rules(ask: &[JsValue], deny: &[JsValue]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for (decision, patterns) in [("deny", deny), ("ask", ask)] {
        let mut seen: Vec<String> = Vec::new();
        for pattern in patterns {
            let Some(pattern) = text(Some(pattern)) else {
                continue;
            };
            if let Some(translated) = translate_shell_pattern(&pattern) {
                let line = format!("{decision} {}", translated.tokens.join(" "));
                if !seen.contains(&line) {
                    seen.push(line);
                }
            }
        }
        lines.extend(seen);
    }
    if lines.is_empty() {
        "-".to_owned()
    } else {
        lines.join("\n")
    }
}

fn plugin_text(plugin: &LoadedPlugin, path: &str) -> Result<&'static str, PiDelegate> {
    assets::plugin(&plugin.dir, path)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .ok_or(PiDelegate)
}

fn has_mcp_server(plugin: &LoadedPlugin) -> bool {
    !matches!(
        get(&plugin.manifest, "mcpServer"),
        None | Some(JsValue::Undefined | JsValue::Null)
    )
}

fn plugin_meta(plugin: &LoadedPlugin) -> MarkerMeta {
    MarkerMeta {
        source: Some(format!("@navori/plugin-{}", plugin.manifest_id())),
        version: Some(STAMP_VERSION.to_owned()),
        ..MarkerMeta::default()
    }
}

fn grants_of<'a>(grants: &'a PiKnowledgeGrants, role: &str) -> &'a [String] {
    grants
        .iter()
        .find(|(r, _)| r == role)
        .map_or(&[], |(_, names)| names.as_slice())
}

/// `prefixKnowledgeNames(prose, role, grants)`.
#[must_use]
pub fn prefix_knowledge_names(prose: &str, role: &str, grants: &PiKnowledgeGrants) -> String {
    let mut out = prose.to_owned();
    for held in grants_of(grants, role) {
        let name = held.strip_prefix("navori_").unwrap_or(held);
        out = out.replace(&format!("`{name}`"), &format!("`{held}`"));
    }
    out
}

/// `rolePluginProse(role, plugins, config, grants)`.
///
/// # Errors
/// [`PiDelegate`] where the TS throws.
pub fn role_plugin_prose(
    role: &str,
    plugins: &[LoadedPlugin],
    config: &JsValue,
    grants: &PiKnowledgeGrants,
) -> Result<String, PiDelegate> {
    let mut prose = String::new();
    let held = grants_of(grants, role);
    let target = format!(".claude/agents/{role}.md");
    for plugin in plugins {
        let id = plugin.manifest_id();
        let table = PI_KNOWLEDGE_READONLY
            .iter()
            .find(|(p, _)| *p == id)
            .map_or(&[][..], |(_, tools)| *tools);
        let granted = table
            .iter()
            .any(|tool| held.contains(&pi_knowledge_tool_name(tool)));
        if has_mcp_server(plugin) && !granted {
            continue;
        }
        for skill in &plugin.skill_assets {
            if skill.inject_into.as_deref() != Some(target.as_str()) {
                continue;
            }
            let extension = parse_asset(plugin_text(plugin, &skill.path)?, CommentStyle::Html);
            let body = interpolate(
                &condition_orchestration(&extension.managed_body, config, "pi")
                    .map_err(|_| PiDelegate)?,
                config,
                &InterpolateOptions::default(),
            );
            prose.push_str("\n\n");
            prose.push_str(&if has_mcp_server(plugin) {
                prefix_knowledge_names(&body, role, grants)
            } else {
                body
            });
        }
    }
    Ok(prose)
}

/// `subBlockBody`: the plugin skill without frontmatter, conditioned for Pi and interpolated.
fn sub_block_body(
    plugin: &LoadedPlugin,
    path: &str,
    config: &JsValue,
) -> Result<String, PiDelegate> {
    let conditioned =
        condition_orchestration(strip_frontmatter(plugin_text(plugin, path)?), config, "pi")
            .map_err(|_| PiDelegate)?;
    Ok(interpolate(
        &conditioned,
        config,
        &InterpolateOptions::default(),
    ))
}

/// `extendWithOrchestratorBlocks(body, plugins, config)`.
///
/// # Errors
/// [`PiDelegate`] where the TS throws.
pub fn extend_with_orchestrator_blocks(
    body: &str,
    plugins: &[LoadedPlugin],
    config: &JsValue,
    ambient_floor: Option<&str>,
) -> Result<String, PiDelegate> {
    let mut out = body.to_owned();
    for plugin in plugins {
        for skill in &plugin.skill_assets {
            if skill.inject_into.as_deref() != Some(".claude/agents/orchestrator.md") {
                continue;
            }
            out = inject_managed_section(
                &out,
                &skill.id,
                &sub_block_body(plugin, &skill.path, config)?,
                &plugin_meta(plugin),
                InjectOptions {
                    ambient_floor,
                    ..InjectOptions::default()
                },
            )
            .output;
        }
    }
    Ok(out)
}

fn store(pending: &mut Vec<PendingWrite>, rel: &str, content: String) {
    match pending.iter_mut().find(|w| w.rel_path == rel) {
        Some(write) => write.content = content,
        None => pending.push(PendingWrite {
            rel_path: rel.to_owned(),
            content,
            status: InjectStatus::Updated,
            chmod_exec: false,
        }),
    }
}

fn current(
    view: &dyn RepoView,
    pending: &[PendingWrite],
    rel: &str,
) -> Result<Option<String>, PiDelegate> {
    if let Some(write) = pending.iter().find(|w| w.rel_path == rel) {
        return Ok(Some(write.content.clone()));
    }
    read_if_exists(view, rel).map_err(|_| PiDelegate)
}

/// `applySkillSubBlocks`: enabled plugins' skill extensions injected (an edited or newer block is
/// left alone), disabled plugins' stripped.
///
/// # Errors
/// [`PiDelegate`] where the TS throws.
#[allow(clippy::too_many_arguments, reason = "mirrors the TS input object")]
pub fn apply_pi_skill_sub_blocks(
    view: &dyn RepoView,
    config: &JsValue,
    enabled: &[LoadedPlugin],
    disabled: &[LoadedPlugin],
    pending: &mut Vec<PendingWrite>,
    warnings: &mut Vec<String>,
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<(), PiDelegate> {
    for plugin in enabled {
        for skill in &plugin.skill_assets {
            let Some(id) = skill.inject_into.as_deref().and_then(skill_inject_target) else {
                continue;
            };
            let rel = format!(".agents/skills/{id}/SKILL.md");
            let Some(base) = current(view, pending, &rel)? else {
                warnings.push(crate::i18n::plugin_skill_not_injected(
                    lang,
                    &skill.id,
                    &plugin.manifest_id(),
                    &rel,
                ));
                continue;
            };
            let injected = inject_managed_section(
                &base,
                &skill.id,
                &sub_block_body(plugin, &skill.path, config)?,
                &plugin_meta(plugin),
                InjectOptions {
                    ambient_floor,
                    ..InjectOptions::default()
                },
            );
            if matches!(
                injected.status,
                InjectStatus::UserModifiedSkipped | InjectStatus::DowngradeSkipped
            ) {
                continue;
            }
            if injected.output != base {
                store(pending, &rel, injected.output);
            }
        }
    }
    for plugin in disabled {
        for skill in &plugin.skill_assets {
            let Some(id) = skill.inject_into.as_deref().and_then(skill_inject_target) else {
                continue;
            };
            let rel = format!(".agents/skills/{id}/SKILL.md");
            let Some(base) = current(view, pending, &rel)? else {
                continue;
            };
            let stripped = remove_managed_section(&base, &skill.id, CommentStyle::Html);
            if stripped != base {
                store(pending, &rel, stripped);
            }
        }
    }
    Ok(())
}

/// `mcpPluginIds(config)`: enabled plugins with an MCP server, in config order.
#[must_use]
pub fn mcp_plugin_ids(plugins: &[LoadedPlugin]) -> Vec<String> {
    plugins
        .iter()
        .filter(|p| has_mcp_server(p))
        .map(LoadedPlugin::manifest_id)
        .collect()
}

/// `mcpRoleDiagnostics(config, roles, grants)`.
#[must_use]
pub fn mcp_role_diagnostics(
    plugins: &[LoadedPlugin],
    roles: &[String],
    grants: &PiKnowledgeGrants,
) -> Vec<String> {
    let mut out = Vec::new();
    for plugin in plugins {
        if !has_mcp_server(plugin) {
            continue;
        }
        let id = plugin.manifest_id();
        let Some(JsValue::Array(skills)) = get(&plugin.manifest, "skills") else {
            continue;
        };
        for skill in skills {
            let Some(role) = text(get(skill, "injectInto")).and_then(|t| {
                t.strip_prefix(".claude/agents/")
                    .and_then(|r| r.strip_suffix(".md"))
                    .filter(|r| {
                        !r.is_empty()
                            && r.bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    })
                    .map(str::to_owned)
            }) else {
                continue;
            };
            // A parent role runs in the parent session, where MCP is available.
            if !roles.contains(&role) || !is_pi_child_role(&role) {
                continue;
            }
            let covered = PI_KNOWLEDGE_READONLY
                .iter()
                .find(|(p, _)| *p == id)
                .map_or(&[][..], |(_, tools)| *tools);
            let held = grants_of(grants, &role);
            if covered
                .iter()
                .any(|tool| held.contains(&pi_knowledge_tool_name(tool)))
            {
                continue;
            }
            let mcp_tools: Option<Vec<String>> = match get(skill, "mcpTools") {
                Some(JsValue::Array(items)) => {
                    Some(items.iter().filter_map(|i| text(Some(i))).collect())
                }
                _ => None,
            };
            let tools = derive_mcp_tools(plugin, mcp_tools.as_deref()).join(", ");
            out.push(format!(
                "Pi role {role} needs MCP tools from plugin {id} ({tools}) but is unavailable for them in children: Pi children run with --no-mcp, so direct, discovery and codemode MCP access are all off. Run that work from the parent session, or disable plugin {id} for Pi."
            ));
        }
    }
    out
}

/// One MCP server entry: enabled, and whether it defines its own transport.
struct McpEntry {
    enabled: bool,
    replaces: bool,
}

/// `mcpServerStates`'s `read`: `mcpServers` entries by normalized name.
fn read_servers(doc: Option<&JsValue>) -> Vec<(String, McpEntry)> {
    let Some(JsValue::Object(block)) = doc.and_then(|d| get(d, "mcpServers")) else {
        return Vec::new();
    };
    let mut out: Vec<(String, McpEntry)> = Vec::new();
    for (name, raw) in block.entries() {
        let JsValue::Object(raw) = raw else {
            continue;
        };
        let Some(name) = name.to_rust() else {
            continue;
        };
        let norm = name.replace('-', "_");
        let entry = McpEntry {
            enabled: raw.get("enabled") != Some(&JsValue::Bool(false)),
            replaces: ["command", "url", "type"].iter().any(|k| raw.has(k)),
        };
        match out.iter_mut().find(|(n, _)| *n == norm) {
            Some(slot) => slot.1 = entry,
            None => out.push((norm, entry)),
        }
    }
    out
}

/// `mcpServerDiagnostics(cwd, config)`, with Pi's agent dir resolved as the TS does.
///
/// # Errors
/// [`PiDelegate`] when an existing `mcp.json` is not JSON this parser reads (the TS's own
/// verdict on it is not reproduced).
pub fn mcp_server_diagnostics(
    cwd: &Path,
    plugins: &[LoadedPlugin],
) -> Result<Vec<String>, PiDelegate> {
    let ids = mcp_plugin_ids(plugins);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let agent_dir = match std::env::var_os("PI_CODING_AGENT_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::home_dir()
            .ok_or(PiDelegate)?
            .join(".pi")
            .join("agent"),
    };
    let read = |path: &Path| -> Result<Option<JsValue>, PiDelegate> {
        match std::fs::read(path) {
            Err(_) => Ok(None),
            Ok(bytes) => js_json::parse(&String::from_utf8_lossy(&bytes))
                .map(Some)
                .ok_or(PiDelegate),
        }
    };
    let global_doc = read(&agent_dir.join("mcp.json"))?;
    let project_doc = read(&cwd.join(".pi").join("mcp.json"))?;
    let global = read_servers(global_doc.as_ref());
    let project = read_servers(project_doc.as_ref());
    let mut out = Vec::new();
    for id in ids {
        let norm = id.replace('-', "_");
        let g = global.iter().find(|(n, _)| *n == norm).map(|(_, e)| e);
        let p = project.iter().find(|(n, _)| *n == norm).map(|(_, e)| e);
        let effective: Option<(bool, bool)> = match (p, g) {
            (None, g) => g.map(|g| (g.enabled, true)),
            (Some(p), _) if p.replaces => Some((p.enabled, true)),
            (Some(p), Some(_)) => Some((p.enabled, true)),
            (Some(_), None) => None,
        };
        if g.is_some_and(|g| g.enabled) && effective.is_some_and(|(enabled, _)| enabled) {
            continue;
        }
        if effective.is_some_and(|(enabled, _)| enabled) {
            out.push(format!(
                "Pi MCP server {id} (plugin {id}) is configured only in .pi/mcp.json: it takes effect only if you trust the project (/trust)."
            ));
            continue;
        }
        let state = if effective.is_none() {
            "is not configured"
        } else {
            "is disabled"
        };
        out.push(format!(
            "Pi MCP server {id} (plugin {id}) {state} in Pi's MCP config. Register it with: pi mcp add {id} [-l] -- <command> <args...> (add --env KEY=<value> if it needs credentials). Navori does not write Pi MCP config."
        ));
    }
    Ok(out)
}

/// `PI_MAP_MIGRATION_WARNING`.
pub const PI_MAP_MIGRATION_WARNING: &str = "Pi roles no longer take their model from models.codexMap: they now inherit the parent Pi model. Set models.piMap (opus/sonnet/haiku as provider/id) to pin them, or {} to keep inheriting and silence this warning.";

/// `piMapMigrationPending(config)`.
#[must_use]
pub fn pi_map_migration_pending(config: &JsValue) -> bool {
    let models = get(config, "models");
    let pi_map = models.and_then(|m| get(m, "piMap"));
    let codex_map = models.and_then(|m| get(m, "codexMap"));
    let renders_pi = engines_include(config, "pi");
    renders_pi
        && matches!(pi_map, None | Some(JsValue::Undefined))
        && matches!(codex_map, Some(JsValue::Object(map)) if map.entries().iter().any(|(_, v)| !matches!(v, JsValue::Undefined)))
}
