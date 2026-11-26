//! `engines/claude/agent-mcp-tools.ts` (spec 0058 T14): the `tools:` grant that ships with a
//! plugin's prose injected into an agent, and its inverse.

use crate::js_json::JsValue;
use crate::render::frontmatter::{
    get_frontmatter_field, js_line_starts, split_frontmatter, split_tool_list,
};
use crate::render::plugins::LoadedPlugin;

/// Inject targets whose `tools:` gates MCP access.
const AGENTS_DIR: &str = ".claude/agents/";

/// `deriveMcpToolEntries`: the curated `mcp__<id>__<tool>` list, the whole-server wildcard, or
/// nothing for a plugin without an MCP server.
#[must_use]
pub fn derive_mcp_tools(plugin: &LoadedPlugin, mcp_tools: Option<&[String]>) -> Vec<String> {
    let JsValue::Object(manifest) = &plugin.manifest else {
        return Vec::new();
    };
    if matches!(
        manifest.get("mcpServer"),
        None | Some(JsValue::Undefined | JsValue::Null)
    ) {
        return Vec::new();
    }
    let id = plugin.manifest_id();
    match mcp_tools {
        Some(tools) if !tools.is_empty() => {
            tools.iter().map(|t| format!("mcp__{id}__{t}")).collect()
        }
        _ => vec![format!("mcp__{id}__*")],
    }
}

fn superseded_wildcard(plugin: &LoadedPlugin, mcp_tools: Option<&[String]>) -> Option<String> {
    mcp_tools
        .is_some_and(|tools| !tools.is_empty())
        .then(|| format!("mcp__{}__*", plugin.manifest_id()))
}

/// `withAgentMcpTools`. `None` where Rust does not model the rewrite (a `$` in the new list,
/// which `String.prototype.replace` would expand).
#[must_use]
pub fn with_agent_mcp_tools(
    content: &str,
    plugin: &LoadedPlugin,
    target: &str,
    mcp_tools: Option<&[String]>,
) -> Option<String> {
    let wildcard = superseded_wildcard(plugin, mcp_tools);
    rewrite_agent_tools(content, plugin, target, mcp_tools, |have, tools| {
        let kept: Vec<String> = have
            .iter()
            .filter(|t| Some(*t) != wildcard.as_ref())
            .cloned()
            .collect();
        let missing: Vec<String> = tools
            .iter()
            .filter(|t| !kept.contains(t))
            .cloned()
            .collect();
        if missing.is_empty() && kept.len() == have.len() {
            return None;
        }
        Some(kept.into_iter().chain(missing).collect())
    })
}

/// `withoutAgentMcpTools`. `None` as in [`with_agent_mcp_tools`].
#[must_use]
pub fn without_agent_mcp_tools(
    content: &str,
    plugin: &LoadedPlugin,
    target: &str,
    mcp_tools: Option<&[String]>,
) -> Option<String> {
    let wildcard = superseded_wildcard(plugin, mcp_tools);
    rewrite_agent_tools(content, plugin, target, mcp_tools, |have, tools| {
        let kept: Vec<String> = have
            .iter()
            .filter(|t| !tools.contains(t) && Some(*t) != wildcard.as_ref())
            .cloned()
            .collect();
        (kept.len() != have.len()).then_some(kept)
    })
}

/// `rewriteAgentTools`: `next` gets the declared tools and the plugin's, and returns the new
/// list or `None` to leave the file alone.
fn rewrite_agent_tools(
    content: &str,
    plugin: &LoadedPlugin,
    target: &str,
    mcp_tools: Option<&[String]>,
    next: impl Fn(&[String], &[String]) -> Option<Vec<String>>,
) -> Option<String> {
    let unchanged = Some(content.to_owned());
    if !target.starts_with(AGENTS_DIR) {
        return unchanged;
    }
    let tools = derive_mcp_tools(plugin, mcp_tools);
    if tools.is_empty() {
        return unchanged;
    }
    let frontmatter = split_frontmatter(content).frontmatter;
    if frontmatter.is_empty() {
        return unchanged;
    }
    let Some(declared) = get_frontmatter_field(frontmatter, "tools") else {
        return unchanged;
    };
    let have: Vec<String> = split_tool_list(&declared)
        .into_iter()
        .filter(|t| !t.is_empty())
        .collect();
    let Some(result) = next(&have, &tools) else {
        return unchanged;
    };
    let replacement = format!("tools: {}", result.join(", "));
    if replacement.contains('$') {
        return None;
    }
    // `/^tools:[ \t]*[^\r\n]*/m`: the first line starting with `tools:`, to its line end.
    let Some(start) =
        js_line_starts(frontmatter).find(|&at| frontmatter[at..].starts_with("tools:"))
    else {
        return unchanged;
    };
    let end = frontmatter[start..]
        .find(['\r', '\n'])
        .map_or(frontmatter.len(), |len| start + len);
    let updated = format!(
        "{}{replacement}{}",
        &frontmatter[..start],
        &frontmatter[end..]
    );
    // Spliced at the first occurrence of the frontmatter text, as the TS does.
    let at = content.find(frontmatter)?;
    Some(format!(
        "{}{updated}{}",
        &content[..at],
        &content[at + frontmatter.len()..]
    ))
}
