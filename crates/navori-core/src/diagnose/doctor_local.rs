//! `doctor`'s repo-local pure scans (spec 0060 T23 slice 3a, R73, R76): reads of the repo and of
//! the bundled registries, with no spawn and no host-global state.
//!
//! Each scan mirrors its TS twin's ordering, fields and edge cases. Where the TS result depends on
//! something this port does not model (enabled monorepo workspaces, V8's `JSON.parse` messages,
//! text that is not UTF-8, the hook-source scan of a retired plugin's assets, a preset or plugin
//! the loader delegates), the scan returns [`Unmodeled`] and the CLI delegates to the TS.

use std::path::Path;

use crate::config::Config;
use crate::diagnose::health::{
    MarkerInfo, collect_marker_files, configured_engines, list_markers, read_text,
};
use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsObject, JsValue, number_to_js};
use crate::markers::{CommentStyle, extract_managed_content, prose_lines, reorder_managed_blocks};
use crate::render::block_plan::canonical_managed_order;
use crate::render::claude_md::{CLAUDE_COMPUTED_BLOCK_IDS, has_monorepo_workspaces};
use crate::render::collect::DiskView;
use crate::render::harness_plan::resolve_harness_plan;
use crate::render::mcp_file::build_desired_mcp_servers;
use crate::render::plan::{CORE_MANAGED_ASSETS, EXCLUDABLE_BLOCK_IDS};
use crate::render::plugins::{
    KNOWN_PLUGINS, PluginLoadError, RETIRED_PLUGIN_BLOCKS, RETIRED_PLUGIN_SUB_BLOCKS,
    RETIRED_PLUGINS, bundled_plugin_ids, load_enabled_plugins, load_plugin,
};
use crate::render::presets::{ResolvedPreset, load_preset, preset_exists, resolve_preset};
use crate::render::removable::{Authorship, navori_authorship};
use crate::render::retirements::{RETIRED_AGENTS, RETIRED_HOOKS, RETIRED_SKILLS};
pub use crate::workspace::patterns::Unmodeled;

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/// `value[key]` on a plain object.
fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`.
const fn as_plain_object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(object) => Some(object),
        _ => None,
    }
}

/// JS truthiness of a JSON value (`undefined` for an absent key).
fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => false,
        Some(JsValue::Bool(flag)) => *flag,
        Some(JsValue::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(JsValue::String(text)) => !text.units().is_empty(),
        Some(JsValue::Array(_) | JsValue::Object(_)) => true,
    }
}

/// A JS string value as Rust text; a lone surrogate is [`Unmodeled`].
fn js_text(value: &JsValue) -> Result<Option<String>, Unmodeled> {
    match value {
        JsValue::String(text) => text.to_rust().map(Some).ok_or(Unmodeled),
        _ => Ok(None),
    }
}

/// `config.<key>` as text, required by the schema.
fn config_text(config: &JsValue, key: &str) -> Result<String, Unmodeled> {
    get(config, key)
        .map(js_text)
        .transpose()?
        .flatten()
        .ok_or(Unmodeled)
}

/// `config.engines.includes(engine)`.
fn has_engine(config: &JsValue, engine: &str) -> Result<bool, Unmodeled> {
    Ok(configured_engines(config)
        .ok_or(Unmodeled)?
        .iter()
        .any(|e| e == engine))
}

/// JS `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Array `.sort()` with no comparator: UTF-16 code-unit order.
fn js_sort(items: &mut [String]) {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `text.slice(0, units)` in UTF-16 code units; cutting a surrogate pair is [`Unmodeled`].
fn js_slice(text: &str, units: usize) -> Result<&str, Unmodeled> {
    let mut used = 0;
    for (at, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if used + width > units {
            return if used < units {
                Err(Unmodeled)
            } else {
                Ok(&text[..at])
            };
        }
        used += width;
    }
    Ok(text)
}

/// `readdirSync(dir)` names in libuv's byte order; `None` when it throws, a non-UTF-8 name is
/// [`Unmodeled`].
fn read_dir_names(dir: &Path) -> Result<Option<Vec<String>>, Unmodeled> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let mut names = Vec::new();
    for entry in read {
        let Ok(entry) = entry else {
            return Ok(None);
        };
        names.push(entry.file_name().into_string().map_err(|_| Unmodeled)?);
    }
    names.sort_unstable();
    Ok(Some(names))
}

/// `navoriAuthorship(path, markerId)` on disk. A regular file whose bytes are not UTF-8 is
/// [`Unmodeled`]: Node would decode it with replacement characters and might still find a writer.
fn authorship(cwd: &Path, rel: &str, marker_id: &str) -> Result<Authorship, Unmodeled> {
    let abs = cwd.join(rel);
    if std::fs::symlink_metadata(&abs).is_ok_and(|meta| meta.is_file())
        && let Ok(bytes) = std::fs::read(&abs)
        && std::str::from_utf8(&bytes).is_err()
    {
        return Err(Unmodeled);
    }
    Ok(navori_authorship(
        &DiskView(cwd),
        rel,
        Some(marker_id),
        false,
    ))
}

/// The keys `{}` inherits from `Object.prototype`: a plain-object lookup by one of these finds a
/// function the TS then treats as a value.
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

// ---------------------------------------------------------------------------------------------
// listContextMarkers (doctor.ts:1762)
// ---------------------------------------------------------------------------------------------

/// `listContextMarkers(cwd)`: the open markers of `.claude/context/*.md`, files in `.sort()`
/// order.
///
/// # Errors
/// A file name or a file body that is not UTF-8.
pub fn list_context_markers(cwd: &Path) -> Result<Vec<MarkerInfo>, Unmodeled> {
    let dir = cwd.join(".claude").join("context");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let Some(names) = read_dir_names(&dir)? else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = names.into_iter().filter(|n| n.ends_with(".md")).collect();
    js_sort(&mut names);
    let mut out = Vec::new();
    for name in names {
        let content = read_text(&dir.join(name))?.unwrap_or_default();
        out.extend(list_markers(&content));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanManagedOrder (health.ts:1021)
// ---------------------------------------------------------------------------------------------

/// `OrderReport.misplacedFirst`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MisplacedFirst {
    /// The block that should lead.
    pub id: String,
    /// Its 1-based current position.
    pub current_pos: usize,
    /// How many blocks the file has.
    pub total: usize,
}

/// `OrderReport` for the root `CLAUDE.md` (`workspacePath` is never set: workspaces delegate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderReport {
    /// Managed-block ids in document order.
    pub current: Vec<String>,
    /// The canonical order of those same ids.
    pub expected: Vec<String>,
    /// Prose between two managed blocks blocks the reorder.
    pub interleaved: bool,
    /// The block that should lead, when it is not first.
    pub misplaced_first: Option<MisplacedFirst>,
}

/// `scanManagedOrder(cwd, config, CLAUDE_COMPUTED_BLOCK_IDS)`: `None` when there is nothing to
/// flag.
///
/// # Errors
/// An unreadable or non-UTF-8 `CLAUDE.md` (the TS throws), a canonical order the planner
/// delegates, or a clean root with enabled monorepo workspaces (each workspace's file is checked
/// next, which this port does not model).
pub fn scan_managed_order(cwd: &Path, config: &Config) -> Result<Option<OrderReport>, Unmodeled> {
    let root = order_report_at(cwd, &config.data)?;
    if root.is_none() && has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    Ok(root)
}

/// `orderReportAt(cwd, config, cwd, { computedBlockIds })`.
fn order_report_at(cwd: &Path, config: &JsValue) -> Result<Option<OrderReport>, Unmodeled> {
    let path = cwd.join("CLAUDE.md");
    if !path.exists() {
        return Ok(None);
    }
    let content = read_text(&path)?.ok_or(Unmodeled)?;
    let current: Vec<String> = list_markers(&content).into_iter().map(|m| m.id).collect();
    if current.len() < 2 {
        return Ok(None);
    }
    let canonical = canonical_managed_order(config, cwd, false, &CLAUDE_COMPUTED_BLOCK_IDS)
        .map_err(|_| Unmodeled)?;
    let canonical_refs: Vec<&str> = canonical.iter().map(String::as_str).collect();
    let result = reorder_managed_blocks(&content, &canonical_refs, CommentStyle::Html);
    if !result.reordered && !result.blocked_by_interleaving {
        return Ok(None);
    }
    let mut keyed: Vec<(usize, usize, &String)> = current
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let key = canonical
                .iter()
                .position(|c| c == id)
                .unwrap_or(canonical.len() + i);
            (key, i, id)
        })
        .collect();
    keyed.sort_by_key(|(key, i, _)| (*key, *i));
    let expected: Vec<String> = keyed.into_iter().map(|(_, _, id)| id.clone()).collect();
    let misplaced_first = expected.first().and_then(|lead| {
        let pos = current.iter().position(|id| id == lead)?;
        (pos > 0).then(|| MisplacedFirst {
            id: lead.clone(),
            current_pos: pos + 1,
            total: current.len(),
        })
    });
    Ok(Some(OrderReport {
        current,
        expected,
        interleaved: result.blocked_by_interleaving,
        misplaced_first,
    }))
}

// ---------------------------------------------------------------------------------------------
// scanMalformedMarkers (health.ts:1135)
// ---------------------------------------------------------------------------------------------

/// `MalformedMarkerReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MalformedReason {
    /// The line lost its `-->`.
    Unterminated,
    /// The open marker has no leading `id="…"`.
    MissingId,
}

impl MalformedReason {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unterminated => "unterminated",
            Self::MissingId => "missing-id",
        }
    }
}

/// `MalformedMarker`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedMarker {
    /// Repo-relative path.
    pub file_path: String,
    /// 1-based line.
    pub line: usize,
    /// The trimmed line, first 80 UTF-16 units.
    pub snippet: String,
    /// Why.
    pub reason: MalformedReason,
}

const HTML_CLOSE_PREFIX: &str = "<!-- /navori:managed";
const HTML_OPEN_PREFIX: &str = "<!-- navori:managed";

/// `HTML_OPEN_TERMINATED_RE.exec(text)?.[0]`: `^<!-- navori:managed(?![\w-])[^>]*?-->`.
fn open_terminated(text: &str) -> Option<&str> {
    let rest = text.strip_prefix(HTML_OPEN_PREFIX)?;
    if rest
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    // `[^>]*?` cannot cross a `>`, so the only candidate `-->` ends at the first `>`.
    let gt = rest.find('>')?;
    rest[..gt]
        .ends_with("--")
        .then(|| &text[..HTML_OPEN_PREFIX.len() + gt + 1])
}

/// `MARKER_LEADING_ID_RE.test(open)`: `^<!-- navori:managed\s+id="[^"\n]+"`.
fn has_leading_id(open: &str) -> bool {
    let Some(rest) = open.strip_prefix(HTML_OPEN_PREFIX) else {
        return false;
    };
    let after_ws = rest.trim_start_matches(is_js_whitespace);
    if after_ws.len() == rest.len() {
        return false;
    }
    let Some(value) = after_ws.strip_prefix("id=\"") else {
        return false;
    };
    value
        .find(['"', '\n'])
        .is_some_and(|end| end > 0 && value[end..].starts_with('"'))
}

/// `scanMalformedMarkers(cwd, config)`.
///
/// # Errors
/// Enabled monorepo workspaces, engines that are not strings, and names, bodies or snippets the
/// port cannot reproduce byte for byte.
pub fn scan_malformed_markers(
    cwd: &Path,
    config: &Config,
) -> Result<Vec<MalformedMarker>, Unmodeled> {
    if has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    let mut out = Vec::new();
    for (path, style) in collect_marker_files(cwd, &engines)? {
        if style != CommentStyle::Html {
            continue;
        }
        let Some(content) = read_text(&cwd.join(&path))? else {
            continue;
        };
        let prose: Vec<usize> = prose_lines(&content, &[CommentStyle::Html])
            .iter()
            .map(|line| line.index)
            .collect();
        for (i, line) in content.split('\n').enumerate() {
            let trimmed = js_trim(line);
            let snippet = || js_slice(trimmed, 80).map(str::to_owned);
            for prefix in [HTML_CLOSE_PREFIX, HTML_OPEN_PREFIX] {
                let Some(idx) = line.find(prefix) else {
                    continue;
                };
                if !line[idx + prefix.len()..].contains("-->") {
                    out.push(MalformedMarker {
                        file_path: path.clone(),
                        line: i + 1,
                        snippet: snippet()?,
                        reason: MalformedReason::Unterminated,
                    });
                }
                break;
            }
            if !prose.contains(&i) {
                continue;
            }
            if let Some(open) = open_terminated(trimmed)
                && !has_leading_id(open)
            {
                out.push(MalformedMarker {
                    file_path: path.clone(),
                    line: i + 1,
                    snippet: snippet()?,
                    reason: MalformedReason::MissingId,
                });
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanExcludedBlocks (health.ts:974)
// ---------------------------------------------------------------------------------------------

/// `ExcludedBlocksReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExcludedBlocks {
    /// Excludable core blocks opted out.
    pub excluded: Vec<String>,
    /// Core blocks that cannot be excluded.
    pub non_excludable: Vec<String>,
    /// Ids matching no core block.
    pub unknown: Vec<String>,
}

/// `scanExcludedBlocks(config)`: `None` when nothing is excluded.
///
/// # Errors
/// An exclude entry that is not a well-formed string.
pub fn scan_excluded_blocks(config: &Config) -> Result<Option<ExcludedBlocks>, Unmodeled> {
    let list = match get(&config.data, "blocks").and_then(|b| get(b, "exclude")) {
        None | Some(JsValue::Undefined) => return Ok(None),
        Some(JsValue::Array(items)) => items,
        Some(_) => return Err(Unmodeled),
    };
    if list.is_empty() {
        return Ok(None);
    }
    let mut report = ExcludedBlocks::default();
    for item in list {
        let id = js_text(item)?.ok_or(Unmodeled)?;
        if EXCLUDABLE_BLOCK_IDS.contains(&id.as_str()) {
            report.excluded.push(id);
        } else if CORE_MANAGED_ASSETS.iter().any(|a| a.id == id) {
            report.non_excludable.push(id);
        } else {
            report.unknown.push(id);
        }
    }
    Ok(Some(report))
}

// ---------------------------------------------------------------------------------------------
// scanLegacyAgents (health.ts:1285)
// ---------------------------------------------------------------------------------------------

/// `LEGACY_AGENT_ALIASES`.
const LEGACY_AGENT_ALIASES: [(&str, &str); 7] = [
    ("sdd-leader", "orchestrator"),
    ("sdd-implementer", "implementer"),
    ("sdd-reviewer", "reviewer"),
    ("sdd-explorer", "scout"),
    ("sdd-researcher", "scout"),
    ("sdd-ticket-audit", "auditor"),
    ("deep-auditor", "auditor"),
];

/// `LegacyAgent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyAgent {
    /// The legacy file's name without `.md`.
    pub legacy_name: String,
    /// The canonical navori agent that supersedes it.
    pub canonical: String,
}

/// `scanLegacyAgents(cwd, config)`: `detectLegacyAgents(detectClaudeInfra(cwd).agentFiles)`.
/// Every canonical target has a `CANONICAL_HARNESS_KEY` equal to its own id.
///
/// # Errors
/// A non-UTF-8 name, or a legacy name that is an `Object.prototype` key (the TS alias lookup finds
/// a function there).
pub fn scan_legacy_agents(cwd: &Path, config: &Config) -> Result<Vec<LegacyAgent>, Unmodeled> {
    let names = read_dir_names(&cwd.join(".claude").join("agents"))?.unwrap_or_default();
    let harness = get(&config.data, "harness");
    let mut out = Vec::new();
    for file in names.iter().filter(|n| n.ends_with(".md")) {
        let legacy_name = file.strip_suffix(".md").unwrap_or(file);
        if PROTOTYPE_KEYS.contains(&legacy_name) {
            return Err(Unmodeled);
        }
        let Some((_, canonical)) = LEGACY_AGENT_ALIASES
            .iter()
            .find(|(legacy, _)| *legacy == legacy_name)
        else {
            continue;
        };
        let enabled = !truthy(harness)
            || *canonical == "architect"
            || harness.and_then(|h| get(h, canonical)) != Some(&JsValue::Bool(false));
        if enabled {
            out.push(LegacyAgent {
                legacy_name: legacy_name.to_owned(),
                canonical: (*canonical).to_owned(),
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanRetiredAssets (health.ts:734)
// ---------------------------------------------------------------------------------------------

/// `RetiredAssetOnDisk`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredAssetOnDisk {
    /// Repo-relative path.
    pub path: String,
    /// The retired id.
    pub id: String,
    /// Its successor.
    pub successor: Option<String>,
    /// Why `render --apply` would keep it; `None` when navori still owns it.
    pub reason: Option<&'static str>,
}

/// `scanRetiredAssets(cwd)`: Claude and Codex destinations of every retired agent, skill and hook.
/// The Codex marker is `<id>-codex-base` for agents and the Claude marker for skills and hooks,
/// as `roster.ts` declares them.
///
/// # Errors
/// A retired file on disk whose bytes are not UTF-8.
pub fn scan_retired_assets(cwd: &Path) -> Result<Vec<RetiredAssetOnDisk>, Unmodeled> {
    let mut out = Vec::new();
    let mut record =
        |rel: String, id: &str, successor: Option<&str>, marker: &str| -> Result<(), Unmodeled> {
            if !cwd.join(&rel).exists() {
                return Ok(());
            }
            let found = authorship(cwd, &rel, marker)?;
            out.push(RetiredAssetOnDisk {
                path: rel,
                id: id.to_owned(),
                successor: successor.map(str::to_owned),
                reason: (found != Authorship::Ours).then(|| found.as_str()),
            });
            Ok(())
        };
    for retired in RETIRED_AGENTS {
        let codex = format!("{}-codex-base", retired.id);
        record(
            format!(".claude/agents/{}.md", retired.id),
            retired.id,
            retired.successor,
            retired.claude_marker,
        )?;
        record(
            format!(".codex/agents/{}.toml", retired.id),
            retired.id,
            retired.successor,
            &codex,
        )?;
    }
    for retired in RETIRED_SKILLS {
        for rel in [
            format!(".claude/skills/{}.md", retired.id),
            format!(".claude/skills/{}/SKILL.md", retired.id),
            format!(".agents/skills/{}/SKILL.md", retired.id),
        ] {
            record(rel, retired.id, retired.successor, retired.claude_marker)?;
        }
    }
    for retired in RETIRED_HOOKS {
        for rel in [
            format!(".claude/hooks/{}.sh", retired.id),
            format!(".codex/hooks/{}.sh", retired.id),
        ] {
            record(rel, retired.id, retired.successor, retired.claude_marker)?;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanRetiredPluginLeftovers (health.ts:632)
// ---------------------------------------------------------------------------------------------

/// A retired managed block or sub-block still present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredBlock {
    /// Repo-relative file.
    pub path: String,
    /// Block id.
    pub id: String,
}

/// `RetiredPluginLeftovers` when it is modelled: `declared`, `assets` and `references` are then
/// all empty, so only the blocks remain.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RetiredPluginLeftovers {
    /// Retired blocks and sub-blocks still present.
    pub blocks: Vec<RetiredBlock>,
}

/// `codexSkillTarget`: `.agents/skills/<id>/SKILL.md` for a `.claude/skills/<id>[/SKILL].md`.
fn codex_skill_target(claude_path: &str) -> Option<String> {
    let rest = claude_path.strip_prefix(".claude/skills/")?;
    let rest = rest.strip_suffix(".md")?;
    let id = rest.strip_suffix("/SKILL").unwrap_or(rest);
    (!id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    .then(|| format!(".agents/skills/{id}/SKILL.md"))
}

/// `scanRetiredPluginLeftovers(cwd, config)`.
///
/// # Errors
/// A retired id the config still declares or a retired script on disk (both need the hook-source
/// scan of `retiredAssetKeepReason`/`findRetiredScriptReferences`), a retired plugin the loader
/// delegates, or a block file that is not UTF-8.
pub fn scan_retired_plugin_leftovers(
    cwd: &Path,
    config: &Config,
) -> Result<RetiredPluginLeftovers, Unmodeled> {
    if let Some(plugins) = get(&config.data, "plugins").and_then(as_plain_object) {
        for (key, _) in plugins.ordered() {
            let id = key.to_rust().ok_or(Unmodeled)?;
            if !RETIRED_PLUGINS.iter().any(|(retired, _)| *retired == id) {
                continue;
            }
            // `NotFound` declares it, which needs the hook-source scan for its references;
            // anything else the loader rejects is not modelled either.
            if load_plugin(&id).is_err() {
                return Err(Unmodeled);
            }
        }
    }
    for (_, retired) in RETIRED_PLUGINS {
        for asset in retired.assets {
            let Some(name) = asset.strip_prefix(".claude/scripts/") else {
                continue;
            };
            if cwd.join(asset).exists() || cwd.join(".codex/scripts").join(name).exists() {
                return Err(Unmodeled);
            }
        }
    }
    let present = |rel: &str, id: &str| -> Result<bool, Unmodeled> {
        let abs = cwd.join(rel);
        if !abs.exists() {
            return Ok(false);
        }
        Ok(read_text(&abs)?.is_some_and(|content| {
            extract_managed_content(&content, id, CommentStyle::Html).is_some()
        }))
    };
    let mut block_ids: Vec<&str> = Vec::new();
    let all_ids = RETIRED_PLUGINS
        .iter()
        .flat_map(|(_, r)| r.block_ids.iter())
        .chain(
            RETIRED_PLUGIN_BLOCKS
                .iter()
                .flat_map(|(_, _, ids)| ids.iter()),
        );
    for id in all_ids {
        if !block_ids.contains(id) {
            block_ids.push(id);
        }
    }
    let mut blocks = Vec::new();
    for id in block_ids {
        if present("CLAUDE.md", id)? {
            blocks.push(RetiredBlock {
                path: "CLAUDE.md".to_owned(),
                id: id.to_owned(),
            });
        }
    }
    for (_, _, entries) in RETIRED_PLUGIN_SUB_BLOCKS {
        for (id, target) in *entries {
            for path in [Some((*target).to_owned()), codex_skill_target(target)]
                .into_iter()
                .flatten()
            {
                if present(&path, id)? {
                    blocks.push(RetiredBlock {
                        path,
                        id: (*id).to_owned(),
                    });
                }
            }
        }
    }
    Ok(RetiredPluginLeftovers { blocks })
}

// ---------------------------------------------------------------------------------------------
// scanPermissionMode (health.ts:1340)
// ---------------------------------------------------------------------------------------------

/// `PermissionModeConflict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionModeConflict {
    /// The declared mode.
    pub mode: String,
    /// Repo-relative settings file.
    pub path: String,
    /// Cycle tools the allow list does not grant.
    pub missing: Vec<&'static str>,
}

/// `CYCLE_TOOLS`.
const CYCLE_TOOLS: [&str; 2] = ["Edit", "Write"];

/// `declaredMode(settings)`.
fn declared_mode(settings: &JsObject) -> Result<Option<String>, Unmodeled> {
    let nested = settings
        .get("permissions")
        .and_then(as_plain_object)
        .and_then(|perms| perms.get("defaultMode"));
    let value = match nested {
        None | Some(JsValue::Undefined | JsValue::Null) => settings.get("defaultMode"),
        some => some,
    };
    Ok(value
        .map(js_text)
        .transpose()?
        .flatten()
        .filter(|mode| !mode.is_empty()))
}

/// `allowList(settings)`.
fn allow_list(settings: &JsObject) -> Result<Vec<String>, Unmodeled> {
    let Some(JsValue::Array(allow)) = settings
        .get("permissions")
        .and_then(as_plain_object)
        .and_then(|perms| perms.get("allow"))
    else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for rule in allow {
        if let Some(text) = js_text(rule)? {
            out.push(text);
        }
    }
    Ok(out)
}

/// Parse a settings-like JSON file: `Ok(None)` when it is absent or cannot be read, the value
/// otherwise. Text Rust cannot parse is [`Unmodeled`] (it may be invalid JSON, whose V8 message or
/// sibling report the port does not reproduce, or valid JSON outside [`js_json::parse`]).
fn read_json(path: &Path) -> Result<Option<JsValue>, Unmodeled> {
    if !path.exists() {
        return Ok(None);
    }
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    js_json::parse(&text).map(Some).ok_or(Unmodeled)
}

/// `scanPermissionMode(cwd)`: `.claude/settings.json`, then `.claude/settings.local.json`.
///
/// # Errors
/// A settings file that is not UTF-8 or that the port cannot parse.
pub fn scan_permission_mode(cwd: &Path) -> Result<Vec<PermissionModeConflict>, Unmodeled> {
    let mut out = Vec::new();
    for file in ["settings.json", "settings.local.json"] {
        let rel = format!(".claude/{file}");
        let Some(parsed) = read_json(&cwd.join(&rel))? else {
            continue;
        };
        let Some(settings) = as_plain_object(&parsed) else {
            continue;
        };
        if declared_mode(settings)?.as_deref() != Some("dontAsk") {
            continue;
        }
        let allow = allow_list(settings)?;
        let missing: Vec<&'static str> = CYCLE_TOOLS
            .into_iter()
            .filter(|tool| !allow.iter().any(|rule| rule == tool))
            .collect();
        if !missing.is_empty() {
            out.push(PermissionModeConflict {
                mode: "dontAsk".to_owned(),
                path: rel,
                missing,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// isPlaceholderName (detect.ts:299), scanNameMismatch (doctor.ts:1888), presetOverride
// ---------------------------------------------------------------------------------------------

/// `PLACEHOLDER_NAMES`.
const PLACEHOLDER_NAMES: [&str; 18] = [
    "temp-app",
    "temp",
    "tmp",
    "my-app",
    "myapp",
    "my-project",
    "your-app",
    "your-project",
    "your-app-name",
    "app-name",
    "project-name",
    "changeme",
    "change-me",
    "example-app",
    "sample-app",
    "new-project",
    "untitled",
    "placeholder",
];

/// `isPlaceholderName(name)`.
#[must_use]
pub fn is_placeholder_name(name: &str) -> bool {
    let lowered = js_trim(name).to_lowercase();
    PLACEHOLDER_NAMES.contains(&lowered.as_str())
}

/// `kebabDirName(dirName)`.
fn kebab_dir_name(dir_name: &str) -> Option<String> {
    let lowered = js_trim(dir_name).to_lowercase();
    let mut kebab = String::new();
    let mut in_run = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            kebab.push(ch);
            in_run = false;
        } else if !in_run {
            kebab.push('-');
            in_run = true;
        }
    }
    let kebab = kebab.trim_matches('-');
    (!kebab.is_empty()).then(|| kebab.to_owned())
}

/// `NameMismatch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameMismatch {
    /// `config.name`.
    pub config_name: String,
    /// `basename(cwd)`.
    pub dir_name: String,
    /// The directory's kebab-case form.
    pub suggested_name: String,
}

/// `scanNameMismatch(cwd, config)`.
///
/// # Errors
/// A missing `name` or a directory name that is not UTF-8.
pub fn scan_name_mismatch(cwd: &Path, config: &Config) -> Result<Option<NameMismatch>, Unmodeled> {
    let name = config_text(&config.data, "name")?;
    if is_placeholder_name(&name) {
        return Ok(None);
    }
    let dir_name = match cwd.file_name() {
        Some(base) => base.to_str().ok_or(Unmodeled)?.to_owned(),
        None => String::new(),
    };
    let Some(suggested_name) = kebab_dir_name(&dir_name) else {
        return Ok(None);
    };
    if name == suggested_name {
        return Ok(None);
    }
    Ok(Some(NameMismatch {
        config_name: name,
        dir_name,
        suggested_name,
    }))
}

/// `presetOverride`: the declared preset when a local manifest shadows a bundled one.
///
/// # Errors
/// A preset id the resolver delegates.
pub fn preset_override(cwd: &Path, config: &Config) -> Result<Option<String>, Unmodeled> {
    let preset = config_text(&config.data, "preset")?;
    let resolved = resolve_preset(&preset, cwd).map_err(|_| Unmodeled)?;
    Ok(
        (matches!(resolved, Some(ResolvedPreset::Local(_))) && preset_exists(&preset))
            .then_some(preset),
    )
}

// ---------------------------------------------------------------------------------------------
// classifyLocalSkills (engines/shared/local-skill-pointer.ts:50)
// ---------------------------------------------------------------------------------------------

/// `ClassifiedLocalSkills`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LocalSkills {
    /// Source present; the pointer may be (re)written.
    pub emit: Vec<String>,
    /// No `.claude/skills/<id>/SKILL.md`.
    pub missing: Vec<String>,
    /// The destination exists and is not navori's pointer.
    pub foreign: Vec<String>,
}

/// `resolveLocalSkillPath(cwd, id)`: the directory form only, flat slugs only.
fn resolve_local_skill_path(cwd: &Path, id: &str) -> Option<String> {
    if id.is_empty() || id != js_trim(id) || id.contains(['/', '\\']) || id.contains("..") {
        return None;
    }
    let rel = format!(".claude/skills/{id}/SKILL.md");
    cwd.join(&rel).exists().then_some(rel)
}

/// `classifyLocalSkills(cwd, config.project?.localSkills ?? [], planSkillIds)` as `doctor` calls
/// it: the plan is `resolveHarnessPlan(config, coreAssets, preset)` with the configured preset.
///
/// # Errors
/// A preset the loader delegates (the TS swallows a throwing preset as `null`; Rust cannot tell
/// that apart from one it does not model), a non-string id, or a non-UTF-8 pointer.
pub fn classify_local_skills(cwd: &Path, config: &Config) -> Result<LocalSkills, Unmodeled> {
    let ids = match get(&config.data, "project").and_then(|p| get(p, "localSkills")) {
        None | Some(JsValue::Undefined | JsValue::Null) => return Ok(LocalSkills::default()),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| js_text(item)?.ok_or(Unmodeled))
            .collect::<Result<Vec<String>, Unmodeled>>()?,
        Some(_) => return Err(Unmodeled),
    };
    let preset = config_text(&config.data, "preset")?;
    let loaded = if preset == "custom" {
        None
    } else {
        load_preset(&preset, cwd).map_err(|_| Unmodeled)?
    };
    let plan = resolve_harness_plan(&config.data, loaded.as_ref(), false, None);
    let mut out = LocalSkills::default();
    for id in ids {
        if plan.skills.iter().any(|skill| skill.id == id) {
            continue;
        }
        if resolve_local_skill_path(cwd, &id).is_none() {
            out.missing.push(id);
            continue;
        }
        let dest = format!(".agents/skills/{id}/SKILL.md");
        let foreign = cwd.join(&dest).exists()
            && authorship(cwd, &dest, &format!("{id}-local-pointer"))? == Authorship::Foreign;
        if foreign {
            out.foreign.push(id);
        } else {
            out.emit.push(id);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanClaudeHookScripts (doctor.ts:1936)
// ---------------------------------------------------------------------------------------------

/// `ClaudeHookScriptsReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaudeHookScripts {
    /// Referenced scripts absent from disk.
    pub missing: Vec<String>,
    /// Referenced scripts without any executable bit.
    pub not_executable: Vec<String>,
}

/// `/\.claude\/(?:scripts|hooks)\/[^\s"']+/g` over `command`, appended to `out` unless present.
fn hook_script_refs(command: &str, out: &mut Vec<String>) {
    let mut at = 0;
    while at < command.len() {
        let rest = &command[at..];
        let matched = [".claude/scripts/", ".claude/hooks/"]
            .iter()
            .find_map(|prefix| {
                let tail = rest.strip_prefix(prefix)?;
                let end = tail
                    .find(|c: char| is_js_whitespace(c) || c == '"' || c == '\'')
                    .unwrap_or(tail.len());
                (end > 0).then(|| prefix.len() + end)
            });
        if let Some(len) = matched {
            let found = &rest[..len];
            if !out.iter().any(|r| r == found) {
                out.push(found.to_owned());
            }
            at += len;
        } else {
            at += rest.chars().next().map_or(1, char::len_utf8);
        }
    }
}

/// `collectHookScriptRefs`: walk the hooks tree, reading every `command` string.
fn collect_hook_script_refs(node: &JsValue, out: &mut Vec<String>) -> Result<(), Unmodeled> {
    match node {
        JsValue::Array(items) => {
            for item in items {
                collect_hook_script_refs(item, out)?;
            }
        }
        JsValue::Object(object) => {
            for (key, value) in object.ordered() {
                if key.is("command")
                    && let JsValue::String(text) = value
                {
                    hook_script_refs(&text.to_rust().ok_or(Unmodeled)?, out);
                } else {
                    collect_hook_script_refs(value, out)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// `(statSync(abs).mode & 0o111) === 0`; `None` when `stat` fails.
#[cfg(unix)]
fn lacks_exec_bit(abs: &Path) -> Result<Option<bool>, Unmodeled> {
    use std::os::unix::fs::PermissionsExt;
    Ok(std::fs::metadata(abs)
        .ok()
        .map(|meta| meta.permissions().mode() & 0o111 == 0))
}

/// Windows modes are synthesized by libuv; not modelled.
#[cfg(not(unix))]
fn lacks_exec_bit(_abs: &Path) -> Result<Option<bool>, Unmodeled> {
    Err(Unmodeled)
}

/// `scanClaudeHookScripts(cwd, config)`: `None` without the Claude engine or a settings file.
///
/// # Errors
/// A settings file that is not UTF-8 or that the port cannot parse, or a lone surrogate in a
/// command.
pub fn scan_claude_hook_scripts(
    cwd: &Path,
    config: &Config,
) -> Result<Option<ClaudeHookScripts>, Unmodeled> {
    if !has_engine(&config.data, "claude")? {
        return Ok(None);
    }
    let Some(settings) = read_json(&cwd.join(".claude/settings.json"))? else {
        return Ok(None);
    };
    let mut refs = Vec::new();
    if let Some(hooks @ (JsValue::Object(_) | JsValue::Array(_))) = get(&settings, "hooks") {
        collect_hook_script_refs(hooks, &mut refs)?;
    }
    js_sort(&mut refs);
    let mut report = ClaudeHookScripts::default();
    for rel in refs {
        let abs = cwd.join(&rel);
        if !abs.exists() {
            report.missing.push(rel);
            continue;
        }
        if lacks_exec_bit(&abs)? == Some(true) {
            report.not_executable.push(rel);
        }
    }
    Ok(Some(report))
}

// ---------------------------------------------------------------------------------------------
// scanMcpCoherence (doctor.ts:2264)
// ---------------------------------------------------------------------------------------------

/// `McpCoherenceIssue` (an `unparseable` `.mcp.json` is [`Unmodeled`]: its detail is V8's message).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpCoherenceIssue {
    /// No plain-object entry for the plugin.
    MissingEntry {
        /// Plugin id.
        plugin_id: String,
    },
    /// The entry's `command` differs.
    CommandMismatch {
        /// Plugin id.
        plugin_id: String,
        /// `String(expected)`.
        expected: String,
        /// `String(actual)`.
        actual: String,
    },
}

/// `String(value)` for the JSON values whose JS conversion this port reproduces.
fn js_string_of(value: Option<&JsValue>) -> Result<String, Unmodeled> {
    match value {
        None | Some(JsValue::Undefined) => Ok("undefined".to_owned()),
        Some(JsValue::Null) => Ok("null".to_owned()),
        Some(JsValue::Bool(flag)) => Ok(flag.to_string()),
        Some(JsValue::Number(number)) => Ok(number_to_js(*number)),
        Some(JsValue::String(text)) => text.to_rust().ok_or(Unmodeled),
        Some(JsValue::Array(_) | JsValue::Object(_)) => Err(Unmodeled),
    }
}

/// `scanMcpCoherence(cwd, config)`.
///
/// # Errors
/// An enabled plugin the loader delegates, a `.mcp.json` the TS would fail to parse or the port
/// cannot parse, a non-string expected command, or an actual command whose `String()` is not
/// modelled.
pub fn scan_mcp_coherence(
    cwd: &Path,
    config: &Config,
) -> Result<Vec<McpCoherenceIssue>, Unmodeled> {
    if !has_engine(&config.data, "claude")? {
        return Ok(Vec::new());
    }
    let enabled = load_enabled_plugins(get(&config.data, "plugins")).map_err(|_| Unmodeled)?;
    let desired = build_desired_mcp_servers(&enabled.loaded);
    if desired.is_empty() {
        return Ok(Vec::new());
    }
    let path = cwd.join(".mcp.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = read_text(&path)?.ok_or(Unmodeled)?;
    let parsed = js_json::parse(&text).ok_or(Unmodeled)?;
    let Some(servers) = get(&parsed, "mcpServers").and_then(as_plain_object) else {
        return Ok(desired
            .into_iter()
            .map(|(plugin_id, _)| McpCoherenceIssue::MissingEntry { plugin_id })
            .collect());
    };
    let mut issues = Vec::new();
    for (plugin_id, entry) in desired {
        if PROTOTYPE_KEYS.contains(&plugin_id.as_str()) {
            return Err(Unmodeled);
        }
        let Some(actual) = servers.get(&plugin_id).and_then(as_plain_object) else {
            issues.push(McpCoherenceIssue::MissingEntry { plugin_id });
            continue;
        };
        let expected = match get(&entry, "command") {
            Some(JsValue::String(text)) => text.to_rust().ok_or(Unmodeled)?,
            _ => return Err(Unmodeled),
        };
        let actual_command = actual.get("command");
        let same = matches!(actual_command, Some(JsValue::String(text)) if text.is(&expected));
        if !same {
            issues.push(McpCoherenceIssue::CommandMismatch {
                plugin_id,
                expected,
                actual: js_string_of(actual_command)?,
            });
        }
    }
    Ok(issues)
}

// ---------------------------------------------------------------------------------------------
// scanMonorepoDrift (doctor.ts:2735)
// ---------------------------------------------------------------------------------------------

/// `MonorepoDrift` for a disabled monorepo (the enabled path delegates).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonorepoDrift {
    /// `monorepo.enabled` is false.
    pub disabled: bool,
    /// Detected workspaces missing from the config.
    pub added: Vec<String>,
    /// Configured workspaces no longer on disk.
    pub orphan: Vec<String>,
    /// `workspaces: []` while workspaces exist on disk.
    pub empty_declared: bool,
}

/// `scanMonorepoDrift(cwd, config)`: `None` without a `monorepo` section.
///
/// # Errors
/// An enabled monorepo: workspace detection and diffing are not modelled.
pub fn scan_monorepo_drift(config: &Config) -> Result<Option<MonorepoDrift>, Unmodeled> {
    let monorepo = get(&config.data, "monorepo");
    if !truthy(monorepo) {
        return Ok(None);
    }
    if truthy(monorepo.and_then(|m| get(m, "enabled"))) {
        return Err(Unmodeled);
    }
    Ok(Some(MonorepoDrift {
        disabled: true,
        added: Vec::new(),
        orphan: Vec::new(),
        empty_declared: false,
    }))
}

// ---------------------------------------------------------------------------------------------
// listAvailableExternalProviders (external-providers.ts:36), needsExternalProviderSetupHint
// ---------------------------------------------------------------------------------------------

/// `PROVIDERS_WITH_SETUP_RECIPE`.
pub const PROVIDERS_WITH_SETUP_RECIPE: [&str; 2] = ["codegraph", "tgrep"];

/// `listKnownPluginIds()`: the bundled ids (libuv order), else `KNOWN_PLUGINS`.
fn known_plugin_ids() -> Vec<String> {
    let bundled = bundled_plugin_ids();
    if bundled.is_empty() {
        KNOWN_PLUGINS.iter().map(|id| (*id).to_owned()).collect()
    } else {
        bundled
    }
}

/// `listAvailableExternalProviders(config, cwd)`: known plugins with an `externalTool` that are not
/// enabled, `engram` excluded. `is_github_repo` answers `isGitHubRepo(cwd)` (a `git` spawn the CLI
/// owns) and is asked only when `gh` is a candidate.
///
/// # Errors
/// A plugin the loader delegates, a non-UTF-8 plugin key, or an error from `is_github_repo`.
pub fn list_available_external_providers(
    config: &Config,
    is_github_repo: &mut dyn FnMut() -> Result<bool, Unmodeled>,
) -> Result<Vec<String>, Unmodeled> {
    let mut enabled: Vec<String> = Vec::new();
    if let Some(plugins) = get(&config.data, "plugins").and_then(as_plain_object) {
        for (key, settings) in plugins.ordered() {
            if get(settings, "enabled") == Some(&JsValue::Bool(true)) {
                enabled.push(key.to_rust().ok_or(Unmodeled)?);
            }
        }
    }
    let mut out = Vec::new();
    for id in known_plugin_ids() {
        if id == "engram" || enabled.contains(&id) {
            continue;
        }
        if id == "gh" && !is_github_repo()? {
            continue;
        }
        let plugin = match load_plugin(&id) {
            Ok(plugin) => plugin,
            Err(PluginLoadError::NotFound) => continue,
            Err(PluginLoadError::Delegate) => return Err(Unmodeled),
        };
        if !matches!(
            get(&plugin.manifest, "externalTool"),
            None | Some(JsValue::Undefined | JsValue::Null)
        ) {
            out.push(id);
        }
    }
    Ok(out)
}

/// `needsExternalProviderSetupHint(missing, available, tgrepIndexFreshness, codegraphIndexDrift)`;
/// the two index reports are passed as "is non-null".
#[must_use]
pub fn needs_external_provider_setup_hint(
    missing_external_tool_ids: &[&str],
    available_external_providers: &[String],
    tgrep_index_freshness: bool,
    codegraph_index_drift: bool,
) -> bool {
    missing_external_tool_ids
        .iter()
        .any(|id| PROVIDERS_WITH_SETUP_RECIPE.contains(id))
        || available_external_providers
            .iter()
            .any(|id| PROVIDERS_WITH_SETUP_RECIPE.contains(&id.as_str()))
        || tgrep_index_freshness
        || codegraph_index_drift
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory; removed on drop.
    struct Temp(std::path::PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("navori-doctor-{}-{n}", std::process::id()))
                .join(name);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).ok();
            Self(dir)
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(path, text).ok();
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    fn config(json: &str) -> Config {
        Config {
            data: js_json::parse(json).unwrap_or(JsValue::Null),
            warnings: Vec::new(),
        }
    }

    fn block(id: &str) -> String {
        format!("<!-- navori:managed id=\"{id}\" -->\nbody\n<!-- /navori:managed id=\"{id}\" -->\n")
    }

    // Covers: R73
    #[test]
    fn context_markers_follow_the_sorted_md_files() -> Result<(), Unmodeled> {
        let t = Temp::new("ctx");
        assert!(list_context_markers(&t.0)?.is_empty());
        t.write(".claude/context/b.md", &block("second"));
        t.write(".claude/context/a.md", &block("first"));
        t.write(".claude/context/c.txt", &block("ignored"));
        let ids: Vec<String> = list_context_markers(&t.0)?
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["first", "second"]);
        Ok(())
    }

    // Covers: R76
    #[test]
    fn managed_order_flags_reorder_and_interleaving() -> Result<(), Unmodeled> {
        let t = Temp::new("order");
        let cfg = config(r#"{"name":"x","preset":"custom","engines":["claude"]}"#);
        assert_eq!(scan_managed_order(&t.0, &cfg)?, None);
        let canonical = canonical_managed_order(&cfg.data, &t.0, false, &CLAUDE_COMPUTED_BLOCK_IDS)
            .map_err(|_| Unmodeled)?;
        assert!(canonical.len() >= 2);
        let (first, second) = (&canonical[0], &canonical[1]);
        t.write("CLAUDE.md", &format!("{}\n{}", block(second), block(first)));
        let report = scan_managed_order(&t.0, &cfg)?.ok_or(Unmodeled)?;
        assert_eq!(report.current, [second.clone(), first.clone()]);
        assert_eq!(report.expected, [first.clone(), second.clone()]);
        assert!(!report.interleaved);
        assert_eq!(
            report.misplaced_first,
            Some(MisplacedFirst {
                id: first.clone(),
                current_pos: 2,
                total: 2
            })
        );
        t.write(
            "CLAUDE.md",
            &format!("{}\nprose\n{}", block(second), block(first)),
        );
        assert!(
            scan_managed_order(&t.0, &cfg)?
                .ok_or(Unmodeled)?
                .interleaved
        );
        t.write("CLAUDE.md", &format!("{}\n{}", block(first), block(second)));
        assert_eq!(scan_managed_order(&t.0, &cfg)?, None);
        Ok(())
    }

    // Covers: R76
    #[test]
    fn malformed_markers_report_unterminated_and_missing_id() -> Result<(), Unmodeled> {
        let t = Temp::new("malformed");
        t.write(
            "CLAUDE.md",
            "<!-- navori:managed hash=\"h\" id=\"a\" -->\nsee `<!-- navori:managed -->` here\n```\n<!-- navori:managed -->\n```\n  <!-- navori:managed id=\"\" -->\n<!-- navori:managed-x -->\n",
        );
        t.write(".claude/agents/a.md", "<!-- /navori:managed id=\"ok\"\n");
        let cfg = config(r#"{"engines":["claude"]}"#);
        let found: Vec<(String, usize, MalformedReason, String)> =
            scan_malformed_markers(&t.0, &cfg)?
                .into_iter()
                .map(|m| (m.file_path, m.line, m.reason, m.snippet))
                .collect();
        assert_eq!(
            found,
            [
                (
                    "CLAUDE.md".to_owned(),
                    1,
                    MalformedReason::MissingId,
                    "<!-- navori:managed hash=\"h\" id=\"a\" -->".to_owned()
                ),
                (
                    "CLAUDE.md".to_owned(),
                    6,
                    MalformedReason::MissingId,
                    "<!-- navori:managed id=\"\" -->".to_owned()
                ),
                (
                    ".claude/agents/a.md".to_owned(),
                    1,
                    MalformedReason::Unterminated,
                    "<!-- /navori:managed id=\"ok\"".to_owned()
                ),
            ]
        );
        Ok(())
    }

    // Covers: R76
    #[test]
    fn snippets_cut_at_80_utf16_units() {
        assert_eq!(js_slice("abc", 80), Ok("abc"));
        let long = "é".repeat(90);
        assert_eq!(js_slice(&long, 80).map(|s| s.chars().count()), Ok(80));
        let astral = format!("{}😀", "a".repeat(79));
        assert_eq!(js_slice(&astral, 80), Err(Unmodeled));
    }

    // Covers: R76
    #[test]
    fn excluded_blocks_split_by_kind() -> Result<(), Unmodeled> {
        assert_eq!(scan_excluded_blocks(&config("{}"))?, None);
        let core = CORE_MANAGED_ASSETS
            .iter()
            .find(|a| !EXCLUDABLE_BLOCK_IDS.contains(&a.id))
            .map(|a| a.id)
            .ok_or(Unmodeled)?;
        let cfg = config(&format!(
            r#"{{"blocks":{{"exclude":["sdd","{core}","typo"]}}}}"#
        ));
        assert_eq!(
            scan_excluded_blocks(&cfg)?,
            Some(ExcludedBlocks {
                excluded: vec!["sdd".to_owned()],
                non_excludable: vec![core.to_owned()],
                unknown: vec!["typo".to_owned()],
            })
        );
        Ok(())
    }

    // Covers: R76
    #[test]
    fn legacy_agents_honor_the_harness_toggle() -> Result<(), Unmodeled> {
        let t = Temp::new("legacy");
        t.write(".claude/agents/sdd-leader.md", "x");
        t.write(".claude/agents/sdd-reviewer.md", "x");
        t.write(".claude/agents/mine.md", "x");
        let all = scan_legacy_agents(&t.0, &config("{}"))?;
        assert_eq!(
            all,
            [
                LegacyAgent {
                    legacy_name: "sdd-leader".to_owned(),
                    canonical: "orchestrator".to_owned()
                },
                LegacyAgent {
                    legacy_name: "sdd-reviewer".to_owned(),
                    canonical: "reviewer".to_owned()
                },
            ]
        );
        let off = scan_legacy_agents(&t.0, &config(r#"{"harness":{"reviewer":false}}"#))?;
        assert_eq!(off.len(), 1);
        t.write(".claude/agents/constructor.md", "x");
        assert_eq!(scan_legacy_agents(&t.0, &config("{}")), Err(Unmodeled));
        Ok(())
    }

    // Covers: R76
    #[test]
    fn retired_assets_name_their_successor_and_keep_reason() -> Result<(), Unmodeled> {
        let t = Temp::new("retired");
        assert!(scan_retired_assets(&t.0)?.is_empty());
        t.write(".claude/agents/leader.md", "hand written");
        t.write(
            ".codex/agents/leader.toml",
            "# navori:managed start id=\"leader-codex-base\" version=\"0.0.1\"\nx\n# navori:managed end id=\"leader-codex-base\"\n",
        );
        let found = scan_retired_assets(&t.0)?;
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].path, ".claude/agents/leader.md");
        assert_eq!(found[0].successor.as_deref(), Some("orchestrator"));
        assert_eq!(found[0].reason, Some("foreign"));
        assert_eq!(found[1].path, ".codex/agents/leader.toml");
        assert_eq!(found[1].reason, None);
        Ok(())
    }

    // Covers: R76
    #[test]
    fn retired_plugin_leftovers_list_blocks_and_delegate_scripts() -> Result<(), Unmodeled> {
        let t = Temp::new("retired-plugins");
        let cfg = config("{}");
        assert_eq!(scan_retired_plugin_leftovers(&t.0, &cfg)?.blocks, []);
        t.write("CLAUDE.md", &block("engram-protocol"));
        t.write(
            ".agents/skills/review-diff/SKILL.md",
            &block("jscpd-review-extension"),
        );
        let blocks = scan_retired_plugin_leftovers(&t.0, &cfg)?.blocks;
        assert_eq!(
            blocks,
            [
                RetiredBlock {
                    path: "CLAUDE.md".to_owned(),
                    id: "engram-protocol".to_owned()
                },
                RetiredBlock {
                    path: ".agents/skills/review-diff/SKILL.md".to_owned(),
                    id: "jscpd-review-extension".to_owned()
                },
            ]
        );
        let declared = config(r#"{"plugins":{"jscpd":{"enabled":true}}}"#);
        assert_eq!(
            scan_retired_plugin_leftovers(&t.0, &declared),
            Err(Unmodeled)
        );
        t.write(".codex/scripts/check-jscpd.sh", "x");
        assert_eq!(scan_retired_plugin_leftovers(&t.0, &cfg), Err(Unmodeled));
        assert_eq!(
            codex_skill_target(".claude/skills/review-diff.md").as_deref(),
            Some(".agents/skills/review-diff/SKILL.md")
        );
        assert_eq!(codex_skill_target(".claude/agents/explorer.md"), None);
        Ok(())
    }

    // Covers: R76
    #[test]
    fn permission_mode_flags_dont_ask_without_write_tools() -> Result<(), Unmodeled> {
        let t = Temp::new("perm");
        assert!(scan_permission_mode(&t.0)?.is_empty());
        t.write(
            ".claude/settings.json",
            r#"{"permissions":{"defaultMode":"dontAsk","allow":["Edit"]}}"#,
        );
        t.write(
            ".claude/settings.local.json",
            r#"{"permissions":{"defaultMode":null},"defaultMode":"dontAsk"}"#,
        );
        assert_eq!(
            scan_permission_mode(&t.0)?,
            [
                PermissionModeConflict {
                    mode: "dontAsk".to_owned(),
                    path: ".claude/settings.json".to_owned(),
                    missing: vec!["Write"],
                },
                PermissionModeConflict {
                    mode: "dontAsk".to_owned(),
                    path: ".claude/settings.local.json".to_owned(),
                    missing: vec!["Edit", "Write"],
                },
            ]
        );
        t.write(".claude/settings.json", "{oops");
        assert_eq!(scan_permission_mode(&t.0), Err(Unmodeled));
        Ok(())
    }

    // Covers: R76
    #[test]
    fn name_mismatch_skips_placeholders_and_matches_kebab() -> Result<(), Unmodeled> {
        let t = Temp::new("Alerta_Ciudadana");
        assert!(is_placeholder_name("  My-App "));
        assert_eq!(
            scan_name_mismatch(&t.0, &config(r#"{"name":"my-app"}"#))?,
            None
        );
        assert_eq!(
            scan_name_mismatch(&t.0, &config(r#"{"name":"alerta-ciudadana"}"#))?,
            None
        );
        assert_eq!(
            scan_name_mismatch(&t.0, &config(r#"{"name":"other"}"#))?,
            Some(NameMismatch {
                config_name: "other".to_owned(),
                dir_name: "Alerta_Ciudadana".to_owned(),
                suggested_name: "alerta-ciudadana".to_owned(),
            })
        );
        assert_eq!(kebab_dir_name("__"), None);
        Ok(())
    }

    // Covers: R76
    #[test]
    fn preset_override_needs_a_local_shadow_of_a_bundled_preset() -> Result<(), Unmodeled> {
        let t = Temp::new("preset");
        let cfg = config(r#"{"preset":"astro"}"#);
        assert!(preset_exists("astro"));
        assert_eq!(preset_override(&t.0, &cfg)?, None);
        t.write(".navori/presets/astro/astro.json", "{}");
        assert_eq!(preset_override(&t.0, &cfg)?, Some("astro".to_owned()));
        let local_only = config(r#"{"preset":"mine"}"#);
        t.write(".navori/presets/mine/mine.json", "{}");
        assert_eq!(preset_override(&t.0, &local_only)?, None);
        assert_eq!(
            preset_override(&t.0, &config(r#"{"preset":"custom"}"#))?,
            None
        );
        Ok(())
    }

    // Covers: R76
    #[test]
    fn local_skills_split_into_emit_missing_and_foreign() -> Result<(), Unmodeled> {
        let t = Temp::new("local-skills");
        t.write(".claude/skills/mine/SKILL.md", "x");
        t.write(".claude/skills/theirs/SKILL.md", "x");
        t.write(".agents/skills/theirs/SKILL.md", "hand written");
        let cfg = config(
            r#"{"preset":"custom","project":{"localSkills":["mine","gone","theirs","../x"]}}"#,
        );
        assert_eq!(
            classify_local_skills(&t.0, &cfg)?,
            LocalSkills {
                emit: vec!["mine".to_owned()],
                missing: vec!["gone".to_owned(), "../x".to_owned()],
                foreign: vec!["theirs".to_owned()],
            }
        );
        Ok(())
    }

    // Covers: R76
    #[test]
    fn hook_scripts_report_missing_and_non_executable() -> Result<(), Unmodeled> {
        let t = Temp::new("hooks");
        let cfg = config(r#"{"engines":["claude"]}"#);
        assert_eq!(scan_claude_hook_scripts(&t.0, &cfg)?, None);
        t.write(
            ".claude/settings.json",
            r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"bash .claude/scripts/z.sh && .claude/hooks/a.sh '.claude/hooks/a.sh'"}]}],"x":{"command":".claude/scripts/gone.sh"}}}"#,
        );
        t.write(".claude/scripts/z.sh", "#!/bin/sh\n");
        t.write(".claude/hooks/a.sh", "#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                t.0.join(".claude/hooks/a.sh"),
                std::fs::Permissions::from_mode(0o755),
            )
            .ok();
            std::fs::set_permissions(
                t.0.join(".claude/scripts/z.sh"),
                std::fs::Permissions::from_mode(0o644),
            )
            .ok();
        }
        assert_eq!(
            scan_claude_hook_scripts(&t.0, &cfg)?,
            Some(ClaudeHookScripts {
                missing: vec![".claude/scripts/gone.sh".to_owned()],
                not_executable: vec![".claude/scripts/z.sh".to_owned()],
            })
        );
        assert_eq!(
            scan_claude_hook_scripts(&t.0, &config(r#"{"engines":["codex"]}"#))?,
            None
        );
        Ok(())
    }

    // Covers: R76
    #[test]
    fn mcp_coherence_compares_entries_and_commands() -> Result<(), Unmodeled> {
        let t = Temp::new("mcp");
        let cfg = config(r#"{"engines":["claude"],"plugins":{"engram":{"enabled":true}}}"#);
        let desired = build_desired_mcp_servers(
            &load_enabled_plugins(get(&cfg.data, "plugins"))
                .map_err(|_| Unmodeled)?
                .loaded,
        );
        assert_eq!(scan_mcp_coherence(&t.0, &cfg)?, []);
        let (id, _) = desired.first().ok_or(Unmodeled)?;
        t.write(".mcp.json", r#"{"mcpServers":[]}"#);
        assert_eq!(
            scan_mcp_coherence(&t.0, &cfg)?,
            [McpCoherenceIssue::MissingEntry {
                plugin_id: id.clone()
            }]
        );
        t.write(
            ".mcp.json",
            &format!(r#"{{"mcpServers":{{"{id}":{{"command":7}}}}}}"#),
        );
        let issues = scan_mcp_coherence(&t.0, &cfg)?;
        assert!(matches!(
            issues.as_slice(),
            [McpCoherenceIssue::CommandMismatch { actual, .. }] if actual == "7"
        ));
        t.write(".mcp.json", "{");
        assert_eq!(scan_mcp_coherence(&t.0, &cfg), Err(Unmodeled));
        Ok(())
    }

    // Covers: R76
    #[test]
    fn monorepo_drift_is_null_disabled_or_delegated() {
        assert_eq!(scan_monorepo_drift(&config("{}")), Ok(None));
        assert_eq!(
            scan_monorepo_drift(&config(r#"{"monorepo":{"enabled":false}}"#))
                .map(|d| d.map(|d| d.disabled)),
            Ok(Some(true))
        );
        assert_eq!(
            scan_monorepo_drift(&config(r#"{"monorepo":{"enabled":true,"workspaces":[]}}"#)),
            Err(Unmodeled)
        );
    }

    // Covers: R76
    #[test]
    fn available_providers_skip_engram_enabled_and_non_github_gh() -> Result<(), Unmodeled> {
        let cfg = config(r#"{"plugins":{"tgrep":{"enabled":true}}}"#);
        let mut asked = 0;
        let list = list_available_external_providers(&cfg, &mut || {
            asked += 1;
            Ok(false)
        })?;
        assert!(
            !list
                .iter()
                .any(|id| id == "engram" || id == "tgrep" || id == "gh")
        );
        assert!(asked <= 1);
        assert!(
            needs_external_provider_setup_hint(&[], &list, false, false)
                == list.iter().any(|id| id == "codegraph")
        );
        assert!(needs_external_provider_setup_hint(
            &["tgrep"],
            &[],
            false,
            false
        ));
        assert!(needs_external_provider_setup_hint(&[], &[], false, true));
        assert!(!needs_external_provider_setup_hint(
            &["engram"],
            &[],
            false,
            false
        ));
        Ok(())
    }
}
