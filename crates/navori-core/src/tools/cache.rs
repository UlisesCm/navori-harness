//! Port of `lib/primitives/remote-version-cache.ts` (spec 0059 D34): the per-machine state files,
//! their `mkdir` lock, and the value checks shared by the version notices. The network worker is
//! not here: the TS runs it (R59).

use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt as _;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::js_json::{self, JsValue};
use crate::process::Env;
use crate::workspace::registry::Stop;

/// `DAY`.
pub const DAY: f64 = 86_400_000.0;
/// `STATE_MAX_BYTES`, in UTF-16 units like `text.length`.
const STATE_MAX: usize = 16 * 1024;
/// `LOCK_STALE_MS`.
const LOCK_STALE: Duration = Duration::from_secs(60);
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Date.now()`.
#[must_use]
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `Number.isSafeInteger`.
#[must_use]
pub fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value && value.abs() <= MAX_SAFE_INTEGER
}

/// `stableVersion`: a strict `x.y.z` string, no leading zeros, safe integers only.
#[must_use]
pub fn stable_version(value: Option<&JsValue>) -> Option<String> {
    let Some(JsValue::String(text)) = value else {
        return None;
    };
    let text = text.to_rust()?;
    let parts: Vec<&str> = text.split('.').collect();
    let valid = parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (*part == "0" || !part.starts_with('0'))
                && part.parse::<f64>().is_ok_and(safe_integer)
        });
    valid.then_some(text)
}

/// `stamp(value, now)`: the `at` of an object whose `at` is a safe integer in `[0, now]`.
#[must_use]
pub fn stamp(value: &JsValue, now: f64) -> Option<f64> {
    let JsValue::Object(object) = value else {
        return None;
    };
    match object.get("at") {
        Some(JsValue::Number(at)) if safe_integer(*at) && *at >= 0.0 && *at <= now => Some(*at),
        _ => None,
    }
}

/// `readState(path)`: `None` for a missing, unreadable, oversized or invalid file, as the TS's
/// `undefined`.
///
/// # Errors
/// [`Stop::Delegate`] for JSON the port cannot tell from invalid (`js_json::parse` is `None` for
/// both).
pub fn read_state(path: &Path) -> Result<Option<JsValue>, Stop> {
    let Ok(bytes) = fs::read(path) else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.encode_utf16().count() > STATE_MAX {
        return Ok(None);
    }
    js_json::parse(&text)
        .map(Some)
        .ok_or(Stop::Delegate("state JSON outside the model"))
}

/// `locked(dir, action)`: `Ok(None)` when the lock is held (a stale one is removed for the next
/// run). The lock is released after the action, whatever it returned.
///
/// # Errors
/// The action's error, or [`Stop::Throw`] when the lock cannot be released (the TS's `finally`
/// throws).
pub fn locked<T>(dir: &Path, action: impl FnOnce() -> Result<T, Stop>) -> Result<Option<T>, Stop> {
    let lock = dir.join("lock");
    let acquired = DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .and_then(|()| fs::create_dir(&lock));
    if acquired.is_err() {
        // A lock mtime in the future (clock rewound) counts as fresh.
        let stale = fs::metadata(&lock)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > LOCK_STALE);
        if stale {
            let _ = fs::remove_dir(&lock);
        }
        return Ok(None);
    }
    let result = action();
    fs::remove_dir(&lock).map_err(|_| Stop::Throw)?;
    result.map(Some)
}

/// `machineEligible()`: no `NAVORI_NO_UPDATE_NOTIFIER=1` and no truthy `CI`.
#[must_use]
pub fn machine_eligible(env: &Env) -> bool {
    let var = |name: &str| {
        env.iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_string_lossy().into_owned())
    };
    if var("NAVORI_NO_UPDATE_NOTIFIER").as_deref() == Some("1") {
        return false;
    }
    match var("CI") {
        Some(ci) if !ci.is_empty() => matches!(ci.to_ascii_lowercase().as_str(), "0" | "false"),
        _ => true,
    }
}
