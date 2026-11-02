//! Workflow escalation acknowledgements (`lib/plan/escalation.ts` and `evaluateEscalation` of
//! `lib/plan/gate.ts`, spec 0060 T11): the rejection history, the escalation binding, the
//! acknowledgement lineage and its reconciliation, for `navori plan acknowledge`.
//!
//! Everything reads through a [`View`] that overlays the files a step will write, so the whole
//! command is decided before the first write. A zod or `JSON.parse` failure, or a read Node would
//! fail with its own message, is [`Stop::Unmodeled`] and the command goes to the TS.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::content_identity::hex;
use crate::js_json::{JsObject, JsValue};
use crate::posix::js_trim;
use crate::state_files::{Refusal, artifact_path, resolve_state_root};

const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const RECORD_BYTES: u64 = 64 * 1024;
const LINEAGE_BYTES: usize = 2 * 1024 * 1024;
const ENUMERATION_LIMIT: usize = 512;
const NEUTRAL_DIR: &str = ".navori/state/handoffs";

/// Why a step stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// The message the TS throws (`acknowledge` prints it as denied).
    Message(String),
    Unmodeled,
}

type R<T> = Result<T, Stop>;

fn message<T>(text: impl Into<String>) -> R<T> {
    Err(Stop::Message(text.into()))
}

fn refusal(r: Refusal) -> Stop {
    match r {
        Refusal::Message(m) => Stop::Message(m),
        Refusal::Unmodeled => Stop::Unmodeled,
    }
}

fn digest(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn stringify(value: &JsValue) -> R<String> {
    value.stringify(None).ok_or(Stop::Unmodeled)
}

/// A write the command performs, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Write {
    /// `appendFileSync(path, text)`, after `ensureStateDirectory` creates `mkdirs`.
    Append {
        mkdirs: Vec<String>,
        path: String,
        text: String,
    },
    /// An exclusive `wx` create with mode `0600`, after `ensureStateDirectory` creates `mkdirs`.
    Create {
        mkdirs: Vec<String>,
        path: String,
        text: String,
    },
}

/// The state as it will be after the planned writes.
#[derive(Debug, Default)]
struct View {
    overlay: BTreeMap<String, String>,
    writes: Vec<Write>,
}

impl View {
    /// `readPlanSnapshot(path, maximum)`.
    fn snapshot(&self, path: &str, maximum: u64) -> R<Option<String>> {
        if let Some(text) = self.overlay.get(path) {
            return Ok(Some(text.clone()));
        }
        let meta = match std::fs::metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Stop::Unmodeled),
        };
        if !meta.is_file() || meta.len() > maximum {
            return message(format!("unsafe or oversized plan state: {path}"));
        }
        let bytes = std::fs::read(path).map_err(|_| Stop::Unmodeled)?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| Stop::Unmodeled)
    }

    /// `existsSync(path)`, a planned file or a directory a planned file creates included.
    fn exists(&self, path: &str) -> bool {
        let dir = format!("{path}/");
        self.overlay.contains_key(path)
            || self.overlay.keys().any(|k| k.starts_with(&dir))
            || std::fs::metadata(path).is_ok()
    }

    /// Whether an exclusive create of `path` would succeed: absent, and not a dangling link
    /// (`wx` refuses it while `existsSync` reports it absent).
    fn creatable(&self, path: &str) -> R<bool> {
        if self.exists(path) {
            return Ok(false);
        }
        if std::fs::symlink_metadata(path).is_ok() {
            return Err(Stop::Unmodeled);
        }
        Ok(true)
    }

    /// `opendirSync` names, then the overlay's new names in the same directory.
    fn names(&self, dir: &str) -> R<Vec<String>> {
        let mut names = Vec::new();
        if std::fs::metadata(dir).is_ok() {
            for entry in std::fs::read_dir(dir).map_err(|_| Stop::Unmodeled)? {
                let entry = entry.map_err(|_| Stop::Unmodeled)?;
                names.push(
                    entry
                        .file_name()
                        .into_string()
                        .map_err(|_| Stop::Unmodeled)?,
                );
            }
        }
        for path in self.overlay.keys() {
            if let Some(name) = path.strip_prefix(&format!("{dir}/"))
                && !names.iter().any(|n| n == name)
            {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }

    fn write(&mut self, write: Write) {
        match &write {
            Write::Append { path, text, .. } => {
                let base = self
                    .overlay
                    .get(path)
                    .cloned()
                    .or_else(|| std::fs::read_to_string(path).ok())
                    .unwrap_or_default();
                self.overlay.insert(path.clone(), format!("{base}{text}"));
            }
            Write::Create { path, text, .. } => {
                self.overlay.insert(path.clone(), text.clone());
            }
        }
        self.writes.push(write);
    }
}

// ---------------------------------------------------------------------------------------------
// schemas

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn text(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

fn strict<'a>(value: &'a JsValue, keys: &[&str]) -> Option<&'a JsObject> {
    let JsValue::Object(o) = value else {
        return None;
    };
    (o.entries()
        .iter()
        .all(|(k, _)| keys.iter().any(|key| k.is(key)))
        && keys.iter().all(|k| o.has(k)))
    .then_some(o)
}

fn int_in(value: &JsValue, min: f64, max: f64) -> Option<f64> {
    match value {
        JsValue::Number(n) if n.fract() == 0.0 && *n >= min && *n <= max => Some(*n),
        _ => None,
    }
}

/// `z.string().trim().min(1).max(4096)`: the trimmed text.
fn decision(value: &JsValue) -> Option<String> {
    let t = text(value)?;
    let trimmed = js_trim(&t);
    (!trimmed.is_empty() && trimmed.encode_utf16().count() <= 4096).then(|| trimmed.to_owned())
}

/// `z.string().datetime({ offset: true })`: a real calendar date-time with seconds, `Z` or
/// `+HH:MM`; anything this rejects goes to the TS, so it may be stricter than zod.
fn datetime_offset(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 20 {
        return false;
    }
    let (zone_at, zone_ok) = if b.ends_with(b"Z") {
        (b.len() - 1, true)
    } else if b.len() >= 25 {
        let z = &b[b.len() - 6..];
        let ok = matches!(z[0], b'+' | b'-')
            && matches!(
                (z[1], z[2]),
                (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
            )
            && z[3] == b':'
            && matches!(z[4], b'0'..=b'5')
            && z[5].is_ascii_digit();
        (b.len() - 6, ok)
    } else {
        return false;
    };
    if !zone_ok {
        return false;
    }
    let base = format!("{}Z", &text[..zone_at]);
    crate::handoff::review_evidence::iso_utc_ms(&base).is_some() && calendar_ok(&base)
}

/// A real date (zod rejects `02-30`, `Date.parse` does not).
fn calendar_ok(text: &str) -> bool {
    let n = |r: std::ops::Range<usize>| text.get(r).and_then(|s| s.parse::<u32>().ok());
    let (Some(y), Some(m), Some(d)) = (n(0..4), n(5..7), n(8..10)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    d >= 1 && d <= days
}

/// `Binding`, as zod returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub cwd: String,
    pub feature: String,
    pub level: u8,
    pub opening: String,
    pub hashes: Vec<String>,
    pub files: Vec<(String, Option<String>)>,
}

impl Binding {
    fn to_js(&self) -> JsValue {
        let mut o = JsObject::new();
        o.insert("cwd", JsValue::string(&self.cwd));
        o.insert("feature", JsValue::string(&self.feature));
        o.insert("level", JsValue::Number(f64::from(self.level)));
        o.insert("opening", JsValue::string(&self.opening));
        o.insert(
            "hashes",
            JsValue::Array(self.hashes.iter().map(|h| JsValue::string(h)).collect()),
        );
        let files = self
            .files
            .iter()
            .map(|(path, hash)| {
                let mut f = JsObject::new();
                f.insert("path", JsValue::string(path));
                f.insert(
                    "hash",
                    hash.as_deref().map_or(JsValue::Null, JsValue::string),
                );
                JsValue::Object(f)
            })
            .collect();
        o.insert("files", JsValue::Array(files));
        JsValue::Object(o)
    }

    fn json(&self) -> R<String> {
        stringify(&self.to_js())
    }

    /// `checkedBinding`: canonical hashes and distinct paths.
    fn checked(&self) -> R<&Self> {
        let mut canonical: Vec<String> = self
            .hashes
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        canonical.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let paths: BTreeSet<&String> = self.files.iter().map(|(p, _)| p).collect();
        if canonical != self.hashes || paths.len() != self.files.len() {
            return message("noncanonical escalation binding");
        }
        Ok(self)
    }

    fn epoch(&self) -> R<String> {
        let value = JsValue::Array(vec![
            JsValue::string(&self.cwd),
            JsValue::string(&self.feature),
            JsValue::Array(self.hashes.iter().map(|h| JsValue::string(h)).collect()),
        ]);
        Ok(digest(&stringify(&value)?))
    }

    /// `snapshotDigest(binding)`.
    fn snapshot_digest(&self) -> R<String> {
        self.checked()?;
        let value = JsValue::Array(vec![JsValue::string("plan-snapshot-v1"), self.to_js()]);
        Ok(digest(&stringify(&value)?))
    }
}

fn parse_binding(value: &JsValue) -> Option<Binding> {
    let o = strict(
        value,
        &["cwd", "feature", "level", "opening", "hashes", "files"],
    )?;
    let JsValue::Array(hashes) = o.get("hashes")? else {
        return None;
    };
    let hashes = hashes
        .iter()
        .map(|h| text(h).filter(|t| is_hash(t)))
        .collect::<Option<Vec<_>>>()?;
    if hashes.len() < 2 || hashes.len() > 4096 {
        return None;
    }
    let JsValue::Array(files) = o.get("files")? else {
        return None;
    };
    if files.len() > 8 {
        return None;
    }
    let files = files
        .iter()
        .map(|f| {
            let JsValue::Object(f) = f else { return None };
            let hash = match f.get("hash")? {
                JsValue::Null => None,
                v => Some(text(v).filter(|t| is_hash(t))?),
            };
            Some((text(f.get("path")?)?, hash))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Binding {
        cwd: text(o.get("cwd")?)?,
        feature: text(o.get("feature")?)?,
        level: u8::try_from(int_in(o.get("level")?, 2.0, 3.0)? as i64).ok()?,
        opening: text(o.get("opening")?)?,
        hashes,
        files,
    })
}

fn parse_json(raw: &str) -> R<JsValue> {
    let value = crate::js_json::parse(raw).ok_or(Stop::Unmodeled)?;
    if crate::handoff::ownership::has_lone_surrogate(&value) {
        return Err(Stop::Unmodeled);
    }
    Ok(value)
}

/// `Ack.parse(JSON.parse(text))`.
fn parse_ack(raw: &str) -> R<(Binding, String)> {
    ack_value(&parse_json(raw)?)
}

/// `Ack.parse(value)`.
fn ack_value(value: &JsValue) -> R<(Binding, String)> {
    let o = strict(value, &["binding", "decision"]).ok_or(Stop::Unmodeled)?;
    let binding = parse_binding(o.get("binding").ok_or(Stop::Unmodeled)?).ok_or(Stop::Unmodeled)?;
    let decision = decision(o.get("decision").ok_or(Stop::Unmodeled)?).ok_or(Stop::Unmodeled)?;
    Ok((binding, decision))
}

/// `/^(base|grant):[a-f0-9]{64}$/`.
fn is_reference(text: &str) -> bool {
    text.strip_prefix("base:")
        .or_else(|| text.strip_prefix("grant:"))
        .is_some_and(is_hash)
}

/// `Continuation`, as zod returns it.
#[derive(Debug, Clone)]
struct Continuation {
    epoch: String,
    ordinal: u32,
    predecessor: String,
    authorization_id: String,
    decision: String,
    binding: Binding,
    snapshot: String,
}

impl Continuation {
    fn json(&self) -> R<String> {
        let mut o = JsObject::new();
        o.insert("version", JsValue::Number(1.0));
        o.insert("kind", JsValue::string("plan-continuation"));
        o.insert("epoch", JsValue::string(&self.epoch));
        o.insert("ordinal", JsValue::Number(f64::from(self.ordinal)));
        o.insert("predecessor", JsValue::string(&self.predecessor));
        o.insert("authorizationId", JsValue::string(&self.authorization_id));
        o.insert("decision", JsValue::string(&self.decision));
        o.insert("binding", self.binding.to_js());
        o.insert("snapshot", JsValue::string(&self.snapshot));
        stringify(&JsValue::Object(o))
    }
}

fn authorization_id(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn parse_continuation(raw: &str) -> R<Continuation> {
    continuation_value(&parse_json(raw)?)
}

/// `Continuation.parse(value)`.
fn continuation_value(value: &JsValue) -> R<Continuation> {
    let keys = [
        "version",
        "kind",
        "epoch",
        "ordinal",
        "predecessor",
        "authorizationId",
        "decision",
        "binding",
        "snapshot",
    ];
    let parse = || -> Option<Continuation> {
        let o = strict(value, &keys)?;
        int_in(o.get("version")?, 1.0, 1.0)?;
        (text(o.get("kind")?)? == "plan-continuation").then_some(())?;
        Some(Continuation {
            epoch: text(o.get("epoch")?).filter(|t| is_hash(t))?,
            ordinal: int_in(o.get("ordinal")?, 1.0, 32.0)? as u32,
            predecessor: text(o.get("predecessor")?).filter(|t| is_reference(t))?,
            authorization_id: text(o.get("authorizationId")?).filter(|t| authorization_id(t))?,
            decision: decision(o.get("decision")?)?,
            binding: parse_binding(o.get("binding")?)?,
            snapshot: text(o.get("snapshot")?).filter(|t| is_hash(t))?,
        })
    };
    parse().ok_or(Stop::Unmodeled)
}

/// `Burn.parse(JSON.parse(text))`: `(reference, snapshot)`.
fn parse_burn(raw: &str) -> R<(String, String)> {
    burn_value(&parse_json(raw)?)
}

/// `Burn.parse(value)`.
fn burn_value(value: &JsValue) -> R<(String, String)> {
    let parse = || -> Option<(String, String)> {
        let o = strict(value, &["version", "kind", "reference", "snapshot"])?;
        int_in(o.get("version")?, 1.0, 1.0)?;
        (text(o.get("kind")?)? == "plan-continuation-burn").then_some(())?;
        Some((
            text(o.get("reference")?).filter(|t| is_reference(t))?,
            text(o.get("snapshot")?).filter(|t| is_hash(t))?,
        ))
    };
    parse().ok_or(Stop::Unmodeled)
}

// ---------------------------------------------------------------------------------------------
// history

/// `RejectionHistory`.
#[derive(Debug, Clone)]
struct History {
    files: Vec<(String, Option<String>)>,
    hashes: Vec<String>,
    active: Vec<String>,
}

fn final_verdict(review: &str) -> R<Option<String>> {
    let re = Regex::new(&format!(
        r"\*\*Final verdict:\*\*{}*([A-Z_]+)",
        crate::js_re::ws()
    ))
    .map_err(|_| Stop::Unmodeled)?;
    Ok(re
        .captures_iter(review)
        .last()
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned()))
}

/// The state directory, log and review paths of a feature (its resolved root).
struct Paths {
    cwd: String,
    state: String,
}

impl Paths {
    fn root(&self) -> crate::state_files::StateRoot {
        crate::state_files::StateRoot {
            cwd: self.cwd.clone(),
            dir: crate::posix::relative(&self.cwd, &self.state),
            path: self.state.clone(),
        }
    }

    fn artifact(&self, name: &str) -> R<String> {
        artifact_path(&self.root(), name).map_err(refusal)
    }

    /// `ensureStateDirectory(root)`, planned: the directories it creates, or its message.
    fn ensure(&self, view: &View) -> R<Vec<String>> {
        let dirs = crate::state_files::plan_state_dirs(&self.root()).map_err(refusal)?;
        Ok(dirs.into_iter().filter(|d| !view.exists(d)).collect())
    }
}

/// `readRejectionHistory(root, feature)`.
fn read_history(view: &View, paths: &Paths, feature: &str) -> R<History> {
    let log_path = paths.artifact(&format!("workplan_{feature}.gate.jsonl"))?;
    let log = view.snapshot(&log_path, MAX_LOG_BYTES)?;
    let review_path = paths.artifact(&format!("review_{feature}.md"))?;
    let review = view.snapshot(&review_path, MAX_BYTES)?;
    let content = log.clone().unwrap_or_default();
    if !content.is_empty() && !content.ends_with('\n') {
        return message("incomplete rejection history");
    }
    let mut hashes: Vec<String> = Vec::new();
    let mut active: Vec<String> = Vec::new();
    for line in content.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        if line.len() > 8192 {
            return message("oversized rejection history entry");
        }
        let value = parse_json(line)?;
        match history_entry(&value).ok_or(Stop::Unmodeled)? {
            Entry::Reset => active.clear(),
            Entry::Rejection { ts, hash } => {
                if !hashes.contains(&hash) {
                    hashes.push(hash);
                    active.push(ts);
                }
            }
        }
    }
    if hashes.len() > 4096 {
        return message("oversized rejection history");
    }
    reconcile(view, &paths.cwd, feature, &hashes)?;
    hashes.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(History {
        files: vec![(log_path, log), (review_path, review)],
        hashes,
        active,
    })
}

enum Entry {
    Rejection { ts: String, hash: String },
    Reset,
}

/// `HistoryEntry.parse(...)` (`Entry | Reset`), `None` where zod throws.
fn history_entry(value: &JsValue) -> Option<Entry> {
    if let Some(o) = strict(value, &["ts", "reviewHash", "verdict"]) {
        let ts = text(o.get("ts")?).filter(|t| datetime_offset(t))?;
        let hash = text(o.get("reviewHash")?).filter(|t| is_hash(t))?;
        (text(o.get("verdict")?)? == "CHANGES_REQUESTED").then_some(())?;
        return Some(Entry::Rejection { ts, hash });
    }
    let o = strict(
        value,
        &["ts", "kind", "approvedBy", "reason", "rejectionsBefore"],
    )?;
    text(o.get("ts")?).filter(|t| datetime_offset(t))?;
    (text(o.get("kind")?)? == "reset").then_some(())?;
    (text(o.get("approvedBy")?)? == "user").then_some(())?;
    decision(o.get("reason")?)?;
    let before = o.get("rejectionsBefore")?;
    matches!(before, JsValue::Number(n) if n.fract() == 0.0 && *n >= 2.0 && n.abs() <= 9_007_199_254_740_991.0)
        .then_some(Entry::Reset)
}

/// `recordRejections(root, feature)`: appends a new current rejection to the view.
fn record_rejections(view: &mut View, paths: &Paths, feature: &str, now: &str) -> R<History> {
    let history = read_history(view, paths, feature)?;
    let review = history.files[1].1.clone().unwrap_or_default();
    if final_verdict(&review)?.as_deref() == Some("CHANGES_REQUESTED") {
        let hash = digest(&review);
        if !history.hashes.contains(&hash) {
            let mut line = JsObject::new();
            line.insert("ts", JsValue::string(now));
            line.insert("reviewHash", JsValue::string(&hash));
            line.insert("verdict", JsValue::string("CHANGES_REQUESTED"));
            let mkdirs = paths.ensure(view)?;
            view.write(Write::Append {
                mkdirs,
                path: history.files[0].0.clone(),
                text: format!("{}\n", stringify(&JsValue::Object(line))?),
            });
            return read_history(view, paths, feature);
        }
    }
    Ok(history)
}

// ---------------------------------------------------------------------------------------------
// lineage

#[derive(Debug, Clone)]
struct Grant {
    reference: String,
    ordinal: u32,
    consumed: bool,
    stored_snapshot: String,
    predecessor: Option<String>,
    authorization_id: Option<String>,
}

struct Lineage {
    grants: Vec<Grant>,
    visited: BTreeSet<String>,
    bytes: usize,
}

/// The neutral root of a binding's epoch (`paths(binding)`).
struct Epoch {
    state: Paths,
    ack: String,
    consumed: String,
}

fn epoch_paths(binding: &Binding) -> R<Epoch> {
    let epoch = binding.epoch()?;
    let root = resolve_state_root(
        &binding.cwd,
        &binding.cwd,
        &binding.feature,
        Some(NEUTRAL_DIR),
    )
    .map_err(refusal)?;
    let state = Paths {
        cwd: root.cwd.clone(),
        state: root.path.clone(),
    };
    Ok(Epoch {
        ack: state.artifact(&format!("escalation_{epoch}.json"))?,
        consumed: state.artifact(&format!("escalation_{epoch}.consumed"))?,
        state,
    })
}

fn successor_path(state: &Paths, reference: &str) -> R<String> {
    let id = reference.split(':').nth(1).ok_or(Stop::Unmodeled)?;
    state.artifact(&format!("escalation_continuation_{id}.json"))
}

fn burn_path(state: &Paths, reference: &str) -> R<String> {
    let id = reference.split(':').nth(1).ok_or(Stop::Unmodeled)?;
    state.artifact(&format!("escalation_burn_{id}.json"))
}

/// `readLineage(binding)`.
fn read_lineage(view: &View, binding: &Binding) -> R<Lineage> {
    binding.checked()?;
    let state = epoch_paths(binding)?;
    let mut visited = BTreeSet::new();
    let mut total = 0usize;
    let mut read = |path: &str, maximum: u64| -> R<Option<String>> {
        let found = view.snapshot(path, maximum)?;
        if let Some(text) = &found {
            visited.insert(path.to_owned());
            total += text.len();
            if total > LINEAGE_BYTES {
                return message("oversized escalation lineage");
            }
        }
        Ok(found)
    };
    let Some(ack_text) = read(&state.ack, MAX_BYTES)? else {
        return message("escalate to the user, then run navori plan acknowledge");
    };
    let (ack, _) = parse_ack(&ack_text)?;
    ack.checked()?;
    let epoch = binding.epoch()?;
    if ack.epoch()? != epoch {
        return message("legacy escalation epoch mismatch");
    }
    let spent = read(&state.consumed, MAX_BYTES)?;
    if let Some(spent) = &spent {
        let value = parse_json(spent)?;
        let consumed = parse_binding(&value).ok_or(Stop::Unmodeled)?;
        consumed.checked()?;
        if consumed.json()? != ack.json()? {
            return message("invalid legacy consumption binding");
        }
    }
    let base = JsValue::Array(vec![
        JsValue::string("plan-base-v1"),
        JsValue::string(&epoch),
        JsValue::string(&digest(&ack_text)),
        spent
            .as_deref()
            .map_or(JsValue::Null, |s| JsValue::string(&digest(s))),
    ]);
    let mut grants = vec![Grant {
        reference: format!("base:{}", digest(&stringify(&base)?)),
        ordinal: 0,
        consumed: spent.is_some(),
        stored_snapshot: ack.snapshot_digest()?,
        predecessor: None,
        authorization_id: None,
    }];
    let mut ids: BTreeSet<String> = BTreeSet::new();
    loop {
        let parent = grants.last().cloned().ok_or(Stop::Unmodeled)?;
        let Some(child_text) = read(
            &successor_path(&state.state, &parent.reference)?,
            RECORD_BYTES,
        )?
        else {
            break;
        };
        if !parent.consumed || grants.len() > 32 {
            return message("invalid or exhausted continuation ancestry");
        }
        let child = parse_continuation(&child_text)?;
        child.binding.checked()?;
        if child.epoch != epoch
            || child.binding.epoch()? != epoch
            || child.predecessor != parent.reference
            || child.ordinal as usize != grants.len()
            || child.snapshot != child.binding.snapshot_digest()?
            || ids.contains(&child.authorization_id)
        {
            return message("invalid continuation ancestry");
        }
        ids.insert(child.authorization_id.clone());
        let grant_value = JsValue::Array(vec![
            JsValue::string("plan-grant-v1"),
            parse_json(&child.json()?)?,
        ]);
        let reference = format!("grant:{}", digest(&stringify(&grant_value)?));
        let burn = read(&burn_path(&state.state, &reference)?, RECORD_BYTES)?;
        if let Some(burn) = &burn {
            let (burn_reference, snapshot) = parse_burn(burn)?;
            if burn_reference != reference || snapshot != child.snapshot {
                return message("invalid continuation burn");
            }
        }
        grants.push(Grant {
            reference,
            ordinal: child.ordinal,
            consumed: burn.is_some(),
            stored_snapshot: child.snapshot.clone(),
            predecessor: Some(child.predecessor.clone()),
            authorization_id: Some(child.authorization_id.clone()),
        });
    }
    Ok(Lineage {
        grants,
        visited,
        bytes: total,
    })
}

/// `/^escalation_[a-f0-9]{64}\.(json|consumed)$/`-style names.
fn hashed(name: &str, prefix: &str, suffix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|r| r.strip_suffix(suffix))
        .is_some_and(is_hash)
}

fn private_temporary(name: &str) -> bool {
    name.strip_prefix("escalation_private_")
        .and_then(|r| r.strip_suffix(".tmp"))
        .is_some_and(|id| {
            id.len() == 36
                && id
                    .bytes()
                    .all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
        })
}

/// `reconcileHistory(cwd, feature, hashes)`.
fn reconcile(view: &View, cwd: &str, feature: &str, hashes: &[String]) -> R<()> {
    let root = resolve_state_root(cwd, cwd, feature, Some(NEUTRAL_DIR)).map_err(refusal)?;
    if !view.exists(&root.path) {
        return Ok(());
    }
    let paths = Paths {
        cwd: root.cwd.clone(),
        state: root.path.clone(),
    };
    let names = view.names(&root.path)?;
    if names.len() > 8192 {
        return message("escalation directory enumeration limit exceeded");
    }
    let mut candidates: Vec<(String, String, Option<Binding>)> = Vec::new();
    let mut entries = 0;
    let mut bytes = 0usize;
    for name in names {
        if !name.starts_with("escalation_") || private_temporary(&name) {
            continue;
        }
        entries += 1;
        if entries > ENUMERATION_LIMIT {
            return message("escalation enumeration limit exceeded");
        }
        let path = paths.artifact(&name)?;
        let Some(text) = view.snapshot(&path, MAX_BYTES)? else {
            return message("escalation state changed during enumeration");
        };
        bytes += text.len();
        if bytes > 16 * 1024 * 1024 {
            return message("escalation enumeration byte limit exceeded");
        }
        let raw = parse_json(&text)?;
        let binding = if hashed(&name, "escalation_", ".json") {
            let (binding, _) = ack_value(&raw)?;
            binding.checked()?;
            if name != format!("escalation_{}.json", binding.epoch()?) {
                return message("misnamed legacy acknowledgement");
            }
            Some(binding)
        } else if hashed(&name, "escalation_", ".consumed") {
            let binding = parse_binding(&raw).ok_or(Stop::Unmodeled)?;
            binding.checked()?;
            if name != format!("escalation_{}.consumed", binding.epoch()?) {
                return message("misnamed legacy consumption");
            }
            Some(binding)
        } else if hashed(&name, "escalation_continuation_", ".json") {
            if text.len() as u64 > RECORD_BYTES {
                return message("oversized continuation record");
            }
            let child = continuation_value(&raw)?;
            child.binding.checked()?;
            Some(child.binding)
        } else if hashed(&name, "escalation_burn_", ".json") {
            burn_value(&raw)?;
            None
        } else {
            return message("unattributable escalation state");
        };
        if let Some(b) = &binding
            && b.cwd == cwd
            && b.feature == feature
            && !b.hashes.iter().all(|h| hashes.contains(h))
        {
            return message("rejection history rollback: missing evidenced rejection");
        }
        candidates.push((path, name, binding));
    }
    let mut visited = BTreeSet::new();
    for (_, name, binding) in &candidates {
        if let Some(binding) = binding
            && hashed(name, "escalation_", ".json")
        {
            visited.extend(read_lineage(view, binding)?.visited);
        }
    }
    if candidates
        .iter()
        .any(|(path, _, _)| !visited.contains(path))
    {
        return message("orphan or ambiguous escalation state");
    }
    Ok(())
}

/// `unchanged(binding)`: every bound file still hashes as captured.
fn unchanged(view: &View, binding: &Binding) -> R<bool> {
    for (path, hash) in &binding.files {
        let current = view.snapshot(path, MAX_BYTES)?.map(|t| digest(&t));
        if current != *hash {
            return Ok(false);
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------------------------
// entry

/// The request `acknowledgePlanEscalation` received after the gate front.
pub struct Request<'a> {
    pub feature: &'a str,
    pub opening: &'a str,
    pub decision: &'a str,
    pub inspect: bool,
    /// `(continueAfter, authorizationId, snapshot)`.
    pub continuation: Option<(&'a str, &'a str, &'a str)>,
    /// `new Date().toISOString()`, for a recorded rejection.
    pub now: &'a str,
}

/// What the command prints and writes.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// The `JSON.stringify(result)` value, or the thrown message.
    pub result: Result<JsValue, String>,
    /// The writes to perform before printing, in order.
    pub writes: Vec<Write>,
}

/// `acknowledgePlanEscalation` from the escalation on, over the validated `scope`.
///
/// # Errors
/// [`Stop::Unmodeled`] where the TS's answer depends on something this port does not reproduce.
pub fn acknowledge(
    scope: &crate::plan::gate::AckScope,
    request: &Request<'_>,
) -> Result<Outcome, Stop> {
    let mut view = View::default();
    let result = run(&mut view, scope, request);
    match result {
        Ok(value) => Ok(Outcome {
            result: Ok(value),
            writes: view.writes,
        }),
        Err(Stop::Message(m)) => Ok(Outcome {
            result: Err(m),
            writes: view.writes,
        }),
        Err(Stop::Unmodeled) => Err(Stop::Unmodeled),
    }
}

fn status(feature: &str, status: &str, reference: Option<&str>) -> JsValue {
    let mut o = JsObject::new();
    o.insert("status", JsValue::string(status));
    o.insert("feature", JsValue::string(feature));
    if let Some(reference) = reference {
        o.insert("reference", JsValue::string(reference));
    }
    JsValue::Object(o)
}

#[allow(
    clippy::too_many_lines,
    reason = "evaluateEscalation and the three entrypoints, in order"
)]
fn run(view: &mut View, scope: &crate::plan::gate::AckScope, request: &Request<'_>) -> R<JsValue> {
    let feature = request.feature;
    let paths = Paths {
        cwd: scope.cwd.clone(),
        state: scope.state.clone(),
    };
    // `evaluateEscalation(root, feature, level, context)` with `acknowledging: true`.
    let history = if request.inspect {
        read_history(view, &paths, feature)?
    } else {
        record_rejections(view, &paths, feature, request.now)?
    };
    if request.inspect {
        let review = history.files[1].1.clone().unwrap_or_default();
        if final_verdict(&review)?.as_deref() == Some("CHANGES_REQUESTED")
            && !history.hashes.contains(&digest(&review))
        {
            return message("current review rejection is unrecorded; use the normal gate first");
        }
    }
    let rejections = history.active.len();
    if rejections < 2 {
        return message("acknowledgement requires two recorded rejections at level 2 or 3");
    }
    if scope.level < 2 {
        let index = 2 * (rejections / 2) - 1;
        let pair = history
            .active
            .get(index)
            .map(|ts| crate::plan::gate::iso_date_ms(ts).ok_or(Stop::Unmodeled))
            .transpose()?;
        let fresh = |name: &str| -> R<bool> {
            let path = paths.artifact(name)?;
            let Ok(meta) = std::fs::metadata(&path) else {
                return Ok(false);
            };
            let Some(pair) = pair else { return Ok(true) };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .ok_or(Stop::Unmodeled)?;
            Ok(mtime.as_secs_f64() * 1000.0 >= pair)
        };
        if !fresh(&format!("solution_{feature}.md"))?
            || !fresh(&format!("solution_review_{feature}.md"))?
        {
            return message(format!(
                "feature \"{feature}\" has {rejections} recorded CHANGES_REQUESTED — produce a NEW solution_{feature}.md and its challenge (solution_review_{feature}.md), written after the latest rejection pair, before the next dispatch, skill `plan-advanced`."
            ));
        }
        return message("acknowledgement requires two recorded rejections at level 2 or 3");
    }
    let mut files: Vec<(String, Option<String>)> = scope.files.clone();
    files.extend(history.files.iter().cloned());
    if files.len() > 8 || !(2..=3).contains(&scope.level) || history.hashes.len() < 2 {
        return Err(Stop::Unmodeled);
    }
    let binding = Binding {
        cwd: scope.cwd.clone(),
        feature: feature.to_owned(),
        level: scope.level,
        opening: request.opening.to_owned(),
        hashes: history.hashes.clone(),
        files: files
            .into_iter()
            .map(|(path, content)| (path, content.map(|c| digest(&c))))
            .collect(),
    };
    if request.inspect {
        // `inspectEscalation(binding)`.
        reconcile(view, &binding.cwd, &binding.feature, &binding.hashes)?;
        let tip = read_lineage(view, &binding)?
            .grants
            .pop()
            .ok_or(Stop::Unmodeled)?;
        if !unchanged(view, &binding)? {
            return message("escalation inputs changed during inspection");
        }
        let mut terminal = JsObject::new();
        terminal.insert("reference", JsValue::string(&tip.reference));
        terminal.insert("ordinal", JsValue::Number(f64::from(tip.ordinal)));
        terminal.insert(
            "status",
            JsValue::string(if tip.consumed {
                "consumed"
            } else {
                "unconsumed"
            }),
        );
        terminal.insert("storedSnapshot", JsValue::string(&tip.stored_snapshot));
        if let Some(p) = &tip.predecessor {
            terminal.insert("predecessor", JsValue::string(p));
        }
        if let Some(a) = &tip.authorization_id {
            terminal.insert("authorizationId", JsValue::string(a));
        }
        let mut o = JsObject::new();
        o.insert("status", JsValue::string("inspected"));
        o.insert("feature", JsValue::string(feature));
        o.insert(
            "currentSnapshot",
            JsValue::string(&binding.snapshot_digest()?),
        );
        o.insert("terminal", JsValue::Object(terminal));
        if tip.consumed && tip.ordinal < 32 {
            o.insert("eligiblePredecessor", JsValue::string(&tip.reference));
        }
        return Ok(JsValue::Object(o));
    }
    let state = epoch_paths(&binding)?;
    if let Some((after, id, snapshot)) = request.continuation {
        // `continueEscalation(binding, decision, request)`.
        reconcile(view, &binding.cwd, &binding.feature, &binding.hashes)?;
        let lineage = read_lineage(view, &binding)?;
        if !is_reference(after) {
            return Err(Stop::Unmodeled);
        }
        let Some(parent) = lineage
            .grants
            .iter()
            .find(|g| g.reference == after)
            .cloned()
        else {
            return message("consumed predecessor required");
        };
        if !parent.consumed {
            return message("consumed predecessor required");
        }
        let decision = decision(&JsValue::string(request.decision)).ok_or(Stop::Unmodeled)?;
        if !authorization_id(id) || !is_hash(snapshot) || parent.ordinal + 1 > 32 {
            return Err(Stop::Unmodeled);
        }
        let child = Continuation {
            epoch: binding.epoch()?,
            ordinal: parent.ordinal + 1,
            predecessor: parent.reference.clone(),
            authorization_id: id.to_owned(),
            decision,
            binding: binding.clone(),
            snapshot: snapshot.to_owned(),
        };
        if child.snapshot != binding.snapshot_digest()? || !unchanged(view, &binding)? {
            return message("continuation snapshot changed");
        }
        let path = successor_path(&state.state, &parent.reference)?;
        let child_json = child.json()?;
        let grant_value = JsValue::Array(vec![
            JsValue::string("plan-grant-v1"),
            parse_json(&child_json)?,
        ]);
        let reference = format!("grant:{}", digest(&stringify(&grant_value)?));
        if !view.exists(&path) {
            if lineage.grants.last().map(|g| &g.reference) != Some(&parent.reference) {
                return message("terminal predecessor required");
            }
            if lineage
                .grants
                .iter()
                .any(|g| g.authorization_id.as_deref() == Some(id))
            {
                return message("authorization identifier already used");
            }
            if lineage.bytes + child_json.len() + 1 > LINEAGE_BYTES {
                return message("oversized escalation lineage");
            }
            if child_json.len() as u64 + 1 > RECORD_BYTES {
                return message("oversized continuation record");
            }
            let mkdirs = state.state.ensure(view)?;
            if !view.creatable(&path)? {
                return Err(Stop::Unmodeled);
            }
            view.write(Write::Create {
                mkdirs,
                path: path.clone(),
                text: format!("{child_json}\n"),
            });
        }
        // `observe()`.
        let stored = view.snapshot(&path, RECORD_BYTES)?;
        let same = match &stored {
            Some(text) => parse_continuation(text)?.json()? == child_json,
            None => false,
        };
        if !same {
            return message("continuation conflict; inspect the winning authorization");
        }
        let grant = read_lineage(view, &binding)?
            .grants
            .into_iter()
            .find(|g| g.reference == reference);
        let Some(grant) = grant else {
            return message("continuation publication cannot be reconciled");
        };
        let s = if grant.consumed {
            "consumed"
        } else {
            "acknowledged"
        };
        return Ok(status(feature, s, Some(&reference)));
    }
    // `acknowledgeEscalation(binding, decision)`.
    let decision = decision(&JsValue::string(request.decision)).ok_or(Stop::Unmodeled)?;
    let mut record = JsObject::new();
    record.insert("binding", binding.to_js());
    record.insert("decision", JsValue::string(&decision));
    reconcile(view, &binding.cwd, &binding.feature, &binding.hashes)?;
    if !unchanged(view, &binding)? {
        return message("escalation inputs changed during acknowledgement");
    }
    let mkdirs = state.state.ensure(view)?;
    if view.exists(&state.consumed) {
        return Ok(status(feature, "consumed", None));
    }
    if view.creatable(&state.ack)? {
        view.write(Write::Create {
            mkdirs,
            path: state.ack.clone(),
            text: format!("{}\n", stringify(&JsValue::Object(record))?),
        });
    }
    // `requireAcknowledgement(binding)`.
    reconcile(view, &binding.cwd, &binding.feature, &binding.hashes)?;
    let lineage = read_lineage(view, &binding)?;
    let tip = lineage.grants.last().ok_or(Stop::Unmodeled)?;
    if tip.consumed {
        return message("escalation acknowledgement already consumed");
    }
    if tip.stored_snapshot != binding.snapshot_digest()? {
        return message("escalation acknowledgement binding changed");
    }
    Ok(status(feature, "acknowledged", None))
}

/// Runs the planned writes over `fs`; the first failure is Node's message.
///
/// # Errors
/// Node's message for the write that failed.
pub fn apply(fs: &mut dyn crate::fs::Fs, writes: &[Write]) -> Result<(), String> {
    use crate::fs::{Syscall, node_message};
    for write in writes {
        let (Write::Append { mkdirs, path, text } | Write::Create { mkdirs, path, text }) = write;
        for dir in mkdirs {
            fs.mkdir_all(Path::new(dir))
                .map_err(|e| node_message(&e, Syscall::Mkdir, Path::new(dir), None))?;
        }
        match write {
            Write::Append { .. } => fs
                .append(Path::new(path), text.as_bytes())
                .map_err(|e| node_message(&e, Syscall::Open, Path::new(path), None))?,
            Write::Create { .. } => {
                let file = fs
                    .create(Path::new(path), 0o600)
                    .map_err(|e| node_message(&e, Syscall::Open, Path::new(path), None))?;
                fs.write(file, text.as_bytes())
                    .map_err(|e| node_message(&e, Syscall::Write, Path::new(path), None))?;
                fs.close(file)
                    .map_err(|e| node_message(&e, Syscall::Close, Path::new(path), None))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datetimes_follow_zod_with_offsets() {
        assert!(datetime_offset("2026-11-01T00:00:00.000Z"));
        assert!(datetime_offset("2026-11-01T00:00:00+02:00"));
        assert!(!datetime_offset("2026-02-30T00:00:00Z"));
        assert!(!datetime_offset("2026-11-01T00:00Z"));
        assert!(!datetime_offset("2026-11-01T00:00:00+0200"));
        assert!(!datetime_offset("2026-11-01T00:00:00+24:00"));
        assert!(!datetime_offset("2026-11-01T00:00:00+02:60"));
    }
}
