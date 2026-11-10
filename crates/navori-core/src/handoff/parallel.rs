//! Opt-in parallel delivery (`lib/handoff/parallel.ts`, spec 0060 T10): `prepareParallel`,
//! `checkParallel`, `beginParallel`, `completeParallel` and `finalizeParallel`, each planned
//! before the first write. Every entrypoint answers the TS's `Result` and the writes it performs,
//! in order, or `None` where the TS's answer depends on something this port does not reproduce
//! (a zod or `JSON.parse` message, Node's message for an unexpected read failure, a config that
//! prints warnings on every read). `parallelOwnershipValid` stays with the TS:
//! `currentOwnership` delegates any parallel authority.

use std::path::Path;
use std::time::Duration;

use regex::Regex;
use sha2::{Digest, Sha256};

use super::implementation;
use super::native_actor::native_actor;
use super::ownership::{NativeActor, has_lone_surrogate, parse_actor};
use crate::content_identity::{self, CONTENT_MAX_BYTES, CONTENT_TIMEOUT, Identity, hex};
use crate::js_json::{JsObject, JsValue};
use crate::posix::{js_trim, relative};
use crate::process::{self, Env, ProcessRunner};
use crate::spec::classify::{DEFAULT_THRESHOLDS, Thresholds};
use crate::state_files::{Refusal, StateRoot, artifact_path, resolve_state_root};

/// `PROGRESS_DIRS`.
const PROGRESS_DIRS: [&str; 4] = [
    ".claude/progress/",
    ".codex/progress/",
    ".navori/state/",
    "progress/",
];

fn under_progress(path: &str) -> bool {
    PROGRESS_DIRS.iter().any(|d| path.starts_with(d))
}

enum Stop {
    /// What `attempt` reports as `{ status: "error", message }`.
    Message(String),
    Unmodeled,
}

impl From<super::Unmodeled> for Stop {
    fn from(_: super::Unmodeled) -> Self {
        Self::Unmodeled
    }
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

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn stringify(value: &JsValue) -> R<String> {
    value.stringify(None).ok_or(Stop::Unmodeled)
}

/// One write, in the order the TS performs them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Write {
    /// `exclusive(root, name, value)`: `writeFileSync(path, text, { flag: "wx" })`.
    Exclusive { name: String, content: String },
    /// `writeStateFileAtomic(root, name, text)`.
    Atomic { name: String, content: String },
}

/// The planned `Result` of an entrypoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Planned {
    /// Success with its `status` and `runId`, after `writes`.
    Done {
        status: &'static str,
        run_id: String,
        writes: Vec<Write>,
    },
    /// `{ status: "error", message }`, with nothing written.
    Error(String),
}

/// The options every entrypoint resolves (`resolveReceiptOptions` plus the process facts).
pub struct Context<'a> {
    /// The root `resolveReceiptOptions` resolved (`cwd` and `dir`).
    pub root: &'a StateRoot,
    pub feature: &'a str,
    pub target: &'a str,
    /// `process.cwd()`.
    pub process_cwd: &'a str,
    pub env: &'a Env,
    pub runner: &'a dyn ProcessRunner,
    /// The config `readConfig` returns (its `data`), already known to print no warnings.
    pub config: &'a JsValue,
    /// A fresh `randomUUID()` and `new Date().toISOString()`.
    pub uuid: &'a str,
    pub now: &'a str,
}

fn plan(result: R<Planned>) -> Option<Planned> {
    match result {
        Ok(planned) => Some(planned),
        Err(Stop::Message(m)) => Some(Planned::Error(m)),
        Err(Stop::Unmodeled) => None,
    }
}

// ---------------------------------------------------------------------------------------------
// schemas

/// `z.string().trim().min(1)`: the trimmed text.
fn nonempty(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(s) => {
            let text = s.to_rust()?;
            let trimmed = js_trim(&text);
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        _ => None,
    }
}

fn text(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

fn nonempty_list(value: &JsValue) -> Option<Vec<String>> {
    match value {
        JsValue::Array(items) => items.iter().map(nonempty).collect(),
        _ => None,
    }
}

fn strict<'a>(value: &'a JsValue, required: &[&str], optional: &[&str]) -> Option<&'a JsObject> {
    let JsValue::Object(o) = value else {
        return None;
    };
    let known = o
        .entries()
        .iter()
        .all(|(k, _)| required.iter().chain(optional).any(|key| k.is(key)));
    (known && required.iter().all(|k| o.has(k))).then_some(o)
}

fn regex_full(text: &str, prefix: char) -> bool {
    text.strip_prefix(prefix).is_some_and(|d| {
        let mut b = d.bytes();
        b.next().is_some_and(|f| (b'1'..=b'9').contains(&f)) && b.all(|c| c.is_ascii_digit())
    })
}

fn hex_of(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `z.uuid()`: RFC 9562 variants 1-8, the nil and the max UUID, either case.
fn zod_uuid(text: &str) -> bool {
    if text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let parts: Vec<&str> = text.split('-').collect();
    let hexes = |p: &str, n: usize| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit());
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| hexes(p, n))
        && (b'1'..=b'8').contains(&parts[2].as_bytes()[0])
        && matches!(
            parts[3].as_bytes()[0],
            b'8' | b'9' | b'a' | b'b' | b'A' | b'B'
        )
}

/// `z.iso.datetime()`: a real calendar date, `THH:MM:SS(.d+)?Z`.
fn zod_datetime(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return false;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let s = text.get(r)?;
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    let (Some(y), Some(m), Some(d), Some(h), Some(mi), Some(s)) = (
        num(0..4),
        num(5..7),
        num(8..10),
        num(11..13),
        num(14..16),
        num(17..19),
    ) else {
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
    if d == 0 || d > days || h > 23 || mi > 59 || s > 59 {
        return false;
    }
    match &b[19..] {
        [b'Z'] => true,
        [b'.', rest @ .., b'Z'] => !rest.is_empty() && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

fn record(value: &JsValue, check: impl Fn(&str) -> bool) -> Option<JsObject> {
    let JsValue::Object(o) = value else {
        return None;
    };
    let mut out = JsObject::new();
    for (k, v) in o.ordered() {
        let v = text(v).filter(|t| check(t))?;
        out.insert(k.clone(), JsValue::string(&v));
    }
    Some(out)
}

/// `requestSchema`, parsed.
#[derive(Debug, Clone)]
struct ParallelRequest {
    spec: String,
    delivery: String,
    milestone: String,
    implementer_paths: Vec<String>,
    /// `(path, intent, evidence)`.
    markdown_requests: Vec<(String, String, String)>,
    derived_paths: Vec<String>,
}

const REQUEST_KEYS: [&str; 6] = [
    "spec",
    "delivery",
    "milestone",
    "implementerPaths",
    "markdownRequests",
    "derivedPaths",
];

fn markdown_request(value: &JsValue) -> Option<(String, String, String)> {
    let o = strict(value, &["path", "intent", "evidence"], &[])?;
    let field = |k: &str| text(o.get(k)?).filter(|t| !t.is_empty());
    Some((field("path")?, field("intent")?, field("evidence")?))
}

fn parse_request(o: &JsObject) -> Option<ParallelRequest> {
    let delivery = text(o.get("delivery")?).filter(|d| regex_full(d, 'E'))?;
    let milestone = text(o.get("milestone")?).filter(|m| regex_full(m, 'M'))?;
    let implementer_paths = nonempty_list(o.get("implementerPaths")?).filter(|p| !p.is_empty())?;
    let JsValue::Array(requests) = o.get("markdownRequests")? else {
        return None;
    };
    let markdown_requests = requests
        .iter()
        .map(markdown_request)
        .collect::<Option<Vec<_>>>()
        .filter(|r| !r.is_empty())?;
    Some(ParallelRequest {
        spec: nonempty(o.get("spec")?)?,
        delivery,
        milestone,
        implementer_paths,
        markdown_requests,
        derived_paths: nonempty_list(o.get("derivedPaths")?)?,
    })
}

impl ParallelRequest {
    fn prose(&self) -> Vec<String> {
        self.markdown_requests.iter().map(|r| r.0.clone()).collect()
    }

    fn owned(&self) -> Vec<String> {
        let mut out = self.implementer_paths.clone();
        out.extend(self.prose());
        out.extend(self.derived_paths.iter().cloned());
        out
    }

    fn insert_into(&self, o: &mut JsObject) {
        let strings = |v: &[String]| JsValue::Array(v.iter().map(|s| JsValue::string(s)).collect());
        o.insert("spec", JsValue::string(&self.spec));
        o.insert("delivery", JsValue::string(&self.delivery));
        o.insert("milestone", JsValue::string(&self.milestone));
        o.insert("implementerPaths", strings(&self.implementer_paths));
        let requests = self
            .markdown_requests
            .iter()
            .map(|(p, i, e)| {
                let mut r = JsObject::new();
                r.insert("path", JsValue::string(p));
                r.insert("intent", JsValue::string(i));
                r.insert("evidence", JsValue::string(e));
                JsValue::Object(r)
            })
            .collect();
        o.insert("markdownRequests", JsValue::Array(requests));
        o.insert("derivedPaths", strings(&self.derived_paths));
    }
}

/// `contractSchema`, parsed.
#[derive(Debug, Clone)]
struct Contract {
    request: ParallelRequest,
    run_id: String,
    feature: String,
    cwd: String,
    branch: String,
    target: String,
    head: String,
    base: String,
    prepared_at: String,
    bindings: JsObject,
    derived_before: JsObject,
    readonly_before: JsObject,
    previous_run_id: Option<String>,
}

impl Contract {
    /// `JSON.stringify(contractSchema.parse(...))`: the keys in schema order.
    fn parsed_json(&self) -> R<String> {
        let mut o = JsObject::new();
        self.request.insert_into(&mut o);
        o.insert("formatVersion", JsValue::Number(1.0));
        o.insert("runId", JsValue::string(&self.run_id));
        o.insert("feature", JsValue::string(&self.feature));
        o.insert("cwd", JsValue::string(&self.cwd));
        o.insert("branch", JsValue::string(&self.branch));
        o.insert("target", JsValue::string(&self.target));
        o.insert("head", JsValue::string(&self.head));
        o.insert("base", JsValue::string(&self.base));
        o.insert("preparedAt", JsValue::string(&self.prepared_at));
        o.insert("bindings", JsValue::Object(self.bindings.clone()));
        o.insert(
            "derivedBefore",
            JsValue::Object(self.derived_before.clone()),
        );
        o.insert(
            "readonlyBefore",
            JsValue::Object(self.readonly_before.clone()),
        );
        if let Some(previous) = &self.previous_run_id {
            o.insert("previousRunId", JsValue::string(previous));
        }
        stringify(&JsValue::Object(o))
    }

    /// `JSON.stringify(c)` of the object `prepareParallel` builds, in its literal's order.
    fn written_json(&self) -> R<String> {
        let mut o = JsObject::new();
        self.request.insert_into(&mut o);
        o.insert("formatVersion", JsValue::Number(1.0));
        o.insert("feature", JsValue::string(&self.feature));
        o.insert("cwd", JsValue::string(&self.cwd));
        o.insert("target", JsValue::string(&self.target));
        o.insert("head", JsValue::string(&self.head));
        o.insert("base", JsValue::string(&self.base));
        o.insert("branch", JsValue::string(&self.branch));
        o.insert("preparedAt", JsValue::string(&self.prepared_at));
        o.insert("runId", JsValue::string(&self.run_id));
        o.insert("bindings", JsValue::Object(self.bindings.clone()));
        o.insert(
            "derivedBefore",
            JsValue::Object(self.derived_before.clone()),
        );
        o.insert(
            "readonlyBefore",
            JsValue::Object(self.readonly_before.clone()),
        );
        if let Some(previous) = &self.previous_run_id {
            o.insert("previousRunId", JsValue::string(previous));
        }
        stringify(&JsValue::Object(o))
    }

    fn digest(&self) -> R<String> {
        Ok(sha256(self.parsed_json()?.as_bytes()))
    }
}

fn parse_contract(value: &JsValue) -> Option<Contract> {
    let required = [
        "spec",
        "delivery",
        "milestone",
        "implementerPaths",
        "markdownRequests",
        "derivedPaths",
        "formatVersion",
        "runId",
        "feature",
        "cwd",
        "branch",
        "target",
        "head",
        "base",
        "preparedAt",
        "bindings",
        "derivedBefore",
        "readonlyBefore",
    ];
    let o = strict(value, &required, &["previousRunId"])?;
    if !matches!(o.get("formatVersion")?, JsValue::Number(n) if *n == 1.0) {
        return None;
    }
    let sha = |k: &str| text(o.get(k)?).filter(|t| hex_of(t, 40));
    let previous_run_id = match o.get("previousRunId") {
        None => None,
        Some(v) => Some(text(v).filter(|t| zod_uuid(t))?),
    };
    Some(Contract {
        request: parse_request(o)?,
        run_id: text(o.get("runId")?).filter(|t| zod_uuid(t))?,
        feature: nonempty(o.get("feature")?)?,
        cwd: nonempty(o.get("cwd")?)?,
        branch: nonempty(o.get("branch")?)?,
        target: nonempty(o.get("target")?)?,
        head: sha("head")?,
        base: sha("base")?,
        prepared_at: text(o.get("preparedAt")?).filter(|t| zod_datetime(t))?,
        bindings: record(o.get("bindings")?, |t| hex_of(t, 64))?,
        derived_before: record(o.get("derivedBefore")?, |_| true)?,
        readonly_before: record(o.get("readonlyBefore")?, |_| true)?,
        previous_run_id,
    })
}

/// `claimSchema` / `completionSchema` fields the checks read.
#[derive(Debug, Clone)]
struct Claim {
    run_id: String,
    authorization_digest: String,
    actor: NativeActor,
    actor_json: String,
    started_at: String,
}

fn parse_claim(value: &JsValue) -> Option<Claim> {
    let o = strict(
        value,
        &["runId", "authorizationDigest", "actor", "startedAt"],
        &[],
    )?;
    let actor_value = o.get("actor")?;
    let actor = parse_actor(actor_value)?;
    Some(Claim {
        run_id: text(o.get("runId")?).filter(|t| zod_uuid(t))?,
        authorization_digest: text(o.get("authorizationDigest")?).filter(|t| hex_of(t, 64))?,
        actor_json: actor_json(&actor).ok()?,
        actor,
        started_at: text(o.get("startedAt")?).filter(|t| zod_datetime(t))?,
    })
}

#[derive(Debug, Clone)]
struct Completion {
    claim: Claim,
    role: String,
    status: String,
    completed_at: String,
    blockers: usize,
    files: JsObject,
}

fn parse_completion(value: &JsValue) -> Option<Completion> {
    let keys = [
        "runId",
        "authorizationDigest",
        "role",
        "actor",
        "status",
        "startedAt",
        "completedAt",
        "blockers",
        "files",
    ];
    let o = strict(value, &keys, &[])?;
    let actor = parse_actor(o.get("actor")?)?;
    Some(Completion {
        claim: Claim {
            run_id: text(o.get("runId")?).filter(|t| zod_uuid(t))?,
            authorization_digest: text(o.get("authorizationDigest")?).filter(|t| hex_of(t, 64))?,
            actor_json: actor_json(&actor).ok()?,
            actor,
            started_at: text(o.get("startedAt")?).filter(|t| zod_datetime(t))?,
        },
        role: text(o.get("role")?).filter(|r| r == "implementer" || r == "scribe")?,
        status: text(o.get("status")?).filter(|s| s == "DONE" || s == "BLOCKED")?,
        completed_at: text(o.get("completedAt")?).filter(|t| zod_datetime(t))?,
        blockers: nonempty_list(o.get("blockers")?)?.len(),
        files: record(o.get("files")?, |_| true)?,
    })
}

fn actor_value(a: &NativeActor) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in [
        ("host", &a.host),
        ("thread", &a.thread),
        ("root", &a.root),
        ("parent", &a.parent),
        ("role", &a.role),
        ("version", &a.version),
        ("sourceCwd", &a.source_cwd),
        ("sourceHash", &a.source_hash),
    ] {
        o.insert(k, JsValue::string(v));
    }
    JsValue::Object(o)
}

fn actor_json(a: &NativeActor) -> R<String> {
    stringify(&actor_value(a))
}

// ---------------------------------------------------------------------------------------------
// reads, git and paths

/// `readFileSync(path, "utf8")`: a missing file is Node's `ENOENT` message.
fn read_text(path: &str) -> R<String> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| Stop::Unmodeled),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            message(format!("ENOENT: no such file or directory, open '{path}'"))
        }
        Err(_) => Err(Stop::Unmodeled),
    }
}

/// `JSON.parse(readFileSync(path, "utf8"))`.
fn read_json(path: &str) -> R<JsValue> {
    let value = crate::js_json::parse(&read_text(path)?).ok_or(Stop::Unmodeled)?;
    if has_lone_surrogate(&value) {
        return Err(Stop::Unmodeled);
    }
    Ok(value)
}

struct Facts<'a> {
    root: StateRoot,
    feature: &'a str,
    ctx: &'a Context<'a>,
}

impl Facts<'_> {
    /// `git(cwd, args)`: trimmed stdout, or the throw of a non-zero status.
    fn git(&self, args: &[&str]) -> R<String> {
        let mut full = vec!["-c", "core.fsmonitor=false"];
        full.extend_from_slice(args);
        let output = self
            .ctx
            .runner
            .run(&process::Request {
                program: "git",
                args: &full,
                cwd: Path::new(&self.root.cwd),
                env: self.ctx.env,
                input: None,
                timeout: Duration::from_secs(5),
            })
            .map_err(|_| Stop::Unmodeled)?;
        if !output.status.success() {
            return message("parallel git identity unavailable");
        }
        let text = String::from_utf8(output.stdout).map_err(|_| Stop::Unmodeled)?;
        Ok(js_trim(&text).to_owned())
    }

    fn artifact(&self, name: &str) -> R<String> {
        artifact_path(&self.root, name).map_err(refusal)
    }

    fn contract(&self) -> R<Contract> {
        let value = read_json(&self.artifact(&format!("parallel_{}.json", self.feature))?)?;
        parse_contract(&value).ok_or(Stop::Unmodeled)
    }

    /// `targetBase(cwd, target)`.
    fn target_base(&self, target: &str) -> R<String> {
        let origin = self.git(&["remote"])?.split('\n').any(|r| r == "origin");
        if !origin && self.git(&["branch", "--show-current"])? == target {
            return message("parallel requires a feature branch distinct from its local target");
        }
        let reference = if origin {
            format!("refs/remotes/origin/{target}")
        } else {
            format!("refs/heads/{target}")
        };
        self.git(&["rev-parse", "--verify", &reference])
    }

    fn identity(&self, target: &str) -> Result<Identity, content_identity::Failure> {
        content_identity::working_for(
            Path::new(&self.root.cwd),
            self.ctx.env,
            Some(target),
            CONTENT_TIMEOUT,
            CONTENT_MAX_BYTES,
        )
    }

    fn changed(&self, since: &str) -> R<Vec<String>> {
        let joined = format!(
            "{}\0{}",
            self.git(&["diff", "--name-only", "-z", since])?,
            self.git(&["ls-files", "--others", "--exclude-standard", "-z"])?
        );
        Ok(joined
            .split('\0')
            .filter(|p| !p.is_empty() && !under_progress(p))
            .map(str::to_owned)
            .collect())
    }
}

/// `safePath(cwd, path)`: rejects traversal and every symlink component.
fn safe_path(cwd: &str, path: &str) -> R<String> {
    let parts: Vec<&str> = path.split('/').collect();
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['\\', '\r', '\n', ':', '\0'])
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
        || parts.contains(&".git")
    {
        return message(format!("unsafe parallel path: {path}"));
    }
    let mut current = cwd.to_owned();
    for part in parts {
        current = format!("{current}/{part}");
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return message(format!("parallel symlink: {path}"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Stop::Unmodeled),
        }
    }
    Ok(current)
}

/// `fileHash(cwd, path)`.
fn file_hash(cwd: &str, path: &str) -> R<String> {
    use std::os::unix::fs::PermissionsExt as _;
    let full = safe_path(cwd, path)?;
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("missing".to_owned()),
        Err(_) => return Err(Stop::Unmodeled),
    };
    if !meta.is_file() {
        return message(format!("parallel path is not a regular file: {path}"));
    }
    let bytes = std::fs::read(&full).map_err(|_| Stop::Unmodeled)?;
    let mode = meta.permissions().mode() & 0o111;
    Ok(sha256(format!("{mode}\0{}", sha256(&bytes)).as_bytes()))
}

fn hashes(cwd: &str, paths: &[String]) -> R<JsObject> {
    let mut out = JsObject::new();
    for p in paths {
        out.insert(p.as_str(), JsValue::string(&file_hash(cwd, p)?));
    }
    Ok(out)
}

fn same(a: &JsObject, b: &JsObject) -> R<bool> {
    Ok(stringify(&JsValue::Object(a.clone()))? == stringify(&JsValue::Object(b.clone()))?)
}

fn keys(o: &JsObject) -> Vec<String> {
    o.ordered()
        .iter()
        .filter_map(|(k, _)| k.to_rust())
        .collect()
}

/// Node's `path.extname`.
fn extname(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(0) | None => "",
        Some(i) => &base[i..],
    }
}

/// `/^(\s*-\s+)\[[ xX]\](\s+\*\*T\d+\*\*)/gm` → `$1[ ]$2`, `^` after any JS line terminator.
fn normalize_checkboxes(text: &str) -> R<String> {
    let ws = crate::js_re::ws();
    let re = Regex::new(&format!(r"^({ws}*-{ws}+)\[[ xX]\]({ws}+\*\*T[0-9]+\*\*)"))
        .map_err(|_| Stop::Unmodeled)?;
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut line_start = true;
    while at < text.len() {
        if line_start && let Some(c) = re.captures(&text[at..]) {
            let whole = c.get(0).map_or(0, |m| m.end());
            out.push_str(&c[1]);
            out.push_str("[ ]");
            out.push_str(&c[2]);
            line_start = matches!(
                c[2].chars().last(),
                Some('\n' | '\r' | '\u{2028}' | '\u{2029}')
            );
            at += whole;
            continue;
        }
        let ch = text[at..].chars().next().unwrap_or_default();
        out.push(ch);
        line_start = matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        at += ch.len_utf8();
    }
    Ok(out)
}

/// `bindingHash(path, text)`.
fn binding_hash(path: &str, text: &str) -> R<String> {
    let workplan = path.rsplit_once("/workplan_").is_some_and(|(_, rest)| {
        rest.ends_with(".json") && rest.len() > ".json".len() && !rest.contains('/')
    });
    if workplan {
        let mut value = crate::js_json::parse(text).ok_or(Stop::Unmodeled)?;
        if let JsValue::Object(o) = &mut value {
            o.remove("progress");
            o.remove("evidence");
        } else {
            // `const { progress, evidence, ...contract } = <non-object>`: not modeled.
            return Err(Stop::Unmodeled);
        }
        return Ok(sha256(stringify(&value)?.as_bytes()));
    }
    if path.ends_with("/tasks.md") {
        return Ok(sha256(normalize_checkboxes(text)?.as_bytes()));
    }
    Ok(sha256(text.as_bytes()))
}

/// `resolveDeliveryThresholds(config)`.
fn thresholds(config: &JsValue) -> R<Thresholds> {
    let deliveries = config_member(config, &["sdd", "deliveries"]);
    let field = |key: &str, fallback: f64| match deliveries.and_then(|d| config_member(d, &[key])) {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(fallback),
        Some(JsValue::Number(n)) => Ok(*n),
        Some(_) => Err(Stop::Unmodeled),
    };
    Ok(Thresholds {
        split_min_tasks: field("splitMinTasks", DEFAULT_THRESHOLDS.split_min_tasks)?,
        split_min_loc: field("splitMinLoc", DEFAULT_THRESHOLDS.split_min_loc)?,
        max_prs_per_spec: field("maxPrsPerSpec", DEFAULT_THRESHOLDS.max_prs_per_spec)?,
    })
}

fn config_member<'a>(config: &'a JsValue, path: &[&str]) -> Option<&'a JsValue> {
    let mut value = config;
    for key in path {
        let JsValue::Object(o) = value else {
            return None;
        };
        value = o.get(key)?;
    }
    Some(value)
}

/// `bindings(root, c)`.
#[allow(clippy::too_many_lines, reason = "one linear port of bindings()")]
fn bindings(f: &Facts<'_>, c: &ParallelRequest) -> R<JsObject> {
    let config = f.ctx.config;
    if !matches!(
        config_member(config, &["harness", "scribeOwnsMarkdown"]),
        Some(JsValue::Bool(true))
    ) {
        return message("parallel requires scribeOwnsMarkdown");
    }
    let plan_path = f.artifact(&format!("workplan_{}.json", f.feature))?;
    let raw = read_json(&plan_path)?;
    let plan = crate::plan::check::schema(&raw).ok_or(Stop::Unmodeled)?;
    if plan.level != 3 || plan.feature != f.feature {
        return message("parallel requires a valid level-3 workplan for this feature");
    }
    if plan.feature != format!("{}-{}", c.spec, c.delivery.to_lowercase()) {
        return message("parallel spec delivery feature mismatch");
    }
    let specs_dir = match config_member(config, &["sdd", "specsDir"]) {
        None | Some(JsValue::Undefined | JsValue::Null) => "specs".to_owned(),
        Some(v) => text(v).ok_or(Stop::Unmodeled)?,
    };
    let dir = match crate::spec::locate::locate_spec_dir(&f.root.cwd, &specs_dir, &c.spec)
        .ok_or(Stop::Unmodeled)?
    {
        Ok(dir) => dir,
        Err(why) => return message(why),
    };
    let spec_paths: Vec<String> = ["requirements.md", "design.md", "tasks.md"]
        .iter()
        .map(|p| relative(&f.root.cwd, &crate::posix::join(&[&dir, p])))
        .collect();
    let mut texts = Vec::new();
    for p in &spec_paths {
        texts.push(read_text(&safe_path(&f.root.cwd, p)?)?);
    }
    let tasks = crate::spec::tasks::parse(&texts[2]);
    let requirements = crate::spec::requirement_ids(&texts[0]);
    let deliveries: Vec<_> = tasks
        .deliveries
        .iter()
        .filter(|d| d.id == c.delivery)
        .collect();
    let checked = crate::spec::check::check(&tasks, thresholds(config)?, Some(&requirements))
        .map_err(|_| Stop::Unmodeled)?;
    if tasks.format != crate::spec::tasks::Format::Deliveries
        || requirements.is_empty()
        || !checked.ok
        || deliveries.len() != 1
        || deliveries[0]
            .milestones
            .iter()
            .filter(|m| m.id == c.milestone)
            .count()
            != 1
        || texts.iter().any(|t| js_trim(t).is_empty())
    {
        return message("parallel requires accepted spec/delivery/milestone membership");
    }
    let allowed: Vec<&str> = plan.files.iter().map(|(p, _)| p.as_str()).collect();
    let paths = c.owned();
    for path in &paths {
        safe_path(&f.root.cwd, path)?;
        if !allowed.contains(&path.as_str())
            || under_progress(path)
            || spec_paths.contains(path)
            || path == "navori.config.json"
        {
            return message(format!(
                "parallel path outside independent approved scope: {path}"
            ));
        }
    }
    let overlap = paths.iter().enumerate().any(|(i, a)| {
        paths
            .iter()
            .enumerate()
            .any(|(j, b)| i != j && (a == b || a.starts_with(&format!("{b}/"))))
    });
    if overlap {
        return message("parallel paths overlap");
    }
    let md = |p: &str| matches!(extname(p), ".md" | ".mdx");
    if c.prose().iter().any(|p| !md(p))
        || c.implementer_paths.iter().any(|p| md(p))
        || c.derived_paths
            .iter()
            .any(|p| !super::attest::is_derived_handoff_path(p))
    {
        return message("parallel role or derived paths invalid");
    }
    let mut out = JsObject::new();
    let mut bound = vec![
        relative(&f.root.cwd, &plan_path),
        "navori.config.json".to_owned(),
    ];
    bound.extend(spec_paths);
    for p in bound {
        let text = read_text(&safe_path(&f.root.cwd, &p)?)?;
        out.insert(p.as_str(), JsValue::string(&binding_hash(&p, &text)?));
    }
    Ok(out)
}

/// `validate(root, c, allowCommitted)`.
fn validate(f: &Facts<'_>, c: &Contract, allow_committed: bool) -> R<Identity> {
    let Ok(identity) = f.identity(&c.target) else {
        return message("parallel content identity unavailable");
    };
    if !allow_committed && !f.git(&["diff", "--cached", "--name-only"])?.is_empty() {
        return message("parallel production forbids staging");
    }
    let drift = c.feature != f.feature
        || c.cwd != f.root.cwd
        || c.branch != f.git(&["branch", "--show-current"])?
        || (!allow_committed && identity.head != c.head)
        || f.target_base(&c.target)? != c.base
        || !same(&bindings(f, &c.request)?, &c.bindings)?;
    if drift {
        return message("parallel authorization drift");
    }
    let changed = f.changed(&c.head)?;
    let mut allowed = c.request.owned();
    allowed.extend(keys(&c.readonly_before));
    allowed.extend(
        keys(&c.bindings)
            .into_iter()
            .filter(|p| p.ends_with("/tasks.md")),
    );
    if changed.iter().any(|p| !allowed.contains(p)) {
        return message("parallel diff escapes approved scope");
    }
    if !same(
        &hashes(&f.root.cwd, &keys(&c.readonly_before))?,
        &c.readonly_before,
    )? {
        return message("parallel readonly baseline changed");
    }
    for p in c.request.owned() {
        safe_path(&f.root.cwd, &p)?;
    }
    Ok(identity)
}

/// `production(root, c)`.
fn production(f: &Facts<'_>, c: &Contract) -> R<()> {
    validate(f, c, false)?;
    if !same(
        &hashes(&f.root.cwd, &c.request.derived_paths)?,
        &c.derived_before,
    )? {
        return message("render must wait for both producers");
    }
    Ok(())
}

fn facts<'a>(ctx: &'a Context<'a>) -> R<Facts<'a>> {
    let root = resolve_state_root(
        &ctx.root.cwd,
        &ctx.root.cwd,
        ctx.feature,
        Some(&ctx.root.dir),
    )
    .map_err(refusal)?;
    Ok(Facts {
        root,
        feature: ctx.feature,
        ctx,
    })
}

fn real(path: &str) -> R<String> {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(str::to_owned))
        .ok_or(Stop::Unmodeled)
}

fn claim_name(c: &Contract, role: &str) -> String {
    format!("parallel_{}_{}_{role}_start.json", c.feature, c.run_id)
}

fn done_name(c: &Contract, role: &str) -> String {
    format!("parallel_{}_{}_{role}.json", c.feature, c.run_id)
}

/// `claim(root, c, role)`.
fn claim(f: &Facts<'_>, c: &Contract, role: &str) -> R<Claim> {
    let value = read_json(&f.artifact(&claim_name(c, role))?)?;
    let record = parse_claim(&value).ok_or(Stop::Unmodeled)?;
    if record.run_id != c.run_id
        || record.authorization_digest != c.digest()?
        || record.actor.role != role
        || record.started_at < c.prepared_at
    {
        return message("parallel claim is stale or belongs to another role/run");
    }
    Ok(record)
}

/// `completions(root, c, succeeding)`.
fn completions(f: &Facts<'_>, c: &Contract, succeeding: bool) -> R<Vec<Completion>> {
    let mut records = Vec::new();
    for role in ["implementer", "scribe"] {
        let value = read_json(&f.artifact(&done_name(c, role))?)?;
        let record = parse_completion(&value).ok_or(Stop::Unmodeled)?;
        let start = claim(f, c, role)?;
        let paths = if role == "implementer" {
            c.request.implementer_paths.clone()
        } else {
            c.request.prose()
        };
        let expected = hashes(&f.root.cwd, &paths)?;
        if record.claim.run_id != c.run_id
            || record.claim.authorization_digest != c.digest()?
            || record.role != role
            || record.claim.actor.role != role
            || (!succeeding && (record.status != "DONE" || record.blockers > 0))
            || record.claim.started_at != start.started_at
            || record.completed_at < start.started_at
            || record.claim.actor_json != start.actor_json
            || (!succeeding && !same(&record.files, &expected)?)
        {
            return message(format!(
                "parallel {role} completion invalid or changed after DONE"
            ));
        }
        records.push(record);
    }
    if records[0].claim.actor.root != records[1].claim.actor.root
        || records[0].claim.actor.thread == records[1].claim.actor.thread
    {
        return message("parallel requires two distinct native producers in the same session");
    }
    Ok(records)
}

fn done(status: &'static str, run_id: &str, writes: Vec<Write>) -> R<Planned> {
    Ok(Planned::Done {
        status,
        run_id: run_id.to_owned(),
        writes,
    })
}

// ---------------------------------------------------------------------------------------------
// entrypoints

/// `prepareParallel({ ...options, request, supersede })`. `checkWorkplan` is the caller's: it
/// passes whether the workplan checks (`None` when Rust cannot judge it).
#[must_use]
pub fn prepare(
    ctx: &Context<'_>,
    request: &JsValue,
    supersede: Option<&str>,
    workplan_ok: Option<bool>,
) -> Option<Planned> {
    plan((|| {
        let f = facts(ctx)?;
        match workplan_ok {
            Some(true) => {}
            Some(false) => return message("parallel requires a valid workplan"),
            None => return Err(Stop::Unmodeled),
        }
        if has_lone_surrogate(request) {
            return Err(Stop::Unmodeled);
        }
        let request = strict(request, &REQUEST_KEYS, &[])
            .and_then(parse_request)
            .ok_or(Stop::Unmodeled)?;
        let previous =
            if super::ownership::has_parallel_authority(&f.root.cwd, f.feature, Some(&f.root.dir))?
            {
                Some(f.contract()?)
            } else {
                None
            };
        if let Some(previous) = &previous {
            if supersede != Some(previous.run_id.as_str()) || previous.target != ctx.target {
                return message("explicit --supersede of the active parallel run is required");
            }
            let mut inherited = previous.readonly_before.clone();
            for r in completions(&f, previous, true)? {
                for (k, v) in r.files.ordered() {
                    inherited.insert(k.clone(), v.clone());
                }
            }
            let owned = request.owned();
            let mut changed = false;
            for (p, hash) in inherited.ordered() {
                let p = p.to_rust().ok_or(Stop::Unmodeled)?;
                let hash = text(hash).ok_or(Stop::Unmodeled)?;
                if !owned.contains(&p) && file_hash(&f.root.cwd, &p)? != hash {
                    changed = true;
                    break;
                }
            }
            if changed
                || previous
                    .request
                    .derived_paths
                    .iter()
                    .any(|p| !request.derived_paths.contains(p))
            {
                return message("successor must preserve readonly bytes and retain derived scope");
            }
        } else if supersede.is_some() {
            return message("no parallel run to supersede");
        }
        let Ok(identity) = f.identity(ctx.target) else {
            return message("parallel requires available HEAD and target/base");
        };
        let base = f.target_base(ctx.target)?;
        let branch = f.git(&["branch", "--show-current"])?;
        let mut c = Contract {
            bindings: bindings(&f, &request)?,
            derived_before: hashes(&f.root.cwd, &request.derived_paths)?,
            request,
            run_id: ctx.uuid.to_owned(),
            feature: ctx.feature.to_owned(),
            cwd: f.root.cwd.clone(),
            branch,
            target: ctx.target.to_owned(),
            head: identity.head.clone(),
            base,
            prepared_at: ctx.now.to_owned(),
            readonly_before: JsObject::new(),
            previous_run_id: previous.as_ref().map(|p| p.run_id.clone()),
        };
        if c.branch.is_empty() {
            return message("parallel requires a named branch");
        }
        let dirty = f.changed("HEAD")?;
        let mut inherited: Vec<String> = Vec::new();
        if let Some(previous) = &previous {
            inherited.extend(previous.request.owned());
            inherited.extend(keys(&previous.readonly_before));
        }
        let bound = keys(&c.bindings);
        let bookkeeping = |p: &str| p.ends_with("/tasks.md") && bound.iter().any(|b| b == p);
        if dirty
            .iter()
            .any(|p| !inherited.contains(p) && !bookkeeping(p))
            || identity.index_diverges
        {
            return message("parallel preparation requires a clean delivery snapshot");
        }
        let owned = c.request.owned();
        let readonly: Vec<String> = dirty
            .into_iter()
            .filter(|p| !owned.contains(p) && !bookkeeping(p))
            .collect();
        c.readonly_before = hashes(&f.root.cwd, &readonly)?;
        // `head`, `base` and `branch` are git's facts: a contract the schema would refuse is the TS's.
        if !hex_of(&c.head, 40) || !hex_of(&c.base, 40) || js_trim(&c.branch) != c.branch {
            return Err(Stop::Unmodeled);
        }
        validate(&f, &c, false)?;
        let written = format!("{}\n", c.written_json()?);
        let mut writes = vec![Write::Exclusive {
            name: format!("parallel_{}_{}_authorization.json", c.feature, c.run_id),
            content: written.clone(),
        }];
        let name = format!("parallel_{}.json", ctx.feature);
        match &previous {
            Some(previous) => {
                let mut successor = JsObject::new();
                successor.insert("runId", JsValue::string(&c.run_id));
                writes.push(Write::Exclusive {
                    name: format!("parallel_{}_{}_successor.json", c.feature, previous.run_id),
                    content: format!("{}\n", stringify(&JsValue::Object(successor))?),
                });
                writes.push(Write::Atomic {
                    name,
                    content: written,
                });
            }
            None => writes.push(Write::Exclusive {
                name,
                content: written,
            }),
        }
        done("prepared", &c.run_id, writes)
    })())
}

/// `checkParallel(options)`.
#[must_use]
pub fn check(ctx: &Context<'_>) -> Option<Planned> {
    plan((|| {
        let f = facts(ctx)?;
        let c = f.contract()?;
        if c.target != ctx.target {
            return message("parallel target mismatch");
        }
        production(&f, &c)?;
        done("ok", &c.run_id, Vec::new())
    })())
}

fn native(f: &Facts<'_>, what: &str) -> R<NativeActor> {
    let actor = native_actor(Path::new(&f.root.cwd), f.ctx.env, f.ctx.runner)?;
    match actor {
        Some(actor) if real(f.ctx.process_cwd)? == f.root.cwd && actor.role != "reviewer" => {
            Ok(actor)
        }
        _ => message(format!(
            "parallel {what} requires the native producer in the target checkout"
        )),
    }
}

/// `beginParallel({ ...options, runId })`.
#[must_use]
pub fn begin(ctx: &Context<'_>, run_id: &str) -> Option<Planned> {
    plan((|| {
        let f = facts(ctx)?;
        let c = f.contract()?;
        let actor = native(&f, "begin")?;
        if run_id != c.run_id || ctx.target != c.target {
            return message("parallel run or target mismatch");
        }
        production(&f, &c)?;
        let mut record = JsObject::new();
        record.insert("runId", JsValue::string(&c.run_id));
        record.insert("authorizationDigest", JsValue::string(&c.digest()?));
        record.insert("actor", actor_value(&actor));
        record.insert("startedAt", JsValue::string(ctx.now));
        let writes = vec![Write::Exclusive {
            name: claim_name(&c, &actor.role),
            content: format!("{}\n", stringify(&JsValue::Object(record))?),
        }];
        done("ok", &c.run_id, writes)
    })())
}

/// `completeParallel({ ...options, runId, status, reason })`.
#[must_use]
pub fn complete(
    ctx: &Context<'_>,
    run_id: &str,
    status: &str,
    reason: Option<&str>,
) -> Option<Planned> {
    plan((|| {
        let f = facts(ctx)?;
        let c = f.contract()?;
        let actor = native(&f, "completion")?;
        if run_id != c.run_id || ctx.target != c.target {
            return message("parallel run or target mismatch");
        }
        production(&f, &c)?;
        // `z.enum(...).parse` and `nonempty.parse` throw zod's message.
        if status != "DONE" && status != "BLOCKED" {
            return Err(Stop::Unmodeled);
        }
        let start = claim(&f, &c, &actor.role)?;
        if start.actor_json != actor_json(&actor)? {
            return message("parallel completion belongs to another native claim");
        }
        let blockers: Vec<JsValue> = if status == "BLOCKED" {
            let reason = reason
                .map(js_trim)
                .filter(|r| !r.is_empty())
                .ok_or(Stop::Unmodeled)?;
            vec![JsValue::string(reason)]
        } else {
            Vec::new()
        };
        let paths = if actor.role == "implementer" {
            c.request.implementer_paths.clone()
        } else {
            c.request.prose()
        };
        let mut record = JsObject::new();
        record.insert("runId", JsValue::string(&c.run_id));
        record.insert("authorizationDigest", JsValue::string(&c.digest()?));
        record.insert("role", JsValue::string(&actor.role));
        record.insert("actor", actor_value(&actor));
        record.insert("status", JsValue::string(status));
        record.insert("startedAt", JsValue::string(&start.started_at));
        record.insert("completedAt", JsValue::string(ctx.now));
        record.insert("blockers", JsValue::Array(blockers));
        record.insert("files", JsValue::Object(hashes(&f.root.cwd, &paths)?));
        let writes = vec![Write::Exclusive {
            name: done_name(&c, &actor.role),
            content: format!("{}\n", stringify(&JsValue::Object(record))?),
        }];
        done("completed", &c.run_id, writes)
    })())
}

/// `finalizeParallel(options)`.
#[must_use]
pub fn finalize(ctx: &Context<'_>) -> Option<Planned> {
    plan((|| {
        let f = facts(ctx)?;
        let c = f.contract()?;
        if ctx.target != c.target || real(ctx.process_cwd)? != f.root.cwd {
            return message("parallel finalization target mismatch");
        }
        let identity = validate(&f, &c, false)?;
        let records = completions(&f, &c, false)?;
        let raw = match std::fs::read(f.artifact(&format!("impl_{}.json", c.feature))?) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let path = f.artifact(&format!("impl_{}.json", c.feature))?;
                return message(format!("ENOENT: no such file or directory, open '{path}'"));
            }
            Err(_) => return Err(Stop::Unmodeled),
        };
        let value = crate::js_json::parse(std::str::from_utf8(&raw).map_err(|_| Stop::Unmodeled)?)
            .ok_or(Stop::Unmodeled)?;
        if has_lone_surrogate(&value) {
            return Err(Stop::Unmodeled);
        }
        let handoff = implementation::parse(&value).ok_or(Stop::Unmodeled)?;
        let actor = native_actor(Path::new(&f.root.cwd), ctx.env, ctx.runner)?;
        let actor_text = actor.as_ref().map(actor_json).transpose()?;
        let owned = c.request.owned();
        let requests: Vec<(String, String, String)> = handoff
            .markdown_requests
            .iter()
            .map(|r| (r.path.clone(), r.intent.clone(), r.evidence.clone()))
            .collect();
        let designated = actor_text.as_ref().is_some_and(|a| {
            records
                .iter()
                .any(|r| r.claim.actor_json == *a && r.role == "implementer")
        });
        if !designated
            || handoff.feature != c.feature
            || handoff.status != "DONE"
            || !handoff.blockers.is_empty()
            || handoff.verification.exit_code != 0.0
            || handoff.head.as_deref() != Some(c.head.as_str())
            || handoff.branch != c.branch
            || real(&handoff.worktree)? != c.cwd
            || requests != c.request.markdown_requests
            || handoff.files_touched.iter().any(|p| !owned.contains(p))
        {
            return message(
                "parallel requires the real final implementer handoff and designated native implementer",
            );
        }
        let mut record = JsObject::new();
        record.insert("feature", JsValue::string(&c.feature));
        record.insert("cwd", JsValue::string(&c.cwd));
        record.insert("target", JsValue::string(&c.target));
        record.insert("head", JsValue::string(&c.head));
        record.insert(
            "base",
            identity
                .base
                .as_deref()
                .map_or(JsValue::Null, JsValue::string),
        );
        record.insert("fingerprint", JsValue::string(&identity.fingerprint));
        record.insert("handoff", JsValue::string(&sha256(&raw)));
        record.insert(
            "actors",
            JsValue::Array(
                records
                    .iter()
                    .map(|r| actor_value(&r.claim.actor))
                    .collect(),
            ),
        );
        record.insert("files", JsValue::Object(hashes(&f.root.cwd, &owned)?));
        let ownership = stringify(&JsValue::Object(record))?;
        let mut last = JsObject::new();
        last.insert("authorizationDigest", JsValue::string(&c.digest()?));
        last.insert(
            "ownershipDigest",
            JsValue::string(&sha256(ownership.as_bytes())),
        );
        last.insert("finalizedAt", JsValue::string(ctx.now));
        let writes = vec![
            Write::Atomic {
                name: format!("ownership_{}.json", c.feature),
                content: format!("{ownership}\n"),
            },
            Write::Exclusive {
                name: format!("parallel_{}_{}_final.json", c.feature, c.run_id),
                content: format!("{}\n", stringify(&JsValue::Object(last))?),
            },
        ];
        done("finalized", &c.run_id, writes)
    })())
}

/// Runs the planned writes over `fs`, in order; the first failure is the TS's message.
///
/// # Errors
/// Node's message for the write that failed (an existing exclusive destination is `EEXIST`).
pub fn apply(fs: &mut dyn crate::fs::Fs, root: &StateRoot, writes: &[Write]) -> Result<(), String> {
    for write in writes {
        match write {
            Write::Exclusive { name, content } => {
                let refused = |r: Refusal| match r {
                    Refusal::Message(m) => m,
                    Refusal::Unmodeled => format!("state artifact unavailable: {name}"),
                };
                for dir in crate::state_files::plan_state_dirs(root).map_err(refused)? {
                    fs.mkdir_all(Path::new(&dir)).map_err(|e| {
                        crate::fs::node_message(
                            &e,
                            crate::fs::Syscall::Mkdir,
                            Path::new(&dir),
                            None,
                        )
                    })?;
                }
                let path = artifact_path(root, name).map_err(refused)?;
                if std::fs::symlink_metadata(&path).is_ok() {
                    return Err(format!("EEXIST: file already exists, open '{path}'"));
                }
                let open = |e: std::io::Error| {
                    crate::fs::node_message(&e, crate::fs::Syscall::Open, Path::new(&path), None)
                };
                let file = fs.create(Path::new(&path), 0o666).map_err(open)?;
                fs.write(file, content.as_bytes()).map_err(|e| {
                    crate::fs::node_message(&e, crate::fs::Syscall::Write, Path::new(&path), None)
                })?;
                fs.close(file).map_err(|e| {
                    crate::fs::node_message(&e, crate::fs::Syscall::Close, Path::new(&path), None)
                })?;
            }
            Write::Atomic { name, content } => {
                let planned = crate::state_files::plan_state_write(root, name, std::process::id())
                    .map_err(|_| format!("state artifact unavailable: {name}"))??;
                crate::state_files::write_state_file(fs, &planned, content)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zod_formats_follow_the_ts() {
        assert!(zod_uuid("01234567-89ab-4def-8123-456789abcdef"));
        assert!(!zod_uuid("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(zod_uuid("ffffffff-ffff-ffff-ffff-ffffffffffff"));
        assert!(zod_datetime("2024-02-29T00:00:00.5Z"));
        assert!(!zod_datetime("2026-02-29T00:00:00Z"));
        assert!(!zod_datetime("2026-11-01T00:00Z"));
    }

    #[test]
    fn extname_is_nodes() {
        assert_eq!(extname("docs/a.md"), ".md");
        assert_eq!(extname("docs/.md"), "");
        assert_eq!(extname("a."), ".");
        assert_eq!(extname("a"), "");
    }

    #[test]
    fn checkboxes_reset_at_every_line_start() -> Result<(), String> {
        let text = "- [x] **T1** a\n  - [X] **T22** b\n- [x] T3\n\u{2028}- [x] **T4**";
        let got = normalize_checkboxes(text).map_err(|_| "regex".to_owned())?;
        assert_eq!(
            got,
            "- [ ] **T1** a\n  - [ ] **T22** b\n- [x] T3\n\u{2028}- [ ] **T4**"
        );
        Ok(())
    }
}
