//! Port of `lib/primitives/update-notice.ts` (spec 0062 T9, R85): the daily "a newer navori is
//! available" line on stderr, and the detached worker that asks the npm registry for the latest
//! release.
//!
//! The command path never waits for the network: under the state directory's lock it decides
//! whether to print (a cached latest release, newer than this CLI, at most once a day) and whether
//! to reserve today's registry attempt with a one-use token, which it hands to `spawn_worker`. The
//! worker claims the token and fetches through an [`HttpClient`]. The state files are the TS's
//! (`~/.navori/update-notice/{latest,notice,attempt}.json`), so both CLIs share one daily budget.
//!
//! Like the TS, every failure is silent: the notice is optional and never affects the command.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use super::cache::{DAY, locked, machine_eligible, read_state, stable_version, stamp};
use crate::atomic::{random_uuid, write_file_atomic};
use crate::http::{HttpClient, HttpRequest, get_json};
use crate::js_json::{self, JsObject, JsValue};
use crate::process::Env;
use crate::render::context::Lang;
use crate::semver;
use crate::workspace::registry::{self, Stop};

/// `UPDATE_NOTICE_WORKER_ARG`.
pub const WORKER_ARG: &str = "--navori-private-update-worker";
/// `REGISTRY`.
pub const REGISTRY: &str = "https://registry.npmjs.org/navori/latest";
/// `MAX_BYTES`.
const MAX_BYTES: usize = 16 * 1024;
/// `fetchLatestVersion`'s default timeout.
const TIMEOUT: Duration = Duration::from_millis(2_000);

static TOKEN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new("^[0-9a-f-]{36}$").ok());

fn token_shape(token: &str) -> bool {
    TOKEN.as_ref().is_some_and(|re| re.is_match(token))
}

/// `~/.navori/update-notice`.
fn state_dir(env: &Env) -> Result<PathBuf, Stop> {
    Ok(registry::home(env)?.join(".navori").join("update-notice"))
}

/// `readState`, with JSON outside the port's model read as invalid (the notice stays silent).
fn state(path: &Path) -> Option<JsValue> {
    read_state(path).ok().flatten()
}

fn member<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// `validAttempt`.
fn valid_attempt(value: &JsValue, now: f64) -> bool {
    stamp(value, now).is_some()
        && match member(value, "token") {
            Some(JsValue::Null) => true,
            Some(JsValue::String(token)) => token.to_rust().is_some_and(|t| token_shape(&t)),
            _ => false,
        }
}

/// `validLatest`: its version, when the record is valid.
fn valid_latest(value: &JsValue, now: f64) -> Option<String> {
    stamp(value, now)?;
    stable_version(member(value, "version"))
}

/// `eligible(argv)`, with the two TTY checks passed in.
#[must_use]
pub fn eligible(env: &Env, argv: &[&str], stdout_tty: bool, stderr_tty: bool) -> bool {
    machine_eligible(env)
        && stdout_tty
        && stderr_tty
        && !argv
            .iter()
            .any(|a| *a == "--json" || a.starts_with("--json="))
        && !argv.is_empty()
        && !argv
            .iter()
            .any(|a| matches!(*a, "--help" | "-h" | "--version" | "-v"))
}

/// `language(argv)`: `--cwd`'s (or the process's) `navori.config.json` `language`, `es` when it
/// cannot be read.
#[must_use]
pub fn language(argv: &[&str], process_cwd: &Path) -> Lang {
    let value = match argv.iter().position(|a| *a == "--cwd") {
        Some(index) => argv.get(index + 1).copied(),
        None => argv.iter().find_map(|a| a.strip_prefix("--cwd=")),
    };
    let root = match value {
        Some(cwd) if !cwd.is_empty() && !cwd.starts_with('-') => process_cwd.join(cwd),
        _ => process_cwd.to_path_buf(),
    };
    let Ok(text) = std::fs::read_to_string(root.join("navori.config.json")) else {
        return Lang::Es;
    };
    match js_json::parse(&text)
        .as_ref()
        .and_then(|raw| member(raw, "language"))
    {
        Some(JsValue::String(lang)) => Lang::resolve(lang.to_rust().as_deref()),
        _ => Lang::Es,
    }
}

/// `updateNoticeText(lang, current, latest)`.
#[must_use]
pub fn notice_text(lang: Lang, current: &str, latest: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori {latest} disponible (actual: {current}). Actualiza con: navori update\n\
             Versiones: https://ulisescm.github.io/navori-harness/versiones/\n"
        ),
        Lang::En => format!(
            "navori {latest} available (current: {current}). Update with: navori update\n\
             Releases: https://ulisescm.github.io/navori-harness/en/releases/\n"
        ),
    }
}

fn write_json(path: &Path, value: JsObject) -> Result<(), Stop> {
    let text = JsValue::Object(value).stringify(None).ok_or(Stop::Throw)?;
    write_file_atomic(path, text.as_bytes()).map_err(|_| Stop::Throw)
}

/// `Date.now()` as the JSON number the TS writes.
const fn number(value: f64) -> JsValue {
    JsValue::Number(value)
}

/// What [`run_update_notice`] decided under the lock.
#[derive(Debug, Default)]
struct Outcome {
    version: Option<String>,
    token: Option<String>,
}

/// `runUpdateNotice(installed, argv)`: the notice text to write on stderr, if any. `spawn_worker`
/// receives the worker flag and the reserved token; it must not wait for the child.
#[must_use]
#[allow(
    clippy::too_many_arguments,
    reason = "the TS reads these from `process`; here each one is injected"
)]
pub fn run_update_notice(
    env: &Env,
    process_cwd: &Path,
    installed: &str,
    argv: &[&str],
    stdout_tty: bool,
    stderr_tty: bool,
    now: f64,
    spawn_worker: &dyn Fn(&str, &str),
) -> Option<String> {
    if !eligible(env, argv, stdout_tty, stderr_tty)
        || stable_version(Some(&JsValue::string(installed))).is_none()
    {
        return None;
    }
    let dir = state_dir(env).ok()?;
    let outcome = locked(&dir, || {
        let notice_path = dir.join("notice.json");
        let attempt_path = dir.join("attempt.json");
        let latest = state(&dir.join("latest.json"));
        let previous_notice = state(&notice_path);
        let previous_attempt = state(&attempt_path);
        let mut outcome = Outcome::default();
        let can_notice = !notice_path.exists()
            || previous_notice
                .as_ref()
                .and_then(|n| stamp(n, now))
                .is_some_and(|at| now - at >= DAY);
        let can_attempt = !attempt_path.exists()
            || previous_attempt
                .as_ref()
                .filter(|a| valid_attempt(a, now))
                .and_then(|a| stamp(a, now))
                .is_some_and(|at| now - at >= DAY);
        if let Some(latest) = latest.as_ref()
            && let Some(version) = valid_latest(latest, now)
            && stamp(latest, now).is_some_and(|at| now - at < DAY)
            && semver::compare(Some(&version), Some(installed)) == Some(Ordering::Greater)
            && can_notice
        {
            let mut notice = JsObject::new();
            notice.insert("at", number(now));
            write_json(&notice_path, notice)?;
            outcome.version = Some(version);
        }
        if can_attempt {
            let token = random_uuid().map_err(|_| Stop::Throw)?;
            let mut attempt = JsObject::new();
            attempt.insert("at", number(now));
            attempt.insert("token", JsValue::string(&token));
            write_json(&attempt_path, attempt)?;
            outcome.token = Some(token);
        }
        Ok(outcome)
    })
    .ok()
    .flatten()?;
    let text = outcome
        .version
        .map(|latest| notice_text(language(argv, process_cwd), installed, &latest));
    if let Some(token) = &outcome.token {
        spawn_worker(WORKER_ARG, token);
    }
    text
}

/// `fetchLatestVersion()`: the latest stable navori on npm, `None` when offline, slow, oversized
/// or malformed.
#[must_use]
pub fn fetch_latest_version(http: &dyn HttpClient) -> Option<String> {
    let body = get_json(
        http,
        &HttpRequest {
            url: REGISTRY,
            headers: &[],
            timeout: TIMEOUT,
            max_bytes: MAX_BYTES,
        },
    )?;
    stable_version(member(&body, "version"))
}

/// `runUpdateNoticeWorker(token)`: claim the one-use reservation, then ask the registry and cache
/// a stable answer. `now` is `Date.now()`, read at each of the TS's two reads.
pub fn run_update_worker(
    env: &Env,
    token: Option<&str>,
    http: &dyn HttpClient,
    now: &dyn Fn() -> f64,
) {
    let Some(token) = token.filter(|t| token_shape(t)) else {
        return;
    };
    let Ok(dir) = state_dir(env) else {
        return;
    };
    let claimed = locked(&dir, || {
        let path = dir.join("attempt.json");
        let Some(value) = state(&path) else {
            return Ok(false);
        };
        let at = stamp(&value, now());
        let mine = valid_attempt(&value, now())
            && matches!(member(&value, "token"), Some(JsValue::String(t)) if t.to_rust().as_deref() == Some(token));
        let Some(at) = at.filter(|at| mine && now() - at < DAY) else {
            return Ok(false);
        };
        let mut attempt = JsObject::new();
        attempt.insert("at", number(at));
        attempt.insert("token", JsValue::Null);
        write_json(&path, attempt)?;
        Ok(true)
    });
    if !matches!(claimed, Ok(Some(true))) {
        return;
    }
    let Some(version) = fetch_latest_version(http) else {
        return;
    };
    let mut latest = JsObject::new();
    latest.insert("at", number(now()));
    latest.insert("version", JsValue::string(&version));
    let _ = write_json(&dir.join("latest.json"), latest);
}
