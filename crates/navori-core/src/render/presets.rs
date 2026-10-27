//! Preset loading: port of `packages/cli/src/lib/config/presets.ts` (spec 0058 T14).
//!
//! Local presets (`.navori/presets/<id>/<id>.json`) win over bundled ones. A preset the TS would
//! reject (unreadable, invalid JSON, schema, id mismatch) is reported as [`PresetDelegate`]: the
//! native render hands the invocation to the TS, which prints its own error.

use std::path::{Path, PathBuf};

use crate::js_json::{self, JsValue};
use crate::render::assets;
use crate::render::library_skills::library_skill_label;
use crate::zod::{
    Parsed, Shape, array_of, empty_array, kebab, non_empty, non_empty_strings, string,
};

/// Where a preset's `extras.*.relPath` resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetRoot {
    /// `.navori/presets/<id>` on disk.
    Local(PathBuf),
    /// `core-assets/` of the bundled core.
    Bundled,
}

/// `LoadedPreset`.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedPreset {
    /// The validated definition, `libraries` already filtered.
    pub def: JsValue,
    /// Asset root of the extras.
    pub asset_root: AssetRoot,
    /// `def.libraries` ids unknown to the registry, dropped at load.
    pub dropped_libraries: Vec<String>,
}

/// The TS would throw `PresetError`; the invocation goes to the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetDelegate;

fn managed_extra(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("id", non_empty)?
        .required("relPath", crate::zod::safe_rel_path)?
        .strip())
}

fn file_extra(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("id", non_empty)?
        .required("relPath", crate::zod::safe_rel_path)?
        .required("destRelPath", crate::zod::safe_rel_path)?
        .optional("condition", string)?
        .strip())
}

fn extras(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .defaulted("managed", empty_array(), |v| array_of(v, managed_extra))?
        .defaulted("agents", empty_array(), |v| array_of(v, file_extra))?
        .defaulted("skills", empty_array(), |v| array_of(v, file_extra))?
        .defaulted("hooks", empty_array(), |v| array_of(v, file_extra))?
        .strip())
}

fn empty_extras() -> JsValue {
    let mut object = js_json::JsObject::new();
    for key in ["managed", "agents", "skills", "hooks"] {
        object.insert(key, empty_array());
    }
    JsValue::Object(object)
}

/// `PresetDefinitionSchema`.
fn definition(raw: &JsValue) -> Parsed {
    Ok(Shape::new(raw)?
        .required("id", kebab)?
        .required("displayName", non_empty)?
        .defaulted("extends", JsValue::string("core"), |v| {
            crate::zod::one_of(v, &["core"])
        })?
        .defaulted("extras", empty_extras(), extras)?
        .defaulted("invariants", empty_array(), non_empty_strings)?
        .defaulted("libraries", empty_array(), non_empty_strings)?
        .strip())
}

/// Ids that would make `resolve(repoRoot, ".navori/presets", id)` leave its directory; the TS
/// normalizes those paths, so Rust declines them instead of guessing.
fn is_plain_id(id: &str) -> bool {
    !id.is_empty() && !id.contains(['/', '\\']) && id != "." && id != ".."
}

/// `loadPreset`: `Ok(None)` for `custom` or an id with no manifest.
///
/// # Errors
/// Any preset the TS would reject, or one Rust does not model.
pub fn load_preset(id: &str, repo_root: &Path) -> Result<Option<LoadedPreset>, PresetDelegate> {
    if id == "custom" {
        return Ok(None);
    }
    if !is_plain_id(id) {
        return Err(PresetDelegate);
    }
    let local_dir = repo_root.join(".navori/presets").join(id);
    let local_json = local_dir.join(format!("{id}.json"));
    let (bytes, asset_root) = if local_json.exists() {
        let bytes = std::fs::read(&local_json).map_err(|_| PresetDelegate)?;
        (bytes, AssetRoot::Local(local_dir))
    } else if let Some(bytes) = assets::core(&format!("core-assets/presets/{id}.json")) {
        (bytes.to_vec(), AssetRoot::Bundled)
    } else {
        return Ok(None);
    };
    let text = std::str::from_utf8(&bytes).map_err(|_| PresetDelegate)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw = js_json::parse(text).ok_or(PresetDelegate)?;
    let mut def = definition(&raw).map_err(|_| PresetDelegate)?;
    let JsValue::Object(object) = &mut def else {
        return Err(PresetDelegate);
    };
    if object.get("id") != Some(&JsValue::string(id)) {
        return Err(PresetDelegate);
    }
    let mut dropped = Vec::new();
    let mut kept = Vec::new();
    if let Some(JsValue::Array(libraries)) = object.get("libraries") {
        for library in libraries {
            let name = match library {
                JsValue::String(text) => String::from_utf16_lossy(text.units()),
                _ => continue,
            };
            if library_skill_label(&name).is_some() {
                kept.push(library.clone());
            } else {
                dropped.push(name);
            }
        }
    }
    object.insert("libraries", JsValue::Array(kept));
    Ok(Some(LoadedPreset {
        def,
        asset_root,
        dropped_libraries: dropped,
    }))
}

/// `droppedLibrariesWarnings`.
#[must_use]
pub fn dropped_libraries_warnings(loaded: Option<&LoadedPreset>) -> Vec<String> {
    let Some(loaded) = loaded else {
        return Vec::new();
    };
    let id = match &loaded.def {
        JsValue::Object(object) => match object.get("id") {
            Some(JsValue::String(text)) => String::from_utf16_lossy(text.units()),
            _ => String::new(),
        },
        _ => String::new(),
    };
    loaded
        .dropped_libraries
        .iter()
        .map(|lib| {
            format!(
                "preset '{id}' declares library '{lib}', unknown to this CLI's registry; skipped."
            )
        })
        .collect()
}
