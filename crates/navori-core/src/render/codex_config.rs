//! `buildCodexConfigToml` (`engines/codex/build-config-toml.ts`, spec 0059 T19, D37): the body of
//! navori's block in `.codex/config.toml`, emitted as text line by line exactly as the TS writes
//! it (never through a TOML serializer, whose formatting would differ).

use std::path::Path;

use crate::js_json::JsValue;
use crate::render::codex_hooks::{codex_hook_command, resolve_codex_hooks};
use crate::render::codex_profile::{
    CodexProfileInput, read_native_codex_profile, resolve_codex_profile,
};
use crate::render::plugin_scripts::plugin_script_collisions;
use crate::render::plugins::LoadedPlugin;

/// Codex's own default `project_doc_max_bytes` (`core/src/agents_md.rs`).
const DEFAULT_PROJECT_DOC_MAX_BYTES: u64 = 32768;
/// Slack for the nested `AGENTS.md` files Codex chains onto the project one (D8 of 0035).
const PROJECT_DOC_MAX_BYTES_SLACK: u64 = 8192;

const FULL_ACCESS_WARNING: &str = "Codex usa danger-full-access por defecto: sin aislamiento de archivos ni red. on-request/user no exige aprobación para toda acción; verifica la política efectiva de la sesión (confianza del proyecto y overrides de CLI/host).";
const PATH_PERMISSIONS_WARNING: &str = "Permisos por ruta de Claude no tienen equivalente 1:1 en Codex: reglas ask/deny y hooks solo cubren sus matchers; guard-destructive intercepta únicamente Bash, no apply_patch ni escrituras por MCP/app.";

/// What `buildCodexConfigToml` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexConfigToml {
    /// Block body, ending in one newline.
    pub body: String,
    /// Warnings, in the TS order.
    pub warnings: Vec<String>,
}

/// `tomlString`: `JSON.stringify(value)`.
fn toml_string(value: &str) -> String {
    JsValue::string(value)
        .stringify(None)
        .unwrap_or_else(|| "\"\"".to_owned())
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

/// `nextPowerOfTwoAtLeast`.
const fn next_power_of_two_at_least(n: u64) -> u64 {
    let mut p = 1;
    while p < n {
        p *= 2;
    }
    p
}

/// `[mcp_servers."<id>"]` lines for a validated `mcpServer` (string `command`, string `args`, a
/// string record `env`); `None` for any other shape, which the TS schema would have rejected.
fn mcp_server_lines(id: &str, server: &JsValue) -> Option<Vec<String>> {
    let command = text(get(server, "command"))?;
    let args = match get(server, "args") {
        None | Some(JsValue::Undefined) => Vec::new(),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| text(Some(item)))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let mut lines = vec![
        String::new(),
        format!("[mcp_servers.{}]", toml_string(id)),
        format!("command = {}", toml_string(&command)),
        format!(
            "args = [{}]",
            args.iter()
                .map(|arg| toml_string(arg))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ];
    match get(server, "env") {
        None | Some(JsValue::Undefined) => {}
        Some(JsValue::Object(env)) => {
            let entries = env
                .entries()
                .iter()
                .map(|(key, value)| {
                    Some(format!(
                        "{} = {}",
                        toml_string(&key.to_rust()?),
                        toml_string(&text(Some(value))?)
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            if !entries.is_empty() {
                lines.push(format!("env = {{ {} }}", entries.join(", ")));
            }
        }
        Some(_) => return None,
    }
    Some(lines)
}

/// `buildCodexConfigToml(config, plugins, wsSubpath, agentsMdBytes, cwd)`. `catalog` is the
/// model catalog the TS reads from `defaultCodexCatalogPath()`.
///
/// `None` delegates to the TS: a plugin declares `hooks`, the orchestrator's model resolution is
/// the TS's (see [`crate::render::codex_catalog::ModelDelegate`]), or a manifest field has a
/// shape the TS schema would have rejected.
#[must_use]
pub fn build_codex_config_toml(
    config: &JsValue,
    plugins: &[LoadedPlugin],
    ws_subpath: &str,
    agents_md_bytes: u64,
    cwd: Option<&Path>,
    catalog: Option<&Path>,
) -> Option<CodexConfigToml> {
    let mut lines: Vec<String> = vec![
        "sandbox_mode = \"danger-full-access\"".to_owned(),
        "approval_policy = \"on-request\"".to_owned(),
        "approvals_reviewer = \"user\"".to_owned(),
    ];
    let existing = cwd.map(|cwd| read_native_codex_profile(cwd, "orchestrator"));
    let section = |name: &str| get(config, name).and_then(|s| text(get(s, "orchestrator")));
    let main = resolve_codex_profile(
        config,
        &CodexProfileInput {
            name: "orchestrator".to_owned(),
            tier: section("models"),
            effort: section("effort"),
            previous: existing.as_ref().and_then(|native| native.model.clone()),
        },
        catalog,
    )
    .ok()?;
    let user_model = existing
        .as_ref()
        .is_some_and(|native| native.user_model.as_deref().is_some_and(|v| !v.is_empty()));
    let user_effort = existing
        .as_ref()
        .is_some_and(|native| native.user_effort.as_deref().is_some_and(|v| !v.is_empty()));
    if let Some(model) = main.model.would_render.as_deref().filter(|v| !v.is_empty())
        && !user_model
    {
        lines.push(format!("model = {}", toml_string(model)));
    }
    if let Some(effort) = main
        .effort
        .would_render
        .as_deref()
        .filter(|v| !v.is_empty())
        && !user_effort
    {
        lines.push(format!("model_reasoning_effort = {}", toml_string(effort)));
    }
    if agents_md_bytes > DEFAULT_PROJECT_DOC_MAX_BYTES {
        lines.push(format!(
            "project_doc_max_bytes = {}",
            next_power_of_two_at_least(agents_md_bytes + PROJECT_DOC_MAX_BYTES_SLACK)
        ));
    }
    lines.extend(["", "[features]", "hooks = true", "multi_agent = true"].map(str::to_owned));

    for hook in resolve_codex_hooks(config, plugins)? {
        let command = codex_hook_command(&hook, ws_subpath);
        lines.push(String::new());
        lines.push(format!("[[hooks.{}]]", hook.event));
        if let Some(matcher) = &hook.matcher {
            lines.push(format!("matcher = {}", toml_string(matcher)));
        }
        lines.extend([
            String::new(),
            format!("[[hooks.{}.hooks]]", hook.event),
            "type = \"command\"".to_owned(),
            format!("command = {}", toml_string(&command)),
            format!("timeout = {}", hook.timeout),
        ]);
        if let Some(message) = &hook.status_message {
            lines.push(format!("statusMessage = {}", toml_string(message)));
        }
    }

    // `resolvePluginCodexHooks(plugins).warnings`: with no plugin `hooks` (the rest delegates),
    // only the script collisions.
    let mut warnings: Vec<String> = plugin_script_collisions(plugins)
        .iter()
        .map(|dest| {
            format!(
                "Destino .codex/scripts/{dest} declarado varias veces; scripts y hooks omitidos."
            )
        })
        .collect();
    warnings.push(FULL_ACCESS_WARNING.to_owned());
    warnings.push(PATH_PERMISSIONS_WARNING.to_owned());
    for plugin in plugins {
        let id = plugin.manifest_id();
        match get(&plugin.manifest, "mcpServer") {
            None | Some(JsValue::Undefined) => {
                let external = get(&plugin.manifest, "externalTool")
                    .is_some_and(|tool| !matches!(tool, JsValue::Undefined | JsValue::Null));
                if !external {
                    warnings.push(format!(
                        "Plugin '{id}' no declara mcpServer ni externalTool; se omitió de .codex/config.toml."
                    ));
                }
            }
            Some(server) => lines.extend(mcp_server_lines(&id, server)?),
        }
    }

    let joined = lines.join("\n");
    Some(CodexConfigToml {
        body: format!("{}\n", crate::posix::js_trim(&joined)),
        warnings,
    })
}
