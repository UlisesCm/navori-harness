//! `.pi/extensions/navori.ts` from the derived asset (spec 0059 D29, T20): the template that
//! `scripts/js/gen-pi-extension-asset.mjs` takes from the built TS CLI, with the MCP plugin ids
//! and each role's tools filled in, then the `serializePiSource` header.

use crate::js_json::JsValue;
use crate::render::pi_owned::serialize_pi_source;
use crate::render::pi_roles::{PI_ROLE_NAMES, PiKnowledgeGrants, pi_role_tools};

/// `crates/navori-core/assets/pi/extension.ts.in`, kept fresh by the `oracle` job.
const EXTENSION_TEMPLATE: &str = include_str!("../../assets/pi/extension.ts.in");

fn json_strings(items: &[String]) -> String {
    JsValue::Array(items.iter().map(|s| JsValue::string(s)).collect())
        .stringify(None)
        .unwrap_or_else(|| "[]".to_owned())
}

/// `serializePiSource(renderPiExtensionSource(mcpPluginIds, knowledgeGrants))`.
#[must_use]
pub fn render_pi_extension(mcp_plugin_ids: &[String], grants: &PiKnowledgeGrants) -> String {
    let mut source =
        EXTENSION_TEMPLATE.replacen("{{json:mcpPluginIds}}", &json_strings(mcp_plugin_ids), 1);
    for role in PI_ROLE_NAMES {
        source = source.replacen(
            &format!("{{{{json:roleTools.{role}}}}}"),
            &json_strings(&pi_role_tools(role, grants)),
            1,
        );
    }
    serialize_pi_source(&source)
}
