//! `nativeActor(cwd)` (`lib/handoff/actor-provenance.ts`, spec 0060 T10): the verified native
//! Codex context of this process, read from the one session file of `CODEX_THREAD_ID` under
//! `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/` (bounded, first line only). Git runs through a
//! [`ProcessRunner`] (D42).

use std::ffi::OsStr;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::Unmodeled;
use super::ownership::{NativeActor, has_lone_surrogate, string};
use crate::content_identity::hex;
use crate::js_json::{JsObject, JsValue};
use crate::process::{Env, ProcessRunner, Request};

/// `process.env[key]`.
#[must_use]
pub fn env_var<'a>(env: &'a Env, key: &str) -> Option<&'a OsStr> {
    env.iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_os_str())
}

/// `/^[0-9a-f-]{36}$/`.
fn actor_id(text: &str) -> bool {
    text.len() == 36
        && text
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

fn digits(name: &str, n: usize) -> bool {
    name.len() == n && name.bytes().all(|b| b.is_ascii_digit())
}

/// `readdirSync(dir, { withFileTypes: true })`, sorted by bytes like libuv's `scandir`:
/// `(name, is_directory)`; `None` when the TS would throw (then `nativeActor` is `undefined`).
fn entries(dir: &Path) -> Result<Option<Vec<(String, bool)>>, Unmodeled> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for entry in read {
        let Ok(entry) = entry else {
            return Ok(None);
        };
        let name = entry.file_name().into_string().map_err(|_| Unmodeled)?;
        let is_dir = entry.file_type().map_err(|_| Unmodeled)?.is_dir();
        out.push((name, is_dir));
    }
    out.sort();
    Ok(Some(out))
}

/// `commonDir(cwd)`: the realpath of `git rev-parse --path-format=absolute --git-common-dir`.
fn common_dir(cwd: &Path, runner: &dyn ProcessRunner, env: &Env) -> Option<PathBuf> {
    let output = runner
        .run(&Request {
            program: "git",
            args: &[
                "-c",
                "core.fsmonitor=false",
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            cwd,
            env,
            input: None,
            timeout: Duration::from_secs(2),
        })
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    std::fs::canonicalize(crate::posix::js_trim(&text)).ok()
}

fn field<'a>(o: &'a JsObject, key: &str) -> Option<&'a JsObject> {
    match o.get(key)? {
        JsValue::Object(inner) => Some(inner),
        _ => None,
    }
}

/// The first line of the session file, as `HeaderSchema` reads it.
struct Header {
    id: String,
    session_id: String,
    parent: String,
    version: String,
    cwd: String,
    role: String,
    spawn_parent: String,
    spawn_role: String,
}

fn header(value: &JsValue) -> Option<Header> {
    let JsValue::Object(o) = value else {
        return None;
    };
    (string(o, "type")? == "session_meta").then_some(())?;
    let p = field(o, "payload")?;
    let spawn = field(field(field(p, "source")?, "subagent")?, "thread_spawn")?;
    let role = |r: String| matches!(r.as_str(), "implementer" | "scribe" | "reviewer").then_some(r);
    Some(Header {
        id: string(p, "id").filter(|t| actor_id(t))?,
        session_id: string(p, "session_id").filter(|t| actor_id(t))?,
        parent: string(p, "parent_thread_id").filter(|t| actor_id(t))?,
        version: string(p, "cli_version")
            .filter(|v| matches!(v.as_str(), "0.162.1" | "0.163.0"))?,
        cwd: string(p, "cwd")?,
        role: role(string(p, "agent_role")?)?,
        spawn_parent: string(spawn, "parent_thread_id").filter(|t| actor_id(t))?,
        spawn_role: role(string(spawn, "agent_role")?)?,
    })
}

/// `nativeActor(cwd)`: `Ok(None)` wherever the TS answers `undefined`.
///
/// # Errors
/// [`Unmodeled`] where its answer depends on something this port does not reproduce (a name or a
/// header that is not UTF-8, JSON Rust does not read exactly).
pub fn native_actor(
    cwd: &Path,
    env: &Env,
    runner: &dyn ProcessRunner,
) -> Result<Option<NativeActor>, Unmodeled> {
    let Some(thread) = env_var(env, "CODEX_THREAD_ID") else {
        return Ok(None);
    };
    let thread = thread.to_str().ok_or(Unmodeled)?;
    if !actor_id(thread) {
        return Ok(None);
    }
    let home = match env_var(env, "CODEX_HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(env_var(env, "HOME").ok_or(Unmodeled)?).join(".codex"),
    };
    let sessions = home.join("sessions");
    let suffix = format!("{thread}.jsonl");
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut scanned = 0;
    let Some(years) = entries(&sessions)? else {
        return Ok(None);
    };
    for (year, is_dir) in years {
        if !is_dir || !digits(&year, 4) {
            continue;
        }
        let Some(months) = entries(&sessions.join(&year))? else {
            return Ok(None);
        };
        for (month, is_dir) in months {
            if !is_dir || !digits(&month, 2) {
                continue;
            }
            let Some(days) = entries(&sessions.join(&year).join(&month))? else {
                return Ok(None);
            };
            for (day, is_dir) in days {
                scanned += 1;
                if scanned > 4096 {
                    return Ok(None);
                }
                if !is_dir || !digits(&day, 2) {
                    continue;
                }
                let dir = sessions.join(&year).join(&month).join(&day);
                let Some(files) = entries(&dir)? else {
                    return Ok(None);
                };
                candidates.extend(
                    files
                        .into_iter()
                        .filter(|(name, _)| name.ends_with(&suffix))
                        .map(|(name, _)| dir.join(name)),
                );
            }
        }
    }
    let [candidate] = candidates.as_slice() else {
        return Ok(None);
    };
    let Ok(mut file) = std::fs::File::open(candidate) else {
        return Ok(None);
    };
    let mut buffer = Vec::with_capacity(65536);
    if file.by_ref().take(65536).read_to_end(&mut buffer).is_err() {
        return Ok(None);
    }
    let Some(newline) = buffer.iter().position(|b| *b == b'\n') else {
        return Ok(None);
    };
    let raw = std::str::from_utf8(&buffer[..newline]).map_err(|_| Unmodeled)?;
    let value = crate::js_json::parse(raw).ok_or(Unmodeled)?;
    if has_lone_surrogate(&value) {
        return Err(Unmodeled);
    }
    let Some(h) = header(&value) else {
        return Ok(None);
    };
    if h.id != thread || h.parent != h.spawn_parent || h.role != h.spawn_role {
        return Ok(None);
    }
    let source = Path::new(&h.cwd);
    let (Some(theirs), Some(ours)) = (
        common_dir(source, runner, env),
        common_dir(cwd, runner, env),
    ) else {
        return Ok(None);
    };
    if theirs != ours {
        return Ok(None);
    }
    let Ok(source_cwd) = std::fs::canonicalize(source) else {
        return Ok(None);
    };
    let source_cwd = source_cwd.to_str().ok_or(Unmodeled)?.to_owned();
    Ok(Some(NativeActor {
        host: "codex".into(),
        thread: thread.to_owned(),
        root: h.session_id,
        parent: h.parent,
        role: h.role,
        version: h.version,
        source_cwd,
        source_hash: hex(&Sha256::digest(raw.as_bytes())),
    }))
}
