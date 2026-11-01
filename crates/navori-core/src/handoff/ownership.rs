//! The CLI-owned delivery ownership record and native actor identities
//! (`lib/handoff/actor-provenance.ts`, spec 0060 T10/T11): `readOwnership`, `currentOwnership`
//! and `independentActor`. Reading only; `attestHandoff` and `nativeActor` stay in the TS.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::Unmodeled;
use crate::content_identity::hex;
use crate::js_json::{JsObject, JsValue};
use crate::state_files::{Refusal, StateRoot, artifact_path, resolve_state_root};

/// `NativeActorSchema`: a verified native context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeActor {
    pub host: String,
    pub thread: String,
    pub root: String,
    pub parent: String,
    pub role: String,
    pub version: String,
    pub source_cwd: String,
    pub source_hash: String,
}

/// `OwnershipSchema`: `ownership_<feature>.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownership {
    pub feature: String,
    pub cwd: String,
    pub target: String,
    pub head: String,
    pub base: Option<String>,
    pub fingerprint: String,
    pub handoff: String,
    pub actors: Vec<NativeActor>,
    pub files: BTreeMap<String, String>,
}

const ACTOR_KEYS: [&str; 8] = [
    "host",
    "thread",
    "root",
    "parent",
    "role",
    "version",
    "sourceCwd",
    "sourceHash",
];

const OWNERSHIP_KEYS: [&str; 9] = [
    "feature",
    "cwd",
    "target",
    "head",
    "base",
    "fingerprint",
    "handoff",
    "actors",
    "files",
];

/// Any string (or key) holding a lone surrogate: zod accepts it, Rust text cannot carry it.
pub(crate) fn has_lone_surrogate(value: &JsValue) -> bool {
    match value {
        JsValue::String(s) => s.to_rust().is_none(),
        JsValue::Array(items) => items.iter().any(has_lone_surrogate),
        JsValue::Object(o) => o
            .entries()
            .iter()
            .any(|(k, v)| k.to_rust().is_none() || has_lone_surrogate(v)),
        _ => false,
    }
}

/// `z.strictObject`: exactly `keys`, every one present.
pub(crate) fn strict<'a>(value: &'a JsValue, keys: &[&str]) -> Option<&'a JsObject> {
    let JsValue::Object(o) = value else {
        return None;
    };
    let known = o
        .entries()
        .iter()
        .all(|(k, _)| keys.iter().any(|key| k.is(key)));
    (known && keys.iter().all(|k| o.has(k))).then_some(o)
}

pub(crate) fn string(o: &JsObject, key: &str) -> Option<String> {
    match o.get(key)? {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

/// `/^[0-9a-f-]{36}$/`.
fn actor_id(text: &str) -> bool {
    text.len() == 36
        && text
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// `NativeActorSchema.safeParse(value)`.
#[must_use]
pub fn parse_actor(value: &JsValue) -> Option<NativeActor> {
    let o = strict(value, &ACTOR_KEYS)?;
    let actor = NativeActor {
        host: string(o, "host").filter(|h| h == "codex")?,
        thread: string(o, "thread").filter(|t| actor_id(t))?,
        root: string(o, "root").filter(|t| actor_id(t))?,
        parent: string(o, "parent").filter(|t| actor_id(t))?,
        role: string(o, "role")
            .filter(|r| matches!(r.as_str(), "implementer" | "scribe" | "reviewer"))?,
        version: string(o, "version").filter(|v| matches!(v.as_str(), "0.162.1" | "0.163.0"))?,
        source_cwd: string(o, "sourceCwd")?,
        source_hash: string(o, "sourceHash")?,
    };
    Some(actor)
}

/// `OwnershipSchema.safeParse(value)`, for a value without lone surrogates.
fn parse_ownership(value: &JsValue) -> Option<Ownership> {
    let o = strict(value, &OWNERSHIP_KEYS)?;
    let base = match o.get("base")? {
        JsValue::Null => None,
        JsValue::String(s) => Some(s.to_rust()?),
        _ => return None,
    };
    let JsValue::Array(items) = o.get("actors")? else {
        return None;
    };
    let actors = items.iter().map(parse_actor).collect::<Option<Vec<_>>>()?;
    if actors.is_empty() {
        return None;
    }
    let JsValue::Object(files) = o.get("files")? else {
        return None;
    };
    let files = files
        .entries()
        .iter()
        .map(|(k, v)| match v {
            JsValue::String(s) => Some((k.to_rust()?, s.to_rust()?)),
            _ => None,
        })
        .collect::<Option<BTreeMap<_, _>>>()?;
    Some(Ownership {
        feature: string(o, "feature")?,
        cwd: string(o, "cwd")?,
        target: string(o, "target")?,
        head: string(o, "head")?,
        base,
        fingerprint: string(o, "fingerprint")?,
        handoff: string(o, "handoff")?,
        actors,
        files,
    })
}

/// `resolveStateRoot({ cwd, feature, dir })` inside a `try`: a thrown message is `Ok(None)`.
fn root_for(cwd: &str, feature: &str, dir: Option<&str>) -> Result<Option<StateRoot>, Unmodeled> {
    match resolve_state_root(cwd, cwd, feature, dir) {
        Ok(root) => Ok(Some(root)),
        Err(Refusal::Message(_)) => Ok(None),
        Err(Refusal::Unmodeled) => Err(Unmodeled),
    }
}

/// `stateArtifactPath(root, name)` inside a `try`.
fn artifact(root: &StateRoot, name: &str) -> Result<Option<String>, Unmodeled> {
    match artifact_path(root, name) {
        Ok(path) => Ok(Some(path)),
        Err(Refusal::Message(_)) => Ok(None),
        Err(Refusal::Unmodeled) => Err(Unmodeled),
    }
}

/// Reads a JSON state document: `Ok(None)` when it is absent (the TS's caught `ENOENT`),
/// [`Unmodeled`] for anything else that is not a JSON document Rust reads exactly.
pub(crate) fn read_json(path: &str) -> Result<Option<JsValue>, Unmodeled> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Unmodeled),
    };
    let text = String::from_utf8(bytes).map_err(|_| Unmodeled)?;
    let value = crate::js_json::parse(&text).ok_or(Unmodeled)?;
    if has_lone_surrogate(&value) {
        return Err(Unmodeled);
    }
    Ok(Some(value))
}

/// `readOwnership(cwd, feature, dir)`.
///
/// # Errors
/// [`Unmodeled`] when the TS's answer depends on something this port does not reproduce.
pub fn read_ownership(
    cwd: &str,
    feature: &str,
    dir: Option<&str>,
) -> Result<Option<Ownership>, Unmodeled> {
    let Some(root) = root_for(cwd, feature, dir)? else {
        return Ok(None);
    };
    let Some(path) = artifact(&root, &format!("ownership_{feature}.json"))? else {
        return Ok(None);
    };
    // A directory or unreadable file throws inside the TS's `try`: `undefined`.
    if std::fs::metadata(&path).is_ok_and(|m| m.is_dir()) {
        return Ok(None);
    }
    Ok(read_json(&path)?.as_ref().and_then(parse_ownership))
}

/// `hasParallelAuthority(cwd, feature, dir)`: `parallel_<feature>.json` exists (as any entry).
///
/// # Errors
/// [`Unmodeled`] when the TS would throw.
pub fn has_parallel_authority(
    cwd: &str,
    feature: &str,
    dir: Option<&str>,
) -> Result<bool, Unmodeled> {
    let root = resolve_state_root(cwd, cwd, feature, dir).map_err(|_| Unmodeled)?;
    match std::fs::symlink_metadata(format!("{}/parallel_{feature}.json", root.path)) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Unmodeled),
    }
}

/// The inputs of `currentOwnership`.
#[derive(Debug, Clone, Copy)]
pub struct OwnershipQuery<'a> {
    pub cwd: &'a str,
    pub feature: &'a str,
    pub target: &'a str,
    pub fingerprint: &'a str,
    pub head: &'a str,
    pub base: Option<&'a str>,
    pub dir: Option<&'a str>,
}

/// `currentOwnership(...)`: the ownership record bound to these bytes, base and handoff.
/// A parallel authority (`parallelOwnershipValid`) is not ported and is [`Unmodeled`].
///
/// # Errors
/// [`Unmodeled`] when the TS's answer depends on something this port does not reproduce.
pub fn current_ownership(q: &OwnershipQuery<'_>) -> Result<Option<Ownership>, Unmodeled> {
    let Some(ownership) = read_ownership(q.cwd, q.feature, q.dir)? else {
        return Ok(None);
    };
    let real = std::fs::canonicalize(q.cwd).map_err(|_| Unmodeled)?;
    let real = real.to_str().ok_or(Unmodeled)?;
    if ownership.cwd != real
        || ownership.target != q.target
        || q.head.is_empty()
        || ownership.base.as_deref() != q.base
    {
        return Ok(None);
    }
    let parallel = match resolve_state_root(q.cwd, q.cwd, q.feature, q.dir) {
        Ok(_) => has_parallel_authority(q.cwd, q.feature, q.dir)?,
        Err(Refusal::Message(_)) => return Ok(None),
        Err(Refusal::Unmodeled) => return Err(Unmodeled),
    };
    if parallel {
        return Err(Unmodeled);
    }
    if ownership.fingerprint != q.fingerprint {
        return Ok(None);
    }
    let Some(root) = root_for(q.cwd, q.feature, q.dir)? else {
        return Ok(None);
    };
    let Some(path) = artifact(&root, &format!("impl_{}.json", q.feature))? else {
        return Ok(None);
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    Ok((hex(&Sha256::digest(&bytes)) == ownership.handoff).then_some(ownership))
}

/// `independentActor(reviewer, producers)`: a reviewer in the producers' root context, never one
/// of their threads.
#[must_use]
pub fn independent_actor(reviewer: &NativeActor, producers: &[NativeActor]) -> bool {
    reviewer.role == "reviewer"
        && !producers.is_empty()
        && producers.iter().all(|p| {
            p.root == reviewer.root
                && !(p.host == reviewer.host
                    && p.root == reviewer.root
                    && p.thread == reviewer.thread)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(thread: &str, role: &str) -> NativeActor {
        NativeActor {
            host: "codex".into(),
            thread: thread.into(),
            root: "r".into(),
            parent: "p".into(),
            role: role.into(),
            version: "0.162.1".into(),
            source_cwd: "/".into(),
            source_hash: "h".into(),
        }
    }

    #[test]
    fn independence_needs_a_reviewer_outside_the_producer_threads() {
        let producers = [actor("a", "implementer")];
        assert!(independent_actor(&actor("b", "reviewer"), &producers));
        assert!(!independent_actor(&actor("a", "reviewer"), &producers));
        assert!(!independent_actor(&actor("b", "scribe"), &producers));
        assert!(!independent_actor(&actor("b", "reviewer"), &[]));
    }
}
