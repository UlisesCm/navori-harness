//! The publication receipt check (`lib/diagnose/receipt.ts`, spec 0060 T10/T11): the evidence
//! identity (`evidenceIdentity`) and `checkReceipt` in its read-only mode, the one `plan resume`
//! uses. `sign`, a non-read-only `check` (it fetches and writes git objects) and the audit
//! observer stay in the TS.
//!
//! Git runs through a [`ProcessRunner`] (D42) with the TS's flags. A failure whose message is
//! git's stderr (which the runner does not carry) or Node's is [`Unmodeled`], and the caller
//! hands the command to the TS.

use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::content_identity::{self, hex};
use crate::handoff::Unmodeled;
use crate::handoff::review_evidence::{EvidenceOptions, codex_thread, review_evidence_warning};
use crate::js_json::{JsObject, JsValue};
use crate::posix::{js_trim, relative, resolve};
use crate::process::{Env, ProcessRunner, Request};
use crate::state_files::{Refusal, StateRoot, artifact_path, resolve_state_root};

/// `LOCKFILES` (`lib/diagnose/detect.ts`), in its order.
pub const LOCKFILES: [&str; 5] = [
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "yarn.lock",
    "package-lock.json",
];

/// The `gate=` of a receipt signed after a scoped cycle.
const SCOPED_GATE: &str = "scoped";

/// `PROGRESS_DIRS` (`primitives/progress-dirs.ts`).
const PROGRESS_DIRS: [&str; 4] = [
    ".claude/progress/",
    ".codex/progress/",
    ".navori/state/",
    "progress/",
];

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `EvidenceIdentity`: sha256 of the gate command and of the lockfile payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceIdentity {
    /// `sha256(gate)`.
    pub gate: String,
    /// `sha256(inputsPayload(cwd))`.
    pub inputs: String,
}

/// `evidenceIdentity(cwd, gate)`.
///
/// # Errors
/// [`Unmodeled`] where the TS throws (a lockfile it cannot read): Node's message.
pub fn evidence_identity(cwd: &Path, gate: &str) -> Result<EvidenceIdentity, Unmodeled> {
    let mut payload = String::new();
    for name in LOCKFILES {
        let path = cwd.join(name);
        if std::fs::metadata(&path).is_err() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|_| Unmodeled)?;
        payload.push_str(&format!("{name}\0{}\n", sha256(&bytes)));
    }
    Ok(EvidenceIdentity {
        gate: sha256(gate.as_bytes()),
        inputs: sha256(payload.as_bytes()),
    })
}

/// One `drift` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drift {
    pub path: String,
    /// `null` for a `reappeared` path.
    pub blob: Option<String>,
    /// `changed`, `missing` or `reappeared`.
    pub kind: &'static str,
}

/// `ReceiptResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptResult {
    pub target: String,
    pub target_sha: Option<String>,
    pub head_sha: Option<String>,
    /// `ok`, `findings` or `error`.
    pub status: &'static str,
    pub uncovered: Vec<String>,
    pub drift: Vec<Drift>,
    pub fresh: bool,
    pub stale: Vec<&'static str>,
    pub consumed: bool,
    /// `full`, `scoped` or `null`.
    pub gate_kind: Option<&'static str>,
    pub error: Option<String>,
}

fn opt_string(value: Option<&String>) -> JsValue {
    value.map_or(JsValue::Null, |v| JsValue::string(v))
}

impl ReceiptResult {
    fn error(target: &str, message: String) -> Self {
        Self {
            target: target.to_owned(),
            target_sha: None,
            head_sha: None,
            status: "error",
            uncovered: Vec::new(),
            drift: Vec::new(),
            fresh: false,
            stale: Vec::new(),
            consumed: false,
            gate_kind: None,
            error: Some(message),
        }
    }

    /// The exit code `checkReceipt` pairs with this result.
    #[must_use]
    pub fn exit_code(&self) -> u8 {
        match self.status {
            "ok" => 0,
            "findings" => 2,
            _ => 1,
        }
    }

    /// The object `checkReceipt` returns as `result`, in its key order.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let mut o = JsObject::new();
        o.insert("formatVersion", JsValue::Number(1.0));
        o.insert("target", JsValue::string(&self.target));
        o.insert("targetSha", opt_string(self.target_sha.as_ref()));
        o.insert("headSha", opt_string(self.head_sha.as_ref()));
        o.insert("status", JsValue::string(self.status));
        o.insert(
            "uncovered",
            JsValue::Array(self.uncovered.iter().map(|p| JsValue::string(p)).collect()),
        );
        let drift = self
            .drift
            .iter()
            .map(|d| {
                let mut e = JsObject::new();
                e.insert("path", JsValue::string(&d.path));
                e.insert("blob", opt_string(d.blob.as_ref()));
                e.insert("kind", JsValue::string(d.kind));
                JsValue::Object(e)
            })
            .collect();
        o.insert("drift", JsValue::Array(drift));
        o.insert("fresh", JsValue::Bool(self.fresh));
        o.insert(
            "stale",
            JsValue::Array(self.stale.iter().map(|s| JsValue::string(s)).collect()),
        );
        o.insert("consumed", JsValue::Bool(self.consumed));
        o.insert(
            "gateKind",
            self.gate_kind.map_or(JsValue::Null, JsValue::string),
        );
        o.insert("error", opt_string(self.error.as_ref()));
        JsValue::Object(o)
    }
}

/// The inputs of a read-only `checkReceipt`.
#[derive(Clone, Copy)]
pub struct CheckOptions<'a> {
    /// `cwd` as the TS received it.
    pub cwd: &'a str,
    /// The process directory `cwd` resolves against.
    pub process_cwd: &'a str,
    pub feature: &'a str,
    pub target: &'a str,
    pub dir: &'a str,
    /// `qualityGate.full`; `""` when none is configured.
    pub gate: &'a str,
    pub include_consumed: bool,
    /// The shared absolute deadline, if any.
    pub deadline: Option<Instant>,
    /// `currentContent` for the review correlation.
    pub current_content: Option<&'a Result<content_identity::Identity, content_identity::Failure>>,
    pub runner: &'a dyn ProcessRunner,
    pub env: &'a Env,
}

/// Why a step stopped: a message the TS puts in `result.error`, or [`Unmodeled`].
enum Stop {
    Message(String),
    Unmodeled,
}

impl From<Unmodeled> for Stop {
    fn from(_: Unmodeled) -> Self {
        Self::Unmodeled
    }
}

fn refusal(r: Refusal) -> Stop {
    match r {
        Refusal::Message(m) => Stop::Message(m),
        Refusal::Unmodeled => Stop::Unmodeled,
    }
}

type Step<T> = Result<T, Stop>;

/// `git(cwd, args, nul, deadline)`: an `Err` is any throw, so callers that catch it can.
struct Git<'a> {
    cwd: &'a Path,
    runner: &'a dyn ProcessRunner,
    env: Vec<(OsString, OsString)>,
    has_path: bool,
    deadline: Option<Instant>,
}

impl<'a> Git<'a> {
    fn new(cwd: &'a Path, options: &CheckOptions<'a>) -> Self {
        let has_path = options
            .env
            .iter()
            .any(|(k, v)| k == "PATH" && !v.is_empty());
        let mut env: Vec<_> = options
            .env
            .iter()
            .filter(|(k, _)| k != "GIT_OPTIONAL_LOCKS")
            .cloned()
            .collect();
        env.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
        Self {
            cwd,
            runner: options.runner,
            env,
            has_path,
            deadline: options.deadline,
        }
    }

    fn run(&self, args: &[&str], nul: bool) -> Step<String> {
        let timeout = match self.deadline {
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    return Err(Stop::Message("receipt timeout".into()));
                }
                (deadline - now).max(Duration::from_millis(1))
            }
            None => Duration::from_secs(60 * 60),
        };
        if !self.has_path {
            return Err(Stop::Message("git failed: PATH is empty".into()));
        }
        let mut full = vec!["-c", "core.fsmonitor=false", "-c", "core.quotepath=false"];
        full.extend_from_slice(args);
        let output = self
            .runner
            .run(&Request {
                program: "git",
                args: &full,
                cwd: self.cwd,
                env: &self.env,
                input: None,
                timeout,
            })
            .map_err(|_| Stop::Unmodeled)?;
        // The message would carry git's stderr.
        if !output.status.success() {
            return Err(Stop::Unmodeled);
        }
        let text = String::from_utf8(output.stdout).map_err(|_| Stop::Unmodeled)?;
        Ok(if nul { text } else { js_trim(&text).to_owned() })
    }
}

fn paths_from_nul(value: &str) -> Vec<String> {
    value
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `validatePath(cwd, path)`.
fn validate_path(cwd: &str, path: &str) -> Step<()> {
    if path.contains(['\n', '\r']) {
        let quoted = JsValue::string(path)
            .stringify(None)
            .ok_or(Stop::Unmodeled)?;
        return Err(Stop::Message(format!(
            "path cannot be represented in receipt: {quoted}"
        )));
    }
    let rel = relative(cwd, &resolve(cwd, path));
    if rel == ".." || rel.starts_with("../") {
        return Err(Stop::Message(format!("path escapes repository: {path}")));
    }
    Ok(())
}

/// `liveBlob(cwd, path, { readOnly: true })`.
fn live_blob(git: &Git<'_>, cwd: &str, path: &str) -> Step<String> {
    let meta = std::fs::symlink_metadata(resolve(cwd, path)).map_err(|_| Stop::Unmodeled)?;
    if !meta.is_file() {
        return Err(Stop::Message(format!(
            "unsupported non-regular file: {path}"
        )));
    }
    git.run(&["hash-object", "--no-filters", "--", path], false)
}

struct Inspected {
    target_sha: String,
    head_sha: String,
    paths: Vec<String>,
}

/// `/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/`.
fn raw_record(record: &str) -> Option<(&str, &str, &str, &str, char)> {
    let rest = record.strip_prefix(':')?;
    let mut parts = rest.splitn(5, ' ');
    let old_mode = parts.next()?;
    let new_mode = parts.next()?;
    let old_blob = parts.next()?;
    let new_blob = parts.next()?;
    let status = parts.next()?.chars().next()?;
    let mode = |m: &str| m.len() == 6 && m.bytes().all(|b| (b'0'..=b'7').contains(&b));
    let blob = |b: &str| !b.is_empty() && b.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    (mode(old_mode)
        && mode(new_mode)
        && blob(old_blob)
        && blob(new_blob)
        && status.is_ascii_uppercase())
    .then_some((old_mode, new_mode, old_blob, new_blob, status))
}

/// `inspect(options)` with `readOnly`: no fetch.
fn inspect(git: &Git<'_>, cwd: &str, target: &str) -> Step<Inspected> {
    let remotes = git.run(&["remote"], false)?;
    let (reference, label) = if remotes.split('\n').any(|r| r == "origin") {
        (format!("origin/{target}"), format!("origin/{target}"))
    } else {
        let local = format!("refs/heads/{target}");
        if git
            .run(&["rev-parse", "--verify", "--quiet", &local], false)
            .is_err()
        {
            return Err(Stop::Message(format!(
                "no 'origin' remote and no local branch '{target}': set branchBase (navori configure branch-base <branch>) or pass --target <branch>"
            )));
        }
        let current = git
            .run(&["symbolic-ref", "-q", "--short", "HEAD"], false)
            .unwrap_or_default();
        if current == target {
            return Err(Stop::Message(format!(
                "no 'origin' remote and the current branch is the target '{target}': switch to a feature branch or pass --target <branch>"
            )));
        }
        (local, target.to_owned())
    };
    let target_sha = git.run(&["rev-parse", &reference], false)?;
    let head_sha = git.run(&["rev-parse", "HEAD"], false)?;
    if git.run(
        &["rev-list", "--count", &format!("HEAD..{reference}")],
        false,
    )? != "0"
    {
        return Err(Stop::Message(format!("branch is behind {label}")));
    }
    let mut raw = paths_from_nul(&git.run(
        &[
            "diff",
            "--raw",
            "--no-renames",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            &reference,
        ],
        true,
    )?);
    raw.extend(paths_from_nul(&git.run(
        &[
            "diff",
            "--cached",
            "--raw",
            "--no-renames",
            "-z",
            &reference,
        ],
        true,
    )?));
    let regular = |mode: &str| mode == "100644" || mode == "100755";
    for record in raw.iter().filter(|r| r.starts_with(':')) {
        let Some((old_mode, new_mode, old_blob, new_blob, status)) = raw_record(record) else {
            return Err(Stop::Message("unreadable git diff record".into()));
        };
        if (!regular(old_mode) && !(status == 'A' && old_mode == "000000"))
            || (!regular(new_mode) && !(status == 'D' && new_mode == "000000"))
        {
            return Err(Stop::Message("unsupported non-regular git entry".into()));
        }
        let unhashed = new_blob.bytes().all(|b| b == b'0');
        if old_mode != new_mode && old_blob == new_blob && !unhashed {
            return Err(Stop::Message("diff changes file mode only".into()));
        }
    }
    let tracked = paths_from_nul(&git.run(
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            &reference,
        ],
        true,
    )?);
    let untracked =
        paths_from_nul(&git.run(&["ls-files", "--others", "--exclude-standard", "-z"], true)?);
    let mut paths: Vec<String> = Vec::new();
    for path in tracked.into_iter().chain(untracked) {
        if !paths.contains(&path) && !PROGRESS_DIRS.iter().any(|d| path.starts_with(d)) {
            paths.push(path);
        }
    }
    // `Array.prototype.sort`: UTF-16 code unit order.
    paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for path in &paths {
        validate_path(cwd, path)?;
    }
    Ok(Inspected {
        target_sha,
        head_sha,
        paths,
    })
}

struct Header {
    version: f64,
    feature: String,
    gate: Option<String>,
    inputs: Option<String>,
}

fn header_re() -> Option<Regex> {
    let s = crate::js_re::non_ws();
    Regex::new(&format!(
        r"^# navori-receipt v([0-9]+) feature=({s}+)(?: base=({s}+) gate=({s}+) inputs=({s}+))?$"
    ))
    .ok()
}

fn record_re() -> Option<Regex> {
    Regex::new(&format!(
        r"^(deleted|[0-9a-f]{{40}})  ({}+)$",
        crate::js_re::DOT
    ))
    .ok()
}

/// `readReceiptFile(path)`: the header and the records in `Map` insertion order.
fn read_receipt(path: &str) -> Step<(Header, Vec<(String, String)>)> {
    if std::fs::metadata(path).is_err() {
        return Err(Stop::Message("receipt is absent".into()));
    }
    let bytes = std::fs::read(path).map_err(|_| Stop::Unmodeled)?;
    let text = String::from_utf8(bytes).map_err(|_| Stop::Unmodeled)?;
    let mut lines = text.split('\n');
    let malformed = || Stop::Message("receipt is malformed".into());
    let first = lines.next().unwrap_or_default();
    let captures = header_re()
        .ok_or(Stop::Unmodeled)?
        .captures(first)
        .ok_or_else(malformed)?;
    let group = |i: usize| captures.get(i).map(|m| m.as_str().to_owned());
    let header = Header {
        version: group(1)
            .and_then(|v| v.parse().ok())
            .ok_or(Stop::Unmodeled)?,
        feature: group(2).ok_or_else(malformed)?,
        gate: group(4),
        inputs: group(5),
    };
    let record = record_re().ok_or(Stop::Unmodeled)?;
    let mut records: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let captures = record.captures(line).ok_or_else(malformed)?;
        let (blob, path) = (captures[1].to_owned(), captures[2].to_owned());
        match records.iter_mut().find(|(p, _)| *p == path) {
            Some(entry) => entry.1 = blob,
            None => records.push((path, blob)),
        }
    }
    Ok((header, records))
}

fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// `checkReceipt({ ...options, readOnly: true })`; `None` hands the call to the TS.
#[must_use]
pub fn check_receipt(options: &CheckOptions<'_>) -> Option<ReceiptResult> {
    match check(options) {
        Ok(result) => Some(result),
        Err(Stop::Message(message)) => Some(ReceiptResult::error(options.target, message)),
        Err(Stop::Unmodeled) => None,
    }
}

fn check(options: &CheckOptions<'_>) -> Step<ReceiptResult> {
    let root = resolve_state_root(
        options.cwd,
        options.process_cwd,
        options.feature,
        Some(options.dir),
    )
    .map_err(refusal)?;
    require_current_review(&root, options)?;
    let cwd = root.cwd.as_str();
    let git = Git::new(Path::new(cwd), options);
    let state = inspect(&git, cwd, options.target)?;
    let main = artifact_path(&root, "receipt.txt").map_err(refusal)?;
    let (path, consumed) = if exists(&main) {
        (main, false)
    } else {
        let archived = artifact_path(&root, "receipt.consumed.txt").map_err(refusal)?;
        if options.include_consumed && exists(&archived) {
            (archived, true)
        } else {
            return Err(Stop::Message("receipt is absent".into()));
        }
    };
    let (header, records) = read_receipt(&path)?;
    if header.feature != options.feature {
        return Err(Stop::Message(format!(
            "receipt belongs to feature \"{}\", not \"{}\"",
            header.feature, options.feature
        )));
    }
    let uncovered: Vec<String> = state
        .paths
        .iter()
        .filter(|p| !records.iter().any(|(r, _)| r == *p))
        .cloned()
        .collect();
    let mut drift = Vec::new();
    for (path, blob) in &records {
        validate_path(cwd, path)?;
        let present = exists(&resolve(cwd, path));
        if blob == "deleted" {
            if present {
                drift.push(Drift {
                    path: path.clone(),
                    blob: None,
                    kind: "reappeared",
                });
            }
        } else if !present {
            drift.push(Drift {
                path: path.clone(),
                blob: Some(blob.clone()),
                kind: "missing",
            });
        } else if live_blob(&git, cwd, path)? != *blob {
            drift.push(Drift {
                path: path.clone(),
                blob: Some(blob.clone()),
                kind: "changed",
            });
        }
    }
    let mut stale = Vec::new();
    if header.version == 2.0 {
        let identity = evidence_identity(Path::new(cwd), options.gate)?;
        if header.gate.as_deref() != Some(identity.gate.as_str()) {
            stale.push("gate");
        }
        if header.inputs.as_deref() != Some(identity.inputs.as_str()) {
            stale.push("inputs");
        }
    } else {
        stale.push("format");
    }
    let gate_kind = if header.version != 2.0 {
        None
    } else if header.gate.as_deref() == Some(SCOPED_GATE) {
        Some("scoped")
    } else {
        Some("full")
    };
    let status = if uncovered.is_empty() && drift.is_empty() {
        "ok"
    } else {
        "findings"
    };
    Ok(ReceiptResult {
        target: options.target.to_owned(),
        target_sha: Some(state.target_sha),
        head_sha: Some(state.head_sha),
        status,
        uncovered,
        drift,
        fresh: stale.is_empty(),
        stale,
        consumed,
        gate_kind,
        error: None,
    })
}

/// `requireCurrentReview(root, options)`.
fn require_current_review(root: &StateRoot, options: &CheckOptions<'_>) -> Step<()> {
    let mut recorded = false;
    for kind in ["ownership", "review"] {
        let path =
            artifact_path(root, &format!("{kind}_{}.json", options.feature)).map_err(refusal)?;
        recorded |= exists(&path);
    }
    if !codex_thread(options.env) && !recorded {
        return Ok(());
    }
    let evidence = EvidenceOptions {
        target: options.target,
        gate: options.gate,
        current_content: options.current_content,
        timeout: None,
    };
    match review_evidence_warning(root, options.feature, Some(&evidence), options.env)? {
        Some(problem) => Err(Stop::Message(problem)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_records_follow_the_ts_pattern() {
        assert!(raw_record(":100644 100644 abc def M").is_some());
        assert!(raw_record(":100644 100644 abc def M100").is_some());
        assert!(raw_record(":100644 10064 abc def M").is_none());
        assert!(raw_record(":100644 100644 abc DEF M").is_none());
        assert!(raw_record(":100644 100644 abc def m").is_none());
    }

    #[test]
    fn the_header_regex_reads_v1_and_v2() {
        let Some(re) = header_re() else {
            unreachable!("static pattern");
        };
        assert!(re.is_match("# navori-receipt v1 feature=x"));
        assert!(re.is_match("# navori-receipt v2 feature=x base=a gate=b inputs=c"));
        assert!(!re.is_match("# navori-receipt v2 feature=x base=a gate=b"));
    }
}
