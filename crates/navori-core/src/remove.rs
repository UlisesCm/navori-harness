//! `navori remove <plugin> --yes` (`commands/remove.ts`, spec 0058 T30): disable the plugin in
//! the config, render so the engine strips its blocks, sub-blocks and scripts, then drop its key.
//!
//! Both config writes are `writeConfig` over `readRaw` (the file's JSON without `$schema`), so the
//! zod output and the forward-compatible enums are the TS's ([`crate::config::write_config`]).

use crate::config::{Config, Delegate, write_config};
use crate::js_json::{self, JsObject, JsValue};

/// `readRaw(configPath)`: the file's object without `$schema`. `JSON.parse` must accept the text
/// as is (a BOM makes the TS throw).
fn read_raw(text: &str) -> Result<JsObject, Delegate> {
    if text.starts_with('\u{feff}') {
        return Err(Delegate::Json);
    }
    let Some(JsValue::Object(mut raw)) = js_json::parse(text) else {
        return Err(Delegate::Json);
    };
    raw.remove("$schema");
    Ok(raw)
}

/// `(raw.plugins as Record | undefined) ?? {}`; anything but an object or nothing delegates.
fn plugins_of(raw: &JsObject) -> Result<JsObject, Delegate> {
    match raw.get("plugins") {
        None | Some(JsValue::Null | JsValue::Undefined) => Ok(JsObject::new()),
        Some(JsValue::Object(plugins)) => Ok(plugins.clone()),
        Some(_) => Err(Delegate::Schema),
    }
}

/// `config.plugins?.[id]` of the validated config: `Some(nativeHook === true)` when declared.
#[must_use]
pub fn declared(config: &Config, id: &str) -> Option<bool> {
    let JsValue::Object(root) = &config.data else {
        return None;
    };
    let Some(JsValue::Object(plugins)) = root.get("plugins") else {
        return None;
    };
    match plugins.get(id) {
        Some(JsValue::Object(entry)) => Some(entry.get("nativeHook") == Some(&JsValue::Bool(true))),
        _ => None,
    }
}

/// Phase 1: the config text with the plugin as `{ enabled: false }` (keeping `nativeHook: true`,
/// so the render still keeps a retired script the user wired into a native hook).
///
/// # Errors
/// [`Delegate`] where `readRaw` or `writeConfig` throws.
pub fn disable(text: &str, id: &str, native_hook: bool) -> Result<String, Delegate> {
    let mut raw = read_raw(text)?;
    let mut plugins = plugins_of(&raw)?;
    let mut entry = JsObject::new();
    entry.insert("enabled", JsValue::Bool(false));
    if native_hook {
        entry.insert("nativeHook", JsValue::Bool(true));
    }
    plugins.insert(id, JsValue::Object(entry));
    raw.insert("plugins", JsValue::Object(plugins));
    write_config(&raw)
}

/// Phase 2: the config text without the plugin's key.
///
/// # Errors
/// [`Delegate`] where `readRaw` or `writeConfig` throws.
pub fn prune(text: &str, id: &str) -> Result<String, Delegate> {
    let mut raw = read_raw(text)?;
    let mut plugins = plugins_of(&raw)?;
    plugins.remove(id);
    raw.insert("plugins", JsValue::Object(plugins));
    write_config(&raw)
}
