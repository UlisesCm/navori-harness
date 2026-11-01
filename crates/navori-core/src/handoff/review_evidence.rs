//! Verification of a review's producer evidence (`lib/handoff/review-evidence.ts`, spec 0042
//! D5/R16; spec 0060 T10/T11): `checkSealedEvidence`, `correlateReview` and
//! `reviewEvidenceWarning`. Reading only: `begin`, `seal` and the review gate stay in the TS.
//!
//! Every function answers `Err(Unmodeled)` where the TS's answer depends on something this port
//! does not reproduce (a JSON document Rust cannot read exactly, a path the TS would throw on, a
//! parallel authority), and the caller hands the whole command to the TS.

use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::Unmodeled;
use super::ownership::{
    OwnershipQuery, current_ownership, independent_actor, parse_actor, read_json, strict,
};
use super::review::{Sidecar, iso_now, parse_sidecar};
use crate::content_identity::{self, CONTENT_ALG, CONTENT_MAX_BYTES, CONTENT_TIMEOUT, hex};
use crate::diagnose::receipt::evidence_identity;
use crate::js_json::{JsObject, JsValue};
use crate::process::Env;
use crate::state_files::{Refusal, StateRoot, artifact_path, resolve_state_root};

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `/^[a-f0-9]{64}$/`.
fn hex64(text: &str) -> bool {
    is_hex(text, 64)
}

/// `/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/`.
fn git_sha(text: &str) -> bool {
    is_hex(text, 40) || is_hex(text, 64)
}

/// `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/`.
fn iso_utc(text: &str) -> bool {
    let b = text.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    if b.len() < 20 || !digits(0..4) || !digits(5..7) || !digits(8..10) || !digits(11..13) {
        return false;
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return false;
    }
    if !digits(14..16) || !digits(17..19) {
        return false;
    }
    match &b[19..] {
        [b'Z'] => true,
        [b'.', rest @ .., b'Z'] => !rest.is_empty() && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`.
fn uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| is_hex(p, n))
}

/// An optional field: absent is `Some(None)`; present and invalid is `None`.
fn opt<T>(o: &JsObject, key: &str, parse: impl Fn(&JsValue) -> Option<T>) -> Option<Option<T>> {
    o.get(key).map_or(Some(None), |v| parse(v).map(Some))
}

fn str_where(value: &JsValue, check: impl Fn(&str) -> bool) -> Option<String> {
    match value {
        JsValue::String(s) => s.to_rust().filter(|t| check(t)),
        _ => None,
    }
}

fn number_is(value: Option<&JsValue>, expected: f64) -> bool {
    matches!(value, Some(JsValue::Number(n)) if *n == expected)
}

/// The identity half shared by the stamp, the evidence and the gate run.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IdentityFields {
    fingerprint: String,
    base: Option<String>,
    gate: Option<String>,
    inputs: String,
}

/// `sameIdentity(a, b)`.
fn same_identity(a: &IdentityFields, b: &IdentityFields) -> bool {
    a == b
}

/// `IdentityShape`, parsed: the identity, `head`, `startedAt`, `reviewer` and `ownership`.
#[derive(Debug, Clone)]
struct Shape {
    identity: IdentityFields,
    head: String,
    started_at: String,
    reviewer: Option<JsValue>,
    ownership: Option<String>,
}

/// Keys a strict object accepts: required ones must be present, optional ones may be.
fn only_keys(o: &JsObject, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|k| o.has(k))
        && o.entries()
            .iter()
            .all(|(k, _)| required.iter().chain(optional).any(|key| k.is(key)))
}

fn shape(o: &JsObject) -> Option<Shape> {
    let base = match o.get("base")? {
        JsValue::Null => None,
        value => Some(str_where(value, git_sha)?),
    };
    let reviewer = opt(o, "reviewer", |v| parse_actor(v).map(|_| v.clone()))?;
    Some(Shape {
        identity: IdentityFields {
            fingerprint: str_where(o.get("fingerprint")?, hex64)?,
            base,
            gate: opt(o, "gate", |v| str_where(v, hex64))?,
            inputs: str_where(o.get("inputs")?, hex64)?,
        },
        head: str_where(o.get("head")?, git_sha)?,
        started_at: str_where(o.get("startedAt")?, iso_utc)?,
        reviewer,
        ownership: opt(o, "ownership", |v| str_where(v, hex64))?,
    })
}

/// `ReviewStampSchema`, parsed.
#[derive(Debug, Clone)]
struct Stamp {
    nonce: String,
    feature: String,
    target: Option<String>,
    shape: Shape,
}

/// `ReviewEditBindingSchema`.
fn edit_binding(value: &JsValue) -> Option<()> {
    let o = strict(
        value,
        &["v", "checkout", "gitDir", "commonDir", "stateDir", "target"],
    )?;
    if !number_is(o.get("v"), 1.0) {
        return None;
    }
    for key in ["checkout", "gitDir", "commonDir", "target"] {
        str_where(o.get(key)?, |t| !t.is_empty())?;
    }
    str_where(o.get("stateDir")?, |t| t == ".navori/state/handoffs")?;
    Some(())
}

fn parse_stamp(value: &JsValue) -> Option<Stamp> {
    let JsValue::Object(o) = value else {
        return None;
    };
    let optional = ["target", "editBinding", "gate", "reviewer", "ownership"];
    let required = [
        "v",
        "alg",
        "nonce",
        "feature",
        "fingerprint",
        "base",
        "head",
        "inputs",
        "startedAt",
    ];
    if !only_keys(o, &required, &optional) || !number_is(o.get("v"), 1.0) {
        return None;
    }
    str_where(o.get("alg")?, |a| a == CONTENT_ALG)?;
    opt(o, "editBinding", edit_binding)?;
    Some(Stamp {
        nonce: str_where(o.get("nonce")?, uuid)?,
        feature: str_where(o.get("feature")?, |f| !f.is_empty())?,
        target: opt(o, "target", |v| str_where(v, |_| true))?,
        shape: shape(o)?,
    })
}

/// `ReviewEvidenceSchema`, parsed, with the raw object for the seal.
#[derive(Debug, Clone)]
pub struct Evidence {
    /// `nonce`.
    pub nonce: String,
    /// `state`.
    pub state: String,
    /// `sealedAt`.
    pub sealed_at: String,
    seal: String,
    gate_run: Option<String>,
    shape: Shape,
    raw: JsObject,
}

impl Evidence {
    /// `startedAt`.
    #[must_use]
    pub fn started_at(&self) -> &str {
        &self.shape.started_at
    }
}

fn parse_evidence(value: &JsValue) -> Option<Evidence> {
    let JsValue::Object(o) = value else {
        return None;
    };
    let required = [
        "v",
        "alg",
        "state",
        "nonce",
        "sealedAt",
        "seal",
        "fingerprint",
        "base",
        "head",
        "inputs",
        "startedAt",
    ];
    let optional = [
        "sealedFingerprint",
        "gateRun",
        "gate",
        "reviewer",
        "ownership",
    ];
    if !only_keys(o, &required, &optional) || !number_is(o.get("v"), 1.0) {
        return None;
    }
    str_where(o.get("alg")?, |a| a == CONTENT_ALG)?;
    opt(o, "sealedFingerprint", |v| str_where(v, hex64))?;
    Some(Evidence {
        nonce: str_where(o.get("nonce")?, uuid)?,
        state: str_where(o.get("state")?, |s| {
            s == "validated" || s == "changed-during-review"
        })?,
        sealed_at: str_where(o.get("sealedAt")?, iso_utc)?,
        seal: str_where(o.get("seal")?, hex64)?,
        gate_run: opt(o, "gateRun", |v| str_where(v, hex64))?,
        shape: shape(o)?,
        raw: o.clone(),
    })
}

/// `canonical(value)`: deterministic JSON, keys sorted by UTF-16 code units, `undefined` dropped.
fn canonical(value: &JsValue) -> Option<String> {
    match value {
        JsValue::Array(items) => {
            let parts = items.iter().map(canonical).collect::<Option<Vec<_>>>()?;
            Some(format!("[{}]", parts.join(",")))
        }
        JsValue::Object(o) => {
            let mut entries: Vec<_> = o
                .entries()
                .iter()
                .filter(|(_, v)| !matches!(v, JsValue::Undefined))
                .collect();
            entries.sort_by(|a, b| a.0.units().cmp(b.0.units()));
            let parts = entries
                .iter()
                .map(|(k, v)| {
                    Some(format!(
                        "{}:{}",
                        JsValue::String(k.clone()).stringify(None)?,
                        canonical(v)?
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            Some(format!("{{{}}}", parts.join(",")))
        }
        other => other.stringify(None),
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `sealDigest(sidecar, body)`.
fn seal_digest(sidecar: &Sidecar, body: &JsObject) -> Option<String> {
    let mut head = JsObject::new();
    head.insert("feature", JsValue::string(&sidecar.feature));
    head.insert("verdict", sidecar.verdict.clone());
    let findings = sidecar
        .findings
        .iter()
        .map(|f| {
            let mut o = JsObject::new();
            for (k, v) in &f.fields {
                o.insert(*k, v.clone());
            }
            JsValue::Object(o)
        })
        .collect();
    head.insert("findings", JsValue::Array(findings));
    let text = format!(
        "{}\0{}",
        canonical(&JsValue::Object(head))?,
        canonical(&JsValue::Object(body.clone()))?
    );
    Some(sha256(text.as_bytes()))
}

fn refusal<T>(r: Result<T, Refusal>) -> Result<Option<T>, Unmodeled> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(Refusal::Message(_)) => Ok(None),
        Err(Refusal::Unmodeled) => Err(Unmodeled),
    }
}

/// A state artifact path the TS computes outside any `try`: a thrown message is [`Unmodeled`].
fn artifact(root: &StateRoot, name: &str) -> Result<String, Unmodeled> {
    artifact_path(root, name).map_err(|_| Unmodeled)
}

/// `readStamp(root, feature, nonce)`.
fn read_stamp(root: &StateRoot, feature: &str, nonce: &str) -> Result<Option<Stamp>, Unmodeled> {
    let path = artifact(root, &format!("review_{feature}.{nonce}.begin.json"))?;
    let Ok(meta) = std::fs::metadata(&path) else {
        return Ok(None);
    };
    // `readJson` swallows the `EISDIR` of a directory: `undefined`, which zod rejects.
    if meta.is_dir() {
        return Ok(None);
    }
    let stamp = read_json(&path)?.as_ref().and_then(parse_stamp);
    Ok(stamp.filter(|s| s.nonce == nonce && s.feature == feature))
}

/// `ReviewGateSchema` checks, then `reviewGateDigest(root, stamp)`: the digest of a finished,
/// matching gate run whose log still ends green, or `Ok(None)` where the TS throws.
fn review_gate_digest(root: &StateRoot, stamp: &Stamp) -> Result<Option<String>, Unmodeled> {
    let path = artifact(
        root,
        &format!("review_{}.{}.gate.json", stamp.feature, stamp.nonce),
    )?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let raw = String::from_utf8(bytes).map_err(|_| Unmodeled)?;
    let value = crate::js_json::parse(&raw).ok_or(Unmodeled)?;
    if super::ownership::has_lone_surrogate(&value) {
        return Err(Unmodeled);
    }
    let Some(run) = gate_run(&value) else {
        return Ok(None);
    };
    let now = iso_now();
    if run.feature != stamp.feature
        || run.nonce != stamp.nonce
        || run.cwd != root.cwd
        || Some(&run.target) != stamp.target.as_ref()
        || !same_identity(&stamp.shape.identity, &run.identity)
        || run.started_at < stamp.shape.started_at
        || run.finished_at < run.started_at
        || run.finished_at > now
    {
        return Ok(None);
    }
    if run.log.contains('\\') || run.log.contains('\0') {
        return Err(Unmodeled);
    }
    let resolved = crate::posix::resolve(&root.cwd, &run.log);
    let rel = crate::posix::relative(&root.cwd, &resolved);
    if run.log.starts_with('/') || rel.starts_with("..") || !rel.starts_with(".navori/state/gate/")
    {
        return Ok(None);
    }
    let Some(log_root) = refusal(resolve_state_root(
        &root.cwd,
        &root.cwd,
        "gate",
        Some(".navori/state/gate"),
    ))?
    else {
        return Ok(None);
    };
    let name = crate::posix::relative(&log_root.path, &resolved);
    let Some(safe) = refusal(artifact_path(&log_root, &name))? else {
        return Ok(None);
    };
    let Ok(log) = std::fs::read(&safe) else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&log);
    let last = crate::integrity::js_trim_end(&text)
        .rsplit('\n')
        .next()
        .unwrap_or_default();
    let sentinel = crate::gate::cache::pass_sentinel("full", &stamp.shape.identity.fingerprint);
    if sha256(&log) != run.log_hash || last != sentinel {
        return Ok(None);
    }
    Ok(Some(sha256(raw.as_bytes())))
}

struct GateRun {
    feature: String,
    nonce: String,
    cwd: String,
    target: String,
    identity: IdentityFields,
    started_at: String,
    finished_at: String,
    log: String,
    log_hash: String,
}

/// `ReviewGateSchema.parse(value)`, `None` where zod throws.
fn gate_run(value: &JsValue) -> Option<GateRun> {
    let JsValue::Object(o) = value else {
        return None;
    };
    let required = [
        "v",
        "feature",
        "nonce",
        "cwd",
        "target",
        "fingerprint",
        "base",
        "gate",
        "inputs",
        "startedAt",
        "finishedAt",
        "executorPid",
        "exitCode",
        "log",
        "logHash",
    ];
    if !only_keys(o, &required, &["executorSession"])
        || !number_is(o.get("v"), 1.0)
        || !number_is(o.get("exitCode"), 0.0)
    {
        return None;
    }
    match o.get("executorPid")? {
        JsValue::Number(n) if n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0 => {}
        _ => return None,
    }
    opt(o, "executorSession", |v| str_where(v, |_| true))?;
    let any = |key: &str| str_where(o.get(key)?, |_| true);
    let base = match o.get("base")? {
        JsValue::Null => None,
        value => Some(str_where(value, git_sha)?),
    };
    Some(GateRun {
        feature: any("feature")?,
        nonce: str_where(o.get("nonce")?, uuid)?,
        cwd: any("cwd")?,
        target: any("target")?,
        identity: IdentityFields {
            fingerprint: str_where(o.get("fingerprint")?, hex64)?,
            base,
            gate: Some(str_where(o.get("gate")?, hex64)?),
            inputs: str_where(o.get("inputs")?, hex64)?,
        },
        started_at: str_where(o.get("startedAt")?, iso_utc)?,
        finished_at: str_where(o.get("finishedAt")?, iso_utc)?,
        log: any("log")?,
        log_hash: str_where(o.get("logHash")?, hex64)?,
    })
}

/// `SealedCheck`.
#[derive(Debug, Clone)]
pub enum SealedCheck {
    /// `missing`, `invalid` or `unknown-algorithm`.
    Failed(&'static str),
    /// `sealed` or `changed-during-review`, with the verified evidence.
    Verified(&'static str, Box<Evidence>),
}

impl SealedCheck {
    /// The TS's `status`.
    #[must_use]
    pub fn status(&self) -> &'static str {
        match self {
            Self::Failed(s) | Self::Verified(s, _) => s,
        }
    }
}

/// `checkSealedEvidence(root, sidecar)`: shape, algorithm, the nonce's stamp and the seal, without
/// recomputing the content identity.
///
/// # Errors
/// [`Unmodeled`] when the TS's answer depends on something this port does not reproduce.
pub fn check_sealed_evidence(
    root: &StateRoot,
    sidecar: &Sidecar,
) -> Result<SealedCheck, Unmodeled> {
    let invalid = Ok(SealedCheck::Failed("invalid"));
    let Some(raw) = &sidecar.evidence else {
        return Ok(SealedCheck::Failed("missing"));
    };
    let JsValue::Object(declared) = raw else {
        return invalid;
    };
    if let (Some(JsValue::Number(v)), Some(JsValue::String(alg))) =
        (declared.get("v"), declared.get("alg"))
        && (*v != 1.0 || !alg.is(CONTENT_ALG))
    {
        return Ok(SealedCheck::Failed("unknown-algorithm"));
    }
    if super::ownership::has_lone_surrogate(raw) {
        return Err(Unmodeled);
    }
    let Some(evidence) = parse_evidence(raw) else {
        return invalid;
    };
    let Some(stamp) = read_stamp(root, &sidecar.feature, &evidence.nonce)? else {
        return invalid;
    };
    let reviewer = |v: &Option<JsValue>| v.as_ref().and_then(canonical);
    if !same_identity(&stamp.shape.identity, &evidence.shape.identity)
        || stamp.shape.head != evidence.shape.head
        || stamp.shape.started_at != evidence.shape.started_at
        || reviewer(&stamp.shape.reviewer) != reviewer(&evidence.shape.reviewer)
        || stamp.shape.ownership != evidence.shape.ownership
    {
        return invalid;
    }
    let mut body = evidence.raw.clone();
    body.remove("seal");
    if seal_digest(sidecar, &body).ok_or(Unmodeled)? != evidence.seal {
        return invalid;
    }
    if let Some(gate_run) = &evidence.gate_run
        && review_gate_digest(root, &stamp)?.as_ref() != Some(gate_run)
    {
        return invalid;
    }
    let status = if evidence.state == "validated" {
        "sealed"
    } else {
        "changed-during-review"
    };
    Ok(SealedCheck::Verified(status, Box::new(evidence)))
}

/// What `currentIdentity` needs from `EvidenceOptions`.
#[derive(Debug, Clone, Copy)]
pub struct EvidenceOptions<'a> {
    /// The resolved target branch.
    pub target: &'a str,
    /// `qualityGate.full`; `""` when none is configured.
    pub gate: &'a str,
    /// `currentContent`, already computed by the caller.
    pub current_content: Option<&'a Result<content_identity::Identity, content_identity::Failure>>,
    /// Bound on a content identity computed here.
    pub timeout: Option<Duration>,
}

/// `currentIdentity(root, options)`.
fn current_identity(
    root: &StateRoot,
    options: &EvidenceOptions<'_>,
    env: &Env,
) -> Option<(IdentityFields, String)> {
    let computed;
    let content = match options.current_content {
        Some(content) => content,
        None => {
            computed = content_identity::working_for(
                Path::new(&root.cwd),
                env,
                Some(options.target),
                options.timeout.unwrap_or(CONTENT_TIMEOUT),
                CONTENT_MAX_BYTES,
            );
            &computed
        }
    };
    let content = content.as_ref().ok()?;
    let evidence = evidence_identity(Path::new(&root.cwd), options.gate).ok()?;
    Some((
        IdentityFields {
            fingerprint: content.fingerprint.clone(),
            base: content.base.clone(),
            gate: (!options.gate.is_empty()).then_some(evidence.gate),
            inputs: evidence.inputs,
        },
        content.head.clone(),
    ))
}

/// `process.env.CODEX_THREAD_ID` is set and not empty.
#[must_use]
pub fn codex_thread(env: &Env) -> bool {
    env.iter()
        .any(|(k, v)| k == "CODEX_THREAD_ID" && !v.is_empty())
}

/// `ReviewCorrelationResult`.
#[derive(Debug, Clone)]
pub struct Correlation {
    /// `correlation`.
    pub correlation: &'static str,
    /// `evidence`, when it verified.
    pub evidence: Option<Box<Evidence>>,
}

/// `correlateReview(root, sidecar, options)`: `checkSealedEvidence` plus the current identity.
///
/// # Errors
/// [`Unmodeled`] when the TS's answer depends on something this port does not reproduce.
pub fn correlate_review(
    root: &StateRoot,
    sidecar: &Sidecar,
    options: Option<&EvidenceOptions<'_>>,
    env: &Env,
) -> Result<Correlation, Unmodeled> {
    let (status, evidence) = match check_sealed_evidence(root, sidecar)? {
        SealedCheck::Failed(status) => {
            return Ok(Correlation {
                correlation: status,
                evidence: None,
            });
        }
        SealedCheck::Verified(status, evidence) => (status, evidence),
    };
    let done = |correlation: &'static str, evidence: Box<Evidence>| {
        Ok(Correlation {
            correlation,
            evidence: Some(evidence),
        })
    };
    if status == "changed-during-review" {
        return done("changed-during-review", evidence);
    }
    let current = options.and_then(|o| current_identity(root, o, env));
    let Some((current, head)) = current else {
        return done("unavailable", evidence);
    };
    if codex_thread(env) || evidence.shape.reviewer.is_some() {
        let reviewer = evidence.shape.reviewer.as_ref().and_then(parse_actor);
        let ownership = match options {
            Some(o) => current_ownership(&OwnershipQuery {
                cwd: &root.cwd,
                feature: &sidecar.feature,
                target: o.target,
                fingerprint: &current.fingerprint,
                head: &head,
                base: current.base.as_deref(),
                dir: Some(&root.dir),
            })?,
            None => None,
        };
        let independent = match (&reviewer, &ownership) {
            (Some(reviewer), Some(ownership)) => {
                Some(&ownership.handoff) == evidence.shape.ownership.as_ref()
                    && independent_actor(reviewer, &ownership.actors)
            }
            _ => false,
        };
        if !independent {
            return done("unavailable", evidence);
        }
    }
    if same_identity(&current, &evidence.shape.identity) {
        done("correlated", evidence)
    } else {
        done("changed-after-review", evidence)
    }
}

/// `reviewEvidenceWarning(root, feature, options)`: why this review is not current, or `None`.
///
/// # Errors
/// [`Unmodeled`] when the TS's answer depends on something this port does not reproduce.
pub fn review_evidence_warning(
    root: &StateRoot,
    feature: &str,
    options: Option<&EvidenceOptions<'_>>,
    env: &Env,
) -> Result<Option<String>, Unmodeled> {
    let name = format!("review_{feature}.json");
    let path = artifact(root, &name)?;
    let Ok(meta) = std::fs::metadata(&path) else {
        return Ok(Some(format!(
            "{name} not found; the review is uncorrelated"
        )));
    };
    let sidecar = if meta.is_dir() {
        None
    } else {
        read_json(&path)?.as_ref().and_then(parse_sidecar)
    };
    let Some(sidecar) = sidecar else {
        return Ok(Some(format!("{name} is not a valid sidecar")));
    };
    if sidecar.feature != feature
        || !matches!(&sidecar.verdict, JsValue::String(v) if v.is("APPROVED"))
    {
        return Ok(Some(format!("{name} does not approve this feature")));
    }
    let (checked, ok) = match options {
        Some(_) => (
            correlate_review(root, &sidecar, options, env)?.correlation,
            "correlated",
        ),
        None => (check_sealed_evidence(root, &sidecar)?.status(), "sealed"),
    };
    Ok((checked != ok).then(|| {
        format!(
            "{name} has no current independent evidence ({checked}); the review is uncorrelated"
        )
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_and_uuid_follow_the_ts_patterns() {
        assert!(iso_utc("2026-11-01T00:00:00Z"));
        assert!(iso_utc("2026-11-01T00:00:00.123Z"));
        assert!(!iso_utc("2026-11-01T00:00:00.Z"));
        assert!(!iso_utc("2026-11-01 00:00:00Z"));
        assert!(uuid("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(!uuid("01234567-89ab-cdef-0123-456789abcdeF"));
    }

    #[test]
    fn canonical_sorts_keys_by_code_unit() -> Result<(), &'static str> {
        let value =
            crate::js_json::parse(r#"{"b":1,"a":[true,null,"x"],"B":{"z":-0}}"#).ok_or("json")?;
        assert_eq!(
            canonical(&value).as_deref(),
            Some(r#"{"B":{"z":0},"a":[true,null,"x"],"b":1}"#)
        );
        Ok(())
    }
}
