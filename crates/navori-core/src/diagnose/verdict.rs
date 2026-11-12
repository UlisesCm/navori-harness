//! Port of `computeHealthVerdict` (`commands/doctor.ts`, spec 0060 T23, R73, R76): every check
//! that flips `ok` and drives exit code 2, shared by `status` and `doctor`.
//!
//! Native subset, each exit to the TS an [`Unmodeled`]:
//! - enabled monorepo workspaces (every scan recurses into them);
//! - Codex configured with a `.codex/` directory (`scanCodexHealth` reads its TOML and hook
//!   modes, not ported);
//! - `qualityGate.nativeHooks: true` or a plugin whose hooks `nativeHook` omits (`scanNativeHooks`
//!   would inspect the git hooks; without a declaration its findings never flip `ok`);
//! - a `.claude/settings.json` that cannot be read or parsed (the corrupted-settings report
//!   carries the JS exception message);
//! - a preset the loader delegates, and text that is not UTF-8.

use std::path::Path;

use crate::config::Config;
use crate::diagnose::health::{
    DuplicateMarker, MissingPlugin, Unmodeled, collect_missing_plugins, configured_engines,
    read_rendered_text, read_text, scan_duplicate_markers,
};
use crate::js_json::{self, JsValue};
use crate::posix::js_trim;
use crate::render::assets;
use crate::render::claude_md::has_monorepo_workspaces;
use crate::render::plugins::PluginsLoadResult;
use crate::render::presets::{AssetRoot, load_preset, resolve_preset};

/// Engines that materialize plugin blocks (`PLUGIN_BLOCK_ENGINES`).
const PLUGIN_BLOCK_ENGINES: [&str; 3] = ["claude", "codex", "pi"];

/// `MissingInvariant`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingInvariant {
    /// The load-bearing substring absent from the output.
    pub invariant: String,
    /// `plugin:<id>` or `preset:<id>`.
    pub source: String,
}

/// A preset extra whose source file is missing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingPresetFile {
    /// The extra's id.
    pub id: String,
    /// Its `relPath`.
    pub rel_path: String,
}

/// `HealthVerdict`, without the branches the native subset delegates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthVerdict {
    /// No hard issue: what `doctor` and `status` exit 0 on.
    pub ok: bool,
    /// `missingPlugins`.
    pub missing_plugins: Vec<MissingPlugin>,
    /// `missingInvariants`.
    pub missing_invariants: Vec<MissingInvariant>,
    /// A declared preset that resolves to nothing.
    pub missing_preset: Option<String>,
    /// `missingPresetFiles`.
    pub missing_preset_files: Vec<MissingPresetFile>,
    /// `duplicateMarkers`.
    pub duplicate_markers: Vec<DuplicateMarker>,
}

fn member<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// A string array field, `[]` when absent.
fn strings(value: &JsValue, key: &str) -> Result<Vec<String>, Unmodeled> {
    match member(value, key) {
        None | Some(JsValue::Undefined) => Ok(Vec::new()),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::String(text) => text.to_rust().ok_or(Unmodeled),
                _ => Err(Unmodeled),
            })
            .collect(),
        Some(_) => Err(Unmodeled),
    }
}

fn text_field(value: &JsValue, key: &str) -> Result<String, Unmodeled> {
    match member(value, key) {
        Some(JsValue::String(text)) => text.to_rust().ok_or(Unmodeled),
        _ => Err(Unmodeled),
    }
}

/// `config.preset`.
fn preset_id(config: &JsValue) -> Result<String, Unmodeled> {
    text_field(config, "preset")
}

/// `scanCorruptedSettings` restricted to a readable, parseable file; anything else delegates.
fn check_settings(cwd: &Path) -> Result<(), Unmodeled> {
    let path = cwd.join(".claude/settings.json");
    if !path.exists() {
        return Ok(());
    }
    let text = read_text(&path)?.ok_or(Unmodeled)?;
    if text.starts_with('\u{feff}') {
        return Err(Unmodeled);
    }
    js_json::parse(&text).map(|_| ()).ok_or(Unmodeled)
}

/// `missingInvariantsAt(cwd, config, "", false)`.
fn scan_missing_invariants(
    cwd: &Path,
    config: &Config,
    engines: &[String],
    plugins: &PluginsLoadResult,
) -> Result<Vec<MissingInvariant>, Unmodeled> {
    let mut sources: Vec<(String, Vec<String>)> = Vec::new();
    let preset = preset_id(&config.data)?;
    if let Some(loaded) = load_preset(&preset, cwd).map_err(|_| Unmodeled)? {
        let invariants = strings(&loaded.def, "invariants")?;
        if !invariants.is_empty() {
            sources.push((
                format!("preset:{}", text_field(&loaded.def, "id")?),
                invariants,
            ));
        }
    }
    if engines
        .iter()
        .any(|e| PLUGIN_BLOCK_ENGINES.contains(&e.as_str()))
    {
        for plugin in &plugins.loaded {
            let invariants = strings(&plugin.manifest, "invariants")?;
            if !invariants.is_empty() {
                sources.push((format!("plugin:{}", plugin.dir), invariants));
            }
        }
    }
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let output = read_rendered_text(cwd, engines)?;
    if js_trim(&output).is_empty() {
        return Ok(Vec::new());
    }
    let mut missing = Vec::new();
    for (source, invariants) in sources {
        for invariant in invariants {
            if !output.contains(&invariant) {
                missing.push(MissingInvariant {
                    invariant,
                    source: source.clone(),
                });
            }
        }
    }
    Ok(missing)
}

/// `scanMissingPresetFiles`: extras of the preset whose source is absent.
fn scan_missing_preset_files(
    cwd: &Path,
    preset: &str,
) -> Result<Vec<MissingPresetFile>, Unmodeled> {
    if preset == "custom" {
        return Ok(Vec::new());
    }
    let Some(loaded) = load_preset(preset, cwd).map_err(|_| Unmodeled)? else {
        return Ok(Vec::new());
    };
    let extras = member(&loaded.def, "extras").ok_or(Unmodeled)?;
    let mut missing = Vec::new();
    for kind in ["managed", "agents", "skills", "hooks"] {
        let Some(JsValue::Array(entries)) = member(extras, kind) else {
            return Err(Unmodeled);
        };
        for entry in entries {
            let rel_path = text_field(entry, "relPath")?;
            let exists = match &loaded.asset_root {
                AssetRoot::Local(dir) => dir.join(&rel_path).exists(),
                AssetRoot::Bundled => assets::core(&format!("core-assets/{rel_path}")).is_some(),
            };
            if !exists {
                missing.push(MissingPresetFile {
                    id: text_field(entry, "id")?,
                    rel_path,
                });
            }
        }
    }
    Ok(missing)
}

/// `computeHealthVerdict(cwd, config)`, with `plugins` the `loadEnabledPlugins` result.
///
/// # Errors
/// Any branch the module docs list as delegated.
pub fn compute_health_verdict(
    cwd: &Path,
    config: &Config,
    plugins: &PluginsLoadResult,
) -> Result<HealthVerdict, Unmodeled> {
    // Delegation triggers, before any scan: workspaces, Codex health, native hooks.
    if has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    if engines.iter().any(|e| e == "codex") && cwd.join(".codex").exists() {
        return Err(Unmodeled);
    }
    let gate_declared = member(&config.data, "qualityGate")
        .and_then(|gate| member(gate, "nativeHooks"))
        == Some(&JsValue::Bool(true));
    if gate_declared || plugins.loaded.iter().any(|p| p.native_hook_omitted) {
        return Err(Unmodeled);
    }
    check_settings(cwd)?;

    let missing_plugins = collect_missing_plugins(plugins);
    let missing_invariants = scan_missing_invariants(cwd, config, &engines, plugins)?;
    let preset = preset_id(&config.data)?;
    let missing_preset = (preset != "custom"
        && resolve_preset(&preset, cwd)
            .map_err(|_| Unmodeled)?
            .is_none())
    .then(|| preset.clone());
    let missing_preset_files = scan_missing_preset_files(cwd, &preset)?;
    let duplicate_markers = scan_duplicate_markers(cwd, config)?;
    let ok = missing_plugins.is_empty()
        && missing_invariants.is_empty()
        && missing_preset.is_none()
        && missing_preset_files.is_empty()
        && duplicate_markers.is_empty();
    Ok(HealthVerdict {
        ok,
        missing_plugins,
        missing_invariants,
        missing_preset,
        missing_preset_files,
        duplicate_markers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(text: &str) -> Result<Config, Unmodeled> {
        Ok(Config {
            data: js_json::parse(text).ok_or(Unmodeled)?,
            warnings: Vec::new(),
        })
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("navori-verdict-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    // Covers: R73
    #[test]
    fn unknown_plugins_and_phantom_presets_fail_the_verdict() -> Result<(), Unmodeled> {
        let dir = temp("fail");
        let plugins = PluginsLoadResult {
            missing: vec!["nope".to_owned()],
            ..PluginsLoadResult::default()
        };
        let verdict = compute_health_verdict(
            &dir,
            &config(r#"{"engines":["claude"],"preset":"no-such-preset"}"#)?,
            &plugins,
        )?;
        assert!(!verdict.ok);
        assert_eq!(verdict.missing_plugins[0].id, "nope");
        assert_eq!(verdict.missing_preset.as_deref(), Some("no-such-preset"));
        let clean = compute_health_verdict(
            &dir,
            &config(r#"{"engines":["claude"],"preset":"custom"}"#)?,
            &PluginsLoadResult::default(),
        )?;
        assert!(clean.ok);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    // Covers: R73
    #[test]
    fn unported_branches_delegate() -> Result<(), Unmodeled> {
        let dir = temp("delegate");
        let none = PluginsLoadResult::default();
        let gate = config(
            r#"{"engines":["claude"],"preset":"custom","qualityGate":{"nativeHooks":true}}"#,
        )?;
        assert_eq!(compute_health_verdict(&dir, &gate, &none), Err(Unmodeled));
        let _ = std::fs::create_dir_all(dir.join(".codex"));
        let codex = config(r#"{"engines":["codex"],"preset":"custom"}"#)?;
        assert_eq!(compute_health_verdict(&dir, &codex, &none), Err(Unmodeled));
        let _ = std::fs::create_dir_all(dir.join(".claude"));
        let _ = std::fs::write(dir.join(".claude/settings.json"), "{");
        let claude = config(r#"{"engines":["claude"],"preset":"custom"}"#)?;
        assert_eq!(compute_health_verdict(&dir, &claude, &none), Err(Unmodeled));
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
