//! The shell `case` bodies two Codex hooks interpolate: `{{rolePolicy}}` of `role-guard`
//! (`engines/shared/role-policy.ts`) and `{{engramPolicy}}` of `engram-write-guard`
//! (`engines/shared/engram-grant-policy.ts`), spec 0059 T19.

use crate::js_json::JsValue;
use crate::render::assets;
use crate::render::frontmatter::{get_frontmatter_field, split_frontmatter, split_tool_list};
use crate::render::interpolate::shell_single_quote;
use crate::render::plugins::load_plugin;

/// `COMMON_WRITES`.
const COMMON_WRITES: [&str; 1] = [".navori/state/handoffs/"];
/// `SPEC_WRITES`.
const SPEC_WRITES: [&str; 2] = [".navori/state/handoffs/", "{{sdd.specsDir}}/"];

/// `ROSTER_AGENTS` ids with their `writes`, in order.
const ROSTER_WRITES: [(&str, Option<&[&str]>); 8] = [
    ("orchestrator", None),
    ("implementer", None),
    ("reviewer", Some(&COMMON_WRITES)),
    ("scout", Some(&SPEC_WRITES)),
    ("auditor", Some(&SPEC_WRITES)),
    ("publisher", Some(&COMMON_WRITES)),
    ("scribe", None),
    ("architect", Some(&SPEC_WRITES)),
];

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

/// `cleanPrefix`: leading `./` runs, then leading and trailing slashes, removed.
fn clean_prefix(prefix: &str) -> &str {
    let mut rest = prefix;
    while let Some(stripped) = rest.strip_prefix("./") {
        rest = stripped;
    }
    rest.trim_start_matches('/').trim_end_matches('/')
}

/// `resolvePrefix`: `<path>/`, or `None` for the repo root.
fn resolve_prefix(entry: &str, specs_dir: &str) -> Option<String> {
    let replaced = entry.replace("{{sdd.specsDir}}", specs_dir);
    let clean = clean_prefix(&replaced);
    (!clean.is_empty() && clean != ".").then(|| format!("{clean}/"))
}

fn print_prefixes(prefixes: &[String]) -> String {
    let quoted: Vec<String> = prefixes.iter().map(|p| shell_single_quote(p)).collect();
    format!("printf '%s\\n' {}", quoted.join(" "))
}

/// `buildRolePolicyShell(config)` over the effective config.
#[must_use]
pub fn build_role_policy_shell(config: &JsValue) -> String {
    let specs_dir_raw = get(config, "sdd")
        .and_then(|sdd| text(get(sdd, "specsDir")))
        .unwrap_or_else(|| "specs".to_owned());
    let specs_dir = clean_prefix(&specs_dir_raw);
    let resolve = |entries: &[&str]| -> Vec<String> {
        entries
            .iter()
            .filter_map(|entry| resolve_prefix(entry, specs_dir))
            .collect()
    };
    let mut lines = vec!["  case \"$1\" in".to_owned()];
    for (id, writes) in ROSTER_WRITES {
        if let Some(writes) = writes {
            lines.push(format!("    {id}) {} ;;", print_prefixes(&resolve(writes))));
        }
    }
    lines.push(format!(
        "    *) {} ;;",
        print_prefixes(&resolve(&COMMON_WRITES))
    ));
    lines.push("  esac".to_owned());
    lines.join("\n")
}

/// Bare engram tool names of `mcp__engram__*` entries.
fn bare_names(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| entry.strip_prefix("mcp__engram__").map(str::to_owned))
        .collect()
}

/// `coreAgentEntries`: the core agent's own `tools:` entries.
pub(crate) fn core_agent_entries(id: &str) -> Option<Vec<String>> {
    let raw = std::str::from_utf8(assets::core(&format!("core-assets/agents/{id}.md"))?).ok()?;
    Some(
        get_frontmatter_field(split_frontmatter(raw).frontmatter, "tools")
            .map(|declared| {
                split_tool_list(&declared)
                    .into_iter()
                    .filter(|tool| !tool.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn print_tools(names: &[String]) -> String {
    if names.is_empty() {
        return ":".to_owned();
    }
    let quoted: Vec<String> = names.iter().map(|n| shell_single_quote(n)).collect();
    format!("printf '%s\\n' {}", quoted.join(" "))
}

/// `buildEngramPolicyShell()` with the bundled engram manifest; `None` where the TS throws.
#[must_use]
pub fn build_engram_policy_shell() -> Option<String> {
    let manifest = load_plugin("engram").ok()?.manifest;
    let has_server = !matches!(
        get(&manifest, "mcpServer"),
        None | Some(JsValue::Undefined | JsValue::Null)
    );
    let skills = match get(&manifest, "skills") {
        Some(JsValue::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let mut grants: Vec<(&str, Vec<String>)> = Vec::new();
    for (id, _) in ROSTER_WRITES {
        let mut names = bare_names(&core_agent_entries(id)?);
        for skill in &skills {
            let target = text(get(skill, "injectInto")).unwrap_or_default();
            if target != format!(".claude/agents/{id}.md") || !has_server {
                continue;
            }
            // `deriveMcpToolEntries`: curated `mcpTools`, else the whole server.
            let tools: Vec<String> = match get(skill, "mcpTools") {
                Some(JsValue::Array(items)) if !items.is_empty() => {
                    items.iter().filter_map(|t| text(Some(t))).collect()
                }
                _ => vec!["*".to_owned()],
            };
            names.extend(tools);
        }
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        names.dedup();
        grants.push((id, names));
    }
    let subagents: Vec<&Vec<String>> = grants
        .iter()
        .filter(|(id, names)| *id != "orchestrator" && !names.is_empty())
        .map(|(_, names)| names)
        .collect();
    let fallback: Vec<String> = match subagents.split_first() {
        None => Vec::new(),
        Some((first, rest)) => first
            .iter()
            .filter(|name| {
                rest.iter()
                    .all(|names| names.contains(name) || names.iter().any(|n| n == "*"))
            })
            .cloned()
            .collect(),
    };
    let mut lines = vec!["  case \"$1\" in".to_owned()];
    for (id, names) in &grants {
        lines.push(format!("    {id}) {} ;;", print_tools(names)));
    }
    lines.push(format!("    *) {} ;;", print_tools(&fallback)));
    lines.push("  esac".to_owned());
    Some(lines.join("\n"))
}
