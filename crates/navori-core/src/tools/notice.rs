//! Port of `lib/primitives/tool-version-notice.ts` and the `tools notice` output (spec 0059 D34,
//! R56, R59): reserve the daily refresh of the opted-in tools, read the cached latest releases,
//! probe the installed versions and print the pending notices, or stamp their delivery.
//!
//! The refresh itself is network: [`prepare`] reserves it and hands the token to `spawn_worker`,
//! which the CLI turns into `navori <flag> <token>` on `PATH`, the TS worker. Nothing here opens a
//! socket.
//!
//! Every branch only the TS reproduces is found by [`precheck`] before the first write, so a
//! command that delegates has written nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;

use super::cache::{
    DAY, locked, machine_eligible, now_ms, read_state, safe_integer, stable_version, stamp,
};
use crate::atomic::{random_uuid, write_file_atomic};
use crate::config::Config;
use crate::js_json::{JsObject, JsValue};
use crate::process::{self, Env};
use crate::render::context::Lang;
use crate::render::plugins::{PluginLoadError, load_plugin};
use crate::semver;
use crate::workspace::registry::{self, Stop};

/// `TOOL_VERSION_WORKER_ARG`.
pub const WORKER_ARG: &str = "--navori-private-tool-version-worker";
/// `TOOL_NOTICE_SENTINEL`.
pub const SENTINEL: &str = "#navori-tool-notice v1 ack=";
/// `LATEST_MAX_AGE_MS`.
const LATEST_MAX_AGE: f64 = 7.0 * DAY;
/// `PROBE_BUDGET_MS`.
const PROBE_BUDGET: Duration = Duration::from_millis(1500);
/// `PER_TOOL_MS`.
const PER_TOOL: Duration = Duration::from_millis(1000);
/// `MAX_NOTICES`.
const MAX_NOTICES: usize = 3;

/// `manifest.externalTool.latestRelease`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub source: String,
    pub id: String,
    pub notify: String,
}

/// `ToolUpdate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub plugin_id: String,
    pub installed: String,
    pub latest: String,
}

fn text(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

fn member<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(o) => o.get(key),
        _ => None,
    }
}

/// `record(value)`: the object, or an empty one for anything else.
fn record(value: Option<&JsValue>) -> JsObject {
    match value {
        Some(JsValue::Object(o)) => o.clone(),
        _ => JsObject::new(),
    }
}

/// The bundled manifests of the plugins this run looks at, loaded once.
#[derive(Default)]
pub struct Plugins(BTreeMap<String, Option<JsValue>>);

impl Plugins {
    /// `loadPlugin(id).manifest.externalTool`, `None` when the TS's `loadPlugin` would throw
    /// `PluginNotFoundError`.
    fn tool(&mut self, id: &str) -> Result<Option<JsValue>, Stop> {
        if let Some(tool) = self.0.get(id) {
            return Ok(tool.clone());
        }
        let tool = match load_plugin(id) {
            Ok(plugin) => member(&plugin.manifest, "externalTool").cloned(),
            Err(PluginLoadError::NotFound) => None,
            Err(PluginLoadError::Delegate) => return Err(Stop::Delegate("plugin manifest")),
        };
        self.0.insert(id.to_owned(), tool.clone());
        Ok(tool)
    }

    /// `watched(pluginId)`.
    fn watched(&mut self, id: &str) -> Result<Option<Release>, Stop> {
        let valid = id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !valid {
            return Ok(None);
        }
        let Some(release) = self
            .tool(id)?
            .and_then(|tool| member(&tool, "latestRelease").cloned())
        else {
            return Ok(None);
        };
        match (
            text(member(&release, "source")),
            text(member(&release, "id")),
            text(member(&release, "notify")),
        ) {
            (Some(source), Some(id), Some(notify)) => Ok(Some(Release { source, id, notify })),
            _ => Err(Stop::Delegate("latestRelease outside the model")),
        }
    }
}

/// `~/.navori/tool-versions`.
fn state_dir(env: &Env) -> Result<PathBuf, Stop> {
    Ok(registry::home(env)?.join(".navori").join("tool-versions"))
}

/// Enabled plugin ids of the config, in `Object.entries` order.
fn enabled(config: &Config) -> Vec<String> {
    let Some(JsValue::Object(plugins)) = member(&config.data, "plugins") else {
        return Vec::new();
    };
    plugins
        .ordered()
        .into_iter()
        .filter(|(_, settings)| matches!(member(settings, "enabled"), Some(JsValue::Bool(true))))
        .filter_map(|(id, _)| id.to_rust())
        .collect()
}

/// Every branch only the TS answers, checked before the first write: plugin manifests of the
/// config, the ids in the state files and `extra`, and state files the port cannot read.
///
/// # Errors
/// [`Stop::Delegate`] for the first such branch; [`Stop::Throw`] for an unusable `HOME`.
pub fn precheck(
    env: &Env,
    config: Option<&Config>,
    extra: &[&str],
    plugins: &mut Plugins,
) -> Result<(), Stop> {
    let dir = state_dir(env)?;
    let mut ids: Vec<String> = extra.iter().map(|id| (*id).to_owned()).collect();
    if let Some(config) = config {
        for id in enabled(config) {
            plugins.tool(&id)?;
            ids.push(id);
        }
    }
    for name in ["attempts.json", "latest.json", "notice.json"] {
        let state = read_state(&dir.join(name))?;
        let state = if name == "latest.json" {
            state.as_ref().and_then(|s| member(s, "tools")).cloned()
        } else {
            state
        };
        if let Some(JsValue::Object(object)) = state {
            for (id, _) in object.entries() {
                ids.push(
                    id.to_rust()
                        .ok_or(Stop::Delegate("lone surrogate in state"))?,
                );
            }
        }
    }
    for id in ids {
        plugins.watched(&id)?;
    }
    Ok(())
}

/// `validAttempt`.
fn valid_attempt(value: &JsValue, now: f64) -> bool {
    static TOKEN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new("^[0-9a-f-]{36}$").ok());
    stamp(value, now).is_some()
        && match member(value, "token") {
            Some(JsValue::Null) => true,
            Some(JsValue::String(token)) => token
                .to_rust()
                .is_some_and(|t| TOKEN.as_ref().is_some_and(|re| re.is_match(&t))),
            _ => false,
        }
}

/// `reserveRefresh(ids, now)`: the shared one-use token, `None` when nothing is due.
fn reserve_refresh(
    env: &Env,
    ids: &[String],
    now: f64,
    plugins: &mut Plugins,
) -> Result<Option<String>, Stop> {
    let dir = state_dir(env)?;
    let reserved = locked(&dir, || {
        let path = dir.join("attempts.json");
        let previous = read_state(&path)?;
        // `typeof previous !== "object"`: `null` and arrays are objects.
        if path.exists()
            && !matches!(
                previous,
                Some(JsValue::Object(_) | JsValue::Array(_) | JsValue::Null)
            )
        {
            return Ok(None);
        }
        let previous = record(previous.as_ref());
        let mut attempts = JsObject::new();
        for (id, value) in previous.ordered() {
            let id = id
                .to_rust()
                .ok_or(Stop::Delegate("lone surrogate in state"))?;
            if plugins.watched(&id)?.is_some() && valid_attempt(value, now) {
                attempts.insert(id, value.clone());
            }
        }
        let token = random_uuid().map_err(|_| Stop::Throw)?;
        let mut any = false;
        for id in ids {
            if let Some(prior) = previous.get(id) {
                if !valid_attempt(prior, now) {
                    continue; // future stamp: fail closed
                }
                if stamp(prior, now).is_some_and(|at| now - at < DAY) {
                    continue;
                }
            }
            let mut fresh = JsObject::new();
            fresh.insert("at", JsValue::Number(now));
            fresh.insert("token", JsValue::string(&token));
            attempts.insert(id.as_str(), JsValue::Object(fresh));
            any = true;
        }
        if !any {
            return Ok(None);
        }
        let body = JsValue::Object(attempts)
            .stringify(None)
            .ok_or(Stop::Delegate("attempts did not serialize"))?;
        write_file_atomic(&path, body.as_bytes()).map_err(|_| Stop::Throw)?;
        Ok(Some(token))
    })?;
    Ok(reserved.flatten())
}

/// A cached latest release (`LatestEntry`); `None` version is `unparseable`.
struct Latest {
    version: Option<String>,
}

/// `readLatest(now)`: fresh entries consistent with the current manifests.
fn read_latest(
    dir: &Path,
    now: f64,
    plugins: &mut Plugins,
) -> Result<BTreeMap<String, Latest>, Stop> {
    let state = read_state(&dir.join("latest.json"))?;
    let tools = record(state.as_ref().and_then(|s| member(s, "tools")));
    let mut out = BTreeMap::new();
    for (id, raw) in tools.ordered() {
        let id = id
            .to_rust()
            .ok_or(Stop::Delegate("lone surrogate in state"))?;
        let Some(release) = plugins.watched(&id)? else {
            continue;
        };
        let Some(at) = stamp(raw, now) else {
            continue;
        };
        if now - at >= LATEST_MAX_AGE
            || text(member(raw, "source")).as_deref() != Some(release.source.as_str())
            || text(member(raw, "id")).as_deref() != Some(release.id.as_str())
        {
            continue;
        }
        let status = text(member(raw, "status"));
        let version = member(raw, "version");
        let entry = match (status.as_deref(), stable_version(version)) {
            (Some("ok"), Some(version)) => Latest {
                version: Some(version),
            },
            (Some("unparseable"), _) if matches!(version, Some(JsValue::Null)) => {
                Latest { version: None }
            }
            _ => continue,
        };
        out.insert(id, entry);
    }
    Ok(out)
}

/// `meetsNotifyLevel(installed, latest, notify)`.
#[must_use]
pub fn meets_notify_level(installed: &str, latest: &str, notify: &str) -> bool {
    let (Some(a), Some(b)) = (semver::parse(installed), semver::parse(latest)) else {
        return false;
    };
    if b.major != a.major {
        return b.major > a.major;
    }
    if notify == "major" {
        return false;
    }
    if b.minor != a.minor {
        return b.minor > a.minor;
    }
    notify == "patch" && b.patch > a.patch
}

/// `hasBinary(name)`: an executable regular file along `PATH`, empty entries skipped. The mode
/// bits stand in for `access(X_OK)`, which also weighs the file's owner.
fn has_binary(env: &Env, cwd: &Path, name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    let Some(path) = env
        .iter()
        .rev()
        .find(|(key, _)| key == "PATH")
        .map(|(_, v)| v)
    else {
        return false;
    };
    path.to_string_lossy()
        .split(':')
        .filter(|dir| !dir.is_empty())
        .any(|dir| {
            std::fs::metadata(cwd.join(dir).join(name))
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

/// `probeEnabledToolVersions(config, wants, { budgetMs: 1500 })` for the tools with a fresh `ok`
/// latest release: `(pluginId, first x.y.z of --version)`.
fn probe(
    env: &Env,
    cwd: &Path,
    config: &Config,
    latest: &BTreeMap<String, Latest>,
    plugins: &mut Plugins,
) -> Result<Vec<(String, String)>, Stop> {
    static VERSION: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new("[0-9]+\\.[0-9]+\\.[0-9]+").ok());
    let start = Instant::now();
    let mut found = Vec::new();
    for id in enabled(config) {
        let Some(remaining) = PROBE_BUDGET
            .checked_sub(start.elapsed())
            .filter(|r| !r.is_zero())
        else {
            break; // budget spent: stay silent about the rest
        };
        // `Math.min(PER_TOOL_MS, Math.ceil(remaining))`.
        let ceil_ms = u64::try_from(remaining.as_micros().div_ceil(1000)).unwrap_or(u64::MAX);
        let timeout = PER_TOOL.min(Duration::from_millis(ceil_ms));
        let Some(tool) = plugins.tool(&id)? else {
            continue;
        };
        let Some(binary) = text(member(&tool, "checkBinary")) else {
            continue;
        };
        if !latest.get(&id).is_some_and(|l| l.version.is_some()) || !has_binary(env, cwd, &binary) {
            continue;
        }
        let Ok(out) = process::run(&binary, &["--version"], cwd, env, None, timeout) else {
            continue;
        };
        if out.status.code() != Some(0) {
            continue;
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let Some(version) = VERSION.as_ref().and_then(|re| re.find(&stdout)) else {
            continue;
        };
        found.push((id, version.as_str().to_owned()));
    }
    Ok(found)
}

/// `scanToolUpdates(config, { dedupe: true, budgetMs })`, from `now`.
fn scan(
    env: &Env,
    cwd: &Path,
    config: &Config,
    plugins: &mut Plugins,
) -> Result<Vec<Update>, Stop> {
    if !machine_eligible(env) {
        return Ok(Vec::new());
    }
    let now = now_ms();
    let dir = state_dir(env)?;
    let latest = read_latest(&dir, now, plugins)?;
    let delivered = record(read_state(&dir.join("notice.json"))?.as_ref());
    let mut updates = Vec::new();
    for (plugin_id, installed) in probe(env, cwd, config, &latest, plugins)? {
        let (
            Some(Latest {
                version: Some(version),
            }),
            Some(release),
        ) = (latest.get(&plugin_id), plugins.watched(&plugin_id)?)
        else {
            continue;
        };
        if !meets_notify_level(&installed, version, &release.notify) {
            continue;
        }
        if let Some(prior) = delivered.get(&plugin_id) {
            // An invalid stamp (future or corrupt) suppresses: fail closed, never nag.
            let Some(at) = stamp(prior, now) else {
                continue;
            };
            if text(member(prior, "version")).as_deref() == Some(version.as_str()) && now - at < DAY
            {
                continue;
            }
        }
        updates.push(Update {
            plugin_id,
            installed,
            latest: version.clone(),
        });
    }
    Ok(updates)
}

/// `prepareToolNotices(config)`: reserve due refreshes (handing the token to `spawn_worker`), then
/// the cache-only notices to deliver. A TS throw is an empty list.
///
/// # Errors
/// [`Stop::Delegate`] only, and only from branches [`precheck`] did not see (a state file that
/// changed in between).
pub fn prepare(
    env: &Env,
    cwd: &Path,
    config: &Config,
    plugins: &mut Plugins,
    spawn_worker: &dyn Fn(&str, &str),
) -> Result<Vec<Update>, Stop> {
    let run = |plugins: &mut Plugins| -> Result<Vec<Update>, Stop> {
        if !machine_eligible(env) {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        for id in enabled(config) {
            if plugins.watched(&id)?.is_some() {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(token) = reserve_refresh(env, &ids, now_ms(), plugins)? {
            spawn_worker(WORKER_ARG, &token);
        }
        let mut updates = scan(env, cwd, config, plugins)?;
        updates.truncate(MAX_NOTICES);
        Ok(updates)
    };
    match run(plugins) {
        Err(Stop::Throw) => Ok(Vec::new()),
        other => other,
    }
}

/// `toolNoticeText(lang, …)`.
#[must_use]
pub fn notice_text(lang: Lang, update: &Update) -> String {
    let Update {
        plugin_id,
        installed,
        latest,
    } = update;
    match lang {
        Lang::Es => format!(
            "Hay una versión nueva de {plugin_id}: {latest} (instalada: {installed}). Avísale al usuario una vez; `navori doctor` muestra el detalle."
        ),
        Lang::En => format!(
            "A newer {plugin_id} is available: {latest} (installed: {installed}). Tell the user once; `navori doctor` shows the detail."
        ),
    }
}

/// `toolNoticeOutput()`'s text for `updates`: the sentinel line and one line per tool, or `""`.
#[must_use]
pub fn output(lang: Lang, updates: &[Update]) -> String {
    if updates.is_empty() {
        return String::new();
    }
    let ack: Vec<String> = updates
        .iter()
        .map(|u| format!("{}@{}", u.plugin_id, u.latest))
        .collect();
    let lines: Vec<String> = updates.iter().map(|u| notice_text(lang, u)).collect();
    format!("{SENTINEL}{}\n{}\n", ack.join(","), lines.join("\n"))
}

/// `ackToolNotices(pairs, now)`: stamp delivery of `pluginId@x.y.z` pairs. Best effort: a TS
/// throw writes nothing and is not an error.
///
/// # Errors
/// [`Stop::Delegate`] only, from branches [`precheck`] did not see.
pub fn ack(env: &Env, pairs: &[&str], plugins: &mut Plugins) -> Result<(), Stop> {
    let run = |plugins: &mut Plugins| -> Result<(), Stop> {
        let now = now_ms();
        let dir = state_dir(env)?;
        locked(&dir, || {
            let path = dir.join("notice.json");
            let mut notices = JsObject::new();
            for (id, value) in record(read_state(&path)?.as_ref()).ordered() {
                let id = id
                    .to_rust()
                    .ok_or(Stop::Delegate("lone surrogate in state"))?;
                if plugins.watched(&id)?.is_some()
                    && stamp(value, now).is_some()
                    && stable_version(member(value, "version")).is_some()
                {
                    notices.insert(id, value.clone());
                }
            }
            let mut changed = false;
            for pair in pairs {
                let parts: Vec<&str> = pair.split('@').collect();
                let (Some(id), Some(version), 2) = (parts.first(), parts.get(1), parts.len())
                else {
                    continue;
                };
                let version = JsValue::string(version);
                let Some(version) = stable_version(Some(&version)) else {
                    continue;
                };
                if id.is_empty() || plugins.watched(id)?.is_none() {
                    continue;
                }
                let mut notice = JsObject::new();
                notice.insert("at", JsValue::Number(now));
                notice.insert("version", JsValue::string(&version));
                notices.insert(*id, JsValue::Object(notice));
                changed = true;
            }
            if changed {
                let body = JsValue::Object(notices)
                    .stringify(None)
                    .ok_or(Stop::Delegate("notices did not serialize"))?;
                write_file_atomic(&path, body.as_bytes()).map_err(|_| Stop::Throw)?;
            }
            Ok(())
        })
        .map(|_| ())
    };
    match run(plugins) {
        Err(Stop::Throw) => Ok(()),
        other => other,
    }
}

/// `Number(reserve)` of `--notice-reserve`: `Some` for digits that make a safe integer.
#[must_use]
pub fn notice_reserve(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|n| safe_integer(*n))
        .map(|n| n as u64)
}
