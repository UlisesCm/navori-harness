//! Plugin script placements (`engines/shared/plugin-scripts.ts`) and the frozen fingerprints of
//! pre-#637 renders (`engines/shared/legacy-plugin-script-fingerprints.ts`), spec 0058 T14.

use sha2::{Digest, Sha256};

use crate::js_json::JsValue;
use crate::render::hook_includes::expand_hook_includes;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::plugins::{LoadedPlugin, PluginScript};

/// `pluginScriptManagedId`: `<plugin>-script-<dest slug>`.
#[must_use]
pub fn plugin_script_managed_id(plugin_id: &str, dest: &str) -> String {
    // `/\.[^.]+$/`: the last dot, when at least one character follows it.
    let stem = match dest.rfind('.') {
        Some(dot) if dot + 1 < dest.len() => &dest[..dot],
        _ => dest,
    };
    let mut slug = String::new();
    let mut gap = false;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(ch.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    format!("{plugin_id}-script-{slug}")
}

/// Engines that place plugin scripts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptEngine {
    /// `.claude/scripts/`.
    Claude,
    /// `.codex/scripts/`.
    Codex,
    /// `.pi/navori/scripts/`.
    Pi,
}

/// One entry of `pluginScriptPlacements`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptPlacement {
    /// Plugin directory under `packages/plugins/`.
    pub plugin_dir: String,
    /// The manifest entry.
    pub script: PluginScript,
    /// Destination, relative to the repo root.
    pub dest_rel_path: String,
    /// Managed-block id.
    pub managed_id: String,
    /// Marker `source` (`@navori/plugin-<id>`); the version is the CLI's.
    pub source: String,
}

impl ScriptPlacement {
    /// `basename(script.src)`.
    #[must_use]
    pub fn file_name(&self) -> &str {
        self.script
            .src
            .rsplit('/')
            .next()
            .unwrap_or(&self.script.src)
    }

    /// The bundled template; `None` when missing or not UTF-8 (the TS throws).
    #[must_use]
    pub fn template(&self) -> Option<&'static str> {
        crate::render::assets::plugin(&self.plugin_dir, &self.script.src)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
    }
}

/// `pluginScriptPlacements(plugin, engine)`.
#[must_use]
pub fn plugin_script_placements(
    plugin: &LoadedPlugin,
    engine: ScriptEngine,
) -> Vec<ScriptPlacement> {
    let id = plugin.manifest_id();
    plugin
        .script_assets
        .iter()
        .map(|script| ScriptPlacement {
            plugin_dir: plugin.dir.clone(),
            dest_rel_path: match engine {
                ScriptEngine::Claude => format!(".claude/scripts/{}", script.dest),
                ScriptEngine::Codex => format!(".codex/scripts/{}", script.dest),
                ScriptEngine::Pi => format!(".pi/navori/scripts/{}", script.dest),
            },
            managed_id: plugin_script_managed_id(&id, &script.dest),
            source: format!("@navori/plugin-{id}"),
            script: script.clone(),
        })
        .collect()
}

/// `legacyPluginScriptContent`: the template with includes expanded and interpolated, as
/// navori wrote scripts before they carried a marker. `None` where the TS throws.
#[must_use]
pub fn legacy_script_content(template: &str, config: &JsValue) -> Option<String> {
    let raw = expand_hook_includes(template).ok()?;
    Some(interpolate(&raw, config, &InterpolateOptions::default()))
}

/// `(sha256, masked 0-based lines)` of one pre-#637 render.
pub type Fingerprint = (&'static str, &'static [usize]);

/// `LEGACY_FINGERPRINTS`: the fingerprints per script file name.
pub const LEGACY_FINGERPRINTS: &[(&str, &[Fingerprint])] = &[
    (
        "check-jscpd.sh",
        &[
            (
                "041234ccb943bc66ef798a8a20e59104c557a68e416455e7a38829b984de1cc9",
                &[563, 564],
            ),
            (
                "a40942c03cbe4045cf4412f49c957d6e14a1839ea36a8a0b5a3d9501ecdc5626",
                &[523, 524],
            ),
            (
                "d2c4d0b8d1e0175a3550399929c229a87b4465a88b2d7157340e166502170c48",
                &[514, 515],
            ),
            (
                "0250f89c0f000e97e06a9df61933948184ffe79b0b59577f6b15d1b3ed274b18",
                &[313, 314],
            ),
            (
                "a06f8b54fe2c6938734f8eafeb59e3010c33a45fcc77ed1818d00c00bac5d6cf",
                &[313, 314],
            ),
            (
                "927fd65ea856e3bb5459a04b887150b73f79ba593f00d9d084481e1bba27979a",
                &[131, 132],
            ),
            (
                "f8a5f469167a380ea1f2e84696c3d84cfacfb54b71b343d332e5e34a2667f7ae",
                &[131, 132],
            ),
            (
                "78a5215c8ed4e1d6f75c26c911e77d25d1a8747ce1058fb4ed1e1584df18f344",
                &[126, 127],
            ),
            (
                "563bb4e7f882f989d5d3e359e9adf99f290227d4aa7bf9ec0a8cef123f528fd0",
                &[126, 127],
            ),
            (
                "e60692b1c19c07a14f491692c73814e4a904cee9c7bc58249380e9ac2d70c13a",
                &[113, 114],
            ),
            (
                "31bbb433a1c95b120204035dcf8139067cd9b088fb548aa3e8052bc3c35d8b68",
                &[2, 109, 110, 122, 125, 129, 138],
            ),
            (
                "1c137dc0074cdde8a3a85b3824c3bb14c7b4d7edd276c08b7f87f93f0912d7b0",
                &[2, 98, 99, 111, 114, 118, 127],
            ),
            (
                "63cfce79b8feb7919f021649c9b05ed5fcf0fc3448900212f09616a56b6cacd8",
                &[2, 41, 42, 54, 57, 61, 70],
            ),
            (
                "11d5288142511a4737c3655889d3b63a6f0418ef43f02e40200850470aed6080",
                &[2, 42, 43, 55, 58, 62],
            ),
            (
                "8983c9ecd9eae9d58ae27325d93dd94e6c23c9c458e6a24d78b67a13fec2fef5",
                &[2, 29, 30, 42, 45, 49],
            ),
            (
                "6a5c4406060f7bdf859ffb3535f3b16a8315f0132def8d7315d81e70af772b07",
                &[2, 25, 26, 30, 32, 37],
            ),
        ],
    ),
    (
        "check-semgrep.sh",
        &[
            (
                "c72a061abbb3cbbc2c96dfaa286fb794abb095eedbe42e0fa9ba8a01afee6881",
                &[557],
            ),
            (
                "ea764d62bc4cb06a15e20250456cf9a3a79283f9ca9e62c201dca710dfc9e454",
                &[517],
            ),
            (
                "3d5cfa005b64625a6bc430faa3091b76ae6b62802cce75452586e62f48df5b70",
                &[508],
            ),
            (
                "3f9cd3c00b403c4529d9bad40549d9bf9d1a67f3c75ffebf0c514a441586bc43",
                &[307],
            ),
            (
                "6a34990b770d41e540a6d196b8467f1d4f4bf19c7fdfac9b16b19196bff1d9ee",
                &[307],
            ),
            (
                "cbf700a70cdaee13b7f30c2fc43622a1c6f652ab6111a1176d71c87adb741fd7",
                &[129],
            ),
            (
                "d46749a930a137a50fdb13fd5d7a086da12772617edb7fe0c1794016efbc8804",
                &[129],
            ),
            (
                "192cd9d7e0e07263d8d2b7a5ba634139c9137243471650522d219c4dab3b5036",
                &[127],
            ),
            (
                "08aa28d128ee48866625327bcb42dc262a172393a422cce4d81a11de2d167bbc",
                &[122],
            ),
            (
                "1298ce83fdbc5ed3519ce54d1bee5189c3786f99807139ecb02ade9137f98786",
                &[122],
            ),
            (
                "30da64b0974f311b661c139f0d6c94dc0de55f0b5567ae015d6a43208612c5fe",
                &[109],
            ),
            (
                "b4543ee86d6a918d1715efa55a605aea0de2050256678b41abc4e03443d746d7",
                &[109],
            ),
            (
                "9bf0886e320c671ac700658d51f27cc437b3ca9c0b84636a085f6b625293fd2e",
                &[2, 105, 106, 118, 121, 125],
            ),
            (
                "acd401f45cc51b2a8b99aac3f2377e534efe3ab89eb5d3fd07d1d4671ba51004",
                &[2, 99, 100, 112, 115, 119],
            ),
            (
                "1052b801786b2b82ac9abd4dfc36cb5f05ed724c8b52048d188df8e9d346b553",
                &[2, 42, 43, 55, 58, 62],
            ),
            (
                "84c847391daae5c350b58c99d34acd992fa3e77d1f19d91a14265ef057bf0e73",
                &[2, 29, 30, 42, 45, 49],
            ),
            (
                "5495bfa4a26a1fd153de73605d8ade487ce36ae3351c496415fba9ecbf21ce50",
                &[2, 25, 26, 30, 32, 37],
            ),
        ],
    ),
];

/// `maskedSha256`: the hex sha256 of `content` with the `masked` lines blanked.
#[must_use]
pub fn masked_sha256(content: &str, masked: &[usize]) -> String {
    let mut lines: Vec<&str> = content.split('\n').collect();
    for &index in masked {
        if let Some(line) = lines.get_mut(index) {
            *line = "";
        }
    }
    Sha256::digest(lines.join("\n").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `matchesLegacyFingerprint`: `on_disk` equals, outside its config-bearing lines, a pre-#637
/// render of `script_file`.
#[must_use]
pub fn matches_legacy_fingerprint(script_file: &str, on_disk: &str) -> bool {
    LEGACY_FINGERPRINTS
        .iter()
        .find(|(name, _)| *name == script_file)
        .is_some_and(|(_, entries)| {
            entries
                .iter()
                .any(|(sha, masked)| masked_sha256(on_disk, masked) == *sha)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_id_slugs_the_destination() {
        for (dest, id) in [
            (
                "guard-search-routing.sh",
                "tgrep-script-guard-search-routing",
            ),
            ("--A.B/c_d.tar.gz", "tgrep-script-a-b-c-d-tar"),
            ("x.", "tgrep-script-x"),
            ("é", "tgrep-script-"),
            ("a/.b", "tgrep-script-a"),
        ] {
            assert_eq!(plugin_script_managed_id("tgrep", dest), id, "{dest}");
        }
    }
}
