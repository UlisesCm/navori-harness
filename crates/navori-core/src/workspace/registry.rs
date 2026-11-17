//! Port of the read side of `lib/workspace/workspace.ts` (spec 0059 D34): the workspace registry
//! under `~/.navori/workspaces/`, `WorkspaceConfigSchema`, and `canonicalPath`.
//!
//! Errors keep the TS split: [`Stop::Throw`] is a `WorkspaceError` (or a filesystem throw) the
//! caller catches the way the TS does, and [`Stop::Delegate`] is a branch the port does not
//! reproduce, so the command hands its argv to the TS before any output.

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

use crate::js_json::{self, JsObject, JsValue};
use crate::posix::normalize;
use crate::process::Env;

/// Why a read did not produce a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// The TS throws here; its caller catches it.
    Throw,
    /// Only the TS reproduces this branch.
    Delegate(&'static str),
}

const MANIFEST_NAME: &str = "workspace.json";

/// The fields of a validated workspace the ported commands read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// `defaults.language`.
    pub language: Option<String>,
    /// `repos[].path`, in order.
    pub repo_paths: Vec<String>,
    /// `repos[].name`, aligned with [`Self::repo_paths`].
    pub repo_names: Vec<String>,
    /// The rest of `defaults` (`language` is [`Self::language`]).
    pub defaults: Defaults,
}

/// `defaults` of a workspace manifest, the fields `scanWorkspaceDrift` compares.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Defaults {
    /// `defaults.branchBase`.
    pub branch_base: Option<String>,
    /// `defaults.prTarget`.
    pub pr_target: Option<String>,
    /// `defaults.commits`.
    pub commits: Option<String>,
    /// `defaults.engines`.
    pub engines: Option<Vec<String>>,
    /// `defaults.plugins` as `(id, enabled)`, in `Object.entries` order.
    pub plugins: Vec<(String, bool)>,
}

fn kebab(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn var<'e>(env: &'e Env, name: &str) -> Option<&'e std::ffi::OsStr> {
    env.iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_os_str())
}

/// `safeHomedir()`: `HOME`, which must be absolute. Without `HOME` Node asks the password
/// database, which the port does not.
///
/// # Errors
/// [`Stop::Throw`] for a relative `HOME`, [`Stop::Delegate`] when it is unset, empty or not UTF-8.
pub fn home(env: &Env) -> Result<PathBuf, Stop> {
    let home = var(env, "HOME")
        .filter(|home| !home.is_empty())
        .ok_or(Stop::Delegate("HOME is unset"))?
        .to_str()
        .ok_or(Stop::Delegate("HOME is not UTF-8"))?;
    if !home.starts_with('/') {
        return Err(Stop::Throw);
    }
    Ok(PathBuf::from(home))
}

/// `workspacesRoot()`.
///
/// # Errors
/// As [`home`].
pub fn root(env: &Env) -> Result<PathBuf, Stop> {
    Ok(home(env)?.join(".navori").join("workspaces"))
}

/// `workspaceDirectory(name)`.
///
/// # Errors
/// [`Stop::Throw`] for a name that is not kebab-case; otherwise as [`home`].
pub fn directory(env: &Env, name: &str) -> Result<PathBuf, Stop> {
    if !kebab(name) {
        return Err(Stop::Throw);
    }
    Ok(root(env)?.join(name))
}

fn names(dir: &Path) -> Result<Vec<String>, Stop> {
    let entries = fs::read_dir(dir).map_err(|_| Stop::Throw)?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| Stop::Throw)?;
        names.push(
            entry
                .file_name()
                .into_string()
                .map_err(|_| Stop::Delegate("non-UTF-8 workspace entry"))?,
        );
    }
    Ok(names)
}

/// `listWorkspaces()`. A legacy `<name>.json` that would be migrated is a write: delegated.
///
/// # Errors
/// As [`root`]; [`Stop::Throw`] when the root cannot be read.
pub fn list(env: &Env) -> Result<Vec<String>, Stop> {
    let root = root(env)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let entries = names(&root)?;
    for entry in &entries {
        if let Some(name) = entry.strip_suffix(".json")
            && kebab(name)
            && !root.join(name).join(MANIFEST_NAME).exists()
        {
            return Err(Stop::Delegate("legacy workspace layout"));
        }
    }
    let mut out: Vec<String> = entries
        .into_iter()
        .filter(|entry| {
            let full = root.join(entry);
            fs::metadata(&full).is_ok_and(|meta| meta.is_dir()) && full.join(MANIFEST_NAME).exists()
        })
        .collect();
    // `Array.prototype.sort`: UTF-16 code units, which is byte order for the kebab names that load.
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(out)
}

/// A string member zod reads, `Err` when the value is not a string or holds a lone surrogate.
fn string(value: &JsValue) -> Result<Option<String>, Stop> {
    match value {
        JsValue::String(s) => s
            .to_rust()
            .map(Some)
            .ok_or(Stop::Delegate("lone surrogate in workspace")),
        _ => Ok(None),
    }
}

/// `z.string().optional()` (and its regex form): absent passes, anything else must be a matching
/// string.
fn optional_string(
    object: &JsObject,
    key: &str,
    valid: impl Fn(&str) -> bool,
) -> Result<Result<Option<String>, ()>, Stop> {
    match object.get(key) {
        None | Some(JsValue::Undefined) => Ok(Ok(None)),
        Some(value) => Ok(match string(value)? {
            Some(text) if valid(&text) => Ok(Some(text)),
            _ => Err(()),
        }),
    }
}

static TICKETS_DIR: std::sync::LazyLock<Option<Regex>> =
    std::sync::LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$").ok());

/// `defaults` validated: `Err(())` when zod rejects it, else its language and the rest.
type ValidDefaults = Result<(Option<String>, Defaults), ()>;

fn defaults_valid(value: Option<&JsValue>) -> Result<ValidDefaults, Stop> {
    let object = match value {
        None | Some(JsValue::Undefined) => return Ok(Ok((None, Defaults::default()))),
        Some(JsValue::Object(object)) => object,
        Some(_) => return Ok(Err(())),
    };
    let any = |_: &str| true;
    let Ok(branch_base) = optional_string(object, "branchBase", any)? else {
        return Ok(Err(()));
    };
    let Ok(pr_target) = optional_string(object, "prTarget", any)? else {
        return Ok(Err(()));
    };
    let commits = |v: &str| matches!(v, "conventional" | "conventional-es" | "free");
    let Ok(commits) = optional_string(object, "commits", commits)? else {
        return Ok(Err(()));
    };
    let Ok(language) = optional_string(object, "language", |v| matches!(v, "es" | "en"))? else {
        return Ok(Err(()));
    };
    let engines = match object.get("engines") {
        None | Some(JsValue::Undefined) => None,
        Some(JsValue::Array(items)) => {
            let mut engines = Vec::new();
            for item in items {
                let Some(engine) = string(item)? else {
                    return Ok(Err(()));
                };
                engines.push(engine);
            }
            Some(engines)
        }
        Some(_) => return Ok(Err(())),
    };
    let mut plugins = Vec::new();
    match object.get("plugins") {
        None | Some(JsValue::Undefined) => {}
        Some(JsValue::Object(entries)) => {
            for (key, plugin) in entries.ordered() {
                let Some(key) = key.to_rust() else {
                    return Err(Stop::Delegate("lone surrogate in workspace"));
                };
                let JsValue::Object(plugin) = plugin else {
                    return Ok(Err(()));
                };
                let Some(JsValue::Bool(enabled)) = plugin.get("enabled") else {
                    return Ok(Err(()));
                };
                plugins.push((key, *enabled));
            }
        }
        Some(_) => return Ok(Err(())),
    }
    let defaults = Defaults {
        branch_base,
        pr_target,
        commits,
        engines,
        plugins,
    };
    Ok(Ok((language, defaults)))
}

/// `WorkspaceConfigSchema.safeParse(parsed)`: `Ok(None)` when zod rejects it.
///
/// # Errors
/// [`Stop::Delegate`] for a value only JS reads (a lone surrogate).
pub fn validate(value: &JsValue) -> Result<Option<Workspace>, Stop> {
    let JsValue::Object(object) = value else {
        return Ok(None);
    };
    let any = |_: &str| true;
    if optional_string(object, "$schema", any)?.is_err()
        || optional_string(object, "description", any)?.is_err()
    {
        return Ok(None);
    }
    match object.get("name").map(string).transpose()?.flatten() {
        Some(name) if kebab(&name) => {}
        _ => return Ok(None),
    }
    let tickets = |dir: &str| {
        TICKETS_DIR.as_ref().is_some_and(|re| re.is_match(dir))
            && !dir.split('/').any(|s| s == "..")
    };
    if optional_string(object, "ticketsDir", tickets)?.is_err() {
        return Ok(None);
    }
    let Ok((language, defaults)) = defaults_valid(object.get("defaults"))? else {
        return Ok(None);
    };
    let mut repo_paths = Vec::new();
    let mut repo_names = Vec::new();
    match object.get("repos") {
        None | Some(JsValue::Undefined) => {}
        Some(JsValue::Array(repos)) => {
            for repo in repos {
                let JsValue::Object(repo) = repo else {
                    return Ok(None);
                };
                let name = match repo.get("name").map(string).transpose()?.flatten() {
                    Some(name) if kebab(&name) => name,
                    _ => return Ok(None),
                };
                let path = match repo.get("path").map(string).transpose()?.flatten() {
                    Some(path) if !path.is_empty() => path,
                    _ => return Ok(None),
                };
                for key in ["stack", "description", "branchBase"] {
                    if optional_string(repo, key, any)?.is_err() {
                        return Ok(None);
                    }
                }
                repo_paths.push(path);
                repo_names.push(name);
            }
        }
        Some(_) => return Ok(None),
    }
    Ok(Some(Workspace {
        language,
        repo_paths,
        repo_names,
        defaults,
    }))
}

/// `loadWorkspace(name)`: `None` without a manifest.
///
/// # Errors
/// [`Stop::Throw`] for an invalid name, an unreadable manifest, invalid JSON or a schema failure;
/// [`Stop::Delegate`] for a legacy layout to migrate or JSON only JS reads.
pub fn load(env: &Env, name: &str) -> Result<Option<Workspace>, Stop> {
    let legacy = root(env)?.join(format!("{name}.json"));
    let dir = directory(env, name)?;
    let path = dir.join(MANIFEST_NAME);
    if legacy.exists() && !path.exists() {
        return Err(Stop::Delegate("legacy workspace layout"));
    }
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|_| Stop::Throw)?;
    let text = String::from_utf8(bytes).map_err(|_| Stop::Delegate("workspace is not UTF-8"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let parsed = js_json::parse(text).ok_or(Stop::Delegate("workspace JSON outside the model"))?;
    validate(&parsed)?.map(Some).ok_or(Stop::Throw)
}

/// `path.resolve(input)` from `cwd`, lexical.
#[must_use]
pub fn resolve(cwd: &str, input: &str) -> String {
    let joined = if input.starts_with('/') {
        input.to_owned()
    } else {
        format!("{cwd}/{input}")
    };
    let normal = normalize(&joined);
    match normal.strip_suffix('/') {
        Some(stripped) if !stripped.is_empty() => stripped.to_owned(),
        _ => normal,
    }
}

/// `canonicalPath(input)`: `realpath` of the resolved path, or the resolved path itself.
///
/// # Errors
/// [`Stop::Delegate`] when the real path is not UTF-8.
pub fn canonical(cwd: &str, input: &str) -> Result<String, Stop> {
    let absolute = resolve(cwd, input);
    match fs::canonicalize(&absolute) {
        Ok(real) => real
            .into_os_string()
            .into_string()
            .map_err(|_| Stop::Delegate("real path is not UTF-8")),
        Err(_) => Ok(absolute),
    }
}

/// `resolveWorkspacesForCwd(cwd)`: every workspace with a repo equal to or containing `cwd`. A
/// workspace that fails to load is skipped, as the TS does.
///
/// # Errors
/// As [`list`], and any [`Stop::Delegate`] of a workspace.
pub fn for_cwd(env: &Env, cwd: &str) -> Result<Vec<String>, Stop> {
    let target = canonical(cwd, cwd)?;
    let mut out = Vec::new();
    for name in list(env)? {
        let workspace = match load(env, &name) {
            Ok(Some(workspace)) => workspace,
            Ok(None) | Err(Stop::Throw) => continue,
            Err(stop) => return Err(stop),
        };
        for repo in &workspace.repo_paths {
            let path = canonical(cwd, repo)?;
            if target == path || target.starts_with(&format!("{path}/")) {
                out.push(name);
                break;
            }
        }
    }
    Ok(out)
}
