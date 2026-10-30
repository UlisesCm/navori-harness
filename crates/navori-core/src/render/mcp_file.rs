//! Step 2.5 of `prepareClaudeEngine` (spec 0058 T15): `planMcpRegistration` reconciles
//! `.mcp.json`, the project-scoped MCP registry. Every enabled plugin declaring `mcpServer`
//! registers one server under its id, a disabled one loses its own, and anything else in the file
//! stays. The file carries the `$navori` stamp only while everything in it is navori's, and a
//! stamped file follows the anti-rollback rule of `planStampedJson`.
//!
//! An existing file that cannot be read, or that does not parse without `force`, is delegated:
//! the TS throws, or skips it with the V8 parser message, which Rust does not reproduce.

use crate::STAMP_VERSION;
use crate::i18n;
use crate::js_json::{self, JsObject, JsString, JsValue};
use crate::markers::InjectStatus;
use crate::render::collect::{RepoView, read_if_exists};
use crate::render::context::Lang;
use crate::render::plugins::LoadedPlugin;
use crate::render::settings_file::{
    OWNERSHIP_KEY, SettingsFileDelegate, SettingsPlan, StampedPlan, plan_stamped_json, pretty,
};

/// The registry path.
pub const MCP_PATH: &str = ".mcp.json";

/// `McpPlan`: the same three outcomes as the settings plan.
pub type McpPlan = SettingsPlan;

fn mcp_server(plugin: &LoadedPlugin) -> Option<&JsObject> {
    match &plugin.manifest {
        JsValue::Object(manifest) => match manifest.get("mcpServer") {
            Some(JsValue::Object(server)) => Some(server),
            _ => None,
        },
        _ => None,
    }
}

/// Whether `plugin` declares an `mcpServer`.
#[must_use]
pub fn declares_mcp_server(plugin: &LoadedPlugin) -> bool {
    mcp_server(plugin).is_some()
}

/// `buildDesiredMcpServers(enabledPlugins)`: `(id, entry)` in plugin order.
#[must_use]
pub fn build_desired_mcp_servers(enabled: &[LoadedPlugin]) -> Vec<(String, JsValue)> {
    let mut desired: Vec<(String, JsValue)> = Vec::new();
    for plugin in enabled {
        let Some(server) = mcp_server(plugin) else {
            continue;
        };
        let mut entry = JsObject::new();
        entry.insert(
            "command",
            server.get("command").cloned().unwrap_or(JsValue::Undefined),
        );
        entry.insert(
            "args",
            server.get("args").cloned().unwrap_or(JsValue::Undefined),
        );
        if let Some(JsValue::Object(env)) = server.get("env")
            && !env.is_empty()
        {
            entry.insert("env", JsValue::Object(env.clone()));
        }
        if server.get("alwaysLoad") == Some(&JsValue::Bool(true)) {
            entry.insert("alwaysLoad", JsValue::Bool(true));
        }
        // `Map.set` keeps the first position of a repeated id.
        let id = plugin.manifest_id();
        match desired.iter_mut().find(|(existing, _)| *existing == id) {
            Some(slot) => slot.1 = JsValue::Object(entry),
            None => desired.push((id, JsValue::Object(entry))),
        }
    }
    desired
}

/// `NAVORI_MCP_ENTRY_KEYS`: the keys `buildDesiredMcpServers` emits, navori's to set and drop.
const NAVORI_MCP_ENTRY_KEYS: [&str; 4] = ["command", "args", "env", "alwaysLoad"];

/// `mergeServerEntry(existing, desired)` (#1448): navori's keys from `desired` in the position the
/// file had them, a navori key `desired` no longer has dropped, every other key kept (a host's own
/// switches, like pi's `directTools`), new navori keys last. An entry that is not an object is
/// replaced.
fn merge_server_entry(existing: Option<&JsValue>, desired: &JsValue) -> JsValue {
    let (Some(JsValue::Object(existing)), JsValue::Object(wanted)) = (existing, desired) else {
        return desired.clone();
    };
    let is_navori = |key: &JsString| NAVORI_MCP_ENTRY_KEYS.iter().any(|k| key.is(k));
    let mut out = JsObject::new();
    for (key, value) in existing.ordered() {
        if !is_navori(key) {
            out.insert(key.clone(), value.clone());
        } else if let Some(fresh) = key.to_rust().and_then(|k| wanted.get(&k)) {
            out.insert(key.clone(), fresh.clone());
        }
    }
    for (key, value) in wanted.ordered() {
        if !out.has(&key.to_rust().unwrap_or_default()) {
            out.insert(key.clone(), value.clone());
        }
    }
    JsValue::Object(out)
}

/// `planMcpRegistration(cwd, enabledPlugins, disabledPlugins, config, force)`.
///
/// # Errors
/// [`SettingsFileDelegate`] when the existing file cannot be read, or does not parse and
/// `force` is off.
pub fn plan_mcp_registration(
    view: &dyn RepoView,
    enabled: &[LoadedPlugin],
    disabled: &[LoadedPlugin],
    floor: Option<&str>,
    force: bool,
    lang: Lang,
) -> Result<McpPlan, SettingsFileDelegate> {
    let desired = build_desired_mcp_servers(enabled);
    let existing = read_if_exists(view, MCP_PATH).map_err(|_| SettingsFileDelegate)?;
    let mut base = JsObject::new();
    let mut servers = JsObject::new();
    let mut had_servers_key = false;
    if let Some(text) = existing.as_deref() {
        let parsed = match js_json::parse(text) {
            Some(parsed) => parsed,
            None if force => JsValue::Object(JsObject::new()),
            None => return Err(SettingsFileDelegate),
        };
        if let JsValue::Object(object) = parsed {
            if let Some(JsValue::Object(ms)) = object.get("mcpServers") {
                servers = ms.clone();
                had_servers_key = true;
            }
            base = object;
        } else if !force {
            return Ok(SettingsPlan::Skip {
                reason: i18n::mcp_json_not_object(lang).to_owned(),
                status: None,
            });
        }
    }

    // The user's servers, minus disabled navori plugins, plus the enabled ones.
    for plugin in disabled {
        if mcp_server(plugin).is_some() {
            servers.remove(&plugin.manifest_id());
        }
    }
    for (id, entry) in &desired {
        let merged = merge_server_entry(servers.get(id), entry);
        servers.insert(id.as_str(), merged);
    }

    if existing.is_none() && servers.is_empty() {
        return Ok(SettingsPlan::Noop);
    }

    let mut merged = base;
    if !servers.is_empty() || had_servers_key {
        merged.insert("mcpServers", JsValue::Object(servers.clone()));
    }
    let ours = merged
        .entries()
        .iter()
        .all(|(key, _)| key.is("mcpServers") || key.is(OWNERSHIP_KEY));
    let only_navori = servers
        .entries()
        .iter()
        .all(|(key, _)| desired.iter().any(|(id, _)| key.is(id)));
    merged.remove(OWNERSHIP_KEY);
    let stamped = if ours && only_navori && !servers.is_empty() {
        let mut stamp = JsObject::new();
        stamp.insert("managed", JsValue::Bool(true));
        stamp.insert("version", JsValue::string(STAMP_VERSION));
        let mut out = JsObject::new();
        out.insert(OWNERSHIP_KEY, JsValue::Object(stamp));
        for (key, value) in merged.entries() {
            out.insert(key.clone(), value.clone());
        }
        out
    } else {
        merged
    };

    let new_json = pretty(&JsValue::Object(stamped));
    if existing.as_deref() == Some(new_json.as_str()) {
        return Ok(SettingsPlan::Noop);
    }
    if let Some(current) = existing.as_deref() {
        match plan_stamped_json(current, &new_json, floor, force) {
            StampedPlan::Noop => return Ok(SettingsPlan::Noop),
            StampedPlan::Downgrade(version) => {
                return Ok(SettingsPlan::Skip {
                    reason: i18n::block_from_newer_navori(lang, Some(&version)),
                    status: Some(InjectStatus::DowngradeSkipped),
                });
            }
            StampedPlan::Write(_) => {}
        }
    }
    Ok(SettingsPlan::Write {
        content: new_json,
        status: if existing.is_none() {
            InjectStatus::Created
        } else {
            InjectStatus::Updated
        },
    })
}
