//! The tree fingerprint and HEAD behind recorded acceptance evidence (`lib/plan/evidence.ts`,
//! spec 0060 T10/T11 and the delivery commands of T8). Git runs through a
//! [`ProcessRunner`] (D42) with the TS's hardening flags.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::content_identity::{IDENTITY_EXCLUDES, hex};
use crate::js_json::JsValue;
use crate::plan::expected::{Expected, parse_expected};
use crate::process::{Env, ProcessRunner, Request};

/// `FINGERPRINT_VERSION`: the `fp` an evidence line records for the current exclude set.
pub const FINGERPRINT_VERSION: u32 = 2;

/// The exclude set of evidence lines recorded before `fp` existed.
const LEGACY_FINGERPRINT_EXCLUDES: &[&str] = &[
    ".navori/state",
    ".claude/progress",
    ".codex/progress",
    ".claude/worktrees",
];

/// `PURE_EVIDENCE_RUNNERS`: test runners whose result does not depend on HEAD.
const PURE_EVIDENCE_RUNNERS: &[&[&str]] = &[
    &["bun", "run", "test"],
    &["bun", "run", "test:golden"],
    &["bun", "x", "vitest", "run"],
];

/// `/^[\w@.:/=,+%-]+$/`.
fn pure_arg(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_@.:/=,+%-".contains(&b))
}

/// `/^cd[ \t]+([^\s&;|<>$`"'\\*?[\]{}()~]+)$/`: the directory of a plain `cd`.
fn cd_dir(segment: &str) -> Option<&str> {
    let rest = segment.strip_prefix("cd")?;
    let dir = rest.trim_start_matches([' ', '\t']);
    if dir.len() == rest.len() || dir.is_empty() {
        return None;
    }
    let bad =
        |c: char| crate::integrity::is_js_whitespace(c) || "&;|<>$`\"'\\*?[]{}()~".contains(c);
    (!dir.contains(bad)).then_some(dir)
}

/// `isPureEvidenceRunner`: `cd <relative dir> && … && <pure runner> [args]`, nothing else.
#[must_use]
pub fn is_pure_evidence_runner(command: &str) -> bool {
    if command.contains([
        ';', '|', '$', '`', '<', '>', '(', ')', '\n', '\r', '\\', '\'', '"',
    ]) || command.replace("&&", "").contains('&')
    {
        return false;
    }
    let mut segments: Vec<&str> = command.split("&&").map(crate::posix::js_trim).collect();
    let runner = segments.pop().unwrap_or_default();
    for segment in segments {
        let Some(dir) = cd_dir(segment) else {
            return false;
        };
        if dir.starts_with('/')
            || dir
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return false;
        }
    }
    // `runner.split(/\s+/)` on a trimmed runner: whitespace runs collapse, and an empty runner
    // is `[""]`, which no token rule accepts.
    let tokens: Vec<&str> = runner
        .split(crate::integrity::is_js_whitespace)
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() || !tokens.iter().all(|t| pure_arg(t)) {
        return false;
    }
    PURE_EVIDENCE_RUNNERS.iter().any(|prefix| {
        prefix
            .iter()
            .enumerate()
            .all(|(i, w)| tokens.get(i) == Some(w))
    })
}

/// What git calls, with the TS's hardening flags and remaining budget.
pub struct Git<'a> {
    /// The transport.
    pub runner: &'a dyn ProcessRunner,
    /// The environment the TS process would hand to git.
    pub env: &'a Env,
    /// Absolute deadline, if any.
    pub deadline: Option<Instant>,
}

impl Git<'_> {
    fn remaining(&self) -> Option<Duration> {
        match self.deadline {
            None => Some(Duration::from_secs(60 * 60)),
            Some(deadline) => {
                let now = Instant::now();
                (now < deadline).then(|| (deadline - now).max(Duration::from_millis(1)))
            }
        }
    }

    /// `git(cwd, args)`: stdout bytes, or `None` on any failure or an expired deadline.
    fn run(&self, cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
        let timeout = self.remaining()?;
        let mut full = vec![
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ];
        full.extend_from_slice(args);
        let output = self
            .runner
            .run(&Request {
                program: "git",
                args: &full,
                cwd,
                env: self.env,
                input: None,
                timeout,
            })
            .ok()?;
        output.status.success().then_some(output.stdout)
    }

    fn expired(&self) -> bool {
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }
}

/// `readHead(tree)`: `git rev-parse HEAD`, trimmed, or empty.
#[must_use]
pub fn read_head(git: &Git<'_>, tree: &Path) -> String {
    git.run(tree, &["rev-parse", "HEAD"])
        .map(|out| crate::posix::js_trim(&String::from_utf8_lossy(&out)).to_owned())
        .unwrap_or_default()
}

/// `Fingerprint`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fingerprint {
    /// The tree hash git would write for the working tree.
    Ok(String),
    /// Why it could not be computed.
    Failed(String),
}

fn failed(reason: &str) -> Fingerprint {
    Fingerprint::Failed(reason.to_owned())
}

#[derive(Clone, Copy)]
enum Format {
    Sha1,
    Sha256,
}

impl Format {
    fn digest(self, parts: &[&[u8]]) -> String {
        match self {
            Self::Sha1 => {
                let mut h = Sha1::new();
                for p in parts {
                    h.update(p);
                }
                hex(&h.finalize())
            }
            Self::Sha256 => {
                let mut h = Sha256::new();
                for p in parts {
                    h.update(p);
                }
                hex(&h.finalize())
            }
        }
    }

    fn blob(self, bytes: &[u8]) -> String {
        self.digest(&[format!("blob {}\0", bytes.len()).as_bytes(), bytes])
    }
}

/// `realpathSync`, or `None`.
fn real(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Options of `fingerprintTree`.
#[derive(Debug, Clone, Copy, Default)]
pub struct FingerprintOptions<'a> {
    /// `binding.stagePath` of a delivery: its `state.json` and `STATUS.md` are excluded.
    pub stage_path: Option<&'a str>,
    /// The exclude set of evidence recorded before `fp`.
    pub legacy: bool,
}

/// `DeliveryEvidenceBindingSchema.shape.stagePath`: relative, no empty, `.` or `..` segment,
/// no tab, CR, LF or backslash.
fn valid_stage_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\t', '\r', '\n', '\\'])
        && !path.starts_with('/')
        && !path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
}

/// `fingerprintTree(tree, binding, options)`: the git tree hash of the working tree (tracked
/// plus untracked, not ignored), without the state directories.
#[must_use]
pub fn fingerprint_tree(
    git: &Git<'_>,
    tree: &Path,
    options: FingerprintOptions<'_>,
) -> Fingerprint {
    let base = if options.legacy {
        LEGACY_FINGERPRINT_EXCLUDES
    } else {
        IDENTITY_EXCLUDES
    };
    let mut excludes: Vec<String> = base.iter().map(|e| (*e).to_owned()).collect();
    if let Some(stage_path) = options.stage_path {
        if !valid_stage_path(stage_path) {
            return failed("invalid delivery binding");
        }
        let root = real(tree);
        let stage = root.as_ref().map(|r| r.join(stage_path));
        let contained = match (&root, &stage) {
            (Some(root), Some(stage)) => {
                stage.starts_with(root) && stage != root && real(stage).as_ref() == Some(stage)
            }
            _ => false,
        };
        let (Some(_), Some(stage), true) = (root, stage, contained) else {
            return failed("delivery stage is not physically contained");
        };
        for name in ["state.json", "STATUS.md"] {
            let path = stage.join(name);
            if (name == "state.json" || path.exists()) && real(&path).as_ref() != Some(&path) {
                return failed("delivery lifecycle file is missing or redirected");
            }
            excludes.push(format!("{stage_path}/{name}"));
        }
    }
    let format = match git
        .run(tree, &["rev-parse", "--show-object-format"])
        .map(|out| crate::posix::js_trim(&String::from_utf8_lossy(&out)).to_owned())
        .as_deref()
    {
        Some("sha1") => Format::Sha1,
        Some("sha256") => Format::Sha256,
        _ => return failed("not a readable git checkout"),
    };
    let patterns: Vec<String> = excludes
        .iter()
        .map(|p| format!(":(exclude,literal){p}"))
        .collect();
    let mut args = vec![
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
        "--",
        ".",
    ];
    args.extend(patterns.iter().map(String::as_str));
    let Some(listed) = git.run(tree, &args) else {
        return failed("git ls-files failed");
    };
    let mut entries = Vec::new();
    for raw in listed.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        if git.expired() {
            return failed("timeout");
        }
        // `encoding: "utf8"` turns invalid bytes into U+FFFD: that path no longer exists.
        let Ok(path) = std::str::from_utf8(raw) else {
            continue;
        };
        if path.contains('\n') {
            return failed("a tracked path contains a newline");
        }
        let absolute = tree.join(path);
        let Ok(meta) = std::fs::symlink_metadata(&absolute) else {
            continue;
        };
        let file_type = meta.file_type();
        let entry = if file_type.is_symlink() {
            std::fs::read_link(&absolute)
                .ok()
                .map(|target| ("120000", format.blob(target.as_os_str().as_bytes())))
        } else if file_type.is_file() {
            let mode = if meta.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            };
            std::fs::read(&absolute)
                .ok()
                .map(|bytes| (mode, format.blob(&bytes)))
        } else {
            continue;
        };
        let Some((mode, hash)) = entry else {
            return failed(&format!("cannot hash {path}"));
        };
        entries.push((mode, hash, path.to_owned()));
    }
    memory_tree(&entries, format, git)
}

enum Node {
    Leaf { mode: &'static str, hash: String },
    Dir(BTreeMap<String, Node>),
}

fn memory_tree(
    entries: &[(&'static str, String, String)],
    format: Format,
    git: &Git<'_>,
) -> Fingerprint {
    let mut root: BTreeMap<String, Node> = BTreeMap::new();
    for (mode, hash, path) in entries {
        if git.expired() {
            return failed("timeout");
        }
        let parts: Vec<&str> = path.split('/').collect();
        let (last, dirs) = parts.split_last().unwrap_or((&"", &[]));
        let mut node = &mut root;
        for part in dirs {
            let child = node
                .entry((*part).to_owned())
                .or_insert_with(|| Node::Dir(BTreeMap::new()));
            node = match child {
                Node::Dir(map) => map,
                Node::Leaf { .. } => return failed("tree collision"),
            };
        }
        node.insert(
            (*last).to_owned(),
            Node::Leaf {
                mode,
                hash: hash.clone(),
            },
        );
    }
    match hash_tree(&root, format, git) {
        Some(hash) if !git.expired() => Fingerprint::Ok(hash),
        _ => failed("timeout"),
    }
}

fn hash_tree(node: &BTreeMap<String, Node>, format: Format, git: &Git<'_>) -> Option<String> {
    if git.expired() {
        return None;
    }
    let key = |name: &str, value: &Node| -> Vec<u8> {
        let mut bytes = name.as_bytes().to_vec();
        if matches!(value, Node::Dir(_)) {
            bytes.push(b'/');
        }
        bytes
    };
    let mut sorted: Vec<(&String, &Node)> = node.iter().collect();
    sorted.sort_by_key(|(name, value)| key(name, value));
    let mut bytes = Vec::new();
    for (name, value) in sorted {
        if git.expired() {
            return None;
        }
        let (mode, hash) = match value {
            Node::Dir(map) => ("40000", hash_tree(map, format, git)?),
            Node::Leaf { mode, hash } => (*mode, hash.clone()),
        };
        bytes.extend_from_slice(format!("{mode} {name}\0").as_bytes());
        bytes.extend_from_slice(&unhex(&hash)?);
    }
    if git.expired() {
        return None;
    }
    Some(format.digest(&[format!("tree {}\0", bytes.len()).as_bytes(), &bytes]))
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The environment a TS process inherits, as `(key, value)` pairs.
#[must_use]
pub fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

/// `DeliveryEvidenceBindingSchema`'s keys, in declaration order.
const BINDING_KEYS: [&str; 8] = [
    "policy",
    "authorityGeneration",
    "stagePath",
    "sourceIdentity",
    "baselineIdentity",
    "queueIdentity",
    "qualifiedId",
    "criterionIdentity",
];

/// A valid `DeliveryEvidenceBinding`, kept as the parsed values of its eight keys and its
/// `stagePath`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryBinding {
    values: Vec<JsValue>,
    stage_path: String,
}

impl DeliveryBinding {
    /// `binding.stagePath`.
    #[must_use]
    pub fn stage_path(&self) -> &str {
        &self.stage_path
    }

    /// `DeliveryEvidenceBindingSchema.safeParse(value)` (a strict object).
    #[must_use]
    pub fn parse(value: &JsValue) -> Option<Self> {
        let JsValue::Object(object) = value else {
            return None;
        };
        if object
            .entries()
            .iter()
            .any(|(k, _)| !BINDING_KEYS.iter().any(|b| k.is(b)))
        {
            return None;
        }
        let text = |v: &JsValue| match v {
            JsValue::String(s) => s.to_rust(),
            _ => None,
        };
        let hex64 = |v: &JsValue| {
            text(v).is_some_and(|t| {
                t.len() == 64
                    && t.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        };
        let mut values = Vec::with_capacity(BINDING_KEYS.len());
        for key in BINDING_KEYS {
            let value = object.get(key)?;
            let ok = match key {
                "policy" => matches!(value, JsValue::String(s) if s.is("deliveries-content-v1")),
                "authorityGeneration" => matches!(value, JsValue::Number(n)
                    if n.fract() == 0.0 && *n > 0.0 && n.is_finite()),
                "stagePath" => text(value).is_some_and(|t| valid_stage_path(&t)),
                "qualifiedId" => text(value).is_some_and(|t| qualified_id(&t)),
                _ => hex64(value),
            };
            if !ok {
                return None;
            }
            values.push(value.clone());
        }
        let stage_path = text(object.get("stagePath")?)?;
        Some(Self { values, stage_path })
    }
}

/// `/^P\d+\.A\d+$/`.
fn qualified_id(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('P') else {
        return false;
    };
    let Some((part, criterion)) = rest.split_once(".A") else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(part) && digits(criterion)
}

/// One parsed `workplan_<feature>.evidence.jsonl` line (`EvidenceLineSchema`).
#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceLine {
    /// `ts`.
    pub ts: String,
    /// `feature`.
    pub feature: String,
    /// `id`.
    pub id: String,
    /// `command`.
    pub command: String,
    /// `tree`.
    pub tree: String,
    /// `cwd`.
    pub cwd: String,
    /// `head`.
    pub head: String,
    /// `worktreeTree`.
    pub worktree_tree: String,
    /// `fp` (only `2` parses).
    pub fp: Option<u32>,
    /// `dirty`.
    pub dirty: bool,
    /// `exit`, `-1` when present but invalid.
    pub exit: Option<i64>,
    /// `expected`, empty when present but invalid.
    pub expected: Option<String>,
    /// `outcome`, `unevaluated` when present but invalid.
    pub outcome: Option<String>,
    /// `deliveryBinding`.
    pub delivery_binding: Option<DeliveryBinding>,
}

/// `EvidenceLineSchema.safeParse(value)`: `Ok(None)` when zod rejects it, `Err(())` when Rust
/// cannot model a value the TS would read.
fn parse_line(value: &JsValue) -> Result<Option<EvidenceLine>, ()> {
    let JsValue::Object(o) = value else {
        return Ok(None);
    };
    let optional = |key: &str| match o.get(key) {
        None | Some(JsValue::Undefined) => None,
        Some(v) => Some(v),
    };
    let mut required = Vec::new();
    for key in [
        "ts",
        "feature",
        "id",
        "command",
        "tree",
        "cwd",
        "head",
        "worktreeTree",
    ] {
        match o.get(key) {
            Some(JsValue::String(s)) => required.push(s.to_rust().ok_or(())?),
            _ => return Ok(None),
        }
    }
    let fp = match optional("fp") {
        None => None,
        Some(JsValue::Number(n)) if *n == f64::from(FINGERPRINT_VERSION) => {
            Some(FINGERPRINT_VERSION)
        }
        Some(_) => return Ok(None),
    };
    let Some(JsValue::Bool(dirty)) = o.get("dirty") else {
        return Ok(None);
    };
    for key in ["sessionId", "agentId"] {
        if let Some(v) = optional(key)
            && !matches!(v, JsValue::String(_))
        {
            return Ok(None);
        }
    }
    let delivery_binding = match optional("deliveryBinding") {
        None => None,
        Some(v) => match DeliveryBinding::parse(v) {
            Some(binding) => Some(binding),
            None => return Ok(None),
        },
    };
    let exit = optional("exit").map(|v| match v {
        JsValue::Number(n) if n.fract() == 0.0 && (0.0..=255.0).contains(n) => {
            #[allow(clippy::cast_possible_truncation, reason = "an integer in 0..=255")]
            let code = *n as i64;
            code
        }
        _ => -1,
    });
    let expected = match optional("expected") {
        None => None,
        Some(JsValue::String(s)) => Some(s.to_rust().ok_or(())?),
        Some(_) => Some(String::new()),
    };
    let outcome = optional("outcome").map(|v| match v {
        JsValue::String(s) if s.is("pass") || s.is("fail") || s.is("unevaluated") => {
            s.to_rust().unwrap_or_default()
        }
        _ => "unevaluated".to_owned(),
    });
    let mut fields = required.into_iter();
    let mut next = || fields.next().unwrap_or_default();
    Ok(Some(EvidenceLine {
        ts: next(),
        feature: next(),
        id: next(),
        command: next(),
        tree: next(),
        cwd: next(),
        head: next(),
        worktree_tree: next(),
        fp,
        dirty: *dirty,
        exit,
        expected,
        outcome,
        delivery_binding,
    }))
}

/// `readEvidenceLog(path)`: the lines zod accepts, in file order. `None` when a line is one
/// Rust cannot parse or model (the TS may read it).
#[must_use]
pub fn read_evidence_log(path: &Path) -> Option<Vec<EvidenceLine>> {
    let Ok(text) = std::fs::read(path) else {
        return (!path.exists()).then(Vec::new);
    };
    let text = String::from_utf8(text).ok()?;
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        if crate::posix::js_trim(raw).is_empty() {
            continue;
        }
        let value = crate::js_json::parse(raw)?;
        if let Some(line) = parse_line(&value).ok()? {
            lines.push(line);
        }
    }
    Some(lines)
}

/// `expectedEvidenceProblem(expected, line)`; outer `None` when only JS can judge `expected`.
#[must_use]
pub fn expected_evidence_problem(expected: &str, line: &EvidenceLine) -> Option<Option<String>> {
    expected_problem(expected, line)
        .map(|p| p.map(str::to_owned))
        .or_else(|| match parse_expected(expected)? {
            Expected::Invalid(reason) => {
                Some(Some(format!("invalid structured expected: {reason}")))
            }
            _ => None,
        })
}

/// `expectedEvidenceProblem` for an `expected` Rust parses as valid; `None` otherwise.
fn expected_problem(expected: &str, line: &EvidenceLine) -> Option<Option<&'static str>> {
    let spec = parse_expected(expected)?;
    let (free, code) = match spec {
        Expected::Invalid(_) | Expected::NeedsJs => return None,
        Expected::Free => (true, 0),
        Expected::Exit(code) => (false, i64::from(code)),
        Expected::Contains(_) => (false, 0),
    };
    let not_recorded = "comparison not recorded for the current expected value";
    if line.exit.is_none() && line.expected.is_none() && line.outcome.is_none() {
        return Some((!(free || (matches!(spec, Expected::Exit(0))))).then_some(not_recorded));
    }
    let outcome = line.outcome.as_deref();
    if outcome == Some("unevaluated") {
        return Some(Some(
            "output not comparable (too large, truncated, interrupted or invalid comparison)",
        ));
    }
    if outcome == Some("fail") {
        return Some(Some("expected not met"));
    }
    if line.expected.as_deref().is_some_and(|e| e != expected) {
        return Some(Some(not_recorded));
    }
    if free {
        return Some((line.exit != Some(0)).then_some("successful exit not recorded"));
    }
    if line.expected.as_deref() != Some(expected) || outcome != Some("pass") || line.exit.is_none()
    {
        return Some(Some(not_recorded));
    }
    Some((line.exit != Some(code)).then_some("expected not met"))
}

/// `{ cwd, head, fingerprint }` the caller already computed for one tree.
#[derive(Debug, Clone)]
pub struct Current {
    /// The tree root.
    pub cwd: PathBuf,
    /// Its HEAD.
    pub head: String,
    /// Its current fingerprint.
    pub fingerprint: Fingerprint,
}

/// `ValidateEvidenceInput`.
pub struct ValidateInput<'a> {
    /// The state root of the feature.
    pub root: &'a crate::state_files::StateRoot,
    /// The feature.
    pub feature: &'a str,
    /// The criterion id.
    pub id: &'a str,
    /// The criterion command.
    pub command: &'a str,
    /// The criterion expected value.
    pub expected: &'a str,
    /// The implementer worktree, also accepted as the run's tree.
    pub impl_worktree: Option<&'a Path>,
    /// The producer delivery binding.
    pub delivery_binding: Option<&'a DeliveryBinding>,
    /// Facts already computed for one tree.
    pub current: Option<&'a Current>,
}

/// `EvidenceVerdict`.
#[derive(Debug, Clone, PartialEq)]
pub enum EvidenceVerdict {
    /// The `RecordedEvidence` of the matching run.
    Ok(JsValue),
    /// Why the criterion is not verified and how to fix it.
    Failed {
        /// `why`.
        why: String,
        /// `fix`.
        fix: String,
    },
}

impl EvidenceVerdict {
    /// The verdict as the TS object.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let mut object = crate::js_json::JsObject::new();
        match self {
            Self::Ok(evidence) => {
                object.insert("ok", JsValue::Bool(true));
                object.insert("evidence", evidence.clone());
            }
            Self::Failed { why, fix } => {
                object.insert("ok", JsValue::Bool(false));
                object.insert("why", JsValue::string(why));
                object.insert("fix", JsValue::string(fix));
            }
        }
        JsValue::Object(object)
    }
}

/// `cdChainDir(command)`: the joined directories of plain `cd` segments.
fn cd_chain_dir(command: &str) -> Option<String> {
    if command.contains([';', '\n', '(', '`']) || command.contains("||") || command.contains("$(") {
        return None;
    }
    let mut parts = Vec::new();
    for raw in command.split("&&") {
        let segment = crate::posix::js_trim(raw);
        let Some(dir) = cd_dir(segment) else {
            let words: Vec<&str> = segment.split(crate::integrity::is_js_whitespace).collect();
            if words.iter().any(|w| matches!(*w, "cd" | "pushd" | "popd")) {
                return None;
            }
            continue;
        };
        if dir.starts_with('/')
            || dir
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return None;
        }
        parts.push(dir);
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn cd_target_cwd(tree: &Path, command: &str) -> Option<PathBuf> {
    let target = real(&tree.join(cd_chain_dir(command)?))?;
    (target.starts_with(tree) && target != tree).then_some(target)
}

struct Problem {
    why: String,
    tree: String,
    cwd_mismatch: bool,
}

fn short(head: &str) -> Option<String> {
    head.is_ascii().then(|| {
        let s: String = head.chars().take(7).collect();
        if s.is_empty() { "none".to_owned() } else { s }
    })
}

/// `candidateProblem`; outer `None` when Rust cannot judge the line.
fn candidate_problem(
    git: &Git<'_>,
    line: &EvidenceLine,
    accepted: &[PathBuf],
    input: &ValidateInput<'_>,
    memo: &mut Vec<(PathBuf, bool, Fingerprint)>,
) -> Option<Option<Problem>> {
    let problem = |why: String, tree: String| {
        Some(Some(Problem {
            why,
            tree,
            cwd_mismatch: false,
        }))
    };
    let Some(tree) = real(Path::new(&line.tree)) else {
        return problem(
            format!("tree {} no longer exists", line.tree),
            line.tree.clone(),
        );
    };
    let tree_text = tree.to_str()?.to_owned();
    if !accepted.contains(&tree) {
        return problem(
            format!("ran in {}, not this feature's checkout/worktree", line.tree),
            tree_text,
        );
    }
    let cwd = real(Path::new(&line.cwd));
    if cwd.as_ref() != Some(&tree) && (cwd.is_none() || cwd != cd_target_cwd(&tree, input.command))
    {
        return Some(Some(Problem {
            why: format!("ran from {}, not the tree root {tree_text}", line.cwd),
            tree: tree_text,
            cwd_mismatch: true,
        }));
    }
    let head = match input.current {
        Some(current) if current.cwd == tree => current.head.clone(),
        _ => read_head(git, &tree),
    };
    let head_moved = format!(
        "tree changed since the run (HEAD {} \u{2192} {})",
        short(&line.head)?,
        short(&head)?
    );
    let head_bound = input.delivery_binding.is_none() && !is_pure_evidence_runner(input.command);
    if head != line.head && head_bound {
        return problem(head_moved, tree_text);
    }
    if line.delivery_binding.as_ref() != input.delivery_binding {
        return problem(
            "producer delivery authority or criterion definition changed".to_owned(),
            tree_text,
        );
    }
    let legacy = line.fp.is_none();
    let fingerprint =
        if let Some((_, _, fp)) = memo.iter().find(|(t, l, _)| *t == tree && *l == legacy) {
            fp.clone()
        } else {
            let fp = match input.current {
                Some(current) if !legacy && current.cwd == tree => current.fingerprint.clone(),
                _ => fingerprint_tree(
                    git,
                    &tree,
                    FingerprintOptions {
                        stage_path: input.delivery_binding.map(DeliveryBinding::stage_path),
                        legacy,
                    },
                ),
            };
            memo.push((tree.clone(), legacy, fp.clone()));
            fp
        };
    match fingerprint {
        Fingerprint::Failed(reason) => problem(
            format!("cannot compute the tree fingerprint: {reason}"),
            tree_text,
        ),
        Fingerprint::Ok(hash) if hash != line.worktree_tree => {
            let why = if head == line.head {
                "tree changed since the run (uncommitted changes)".to_owned()
            } else {
                head_moved
            };
            problem(why, tree_text)
        }
        Fingerprint::Ok(_) => Some(None),
    }
}

/// How the acceptance index (the file the evidence hook reads) covers one criterion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IndexCoverage {
    NoFile,
    NoLine,
    DifferentCommand,
    Ok,
}

/// `indexCoverage`: looks the criterion up by feature + id (columns 2, 3) and compares column 1
/// with its escaped command. `None` where the TS's escaping is not certain.
fn index_coverage(
    root: &crate::state_files::StateRoot,
    feature: &str,
    id: &str,
    command: &str,
) -> Option<IndexCoverage> {
    let path = Path::new(&root.cwd).join(".navori/state/handoffs/acceptance-index");
    let Ok(bytes) = std::fs::read(path) else {
        return Some(IndexCoverage::NoFile);
    };
    let text = String::from_utf8_lossy(&bytes);
    let rows: Vec<Vec<&str>> = text
        .split('\n')
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .filter(|cols| cols.get(1) == Some(&feature) && cols.get(2) == Some(&id))
        .collect();
    if rows.is_empty() {
        return Some(IndexCoverage::NoLine);
    }
    let escaped = crate::plan::acceptance_index::json_escape(command)?;
    Some(if rows.iter().any(|cols| cols[0] == escaped) {
        IndexCoverage::Ok
    } else {
        IndexCoverage::DifferentCommand
    })
}

/// `VERBATIM_RULE`: why a command run from the host would not match.
const VERBATIM_RULE: &str = "the hook matches the command verbatim — no pipe, redirection (`2>&1`), env-var prefix, subshell or relative `cd` around it";

fn recorded(line: &EvidenceLine) -> JsValue {
    let mut o = crate::js_json::JsObject::new();
    o.insert("kind", JsValue::string("recorded"));
    o.insert("command", JsValue::string(&line.command));
    o.insert("ranAt", JsValue::string(&line.ts));
    o.insert("tree", JsValue::string(&line.tree));
    o.insert("head", JsValue::string(&line.head));
    o.insert("worktreeTree", JsValue::string(&line.worktree_tree));
    o.insert("dirty", JsValue::Bool(line.dirty));
    if let Some(exit) = line.exit {
        #[allow(clippy::cast_precision_loss, reason = "-1 or 0..=255")]
        o.insert("exit", JsValue::Number(exit as f64));
    }
    if let Some(expected) = &line.expected {
        o.insert("expected", JsValue::string(expected));
    }
    if let Some(outcome) = &line.outcome {
        o.insert("outcome", JsValue::string(outcome));
    }
    JsValue::Object(o)
}

/// `validateEvidence(input)`: the most recent run of exactly this command that is still
/// current, or why none is. `None` when Rust cannot judge it the way the TS would (a log line
/// or an `expected` it does not model, a state artifact the TS refuses).
#[must_use]
pub fn validate_evidence(git: &Git<'_>, input: &ValidateInput<'_>) -> Option<EvidenceVerdict> {
    let (root, feature, id, command) = (input.root, input.feature, input.id, input.command);
    let log =
        crate::state_files::artifact_path(root, &format!("workplan_{feature}.evidence.jsonl"))
            .ok()?;
    let lines: Vec<EvidenceLine> = read_evidence_log(Path::new(&log))?
        .into_iter()
        .filter(|l| l.feature == feature && l.id == id)
        .collect();
    let accepted: Vec<PathBuf> = [Some(Path::new(&root.cwd)), input.impl_worktree]
        .into_iter()
        .flatten()
        .filter_map(real)
        .collect();
    let tree_root = accepted
        .first()
        .and_then(|p| p.to_str().map(str::to_owned))
        .unwrap_or_else(|| root.cwd.clone());
    let rerun = |tree: &str| {
        format!(
            "from {tree}, run exactly:\n         {command}\n       verbatim from the root of that checkout — no pipe, redirection, env-var prefix or relative `cd` (on Pi: `cd {tree} && {command}`)\n       then: navori plan update {feature} --progress {id}=cumplido"
        )
    };
    let fail = |why: &str, fix: String| {
        Some(EvidenceVerdict::Failed {
            why: why.to_owned(),
            fix,
        })
    };
    if lines.is_empty() {
        let render = format!("navori plan render {feature}");
        let cwd = &root.cwd;
        let fix = match index_coverage(root, feature, id, command)? {
            IndexCoverage::NoFile => format!(
                "there is no acceptance index in {cwd}, so no run could be recorded: run `{render}` in {cwd}, then rerun the command.\n       {}",
                rerun(&tree_root)
            ),
            IndexCoverage::NoLine => format!(
                "the acceptance index has no line for {id} of {feature}, so no run could be recorded: run `{render}`, then rerun the command.\n       {}",
                rerun(&tree_root)
            ),
            IndexCoverage::DifferentCommand => format!(
                "the acceptance index has a different command for {id} (the workplan was edited outside the CLI): run `{render}` to refresh it, then rerun the command.\n       {}",
                rerun(&tree_root)
            ),
            IndexCoverage::Ok => format!(
                "{}\n       ({VERBATIM_RULE}; a wrapped command records nothing. Large repos: the hook computes a tree fingerprint after the run and can be killed mid-way, leaving no line; rerun the command, or check the evidence log exists)",
                rerun(&tree_root)
            ),
        };
        return fail("no run recorded", fix);
    }
    let same: Vec<&EvidenceLine> = lines
        .iter()
        .filter(|l| l.command == command)
        .rev()
        .collect();
    if same.is_empty() {
        let fix = match lines.iter().find(|l| l.command.contains(command)) {
            Some(wrapped) => format!(
                "the recorded command wraps the criterion (`{}`): {VERBATIM_RULE}.\n       {}",
                wrapped.command,
                rerun(&tree_root)
            ),
            None => rerun(&tree_root),
        };
        return fail("recorded for a different command", fix);
    }
    let mut first: Option<Problem> = None;
    let mut memo = Vec::new();
    for line in same {
        match candidate_problem(git, line, &accepted, input, &mut memo)? {
            None => {
                if let Some(why) = expected_evidence_problem(input.expected, line)? {
                    return fail(
                        &why,
                        format!(
                            "{}\n       Structured output predicates require an exact host-recorded comparison; command success alone does not verify output. Refresh Claude hooks with navori render --apply; other engines require a supported comparison signal.",
                            rerun(&line.tree)
                        ),
                    );
                }
                return Some(EvidenceVerdict::Ok(recorded(line)));
            }
            Some(problem) => {
                first.get_or_insert(problem);
            }
        }
    }
    let problem = first?;
    if problem.cwd_mismatch {
        return fail(
            &problem.why,
            format!(
                "{}. Either `cd {}` first and rerun from there, or change the criterion's `command` to `cd <dir> && \u{2026}` (a simple relative `cd` chain joined by `&&`), re-render (`navori plan render {feature}`) and run it.\n       then: navori plan update {feature} --progress {id}=cumplido",
                problem.why, problem.tree
            ),
        );
    }
    let accepted_tree = accepted
        .iter()
        .any(|p| p.to_str() == Some(problem.tree.as_str()));
    let mut fix = rerun(if accepted_tree {
        &problem.tree
    } else {
        &tree_root
    });
    if problem.why.starts_with("cannot compute") {
        fix.push_str(&format!("\n       ({})", problem.why));
    }
    fail(&problem.why, fix)
}
