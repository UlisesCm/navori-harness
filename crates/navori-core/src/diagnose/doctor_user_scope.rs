//! `doctor`'s user-scope scans (spec 0060 T23 slice 5e4): what the retired global layer left on
//! the machine (`scanGlobalLayerLeftovers`) and the harness that was already there when navori
//! arrived (`scanForeignHarness`), plus the explicit list of doctor scans that stay in the TS.
//!
//! Both scans are read-only and advisory: neither feeds the health verdict. As in
//! `doctor_machine`, whatever the port does not model (text that is not UTF-8, JSON outside the
//! `JsValue` model, a `localeCompare` outside printable ASCII, a `HOME` Node reads from the
//! password database, a working directory that is not normalized) returns [`Unmodeled`] and the
//! CLI delegates to the TS.

use std::path::Path;
use std::time::Duration;

use crate::collate::{compare_ascii, default_locale_modeled};
use crate::config::Config;
use crate::diagnose::doctor_machine::{Host, claude_user_dir, get, join_text, js_sort, texts};
use crate::diagnose::health::{configured_engines, list_markers};
use crate::js_json::{self, JsValue};
use crate::process::Request;
use crate::workspace::patterns::Unmodeled;
use crate::workspace::registry;

/// `SKILL_DIR_ENTRY`.
const SKILL_DIR_ENTRY: &str = "SKILL.md";
/// navori's own global plugin directory under `<claudeDir>/skills/`.
const NAVORI_PLUGIN_DIR: &str = "navori";
/// `join(".claude-plugin", "plugin.json")`.
const PLUGIN_MANIFEST_REL: &str = ".claude-plugin/plugin.json";
/// `git check-ignore` runs without a limit in the TS; a day stands in for "never".
const GIT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/// `JSON.parse(text)`: `Ok(None)` for text JS rejects, [`Unmodeled`] for text JS accepts that the
/// model does not carry (lone surrogate escapes, numbers beyond a double, deep nesting).
fn parse_json(text: &str) -> Result<Option<JsValue>, Unmodeled> {
    if let Some(value) = js_json::parse(text) {
        return Ok(Some(value));
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Err(error) => {
            let message = error.to_string();
            let beyond = ["recursion limit", "surrogate", "hex escape", "out of range"]
                .iter()
                .any(|needle| message.contains(needle));
            if beyond { Err(Unmodeled) } else { Ok(None) }
        }
        Ok(_) => Err(Unmodeled),
    }
}

/// `readFileSync(path, "utf-8")`: `Ok(None)` where it throws, [`Unmodeled`] for text that is not
/// UTF-8.
fn read_text(path: &str) -> Result<Option<String>, Unmodeled> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| Unmodeled),
        Err(_) => Ok(None),
    }
}

/// `path.join(base, ...parts)` for an absolute, normalized `base` and plain segments.
fn join_all(base: &str, parts: &[&str]) -> String {
    registry::resolve("/", &join_text(base, &parts.join("/")))
}

// ---------------------------------------------------------------------------------------------
// scanGlobalLayerLeftovers
// ---------------------------------------------------------------------------------------------

/// `GlobalLeftoverKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalLeftoverKind {
    /// `~/.navori/global.json`.
    Manifest,
    /// `<claudeDir>/skills/navori`, a plugin whose manifest names `navori`.
    Plugin,
    /// `<claudeDir>/hooks/navori-global-baseline.sh`.
    LegacyHook,
    /// `~/Library/LaunchAgents/com.navori.audit-collect.plist`.
    LaunchAgent,
}

impl GlobalLeftoverKind {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::Plugin => "plugin",
            Self::LegacyHook => "legacy-hook",
            Self::LaunchAgent => "launch-agent",
        }
    }
}

/// `GlobalLeftover`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalLeftover {
    /// What it is.
    pub kind: GlobalLeftoverKind,
    /// Its resolved path, without a trailing slash.
    pub path: String,
}

/// `lstat` succeeds: a broken symlink still counts as present.
fn present(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// `<dir>/.claude-plugin/plugin.json` parses with `name === "navori"`.
fn is_navori_plugin(dir: &str) -> Result<bool, Unmodeled> {
    let Some(text) = read_text(&join_all(dir, &[PLUGIN_MANIFEST_REL]))? else {
        return Ok(false);
    };
    Ok(match parse_json(&text)? {
        Some(parsed) => get(&parsed, "name").is_some_and(|name| match name {
            JsValue::String(name) => name.is("navori"),
            _ => false,
        }),
        None => false,
    })
}

/// `scanGlobalLayerLeftovers()`: what the retired global layer left behind. An unusable `HOME`
/// yields `[]`.
///
/// # Errors
/// [`Unmodeled`] for an environment value that is not UTF-8, a `HOME` Node reads elsewhere or a
/// `plugin.json` the port does not read the way the TS does.
pub fn scan_global_layer_leftovers(host: &Host<'_>) -> Result<Vec<GlobalLeftover>, Unmodeled> {
    let Some(home) = host.home()? else {
        return Ok(Vec::new());
    };
    let Some(claude_dir) = claude_user_dir(host)? else {
        return Ok(Vec::new());
    };
    let mut found = Vec::new();
    let manifest = join_all(&home, &[".navori", "global.json"]);
    if present(&manifest) {
        found.push(GlobalLeftover {
            kind: GlobalLeftoverKind::Manifest,
            path: manifest,
        });
    }
    let plugin = join_all(&claude_dir, &["skills", NAVORI_PLUGIN_DIR]);
    if present(&plugin) && is_navori_plugin(&plugin)? {
        found.push(GlobalLeftover {
            kind: GlobalLeftoverKind::Plugin,
            path: plugin,
        });
    }
    let hook = join_all(&claude_dir, &["hooks", "navori-global-baseline.sh"]);
    if present(&hook) {
        found.push(GlobalLeftover {
            kind: GlobalLeftoverKind::LegacyHook,
            path: hook,
        });
    }
    let plist = join_all(
        &home,
        &["Library", "LaunchAgents", "com.navori.audit-collect.plist"],
    );
    if present(&plist) {
        found.push(GlobalLeftover {
            kind: GlobalLeftoverKind::LaunchAgent,
            path: plist,
        });
    }
    Ok(found)
}

// ---------------------------------------------------------------------------------------------
// scanForeignHarness
// ---------------------------------------------------------------------------------------------

/// `ForeignScope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForeignScope {
    /// Inside the repo.
    Repo,
    /// `~/.claude`.
    Personal,
    /// Another vendor's `@skills-dir` plugin.
    Plugin,
}

impl ForeignScope {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Repo => "repo",
            Self::Personal => "personal",
            Self::Plugin => "plugin",
        }
    }
}

/// `ForeignAssetType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForeignAssetType {
    /// An agent.
    Agent,
    /// A skill.
    Skill,
}

impl ForeignAssetType {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Skill => "skill",
        }
    }
}

/// `ConflictWinner`: who Claude Code actually loads when both files exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictWinner {
    /// navori's asset.
    Navori,
    /// The foreign one.
    Foreign,
    /// Not documented.
    Undecided,
}

impl ConflictWinner {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Navori => "navori",
            Self::Foreign => "foreign",
            Self::Undecided => "undecided",
        }
    }
}

/// `ForeignConflict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignConflict {
    /// `<type>:<scope>:<name>`.
    pub id: String,
    /// `type`.
    pub asset_type: ForeignAssetType,
    /// `scope`.
    pub scope: ForeignScope,
    /// `name`.
    pub name: String,
    /// `foreignPath`: repo-relative for `repo`, absolute otherwise.
    pub foreign_path: String,
    /// `navoriPath`: repo-relative.
    pub navori_path: String,
    /// `winner`.
    pub winner: ConflictWinner,
    /// `gitignored`: set only for a `repo` foreign file that git ignores.
    pub gitignored: Option<bool>,
    /// `adoptable`.
    pub adoptable: bool,
    /// `pluginId`: the owning plugin, when the foreign copy came from one.
    pub plugin_id: Option<String>,
}

/// `ForeignPermissionConflict`: a rule navori denies that a foreign settings file allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignPermissionConflict {
    /// `rule`.
    pub rule: String,
    /// `path`: repo-relative for `settings.local.json`, absolute for the personal one.
    pub path: String,
}

/// `ForeignHarnessReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignHarnessReport {
    /// `conflicts`.
    pub conflicts: Vec<ForeignConflict>,
    /// `permissions`.
    pub permissions: Vec<ForeignPermissionConflict>,
    /// `staleAcknowledged`: `acknowledged` entries matching no current conflict.
    pub stale_acknowledged: Vec<String>,
}

/// `readdirSync(dir)` names in byte order; empty when it throws, a non-UTF-8 name is
/// [`Unmodeled`].
fn safe_readdir(dir: &str) -> Result<Vec<String>, Unmodeled> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut names = Vec::new();
    for entry in read.filter_map(Result::ok) {
        names.push(entry.file_name().into_string().map_err(|_| Unmodeled)?);
    }
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(names)
}

/// `statSync(path).isDirectory()`, `false` where it throws.
fn is_dir(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// `existsSync(path)`.
fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// The file carries a navori managed block.
fn is_navoris(path: &str) -> Result<bool, Unmodeled> {
    if !exists(path) {
        return Ok(false);
    }
    Ok(read_text(path)?.is_some_and(|content| !list_markers(&content).is_empty()))
}

/// A name → file map in insertion order; a later `insert` of a known name replaces the value and
/// keeps the position, as a JS `Map` does.
type Named = Vec<(String, String)>;

fn insert(map: &mut Named, name: String, path: String) {
    match map.iter_mut().find(|(known, _)| *known == name) {
        Some(slot) => slot.1 = path,
        None => map.push((name, path)),
    }
}

fn lookup<'a>(map: &'a Named, name: &str) -> Option<&'a String> {
    map.iter().find(|(known, _)| known == name).map(|(_, p)| p)
}

/// `skillsIn(dir)`: skill name → file that declares it; flat files first, then directories, and
/// a directory wins its name.
fn skills_in(dir: &str) -> Result<Named, Unmodeled> {
    let mut dirs: Named = Vec::new();
    let mut flats: Named = Vec::new();
    for entry in safe_readdir(dir)? {
        let full = join_text(dir, &entry);
        if is_dir(&full) {
            let skill_md = join_text(&full, SKILL_DIR_ENTRY);
            if exists(&skill_md) {
                insert(&mut dirs, entry, skill_md);
            }
        } else if entry.ends_with(".md") && entry != SKILL_DIR_ENTRY {
            let name = entry[..entry.len() - ".md".len()].to_owned();
            insert(&mut flats, name, full);
        }
    }
    let mut merged = flats;
    for (name, path) in dirs {
        insert(&mut merged, name, path);
    }
    Ok(merged)
}

/// `agentsIn(dir)`: agent name → file.
fn agents_in(dir: &str) -> Result<Named, Unmodeled> {
    let mut found: Named = Vec::new();
    for entry in safe_readdir(dir)? {
        if let Some(name) = entry.strip_suffix(".md") {
            let path = join_text(dir, &entry);
            insert(&mut found, name.to_owned(), path);
        }
    }
    Ok(found)
}

/// `foreignPlugins(claudeDir)`: the `@skills-dir` plugins under `<claudeDir>/skills/`, minus
/// navori's own, sorted.
fn foreign_plugins(claude_dir: &str) -> Result<Vec<String>, Unmodeled> {
    let skills_dir = join_text(claude_dir, "skills");
    let mut plugins: Vec<String> = safe_readdir(&skills_dir)?
        .into_iter()
        .filter(|name| name != NAVORI_PLUGIN_DIR)
        .filter(|name| exists(&join_all(&skills_dir, &[name, PLUGIN_MANIFEST_REL])))
        .collect();
    js_sort(&mut plugins);
    Ok(plugins)
}

/// `gitIgnores(cwd, relPath)`: `false` outside a repo or where git cannot run.
fn git_ignores(host: &Host<'_>, cwd: &str, rel_path: &str) -> bool {
    host.runner
        .run(&Request {
            program: "git",
            args: &["check-ignore", "--quiet", "--", rel_path],
            cwd: Path::new(cwd),
            env: host.env,
            input: None,
            timeout: GIT_TIMEOUT,
        })
        .is_ok_and(|output| output.status.code() == Some(0))
}

fn conflict_id(kind: ForeignAssetType, scope: ForeignScope, name: &str) -> String {
    format!("{}:{}:{name}", kind.as_str(), scope.as_str())
}

/// navori's managed assets in this repo, by name (repo-relative paths).
struct Inventory {
    agents: Named,
    skills: Named,
}

/// `navoriInventory(cwd)`: the managed marker is the discriminant, never the file name.
fn navori_inventory(cwd: &str) -> Result<Inventory, Unmodeled> {
    let mut agents: Named = Vec::new();
    for (name, path) in agents_in(&join_all(cwd, &[".claude", "agents"]))? {
        if is_navoris(&path)? {
            let rel = format!(".claude/agents/{name}.md");
            insert(&mut agents, name, rel);
        }
    }
    let skills_dir = join_all(cwd, &[".claude", "skills"]);
    let mut skills: Named = Vec::new();
    for (name, path) in skills_in(&skills_dir)? {
        if !is_navoris(&path)? {
            continue;
        }
        // `path.slice(cwd.length + 1)`: `cwd` is normalized, so it is a plain prefix.
        let rel = path.strip_prefix(&format!("{cwd}/")).ok_or(Unmodeled)?;
        let rel = rel.to_owned();
        insert(&mut skills, name, rel);
    }
    Ok(Inventory { agents, skills })
}

/// `repoSkillCollisions(cwd, navori)`: a flat `<name>.md` next to navori's `<name>/SKILL.md`.
fn repo_skill_collisions(
    host: &Host<'_>,
    cwd: &str,
    navori: &Named,
) -> Result<Vec<ForeignConflict>, Unmodeled> {
    let mut out = Vec::new();
    let skills_dir = join_all(cwd, &[".claude", "skills"]);
    for (name, navori_path) in navori {
        let flat = join_text(&skills_dir, &format!("{name}.md"));
        let flat_rel = format!(".claude/skills/{name}.md");
        if !navori_path.ends_with(SKILL_DIR_ENTRY) || !exists(&flat) || is_navoris(&flat)? {
            continue;
        }
        out.push(ForeignConflict {
            id: conflict_id(ForeignAssetType::Skill, ForeignScope::Repo, name),
            asset_type: ForeignAssetType::Skill,
            scope: ForeignScope::Repo,
            name: name.clone(),
            foreign_path: flat_rel.clone(),
            navori_path: navori_path.clone(),
            winner: ConflictWinner::Undecided,
            gitignored: git_ignores(host, cwd, &flat_rel).then_some(true),
            adoptable: true,
            plugin_id: None,
        });
    }
    Ok(out)
}

/// `personalCollisions(claudeDir, navori)`: agents are won by navori, skills by the foreign one.
fn personal_collisions(
    claude_dir: &str,
    navori: &Inventory,
) -> Result<Vec<ForeignConflict>, Unmodeled> {
    let mut out = Vec::new();
    for (name, path) in agents_in(&join_text(claude_dir, "agents"))? {
        let Some(navori_path) = lookup(&navori.agents, &name) else {
            continue;
        };
        out.push(ForeignConflict {
            id: conflict_id(ForeignAssetType::Agent, ForeignScope::Personal, &name),
            asset_type: ForeignAssetType::Agent,
            scope: ForeignScope::Personal,
            name,
            foreign_path: path,
            navori_path: navori_path.clone(),
            winner: ConflictWinner::Navori,
            gitignored: None,
            adoptable: false,
            plugin_id: None,
        });
    }
    let skills_dir = join_text(claude_dir, "skills");
    for (name, path) in skills_in(&skills_dir)? {
        // A plugin directory is not a personal skill; its skills are namespaced.
        if exists(&join_all(&skills_dir, &[&name, PLUGIN_MANIFEST_REL])) {
            continue;
        }
        let Some(navori_path) = lookup(&navori.skills, &name) else {
            continue;
        };
        out.push(ForeignConflict {
            id: conflict_id(ForeignAssetType::Skill, ForeignScope::Personal, &name),
            asset_type: ForeignAssetType::Skill,
            scope: ForeignScope::Personal,
            name,
            foreign_path: path,
            navori_path: navori_path.clone(),
            winner: ConflictWinner::Foreign,
            gitignored: None,
            adoptable: false,
            plugin_id: None,
        });
    }
    Ok(out)
}

/// `pluginCollisions(claudeDir, navoriAgents)`: agents of somebody else's plugin that this repo
/// makes inert.
fn plugin_collisions(
    claude_dir: &str,
    navori_agents: &Named,
) -> Result<Vec<ForeignConflict>, Unmodeled> {
    let mut out = Vec::new();
    for plugin_id in foreign_plugins(claude_dir)? {
        let dir = join_all(claude_dir, &["skills", &plugin_id, "agents"]);
        for (name, path) in agents_in(&dir)? {
            let Some(navori_path) = lookup(navori_agents, &name) else {
                continue;
            };
            out.push(ForeignConflict {
                id: conflict_id(ForeignAssetType::Agent, ForeignScope::Plugin, &name),
                asset_type: ForeignAssetType::Agent,
                scope: ForeignScope::Plugin,
                name,
                foreign_path: path,
                navori_path: navori_path.clone(),
                winner: ConflictWinner::Navori,
                gitignored: None,
                adoptable: false,
                plugin_id: Some(plugin_id.clone()),
            });
        }
    }
    Ok(out)
}

/// `readSettingsFile(dir, fileName)`: the parsed object, `None` for absent, unreadable, unparsable
/// and non-object files alike (the caller ignores every kind but `ok`).
fn read_settings_object(dir: &str, file: &str) -> Result<Option<JsValue>, Unmodeled> {
    let path = join_text(dir, file);
    if !exists(&path) {
        return Ok(None);
    }
    let Some(text) = read_text(&path)? else {
        return Ok(None);
    };
    Ok(parse_json(&text)?.filter(|value| matches!(value, JsValue::Object(_))))
}

/// `permissionBagOf(settings)[kind]`: the string entries of `permissions[kind]`.
fn permission_list(settings: &JsValue, kind: &str) -> Result<Vec<String>, Unmodeled> {
    let Some(perms @ JsValue::Object(_)) = get(settings, "permissions") else {
        return Ok(Vec::new());
    };
    match get(perms, kind) {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(text) => Some(text.to_rust().ok_or(Unmodeled)),
                _ => None,
            })
            .collect(),
        _ => Ok(Vec::new()),
    }
}

/// `permissionContradictions(cwd, claudeDir)`: rules navori's `settings.json` denies that a
/// foreign settings file allows.
fn permission_contradictions(
    cwd: &str,
    claude_dir: &str,
) -> Result<Vec<ForeignPermissionConflict>, Unmodeled> {
    let repo_claude = join_all(cwd, &[".claude"]);
    let Some(repo) = read_settings_object(&repo_claude, "settings.json")? else {
        return Ok(Vec::new());
    };
    let denied = permission_list(&repo, "deny")?;
    if denied.is_empty() {
        return Ok(Vec::new());
    }
    let sources = [
        (
            repo_claude,
            "settings.local.json",
            ".claude/settings.local.json".to_owned(),
        ),
        (
            claude_dir.to_owned(),
            "settings.json",
            join_all(claude_dir, &["settings.json"]),
        ),
    ];
    let mut out = Vec::new();
    for (dir, file, label) in sources {
        let Some(settings) = read_settings_object(&dir, file)? else {
            continue;
        };
        for rule in permission_list(&settings, "allow")? {
            if denied.contains(&rule) {
                out.push(ForeignPermissionConflict {
                    rule,
                    path: label.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// `[...new Set(items)]`.
fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

/// `scanForeignHarness(cwd, config, { claudeDir })`: `Ok(None)` is the TS `null` (no Claude output
/// here, or no usable `HOME`). `cwd` must be the normalized absolute repo path.
///
/// # Errors
/// [`Unmodeled`] where the TS result depends on something the port does not model (see the module
/// docs), including an ordering by `localeCompare` outside printable ASCII.
pub fn scan_foreign_harness(
    host: &Host<'_>,
    cwd: &str,
    config: &Config,
    claude_dir: Option<&str>,
) -> Result<Option<ForeignHarnessReport>, Unmodeled> {
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    if !engines.iter().any(|engine| engine == "claude") {
        return Ok(None);
    }
    // `join` normalizes `cwd`, and the TS slices a path by `cwd.length`: only a normalized one
    // makes both agree.
    if cwd == "/" || !cwd.starts_with('/') || registry::resolve("/", cwd) != cwd {
        return Err(Unmodeled);
    }
    let claude_dir = match claude_dir {
        Some(dir) => dir.to_owned(),
        None => match claude_user_dir(host)? {
            Some(dir) => dir,
            None => return Ok(None),
        },
    };

    let navori = navori_inventory(cwd)?;
    let mut all = repo_skill_collisions(host, cwd, &navori.skills)?;
    all.extend(personal_collisions(&claude_dir, &navori)?);
    all.extend(plugin_collisions(&claude_dir, &navori.agents)?);
    if all.len() > 1 {
        if !default_locale_modeled(host.env)
            || all.iter().any(|c| compare_ascii(&c.id, "").is_none())
        {
            return Err(Unmodeled);
        }
        all.sort_by(|a, b| compare_ascii(&a.id, &b.id).unwrap_or(std::cmp::Ordering::Equal));
    }

    let project = get(&config.data, "project").and_then(|p| get(p, "foreignHarness"));
    let acknowledged = dedupe(texts(project.and_then(|f| get(f, "acknowledged")))?);
    let live: Vec<&str> = all.iter().map(|c| c.id.as_str()).collect();
    let mut stale: Vec<String> = acknowledged
        .iter()
        .filter(|id| !live.contains(&id.as_str()))
        .cloned()
        .collect();
    js_sort(&mut stale);
    let conflicts = all
        .into_iter()
        .filter(|c| !acknowledged.contains(&c.id))
        .collect();
    Ok(Some(ForeignHarnessReport {
        conflicts,
        permissions: permission_contradictions(cwd, &claude_dir)?,
        stale_acknowledged: stale,
    }))
}

// ---------------------------------------------------------------------------------------------
// Doctor scans that stay in the TS
// ---------------------------------------------------------------------------------------------

/// A `doctor` scan this slice does not port: the native `doctor` (5e5) delegates to the TS when
/// the config makes one of them apply, and runs natively otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TsOnlyScan {
    /// `scanOtelReceiver`, which applies when `config.audit?.mode === "always"`. It probes the
    /// local OpenTelemetry receiver (port 4318) over HTTP, asynchronously; not ported.
    OtelReceiver,
    /// `scanPiHealth`, which applies when `config.engines.includes("pi")`. It probes `pi --version`
    /// and resolves Pi's settings precedence (`PI_CODING_AGENT_DIR`); not ported.
    PiHealth,
    /// `scanOperationalTools`, which applies when `plugins.tgrep`, `plugins.codegraph` or
    /// `plugins.engram` is `enabled === true`. It runs the operational tools' own CLIs (status and
    /// indexes); not ported.
    OperationalTools,
    /// `scanCodegraphWiring`, which applies when `plugins.codegraph.enabled === true`. It classifies
    /// `codegraph status` and the agents' permissions; not ported.
    CodegraphWiring,
}

impl TsOnlyScan {
    /// The TS function that keeps running.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::OtelReceiver => "scanOtelReceiver",
            Self::PiHealth => "scanPiHealth",
            Self::OperationalTools => "scanOperationalTools",
            Self::CodegraphWiring => "scanCodegraphWiring",
        }
    }

    /// Why it is not ported.
    #[must_use]
    pub const fn reason(self) -> &'static str {
        match self {
            Self::OtelReceiver => {
                "probes the local OpenTelemetry receiver (port 4318) over HTTP, asynchronously; not ported"
            }
            Self::PiHealth => {
                "probes `pi --version` and resolves Pi's settings precedence (PI_CODING_AGENT_DIR); not ported"
            }
            Self::OperationalTools => {
                "runs the operational tools' own CLIs (status and indexes); not ported"
            }
            Self::CodegraphWiring => {
                "classifies `codegraph status` and the agents' permissions; not ported"
            }
        }
    }
}

/// `config.plugins?.<id>?.enabled === true`.
fn plugin_enabled(config: &Config, id: &str) -> bool {
    get(&config.data, "plugins")
        .and_then(|plugins| get(plugins, id))
        .and_then(|plugin| get(plugin, "enabled"))
        .is_some_and(|enabled| matches!(enabled, JsValue::Bool(true)))
}

/// The doctor scans that stay in the TS for this config, in the order `doctor` runs them. Empty
/// means every scan of this slice runs natively.
///
/// # Errors
/// [`Unmodeled`] when `engines` is not an array of strings.
pub fn doctor_ts_only_scans(config: &Config) -> Result<Vec<TsOnlyScan>, Unmodeled> {
    let mut scans = Vec::new();
    let always = get(&config.data, "audit")
        .and_then(|audit| get(audit, "mode"))
        .is_some_and(|mode| matches!(mode, JsValue::String(text) if text.is("always")));
    if always {
        scans.push(TsOnlyScan::OtelReceiver);
    }
    let codegraph = plugin_enabled(config, "codegraph");
    if ["tgrep", "codegraph", "engram"]
        .iter()
        .any(|id| plugin_enabled(config, id))
    {
        scans.push(TsOnlyScan::OperationalTools);
    }
    if codegraph {
        scans.push(TsOnlyScan::CodegraphWiring);
    }
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    if engines.iter().any(|engine| engine == "pi") {
        scans.push(TsOnlyScan::PiHealth);
    }
    Ok(scans)
}

#[cfg(test)]
mod tests {
    use super::{TsOnlyScan, doctor_ts_only_scans, parse_json};
    use crate::config::Config;
    use crate::js_json;
    use crate::workspace::patterns::Unmodeled;

    /// The scans that stay in the TS for `json`, as `doctor_ts_only_scans` answers.
    fn scans(json: &str) -> Result<Vec<TsOnlyScan>, Unmodeled> {
        let config = Config {
            data: js_json::parse(json).ok_or(Unmodeled)?,
            warnings: Vec::new(),
        };
        doctor_ts_only_scans(&config)
    }

    #[test]
    fn a_plain_config_keeps_every_scan_native() {
        assert_eq!(scans(r#"{"engines":["claude"]}"#), Ok(vec![]));
        assert_eq!(scans("{}"), Ok(vec![]));
    }

    #[test]
    fn audit_always_keeps_the_otel_receiver_in_the_ts() {
        assert_eq!(
            scans(r#"{"audit":{"mode":"always"}}"#),
            Ok(vec![TsOnlyScan::OtelReceiver])
        );
        for other in [
            r#"{"audit":{"mode":"opt-in"}}"#,
            r#"{"audit":{"mode":true}}"#,
            r#"{"audit":{}}"#,
            r#"{"audit":"always"}"#,
        ] {
            assert_eq!(scans(other), Ok(vec![]), "{other}");
        }
    }

    #[test]
    fn the_pi_engine_keeps_pi_health_in_the_ts() {
        assert_eq!(
            scans(r#"{"engines":["claude","pi"]}"#),
            Ok(vec![TsOnlyScan::PiHealth])
        );
        assert_eq!(scans(r#"{"engines":["claude","codex"]}"#), Ok(vec![]));
        assert_eq!(scans(r#"{"engines":"pi"}"#), Err(Unmodeled));
    }

    #[test]
    fn an_enabled_search_or_memory_tool_keeps_operational_tools_in_the_ts() {
        for id in ["tgrep", "engram"] {
            let json = format!(r#"{{"plugins":{{"{id}":{{"enabled":true}}}}}}"#);
            assert_eq!(scans(&json), Ok(vec![TsOnlyScan::OperationalTools]), "{id}");
        }
        assert_eq!(scans(r#"{"plugins":{"gh":{"enabled":true}}}"#), Ok(vec![]));
    }

    #[test]
    fn codegraph_keeps_both_its_scans_in_the_ts() {
        assert_eq!(
            scans(r#"{"plugins":{"codegraph":{"enabled":true}}}"#),
            Ok(vec![
                TsOnlyScan::OperationalTools,
                TsOnlyScan::CodegraphWiring
            ])
        );
    }

    #[test]
    fn only_a_boolean_true_enables_a_plugin() {
        for value in ["false", "\"true\"", "1", "null", "{}"] {
            let json = format!(r#"{{"plugins":{{"tgrep":{{"enabled":{value}}}}}}}"#);
            assert_eq!(scans(&json), Ok(vec![]), "{value}");
        }
        assert_eq!(scans(r#"{"plugins":{"tgrep":true}}"#), Ok(vec![]));
    }

    #[test]
    fn scans_come_out_in_doctor_order_with_a_reason_each() -> Result<(), Unmodeled> {
        let all = scans(
            r#"{"engines":["claude","pi"],"audit":{"mode":"always"},
                "plugins":{"codegraph":{"enabled":true}}}"#,
        )?;
        assert_eq!(
            all,
            [
                TsOnlyScan::OtelReceiver,
                TsOnlyScan::OperationalTools,
                TsOnlyScan::CodegraphWiring,
                TsOnlyScan::PiHealth
            ]
        );
        for scan in all {
            assert!(scan.name().starts_with("scan"));
            assert!(scan.reason().ends_with("not ported"));
        }
        Ok(())
    }

    #[test]
    fn json_the_model_cannot_carry_is_unmodeled_and_broken_json_is_none() {
        assert_eq!(parse_json("{"), Ok(None));
        assert_eq!(parse_json(""), Ok(None));
        assert_eq!(parse_json("\u{feff}{}"), Ok(None));
        assert!(matches!(parse_json(r#"{"a":1}"#), Ok(Some(_))));
        assert_eq!(parse_json(r#"{"a":"\ud800"}"#), Err(Unmodeled));
        assert_eq!(parse_json("1e999"), Err(Unmodeled));
        assert_eq!(parse_json(&"[".repeat(200)), Err(Unmodeled));
    }
}
