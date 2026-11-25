//! The part of `lib/assets/model-profile.ts` the Codex render uses (spec 0059 T19, D37):
//! `resolveCodexProfile`, `plannedCodexProfileInput`, the read-only native TOML fields
//! (`nativeFields`, `readNativeCodexProfile`) and the diagnostics of `projectCodexProfiles`.
//!
//! Host evidence and catalog freshness (`hostEvidence`, `inspectCodexCatalog`) never reach the
//! render, so a row carries no `catalog`, `application` or `observed` here.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::js_json::JsValue;
use crate::markers::{CommentStyle, remove_managed_section};
use crate::render::codex_catalog::{CodexModelSource, ModelDelegate, resolve_codex_model_value};
use crate::render::frontmatter::{parse_frontmatter_fields, split_frontmatter};
use crate::render::harness_files::{HarnessDelegate, asset_text};
use crate::render::harness_plan::PlannedAgent;

/// `CODEX_MODEL_BY_CLAUDE_TIER`: built-in family per Claude tier.
const CODEX_MODEL_BY_CLAUDE_TIER: [(&str, &str); 3] =
    [("opus", "sol"), ("sonnet", "luna"), ("haiku", "luna")];

/// `model_reasoning_effort` values a native file may declare.
const NATIVE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Why a profile cannot be resolved natively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileDelegate {
    /// A model the TS resolves (see [`ModelDelegate`]).
    Model,
    /// An agent asset is missing or not UTF-8.
    Asset,
}

impl From<ModelDelegate> for ProfileDelegate {
    fn from(_: ModelDelegate) -> Self {
        Self::Model
    }
}

impl From<HarnessDelegate> for ProfileDelegate {
    fn from(_: HarnessDelegate) -> Self {
        Self::Asset
    }
}

/// `ProfileOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileOrigin {
    /// Set explicitly.
    Explicit,
    /// Mapped from a Claude tier or effort.
    Mapped,
    /// Left to native inheritance.
    Inherited,
}

impl ProfileOrigin {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Mapped => "mapped",
            Self::Inherited => "inherited",
        }
    }
}

/// `ProfileValue` without `effectiveObserved`, always `null` in a static projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileValue {
    /// `configured`.
    pub configured: Option<String>,
    /// `origin`.
    pub origin: ProfileOrigin,
    /// `wouldRender`.
    pub would_render: Option<String>,
    /// `mapping`: `true` for `configured`, `false` for `built-in`; model only.
    pub configured_mapping: Option<bool>,
    /// `source`; model only.
    pub source: Option<CodexModelSource>,
}

impl ProfileValue {
    const fn inherited() -> Self {
        Self {
            configured: None,
            origin: ProfileOrigin::Inherited,
            would_render: None,
            configured_mapping: None,
            source: None,
        }
    }

    fn explicit(value: &str) -> Self {
        Self {
            configured: Some(value.to_owned()),
            origin: ProfileOrigin::Explicit,
            would_render: Some(value.to_owned()),
            configured_mapping: None,
            source: None,
        }
    }
}

/// `CodexProfileInput`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexProfileInput {
    /// Native name.
    pub name: String,
    /// Claude tier.
    pub tier: Option<String>,
    /// Claude effort.
    pub effort: Option<String>,
    /// Model currently rendered for this name.
    pub previous: Option<String>,
}

/// `CodexProfileChoice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexProfileChoice {
    /// Model field.
    pub model: ProfileValue,
    /// Effort field.
    pub effort: ProfileValue,
    /// Diagnostics.
    pub diagnostics: Vec<String>,
}

fn get<'a>(value: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    match value? {
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

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// `config.models?.codexProfiles?.[name]`, own properties only.
fn profile_override(config: &JsValue, name: &str) -> (Option<String>, Option<String>) {
    let entry = get(get(get(Some(config), "models"), "codexProfiles"), name);
    (text(get(entry, "model")), text(get(entry, "effort")))
}

/// `resolveCodexProfile`: model and effort resolved independently; a Claude effort is input,
/// never a Codex override.
///
/// # Errors
/// [`ModelDelegate`] when the model resolution is left to the TS.
pub fn resolve_codex_profile(
    config: &JsValue,
    input: &CodexProfileInput,
    catalog: Option<&Path>,
) -> Result<CodexProfileChoice, ModelDelegate> {
    let (override_model, override_effort) = profile_override(config, &input.name);
    let tier = input.tier.as_deref();
    let mut diagnostics = Vec::new();
    let valid_tier = tier.filter(|tier| matches!(*tier, "opus" | "sonnet" | "haiku"));
    if let Some(tier) = non_empty(tier)
        && valid_tier.is_none()
    {
        diagnostics.push(format!("unknown Claude model tier: {tier}"));
    }
    let previous = input.previous.as_deref();
    let choice = if let Some(value) = non_empty(override_model.as_deref()) {
        Some((resolve_codex_model_value(value, catalog, previous)?, true))
    } else if let Some(tier) = valid_tier {
        let configured = text(get(get(get(Some(config), "models"), "codexMap"), tier));
        let builtin = CODEX_MODEL_BY_CLAUDE_TIER
            .iter()
            .find_map(|(key, family)| (*key == tier).then_some(*family))
            .unwrap_or_default();
        let value = configured.as_deref().unwrap_or(builtin);
        Some((
            resolve_codex_model_value(value, catalog, previous)?,
            configured.is_some(),
        ))
    } else {
        None
    };
    let effort = override_effort.clone().or_else(|| {
        if tier == Some("sonnet") && input.effort.as_deref() == Some("medium") {
            Some("high".to_owned())
        } else {
            input.effort.clone()
        }
    });
    let model = match choice {
        Some((resolution, configured_mapping)) => ProfileValue {
            configured: override_model.clone().or_else(|| input.tier.clone()),
            origin: if non_empty(override_model.as_deref()).is_some() {
                ProfileOrigin::Explicit
            } else {
                ProfileOrigin::Mapped
            },
            would_render: Some(resolution.model),
            configured_mapping: Some(configured_mapping),
            source: Some(resolution.source),
        },
        None => ProfileValue::inherited(),
    };
    let effort = match non_empty(effort.as_deref()) {
        Some(value) => ProfileValue {
            configured: override_effort.clone().or_else(|| input.effort.clone()),
            origin: if non_empty(override_effort.as_deref()).is_some()
                || Some(value) == input.effort.as_deref()
            {
                ProfileOrigin::Explicit
            } else {
                ProfileOrigin::Mapped
            },
            would_render: Some(value.to_owned()),
            configured_mapping: None,
            source: None,
        },
        None => ProfileValue::inherited(),
    };
    Ok(CodexProfileChoice {
        model,
        effort,
        diagnostics,
    })
}

/// `plannedCodexProfileInput`: core roles read `models`/`effort` by `modelKey`, preset extras
/// their source frontmatter.
///
/// # Errors
/// [`HarnessDelegate`] when the asset is missing or not UTF-8 (the TS reads it for every agent).
pub fn planned_codex_profile_input(
    source: &PlannedAgent,
    config: &JsValue,
) -> Result<CodexProfileInput, HarnessDelegate> {
    let raw = asset_text(&source.asset)?;
    let (tier, effort) = match source.model_key {
        Some(key) => (
            text(get(get(Some(config), "models"), key)),
            text(get(get(Some(config), "effort"), key)),
        ),
        None => {
            let fields = parse_frontmatter_fields(split_frontmatter(&raw).frontmatter);
            (
                fields.get("model").map(str::to_owned),
                fields.get("effort").map(str::to_owned),
            )
        }
    };
    Ok(CodexProfileInput {
        name: source.id.clone(),
        tier,
        effort,
        previous: None,
    })
}

/// What `nativeFields` reads from a project-native TOML file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeFields {
    /// `name`, when a valid native name.
    pub name: Option<String>,
    /// `model`, when a string.
    pub model: Option<String>,
    /// `model_reasoning_effort`, when a string.
    pub effort: Option<String>,
    /// Carries a navori `*-codex-base` block.
    pub managed: bool,
    /// `config.toml` only: `model` outside navori's block.
    pub user_model: Option<String>,
    /// `config.toml` only: `model_reasoning_effort` outside navori's block.
    pub user_effort: Option<String>,
    /// Why the file is unusable or invalid.
    pub diagnostic: Option<&'static str>,
}

impl NativeFields {
    fn failed(diagnostic: &'static str) -> Self {
        Self {
            diagnostic: Some(diagnostic),
            ..Self::default()
        }
    }
}

/// `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`.
fn is_native_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

static MANAGED_BASE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"\A# navori:managed start id="[^"]+-codex-base" "#).ok());

/// `/^# navori:managed start id="[^"]+-codex-base" /m`, with JS line starts (after `\n`, `\r`,
/// U+2028 and U+2029).
fn has_managed_base(text: &str) -> bool {
    let Some(pattern) = MANAGED_BASE.as_ref() else {
        return false;
    };
    let starts = std::iter::once(0).chain(
        text.char_indices()
            .filter(|(_, ch)| matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(at, ch)| at + ch.len_utf8()),
    );
    starts
        .filter(|start| *start <= text.len())
        .any(|start| pattern.is_match(&text[start..]))
}

/// `parseToml`: the root table, or `None` when the document is not valid TOML.
fn parse_toml(text: &str) -> Option<toml::Table> {
    text.parse::<toml::Table>().ok()
}

fn toml_text(table: &toml::Table, key: &str) -> Option<String> {
    match table.get(key) {
        Some(toml::Value::String(value)) => Some(value.clone()),
        _ => None,
    }
}

/// `nativeFields`: a native TOML file read defensively, never followed outside the checkout.
#[must_use]
pub fn native_fields(path: &Path, cwd: &Path) -> NativeFields {
    let (Ok(root), Ok(real)) = (std::fs::canonicalize(cwd), std::fs::canonicalize(path)) else {
        return NativeFields::failed("missing or malformed native TOML");
    };
    if real.strip_prefix(&root).is_err() {
        return NativeFields::failed("native path escapes project");
    }
    let Ok(bytes) = std::fs::read(path) else {
        return NativeFields::failed("missing or malformed native TOML");
    };
    let text = String::from_utf8_lossy(&bytes);
    let Some(value) = parse_toml(&text) else {
        return NativeFields::failed("missing or malformed native TOML");
    };
    let user = if path.to_string_lossy().ends_with("/config.toml") {
        match parse_toml(&remove_managed_section(
            &text,
            "codex-config-base",
            CommentStyle::Shell,
        )) {
            Some(user) => Some(user),
            None => return NativeFields::failed("missing or malformed native TOML"),
        }
    } else {
        None
    };
    let model = value.get("model");
    let effort = value.get("model_reasoning_effort");
    let invalid = model.is_some_and(|model| !model.is_str())
        || effort.is_some_and(|effort| {
            effort
                .as_str()
                .is_none_or(|effort| !NATIVE_EFFORTS.contains(&effort))
        });
    NativeFields {
        name: toml_text(&value, "name").filter(|name| is_native_name(name)),
        model: toml_text(&value, "model"),
        effort: toml_text(&value, "model_reasoning_effort"),
        managed: has_managed_base(&text),
        user_model: user.as_ref().and_then(|user| toml_text(user, "model")),
        user_effort: user
            .as_ref()
            .and_then(|user| toml_text(user, "model_reasoning_effort")),
        diagnostic: invalid.then_some("invalid native model/effort"),
    }
}

/// `readNativeCodexProfile`: `orchestrator` reads `.codex/config.toml`, any other valid name its
/// `.codex/agents/<name>.toml`.
#[must_use]
pub fn read_native_codex_profile(cwd: &Path, agent_id: &str) -> NativeFields {
    if !is_native_name(agent_id) {
        return NativeFields::failed("unknown native name");
    }
    let rel = if agent_id == "orchestrator" {
        ".codex/config.toml".to_owned()
    } else {
        format!(".codex/agents/{agent_id}.toml")
    };
    native_fields(&cwd.join(rel), cwd)
}

/// Where a projected row comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileRowOrigin {
    /// The main thread (`.codex/config.toml`).
    Main,
    /// A core role.
    Core,
    /// A preset extra.
    Extra,
    /// A project-native agent navori does not manage.
    Local,
}

/// One `CodexProfileProjection`, reduced to what the render reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRow {
    /// `nativeName`.
    pub native_name: String,
    /// `origin`.
    pub origin: ProfileRowOrigin,
    /// Repo-relative native path.
    pub path: String,
    /// Model field.
    pub model: ProfileValue,
    /// Effort field.
    pub effort: ProfileValue,
    /// `rendered`: (model, effort) on disk, `None` when the file is unusable.
    pub rendered: Option<(Option<String>, Option<String>)>,
    /// Diagnostics, in the TS order.
    pub diagnostics: Vec<String>,
}

fn rendered_of(native: &NativeFields) -> Option<(Option<String>, Option<String>)> {
    native
        .diagnostic
        .is_none()
        .then(|| (native.model.clone(), native.effort.clone()))
}

/// `.codex/agents/*.toml` file names in JS `sort()` order, or the escape diagnostic.
fn native_agent_files(cwd: &Path) -> Result<Vec<String>, &'static str> {
    let directory = cwd.join(".codex/agents");
    let (Ok(root), Ok(real)) = (
        std::fs::canonicalize(cwd),
        std::fs::canonicalize(&directory),
    ) else {
        return Ok(Vec::new());
    };
    if real.strip_prefix(&root).is_err() {
        return Err("native agents directory escapes project");
    }
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let mut files: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|file| file.ends_with(".toml"))
        .collect();
    files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(files)
}

/// `projectCodexProfiles` over the planned agents, without host evidence: the managed
/// inventory, then the read-only project-native agents, with the TS diagnostics in order.
///
/// # Errors
/// [`ProfileDelegate`] when a profile or an agent asset cannot be resolved natively.
pub fn project_codex_profiles(
    cwd: &Path,
    config: &JsValue,
    catalog: Option<&Path>,
    agents: &[PlannedAgent],
) -> Result<Vec<ProfileRow>, ProfileDelegate> {
    let mut shared: Vec<String> = Vec::new();
    let mut rows: Vec<ProfileRow> = Vec::new();
    let add = |rows: &mut Vec<ProfileRow>,
               shared: &[String],
               input: CodexProfileInput,
               origin: ProfileRowOrigin,
               path: String,
               rendered: Option<(Option<String>, Option<String>)>|
     -> Result<usize, ProfileDelegate> {
        let choice = resolve_codex_profile(config, &input, catalog)?;
        let mut diagnostics = shared.to_vec();
        diagnostics.extend(choice.diagnostics);
        rows.push(ProfileRow {
            native_name: input.name,
            origin,
            path,
            model: choice.model,
            effort: choice.effort,
            rendered,
            diagnostics,
        });
        Ok(rows.len() - 1)
    };

    let main_path = ".codex/config.toml";
    let main = native_fields(&cwd.join(main_path), cwd);
    let principal = add(
        &mut rows,
        &shared,
        CodexProfileInput {
            name: "orchestrator".to_owned(),
            tier: text(get(get(Some(config), "models"), "orchestrator")),
            effort: text(get(get(Some(config), "effort"), "orchestrator")),
            previous: main.model.clone(),
        },
        ProfileRowOrigin::Main,
        main_path.to_owned(),
        rendered_of(&main),
    )?;
    if non_empty(main.user_model.as_deref()).is_some()
        || non_empty(main.user_effort.as_deref()).is_some()
    {
        rows[principal].diagnostics.push(
            "user-owned main profile preserved; project intent requires a human decision"
                .to_owned(),
        );
    }

    let mut owned: Vec<String> = Vec::new();
    for agent in agents {
        let path = format!(".codex/agents/{}.toml", agent.id);
        let native = native_fields(&cwd.join(&path), cwd);
        if native.managed {
            owned.push(path.clone());
        }
        let mut input = planned_codex_profile_input(agent, config)?;
        input.previous = native.model.clone();
        let origin = if agent.model_key.is_some() {
            ProfileRowOrigin::Core
        } else {
            ProfileRowOrigin::Extra
        };
        let row = add(
            &mut rows,
            &shared,
            input,
            origin,
            path.clone(),
            rendered_of(&native),
        )?;
        if !native.managed && cwd.join(&path).exists() {
            rows[row]
                .diagnostics
                .push("managed placement collides with a user-owned native path".to_owned());
        }
        if let Some(name) = native.name.as_deref()
            && name != agent.id
        {
            rows[row]
                .diagnostics
                .push(format!("managed native name mismatch: {name}"));
        }
    }

    let files = native_agent_files(cwd).unwrap_or_else(|diagnostic| {
        shared.push(diagnostic.to_owned());
        Vec::new()
    });
    for file in files {
        let path = format!(".codex/agents/{file}");
        if owned.contains(&path) {
            continue;
        }
        let native = native_fields(&cwd.join(&path), cwd);
        if native.managed {
            shared.push(format!(
                "disabled or unplanned managed native agent: {path}"
            ));
            continue;
        }
        let name = native
            .name
            .clone()
            .unwrap_or_else(|| format!("unknown:{file}"));
        let row = add(
            &mut rows,
            &shared,
            CodexProfileInput {
                name,
                ..CodexProfileInput::default()
            },
            ProfileRowOrigin::Local,
            path,
            Some((native.model.clone(), native.effort.clone())),
        )?;
        let row = &mut rows[row];
        if native.name.is_none() {
            row.diagnostics
                .push("missing or unknown native name".to_owned());
        }
        if let Some(diagnostic) = native.diagnostic {
            row.diagnostics.push(diagnostic.to_owned());
        }
        let (override_model, override_effort) =
            profile_override(config, native.name.as_deref().unwrap_or_default());
        for (field, value, overridden) in [
            ("model", &native.model, &override_model),
            ("effort", &native.effort, &override_effort),
        ] {
            let overridden = non_empty(overridden.as_deref()).is_some();
            let slot = if field == "model" {
                &mut row.model
            } else {
                &mut row.effort
            };
            match value {
                Some(value) => {
                    if overridden && slot.would_render.as_deref() != Some(value) {
                        row.diagnostics.push(format!(
                            "local {field} conflicts with project override; human decision required"
                        ));
                    }
                    let slot = if field == "model" {
                        &mut row.model
                    } else {
                        &mut row.effort
                    };
                    *slot = ProfileValue::explicit(value);
                }
                None if overridden => row.diagnostics.push(format!(
                    "local {field} override requires a supported native request; file remains inherited"
                )),
                None => {}
            }
        }
    }

    let names: Vec<String> = rows.iter().map(|row| row.native_name.clone()).collect();
    for row in &mut rows {
        let missing: Vec<String> = shared
            .iter()
            .filter(|diagnostic| !row.diagnostics.contains(diagnostic))
            .cloned()
            .collect();
        row.diagnostics.extend(missing);
        if names
            .iter()
            .filter(|name| **name == row.native_name)
            .count()
            > 1
        {
            row.diagnostics
                .push(format!("duplicate native name: {}", row.native_name));
        }
    }
    let overrides = match get(get(Some(config), "models"), "codexProfiles") {
        Some(JsValue::Object(profiles)) => profiles
            .entries()
            .iter()
            .filter_map(|(name, _)| name.to_rust())
            .collect(),
        _ => Vec::new(),
    };
    for name in overrides {
        if !names.contains(&name) {
            for row in &mut rows {
                row.diagnostics
                    .push(format!("override for unknown native name: {name}"));
            }
        }
    }
    Ok(rows)
}
