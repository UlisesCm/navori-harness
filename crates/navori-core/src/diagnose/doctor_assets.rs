//! `doctor`'s asset and render advisories (spec 0060 T23 slice 3b, R73, R76): warnings over the
//! rendered tree, the config and the repo's git state that never flip the health verdict.
//!
//! Each scan mirrors its TS twin's ordering, fields and edge cases. Where the TS result depends on
//! something this port does not model (enabled monorepo workspaces, an error message from zod,
//! V8's `JSON.parse` or the filesystem, text or names that are not UTF-8, `localeCompare` outside
//! printable ASCII or under a locale `collate` does not model), the scan returns [`Unmodeled`]
//! and the CLI delegates to the TS. Binary presence (`hasBinary`) is injected: slice 3c ports it.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::collate::{compare_ascii, default_locale_modeled};
use crate::config::Config;
use crate::diagnose::health::{collect_marker_files, configured_engines, list_markers, read_text};
use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsObject, JsValue};
use crate::markers::{
    CommentStyle, compute_managed_hash, extract_managed_content, locate_managed_blocks,
};
use crate::master::{index, state};
use crate::process::{Env, ProcessRunner, Request};
use crate::render::claude_md::has_monorepo_workspaces;
use crate::render::collect::DiskView;
use crate::render::context::Lang;
use crate::render::doc_budget::{CEILINGS, COMPUTED, count_words};
use crate::render::harness_plan::{ROSTER_AGENTS, is_agent_enabled};
use crate::render::ignore_files::{
    GITIGNORE_MANAGED_ID, PRETTIERIGNORE_MANAGED_ID, gitignore_body, plan_prettierignore,
};
use crate::render::interpolate::placeholder_fallback;
use crate::render::nested_gitignore::{EPHEMERAL_HARNESS_PATHS, NESTED_GITIGNORE_MANAGED_ID};
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

/// `a?.b ?? fallback` for a string-typed config field; any other type is [`Unmodeled`].
fn text_or(value: Option<&JsValue>, fallback: &str) -> Result<String, Unmodeled> {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(fallback.to_owned()),
        Some(JsValue::String(text)) => text.to_rust().ok_or(Unmodeled),
        Some(_) => Err(Unmodeled),
    }
}

/// An array of strings (`undefined`/`null` read as empty); anything else is [`Unmodeled`].
fn string_list(value: Option<&JsValue>) -> Result<Vec<String>, Unmodeled> {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(Vec::new()),
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

/// `config.engines`, as the doctor scans read it.
fn engines(config: &Config) -> Result<Vec<String>, Unmodeled> {
    configured_engines(&config.data).ok_or(Unmodeled)
}

/// JS `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Array `.sort()` with no comparator: UTF-16 code-unit order.
fn js_sort(items: &mut [String]) {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `items.sort((a, b) => key(a).localeCompare(key(b)))`; [`Unmodeled`] when the locale or a key
/// falls outside what [`compare_ascii`] reproduces.
fn locale_sort<T>(items: &mut [T], key: impl Fn(&T) -> &str, env: &Env) -> Result<(), Unmodeled> {
    if !default_locale_modeled(env) || items.iter().any(|i| compare_ascii(key(i), "").is_none()) {
        return Err(Unmodeled);
    }
    items.sort_by(|a, b| compare_ascii(key(a), key(b)).unwrap_or(std::cmp::Ordering::Equal));
    Ok(())
}

/// `readdirSync(dir)` names in libuv's byte order; `None` when it throws, a non-UTF-8 name is
/// [`Unmodeled`].
fn read_dir_names(dir: &Path) -> Result<Option<Vec<String>>, Unmodeled> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let mut names = Vec::new();
    for entry in read.filter_map(Result::ok) {
        names.push(entry.file_name().into_string().map_err(|_| Unmodeled)?);
    }
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(Some(names))
}

/// `readdirSync(dir, { withFileTypes: true })` filtered to `Dirent.isDirectory()` (a symlink is
/// not one); `None` when it throws.
fn read_dir_dirs(dir: &Path) -> Result<Option<Vec<String>>, Unmodeled> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let mut names = Vec::new();
    for entry in read.filter_map(Result::ok) {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            names.push(entry.file_name().into_string().map_err(|_| Unmodeled)?);
        }
    }
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(Some(names))
}

/// `statSync(path).isDirectory()`, following symlinks; `None` when it throws.
fn stat_is_dir(path: &Path) -> Option<bool> {
    std::fs::metadata(path).ok().map(|m| m.is_dir())
}

/// A path as text; a non-UTF-8 path is [`Unmodeled`].
fn path_text(path: &Path) -> Result<&str, Unmodeled> {
    path.to_str().ok_or(Unmodeled)
}

/// `JSON.parse(readFileSync(path, "utf-8"))` inside a `try` that swallows every throw:
/// `Ok(None)` when the TS lands in its `catch`. Text Rust cannot classify is [`Unmodeled`].
fn parse_json_file(path: &Path) -> Result<Option<JsValue>, Unmodeled> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    // A BOM and blank text are never valid JSON; anything else the parser declines is ambiguous
    // between "JS throws" and "JS accepts something not modelled".
    if text.starts_with('\u{feff}') || js_trim(&text).is_empty() {
        return Ok(None);
    }
    js_json::parse(&text).map(Some).ok_or(Unmodeled)
}

/// `Object.prototype`'s own property names: `key in {}` is true for each of them.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// ECMAScript `\s` as a regex class body.
const JS_WS: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// A regex compiled once; `None` only if the literal pattern were invalid.
fn lazy_regex(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

// ---------------------------------------------------------------------------------------------
// scanQualityGateReadiness (lib/config/gate-readiness.ts:111)
// ---------------------------------------------------------------------------------------------

/// `GateBlocker`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateBlocker {
    /// `missing-binary`.
    MissingBinary,
    /// `missing-script`.
    MissingScript,
    /// `missing-deps`.
    MissingDeps,
}

impl GateBlocker {
    /// The TS spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MissingBinary => "missing-binary",
            Self::MissingScript => "missing-script",
            Self::MissingDeps => "missing-deps",
        }
    }
}

/// `GateReadinessIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateReadinessIssue {
    /// `fast` or `full`.
    pub gate: &'static str,
    /// A binary name, a script name, or the deps' directory label.
    pub detail: String,
    /// What is missing.
    pub reason: GateBlocker,
}

/// `SHELL_BUILTINS`.
const SHELL_BUILTINS: [&str; 12] = [
    "cd", "echo", "export", "set", "source", ".", "true", "false", "exit", "eval", "unset", "read",
];

/// `PACKAGE_MANAGERS`.
const PACKAGE_MANAGERS: [&str; 4] = ["pnpm", "npm", "yarn", "bun"];

/// `command.split(/&&|\|\||;|\|/).map(trim).filter(non-empty)`.
fn gate_segments(command: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut at = 0;
    let bytes = command.as_bytes();
    while at < bytes.len() {
        let width = if bytes[at..].starts_with(b"&&") || bytes[at..].starts_with(b"||") {
            2
        } else if matches!(bytes[at], b';' | b'|') {
            1
        } else {
            0
        };
        if width == 0 {
            at += 1;
            continue;
        }
        out.push(&command[start..at]);
        at += width;
        start = at;
    }
    out.push(&command[start..]);
    out.into_iter()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// `/^[A-Za-z_][A-Za-z0-9_]*=/`.
fn is_env_assignment(word: &str) -> bool {
    let bytes = word.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || *first == b'_') {
        return false;
    }
    let name_len = bytes
        .iter()
        .skip(1)
        .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
        .count();
    bytes.get(1 + name_len) == Some(&b'=')
}

/// `commandWords`: whitespace-split words with `VAR=value` prefixes dropped.
fn command_words(segment: &str) -> Vec<&str> {
    let mut words: Vec<&str> = segment
        .split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .collect();
    let skip = words.iter().take_while(|w| is_env_assignment(w)).count();
    words.drain(..skip);
    words
}

/// `scriptOf`: the script of `pm <script>` / `pm run <script>`, else `None`.
fn script_of<'a>(words: &[&'a str]) -> Option<&'a str> {
    let args = words.get(1..).unwrap_or_default();
    if args.iter().any(|w| w.starts_with('-')) {
        return None;
    }
    let rest = if matches!(args.first(), Some(&("run" | "run-script"))) {
        &args[1..]
    } else {
        args
    };
    let [script] = rest else {
        return None;
    };
    (!matches!(*script, "install" | "i" | "exec")).then_some(*script)
}

/// `path.resolve(base, target)` for an absolute `base`.
fn js_resolve(base: &str, target: &str) -> String {
    let joined = if target.starts_with('/') {
        target.to_owned()
    } else {
        format!("{base}/{target}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `relativeTo(cwd, dir)`.
fn relative_to(cwd: &str, dir: &str) -> String {
    if dir == cwd {
        return ".".to_owned();
    }
    let prefix = if cwd.ends_with('/') {
        cwd.to_owned()
    } else {
        format!("{cwd}/")
    };
    dir.strip_prefix(&prefix).unwrap_or(dir).to_owned()
}

/// `readScripts(dir)`'s object, or `None` when the TS returns `null`.
enum Scripts {
    Object(JsObject),
    Empty,
}

impl Scripts {
    /// `script in scripts`.
    fn has(&self, script: &str) -> bool {
        OBJECT_PROTOTYPE_KEYS.contains(&script)
            || matches!(self, Self::Object(object) if object.has(script))
    }
}

/// `readScripts(dir)`.
fn read_scripts(dir: &Path) -> Result<Option<Scripts>, Unmodeled> {
    let path = dir.join("package.json");
    if !path.exists() {
        return Ok(None);
    }
    let Some(parsed) = parse_json_file(&path)? else {
        return Ok(None);
    };
    match parsed {
        JsValue::Array(_) => Ok(Some(Scripts::Empty)),
        JsValue::Object(object) => match object.get("scripts") {
            Some(JsValue::Object(scripts)) => Ok(Some(Scripts::Object(scripts.clone()))),
            // An array's `in` sees indices and `Array.prototype`; not modelled.
            Some(JsValue::Array(_)) => Err(Unmodeled),
            _ => Ok(Some(Scripts::Empty)),
        },
        _ => Ok(None),
    }
}

/// `config.qualityGate?.<gate>` when it names a command.
fn gate_command(config: &Config, gate: &str) -> Result<Option<String>, Unmodeled> {
    match get(&config.data, "qualityGate").and_then(|q| get(q, gate)) {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(None),
        Some(JsValue::String(text)) => {
            let text = text.to_rust().ok_or(Unmodeled)?;
            Ok((!text.is_empty()).then_some(text))
        }
        Some(_) => Err(Unmodeled),
    }
}

/// `scanQualityGateReadiness(cwd, config)`, static: whether each declared gate's binaries are on
/// PATH, its package-manager scripts exist and its deps are installed. `has_binary` is
/// `hasBinary` (`lib/primitives/which.ts`), injected.
///
/// # Errors
/// A non-UTF-8 or relative `cwd`, a non-string gate, or a `package.json` Rust cannot read as
/// `JSON.parse` would.
pub fn scan_quality_gate_readiness(
    cwd: &Path,
    config: &Config,
    has_binary: &dyn Fn(&str) -> bool,
) -> Result<Vec<GateReadinessIssue>, Unmodeled> {
    let cwd_text = path_text(cwd)?;
    if !cwd_text.starts_with('/') {
        return Err(Unmodeled);
    }
    let mut out: Vec<GateReadinessIssue> = Vec::new();
    let mut push = |issue: GateReadinessIssue| {
        if !out
            .iter()
            .any(|seen| seen.reason == issue.reason && seen.detail == issue.detail)
        {
            out.push(issue);
        }
    };
    for gate in ["fast", "full"] {
        let Some(command) = gate_command(config, gate)? else {
            continue;
        };
        let mut dir = cwd_text.to_owned();
        for segment in gate_segments(&command) {
            let words = command_words(segment);
            let Some(&bin) = words.first() else {
                continue;
            };
            if bin == "cd" {
                if let Some(target) = words.get(1).filter(|t| !t.starts_with('-')) {
                    dir = js_resolve(&dir, target);
                }
                continue;
            }
            if SHELL_BUILTINS.contains(&bin) {
                continue;
            }
            if !has_binary(bin) {
                push(GateReadinessIssue {
                    gate,
                    detail: bin.to_owned(),
                    reason: GateBlocker::MissingBinary,
                });
                continue;
            }
            if !PACKAGE_MANAGERS.contains(&bin) {
                continue;
            }
            let Some(scripts) = read_scripts(Path::new(&dir))? else {
                continue;
            };
            if !Path::new(&dir).join("node_modules").exists() {
                push(GateReadinessIssue {
                    gate,
                    detail: relative_to(cwd_text, &dir),
                    reason: GateBlocker::MissingDeps,
                });
                continue;
            }
            if let Some(script) = script_of(&words).filter(|s| !scripts.has(s)) {
                push(GateReadinessIssue {
                    gate,
                    detail: script.to_owned(),
                    reason: GateBlocker::MissingScript,
                });
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanEmptyUserSections (lib/assets/skill-user-section.ts:76)
// ---------------------------------------------------------------------------------------------

/// `EmptyUserSection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmptyUserSection {
    /// Skill id.
    pub id: String,
    /// Repo-relative path of the rendered skill.
    pub path: String,
}

/// The skill roots `doctor` passes: `.claude/skills`, plus `.agents/skills` with Codex.
///
/// # Errors
/// `engines` that is not an array of strings.
pub fn doctor_skill_dirs(config: &Config) -> Result<Vec<&'static str>, Unmodeled> {
    let mut dirs = vec![".claude/skills"];
    if engines(config)?.iter().any(|e| e == "codex") {
        dirs.push(".agents/skills");
    }
    Ok(dirs)
}

/// `userHalf`: everything after the line of the last managed close marker.
fn user_half(content: &str) -> Option<&str> {
    let close = content.rfind("<!-- /navori:managed")?;
    Some(
        content[close..]
            .find('\n')
            .map_or("", |eol| &content[close + eol + 1..]),
    )
}

/// `text.replace(/<!--[\s\S]*?-->/g, "")`.
fn strip_html_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("<!--") {
        let Some(close) = rest[open + 4..].find("-->") else {
            break;
        };
        out.push_str(&rest[..open]);
        rest = &rest[open + 4 + close + 3..];
    }
    out.push_str(rest);
    out
}

/// `isUntouched`: only headings and comments.
fn is_untouched(half: &str) -> bool {
    strip_html_comments(half).split('\n').all(|line| {
        let t = js_trim(line);
        t.is_empty() || t.starts_with('#')
    })
}

/// `skillFiles(dir)`: `(id, repo-relative file suffix)` in readdir order.
fn skill_files(dir: &Path) -> Result<Vec<(String, String)>, Unmodeled> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    // `readdirSync` is outside the TS `try`: a non-directory crashes `doctor`.
    let names = read_dir_names(dir)?.ok_or(Unmodeled)?;
    let mut out = Vec::new();
    for entry in names {
        match stat_is_dir(&dir.join(&entry)) {
            None => {}
            Some(true) => {
                if dir.join(&entry).join("SKILL.md").exists() {
                    out.push((entry.clone(), format!("{entry}/SKILL.md")));
                }
            }
            Some(false) => {
                if let Some(id) = entry.strip_suffix(".md") {
                    out.push((id.to_owned(), entry.clone()));
                }
            }
        }
    }
    Ok(out)
}

/// `scanEmptyUserSections(cwd, skillsDirs)`: installed skills whose user half is still the
/// rendered template, sorted by id.
///
/// # Errors
/// A skills root that is not a directory, a non-UTF-8 name or file, or an id `localeCompare`
/// is not modelled for.
pub fn scan_empty_user_sections(
    cwd: &Path,
    skills_dirs: &[&str],
    env: &Env,
) -> Result<Vec<EmptyUserSection>, Unmodeled> {
    let mut out = Vec::new();
    for rel in skills_dirs {
        let root = cwd.join(rel);
        for (id, suffix) in skill_files(&root)? {
            let Some(content) = read_text(&root.join(&suffix))? else {
                continue;
            };
            let Some(half) = user_half(&content) else {
                continue;
            };
            if js_trim(half).is_empty() {
                continue;
            }
            if is_untouched(half) {
                out.push(EmptyUserSection {
                    id,
                    path: format!("{rel}/{suffix}"),
                });
            }
        }
    }
    locale_sort(&mut out, |s| s.id.as_str(), env)?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanTriggerlessLocalSkills (lib/assets/skill-triggers.ts:69)
// ---------------------------------------------------------------------------------------------

/// `TriggerlessSkill`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerlessSkill {
    /// Skill id, as declared in `project.localSkills`.
    pub id: String,
    /// Repo-relative path of the skill file.
    pub path: String,
}

/// `TRIGGER_RE` = `/\b(aplica|us[aá]r?|use\s+(when|this)|para cuando|cuando|antes de)\b/i`.
/// JS `\b` without the `u` flag is an ASCII word boundary, and `i` folds only within ASCII (plus
/// `á`/`Á`), so the letters are spelled out instead of using Rust's Unicode `(?i)`.
static TRIGGER: LazyLock<Option<Regex>> = LazyLock::new(|| {
    lazy_regex(&format!(
        "(?-u:\\b)(?:[aA][pP][lL][iI][cC][aA]|[uU][sS][aAáÁ][rR]?|[uU][sS][eE][{JS_WS}]+(?:[wW][hH][eE][nN]|[tT][hH][iI][sS])|[pP][aA][rR][aA] [cC][uU][aA][nN][dD][oO]|[cC][uU][aA][nN][dD][oO]|[aA][nN][tT][eE][sS] [dD][eE])(?-u:\\b)"
    ))
});

/// `hasTrigger(description)`.
fn has_trigger(description: Option<&str>) -> Result<bool, Unmodeled> {
    let re = TRIGGER.as_ref().ok_or(Unmodeled)?;
    Ok(description.is_some_and(|d| re.is_match(d)))
}

/// `resolveLocalSkillPath(cwd, id)`: the directory form only, flat slugs only.
fn resolve_local_skill_path(cwd: &Path, id: &str) -> Option<String> {
    if id.is_empty() || id != js_trim(id) || id.contains(['/', '\\']) || id.contains("..") {
        return None;
    }
    let rel = format!(".claude/skills/{id}/SKILL.md");
    cwd.join(&rel).exists().then_some(rel)
}

/// `scanTriggerlessLocalSkills(cwd, config.project?.localSkills ?? [])`: project-local skills
/// whose `description` declares no activation trigger, sorted by id.
///
/// # Errors
/// A non-string id, a non-UTF-8 file, or an id `localeCompare` is not modelled for.
pub fn scan_triggerless_local_skills(
    cwd: &Path,
    config: &Config,
    env: &Env,
) -> Result<Vec<TriggerlessSkill>, Unmodeled> {
    let ids = string_list(get(&config.data, "project").and_then(|p| get(p, "localSkills")))?;
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for id in &ids {
        if seen.contains(&id.as_str()) {
            continue;
        }
        seen.push(id);
        let Some(rel) = resolve_local_skill_path(cwd, id) else {
            continue;
        };
        let Some(raw) = read_text(&cwd.join(&rel))? else {
            continue;
        };
        if raw.contains("<!-- navori:managed") {
            continue;
        }
        let split = crate::render::frontmatter::split_frontmatter(&raw);
        let description =
            crate::render::frontmatter::get_frontmatter_field(split.frontmatter, "description");
        if has_trigger(description.as_deref())? {
            continue;
        }
        out.push(TriggerlessSkill {
            id: id.clone(),
            path: rel,
        });
    }
    locale_sort(&mut out, |s| s.id.as_str(), env)?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanInterpolationArtifacts (lib/render/interpolation-artifacts.ts:117)
// ---------------------------------------------------------------------------------------------

/// Rows `doctor` prints before collapsing into "… and N more" (`doctor.ts:150`).
pub const MAX_ARTIFACT_ROWS: usize = 10;

/// `ArtifactReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactReason {
    /// `unresolved-placeholder`: the hard fallback reached the prose.
    UnresolvedPlaceholder,
    /// `unconfigured-gate`: the `qualityGate.*` soft fallback reached the prose.
    UnconfiguredGate,
}

/// `InterpolationArtifact`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterpolationArtifact {
    /// Repo-relative path of the rendered file.
    pub path: String,
    /// 1-based line number.
    pub line: usize,
    /// The exact text found.
    pub token: String,
    /// Which fallback produced it.
    pub reason: ArtifactReason,
}

/// `PROBE_PATH`.
const PROBE_PATH: &str = "navoriDoctorProbePath";

/// `DIAGNOSTIC_SOFT_PATHS`.
const DIAGNOSTIC_SOFT_PATHS: [&str; 2] = ["qualityGate.fast", "qualityGate.full"];

/// `hardFallbackMatcher()`, derived from [`placeholder_fallback`] in the default language.
fn hard_fallback_matcher() -> Option<Regex> {
    let sample = placeholder_fallback(PROBE_PATH, Lang::Es);
    let at = sample.find(PROBE_PATH).filter(|at| *at > 0)?;
    let (prefix, suffix) = (&sample[..at], &sample[at + PROBE_PATH.len()..]);
    if suffix.is_empty() {
        return None;
    }
    Regex::new(&format!(
        "{}[^\\n]*?{}",
        regex::escape(prefix),
        regex::escape(suffix)
    ))
    .ok()
}

/// `diagnosticSoftTokens(hard)`: every locale's soft gate fallback the hard matcher misses.
fn diagnostic_soft_tokens(hard: Option<&Regex>) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for lang in [Lang::Es, Lang::En] {
        for path in DIAGNOSTIC_SOFT_PATHS {
            let text = placeholder_fallback(path, lang);
            if hard.is_some_and(|re| re.is_match(&text)) || tokens.contains(&text) {
                continue;
            }
            tokens.push(text);
        }
    }
    tokens
}

/// `scanInterpolationArtifacts(cwd, config)`: interpolation fallbacks published anywhere in the
/// rendered tree of the configured engines, in file and line order.
///
/// # Errors
/// `engines` that is not an array of strings, or a non-UTF-8 file or name.
pub fn scan_interpolation_artifacts(
    cwd: &Path,
    config: &Config,
) -> Result<Vec<InterpolationArtifact>, Unmodeled> {
    let hard = hard_fallback_matcher();
    let soft = diagnostic_soft_tokens(hard.as_ref());
    if hard.is_none() && soft.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<InterpolationArtifact> = Vec::new();
    let mut push = |artifact: InterpolationArtifact| {
        if !out.iter().any(|seen| {
            seen.path == artifact.path && seen.line == artifact.line && seen.token == artifact.token
        }) {
            out.push(artifact);
        }
    };
    for (path, _) in collect_marker_files(cwd, &engines(config)?)? {
        let Some(content) = read_text(&cwd.join(&path))? else {
            continue;
        };
        for (i, text) in content.split('\n').enumerate() {
            if let Some(re) = &hard {
                for found in re.find_iter(text) {
                    push(InterpolationArtifact {
                        path: path.clone(),
                        line: i + 1,
                        token: found.as_str().to_owned(),
                        reason: ArtifactReason::UnresolvedPlaceholder,
                    });
                }
            }
            for token in &soft {
                if text.contains(token.as_str()) {
                    push(InterpolationArtifact {
                        path: path.clone(),
                        line: i + 1,
                        token: token.clone(),
                        reason: ArtifactReason::UnconfiguredGate,
                    });
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanMissingModelProfile (lib/assets/model-profile.ts:577)
// ---------------------------------------------------------------------------------------------

/// `MissingTier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingTier {
    /// `model`.
    Model,
    /// `effort`.
    Effort,
}

/// `MissingModelProfile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingModelProfile {
    /// Core agent id.
    pub agent: &'static str,
    /// Its `harness`/`models`/`effort` key.
    pub harness_key: &'static str,
    /// The unset tiers, `model` first.
    pub missing: Vec<MissingTier>,
}

/// `scanMissingModelProfile(config)`: enabled core agents with no `models`/`effort` tier, only
/// when a disk engine (claude, codex) is configured.
///
/// # Errors
/// `engines` that is not an array of strings.
pub fn scan_missing_model_profile(config: &Config) -> Result<Vec<MissingModelProfile>, Unmodeled> {
    if !engines(config)?
        .iter()
        .any(|e| e == "claude" || e == "codex")
    {
        return Ok(Vec::new());
    }
    let data = &config.data;
    let mut out = Vec::new();
    for agent in &ROSTER_AGENTS {
        if !is_agent_enabled(data, agent.harness_key) {
            continue;
        }
        let mut missing = Vec::new();
        if !truthy(get(data, "models").and_then(|m| get(m, agent.harness_key))) {
            missing.push(MissingTier::Model);
        }
        if !truthy(get(data, "effort").and_then(|m| get(m, agent.harness_key))) {
            missing.push(MissingTier::Effort);
        }
        if !missing.is_empty() {
            out.push(MissingModelProfile {
                agent: agent.id,
                harness_key: agent.harness_key,
                missing,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanControlGaps (lib/diagnose/control-gaps.ts:48)
// ---------------------------------------------------------------------------------------------

/// A control's declared state where it is not `enforced`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlState {
    /// `advisory`.
    Advisory,
    /// `unsupported`.
    Unsupported,
}

/// `ControlGap`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlGap {
    /// Configured engine.
    pub engine: String,
    /// Control id.
    pub control: &'static str,
    /// Its state there.
    pub state: ControlState,
    /// The declaration's reason.
    pub reason: &'static str,
    /// `warn` (a condition the user turned on) or `info`.
    pub warn: bool,
}

/// `CONTROL_DEFINITIONS` in declaration order, with each one's condition flag.
const CONTROL_DEFINITIONS: [(&str, Option<&str>); 11] = [
    ("plan-gate", Some("planTiers")),
    ("master-plan", Some("masterPlan")),
    ("markdown-ownership", Some("scribeOwnsMarkdown")),
    ("handoff-shape", None),
    ("handoff-consumer", None),
    ("analytic-write-tools", None),
    ("local-skill-discovery", Some("localSkills")),
    ("acceptance-evidence", None),
    ("repeat-failure-advice", None),
    ("compact-advice", None),
    ("general-purpose-confirm", None),
];

use ControlState::{Advisory, Unsupported};

/// `ENGINE_CAPABILITIES.claude.controls`, the non-`enforced` rows
/// (`engines/shared/engine-capabilities.ts`); a control absent here is `enforced`.
const CLAUDE_GAPS: &[(&str, ControlState, &str)] = &[
    (
        "handoff-shape",
        Advisory,
        "The PostToolUse(Agent|Task) hook is registered unconditionally, but it never blocks (spec 0033 D3): advisory by design.",
    ),
    (
        "handoff-consumer",
        Advisory,
        "Orchestration prose calls `navori handoff check` before scribe/reviewer consume an existing impl handoff; no hook enforces it.",
    ),
    (
        "analytic-write-tools",
        Advisory,
        "The `tools:` frontmatter and prose instructions declare the role's scope; nothing blocks a Bash write outside them.",
    ),
    (
        "acceptance-evidence",
        Advisory,
        "`plan update` requires recorded evidence inside a Claude Code child session (CLAUDE_CODE_CHILD_SESSION=1); an agent can still bypass it (spec 0039 D5). The recording hook ships separately.",
    ),
    (
        "repeat-failure-advice",
        Advisory,
        "PostToolUseFailure(Bash) injects advice after three identical failures.",
    ),
    (
        "compact-advice",
        Advisory,
        "subagent-stop-handoff.sh adds a once-per-session note after a publisher dispatch when the main thread's last transcript usage passes harness.compactAdviceTokens (spec 0039 R44); it advises, never blocks.",
    ),
];

/// `ENGINE_CAPABILITIES.codex.controls`, the non-`enforced` rows.
const CODEX_GAPS: &[(&str, ControlState, &str)] = &[
    (
        "master-plan",
        Advisory,
        "harness.masterPlan registers the SessionStart hook in .codex/config.toml and the skills reach .agents/skills; the context is advisory and the live smoke that would make it enforced is spec 0041 T20.",
    ),
    (
        "plan-gate",
        Advisory,
        "harness.planTiers registers PreToolUse(spawn_agent$) as the last late row; the gate denies a nonconforming implementer dispatch, with the role from tool_input.agent_type and, when the message is encrypted (probe V2), the opening line from the orchestrator's dispatch_<feature>.json (spec 0041 R9). Implementers are dispatched one at a time per session (two or more fresh dispatch files of the same session deny; other sessions' are ignored) and every analysis spawn names a listed role (spec 0052 R41). This unversioned render declaration is advisory; codexControlCapability reports S4 enforcement only for its verified version and surface.",
    ),
    (
        "handoff-shape",
        Advisory,
        "The contract is stated in prose (scribe.md, via AGENTS.md); .codex/config.toml registers no matching hook.",
    ),
    (
        "handoff-consumer",
        Advisory,
        "Orchestration prose calls `navori handoff check` before scribe/reviewer consume an existing impl handoff; no hook enforces it.",
    ),
    (
        "analytic-write-tools",
        Advisory,
        "`sandbox_mode = \"danger-full-access\"` plus prose instructions; no filesystem/network sandbox restricts writes, so the role boundary is advisory.",
    ),
    (
        "acceptance-evidence",
        Advisory,
        "A lane inside routing-watch reads the exit code from the rollout item_completed record (probe V4, spec 0050), so `plan update` can record evidence; without that record `cumplido` stays unevidenced. No per-version verification exists for this lane, so codexControlCapability reports it as unknown (spec 0052 R41).",
    ),
    (
        "repeat-failure-advice",
        Advisory,
        "A lane inside routing-watch reads the exit code of the call from the rollout item_completed record (probe V4, spec 0041 R11) and gives the same advice after three identical failures; silent when the record is missing.",
    ),
    (
        "compact-advice",
        Unsupported,
        "Codex SubagentStop has no PostToolUse context channel and its transcript is not the Claude usage format, so the lane is Claude-only (spec 0039 R44).",
    ),
    (
        "general-purpose-confirm",
        Advisory,
        "PreToolUse(spawn_agent$) denies a general-purpose spawn as a confirmation, since Codex hooks cannot emit `ask` (spec 0041 R10). This unversioned render declaration is advisory; codexControlCapability reports S9 enforcement only for its verified version and surface.",
    ),
];

/// `ENGINE_CAPABILITIES.pi.controls`, the non-`enforced` rows.
const PI_GAPS: &[(&str, ControlState, &str)] = &[
    (
        "master-plan",
        Advisory,
        "When harness.masterPlan is on, Pi before_agent_start appends a bounded status line; this is context, not a permission boundary.",
    ),
    (
        "analytic-write-tools",
        Advisory,
        "Pi role tool allowlists are model-visible capabilities, not OS/filesystem/network sandboxes; scout and reviewer retain write.",
    ),
    (
        "repeat-failure-advice",
        Advisory,
        "The Pi extension's tool_result handler counts identical built-in bash failures (structuredContent.exit_code, Pi 1.1.0+) in memory and appends one advisory after three; it never blocks, never alters the result and is silent on any error or when exit_code is absent.",
    ),
    (
        "compact-advice",
        Unsupported,
        "No Pi binding runs compact-advice, so no context-size advice is injected after a publisher dispatch.",
    ),
    (
        "general-purpose-confirm",
        Unsupported,
        "Pi's `navori_subagent` roster has seven fixed roles and no general-purpose role to confirm.",
    ),
];

/// The prose engines' (`agents-md`, `cursor`, `copilot`) shared table: every control unsupported.
const PROSE_GAPS: &[(&str, ControlState, &str)] = &[
    (
        "master-plan",
        Unsupported,
        "fase 2 de la spec 0034: la skill no se renderiza y no hay hook de arranque",
    ),
    (
        "plan-gate",
        Unsupported,
        "Prose engines render no Task/Agent tool to intercept a subagent dispatch (unsupportedSurfaces: subagent-orchestration).",
    ),
    (
        "markdown-ownership",
        Unsupported,
        "Prose engines render no hooks at all (unsupportedSurfaces: defensive-hooks).",
    ),
    (
        "handoff-shape",
        Unsupported,
        "Prose engines render no hooks at all (unsupportedSurfaces: defensive-hooks).",
    ),
    (
        "handoff-consumer",
        Unsupported,
        "No orchestrator or scribe agent is rendered to invoke `navori handoff check` (unsupportedSurfaces: subagent-orchestration).",
    ),
    (
        "analytic-write-tools",
        Unsupported,
        "No agents are rendered at all for these engines.",
    ),
    (
        "local-skill-discovery",
        Unsupported,
        "buildSkillsSection (prose-harness.ts) never passes project.localSkills to buildSkillRows, so the id never reaches the rendered file.",
    ),
    (
        "acceptance-evidence",
        Unsupported,
        "Prose engines render no hooks, so no Bash run is ever recorded as evidence.",
    ),
    (
        "repeat-failure-advice",
        Unsupported,
        "Prose engines render no Bash failure hooks.",
    ),
    (
        "compact-advice",
        Unsupported,
        "Prose engines render no hooks, so no context-size advice is ever injected.",
    ),
    (
        "general-purpose-confirm",
        Unsupported,
        "Prose engines render no hooks (unsupportedSurfaces: defensive-hooks).",
    ),
];

/// `ENGINE_CAPABILITIES[engine].controls`' non-`enforced` rows; `None` for an unknown engine.
fn engine_gaps(engine: &str) -> Option<&'static [(&'static str, ControlState, &'static str)]> {
    match engine {
        "claude" => Some(CLAUDE_GAPS),
        "codex" => Some(CODEX_GAPS),
        "pi" => Some(PI_GAPS),
        "agents-md" | "cursor" | "copilot" => Some(PROSE_GAPS),
        _ => None,
    }
}

/// `isConditionActive(config, condition)`.
fn condition_active(config: &JsValue, condition: &str) -> bool {
    if condition == "localSkills" {
        return matches!(
            get(config, "project").and_then(|p| get(p, "localSkills")),
            Some(JsValue::Array(items)) if !items.is_empty()
        );
    }
    matches!(
        get(config, "harness").and_then(|h| get(h, condition)),
        Some(JsValue::Bool(true))
    )
}

/// `scanControlGaps(config)`: per configured engine, every control not `enforced` there,
/// skipping a conditioned control whose flag is off.
///
/// # Errors
/// `engines` that is not an array of strings, or an engine `ENGINE_CAPABILITIES` lacks.
pub fn scan_control_gaps(config: &Config) -> Result<Vec<ControlGap>, Unmodeled> {
    let mut gaps = Vec::new();
    for engine in engines(config)? {
        let table = engine_gaps(&engine).ok_or(Unmodeled)?;
        for (control, condition) in CONTROL_DEFINITIONS {
            if condition.is_some_and(|c| !condition_active(&config.data, c)) {
                continue;
            }
            let Some((_, state, reason)) = table.iter().find(|(id, _, _)| *id == control) else {
                continue;
            };
            gaps.push(ControlGap {
                engine: engine.clone(),
                control,
                state: *state,
                reason,
                warn: condition.is_some(),
            });
        }
    }
    Ok(gaps)
}

// ---------------------------------------------------------------------------------------------
// scanProgressSize (lib/diagnose/progress-size.ts:33)
// ---------------------------------------------------------------------------------------------

/// `PROGRESS_CURRENT_PATH`.
pub const PROGRESS_CURRENT_PATH: &str = "progress/current.md";

/// `DEFAULT_PROGRESS_THRESHOLD_BYTES` (`PROGRESS_SOFT_CAP_BYTES`).
pub const DEFAULT_PROGRESS_THRESHOLD_BYTES: usize = SESSION_CONTEXT_DELIVERY_BUDGET_CHARS / 2;

/// `ProgressSizeIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressSizeIssue {
    /// Repo-relative path.
    pub path: &'static str,
    /// Size in bytes.
    pub bytes: usize,
    /// The cap it exceeds.
    pub threshold_bytes: usize,
}

/// `scanProgressSize(cwd, thresholdBytes)`: the session-state file when it exceeds the cap.
#[must_use]
pub fn scan_progress_size(cwd: &Path, threshold_bytes: usize) -> Option<ProgressSizeIssue> {
    let bytes = std::fs::read(cwd.join(PROGRESS_CURRENT_PATH)).ok()?.len();
    (bytes > threshold_bytes).then_some(ProgressSizeIssue {
        path: PROGRESS_CURRENT_PATH,
        bytes,
        threshold_bytes,
    })
}

// ---------------------------------------------------------------------------------------------
// scanMasterPlan (lib/diagnose/master-plan.ts:27)
// ---------------------------------------------------------------------------------------------

/// The repair a master-plan diagnostic names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterRepair {
    /// `init`.
    Init,
    /// `checkout`.
    Checkout,
    /// `close`.
    Close,
}

/// `MasterPlanDiagnostic`. `invalid-index` always carries a TS error message, so the scan
/// returns [`Unmodeled`] instead of producing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MasterPlanDiagnostic {
    /// `missing-raw-gitignore`: `init` for the active stage, `checkout` for a closed one.
    MissingRawGitignore {
        /// Repo-relative path.
        path: String,
        /// The repair.
        repair: MasterRepair,
    },
    /// `flag-registry-desync`: `close` or `init`.
    FlagRegistryDesync {
        /// The repair.
        repair: MasterRepair,
    },
    /// `invalid-state`.
    InvalidState {
        /// The message.
        detail: String,
    },
    /// `deliveries-pending`.
    DeliveriesPending {
        /// The message.
        detail: String,
    },
}

/// `specsDir` as repo-relative segments; an absolute or `..` path is [`Unmodeled`].
fn plain_relative(dir: &str) -> Result<Vec<&str>, Unmodeled> {
    if dir.starts_with('/') || dir.contains('\\') {
        return Err(Unmodeled);
    }
    let parts: Vec<&str> = dir
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.contains(&"..") {
        return Err(Unmodeled);
    }
    Ok(parts)
}

/// `scanMasterPlan(cwd, config)`: recoverable master-plan inconsistencies.
///
/// # Errors
/// Everything whose TS output is an error message (an invalid index, `state.json` or
/// `parts.json`), a `deliveries` stage with a `state.json` or `parts.json` to validate, and a
/// `specsDir` outside the repo.
pub fn scan_master_plan(
    cwd: &Path,
    config: &Config,
) -> Result<Vec<MasterPlanDiagnostic>, Unmodeled> {
    let specs_dir = text_or(
        get(&config.data, "sdd").and_then(|s| get(s, "specsDir")),
        "specs",
    )?;
    let mut rel_parts = plain_relative(&specs_dir)?;
    rel_parts.push(index::MASTER_DIR_NAME);
    let master_rel = rel_parts.join("/");
    let master_dir = cwd.join(&master_rel);
    if !master_dir.join("index.json").exists() {
        return Ok(Vec::new());
    }
    let Some(registry) = index::read(&master_dir).map_err(|_| Unmodeled)? else {
        return Ok(Vec::new());
    };
    let mut issues = Vec::new();
    let active = registry.active();
    if let Some(stage) = active {
        let dir = &stage.dir;
        let state_path = master_dir.join(dir).join("state.json");
        if !state_path.exists() {
            issues.push(MasterPlanDiagnostic::InvalidState {
                detail: format!("{dir}: state.json missing; run master init to resume"),
            });
        } else if stage.deliveries {
            // `DeliveryStateSchema` is not modelled.
            return Err(Unmodeled);
        } else {
            let text = read_text(&state_path)?.ok_or(Unmodeled)?;
            let raw = js_json::parse(&text).ok_or(Unmodeled)?;
            state::master_state(&raw).map_err(|_| Unmodeled)?;
        }
        if stage.deliveries {
            if master_dir.join(dir).join("parts.json").exists() {
                // `checkDeliveryPreparation` is not modelled.
                return Err(Unmodeled);
            }
            issues.push(MasterPlanDiagnostic::DeliveriesPending {
                detail: format!(
                    "{dir}: parts.json missing; write it, then run navori master delivery-check"
                ),
            });
        }
    }
    for stage in &registry.stages {
        let rel = format!("{master_rel}/{}/context/raw/.gitignore", stage.dir);
        if !cwd.join(&rel).exists() {
            issues.push(MasterPlanDiagnostic::MissingRawGitignore {
                path: rel,
                repair: if stage.state == index::StageState::Active {
                    MasterRepair::Init
                } else {
                    MasterRepair::Checkout
                },
            });
        }
    }
    let enabled = truthy(get(&config.data, "harness").and_then(|h| get(h, "masterPlan")));
    if enabled && active.is_none() {
        issues.push(MasterPlanDiagnostic::FlagRegistryDesync {
            repair: MasterRepair::Close,
        });
    }
    if !enabled && active.is_some() {
        issues.push(MasterPlanDiagnostic::FlagRegistryDesync {
            repair: MasterRepair::Init,
        });
    }
    Ok(issues)
}

// ---------------------------------------------------------------------------------------------
// scanNestedWorktrees (lib/workspace/nested-worktrees.ts:62)
// ---------------------------------------------------------------------------------------------

/// `NestedWorktreeConflict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NestedWorktreeConflict {
    /// The eslint config a nested run also resolves (or `package.json#eslintConfig`).
    pub eslint_config: String,
    /// Nested worktrees carrying their own `node_modules`, sorted.
    pub worktrees: Vec<String>,
}

/// `WORKTREES_DIR`.
const WORKTREES_DIR: &str = ".claude/worktrees";

static ESLINT_CONFIG: LazyLock<Option<Regex>> = LazyLock::new(|| {
    lazy_regex(r"^(?:\.eslintrc(?:\.(?:[cm]?js|json|ya?ml))?|eslint\.config\.[cm]?[jt]s)$")
});

/// `scanNestedWorktrees(cwd)`: installed nested worktrees next to a repo eslint config.
///
/// # Errors
/// A non-UTF-8 name, or a `package.json` Rust cannot read as `JSON.parse` would.
pub fn scan_nested_worktrees(cwd: &Path) -> Result<Option<NestedWorktreeConflict>, Unmodeled> {
    let root = cwd.join(WORKTREES_DIR);
    let mut worktrees: Vec<String> = read_dir_dirs(&root)?
        .unwrap_or_default()
        .into_iter()
        .filter(|name| root.join(name).join("node_modules").exists())
        .map(|name| format!("{WORKTREES_DIR}/{name}"))
        .collect();
    js_sort(&mut worktrees);
    if worktrees.is_empty() {
        return Ok(None);
    }
    let re = ESLINT_CONFIG.as_ref().ok_or(Unmodeled)?;
    let Some(names) = read_dir_names(cwd)? else {
        return Ok(None);
    };
    let mut matches: Vec<String> = names.into_iter().filter(|n| re.is_match(n)).collect();
    js_sort(&mut matches);
    let eslint_config = if let Some(first) = matches.into_iter().next() {
        first
    } else {
        let has_key = matches!(
            parse_json_file(&cwd.join("package.json"))?,
            Some(JsValue::Object(pkg)) if pkg.has("eslintConfig")
        );
        if !has_key {
            return Ok(None);
        }
        "package.json#eslintConfig".to_owned()
    };
    Ok(Some(NestedWorktreeConflict {
        eslint_config,
        worktrees,
    }))
}

// ---------------------------------------------------------------------------------------------
// scanStaleHarness (lib/diagnose/stale-harness.ts:157)
// ---------------------------------------------------------------------------------------------

/// `StaleHarness`. Only `undeclared-workspace` is produced natively: the trimmed-workspace
/// leftovers need enabled monorepo workspaces, which are [`Unmodeled`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleHarness {
    /// Repo-relative path of the frozen directory.
    pub path: String,
    /// Oldest navori version stamped inside.
    pub frozen_at: Option<String>,
    /// How many files sit there.
    pub files: usize,
}

/// `MAX_DEPTH`.
const STALE_MAX_DEPTH: usize = 3;

/// `SKIP_DIRS`.
const SKIP_DIRS: [&str; 8] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    "vendor",
];

static VERSION_STAMP: LazyLock<Option<Regex>> =
    LazyLock::new(|| lazy_regex(r#"navori:managed[^\n]*version="([0-9]+\.[0-9]+\.[0-9]+)""#));

/// `EPHEMERAL_INSIDE_CLAUDE`: the ephemeral paths under `.claude/`, prefix and slash dropped.
fn ephemeral_inside_claude(entry: &str) -> bool {
    EPHEMERAL_HARNESS_PATHS.iter().any(|p| {
        p.strip_prefix(".claude/")
            .is_some_and(|rest| rest.strip_suffix('/').unwrap_or(rest) == entry)
    })
}

/// `older(a, b)`: the lower of two `x.y.z` stamps, `a` on a tie.
fn older(a: Option<String>, b: &str) -> String {
    let Some(a) = a else {
        return b.to_owned();
    };
    let parts = |v: &str| -> Vec<f64> { v.split('.').map(|p| p.parse().unwrap_or(0.0)).collect() };
    let (pa, pb) = (parts(&a), parts(b));
    for i in 0..3 {
        let (x, y) = (
            pa.get(i).copied().unwrap_or(0.0),
            pb.get(i).copied().unwrap_or(0.0),
        );
        if x != y {
            return if x < y { a } else { b.to_owned() };
        }
    }
    a
}

/// `surveyDir(dir, depth)`: files below it and the oldest stamp among them.
fn survey_dir(dir: &Path, depth: usize) -> Result<(usize, Option<String>), Unmodeled> {
    let mut files = 0;
    let mut frozen_at: Option<String> = None;
    if depth > STALE_MAX_DEPTH + 2 {
        return Ok((files, frozen_at));
    }
    let Some(entries) = read_dir_names(dir)? else {
        return Ok((files, frozen_at));
    };
    let re = VERSION_STAMP.as_ref().ok_or(Unmodeled)?;
    for entry in entries {
        if depth == 0 && ephemeral_inside_claude(&entry) {
            continue;
        }
        let full = dir.join(&entry);
        let Some(is_dir) = stat_is_dir(&full) else {
            continue;
        };
        if is_dir {
            let (sub_files, sub_frozen) = survey_dir(&full, depth + 1)?;
            files += sub_files;
            if let Some(stamp) = sub_frozen {
                frozen_at = Some(older(frozen_at, &stamp));
            }
            continue;
        }
        files += 1;
        // The TS decodes with replacement characters; the stamp is ASCII on one line, so a lossy
        // decode finds the same capture.
        if let Ok(bytes) = std::fs::read(&full) {
            let text = String::from_utf8_lossy(&bytes);
            if let Some(stamp) = re.captures(&text).and_then(|c| c.get(1)) {
                frozen_at = Some(older(frozen_at, stamp.as_str()));
            }
        }
    }
    Ok((files, frozen_at))
}

/// `findNestedClaudeDirs`: repo-relative `.claude` directories below the root, depth-first.
fn find_nested_claude_dirs(
    cwd: &Path,
    rel: &str,
    depth: usize,
    out: &mut Vec<String>,
) -> Result<(), Unmodeled> {
    if depth > STALE_MAX_DEPTH {
        return Ok(());
    }
    let dir = if rel.is_empty() {
        cwd.to_path_buf()
    } else {
        cwd.join(rel)
    };
    let Some(names) = read_dir_dirs(&dir)? else {
        return Ok(());
    };
    for name in names
        .into_iter()
        .filter(|n| !SKIP_DIRS.contains(&n.as_str()))
    {
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if name == ".claude" {
            if child != ".claude" {
                out.push(child);
            }
            continue;
        }
        find_nested_claude_dirs(cwd, &child, depth + 1, out)?;
    }
    Ok(())
}

/// `scanStaleHarness(cwd, config)`: `.claude/` directories below the root no render reaches,
/// sorted by path.
///
/// # Errors
/// Enabled monorepo workspaces, a non-UTF-8 name, or a path `localeCompare` is not modelled for.
pub fn scan_stale_harness(
    cwd: &Path,
    config: &Config,
    env: &Env,
) -> Result<Vec<StaleHarness>, Unmodeled> {
    let monorepo = get(&config.data, "monorepo");
    if truthy(monorepo) && !truthy(monorepo.and_then(|m| get(m, "enabled"))) {
        return Ok(Vec::new());
    }
    if has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    let mut nested = Vec::new();
    find_nested_claude_dirs(cwd, "", 0, &mut nested)?;
    let mut out = Vec::new();
    for path in nested {
        let (files, frozen_at) = survey_dir(&cwd.join(&path), 0)?;
        if files == 0 {
            continue;
        }
        out.push(StaleHarness {
            path,
            frozen_at,
            files,
        });
    }
    locale_sort(&mut out, |h| h.path.as_str(), env)?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// scanWorkspaceFullHarness (commands/doctor.ts:4000)
// ---------------------------------------------------------------------------------------------

/// `scanWorkspaceFullHarness(config)`: always `None` natively.
///
/// # Errors
/// `workspaceHarness: "full"` with enabled workspaces (their paths are not modelled).
pub fn scan_workspace_full_harness(config: &Config) -> Result<Option<Vec<String>>, Unmodeled> {
    let mode = get(&config.data, "monorepo").and_then(|m| get(m, "workspaceHarness"));
    let full = matches!(mode, Some(JsValue::String(s)) if s.is("full"));
    if full && has_monorepo_workspaces(&config.data) {
        return Err(Unmodeled);
    }
    Ok(None)
}

// ---------------------------------------------------------------------------------------------
// scanFlatSkills (lib/assets/flat-skills.ts:83)
// ---------------------------------------------------------------------------------------------

/// `FlatSkill`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatSkill {
    /// Display path (repo-relative, or `~/…`).
    pub path: String,
    /// The id it was probably meant to have.
    pub id: String,
    /// Where it should live instead.
    pub suggested: String,
}

/// `flatSkillsIn(dir, display)`.
fn flat_skills_in(dir: &Path, display: &str) -> Result<Vec<FlatSkill>, Unmodeled> {
    let mut out = Vec::new();
    for entry in read_dir_names(dir)?.unwrap_or_default() {
        let Some(id) = entry.strip_suffix(".md") else {
            continue;
        };
        if entry == "README.md" || stat_is_dir(&dir.join(&entry)).is_none_or(|d| d) {
            continue;
        }
        out.push(FlatSkill {
            path: format!("{display}/{entry}"),
            id: id.to_owned(),
            suggested: format!("{display}/{id}/SKILL.md"),
        });
    }
    Ok(out)
}

/// `scanFlatSkills(cwd)` with `home` = `safeHomedir()`: loose `<id>.md` files in a skills root
/// the host never loads, sorted by path.
///
/// # Errors
/// A non-UTF-8 name, or a path `localeCompare` is not modelled for.
pub fn scan_flat_skills(cwd: &Path, home: &Path, env: &Env) -> Result<Vec<FlatSkill>, Unmodeled> {
    let roots = [
        (cwd.join(".claude/skills"), ".claude/skills"),
        (home.join(".claude/skills"), "~/.claude/skills"),
    ];
    let mut found = Vec::new();
    for (dir, display) in &roots {
        if dir.exists() {
            found.extend(flat_skills_in(dir, display)?);
        }
    }
    locale_sort(&mut found, |s| s.path.as_str(), env)?;
    Ok(found)
}

// ---------------------------------------------------------------------------------------------
// scanForeignSkillIndexes (lib/assets/foreign-skill-index.ts:74)
// ---------------------------------------------------------------------------------------------

/// `ForeignSkillIndex`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignSkillIndex {
    /// Repo-relative path.
    pub path: &'static str,
    /// The harness that wrote it.
    pub producer: &'static str,
    /// How many skill paths it declares.
    pub indexed: usize,
    /// The self-declared refresh date.
    pub frozen_at: Option<String>,
}

static INDEX_PATH: LazyLock<Option<Regex>> = LazyLock::new(|| lazy_regex(r"`(/[^`\n]+SKILL\.md)`"));

static INDEX_DATE: LazyLock<Option<Regex>> =
    LazyLock::new(|| lazy_regex(&format!("Last updated:[{JS_WS}]*([^{JS_WS}]+)")));

/// `scanForeignSkillIndexes(cwd)`: a known foreign skill index whose every path is gone.
///
/// # Errors
/// A non-UTF-8 index.
pub fn scan_foreign_skill_indexes(cwd: &Path) -> Result<Vec<ForeignSkillIndex>, Unmodeled> {
    const KNOWN: [(&str, &str); 1] = [(".atl/skill-registry.md", "gentle-ai (Agent Teams Lite)")];
    let (path_re, date_re) = (
        INDEX_PATH.as_ref().ok_or(Unmodeled)?,
        INDEX_DATE.as_ref().ok_or(Unmodeled)?,
    );
    let mut found = Vec::new();
    for (rel, producer) in KNOWN {
        let abs = cwd.join(rel);
        if !abs.exists() {
            continue;
        }
        let Some(text) = read_text(&abs)? else {
            continue;
        };
        let paths: Vec<&str> = path_re
            .captures_iter(&text)
            .filter_map(|c| c.get(1).map(|m| js_trim(m.as_str())))
            .filter(|p| !p.is_empty())
            .collect();
        if paths.is_empty() || paths.iter().any(|p| Path::new(p).exists()) {
            continue;
        }
        found.push(ForeignSkillIndex {
            path: rel,
            producer,
            indexed: paths.len(),
            frozen_at: date_re
                .captures(&text)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_owned()),
        });
    }
    Ok(found)
}

// ---------------------------------------------------------------------------------------------
// scanDocBudget (commands/doctor.ts:3822)
// ---------------------------------------------------------------------------------------------

/// `SESSION_CONTEXT_DELIVERY_BUDGET_CHARS`.
pub const SESSION_CONTEXT_DELIVERY_BUDGET_CHARS: usize = 8000;

/// `CODEX_PROJECT_DOC_MAX_BYTES`.
pub const CODEX_PROJECT_DOC_MAX_BYTES: usize = 32768;

/// `ManagedBlockMeasure['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    /// The source asset's ceiling.
    Static,
    /// The `base + k·rows` formula.
    Computed,
    /// No ceiling shipped for this id.
    Unbudgeted,
}

/// `DocBudgetLever`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocBudgetLever {
    /// `project-context`.
    ProjectContext,
    /// `preset`.
    Preset,
    /// `plugins`.
    Plugins,
    /// `core`.
    Core,
}

/// `DocBudgetBlock`: a `ManagedBlockMeasure` plus its lever.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBudgetBlock {
    /// Block id.
    pub id: String,
    /// Words, markers included.
    pub words: usize,
    /// Top-level `- …` rows.
    pub rows: usize,
    /// Its ceiling, `None` when unbudgeted.
    pub ceiling: Option<usize>,
    /// Where the ceiling comes from.
    pub kind: BlockKind,
    /// `words > ceiling`.
    pub over: bool,
    /// The knob that shrinks it.
    pub lever: DocBudgetLever,
}

/// `DocBudgetMeasure` (`lib/diagnose/health.ts:213`), blocks without their lever.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Measure {
    total_words: usize,
    managed_words: usize,
    own_words: i64,
    unbudgeted_words: usize,
    ceiling: usize,
    over_by: usize,
    blocks: Vec<(String, usize, usize, Option<usize>, BlockKind)>,
}

/// `measureDocBudget(content)` with every block; an id that is an `Object.prototype` key would
/// read a function off the ceiling tables, so it is [`Unmodeled`].
fn measure(content: &str) -> Result<Measure, Unmodeled> {
    let mut blocks = Vec::new();
    let (mut managed, mut unbudgeted, mut ceiling, mut top_level_end) = (0, 0, 0, 0);
    for located in locate_managed_blocks(content, CommentStyle::Html) {
        if located.open_start < top_level_end {
            continue;
        }
        top_level_end = located.close_end;
        if OBJECT_PROTOTYPE_KEYS.contains(&located.id.as_str()) {
            return Err(Unmodeled);
        }
        let body = content
            .get(located.open_start..located.close_end)
            .ok_or(Unmodeled)?;
        let words = count_words(body);
        let rows = body.split('\n').filter(|l| l.starts_with("- ")).count();
        let static_ceiling = CEILINGS
            .iter()
            .find(|(id, _)| *id == located.id)
            .map(|(_, c)| *c);
        let computed = COMPUTED
            .iter()
            .find(|(id, _, _)| *id == located.id)
            .map(|(_, base, per_row)| base + per_row * rows);
        let block_ceiling = static_ceiling.or(computed);
        managed += words;
        match block_ceiling {
            None => unbudgeted += words,
            Some(c) => ceiling += c,
        }
        let kind = if static_ceiling.is_some() {
            BlockKind::Static
        } else if computed.is_some() {
            BlockKind::Computed
        } else {
            BlockKind::Unbudgeted
        };
        blocks.push((located.id, words, rows, block_ceiling, kind));
    }
    let total_words = count_words(content);
    Ok(Measure {
        total_words,
        managed_words: managed,
        own_words: i64::try_from(total_words).map_err(|_| Unmodeled)?
            - i64::try_from(managed).map_err(|_| Unmodeled)?,
        unbudgeted_words: unbudgeted,
        ceiling,
        over_by: managed.saturating_sub(unbudgeted).saturating_sub(ceiling),
        blocks,
    })
}

/// `readFileOrEmpty(path)`: `""` when absent or unreadable.
fn read_or_empty(path: &Path) -> Result<String, Unmodeled> {
    if !path.exists() {
        return Ok(String::new());
    }
    Ok(read_text(path)?.unwrap_or_default())
}

/// `DocBudgetFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBudgetFile {
    /// Repo-relative path.
    pub path: String,
    /// Words.
    pub words: usize,
    /// Bytes for a whole surface, UTF-16 units for a context file (as the TS measures each).
    pub chars: usize,
}

/// `ContextDeliveryStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextDelivery {
    /// `inline`.
    Inline,
    /// `pointer`.
    Pointer,
}

/// `DocBudgetContextFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBudgetContextFile {
    /// The measured file.
    pub file: DocBudgetFile,
    /// The hook's delivery verdict.
    pub delivered: ContextDelivery,
    /// Characters queued ahead of it.
    pub ctx_chars_before: usize,
}

/// `DocBudgetMcpServer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBudgetMcpServer {
    /// Server id.
    pub id: String,
    /// `alwaysLoad === true`.
    pub always_load: bool,
}

/// `DocBudgetReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBudgetReport {
    /// `CLAUDE.md` words; `None` without the file (as every `CLAUDE.md` field below).
    pub total_words: Option<usize>,
    /// Words inside managed blocks.
    pub managed_words: Option<usize>,
    /// The user's own prose.
    pub own_words: Option<i64>,
    /// Words in blocks without a ceiling.
    pub unbudgeted_words: Option<usize>,
    /// Σ of the carried blocks' ceilings.
    pub ceiling: Option<usize>,
    /// Excess over the ceiling.
    pub over_by: Option<usize>,
    /// `CLAUDE.md`'s blocks.
    pub blocks: Vec<DocBudgetBlock>,
    /// `readCliVersion()`.
    pub cli_version: String,
    /// `.claude/context/*.md`, in delivery order.
    pub context_files: Vec<DocBudgetContextFile>,
    /// Σ of their words.
    pub context_words: usize,
    /// Σ of their characters.
    pub context_chars: usize,
    /// [`SESSION_CONTEXT_DELIVERY_BUDGET_CHARS`].
    pub context_delivery_budget: usize,
    /// `AGENTS.md`.
    pub agents_md: Option<DocBudgetFile>,
    /// [`CODEX_PROJECT_DOC_MAX_BYTES`].
    pub agents_md_max_bytes: usize,
    /// `AGENTS.md`'s ceiling.
    pub agents_md_ceiling: Option<usize>,
    /// `AGENTS.md`'s excess.
    pub agents_md_over_by: Option<usize>,
    /// `.cursor/rules/navori.mdc`.
    pub cursor_rules: Option<DocBudgetFile>,
    /// `.github/copilot-instructions.md`.
    pub copilot_instructions: Option<DocBudgetFile>,
    /// `CLAUDE.md`'s words when Claude is configured.
    pub per_subagent_words: Option<usize>,
    /// `.mcp.json`'s servers.
    pub mcp_servers: Vec<DocBudgetMcpServer>,
}

/// `leverFor(id, source)`.
fn lever_for(id: &str, source: Option<&str>) -> DocBudgetLever {
    if id == "contexto-proyecto" {
        DocBudgetLever::ProjectContext
    } else if id.starts_with("stack-") {
        DocBudgetLever::Preset
    } else if source.is_some_and(|s| s.starts_with("@navori/plugin-")) {
        DocBudgetLever::Plugins
    } else {
        DocBudgetLever::Core
    }
}

/// `readWholeSurface(cwd, rel)`: words and UTF-8 bytes.
fn read_whole_surface(cwd: &Path, rel: &str) -> Result<Option<DocBudgetFile>, Unmodeled> {
    let abs = cwd.join(rel);
    if !abs.exists() {
        return Ok(None);
    }
    Ok(read_text(&abs)?.map(|content| DocBudgetFile {
        path: rel.to_owned(),
        words: count_words(&content),
        chars: content.len(),
    }))
}

/// `contextPointerChars(path, bodyChars)`: the hook's pointer line, in UTF-16 units.
fn context_pointer_chars(path: &str, body_chars: usize) -> usize {
    format!("[navori] '{path}' no cabe en el contexto de arranque ({body_chars} caracteres). LÉELO con Read antes de decidir cómo abordar la tarea: contiene doctrina que ninguna otra vía te entrega.")
        .encode_utf16()
        .count()
}

/// `readContextSurface(cwd)` with `simulateContextDelivery`.
fn read_context_surface(cwd: &Path) -> Result<Vec<DocBudgetContextFile>, Unmodeled> {
    let dir = cwd.join(".claude/context");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let Some(names) = read_dir_names(&dir)? else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = names.into_iter().filter(|n| n.ends_with(".md")).collect();
    js_sort(&mut names);
    let mut files = Vec::new();
    for name in names {
        // Any read that throws empties the whole surface (one `try` around the map).
        let Some(content) = read_text(&dir.join(&name))? else {
            return Ok(Vec::new());
        };
        files.push(DocBudgetFile {
            path: format!(".claude/context/{name}"),
            words: count_words(&content),
            chars: content.encode_utf16().count(),
        });
    }
    let mut ctx = 0;
    Ok(files
        .into_iter()
        .map(|file| {
            ctx += 1;
            let before = ctx;
            let delivered = if ctx + file.chars <= SESSION_CONTEXT_DELIVERY_BUDGET_CHARS {
                ctx += file.chars + 1;
                ContextDelivery::Inline
            } else {
                ctx += context_pointer_chars(&file.path, file.chars) + 1;
                ContextDelivery::Pointer
            };
            DocBudgetContextFile {
                file,
                delivered,
                ctx_chars_before: before,
            }
        })
        .collect())
}

/// `readMcpServers(cwd)`: `.mcp.json`'s `mcpServers` entries that are plain objects.
fn read_mcp_servers(cwd: &Path) -> Result<Vec<DocBudgetMcpServer>, Unmodeled> {
    let path = cwd.join(".mcp.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let Some(JsValue::Object(parsed)) = parse_json_file(&path)? else {
        return Ok(Vec::new());
    };
    let Some(JsValue::Object(servers)) = parsed.get("mcpServers") else {
        return Ok(Vec::new());
    };
    servers
        .ordered()
        .into_iter()
        .filter_map(|(id, entry)| match entry {
            JsValue::Object(entry) => Some((id, entry)),
            _ => None,
        })
        .map(|(id, entry)| {
            Ok(DocBudgetMcpServer {
                id: id.to_rust().ok_or(Unmodeled)?,
                always_load: matches!(entry.get("alwaysLoad"), Some(JsValue::Bool(true))),
            })
        })
        .collect()
}

/// `scanDocBudget(cwd, config)`: the repo's startup surface priced against the shipped ceilings;
/// `None` when it has none. `cli_version` is `readCliVersion()`.
///
/// # Errors
/// `engines` that is not an array of strings, a non-UTF-8 file or name, a `.mcp.json` Rust
/// cannot read as `JSON.parse` would, or a block id that is an `Object.prototype` key.
pub fn scan_doc_budget(
    cwd: &Path,
    config: &Config,
    cli_version: &str,
) -> Result<Option<DocBudgetReport>, Unmodeled> {
    let claude_md = cwd.join("CLAUDE.md");
    let has_claude_md = claude_md.exists();
    let context_files = read_context_surface(cwd)?;
    let has_prose_surface = [
        "AGENTS.md",
        ".cursor/rules/navori.mdc",
        ".github/copilot-instructions.md",
    ]
    .iter()
    .any(|rel| cwd.join(rel).exists());
    if !has_claude_md && context_files.is_empty() && !has_prose_surface {
        return Ok(None);
    }
    let agents_md = read_whole_surface(cwd, "AGENTS.md")?;
    let cursor_rules = read_whole_surface(cwd, ".cursor/rules/navori.mdc")?;
    let copilot_instructions = read_whole_surface(cwd, ".github/copilot-instructions.md")?;
    let agents_measure = if agents_md.is_some() {
        Some(measure(&read_or_empty(&cwd.join("AGENTS.md"))?)?)
    } else {
        None
    };
    let (claude_measure, markers) = if has_claude_md {
        let content = read_or_empty(&claude_md)?;
        (Some(measure(&content)?), list_markers(&content))
    } else {
        (None, Vec::new())
    };
    // `new Map(markers.map(m => [m.id, m.source]))`: the last marker of an id wins.
    let source_of = |id: &str| {
        markers
            .iter()
            .rev()
            .find(|m| m.id == id)
            .and_then(|m| m.source.as_deref())
    };
    let blocks = claude_measure.as_ref().map_or_else(Vec::new, |m| {
        m.blocks
            .iter()
            .map(|(id, words, rows, ceiling, kind)| DocBudgetBlock {
                id: id.clone(),
                words: *words,
                rows: *rows,
                ceiling: *ceiling,
                kind: *kind,
                over: ceiling.is_some_and(|c| *words > c),
                lever: lever_for(id, source_of(id)),
            })
            .collect()
    });
    let has_claude_engine = engines(config)?.iter().any(|e| e == "claude");
    Ok(Some(DocBudgetReport {
        total_words: claude_measure.as_ref().map(|m| m.total_words),
        managed_words: claude_measure.as_ref().map(|m| m.managed_words),
        own_words: claude_measure.as_ref().map(|m| m.own_words),
        unbudgeted_words: claude_measure.as_ref().map(|m| m.unbudgeted_words),
        ceiling: claude_measure.as_ref().map(|m| m.ceiling),
        over_by: claude_measure.as_ref().map(|m| m.over_by),
        blocks,
        cli_version: cli_version.to_owned(),
        context_words: context_files.iter().map(|f| f.file.words).sum(),
        context_chars: context_files.iter().map(|f| f.file.chars).sum(),
        context_files,
        context_delivery_budget: SESSION_CONTEXT_DELIVERY_BUDGET_CHARS,
        agents_md,
        agents_md_max_bytes: CODEX_PROJECT_DOC_MAX_BYTES,
        agents_md_ceiling: agents_measure.as_ref().map(|m| m.ceiling),
        agents_md_over_by: agents_measure.as_ref().map(|m| m.over_by),
        cursor_rules,
        copilot_instructions,
        per_subagent_words: if has_claude_engine {
            claude_measure.as_ref().map(|m| m.total_words)
        } else {
            None
        },
        mcp_servers: read_mcp_servers(cwd)?,
    }))
}

// ---------------------------------------------------------------------------------------------
// scanGitignoreHarness / scanPrettierIgnore (engines/shared/{gitignore,prettierignore}-harness.ts)
// ---------------------------------------------------------------------------------------------

/// `GitignoreHealth` / `PrettierIgnoreHealth`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IgnoreHealth {
    /// No managed block (and, for prettier, the user's rules don't cover the harness).
    pub missing: bool,
    /// The block's body differs from the config-derived entries.
    pub drift: bool,
}

/// `{ missing, drift }` of a managed block against `body`.
fn block_health(content: &str, id: &str, body: &str) -> IgnoreHealth {
    match extract_managed_content(content, id, CommentStyle::Shell) {
        None => IgnoreHealth {
            missing: true,
            drift: false,
        },
        Some(current) => IgnoreHealth {
            missing: false,
            drift: compute_managed_hash(&current) != compute_managed_hash(body),
        },
    }
}

/// `scanGitignoreHarness(cwd, config)`: `None` in mode `off`.
///
/// # Errors
/// A `.gitignore` that exists but is unreadable (the TS throws) or not UTF-8.
pub fn scan_gitignore_harness(
    cwd: &Path,
    config: &Config,
) -> Result<Option<IgnoreHealth>, Unmodeled> {
    let Some(body) = gitignore_body(&config.data) else {
        return Ok(None);
    };
    let path = cwd.join(".gitignore");
    if !path.exists() {
        return Ok(Some(IgnoreHealth {
            missing: true,
            drift: false,
        }));
    }
    let content = read_text(&path)?.ok_or(Unmodeled)?;
    Ok(Some(block_health(&content, GITIGNORE_MANAGED_ID, &body)))
}

/// `scanPrettierIgnore(cwd, config)`: `None` when the repo does not run prettier or no engine
/// owns a path. The entries come from `plan_prettierignore`, the render's own preview.
///
/// # Errors
/// A `package.json` or `.prettierignore` Rust cannot read as the TS does.
pub fn scan_prettier_ignore(
    cwd: &Path,
    config: &Config,
) -> Result<Option<IgnoreHealth>, Unmodeled> {
    let Some(plan) = plan_prettierignore(&DiskView(cwd), &config.data, false, Lang::Es, None)
        .map_err(|_| Unmodeled)?
    else {
        return Ok(None);
    };
    if plan.entries.is_empty() {
        return Ok(Some(IgnoreHealth {
            missing: false,
            drift: false,
        }));
    }
    let path = cwd.join(".prettierignore");
    let existing = if path.exists() {
        read_text(&path)?.ok_or(Unmodeled)?
    } else {
        String::new()
    };
    Ok(Some(block_health(
        &existing,
        PRETTIERIGNORE_MANAGED_ID,
        &plan.entries.join("\n"),
    )))
}

// ---------------------------------------------------------------------------------------------
// scanGitHygiene (commands/doctor.ts:3464)
// ---------------------------------------------------------------------------------------------

/// `GitHygieneReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHygieneReport {
    /// The specs dir, when gitignored while the `sdd` block is active.
    pub specs_ignored: Option<String>,
    /// Ephemeral agent paths on disk that git does not ignore.
    pub ephemeral_not_ignored: Vec<&'static str>,
    /// Ephemeral agent paths git still tracks.
    pub ephemeral_tracked: Vec<&'static str>,
    /// Presets hidden by an ignore rule.
    pub presets_ignored: bool,
    /// An edited nested block no longer names the state directory.
    pub nested_state_unprotected: bool,
}

/// `execFileSync`'s default `maxBuffer`.
const MAX_BUFFER: usize = 1024 * 1024;

/// `git -C <cwd> …` as `execFileSync` runs it for `scanGitHygiene`.
struct Git<'a> {
    cwd: &'a Path,
    cwd_text: &'a str,
    runner: &'a dyn ProcessRunner,
    env: &'a Env,
}

impl Git<'_> {
    /// Exit 0 and stdout, `None` when it failed or did not start.
    fn run(&self, args: &[&str]) -> Option<Vec<u8>> {
        let mut argv = vec!["-C", self.cwd_text];
        argv.extend_from_slice(args);
        let request = Request {
            program: "git",
            args: &argv,
            cwd: self.cwd,
            env: self.env,
            input: None,
            // `execFileSync` without a timeout; the bound only guards a hung child.
            timeout: Duration::from_secs(60 * 60),
        };
        let output = self.runner.run(&request).ok()?;
        if output.status.code() != Some(0) {
            return None;
        }
        // Past `maxBuffer` Node kills the child and throws, which every caller's `catch` reads as
        // a failure.
        (output.stdout.len() <= MAX_BUFFER).then_some(output.stdout)
    }

    /// `stdout.trim()` of the `utf-8` decode, `None` on failure.
    fn trimmed(&self, args: &[&str]) -> Option<String> {
        self.run(args)
            .map(|bytes| js_trim(&String::from_utf8_lossy(&bytes)).to_owned())
    }

    /// `isIgnoredByGit`: `check-ignore -q --no-index` exits 0.
    fn ignored(&self, rel: &str) -> bool {
        self.run(&["check-ignore", "-q", "--no-index", rel])
            .is_some()
    }

    /// `gitTracksPath`: `ls-files -- <rel>` prints something.
    fn tracks(&self, rel: &str) -> bool {
        self.trimmed(&["ls-files", "--", rel])
            .is_some_and(|t| !t.is_empty())
    }
}

/// `trimSlash`.
fn trim_slash(path: &str) -> &str {
    path.strip_suffix('/').unwrap_or(path)
}

/// `scanGitHygiene(cwd, config)`: `None` outside a git work tree.
///
/// # Errors
/// A non-UTF-8 `cwd`, a non-string `specsDir` or
/// `blocks.exclude`, or a `.navori/.gitignore` the TS cannot read.
pub fn scan_git_hygiene(
    cwd: &Path,
    config: &Config,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<Option<GitHygieneReport>, Unmodeled> {
    let git = Git {
        cwd,
        cwd_text: path_text(cwd)?,
        runner,
        env,
    };
    if git
        .trimmed(&["rev-parse", "--is-inside-work-tree"])
        .as_deref()
        != Some("true")
    {
        return Ok(None);
    }
    let data = &config.data;
    let sdd = get(data, "sdd");
    let sdd_enabled = !matches!(
        sdd.and_then(|s| get(s, "enabled")),
        Some(JsValue::Bool(false))
    );
    let excluded = string_list(get(data, "blocks").and_then(|b| get(b, "exclude")))?;
    let sdd_active = sdd_enabled && !excluded.iter().any(|id| id == "sdd");
    let specs_dir = text_or(sdd.and_then(|s| get(s, "specsDir")), "specs")?;
    let specs_ignored = if sdd_active && git.ignored(&format!("{}/x", trim_slash(&specs_dir))) {
        Some(specs_dir)
    } else {
        None
    };
    let mut ephemeral_not_ignored = Vec::new();
    for rel in EPHEMERAL_HARNESS_PATHS {
        if !cwd.join(rel).exists() {
            continue;
        }
        let probe = if rel.ends_with('/') {
            format!("{rel}x")
        } else {
            rel.to_owned()
        };
        if !git.ignored(&probe) {
            ephemeral_not_ignored.push(rel);
        }
    }
    let mut ephemeral_tracked = Vec::new();
    for rel in EPHEMERAL_HARNESS_PATHS {
        if git.tracks(trim_slash(rel)) {
            ephemeral_tracked.push(rel);
        }
    }
    let nested_path = cwd.join(".navori/.gitignore");
    let nested_content = if nested_path.exists() {
        extract_managed_content(
            &read_text(&nested_path)?.ok_or(Unmodeled)?,
            NESTED_GITIGNORE_MANAGED_ID,
            CommentStyle::Shell,
        )
    } else {
        None
    };
    let nested_state_unprotected =
        nested_content.is_some_and(|c| !c.split('\n').any(|line| line == "state/"));
    let presets_ignored = git.ignored(".navori/presets/navori-probe");
    Ok(Some(GitHygieneReport {
        specs_ignored,
        ephemeral_not_ignored,
        ephemeral_tracked,
        presets_ignored,
        nested_state_unprotected,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::ExitStatus;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::process::{Failure, Output};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory; removed on drop.
    struct Temp(std::path::PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("navori-doctor-assets-{}-{n}", std::process::id()))
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

        fn mkdir(&self, rel: &str) {
            std::fs::create_dir_all(self.0.join(rel)).ok();
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

    fn no_env() -> Vec<(OsString, OsString)> {
        Vec::new()
    }

    // Covers: R73
    #[test]
    fn gate_segments_split_like_the_ts_regex() {
        assert_eq!(
            gate_segments("a && b || c; d | e & f ;;"),
            ["a", "b", "c", "d", "e & f"]
        );
        assert_eq!(command_words("CI=1 X_Y=2 pnpm  test"), ["pnpm", "test"]);
        assert_eq!(script_of(&["pnpm", "run", "lint"]), Some("lint"));
        assert_eq!(script_of(&["pnpm", "--filter", "x", "lint"]), None);
        assert_eq!(script_of(&["npm", "install"]), None);
        assert_eq!(script_of(&["npm", "a", "b"]), None);
        assert_eq!(js_resolve("/r", "packages/../cli/"), "/r/cli");
        assert_eq!(js_resolve("/r", "/abs"), "/abs");
    }

    // Covers: R73
    #[test]
    fn gate_readiness_reports_binaries_deps_and_scripts() -> Result<(), Unmodeled> {
        let t = Temp::new("gate");
        t.write("package.json", r#"{"scripts":{"lint":"x"}}"#);
        t.mkdir("node_modules");
        t.write("packages/cli/package.json", r#"{"scripts":{}}"#);
        let cfg = config(
            r#"{"qualityGate":{"fast":"pnpm lint && cd packages/cli && npm run test && foo && foo","full":"echo hi; bun run nope; bun run toString; git status"}}"#,
        );
        let has_binary = |bin: &str| bin != "foo";
        let issues = scan_quality_gate_readiness(&t.0, &cfg, &has_binary)?;
        let got: Vec<(&str, &str, &str)> = issues
            .iter()
            .map(|i| (i.gate, i.detail.as_str(), i.reason.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("fast", "packages/cli", "missing-deps"),
                ("fast", "foo", "missing-binary"),
                ("full", "nope", "missing-script"),
            ]
        );
        let none = config(r#"{"qualityGate":{"fast":""}}"#);
        assert!(scan_quality_gate_readiness(&t.0, &none, &has_binary)?.is_empty());
        Ok(())
    }

    // Covers: R73
    #[test]
    fn empty_user_sections_flag_only_the_untouched_template() -> Result<(), Unmodeled> {
        let t = Temp::new("user");
        let managed = "<!-- navori:managed id=\"s\" -->\nbody\n<!-- /navori:managed id=\"s\" -->\n";
        t.write(
            ".claude/skills/zeta/SKILL.md",
            &format!("{managed}<!-- navori:user-section -->\n## Rules\n<!-- user: fill\nme -->\n"),
        );
        t.write(
            ".claude/skills/alpha/SKILL.md",
            &format!("{managed}## Rules\n- real rule\n"),
        );
        t.write(".claude/skills/beta.md", &format!("{managed}# Only\n"));
        t.write(".claude/skills/gamma/SKILL.md", managed);
        t.write(".agents/skills/delta/SKILL.md", &format!("{managed}#\n"));
        let cfg = config(r#"{"engines":["claude","codex"]}"#);
        let dirs = doctor_skill_dirs(&cfg)?;
        let found = scan_empty_user_sections(&t.0, &dirs, &no_env())?;
        let got: Vec<(&str, &str)> = found
            .iter()
            .map(|s| (s.id.as_str(), s.path.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("beta", ".claude/skills/beta.md"),
                ("delta", ".agents/skills/delta/SKILL.md"),
                ("zeta", ".claude/skills/zeta/SKILL.md"),
            ]
        );
        Ok(())
    }

    // Covers: R73
    #[test]
    fn triggers_follow_ascii_boundaries_and_both_locales() -> Result<(), Unmodeled> {
        assert!(has_trigger(Some("Use when reviewing a diff"))?);
        assert!(has_trigger(Some("Usar cuando toques el modelo"))?);
        assert!(has_trigger(Some("Rules for X. USE\u{a0}THIS for Y."))?);
        assert!(!has_trigger(Some("Automate browser interactions."))?);
        // `á` is not an ASCII word character: no boundary between it and the space.
        assert!(!has_trigger(Some("Usá esto"))?);
        assert!(!has_trigger(Some("refuse whenever"))?);
        assert!(!has_trigger(None)?);
        Ok(())
    }

    // Covers: R73
    #[test]
    fn triggerless_local_skills_skip_managed_and_missing() -> Result<(), Unmodeled> {
        let t = Temp::new("trig");
        t.write(
            ".claude/skills/pw/SKILL.md",
            "---\nname: pw\ndescription: Automate browser tests.\n---\nbody\n",
        );
        t.write(
            ".claude/skills/ok/SKILL.md",
            "---\ndescription: Use when testing.\n---\n",
        );
        t.write(
            ".claude/skills/mine/SKILL.md",
            "---\ndescription: nothing\n---\n<!-- navori:managed id=\"x\" -->\n",
        );
        t.write(".claude/skills/bare/SKILL.md", "no frontmatter\n");
        let cfg = config(r#"{"project":{"localSkills":["pw","ok","mine","gone","pw","bare"]}}"#);
        let ids: Vec<String> = scan_triggerless_local_skills(&t.0, &cfg, &no_env())?
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, ["bare", "pw"]);
        Ok(())
    }

    // Covers: R73
    #[test]
    fn interpolation_artifacts_find_hard_and_soft_fallbacks() -> Result<(), Unmodeled> {
        let t = Temp::new("interp");
        t.write(
            "CLAUDE.md",
            "ok\nA <not configured: project.x> B <not configured: y>\n(quality gate not configured — run 'navori configure quality-gate')\n",
        );
        let cfg = config(r#"{"engines":["claude"]}"#);
        let found = scan_interpolation_artifacts(&t.0, &cfg)?;
        let got: Vec<(usize, &str, ArtifactReason)> = found
            .iter()
            .map(|a| (a.line, a.token.as_str(), a.reason))
            .collect();
        assert_eq!(
            got,
            [
                (
                    2,
                    "<not configured: project.x>",
                    ArtifactReason::UnresolvedPlaceholder
                ),
                (
                    2,
                    "<not configured: y>",
                    ArtifactReason::UnresolvedPlaceholder
                ),
                (
                    3,
                    "(quality gate not configured — run 'navori configure quality-gate')",
                    ArtifactReason::UnconfiguredGate
                ),
            ]
        );
        assert!(found.iter().all(|a| a.path == "CLAUDE.md"));
        Ok(())
    }

    // Covers: R73
    #[test]
    fn model_profile_lists_enabled_agents_without_tiers() -> Result<(), Unmodeled> {
        let cfg = config(
            r#"{"engines":["claude"],"harness":{"reviewer":false},"models":{"implementer":"opus"},"effort":{"orchestrator":"high"}}"#,
        );
        let rows = scan_missing_model_profile(&cfg)?;
        assert_eq!(rows[0].agent, "orchestrator");
        assert_eq!(rows[0].missing, [MissingTier::Model]);
        assert_eq!(rows[1].agent, "implementer");
        assert_eq!(rows[1].missing, [MissingTier::Effort]);
        assert!(rows.iter().all(|r| r.agent != "reviewer"));
        assert_eq!(rows.len(), 7);
        assert!(scan_missing_model_profile(&config(r#"{"engines":["cursor"]}"#))?.is_empty());
        Ok(())
    }

    // Covers: R73
    #[test]
    fn control_gaps_skip_inactive_conditions() -> Result<(), Unmodeled> {
        let claude = scan_control_gaps(&config(r#"{"engines":["claude"]}"#))?;
        assert_eq!(claude.len(), 6);
        assert!(
            claude
                .iter()
                .all(|g| !g.warn && g.state == ControlState::Advisory)
        );
        assert_eq!(claude[0].control, "handoff-shape");
        let codex = scan_control_gaps(&config(
            r#"{"engines":["codex"],"harness":{"planTiers":true}}"#,
        ))?;
        assert_eq!(codex[0].control, "plan-gate");
        assert!(codex[0].warn);
        assert!(codex.iter().all(|g| g.control != "master-plan"));
        let prose = scan_control_gaps(&config(
            r#"{"engines":["cursor"],"project":{"localSkills":["a"]}}"#,
        ))?;
        assert!(
            prose
                .iter()
                .any(|g| g.control == "local-skill-discovery" && g.warn)
        );
        assert_eq!(
            scan_control_gaps(&config(r#"{"engines":["nope"]}"#)),
            Err(Unmodeled)
        );
        Ok(())
    }

    // Covers: R73
    #[test]
    fn progress_size_reports_only_past_the_cap() {
        let t = Temp::new("progress");
        assert_eq!(
            scan_progress_size(&t.0, DEFAULT_PROGRESS_THRESHOLD_BYTES),
            None
        );
        t.write(PROGRESS_CURRENT_PATH, &"x".repeat(4000));
        assert_eq!(
            scan_progress_size(&t.0, DEFAULT_PROGRESS_THRESHOLD_BYTES),
            None
        );
        t.write(PROGRESS_CURRENT_PATH, &"é".repeat(2001));
        assert_eq!(
            scan_progress_size(&t.0, DEFAULT_PROGRESS_THRESHOLD_BYTES),
            Some(ProgressSizeIssue {
                path: PROGRESS_CURRENT_PATH,
                bytes: 4002,
                threshold_bytes: 4000
            })
        );
    }

    // Covers: R73
    #[test]
    fn master_plan_flags_missing_state_gitignore_and_desync() -> Result<(), Unmodeled> {
        let t = Temp::new("master");
        let cfg = config(r#"{"harness":{"masterPlan":true}}"#);
        assert!(scan_master_plan(&t.0, &cfg)?.is_empty());
        t.write(
            "specs/_master/index.json",
            r#"{"version":1,"stages":[{"number":1,"slug":"uno","dir":"01-uno","state":"cerrada","openedAt":"2026-01-01","closedAt":"2026-01-02"},{"number":2,"slug":"dos","dir":"02-dos","state":"activa","openedAt":"2026-01-03","closedAt":null}]}"#,
        );
        t.mkdir("specs/_master/01-uno");
        t.write("specs/_master/02-dos/context/raw/.gitignore", "*\n");
        let off = config("{}");
        assert_eq!(
            scan_master_plan(&t.0, &off)?,
            [
                MasterPlanDiagnostic::InvalidState {
                    detail: "02-dos: state.json missing; run master init to resume".to_owned()
                },
                MasterPlanDiagnostic::MissingRawGitignore {
                    path: "specs/_master/01-uno/context/raw/.gitignore".to_owned(),
                    repair: MasterRepair::Checkout
                },
                MasterPlanDiagnostic::FlagRegistryDesync {
                    repair: MasterRepair::Init
                },
            ]
        );
        t.write("specs/_master/02-dos/state.json", "{");
        assert_eq!(scan_master_plan(&t.0, &cfg), Err(Unmodeled));
        t.write("specs/_master/index.json", "{");
        assert_eq!(scan_master_plan(&t.0, &cfg), Err(Unmodeled));
        Ok(())
    }

    // Covers: R73
    #[test]
    fn nested_worktrees_need_an_install_and_an_eslint_config() -> Result<(), Unmodeled> {
        let t = Temp::new("nested");
        t.mkdir(".claude/worktrees/b/node_modules");
        t.mkdir(".claude/worktrees/a");
        assert_eq!(scan_nested_worktrees(&t.0)?, None);
        t.write("package.json", r#"{"eslintConfig":{}}"#);
        let found = scan_nested_worktrees(&t.0)?.ok_or(Unmodeled)?;
        assert_eq!(found.eslint_config, "package.json#eslintConfig");
        assert_eq!(found.worktrees, [".claude/worktrees/b"]);
        t.write("eslint.config.mjs", "");
        t.write(".eslintrc.json", "{}");
        t.write(".eslintrc.txt", "");
        let found = scan_nested_worktrees(&t.0)?.ok_or(Unmodeled)?;
        assert_eq!(found.eslint_config, ".eslintrc.json");
        Ok(())
    }

    // Covers: R76
    #[test]
    fn stale_harness_finds_nested_claude_dirs_with_files() -> Result<(), Unmodeled> {
        let t = Temp::new("stale");
        t.write(".claude/agents/x.md", "root is never reported");
        t.write(
            "pkg/b/.claude/skills/s/SKILL.md",
            "<!-- navori:managed id=\"a\" version=\"0.10.2\" -->\n",
        );
        t.write(
            "pkg/b/.claude/CLAUDE.md",
            "<!-- navori:managed id=\"b\" version=\"0.9.10\" -->\n",
        );
        t.write("pkg/b/.claude/worktrees/w/file", "ephemeral, skipped");
        t.write("app/.claude/notes", "no stamp");
        t.mkdir("empty/.claude");
        t.write("node_modules/x/.claude/f", "skipped dir");
        t.write("a/b/c/d/.claude/f", "too deep");
        let found = scan_stale_harness(&t.0, &config("{}"), &no_env())?;
        assert_eq!(
            found,
            [
                StaleHarness {
                    path: "app/.claude".to_owned(),
                    frozen_at: None,
                    files: 1
                },
                StaleHarness {
                    path: "pkg/b/.claude".to_owned(),
                    frozen_at: Some("0.9.10".to_owned()),
                    files: 2
                },
            ]
        );
        let disabled = config(r#"{"monorepo":{"enabled":false}}"#);
        assert!(scan_stale_harness(&t.0, &disabled, &no_env())?.is_empty());
        let workspaces = config(r#"{"monorepo":{"enabled":true,"workspaces":[{"path":"pkg/b"}]}}"#);
        assert_eq!(
            scan_stale_harness(&t.0, &workspaces, &no_env()),
            Err(Unmodeled)
        );
        Ok(())
    }

    // Covers: R76
    #[test]
    fn workspace_full_harness_is_none_or_delegates() {
        assert_eq!(scan_workspace_full_harness(&config("{}")), Ok(None));
        let minimal = config(
            r#"{"monorepo":{"enabled":true,"workspaceHarness":"minimal","workspaces":[{"path":"a"}]}}"#,
        );
        assert_eq!(scan_workspace_full_harness(&minimal), Ok(None));
        let full = config(
            r#"{"monorepo":{"enabled":true,"workspaceHarness":"full","workspaces":[{"path":"a"}]}}"#,
        );
        assert_eq!(scan_workspace_full_harness(&full), Err(Unmodeled));
    }

    // Covers: R73
    #[test]
    fn flat_skills_cover_the_repo_and_home_roots() -> Result<(), Unmodeled> {
        let t = Temp::new("flat");
        let home = Temp::new("home");
        t.write(".claude/skills/loose.md", "x");
        t.write(".claude/skills/README.md", "x");
        t.write(".claude/skills/dir.md/SKILL.md", "x");
        home.write(".claude/skills/mine.md", "x");
        let found = scan_flat_skills(&t.0, &home.0, &no_env())?;
        let got: Vec<(&str, &str, &str)> = found
            .iter()
            .map(|s| (s.path.as_str(), s.id.as_str(), s.suggested.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (
                    ".claude/skills/loose.md",
                    "loose",
                    ".claude/skills/loose/SKILL.md"
                ),
                (
                    "~/.claude/skills/mine.md",
                    "mine",
                    "~/.claude/skills/mine/SKILL.md"
                ),
            ]
        );
        Ok(())
    }

    // Covers: R73
    #[test]
    fn foreign_skill_index_reports_only_fully_dead_paths() -> Result<(), Unmodeled> {
        let t = Temp::new("foreign");
        assert!(scan_foreign_skill_indexes(&t.0)?.is_empty());
        t.write(
            ".atl/skill-registry.md",
            "Last updated:\n  2026-01-05\n| `/nowhere/a/SKILL.md` | `/nowhere/b/SKILL.md` |\n",
        );
        let found = scan_foreign_skill_indexes(&t.0)?;
        assert_eq!(
            found,
            [ForeignSkillIndex {
                path: ".atl/skill-registry.md",
                producer: "gentle-ai (Agent Teams Lite)",
                indexed: 2,
                frozen_at: Some("2026-01-05".to_owned())
            }]
        );
        t.write("live/SKILL.md", "x");
        let live = t.0.join("live/SKILL.md");
        t.write(
            ".atl/skill-registry.md",
            &format!("`/nowhere/SKILL.md` `{}`", path_text(&live)?),
        );
        assert!(scan_foreign_skill_indexes(&t.0)?.is_empty());
        Ok(())
    }

    // Covers: R73
    #[test]
    fn doc_budget_prices_every_surface() -> Result<(), Unmodeled> {
        let t = Temp::new("budget");
        let cfg = config(r#"{"engines":["claude"]}"#);
        assert_eq!(scan_doc_budget(&t.0, &cfg, "1.2.3")?, None);
        t.write(
            "CLAUDE.md",
            "own words here\n<!-- navori:managed id=\"tipado-fuerte\" -->\na b\n<!-- /navori:managed id=\"tipado-fuerte\" -->\n<!-- navori:managed id=\"engram-x\" source=\"@navori/plugin-engram\" -->\nc\n<!-- /navori:managed id=\"engram-x\" -->\n",
        );
        t.write(".claude/context/b.md", &"y".repeat(7995));
        t.write(".claude/context/a.md", "short");
        t.write(
            ".mcp.json",
            r#"{"mcpServers":{"engram":{},"cg":{"alwaysLoad":true},"bad":1}}"#,
        );
        let report = scan_doc_budget(&t.0, &cfg, "1.2.3")?.ok_or(Unmodeled)?;
        // Markers count: 3 own words, 10 per block (4 + 2 + 4 and 5 + 1 + 4).
        assert_eq!(report.total_words, Some(23));
        assert_eq!(report.managed_words, Some(20));
        assert_eq!(report.own_words, Some(3));
        assert_eq!(report.unbudgeted_words, Some(10));
        assert_eq!(report.ceiling, Some(61));
        assert_eq!(report.over_by, Some(0));
        assert_eq!(report.per_subagent_words, Some(23));
        assert_eq!(report.blocks.len(), 2);
        assert_eq!(report.blocks[0].kind, BlockKind::Static);
        assert_eq!(report.blocks[0].lever, DocBudgetLever::Core);
        assert_eq!(report.blocks[1].kind, BlockKind::Unbudgeted);
        assert_eq!(report.blocks[1].lever, DocBudgetLever::Plugins);
        let delivered: Vec<(&str, ContextDelivery, usize)> = report
            .context_files
            .iter()
            .map(|f| (f.file.path.as_str(), f.delivered, f.ctx_chars_before))
            .collect();
        assert_eq!(
            delivered,
            [
                (".claude/context/a.md", ContextDelivery::Inline, 1),
                (".claude/context/b.md", ContextDelivery::Pointer, 8),
            ]
        );
        assert_eq!(report.context_chars, 8000);
        assert_eq!(
            report.mcp_servers,
            [
                DocBudgetMcpServer {
                    id: "engram".to_owned(),
                    always_load: false
                },
                DocBudgetMcpServer {
                    id: "cg".to_owned(),
                    always_load: true
                },
            ]
        );
        assert_eq!(report.agents_md, None);
        assert_eq!(report.cli_version, "1.2.3");
        let only_agents = Temp::new("agents");
        only_agents.write("AGENTS.md", "é é");
        let report = scan_doc_budget(&only_agents.0, &config(r#"{"engines":["codex"]}"#), "v")?
            .ok_or(Unmodeled)?;
        assert_eq!(
            report.agents_md,
            Some(DocBudgetFile {
                path: "AGENTS.md".to_owned(),
                words: 2,
                chars: 5
            })
        );
        assert_eq!(
            (report.total_words, report.per_subagent_words),
            (None, None)
        );
        Ok(())
    }

    // Covers: R73
    #[test]
    fn ignore_health_reads_missing_and_drift() -> Result<(), Unmodeled> {
        let t = Temp::new("ignore");
        let off = config(r#"{"engines":["claude"]}"#);
        assert_eq!(scan_gitignore_harness(&t.0, &off)?, None);
        let on = config(r#"{"engines":["claude"],"gitignoreHarness":"minimal"}"#);
        let missing = Some(IgnoreHealth {
            missing: true,
            drift: false,
        });
        assert_eq!(scan_gitignore_harness(&t.0, &on)?, missing);
        let body = gitignore_body(&on.data).ok_or(Unmodeled)?;
        t.write(
            ".gitignore",
            &format!("# navori:managed start id=\"gitignore-harness\"\n{body}\n# navori:managed end id=\"gitignore-harness\"\n"),
        );
        let healthy = scan_gitignore_harness(&t.0, &on)?.ok_or(Unmodeled)?;
        assert_eq!((healthy.missing, healthy.drift), (false, false));
        t.write(
            ".gitignore",
            "# navori:managed start id=\"gitignore-harness\"\nold\n# navori:managed end id=\"gitignore-harness\"\n",
        );
        let drifted = scan_gitignore_harness(&t.0, &on)?.ok_or(Unmodeled)?;
        assert_eq!((drifted.missing, drifted.drift), (false, true));

        assert_eq!(scan_prettier_ignore(&t.0, &off)?, None);
        t.write(".prettierrc", "{}");
        assert_eq!(scan_prettier_ignore(&t.0, &off)?, missing);
        t.write(".prettierignore", "CLAUDE.md\n.claude/\n");
        let covered = scan_prettier_ignore(&t.0, &off)?;
        assert!(covered.is_some());
        Ok(())
    }

    /// Answers `git -C <cwd> <args…>` from a table; anything else fails to start.
    struct FakeGit(Vec<(Vec<&'static str>, i32, &'static str)>);

    impl ProcessRunner for FakeGit {
        fn run(&self, request: &Request<'_>) -> Result<Output, Failure> {
            let args = request.args.get(2..).unwrap_or_default();
            self.0
                .iter()
                .find(|(want, _, _)| want.as_slice() == args)
                .map(|(_, code, stdout)| Output {
                    status: ExitStatus::from_raw(code << 8),
                    stdout: stdout.as_bytes().to_vec(),
                })
                .ok_or_else(|| Failure::Spawn(std::io::Error::other("no answer")))
        }
    }

    // Covers: R73
    #[test]
    fn git_hygiene_reads_ignore_rules_and_the_index() -> Result<(), Unmodeled> {
        let t = Temp::new("hygiene");
        let cfg = config("{}");
        assert_eq!(
            scan_git_hygiene(&t.0, &cfg, &FakeGit(Vec::new()), &no_env())?,
            None
        );
        t.mkdir(".claude/worktrees");
        t.write(".claude/settings.local.json", "{}");
        t.write(
            ".navori/.gitignore",
            "# navori:managed start id=\"nested-gitignore-harness\"\npresets/\n# navori:managed end id=\"nested-gitignore-harness\"\n",
        );
        let git = FakeGit(vec![
            (vec!["rev-parse", "--is-inside-work-tree"], 0, "true\n"),
            (vec!["check-ignore", "-q", "--no-index", "specs/x"], 0, ""),
            (
                vec!["check-ignore", "-q", "--no-index", ".claude/worktrees/x"],
                0,
                "",
            ),
            (
                vec![
                    "check-ignore",
                    "-q",
                    "--no-index",
                    ".claude/settings.local.json",
                ],
                1,
                "",
            ),
            (
                vec!["ls-files", "--", ".claude/.managed-drift-stamp"],
                0,
                ".claude/.managed-drift-stamp\n",
            ),
            (vec!["ls-files", "--", ".navori/state"], 0, "  \n"),
            (
                vec![
                    "check-ignore",
                    "-q",
                    "--no-index",
                    ".navori/presets/navori-probe",
                ],
                0,
                "",
            ),
        ]);
        let report = scan_git_hygiene(&t.0, &cfg, &git, &no_env())?.ok_or(Unmodeled)?;
        assert_eq!(
            report,
            GitHygieneReport {
                specs_ignored: Some("specs".to_owned()),
                ephemeral_not_ignored: vec![".claude/settings.local.json"],
                ephemeral_tracked: vec![".claude/.managed-drift-stamp"],
                presets_ignored: true,
                nested_state_unprotected: true,
            }
        );
        let sdd_off = config(r#"{"blocks":{"exclude":["sdd"]}}"#);
        let report = scan_git_hygiene(&t.0, &sdd_off, &git, &no_env())?.ok_or(Unmodeled)?;
        assert_eq!(report.specs_ignored, None);
        Ok(())
    }
}
