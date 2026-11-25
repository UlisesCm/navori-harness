//! The repo-level files `runRenderCore` reconciles after the engines (spec 0058 E3 M6, D23):
//! the harness block of the root `.gitignore` (`renderGitignore`), the one of `.prettierignore`
//! (`ensurePrettierIgnore`) and the scan of outputs left by engines no longer configured
//! (`scanOrphanedEngineOutputs`, report only: `--prune` is delegated).
//!
//! Like the nested `.gitignore` files, the plans are pure: a `created`/`updated` status carries
//! the content a write would put on disk, and the command decides whether to commit it.

use crate::STAMP_VERSION;
use crate::i18n;
use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsValue};
use crate::markers::{
    CommentStyle, InjectOptions, InjectStatus, MarkerMeta, inject_managed_section,
    remove_managed_section,
};
use crate::render::collect::{RepoView, read_if_exists};
use crate::render::context::Lang;
use crate::render::nested_gitignore::EPHEMERAL_HARNESS_PATHS;
use crate::render::plan::CORE_SOURCE_ID;

/// `GITIGNORE_MANAGED_ID`.
pub const GITIGNORE_MANAGED_ID: &str = "gitignore-harness";

/// `PRETTIERIGNORE_MANAGED_ID`.
pub const PRETTIERIGNORE_MANAGED_ID: &str = "prettierignore-harness";

/// `engineOwnedPaths` input per engine of `ENGINE_OUTPUTS`, in its order: marker files and
/// directories, then `textDirs`, then `generated`.
pub const ENGINE_OUTPUTS: [(&str, &[&str]); 6] = [
    (
        "claude",
        &[
            "CLAUDE.md",
            ".claude/agents",
            ".claude/skills",
            ".claude/hooks",
            ".claude/context",
            ".claude",
            ".mcp.json",
        ],
    ),
    (
        "codex",
        &[
            "AGENTS.md",
            ".agents/skills",
            ".codex/config.toml",
            ".codex/agents",
            ".codex/hooks",
            ".agents",
            ".codex",
        ],
    ),
    (
        "pi",
        &[
            "AGENTS.md",
            ".agents/skills",
            ".pi/navori/hooks",
            ".pi/navori/scripts",
            ".agents",
            ".pi",
        ],
    ),
    ("agents-md", &["AGENTS.md"]),
    ("cursor", &[".cursor/rules/navori.mdc", ".cursor"]),
    ("copilot", &[".github/copilot-instructions.md"]),
];

/// The TS throws (an unreadable destination), or reads a `package.json` Rust does not model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IgnoreFileDelegate;

/// `GitignoreRenderResult`/`PrettierIgnoreResult` of a preview, with the content a write carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IgnoreFile {
    /// `.gitignore` or `.prettierignore`.
    pub rel_path: &'static str,
    /// What the inject did.
    pub status: InjectStatus,
    /// The file after the inject (`created`/`updated` write it).
    pub content: String,
    /// Why a kept block was not touched.
    pub skipped_reason: Option<String>,
    /// `.prettierignore` only: the entries the block carries.
    pub entries: Vec<String>,
}

/// `engineOwnedPaths(engine)`: top-level owned paths, nested ones folded into their ancestor.
#[must_use]
pub fn engine_owned_paths(engine: &str) -> Vec<String> {
    let Some((_, raw)) = ENGINE_OUTPUTS.iter().find(|(name, _)| *name == engine) else {
        return Vec::new();
    };
    let mut sorted: Vec<&str> = raw.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out: Vec<String> = Vec::new();
    for path in sorted {
        let nested = out
            .iter()
            .any(|base| path == base || path.starts_with(&format!("{base}/")));
        if !nested {
            out.push(path.to_owned());
        }
    }
    out
}

/// `path.extname(p) === ""` for the static paths of [`ENGINE_OUTPUTS`].
fn has_no_extension(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    !base.rfind('.').is_some_and(|dot| dot > 0)
}

/// `engineOutputPaths(engines)`: the owned paths of `engines`, directories with a trailing slash,
/// deduped and sorted.
#[must_use]
pub fn engine_output_paths(engines: &[String]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for (engine, _) in ENGINE_OUTPUTS {
        if !engines.iter().any(|e| e == engine) {
            continue;
        }
        for owned in engine_owned_paths(engine) {
            let entry = if has_no_extension(&owned) {
                format!("{owned}/")
            } else {
                owned
            };
            if !paths.contains(&entry) {
                paths.push(entry);
            }
        }
    }
    paths.sort_unstable();
    paths
}

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// `config.engines`, its strings.
fn engines(config: &JsValue) -> Vec<String> {
    match get(config, "engines") {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `plugins?.[id]?.enabled === true`.
fn plugin_enabled(config: &JsValue, id: &str) -> bool {
    matches!(
        get(config, "plugins")
            .and_then(|p| get(p, id))
            .and_then(|p| get(p, "enabled")),
        Some(JsValue::Bool(true))
    )
}

/// `buildGitignoreBody(config)`: `None` in mode `off` (or absent).
#[must_use]
pub fn gitignore_body(config: &JsValue) -> Option<String> {
    let mode = match get(config, "gitignoreHarness") {
        Some(JsValue::String(s)) => s.to_rust(),
        _ => None,
    };
    let mode = mode.as_deref().unwrap_or("off");
    if mode == "off" {
        return None;
    }
    let mut entries: Vec<String> = EPHEMERAL_HARNESS_PATHS
        .iter()
        .map(|p| (*p).to_owned())
        .collect();
    if plugin_enabled(config, "codegraph") {
        entries.push(".codegraph/".to_owned());
    }
    if plugin_enabled(config, "tgrep") {
        entries.push(".tgrep/".to_owned());
    }
    if mode == "full" {
        entries.extend(engine_output_paths(&engines(config)));
    }
    Some(entries.join("\n"))
}

fn core_meta() -> MarkerMeta {
    MarkerMeta {
        source: Some(CORE_SOURCE_ID.to_owned()),
        version: Some(STAMP_VERSION.to_owned()),
        ..MarkerMeta::default()
    }
}

/// Injects `body` under `id` and fills the skip reason, as both TS functions do.
fn inject(
    existing: &str,
    id: &str,
    body: &str,
    force: bool,
    lang: Lang,
    ambient_floor: Option<&str>,
) -> (InjectStatus, String, Option<String>) {
    let result = inject_managed_section(
        existing,
        id,
        body,
        &core_meta(),
        InjectOptions {
            shell: true,
            force_overwrite: force,
            ambient_floor,
            ..InjectOptions::default()
        },
    );
    let skipped_reason = match result.status {
        InjectStatus::UserModifiedSkipped => {
            Some(i18n::managed_block_edited_by_hand(lang).to_owned())
        }
        InjectStatus::DowngradeSkipped => Some(i18n::block_from_newer_navori(
            lang,
            result.details.existing_version.as_deref(),
        )),
        _ => None,
    };
    (result.status, result.output, skipped_reason)
}

/// `renderGitignore(cwd, config, { dryRun: true, force, lang })`.
///
/// # Errors
/// [`IgnoreFileDelegate`] when `.gitignore` exists but cannot be read as text.
pub fn plan_gitignore(
    view: &dyn RepoView,
    config: &JsValue,
    force: bool,
    lang: Lang,
    ambient_floor: Option<&str>,
) -> Result<Option<IgnoreFile>, IgnoreFileDelegate> {
    let Some(body) = gitignore_body(config) else {
        return Ok(None);
    };
    let existing = read_if_exists(view, ".gitignore")
        .map_err(|_| IgnoreFileDelegate)?
        .unwrap_or_else(|| i18n::gitignore_header(lang).to_owned());
    let (status, content, skipped_reason) = inject(
        &existing,
        GITIGNORE_MANAGED_ID,
        &body,
        force,
        lang,
        ambient_floor,
    );
    Ok(Some(IgnoreFile {
        rel_path: ".gitignore",
        status,
        content,
        skipped_reason,
        entries: Vec::new(),
    }))
}

/// `PRETTIER_CONFIG_FILES`.
const PRETTIER_CONFIG_FILES: [&str; 14] = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.json5",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.toml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.ts",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
    "prettier.config.ts",
];

/// `/(?:^|[\s/"'])prettier(?:$|[\s"'])/.test(command)`.
fn invokes_prettier(command: &str) -> bool {
    command.match_indices("prettier").any(|(at, word)| {
        let before = command[..at].chars().next_back();
        let after = command[at + word.len()..].chars().next();
        before.is_none_or(|c| is_js_whitespace(c) || matches!(c, '/' | '"' | '\''))
            && after.is_none_or(|c| is_js_whitespace(c) || matches!(c, '"' | '\''))
    })
}

/// `Object.values(pkg.scripts ?? {})` over a parsed value, its string members.
fn script_commands(scripts: Option<&JsValue>) -> Vec<String> {
    match scripts {
        Some(JsValue::Object(object)) => object
            .entries()
            .iter()
            .filter_map(|(_, value)| match value {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|value| match value {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        // A string's values are its one-character strings, which never invoke prettier.
        _ => Vec::new(),
    }
}

/// `detectPrettier(cwd)`.
///
/// # Errors
/// [`IgnoreFileDelegate`] when `package.json` exists but Rust cannot read it exactly as
/// `JSON.parse` would (unreadable, not UTF-8, or outside what [`js_json::parse`] models).
pub fn detect_prettier(view: &dyn RepoView) -> Result<bool, IgnoreFileDelegate> {
    if PRETTIER_CONFIG_FILES.iter().any(|file| view.exists(file)) {
        return Ok(true);
    }
    let Some(text) = read_if_exists(view, "package.json").map_err(|_| IgnoreFileDelegate)? else {
        return Ok(false);
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let pkg = js_json::parse(text).ok_or(IgnoreFileDelegate)?;
    // `typeof parsed === "object" && parsed !== null`: arrays pass, and read nothing below.
    let JsValue::Object(object) = &pkg else {
        return Ok(false);
    };
    let has = |key: &str| {
        object
            .get(key)
            .and_then(|deps| get(deps, "prettier"))
            .is_some()
    };
    if object.has("prettier") || has("dependencies") || has("devDependencies") {
        return Ok(true);
    }
    Ok(script_commands(object.get("scripts"))
        .iter()
        .any(|command| invokes_prettier(command)))
}

/// `line.trim()` with the ECMAScript whitespace set.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `normalizeEntry`: trimmed, trailing slashes dropped.
fn normalize_entry(line: &str) -> &str {
    js_trim(line).trim_end_matches('/')
}

/// `userOwnedEntries(existing)`: the rules outside the managed block.
fn user_owned_entries(existing: &str) -> Vec<String> {
    let outside = remove_managed_section(existing, PRETTIERIGNORE_MANAGED_ID, CommentStyle::Shell);
    outside
        .split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| normalize_entry(line).to_owned())
        .collect()
}

/// `ensurePrettierIgnore(cwd, config, { dryRun: true, force, lang })`.
///
/// # Errors
/// [`IgnoreFileDelegate`] when `package.json` or `.prettierignore` cannot be read as the TS does.
pub fn plan_prettierignore(
    view: &dyn RepoView,
    config: &JsValue,
    force: bool,
    lang: Lang,
    ambient_floor: Option<&str>,
) -> Result<Option<IgnoreFile>, IgnoreFileDelegate> {
    if !detect_prettier(view)? {
        return Ok(None);
    }
    let desired = engine_output_paths(&engines(config));
    if desired.is_empty() {
        return Ok(None);
    }
    let existing = read_if_exists(view, ".prettierignore")
        .map_err(|_| IgnoreFileDelegate)?
        .unwrap_or_else(|| i18n::prettier_ignore_header(lang).to_owned());
    let covered = user_owned_entries(&existing);
    let entries: Vec<String> = desired
        .into_iter()
        .filter(|entry| !covered.iter().any(|c| c == normalize_entry(entry)))
        .collect();
    if entries.is_empty() {
        return Ok(Some(IgnoreFile {
            rel_path: ".prettierignore",
            status: InjectStatus::Unchanged,
            content: existing,
            skipped_reason: None,
            entries,
        }));
    }
    let (status, content, skipped_reason) = inject(
        &existing,
        PRETTIERIGNORE_MANAGED_ID,
        &entries.join("\n"),
        force,
        lang,
        ambient_floor,
    );
    Ok(Some(IgnoreFile {
        rel_path: ".prettierignore",
        status,
        content,
        skipped_reason,
        entries,
    }))
}

/// `scanOrphanedEngineOutputs(cwd, config)`: `(engine, paths)` of outputs on disk owned only by
/// engines outside `config.engines`, each path once.
#[must_use]
pub fn scan_orphaned_engine_outputs(
    view: &dyn RepoView,
    config: &JsValue,
) -> Vec<(String, Vec<String>)> {
    let enabled = engines(config);
    let owned_by_enabled: Vec<String> = enabled
        .iter()
        .flat_map(|engine| engine_owned_paths(engine))
        .collect();
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (engine, _) in ENGINE_OUTPUTS {
        if enabled.iter().any(|e| e == engine) {
            continue;
        }
        let paths: Vec<String> = engine_owned_paths(engine)
            .into_iter()
            .filter(|p| !owned_by_enabled.contains(p) && !seen.contains(p) && view.exists(p))
            .collect();
        seen.extend(paths.iter().cloned());
        if !paths.is_empty() {
            out.push((engine.to_owned(), paths));
        }
    }
    out
}
