//! Port of the `lib/diagnose/health.ts` subset `status` reads (spec 0060 T23, R73, R76): the
//! marker listings, the managed-output table, managed drift, duplicated markers, the rendered
//! text the invariants are matched against, the missing plugins and `suggestNextSteps`.
//!
//! Pure reads of the repo. A monorepo with enabled workspaces (every scan recurses into them) and
//! text that is not UTF-8 are [`Unmodeled`]: the caller delegates to the TS. `doctor` (slice 3)
//! reuses these scans and extends [`HealthState`] with its own inputs.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::config::Config;
use crate::i18n::Status;
use crate::js_json::JsValue;
use crate::markers::{CommentStyle, compute_managed_hash, extract_managed_content, prose_lines};
use crate::render::claude_md::has_monorepo_workspaces;
use crate::render::context::Lang;
use crate::render::nested_gitignore::EPHEMERAL_HARNESS_PATHS;
use crate::render::plugins::{LoadedPlugin, PluginsLoadResult};
use crate::semver::is_downgrade;
pub use crate::workspace::patterns::Unmodeled;

/// `MarkerInfo`: an open marker's id and the attributes drift reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerInfo {
    /// `id="…"`.
    pub id: String,
    /// `hash="…"`, when non-empty.
    pub hash: Option<String>,
    /// `version="…"`, when non-empty.
    pub version: Option<String>,
    /// `source="…"`, when non-empty.
    pub source: Option<String>,
}

/// `MARKER_TAG_RE`: open markers of both syntaxes, `id` first on the same line.
static MARKER_TAG: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(?:<!-- navori:managed|# navori:managed start)[ \t]+id="([^"\n]+)"[^\n>]*"#).ok()
});

/// `tag.match(/<name>="([^"]+)"/)?.[1]`.
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(at) = tag.get(from..)?.find(&needle) {
        let value_start = from + at + needle.len();
        match tag[value_start..].find('"') {
            Some(0) => from += at + 1,
            Some(end) => return Some(tag[value_start..value_start + end].to_owned()),
            None => return None,
        }
    }
    None
}

/// `markersInLines`.
fn markers_in_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<MarkerInfo> {
    let Some(re) = MARKER_TAG.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for text in lines {
        for captures in re.captures_iter(text) {
            let (Some(tag), Some(id)) = (captures.get(0), captures.get(1)) else {
                continue;
            };
            let tag = tag.as_str();
            out.push(MarkerInfo {
                id: id.as_str().to_owned(),
                hash: tag_attr(tag, "hash"),
                version: tag_attr(tag, "version"),
                source: tag_attr(tag, "source"),
            });
        }
    }
    out
}

/// `listMarkers` over a file's content: prose lines only (fences and managed bodies skipped).
#[must_use]
pub fn list_markers(content: &str) -> Vec<MarkerInfo> {
    let lines = prose_lines(content, &[CommentStyle::Html, CommentStyle::Shell]);
    markers_in_lines(lines.iter().map(|line| line.text))
}

/// `listMarkersRaw` over a file's content: every line, no parser in between.
#[must_use]
pub fn list_markers_raw(content: &str) -> Vec<MarkerInfo> {
    markers_in_lines(content.split('\n'))
}

/// One managed-output source of `ENGINE_OUTPUTS`.
#[derive(Debug, Clone, Copy)]
enum MarkerSource {
    /// A fixed file.
    File(&'static str, CommentStyle),
    /// The `<ext>` files directly under a directory.
    Flat(&'static str, &'static str, CommentStyle),
    /// The `<ext>` files of a directory tree.
    Recursive(&'static str, &'static str, CommentStyle),
}

/// `ENGINE_OUTPUTS` entry: the engine, its marker sources and its `textDirs`.
struct EngineOutputs {
    engine: &'static str,
    markers: &'static [MarkerSource],
    text_dirs: &'static [&'static str],
}

const HTML: CommentStyle = CommentStyle::Html;
const SHELL: CommentStyle = CommentStyle::Shell;

/// `ENGINE_OUTPUTS` (marker sources and text roots; `generated` lives in
/// [`crate::render::ignore_files::ENGINE_OUTPUTS`]).
const ENGINE_OUTPUTS: [EngineOutputs; 6] = [
    EngineOutputs {
        engine: "claude",
        markers: &[
            MarkerSource::File("CLAUDE.md", HTML),
            MarkerSource::Flat(".claude/agents", ".md", HTML),
            MarkerSource::Recursive(".claude/skills", ".md", HTML),
            MarkerSource::Recursive(".claude/hooks", ".sh", SHELL),
            MarkerSource::Recursive(".claude/context", ".md", HTML),
        ],
        text_dirs: &[".claude"],
    },
    EngineOutputs {
        engine: "codex",
        markers: &[
            MarkerSource::File("AGENTS.md", HTML),
            MarkerSource::Recursive(".agents/skills", ".md", HTML),
            MarkerSource::File(".codex/config.toml", SHELL),
            MarkerSource::Recursive(".codex/agents", ".toml", SHELL),
            MarkerSource::Recursive(".codex/hooks", ".sh", SHELL),
        ],
        text_dirs: &[".agents", ".codex"],
    },
    EngineOutputs {
        engine: "pi",
        markers: &[
            MarkerSource::File("AGENTS.md", HTML),
            MarkerSource::Recursive(".agents/skills", ".md", HTML),
            MarkerSource::Recursive(".pi/navori/hooks", ".sh", SHELL),
            MarkerSource::Recursive(".pi/navori/scripts", ".sh", SHELL),
        ],
        text_dirs: &[".agents", ".pi"],
    },
    EngineOutputs {
        engine: "agents-md",
        markers: &[MarkerSource::File("AGENTS.md", HTML)],
        text_dirs: &[],
    },
    EngineOutputs {
        engine: "cursor",
        markers: &[MarkerSource::File(".cursor/rules/navori.mdc", HTML)],
        text_dirs: &[".cursor"],
    },
    EngineOutputs {
        engine: "copilot",
        markers: &[MarkerSource::File(".github/copilot-instructions.md", HTML)],
        text_dirs: &[],
    },
];

/// `config.engines ?? ["claude"]`; `None` when it is not an array of strings.
#[must_use]
pub fn configured_engines(config: &JsValue) -> Option<Vec<String>> {
    let JsValue::Object(root) = config else {
        return None;
    };
    match root.get("engines") {
        None | Some(JsValue::Undefined) => Some(vec!["claude".to_owned()]),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::String(text) => text.to_rust(),
                _ => None,
            })
            .collect(),
        Some(_) => None,
    }
}

/// `readdirSync(dir)` names, sorted like libuv's scandir (byte order); empty when unreadable.
fn sorted_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<std::fs::DirEntry> = read.filter_map(Result::ok).collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    entries
}

/// `collectFilesFlat`: repo-relative `<ext>` names directly under `cwd/dir`, any entry type.
fn collect_flat(cwd: &Path, dir: &str, ext: &str) -> Result<Vec<String>, Unmodeled> {
    let mut out = Vec::new();
    for entry in sorted_entries(&cwd.join(dir)) {
        let name = entry.file_name();
        let name = name.to_str().ok_or(Unmodeled)?;
        if name.ends_with(ext) {
            out.push(format!("{dir}/{name}"));
        }
    }
    Ok(out)
}

/// `collectFilesRecursive`: regular `<ext>` files of a tree, symlinks skipped, depth capped at 6.
fn collect_recursive(cwd: &Path, dir: &str, ext: &str) -> Result<Vec<String>, Unmodeled> {
    fn walk(
        cwd: &Path,
        rel: &str,
        depth: usize,
        ext: &str,
        out: &mut Vec<String>,
    ) -> Result<(), Unmodeled> {
        if depth > 6 {
            return Ok(());
        }
        for entry in sorted_entries(&cwd.join(rel)) {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let child = format!("{rel}/{}", name.to_str().ok_or(Unmodeled)?);
            if kind.is_dir() {
                walk(cwd, &child, depth + 1, ext, out)?;
            } else if kind.is_file() && child.ends_with(ext) {
                out.push(child);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if cwd.join(dir).exists() {
        walk(cwd, dir, 0, ext, &mut out)?;
    }
    Ok(out)
}

/// `collectMarkerFiles(cwd, undefined, engines)`: existing marker files of the configured
/// engines, deduped by path (the first style wins).
///
/// # Errors
/// A file name that is not UTF-8.
pub fn collect_marker_files(
    cwd: &Path,
    engines: &[String],
) -> Result<Vec<(String, CommentStyle)>, Unmodeled> {
    let mut seen: Vec<(String, CommentStyle)> = Vec::new();
    for outputs in &ENGINE_OUTPUTS {
        if !engines.iter().any(|e| e == outputs.engine) {
            continue;
        }
        for source in outputs.markers {
            let (paths, style) = match *source {
                MarkerSource::File(path, style) => (
                    if cwd.join(path).exists() {
                        vec![path.to_owned()]
                    } else {
                        Vec::new()
                    },
                    style,
                ),
                MarkerSource::Flat(dir, ext, style) => (collect_flat(cwd, dir, ext)?, style),
                MarkerSource::Recursive(dir, ext, style) => {
                    (collect_recursive(cwd, dir, ext)?, style)
                }
            };
            for path in paths {
                if !seen.iter().any(|(p, _)| *p == path) {
                    seen.push((path, style));
                }
            }
        }
    }
    Ok(seen)
}

/// `readFileSync(path, "utf-8")`: `Ok(None)` when it cannot be read.
///
/// # Errors
/// Bytes that are not UTF-8 (the TS decoder's replacement is not modelled).
pub fn read_text(path: &Path) -> Result<Option<String>, Unmodeled> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| Unmodeled),
        Err(_) => Ok(None),
    }
}

/// `MissingPlugin`: an enabled plugin that cannot be loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingPlugin {
    /// The configured id.
    pub id: String,
    /// Why (`unknown plugin id`; manifest failures delegate before reaching here).
    pub reason: String,
}

/// `collectMissingPlugins(config)` from `loadEnabledPlugins`'s result: unknown ids, retired ones
/// excluded.
#[must_use]
pub fn collect_missing_plugins(plugins: &PluginsLoadResult) -> Vec<MissingPlugin> {
    plugins
        .missing
        .iter()
        .map(|id| MissingPlugin {
            id: id.clone(),
            reason: "unknown plugin id".to_owned(),
        })
        .collect()
}

/// What a [`DriftReport`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriftKind {
    /// The marker is newer than the CLI.
    Downgrade,
    /// `harnessVersion` is newer than the CLI.
    Harness,
    /// The managed body no longer hashes to its `hash=`.
    Content,
}

/// `DriftReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriftReport {
    /// Repo-relative path.
    pub file_path: String,
    /// The marker id (`harnessVersion` for [`DriftKind::Harness`]).
    pub marker_id: String,
    /// The marker's `source=`.
    pub source: String,
    /// The kind.
    pub kind: DriftKind,
    /// `fromVersion`.
    pub from_version: Option<String>,
    /// `toVersion`.
    pub to_version: Option<String>,
    /// `expectedHash`.
    pub expected_hash: Option<String>,
    /// `actualHash`.
    pub actual_hash: Option<String>,
}

/// `knownDriftSources`: `@navori/core` plus every enabled plugin that loads.
#[must_use]
pub fn known_drift_sources(loaded: &[LoadedPlugin]) -> Vec<String> {
    let mut known = vec!["@navori/core".to_owned()];
    known.extend(loaded.iter().map(|p| format!("@navori/plugin-{}", p.dir)));
    known
}

/// `scanManagedDrift(cwd, config)` on a root without workspaces. `cli_version` is
/// `readCliVersion()`.
///
/// # Errors
/// Enabled monorepo workspaces, engines that are not strings, or text that is not UTF-8.
pub fn scan_managed_drift(
    cwd: &Path,
    config: &Config,
    known_sources: &[String],
    cli_version: &str,
) -> Result<Vec<DriftReport>, Unmodeled> {
    if has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    let mut out = Vec::new();
    for (path, style) in collect_marker_files(cwd, &engines)? {
        let content = read_text(&cwd.join(&path))?;
        let markers = list_markers(content.as_deref().unwrap_or(""));
        for marker in markers {
            let Some(source) = marker.source else {
                continue;
            };
            if let Some(version) = &marker.version
                && known_sources.contains(&source)
                && is_downgrade(Some(version), Some(cli_version))
            {
                out.push(DriftReport {
                    file_path: path.clone(),
                    marker_id: marker.id.clone(),
                    source: source.clone(),
                    kind: DriftKind::Downgrade,
                    from_version: Some(version.clone()),
                    to_version: Some(cli_version.to_owned()),
                    expected_hash: None,
                    actual_hash: None,
                });
            }
            if let (Some(hash), Some(content)) = (&marker.hash, &content)
                && let Some(body) = extract_managed_content(content, &marker.id, style)
            {
                let actual = compute_managed_hash(&body);
                if actual != *hash {
                    out.push(DriftReport {
                        file_path: path.clone(),
                        marker_id: marker.id.clone(),
                        source: source.clone(),
                        kind: DriftKind::Content,
                        from_version: None,
                        to_version: None,
                        expected_hash: Some(hash.clone()),
                        actual_hash: Some(actual),
                    });
                }
            }
        }
    }
    if let Some(harness) = config.harness_version()
        && !harness.is_empty()
        && is_downgrade(Some(&harness), Some(cli_version))
    {
        out.push(DriftReport {
            file_path: "navori.config.json".to_owned(),
            marker_id: "harnessVersion".to_owned(),
            source: "navori.config.json".to_owned(),
            kind: DriftKind::Harness,
            from_version: Some(harness),
            to_version: Some(cli_version.to_owned()),
            expected_hash: None,
            actual_hash: None,
        });
    }
    Ok(out)
}

/// `DuplicateMarker`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateMarker {
    /// Repo-relative path.
    pub file_path: String,
    /// The repeated id.
    pub id: String,
    /// How many open markers carry it (>= 2).
    pub count: usize,
}

/// `scanDuplicateMarkers(cwd, config)` on a root without workspaces.
///
/// # Errors
/// As [`scan_managed_drift`].
pub fn scan_duplicate_markers(
    cwd: &Path,
    config: &Config,
) -> Result<Vec<DuplicateMarker>, Unmodeled> {
    if has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    let mut out = Vec::new();
    for (path, _) in collect_marker_files(cwd, &engines)? {
        let content = read_text(&cwd.join(&path))?.unwrap_or_default();
        let mut counts: Vec<(String, usize)> = Vec::new();
        for marker in list_markers_raw(&content) {
            match counts.iter_mut().find(|(id, _)| *id == marker.id) {
                Some((_, count)) => *count += 1,
                None => counts.push((marker.id, 1)),
            }
        }
        for (id, count) in counts {
            if count > 1 {
                out.push(DuplicateMarker {
                    file_path: path.clone(),
                    id,
                    count,
                });
            }
        }
    }
    Ok(out)
}

/// `collectText`: `.md`/`.json`/`.sh` text under `dir`, skipping `node_modules`, `.git` and the
/// ephemeral harness directories (relative to `cwd`). Symlinks are neither files nor directories.
fn collect_text(cwd: &Path, dir: &Path, parts: &mut Vec<String>) -> Result<(), Unmodeled> {
    for entry in sorted_entries(dir) {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_str().ok_or(Unmodeled)?;
        let abs = dir.join(name);
        if kind.is_dir() {
            if name == "node_modules" || name == ".git" {
                continue;
            }
            let rel = abs.strip_prefix(cwd).map_err(|_| Unmodeled)?;
            let rel = format!("{}/", rel.to_str().ok_or(Unmodeled)?);
            if EPHEMERAL_HARNESS_PATHS.contains(&rel.as_str()) {
                continue;
            }
            collect_text(cwd, &abs, parts)?;
        } else if kind.is_file()
            && [".md", ".json", ".sh"]
                .iter()
                .any(|ext| name.ends_with(ext))
            && let Some(text) = read_text(&abs)?
        {
            parts.push(text);
        }
    }
    Ok(())
}

/// `readRenderedText(cwd, config)`: the root prose files and text trees of the configured engines,
/// joined with newlines.
///
/// # Errors
/// Names or text that are not UTF-8.
pub fn read_rendered_text(cwd: &Path, engines: &[String]) -> Result<String, Unmodeled> {
    let mut parts = Vec::new();
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    for engine in engines {
        let Some(outputs) = ENGINE_OUTPUTS.iter().find(|o| o.engine == engine) else {
            continue;
        };
        for source in outputs.markers {
            let MarkerSource::File(path, _) = *source else {
                continue;
            };
            let abs = cwd.join(path);
            if seen.contains(&abs) || !abs.exists() {
                continue;
            }
            if let Some(text) = read_text(&abs)? {
                parts.push(text);
            }
            seen.push(abs);
        }
        for dir in outputs.text_dirs {
            let abs = cwd.join(dir);
            if seen.contains(&abs) || !abs.exists() {
                continue;
            }
            collect_text(cwd, &abs, &mut parts)?;
            seen.push(abs);
        }
    }
    Ok(parts.join("\n"))
}

/// `HealthState`: what `suggestNextSteps` reads. `doctor` adds its order and legacy-agent inputs.
#[derive(Debug, Clone, Copy)]
pub struct HealthState<'a> {
    /// `claudeMdExists`.
    pub claude_md_exists: bool,
    /// `missingPlugins.length`.
    pub missing_plugins: usize,
    /// `drifts`.
    pub drifts: &'a [DriftReport],
    /// `renderPending`: `None` when unknown.
    pub render_pending: Option<usize>,
}

/// `suggestNextSteps(state, lang)`.
#[must_use]
pub fn suggest_next_steps(state: &HealthState<'_>, lang: Lang) -> Vec<String> {
    let ts = Status(lang);
    let mut steps = Vec::new();
    if !state.claude_md_exists {
        steps.push(ts.next_render().to_owned());
    }
    if state.missing_plugins > 0 {
        steps.push(ts.next_missing_plugins(state.missing_plugins));
    }
    if state.drifts.iter().any(|d| d.kind == DriftKind::Content) {
        steps.push(ts.next_content_drift().to_owned());
    }
    if state
        .drifts
        .iter()
        .any(|d| matches!(d.kind, DriftKind::Downgrade | DriftKind::Harness))
    {
        steps.push(ts.next_downgrade_drift().to_owned());
    }
    if let Some(pending) = state.render_pending
        && pending > 0
    {
        steps.push(ts.next_render_pending(pending));
    }
    if steps.is_empty() {
        steps.push(ts.all_current().to_owned());
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drift(kind: DriftKind) -> DriftReport {
        DriftReport {
            file_path: "CLAUDE.md".to_owned(),
            marker_id: "a".to_owned(),
            source: "@navori/core".to_owned(),
            kind,
            from_version: None,
            to_version: None,
            expected_hash: None,
            actual_hash: None,
        }
    }

    // Covers: R73
    #[test]
    fn markers_read_open_tags_with_their_attributes() {
        let content = "<!-- navori:managed id=\"a\" hash=\"\" hash=\"h1\" version=\"1.2.3\" source=\"@navori/core\" -->\nbody\n<!-- /navori:managed id=\"a\" -->\n```\n<!-- navori:managed id=\"q\" -->\n```\n# navori:managed start id=\"s\" source=\"x\"\nnavori:managed id=\"mention\"\n";
        let prose = list_markers(content);
        let ids: Vec<&str> = prose.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["a", "s"]);
        assert_eq!(prose[0].hash.as_deref(), Some("h1"));
        assert_eq!(prose[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(prose[1].hash, None);
        let raw: Vec<String> = list_markers_raw(content)
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(raw, ["a", "q", "s"]);
    }

    // Covers: R76
    #[test]
    fn next_steps_follow_the_ts_order_and_fall_back_to_all_current() {
        let drifts = [drift(DriftKind::Harness), drift(DriftKind::Content)];
        let state = HealthState {
            claude_md_exists: false,
            missing_plugins: 2,
            drifts: &drifts,
            render_pending: Some(3),
        };
        assert_eq!(
            suggest_next_steps(&state, Lang::En),
            [
                "Run 'navori render --apply' to generate files for the configured engines.",
                "Resolve 2 missing plugin(s): install them or remove them from the config.",
                "Run 'navori sync --interactive' to resolve manually edited blocks.",
                "Your navori CLI is out of date (on-disk blocks are newer): update it with 'npm i -g navori@latest'. Render won't roll them back.",
                "A render would change 3 file(s)/block(s): run 'navori render' to preview and 'navori render --apply' to apply.",
            ]
        );
        let idle = HealthState {
            claude_md_exists: true,
            missing_plugins: 0,
            drifts: &[],
            render_pending: Some(0),
        };
        assert_eq!(
            suggest_next_steps(&idle, Lang::Es),
            ["Todo al día — sin acciones pendientes."]
        );
    }

    // Covers: R76
    #[test]
    fn drift_flags_hand_edits_newer_markers_and_a_newer_harness() -> Result<(), Unmodeled> {
        let dir = std::env::temp_dir().join(format!("navori-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|_| Unmodeled)?;
        let sample =
            "<!-- navori:managed id=\"ok\" -->\nkept\n<!-- /navori:managed id=\"ok\" -->\n";
        let body = extract_managed_content(sample, "ok", CommentStyle::Html).ok_or(Unmodeled)?;
        let hash = compute_managed_hash(&body);
        let body = "kept\n";
        let claude = format!(
            "<!-- navori:managed id=\"ok\" hash=\"{hash}\" version=\"0.1.0\" source=\"@navori/core\" -->\n{body}<!-- /navori:managed id=\"ok\" -->\n<!-- navori:managed id=\"edited\" hash=\"{hash}\" version=\"99.0.0\" source=\"@navori/core\" -->\nchanged\n<!-- /navori:managed id=\"edited\" -->\n<!-- navori:managed id=\"foreign\" version=\"99.0.0\" source=\"@other\" -->\nx\n<!-- /navori:managed id=\"foreign\" -->\n"
        );
        std::fs::write(dir.join("CLAUDE.md"), claude).map_err(|_| Unmodeled)?;
        let config = Config {
            data: crate::js_json::parse(r#"{"engines":["claude"],"harnessVersion":"9.0.0"}"#)
                .ok_or(Unmodeled)?,
            warnings: Vec::new(),
        };
        let known = known_drift_sources(&[]);
        let drifts = scan_managed_drift(&dir, &config, &known, "1.0.0")?;
        let _ = std::fs::remove_dir_all(&dir);
        let kinds: Vec<(&str, DriftKind)> = drifts
            .iter()
            .map(|d| (d.marker_id.as_str(), d.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("edited", DriftKind::Downgrade),
                ("edited", DriftKind::Content),
                ("harnessVersion", DriftKind::Harness),
            ]
        );
        Ok(())
    }
}
