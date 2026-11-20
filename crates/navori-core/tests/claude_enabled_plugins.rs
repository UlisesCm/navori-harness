//! `claudePlugins` -> `enabledPlugins` in the Claude settings (#1747), against the TS rules.

use std::error::Error;

use navori_core::js_json::{self, JsValue};
use navori_core::render::claude_settings::build_claude_settings;
use navori_core::render::harness_plan::HarnessPlan;
use navori_core::render::plugins::plugin_from_manifest;

type Check = Result<(), Box<dyn Error>>;

/// The serialized `enabledPlugins` of the built settings, or `"absent"`.
fn settings(config: &str, plugins: &[&str]) -> Result<String, Box<dyn Error>> {
    let config = js_json::parse(config).ok_or("config")?;
    let mut loaded = Vec::new();
    for raw in plugins {
        loaded.push(plugin_from_manifest("synth", raw).map_err(|_| "plugin")?);
    }
    let built =
        build_claude_settings(&config, &HarnessPlan::default(), &loaded).map_err(|_| "settings")?;
    let JsValue::Object(object) = built else {
        return Err("settings is not an object".into());
    };
    Ok(object
        .get("enabledPlugins")
        .and_then(|v| v.stringify(None))
        .unwrap_or_else(|| "absent".to_owned()))
}

#[test]
fn keys_are_sorted_and_false_is_kept() -> Check {
    assert_eq!(
        settings(
            r#"{"claudePlugins":{"b@m":true,"a@m":false,"B@m":true}}"#,
            &[]
        )?,
        r#"{"B@m":true,"a@m":false,"b@m":true}"#
    );
    Ok(())
}

#[test]
fn empty_or_absent_writes_no_key() -> Check {
    assert_eq!(settings(r#"{"claudePlugins":{}}"#, &[])?, "absent");
    assert_eq!(settings("{}", &[])?, "absent");
    Ok(())
}

const FRAGMENT: &str = r#"{"id":"synth","name":"S","description":"S","version":"0.0.1","settingsFragment":{"enabledPlugins":{"old@m":true}}}"#;

#[test]
fn the_config_replaces_a_fragment_enabled_plugins() -> Check {
    assert_eq!(
        settings(r#"{"claudePlugins":{"new@m":true}}"#, &[FRAGMENT])?,
        r#"{"new@m":true}"#
    );
    Ok(())
}

#[test]
fn an_empty_config_keeps_the_fragment_enabled_plugins() -> Check {
    assert_eq!(
        settings(r#"{"claudePlugins":{}}"#, &[FRAGMENT])?,
        r#"{"old@m":true}"#
    );
    Ok(())
}
