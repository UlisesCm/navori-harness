//! The Pi child roles (`engines/pi/role-tools.ts`) and their read-only knowledge tools
//! (`engines/pi/knowledge-tools.ts`), spec 0059 T20.

use crate::js_json::JsValue;
use crate::render::codex_policies::core_agent_entries;
use crate::render::plugins::LoadedPlugin;

/// `PI_ROLE_NAMES`: the dispatchable child roles, in order.
pub const PI_ROLE_NAMES: [&str; 6] = [
    "scout",
    "implementer",
    "reviewer",
    "scribe",
    "auditor",
    "architect",
];

/// `PI_PARENT_ROLES` (#1496): rendered as `.pi/agents/<role>.md` with `tools: []` for the parent
/// session to follow, never dispatched as a child.
pub const PI_PARENT_ROLES: [&str; 1] = ["publisher"];

/// `isPiChildRole`.
#[must_use]
pub fn is_pi_child_role(role: &str) -> bool {
    PI_ROLE_NAMES.contains(&role)
}

/// `isPiParentRole`.
#[must_use]
pub fn is_pi_parent_role(role: &str) -> bool {
    PI_PARENT_ROLES.contains(&role)
}

/// `isPiRenderedRole`: Pi renders `.pi/agents/<id>.md` for a child or a parent role.
#[must_use]
pub fn is_pi_rendered_role(role: &str) -> bool {
    is_pi_child_role(role) || is_pi_parent_role(role)
}

/// `PI_ROLE_TOOLS[role]`; `None` for a role that is not a dispatchable child.
#[must_use]
pub fn pi_role_base_tools(role: &str) -> Option<&'static [&'static str]> {
    Some(match role {
        "scout" => &["read", "grep", "find", "ls", "write"],
        "implementer" | "scribe" => &["read", "grep", "find", "ls", "bash", "edit", "write"],
        "reviewer" | "auditor" | "architect" => &["read", "grep", "find", "ls", "bash", "write"],
        _ => return None,
    })
}

/// `PI_KNOWLEDGE_READONLY`, in table order.
pub const PI_KNOWLEDGE_READONLY: [(&str, &[&str]); 2] = [
    ("codegraph", &["codegraph_explore"]),
    ("engram", &["mem_search", "mem_get_observation"]),
];

/// `piKnowledgeToolName`.
#[must_use]
pub fn pi_knowledge_tool_name(tool: &str) -> String {
    format!("navori_{tool}")
}

/// `PI_KNOWLEDGE_TOOL_NAMES`, in table order.
#[must_use]
pub fn pi_knowledge_tool_names() -> Vec<String> {
    PI_KNOWLEDGE_READONLY
        .iter()
        .flat_map(|(_, tools)| tools.iter().map(|t| pi_knowledge_tool_name(t)))
        .collect()
}

/// `PiKnowledgeGrants`: `(role, tool names)` for the roles that get any, in role order.
pub type PiKnowledgeGrants = Vec<(String, Vec<String>)>;

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

fn present(value: Option<&JsValue>) -> bool {
    !matches!(value, None | Some(JsValue::Undefined | JsValue::Null))
}

/// `deriveMcpToolEntries(manifest, mcpTools)`.
fn derive_mcp_tool_entries(manifest: &JsValue, mcp_tools: Option<&JsValue>) -> Vec<String> {
    if !present(get(manifest, "mcpServer")) {
        return Vec::new();
    }
    let id = text(get(manifest, "id")).unwrap_or_default();
    match mcp_tools {
        Some(JsValue::Array(tools)) if !tools.is_empty() => tools
            .iter()
            .filter_map(|t| text(Some(t)))
            .map(|t| format!("mcp__{id}__{t}"))
            .collect(),
        _ => vec![format!("mcp__{id}__*")],
    }
}

/// `piKnowledgeGrants(plugins)`; `None` where the TS throws (an unreadable core agent).
#[must_use]
pub fn pi_knowledge_grants(plugins: &[LoadedPlugin]) -> Option<PiKnowledgeGrants> {
    let ordered_names = pi_knowledge_tool_names();
    let mut grants = Vec::new();
    for role in PI_ROLE_NAMES {
        let mut names: Vec<String> = Vec::new();
        for plugin in plugins {
            let id = plugin.manifest_id();
            let Some((_, table)) = PI_KNOWLEDGE_READONLY.iter().find(|(p, _)| *p == id) else {
                continue;
            };
            if !present(get(&plugin.manifest, "mcpServer")) {
                continue;
            }
            let mut entries = core_agent_entries(role)?;
            if let Some(JsValue::Array(skills)) = get(&plugin.manifest, "skills") {
                for skill in skills {
                    if text(get(skill, "injectInto")) != Some(format!(".claude/agents/{role}.md")) {
                        continue;
                    }
                    entries.extend(derive_mcp_tool_entries(
                        &plugin.manifest,
                        get(skill, "mcpTools"),
                    ));
                }
            }
            // `grantedNames`: the plugin's own entries, the wildcard meaning the whole table.
            let prefix = format!("mcp__{id}__");
            let granted: Vec<String> = entries
                .iter()
                .filter_map(|e| e.strip_prefix(prefix.as_str()).map(str::to_owned))
                .collect();
            let granted: Vec<String> = if granted.iter().any(|g| g == "*") {
                table.iter().map(|t| (*t).to_owned()).collect()
            } else {
                granted
            };
            for tool in granted {
                if table.contains(&tool.as_str()) {
                    names.push(pi_knowledge_tool_name(&tool));
                }
            }
        }
        let ordered: Vec<String> = ordered_names
            .iter()
            .filter(|n| names.contains(n))
            .cloned()
            .collect();
        if !ordered.is_empty() {
            grants.push((role.to_owned(), ordered));
        }
    }
    Some(grants)
}

/// `piRoleTools(role, grants)`: base tools plus the role's knowledge grants; a parent role gets none.
#[must_use]
pub fn pi_role_tools(role: &str, grants: &PiKnowledgeGrants) -> Vec<String> {
    if is_pi_parent_role(role) {
        return Vec::new();
    }
    let mut tools: Vec<String> = pi_role_base_tools(role)
        .unwrap_or_default()
        .iter()
        .map(|t| (*t).to_owned())
        .collect();
    if let Some((_, names)) = grants.iter().find(|(r, _)| r == role) {
        tools.extend(names.iter().cloned());
    }
    tools
}
