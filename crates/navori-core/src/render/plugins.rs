//! Plugin loading: port of `packages/cli/src/lib/config/plugins.ts` (spec 0058 T14).
//!
//! Plugins are never local: every manifest is a bundled `plugin.json` embedded at build time, and
//! `plugins_parity` loads each one through the real `loadPlugin`. So the schema port reproduces
//! zod's OUTPUT (shape key order, stripped keys, defaults) and checks only what it must descend
//! into; leaf validation is the oracle's job at build time, not a runtime guess. The only runtime
//! input is the plugin id a config declares.

use std::collections::BTreeSet;

use crate::js_json::{self, JsObject, JsValue};
use crate::render::assets;
use crate::zod::{Invalid, Parsed, Shape, array_of, empty_array};

/// A plugin a past navori shipped and later removed (`RetiredPluginEntry`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetiredPlugin {
    /// `removedIn`.
    pub removed_in: &'static str,
    /// `blockIds`: managed `CLAUDE.md` blocks it injected.
    pub block_ids: &'static [&'static str],
    /// `assets`: repo-relative files/dirs it materialized.
    pub assets: &'static [&'static str],
    /// `deleteForeign`.
    pub delete_foreign: bool,
}

/// `RETIRED_PLUGINS`, in declaration order.
pub const RETIRED_PLUGINS: &[(&str, RetiredPlugin)] = &[
    (
        "cognitive",
        RetiredPlugin {
            removed_in: "#130",
            block_ids: &["cognitive-protocol"],
            assets: &[
                ".claude/scripts/check-cognitive.sh",
                ".claude/scripts/cognitive-tool",
            ],
            delete_foreign: true,
        },
    ),
    (
        "jscpd",
        RetiredPlugin {
            removed_in: "#1300",
            block_ids: &["jscpd-protocol"],
            assets: &[".claude/scripts/check-jscpd.sh"],
            delete_foreign: false,
        },
    ),
    (
        "semgrep",
        RetiredPlugin {
            removed_in: "#1300",
            block_ids: &["semgrep-protocol"],
            assets: &[".claude/scripts/check-semgrep.sh"],
            delete_foreign: false,
        },
    ),
];

/// `RETIRED_PLUGIN_BLOCKS`: `(plugin id, retiredIn, blockIds)`.
pub const RETIRED_PLUGIN_BLOCKS: &[(&str, &str, &[&str])] = &[
    ("engram", "#814", &["engram-protocol"]),
    ("codegraph", "#838", &["codegraph-protocol"]),
    ("tgrep", "#838", &["tgrep-protocol"]),
    ("gh", "#1273", &["gh-protocol"]),
];

/// `(sub-block id, targetPath)` of a retired `injectInto` sub-block.
pub type RetiredSubBlock = (&'static str, &'static str);

/// `RETIRED_PLUGIN_SUB_BLOCKS`: `(plugin id, retiredIn, entries)`.
pub const RETIRED_PLUGIN_SUB_BLOCKS: &[(&str, &str, &[RetiredSubBlock])] = &[
    (
        "jscpd",
        "#1300",
        &[(
            "jscpd-review-extension",
            ".claude/skills/review-diff/SKILL.md",
        )],
    ),
    (
        "semgrep",
        "#1300",
        &[(
            "semgrep-review-extension",
            ".claude/skills/security-invariants/SKILL.md",
        )],
    ),
    (
        "codegraph",
        "#838",
        &[
            (
                "codegraph-search-extension",
                ".claude/skills/structural-search/SKILL.md",
            ),
            (
                "codegraph-researcher-extension",
                ".claude/agents/researcher.md",
            ),
            ("codegraph-explorer-extension", ".claude/agents/explorer.md"),
            (
                "codegraph-implementer-extension",
                ".claude/agents/implementer.md",
            ),
            ("codegraph-reviewer-extension", ".claude/agents/reviewer.md"),
        ],
    ),
    (
        "tgrep",
        "#838",
        &[
            (
                "tgrep-search-extension",
                ".claude/skills/structural-search/SKILL.md",
            ),
            ("tgrep-researcher-extension", ".claude/agents/researcher.md"),
            ("tgrep-explorer-extension", ".claude/agents/explorer.md"),
            (
                "tgrep-implementer-extension",
                ".claude/agents/implementer.md",
            ),
            ("tgrep-reviewer-extension", ".claude/agents/reviewer.md"),
        ],
    ),
];

/// Own keys of `KNOWN_PLUGINS`.
pub const KNOWN_PLUGINS: &[&str] = &["engram", "acli", "gh", "codegraph", "tgrep"];

/// `Object.prototype` members: `KNOWN_PLUGINS[id]` is truthy for these, so the TS takes the
/// manifest branch and fails with an absolute path Rust does not reproduce.
const PROTOTYPE_KEYS: &[&str] = &[
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// `isRetiredPlugin`.
#[must_use]
pub fn retired_plugin(id: &str) -> Option<&'static RetiredPlugin> {
    RETIRED_PLUGINS
        .iter()
        .find_map(|(candidate, entry)| (*candidate == id).then_some(entry))
}

fn script_basename(asset: &str) -> Option<&str> {
    let rest = asset.strip_prefix(".claude/scripts/")?;
    Some(rest.rsplit('/').next().unwrap_or(rest))
}

/// `retiredScriptBasenames`, in insertion order.
#[must_use]
pub fn retired_script_basenames() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for (_, entry) in RETIRED_PLUGINS {
        for asset in entry.assets {
            if let Some(name) = script_basename(asset)
                && !out.contains(&name)
            {
                out.push(name);
            }
        }
    }
    out
}

/// `retiredPluginForScript`.
#[must_use]
pub fn retired_plugin_for_script(name: &str) -> Option<(&'static str, &'static RetiredPlugin)> {
    RETIRED_PLUGINS
        .iter()
        .find(|(_, entry)| {
            entry
                .assets
                .iter()
                .any(|asset| script_basename(asset) == Some(name))
        })
        .map(|(id, entry)| (*id, entry))
}

/// `listBundledPluginIds`: every embedded `packages/plugins/<id>/` root, sorted.
#[must_use]
pub fn bundled_plugin_ids() -> Vec<String> {
    let ids: BTreeSet<String> = assets::under("packages/plugins/")
        .filter_map(|(path, _)| {
            let rest = path.strip_prefix("packages/plugins/")?;
            rest.split_once('/').map(|(id, _)| id.to_owned())
        })
        .collect();
    ids.into_iter().collect()
}

/// A resolved file entry: `id` and its path relative to the plugin root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginAsset {
    /// Entry id.
    pub id: String,
    /// Normalized path under the plugin root (`assets::plugin(plugin, path)`).
    pub path: String,
}

/// `scriptAssets[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginScript {
    /// Source, normalized under the plugin root.
    pub src: String,
    /// `dest`, verbatim (relative to the engine's scripts dir).
    pub dest: String,
    /// chmod +x after copy.
    pub exec: bool,
}

/// `hookExtensionAssets[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginHookExtension {
    /// Managed sub-block id.
    pub id: String,
    /// Target hook, repo-relative.
    pub target: String,
    /// Body, normalized under the plugin root.
    pub path: String,
}

/// `skillAssets[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSkill {
    /// Skill id.
    pub id: String,
    /// Body, normalized under the plugin root.
    pub path: String,
    /// `recommendedAgent`.
    pub recommended_agent: Option<String>,
    /// `injectInto`.
    pub inject_into: Option<String>,
    /// `mcpTools`.
    pub mcp_tools: Option<Vec<String>>,
}

/// `LoadedPlugin`, with paths relative to the plugin root instead of absolute.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedPlugin {
    /// Directory name under `packages/plugins/` (the declared id).
    pub dir: String,
    /// The manifest as `PluginManifestSchema` outputs it.
    pub manifest: JsValue,
    /// `nativeHookOmitted`.
    pub native_hook_omitted: bool,
    /// `managedAssets`.
    pub managed_assets: Vec<PluginAsset>,
    /// `scriptAssets`.
    pub script_assets: Vec<PluginScript>,
    /// `hookExtensionAssets`.
    pub hook_extension_assets: Vec<PluginHookExtension>,
    /// `skillAssets`.
    pub skill_assets: Vec<PluginSkill>,
}

impl LoadedPlugin {
    /// `manifest.id`.
    #[must_use]
    pub fn manifest_id(&self) -> String {
        field_text(&self.manifest, "id").unwrap_or_default()
    }
}

/// Why `load_plugin` did not return a plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginLoadError {
    /// `PluginNotFoundError`.
    NotFound,
    /// The TS would throw something Rust does not reproduce; the invocation goes to the TS.
    Delegate,
}

fn present(value: &JsValue) -> Parsed {
    match value {
        JsValue::Undefined => Err(Invalid),
        _ => Ok(value.clone()),
    }
}

fn bilingual(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("es", present)?
        .required("en", present)?
        .strip())
}

fn managed_entry(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("id", present)?
        .required("file", present)?
        .optional("recommendedAgent", present)?
        .strip())
}

fn version_advisory(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("below", present)?
        .required("reason", bilingual)?
        .optional("ref", present)?
        .strip())
}

fn capability_probe(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("args", present)?
        .required("mustContain", present)?
        .required("minVersion", present)?
        .strip())
}

fn latest_release(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("source", present)?
        .required("id", present)?
        .defaulted("notify", JsValue::string("minor"), present)?
        .strip())
}

fn external_tool(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("name", present)?
        .optional("checkBinary", present)?
        .optional("install", present)?
        .optional("installDocs", present)?
        .optional("postInstall", present)?
        .optional("pinnedVersion", present)?
        .optional("capabilityProbe", capability_probe)?
        .optional("versionAdvisory", |v| array_of(v, version_advisory))?
        .optional("latestRelease", latest_release)?
        .strip())
}

fn mcp_server(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("command", present)?
        .defaulted("args", empty_array(), present)?
        .optional("env", present)?
        .optional("alwaysLoad", present)?
        .strip())
}

fn hook_entry(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("event", present)?
        .optional("matcher", present)?
        .required("command", present)?
        .optional("timeout", present)?
        .optional("statusMessage", present)?
        .optional("mainThreadOnly", present)?
        .strip())
}

fn script_entry(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("src", present)?
        .required("dest", present)?
        .defaulted("exec", JsValue::Bool(true), present)?
        .strip())
}

fn hook_extension(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("id", present)?
        .required("target", present)?
        .required("file", present)?
        .strip())
}

fn skill_entry(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("id", present)?
        .required("file", present)?
        .optional("recommendedAgent", present)?
        .optional("injectInto", present)?
        .optional("mcpTools", present)?
        .strip())
}

fn prompt_option(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("value", present)?
        .required("label", bilingual)?
        .strip())
}

fn prompt_entry(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("key", present)?
        .optional("phase", present)?
        .required("question", bilingual)?
        .required("type", present)?
        .optional("options", |v| array_of(v, prompt_option))?
        .optional("placeholder", present)?
        .defaulted("optional", JsValue::Bool(false), present)?
        .strip())
}

/// `PluginManifestSchema`'s output shape.
fn manifest(value: &JsValue) -> Parsed {
    Ok(Shape::new(value)?
        .required("id", present)?
        .required("name", present)?
        .required("description", present)?
        .required("version", present)?
        .defaulted("managed", empty_array(), |v| array_of(v, managed_entry))?
        .optional("externalTool", external_tool)?
        .optional("mcpServer", mcp_server)?
        .optional("settingsFragment", present)?
        .optional("hooks", |v| array_of(v, hook_entry))?
        .optional("scripts", |v| array_of(v, script_entry))?
        .optional("hookExtensions", |v| array_of(v, hook_extension))?
        .optional("skills", |v| array_of(v, skill_entry))?
        .optional("prompts", |v| array_of(v, prompt_entry))?
        .defaulted("invariants", empty_array(), present)?
        .strip())
}

fn field<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn field_text(value: &JsValue, key: &str) -> Option<String> {
    match field(value, key)? {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

fn entries<'a>(manifest: &'a JsValue, key: &str) -> &'a [JsValue] {
    match field(manifest, key) {
        Some(JsValue::Array(items)) => items,
        _ => &[],
    }
}

/// `resolve(packageRoot, file)` plus the containment check, relative to the root.
fn contain(file: &str) -> Result<String, PluginLoadError> {
    if file.starts_with('/') {
        return Err(PluginLoadError::Delegate);
    }
    let mut parts: Vec<&str> = Vec::new();
    for segment in file.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or(PluginLoadError::Delegate)?;
            }
            other => parts.push(other),
        }
    }
    Ok(parts.join("/"))
}

fn required_text(entry: &JsValue, key: &str) -> Result<String, PluginLoadError> {
    field_text(entry, key).ok_or(PluginLoadError::Delegate)
}

fn optional_text(entry: &JsValue, key: &str) -> Result<Option<String>, PluginLoadError> {
    match field(entry, key) {
        None => Ok(None),
        Some(_) => required_text(entry, key).map(Some),
    }
}

fn skill_asset(entry: &JsValue) -> Result<PluginSkill, PluginLoadError> {
    let mcp_tools = match field(entry, "mcpTools") {
        None => None,
        Some(JsValue::Array(items)) => Some(
            items
                .iter()
                .map(|item| match item {
                    JsValue::String(text) => text.to_rust().ok_or(PluginLoadError::Delegate),
                    _ => Err(PluginLoadError::Delegate),
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Some(_) => return Err(PluginLoadError::Delegate),
    };
    Ok(PluginSkill {
        id: required_text(entry, "id")?,
        path: contain(&required_text(entry, "file")?)?,
        recommended_agent: optional_text(entry, "recommendedAgent")?,
        inject_into: optional_text(entry, "injectInto")?,
        mcp_tools,
    })
}

/// `loadPlugin`, against the embedded bundle.
///
/// # Errors
/// [`PluginLoadError::NotFound`] for an id no bundle or `KNOWN_PLUGINS` knows; `Delegate` for
/// anything else the TS would reject.
pub fn load_plugin(id: &str) -> Result<LoadedPlugin, PluginLoadError> {
    if !bundled_plugin_ids().iter().any(|bundled| bundled == id) {
        if KNOWN_PLUGINS.contains(&id) || PROTOTYPE_KEYS.contains(&id) {
            return Err(PluginLoadError::Delegate);
        }
        return Err(PluginLoadError::NotFound);
    }
    let bytes = assets::plugin(id, "plugin.json").ok_or(PluginLoadError::Delegate)?;
    let text = std::str::from_utf8(bytes).map_err(|_| PluginLoadError::Delegate)?;
    plugin_from_manifest(id, text)
}

/// The part of `loadPlugin` after reading `plugin.json`: parse, schema output and asset paths.
///
/// Leaf values are not validated (see the module docs): a manifest the TS schema rejects may load
/// here, but one that escapes the plugin root always delegates.
///
/// # Errors
/// [`PluginLoadError::Delegate`] for invalid JSON, a wrong shape or an escaping path.
pub fn plugin_from_manifest(dir: &str, text: &str) -> Result<LoadedPlugin, PluginLoadError> {
    let raw = js_json::parse(text).ok_or(PluginLoadError::Delegate)?;
    let manifest = manifest(&raw).map_err(|_| PluginLoadError::Delegate)?;

    let managed_assets = entries(&manifest, "managed")
        .iter()
        .map(|entry| {
            Ok(PluginAsset {
                id: required_text(entry, "id")?,
                path: contain(&required_text(entry, "file")?)?,
            })
        })
        .collect::<Result<Vec<_>, PluginLoadError>>()?;
    let script_assets = entries(&manifest, "scripts")
        .iter()
        .map(|entry| {
            Ok(PluginScript {
                src: contain(&required_text(entry, "src")?)?,
                dest: required_text(entry, "dest")?,
                exec: !matches!(field(entry, "exec"), Some(JsValue::Bool(false))),
            })
        })
        .collect::<Result<Vec<_>, PluginLoadError>>()?;
    let hook_extension_assets = entries(&manifest, "hookExtensions")
        .iter()
        .map(|entry| {
            Ok(PluginHookExtension {
                id: required_text(entry, "id")?,
                target: required_text(entry, "target")?,
                path: contain(&required_text(entry, "file")?)?,
            })
        })
        .collect::<Result<Vec<_>, PluginLoadError>>()?;
    let skill_assets = entries(&manifest, "skills")
        .iter()
        .map(skill_asset)
        .collect::<Result<Vec<_>, PluginLoadError>>()?;

    Ok(LoadedPlugin {
        dir: dir.to_owned(),
        manifest,
        native_hook_omitted: false,
        managed_assets,
        script_assets,
        hook_extension_assets,
        skill_assets,
    })
}

/// `PluginsLoadResult`; manifest failures delegate, so `missing` only carries unknown ids.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PluginsLoadResult {
    /// Loaded plugins, in config order.
    pub loaded: Vec<LoadedPlugin>,
    /// Ids no bundle knows (reason `unknown plugin id`).
    pub missing: Vec<String>,
    /// Ids in `RETIRED_PLUGINS`.
    pub retired: Vec<String>,
}

/// `loadEnabledPlugins`.
///
/// # Errors
/// Whatever the TS would throw or report with a message Rust does not reproduce.
pub fn load_enabled_plugins(
    plugins: Option<&JsValue>,
) -> Result<PluginsLoadResult, PluginLoadError> {
    load_plugins_where(plugins, true)
}

/// `loadDisabledPlugins`.
///
/// # Errors
/// As [`load_enabled_plugins`].
pub fn load_disabled_plugins(
    plugins: Option<&JsValue>,
) -> Result<PluginsLoadResult, PluginLoadError> {
    load_plugins_where(plugins, false)
}

/// `nativeHook: true` (spec 0045 R4): the native git hook runs the check, so a plugin with hooks
/// keeps everything else but registers none.
#[must_use]
pub fn with_native_hook(mut plugin: LoadedPlugin, settings: &JsObject) -> LoadedPlugin {
    let has_hooks = !entries(&plugin.manifest, "hooks").is_empty();
    if settings.get("nativeHook") == Some(&JsValue::Bool(true)) && has_hooks {
        plugin.manifest = without_hooks(&plugin.manifest);
        plugin.native_hook_omitted = true;
    }
    plugin
}

fn without_hooks(manifest: &JsValue) -> JsValue {
    let JsValue::Object(object) = manifest else {
        return manifest.clone();
    };
    let mut out = JsObject::new();
    for (key, value) in object.entries() {
        let value = if key.is("hooks") {
            empty_array()
        } else {
            value.clone()
        };
        out.insert(key.clone(), value);
    }
    JsValue::Object(out)
}

fn load_plugins_where(
    plugins: Option<&JsValue>,
    enabled: bool,
) -> Result<PluginsLoadResult, PluginLoadError> {
    let mut result = PluginsLoadResult::default();
    let object = match plugins {
        None | Some(JsValue::Undefined | JsValue::Null) => return Ok(result),
        Some(JsValue::Object(object)) => object,
        Some(_) => return Err(PluginLoadError::Delegate),
    };
    for (key, entry) in object.ordered() {
        let JsValue::Object(settings) = entry else {
            return Err(PluginLoadError::Delegate);
        };
        if settings.get("enabled") != Some(&JsValue::Bool(enabled)) {
            continue;
        }
        let id = key.to_rust().ok_or(PluginLoadError::Delegate)?;
        match load_plugin(&id) {
            Ok(plugin) => result.loaded.push(with_native_hook(plugin, settings)),
            Err(PluginLoadError::NotFound) if retired_plugin(&id).is_some() => {
                result.retired.push(id);
            }
            Err(PluginLoadError::NotFound) => result.missing.push(id),
            Err(PluginLoadError::Delegate) => return Err(PluginLoadError::Delegate),
        }
    }
    Ok(result)
}
