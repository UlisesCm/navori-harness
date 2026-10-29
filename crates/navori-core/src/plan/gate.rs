//! Port of `lib/plan/gate.ts` (`evaluatePlanGate`) for `navori plan gate` (spec 0059 D33, R56,
//! R57): the decision on an `Agent`/`spawn_agent` payload, the Codex dispatch marker selection
//! and its atomic claim.
//!
//! Every branch whose output Rust would not reproduce byte for byte — a JS error message, a zod
//! issue, a rejection history, an escalation, a possible audit target — stops with
//! [`Outcome::Delegate`] **before any write**, and the command hands the same stdin to the TS.
//! The only write is the claim of the dispatch marker, after the decision is final.

use std::fs;
use std::io::{ErrorKind, Read as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use regex::Regex;

use crate::config::{self, Config};
use crate::js_json::{self, JsValue};
use crate::js_re::{DOT, non_ws, ws};
use crate::plan::check::{Checked, ProjectContext, check_workplan};
use crate::plan::classify::{ClassifyInput, classify, matches_critical_paths, normalize_repo_path};
use crate::plan::expected::{Expected, parse_expected};
use crate::plan::roster::NON_IMPLEMENTER_ROLES;
use crate::posix::js_trim;
use crate::process::Env;
use crate::spec::locate::locate_spec_dir;
use crate::spec::tasks::parse_tasks;
use crate::state_root::{checkout_root, contained_dir, has_symlink_ancestor};

/// How long a dispatch marker stays valid after `createdAt`.
pub const DISPATCH_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;
const DISPATCH_FUTURE_SKEW_MS: f64 = 60.0 * 1000.0;
const DISPATCH_DIR: &str = ".navori/state/handoffs";
const NEUTRAL_DIR: &str = ".navori/state/handoffs";
const LEGACY_DIRS: [&str; 2] = [".claude/progress", ".codex/progress"];
const MAX_BYTES: u64 = 4 * 1024 * 1024;

const NO_OPENING_LINE_REASON: &str = "the encargo does not open with `workplan: <feature>`, `nivel-0: <path> <feature>` or `spec: <spec> E<n> M<n>` — load skill `plan-simple` (level 1) or `plan-advanced` (level 2) and produce a workplan, or confirm a level-0 exemption with `navori plan classify <feature>`.";
const NIVEL0_FORM: &str = "`nivel-0: <path>[,<path>] <feature> | verify: `<cmd>` → <expected>`";

/// The gate's decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Allow,
    Deny(String),
    /// Rust cannot reproduce this branch exactly; nothing was written.
    Delegate(&'static str),
}

/// What [`evaluate`] returns: the outcome and the stderr lines `readConfig` printed before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub outcome: Outcome,
    pub warnings: Vec<String>,
}

/// The process facts the TS reads from `process`.
pub struct Context<'a> {
    pub process_cwd: &'a Path,
    pub env: &'a Env,
    /// `Date.now()`.
    pub now_ms: f64,
    /// `process.pid`, for the claim name.
    pub pid: u32,
}

/// A non-allow stop inside the evaluation.
enum Stop {
    Deny(String),
    Delegate(&'static str),
}

type R<T> = Result<T, Stop>;

fn deny<T>(reason: impl Into<String>) -> R<T> {
    Err(Stop::Deny(reason.into()))
}

const fn delegate<T>(why: &'static str) -> R<T> {
    Err(Stop::Delegate(why))
}

struct Patterns {
    whitespace_run: Regex,
    workplan: Regex,
    nivel0: Regex,
    spec: Regex,
    encrypted: Regex,
    spawn_id: Regex,
    feature_slug: Regex,
    dispatch_file: Regex,
    verify_tail: Regex,
    verify_head: Regex,
    final_verdict: Regex,
    receipt: Regex,
    created_at: Regex,
}

static PATTERNS: LazyLock<Option<Patterns>> = LazyLock::new(|| {
    let s = ws();
    let ns = non_ws();
    Some(Patterns {
        whitespace_run: Regex::new(&format!("{s}+")).ok()?,
        workplan: Regex::new(&format!("^workplan:{s}*({ns}+)")).ok()?,
        nivel0: Regex::new(&format!("^nivel-0:{s}*({ns}+)(?:{s}+({DOT}*))?$")).ok()?,
        spec: Regex::new(&format!(
            "^spec:{s}*([a-z0-9][a-z0-9._-]*){s}+E([1-9][0-9]*){s}+M([1-9][0-9]*)$"
        ))
        .ok()?,
        encrypted: Regex::new("^gAAAAA[A-Za-z0-9_=-]*$").ok()?,
        spawn_id: Regex::new("^[A-Za-z0-9_-]{1,256}$").ok()?,
        feature_slug: Regex::new("^[a-z0-9][a-z0-9._-]*$").ok()?,
        dispatch_file: Regex::new(r"^dispatch_([a-z0-9][a-z0-9._-]*)\.json$").ok()?,
        verify_head: Regex::new(&format!("^verify:{s}+")).ok()?,
        verify_tail: Regex::new(&format!("^{s}+(?:→|->){s}+({ns}{DOT}*)$")).ok()?,
        final_verdict: Regex::new(&format!(r"\*\*Final verdict:\*\*{s}*([A-Z_]+)")).ok()?,
        receipt: Regex::new(&format!(r"^# navori-receipt v[0-9]+ feature=({ns}+)")).ok()?,
        created_at: Regex::new(
            r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:(Z)|([+-])([0-9]{2}):([0-9]{2}))$",
        )
        .ok()?,
    })
});

// ---------------------------------------------------------------------------------------------
// Payload

struct Payload {
    session_id: Option<String>,
    role: Option<String>,
    prompt: Option<String>,
    codex: bool,
}

fn member<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(o) => o.get(key),
        _ => None,
    }
}

/// A string member; a lone surrogate makes the branch unportable.
fn string_member(value: &JsValue, key: &str) -> R<Option<String>> {
    match member(value, key) {
        Some(JsValue::String(s)) => match s.to_rust() {
            Some(text) => Ok(Some(text)),
            None => delegate("payload string with a lone surrogate"),
        },
        _ => Ok(None),
    }
}

fn is_record(value: &JsValue) -> bool {
    matches!(value, JsValue::Object(_) | JsValue::Array(_))
}

/// `parsePayload`: the payload, or the problem that makes it unreadable.
fn parse_payload(raw: &JsValue, force_codex: bool) -> R<Result<Payload, &'static str>> {
    if !is_record(raw) {
        return Ok(Err("payload is not a JSON object"));
    }
    let Some(tool_input) = member(raw, "tool_input").filter(|t| is_record(t)) else {
        return Ok(Err("payload has no tool_input object"));
    };
    let agent_type = string_member(tool_input, "agent_type")?;
    let codex = force_codex || agent_type.is_some();
    let role = match agent_type {
        Some(role) => Some(role),
        None => string_member(tool_input, "subagent_type")?,
    };
    let prompt = match string_member(tool_input, "message")? {
        Some(message) => Some(message),
        None => string_member(tool_input, "prompt")?,
    };
    Ok(Ok(Payload {
        session_id: string_member(raw, "session_id")?,
        role,
        prompt,
        codex,
    }))
}

/// `normalizeRole`: no JS whitespace, lowercase, no `<plugin>:` prefix.
fn normalize_role(role: &str, p: &Patterns) -> String {
    let lower = p.whitespace_run.replace_all(role, "").to_lowercase();
    match lower.split_once(':') {
        Some((_, rest)) => rest.to_owned(),
        None => lower,
    }
}

fn is_implementer_spawn(role: Option<&str>, codex: bool, p: &Patterns) -> bool {
    let normalized = normalize_role(role.unwrap_or(""), p);
    if codex {
        !NON_IMPLEMENTER_ROLES.contains(&normalized.as_str())
    } else {
        normalized == "implementer"
    }
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers with the TS's failure split: a JS throw becomes a delegation.

/// `readPlanSnapshot`: `None` on `ENOENT`, delegation on anything the TS would throw.
fn read_snapshot(path: &Path) -> R<Option<String>> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return delegate("unreadable plan state"),
    };
    let Ok(meta) = file.metadata() else {
        return delegate("unreadable plan state");
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return delegate("unsafe or oversized plan state");
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() || bytes.len() as u64 > meta.len() {
        return delegate("plan state changed during read");
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Some(text)),
        Err(_) => delegate("plan state is not UTF-8"),
    }
}

/// `existsSync`: follows symlinks and swallows every error.
fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// A resolved state root (`resolveStateRoot`).
struct StateRoot {
    cwd: PathBuf,
    path: PathBuf,
}

impl StateRoot {
    /// `stateArtifactPath` for a name the gate builds from a valid slug.
    fn artifact(&self, name: &str) -> R<PathBuf> {
        let path = self.path.join(name);
        match has_symlink_ancestor(&self.cwd, &path) {
            Ok(false) => Ok(path),
            _ => delegate("state artifact escapes checkout"),
        }
    }
}

fn checkout(cwd: &str, ctx: &Context<'_>) -> R<PathBuf> {
    checkout_root(Path::new(cwd), ctx.process_cwd, ctx.env)
        .or_else(|_| delegate("checkout refused"))
}

fn contained(cwd: &Path, dir: &str) -> R<PathBuf> {
    contained_dir(cwd, dir).or_else(|_| delegate("state directory refused"))
}

/// `resolveStateRoot` for a slug already validated by the caller's regex.
fn resolve_state_root(
    cwd: &str,
    feature: &str,
    dir: Option<&str>,
    ctx: &Context<'_>,
    p: &Patterns,
) -> R<StateRoot> {
    if !p.feature_slug.is_match(feature) {
        let quoted = JsValue::string(feature).stringify(None).unwrap_or_default();
        return deny(format!("invalid feature slug: {quoted}"));
    }
    let cwd = checkout(cwd, ctx)?;
    if let Some(dir) = dir {
        let path = contained(&cwd, dir)?;
        return Ok(StateRoot { cwd, path });
    }
    let neutral = StateRoot {
        path: contained(&cwd, NEUTRAL_DIR)?,
        cwd: cwd.clone(),
    };
    if root_matches(&neutral, feature, p)? {
        return Ok(neutral);
    }
    let mut legacy = Vec::new();
    for dir in LEGACY_DIRS {
        let root = StateRoot {
            path: contained(&cwd, dir)?,
            cwd: cwd.clone(),
        };
        if root_matches(&root, feature, p)? {
            legacy.push(root);
        }
    }
    match legacy.len() {
        0 => Ok(neutral),
        1 => Ok(legacy.remove(0)),
        _ => delegate("several legacy state roots"),
    }
}

fn root_matches(root: &StateRoot, feature: &str, p: &Patterns) -> R<bool> {
    let link = fs::symlink_metadata(&root.path).is_ok_and(|m| m.file_type().is_symlink());
    if !exists(&root.path) || link {
        return Ok(false);
    }
    for name in [
        format!("workplan_{feature}.json"),
        format!("workplan_{feature}.md"),
        format!("impl_{feature}.json"),
        format!("impl_{feature}.md"),
        format!("review_{feature}.md"),
        format!("workplan_{feature}.gate.jsonl"),
    ] {
        if exists(&root.artifact(&name)?) {
            return Ok(true);
        }
    }
    for name in ["receipt.txt", "receipt.consumed.txt"] {
        let path = root.artifact(name)?;
        if !exists(&path) {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            return delegate("unreadable receipt");
        };
        let text = String::from_utf8_lossy(&bytes);
        let owner = p.receipt.captures(&text).and_then(|c| c.get(1));
        if owner.is_some_and(|o| o.as_str() == feature) {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------------------------------------
// Dispatch markers (Codex V2)

/// A marker `DispatchSchema` accepts: feature, opening, `createdAt` in ms, optional session.
type Dispatch = (String, String, f64, Option<String>);

struct DispatchHit {
    opening: String,
    file: PathBuf,
    feature: String,
    raw: String,
}

/// `DispatchSchema.safeParse`: `Some(Ok)` valid, `Some(Err)` invalid, `None` not judged.
fn dispatch_schema(json: &JsValue, p: &Patterns) -> Option<Result<Dispatch, ()>> {
    let JsValue::Object(o) = json else {
        return Some(Err(()));
    };
    let field = |key: &str| -> Option<Result<Option<String>, ()>> {
        match o.get(key) {
            None | Some(JsValue::Undefined) => Some(Ok(None)),
            Some(JsValue::String(s)) => s.to_rust().map(|t| Ok(Some(t))),
            Some(_) => Some(Err(())),
        }
    };
    let feature = match field("feature")? {
        Ok(Some(f)) if p.feature_slug.is_match(&f) => f,
        _ => return Some(Err(())),
    };
    let opening = match field("opening")? {
        Ok(Some(o)) if !o.is_empty() => o,
        _ => return Some(Err(())),
    };
    let created = match field("createdAt")? {
        Ok(Some(c)) => c,
        _ => return Some(Err(())),
    };
    let session = match field("sessionId")? {
        Ok(None) => None,
        Ok(Some(s)) if p.spawn_id.is_match(&s) => Some(s),
        _ => return Some(Err(())),
    };
    // Only the ISO shape both zod and `Date.parse` agree on is judged; anything else goes to TS.
    let ms = iso_ms(&created, p)?;
    Some(Ok((feature, opening, ms, session)))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.parse` of a complete ISO date-time with seconds and an offset; `None` outside it.
fn iso_ms(text: &str, p: &Patterns) -> Option<f64> {
    let c = p.created_at.captures(text)?;
    let n = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<i64>().ok());
    let (year, month, day) = (n(1)?, n(2)?, n(3)?);
    let (hour, minute, second) = (n(4)?, n(5)?, n(6)?);
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let millis = c.get(7).map_or(Some(0), |f| {
        let digits: String = f.as_str().chars().chain("000".chars()).take(3).collect();
        digits.parse::<i64>().ok()
    })?;
    let offset = if c.get(8).is_some() {
        0
    } else {
        let (oh, om) = (n(10)?, n(11)?);
        if oh > 23 || om > 59 {
            return None;
        }
        let sign = if c.get(9).is_some_and(|s| s.as_str() == "-") {
            -1
        } else {
            1
        };
        sign * (oh * 60 + om)
    };
    let minutes = days_from_civil(year, month, day) * 1440 + hour * 60 + minute - offset;
    Some(((minutes * 60 + second) * 1000 + millis) as f64)
}

fn dispatch_fix(session: Option<&str>) -> String {
    let mut fix = "the orchestrator must write `.navori/state/handoffs/dispatch_<feature>.json` ({\"feature\",\"opening\":\"workplan: <feature>\",\"createdAt\":<ISO now>,\"sessionId\":<this session's id>}) right before spawning the implementer, and keep exactly one fresh dispatch per session (TTL 10 min)".to_owned();
    if let Some(id) = session {
        fix.push_str(&format!(
            "; this session's id is `{id}`: write it as `sessionId` in dispatch_<feature>.json"
        ));
    }
    fix
}

fn fresh(age: f64) -> bool {
    age <= DISPATCH_TTL_MS && -age <= DISPATCH_FUTURE_SKEW_MS
}

/// `readDispatch`: the single fresh marker for this spawn, or the deny reason.
fn read_dispatch(
    cwd: &str,
    session: Option<&str>,
    ctx: &Context<'_>,
    p: &Patterns,
) -> R<DispatchHit> {
    let fix = dispatch_fix(session);
    let root = resolve_state_root(cwd, "dispatch", Some(DISPATCH_DIR), ctx, p)?;
    let mut names: Vec<String> = Vec::new();
    if exists(&root.path) {
        let Ok(entries) = fs::read_dir(&root.path) else {
            return delegate("unreadable dispatch directory");
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return delegate("unreadable dispatch directory");
            };
            let Ok(name) = entry.file_name().into_string() else {
                return delegate("non-UTF-8 dispatch name");
            };
            if p.dispatch_file.is_match(&name) {
                names.push(name);
            }
        }
    }
    // libuv's scandir sorts by byte order, so `readdirSync` does too.
    names.sort();
    let mut fresh_hits = Vec::new();
    let mut own = Vec::new();
    let mut unscoped = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut other_fresh = 0usize;
    let mut stale = 0usize;
    for name in names {
        let file = root.artifact(&name)?;
        let content = read_snapshot(&file)?;
        let json = match &content {
            None => JsValue::Undefined,
            Some(text) => match js_json::parse(text) {
                Some(value) => value,
                None => return delegate("dispatch JSON outside the ported model"),
            },
        };
        if let (Some(session), JsValue::Object(o)) = (session, &json) {
            let stamp = match o.get("sessionId") {
                Some(JsValue::String(s)) => s.to_rust(),
                _ => None,
            };
            if stamp.is_some_and(|s| p.spawn_id.is_match(&s) && s != session) {
                skipped.push(name);
                match dispatch_schema(&json, p) {
                    None => return delegate("dispatch outside the ported schema"),
                    Some(Ok((_, _, created, _))) => {
                        if fresh(ctx.now_ms - created) {
                            other_fresh += 1;
                        }
                    }
                    Some(Err(())) => {}
                }
                continue;
            }
        }
        let parsed = match dispatch_schema(&json, p) {
            None => return delegate("dispatch outside the ported schema"),
            Some(Err(())) => {
                return deny(format!("{} is malformed — {fix}.", file.display()));
            }
            Some(Ok(parsed)) => parsed,
        };
        let (feature, opening, created, stamp) = parsed;
        let named = p
            .dispatch_file
            .captures(&name)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_owned());
        if named.as_deref() != Some(feature.as_str()) {
            return deny(format!(
                "{}: \"feature\" does not match the file name — {fix}.",
                file.display()
            ));
        }
        if !fresh(ctx.now_ms - created) {
            stale += 1;
            continue;
        }
        let Some(raw) = content else {
            return delegate("dispatch vanished");
        };
        let hit = DispatchHit {
            opening,
            file,
            feature,
            raw,
        };
        if session.is_some() {
            if stamp.is_none() {
                unscoped.push(fresh_hits.len());
            } else {
                own.push(fresh_hits.len());
            }
        }
        fresh_hits.push(hit);
    }
    let ambiguous = |n: usize, scope: &str| {
        format!("{n} fresh dispatch files exist{scope}, the gate will not guess which one — {fix}.")
    };
    let skipped_note = if skipped.is_empty() {
        String::new()
    } else {
        format!(" (skipped other-session markers: {})", skipped.join(", "))
    };
    match session {
        None => {
            if fresh_hits.len() == 1 {
                return Ok(fresh_hits.remove(0));
            }
            if fresh_hits.len() > 1 {
                return deny(ambiguous(fresh_hits.len(), ""));
            }
        }
        Some(id) => {
            if own.len() == 1 {
                return Ok(fresh_hits.remove(own[0]));
            }
            if own.len() > 1 {
                return deny(ambiguous(own.len(), " for this session"));
            }
            if unscoped.len() == 1 && other_fresh == 0 {
                return Ok(fresh_hits.remove(unscoped[0]));
            }
            if !unscoped.is_empty() {
                return deny(format!(
                    "no dispatch file for this session ({id}) can be selected: {} unstamped and {other_fresh} other-session fresh dispatch files exist, the gate will not guess{skipped_note} — {fix}.",
                    unscoped.len()
                ));
            }
        }
    }
    let lead = if stale > 0 {
        "the dispatch file is stale (older than 10 min) — ".to_owned()
    } else {
        format!(
            "the spawn message is encrypted and no dispatch file exists{}{skipped_note} — ",
            if session.is_some() {
                " for this session"
            } else {
                ""
            }
        )
    };
    deny(format!("{lead}{fix}."))
}

fn uuid_v4() -> Option<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .ok()?
        .read_exact(&mut bytes)
        .ok()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// `claimDispatch` without an escalation burn: `Ok(None)` when the claim spent this exact
/// marker. A failed rename other than `ENOENT` quotes a Node error message: delegated, since
/// nothing moved.
fn claim_dispatch(file: &Path, raw: &str, ctx: &Context<'_>) -> R<Option<String>> {
    let base = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let uuid = uuid_v4().unwrap_or_else(|| format!("{:x}", ctx.now_ms as u64));
    let claim = file.with_file_name(format!(
        ".{base}.claim-{}-{}-{uuid}",
        ctx.pid,
        js_json::number_to_js(ctx.now_ms)
    ));
    if let Err(error) = fs::rename(file, &claim) {
        return if error.kind() == ErrorKind::NotFound {
            Ok(Some(
                "dispatch already claimed by a concurrent spawn.".to_owned(),
            ))
        } else {
            delegate("dispatch rename failed")
        };
    }
    let unchanged = || matches!(read_snapshot(&claim), Ok(Some(text)) if text == raw);
    let verdict = if !unchanged() {
        Some("dispatch changed during evaluation; rewrite it and retry.".to_owned())
    } else if !unchanged() {
        Some("dispatch changed during consumption; attempt stays spent.".to_owned())
    } else {
        None
    };
    // Only the selected bytes are deleted; anything else returns to its public name when free.
    if unchanged() || fs::hard_link(&claim, file).is_ok() {
        let _ = fs::remove_file(&claim);
    }
    Ok(verdict)
}

// ---------------------------------------------------------------------------------------------
// Escalation: only the "no rejection on record" fast path is native.

/// `evaluateEscalation(...) === null` without writing, or delegation when the history, the
/// review's last verdict or any escalation state could change the answer or append a line.
fn no_rejections(root: &StateRoot, feature: &str, ctx: &Context<'_>, p: &Patterns) -> R<()> {
    let log = root.artifact(&format!("workplan_{feature}.gate.jsonl"))?;
    match fs::metadata(&log) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        _ => return delegate("rejection history present"),
    }
    let review = root.artifact(&format!("review_{feature}.md"))?;
    if let Some(text) = read_snapshot(&review)? {
        let last = p
            .final_verdict
            .captures_iter(&text)
            .last()
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_owned());
        if last.as_deref() == Some("CHANGES_REQUESTED") {
            return delegate("review requests changes");
        }
    }
    let handoffs = resolve_state_root(
        &root.cwd.to_string_lossy(),
        feature,
        Some(NEUTRAL_DIR),
        ctx,
        p,
    )?;
    if !exists(&handoffs.path) {
        return Ok(());
    }
    let Ok(entries) = fs::read_dir(&handoffs.path) else {
        return delegate("unreadable escalation directory");
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return delegate("unreadable escalation directory");
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("escalation_") && !is_private_temporary(&name) {
            return delegate("escalation state present");
        }
    }
    Ok(())
}

/// `^escalation_private_[a-f0-9-]{36}\.tmp$`.
fn is_private_temporary(name: &str) -> bool {
    name.strip_prefix("escalation_private_")
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|id| {
            id.len() == 36
                && id
                    .bytes()
                    .all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
        })
}

// ---------------------------------------------------------------------------------------------
// Openings

/// `VERIFY_CLAUSE`: `verify:\s+(`+)(.+?)\1\s+(?:→|->)\s+(\S.*)$`, matched like a backtracking
/// engine (the backreference rules out the `regex` crate). Returns `(command, expected)`.
fn verify_clause(text: &str, p: &Patterns) -> Option<(String, String)> {
    let head = p.verify_head.find(text)?;
    let rest = &text[head.end()..];
    let run = rest.bytes().take_while(|b| *b == b'`').count();
    for n in (1..=run).rev() {
        let body = &rest[n..];
        let fence = "`".repeat(n);
        for (index, ch) in body.char_indices() {
            if matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                break;
            }
            let end = index + ch.len_utf8();
            if !body[end..].starts_with(&fence) {
                continue;
            }
            if let Some(c) = p.verify_tail.captures(&body[end + n..]) {
                let expected = c.get(1)?.as_str().to_owned();
                return Some((body[..end].to_owned(), expected));
            }
        }
    }
    None
}

fn doctrine_is_stale(cwd: &str) -> bool {
    ["CLAUDE.md", "AGENTS.md"].iter().any(|name| {
        fs::read(Path::new(cwd).join(name))
            .is_ok_and(|b| String::from_utf8_lossy(&b).contains("`nivel-0: <path>`"))
    })
}

fn config_strings(config: &Config, section: &str, key: &str) -> Option<Vec<String>> {
    let JsValue::Array(items) = member(member(&config.data, section)?, key)? else {
        return None;
    };
    items
        .iter()
        .map(|v| match v {
            JsValue::String(s) => s.to_rust(),
            _ => None,
        })
        .collect()
}

#[allow(
    clippy::too_many_arguments,
    reason = "a literal port of evaluateNivel0's parameters"
)]
fn evaluate_nivel0(
    cwd: &str,
    config: &Config,
    raw_path: &str,
    raw_feature: Option<&str>,
    dispatch_feature: Option<&str>,
    ctx: &Context<'_>,
    p: &Patterns,
) -> R<()> {
    let tail = raw_feature.unwrap_or("");
    let (feature, verify) = match tail.find('|') {
        None => (js_trim(tail), None),
        Some(bar) => (js_trim(&tail[..bar]), Some(js_trim(&tail[bar + 1..]))),
    };
    if !p.feature_slug.is_match(feature) {
        let stale = if doctrine_is_stale(cwd) {
            " The rendered doctrine is outdated: run `navori render --apply`."
        } else {
            ""
        };
        return deny(format!(
            "`nivel-0:` needs a feature — open with {NIVEL0_FORM}.{stale}"
        ));
    }
    if let Some(dispatch) = dispatch_feature.filter(|d| *d != feature) {
        return deny(format!(
            "dispatch feature \"{dispatch}\" does not match nivel-0 feature \"{feature}\"."
        ));
    }
    let clause = verify.and_then(|v| verify_clause(v, p));
    let Some((_, expected)) = clause.filter(|(c, _)| !js_trim(c).is_empty()) else {
        return deny(format!(
            "`nivel-0:` needs a verification criterion (R28) — open with {NIVEL0_FORM}; `<expected>` may be structured or free text and must not be empty."
        ));
    };
    match parse_expected(&expected) {
        None | Some(Expected::NeedsJs) => return delegate("matches: needs a JS RegExp"),
        Some(Expected::Invalid(reason)) => {
            return deny(format!(
                "`nivel-0:` invalid structured expected — {reason}."
            ));
        }
        Some(_) => {}
    }
    let root = resolve_state_root(cwd, feature, None, ctx, p)?;
    if exists(&root.artifact(&format!("workplan_{feature}.json"))?) {
        return deny(format!(
            "feature \"{feature}\" already has a workplan — open with `workplan: {feature}`, not nivel-0."
        ));
    }
    let files: Vec<String> = raw_path
        .split(',')
        .filter(|f| !f.is_empty())
        .map(str::to_owned)
        .collect();
    if files.is_empty() {
        return deny(format!("`nivel-0:` has no path — open with {NIVEL0_FORM}."));
    }
    if let Some(unsafe_path) = files.iter().find(|f| {
        let n = normalize_repo_path(f);
        n.absolute || n.escapes
    }) {
        return deny(format!(
            "`nivel-0:` path \"{unsafe_path}\" is absolute or climbs out with `..` — use repo-relative paths."
        ));
    }
    let critical = config_strings(config, "project", "criticalPaths");
    if matches_critical_paths(&files, critical.as_deref().unwrap_or_default()) {
        return deny(format!(
            "`nivel-0: {raw_path}` touches a critical path (project.criticalPaths) — level 0 is not allowed; run `navori plan classify <feature>` and produce a workplan."
        ));
    }
    let input = ClassifyInput {
        files,
        critical_paths: critical.unwrap_or_default(),
        local_skill_ids: config_strings(config, "project", "localSkills")
            .map(|ids| ids.into_iter().collect()),
        ..ClassifyInput::default()
    };
    let Some(result) = classify(&input) else {
        return delegate("classify rules failed to compile");
    };
    if result.level != 0 {
        return deny(format!(
            "`nivel-0: {raw_path}` is not confirmed by classify (computed level {}, score {}) — run `navori plan classify <feature>`, then produce a workplan with skill `plan-simple` (level 1) or `plan-advanced` (level 2).",
            result.level, result.score
        ));
    }
    no_rejections(&root, feature, ctx, p)
}

/// `evaluateWorkplan`.
fn evaluate_workplan(
    root: &StateRoot,
    feature: &str,
    config: &Config,
    spec: bool,
    warnings: &mut Vec<String>,
    ctx: &Context<'_>,
    p: &Patterns,
) -> R<()> {
    let path = root.artifact(&format!("workplan_{feature}.json"))?;
    if !exists(&path) {
        return deny(format!(
            "no workplan at {} — write the draft and run `navori plan render {feature}` then `navori plan check {feature}`, skill `plan-simple` (level 1) or `plan-advanced` (level 2).",
            path.display()
        ));
    }
    let Some(text) = read_snapshot(&path)? else {
        return delegate("workplan vanished");
    };
    let Some(raw) = js_json::parse(&text) else {
        return delegate("workplan JSON error message");
    };
    let project = ProjectContext {
        critical_paths: config_strings(config, "project", "criticalPaths"),
        local_skill_ids: config_strings(config, "project", "localSkills"),
    };
    let Checked::Ok {
        level,
        feature: declared,
    } = check_workplan(&raw, feature, &project)
    else {
        return delegate("workplan check fails");
    };
    // `checkLevel` re-reads the config through `projectClassifyContext`, warnings included.
    warnings.extend(config.warnings.iter().cloned());
    if spec && (level != 3 || declared != feature) {
        return deny(format!(
            "spec dispatch requires workplan feature \"{feature}\" and level 3."
        ));
    }
    if declared != feature {
        return deny("workplan feature does not match opening");
    }
    no_rejections(root, feature, ctx, p)
}

fn evaluate_spec(
    root: &StateRoot,
    config: &Config,
    (spec, delivery, milestone): (&str, &str, &str),
    feature: &str,
    warnings: &mut Vec<String>,
    ctx: &Context<'_>,
    p: &Patterns,
) -> R<()> {
    let specs_dir = match member(&config.data, "sdd").and_then(|s| member(s, "specsDir")) {
        Some(JsValue::String(s)) => match s.to_rust() {
            Some(dir) => dir,
            None => return delegate("specsDir with a lone surrogate"),
        },
        None | Some(JsValue::Undefined | JsValue::Null) => "specs".to_owned(),
        Some(_) => return delegate("specsDir of another type"),
    };
    let cwd = root.cwd.to_string_lossy();
    let dir = match locate_spec_dir(&cwd, &specs_dir, spec) {
        None => return delegate("spec name pattern failed to compile"),
        Some(Err(why)) => return deny(why),
        Some(Ok(dir)) => dir,
    };
    let tasks_path = format!("{dir}/tasks.md");
    let text = read_snapshot(Path::new(&tasks_path))?.unwrap_or_default();
    let Some(tasks) = parse_tasks(&text) else {
        return delegate("tasks patterns failed to compile");
    };
    if !tasks.deliveries_format
        || tasks.malformed > 0
        || tasks.orphan_tasks > 0
        || tasks.orphan_criteria > 0
    {
        return deny(format!(
            "{tasks_path} must use deliveries without malformed or orphan items."
        ));
    }
    let deliveries: Vec<_> = tasks
        .deliveries
        .iter()
        .filter(|d| d.id == delivery)
        .collect();
    let [only] = deliveries.as_slice() else {
        return deny(format!(
            "{tasks_path} must contain exactly one {delivery} delivery."
        ));
    };
    if only.milestones.iter().filter(|m| *m == milestone).count() != 1 {
        return deny(format!(
            "{tasks_path} must contain exactly one {milestone} milestone in {delivery}."
        ));
    }
    evaluate_workplan(root, feature, config, true, warnings, ctx, p)
}

// ---------------------------------------------------------------------------------------------
// Entry

/// `configRoot`: the Git toplevel of `cwd`, or `cwd` outside a checkout.
fn config_root(cwd: &str, ctx: &Context<'_>) -> String {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .env_clear()
        .envs(ctx.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let top = js_trim(&String::from_utf8_lossy(&out.stdout)).to_owned();
            if top.is_empty() { cwd.to_owned() } else { top }
        }
        _ => cwd.to_owned(),
    }
}

/// Whether the environment carries an audit session identity `contextFromEnv` could read.
#[must_use]
pub fn audit_identity_in_env(env: &Env) -> bool {
    [
        "NAVORI_AUDIT_HOST",
        "NAVORI_AUDIT_SESSION_ID",
        "CLAUDE_CODE_SESSION_ID",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
    ]
    .iter()
    .any(|name| {
        env.iter()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.to_str())
            .is_some_and(|v| !js_trim(v).is_empty())
    })
}

/// Whether the audit directory of `cwd`'s repo holds a regular `session-*.log`, under
/// `NAVORI_AUDITS_ROOT` or `~/.navori/audits` (both are checked: a superset of `auditsRoot()`).
/// A repo name the port cannot derive counts as present.
#[must_use]
pub fn audit_log_present(cwd: &str, env: &Env) -> bool {
    let var = |name: &str| {
        env.iter()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.to_str().map(str::to_owned))
    };
    let Some(repo) = crate::audit::repo_from_cwd(cwd) else {
        return true;
    };
    let mut roots = Vec::new();
    if let Some(root) = var("NAVORI_AUDITS_ROOT").filter(|r| !r.is_empty()) {
        roots.push(PathBuf::from(root));
    }
    if let Some(home) = var("HOME").filter(|h| !h.is_empty()) {
        roots.push(Path::new(&home).join(".navori/audits"));
    }
    roots.iter().any(|root| {
        let Ok(entries) = fs::read_dir(root.join(&repo)) else {
            return root.join(&repo).exists();
        };
        entries.flatten().any(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("session-")
                && name.ends_with(".log")
                && e.file_type().is_ok_and(|t| t.is_file())
        })
    })
}

/// `evaluatePlanGate` over the raw stdin bytes, with the Codex claim on an allow.
#[must_use]
pub fn evaluate(stdin: &[u8], force_codex: bool, ctx: &Context<'_>) -> Decision {
    let mut warnings = Vec::new();
    let outcome = match run(stdin, force_codex, ctx, &mut warnings) {
        Ok(()) => Outcome::Allow,
        Err(Stop::Deny(reason)) => Outcome::Deny(reason),
        Err(Stop::Delegate(why)) => Outcome::Delegate(why),
    };
    Decision { outcome, warnings }
}

fn run(stdin: &[u8], force_codex: bool, ctx: &Context<'_>, warnings: &mut Vec<String>) -> R<()> {
    let Some(p) = PATTERNS.as_ref() else {
        return delegate("gate patterns failed to compile");
    };
    // `readFileSync(0, "utf8")` replaces invalid bytes; `JSON.parse` errors are not modelled.
    let Ok(text) = std::str::from_utf8(stdin) else {
        return delegate("stdin is not UTF-8");
    };
    // An unparsable payload (UNREADABLE_PAYLOAD) is rare, and js_json cannot tell it from JSON
    // it does not model: both go to the TS.
    let Some(raw) = js_json::parse(text) else {
        return delegate("payload is not JSON the port models");
    };
    let parsed = parse_payload(&raw, force_codex)?;
    if let Ok(payload) = &parsed {
        // JS and Rust case mappings agree on ASCII; any other role goes to the TS.
        if !payload.role.as_deref().unwrap_or("").is_ascii() {
            return delegate("non-ASCII role");
        }
        if !is_implementer_spawn(payload.role.as_deref(), payload.codex, p) {
            return Ok(());
        }
    }
    let cwd = match string_member(&raw, "cwd")? {
        Some(cwd) if !cwd.is_empty() => cwd,
        _ => ctx.process_cwd.to_string_lossy().into_owned(),
    };
    let config_path = Path::new(&config_root(&cwd, ctx)).join("navori.config.json");
    if !exists(&config_path) {
        return Ok(());
    }
    let snapshot_path = Path::new(&cwd).join("navori.config.json");
    let snapshot = read_snapshot(&snapshot_path)?;
    let Ok(bytes) = fs::read(&config_path) else {
        return delegate("unreadable config");
    };
    let config = config::read(&bytes).or_else(|_| delegate("config outside the ported model"))?;
    warnings.extend(config.warnings.iter().cloned());
    if read_snapshot(&snapshot_path)? != snapshot {
        return deny("configuration changed during validation");
    }
    let plan_tiers = member(&config.data, "harness").and_then(|h| member(h, "planTiers"));
    if !matches!(plan_tiers, Some(JsValue::Bool(true))) {
        return Ok(());
    }
    checkout(&cwd, ctx)?;
    let payload = match parsed {
        Ok(payload) => payload,
        Err(problem) => return deny(format!("the hook payload is unreadable ({problem}).")),
    };
    let session = payload
        .session_id
        .as_deref()
        .filter(|s| p.spawn_id.is_match(s));

    let prompt = payload.prompt.as_deref().unwrap_or("");
    let mut first_line = js_trim(prompt.split('\n').next().unwrap_or("")).to_owned();
    let mut consume: Option<(PathBuf, String)> = None;
    let mut dispatch_feature: Option<String> = None;
    if payload.codex && (first_line.is_empty() || p.encrypted.is_match(&first_line)) {
        let hit = read_dispatch(&cwd, session, ctx, p)?;
        first_line = js_trim(hit.opening.split('\n').next().unwrap_or("")).to_owned();
        consume = Some((hit.file, hit.raw));
        dispatch_feature = Some(hit.feature);
    }
    let workplan = p.workplan.captures(&first_line);
    let nivel0 = p.nivel0.captures(&first_line);
    let spec = p.spec.captures(&first_line);
    let group = |c: &regex::Captures<'_>, i: usize| c.get(i).map(|m| m.as_str().to_owned());
    let feature = match (&spec, &workplan) {
        (Some(s), _) => Some(format!(
            "{}-e{}",
            group(s, 1).unwrap_or_default(),
            group(s, 2).unwrap_or_default()
        )),
        (None, Some(w)) => group(w, 1),
        (None, None) => None,
    };
    if workplan.is_none() && nivel0.is_none() && spec.is_none() {
        return deny(NO_OPENING_LINE_REASON);
    }
    if let Some(n) = &nivel0 {
        let path = group(n, 1).unwrap_or_default();
        let rest = group(n, 2);
        evaluate_nivel0(
            &cwd,
            &config,
            &path,
            rest.as_deref(),
            dispatch_feature.as_deref(),
            ctx,
            p,
        )?;
    } else {
        let feature = feature.clone().unwrap_or_default();
        let root = resolve_state_root(&cwd, &feature, None, ctx, p)?;
        if let Some(s) = &spec {
            if let Some(d) = dispatch_feature.as_deref().filter(|d| *d != feature) {
                return deny(format!(
                    "dispatch feature \"{d}\" does not match spec delivery \"{feature}\"."
                ));
            }
            let delivery = format!("E{}", group(s, 2).unwrap_or_default());
            let milestone = format!("M{}", group(s, 3).unwrap_or_default());
            let name = group(s, 1).unwrap_or_default();
            let target = (name.as_str(), delivery.as_str(), milestone.as_str());
            evaluate_spec(&root, &config, target, &feature, warnings, ctx, p)?;
        } else {
            evaluate_workplan(&root, &feature, &config, false, warnings, ctx, p)?;
        }
    }
    // An allow with a feature reports a dispatch outcome; only the TS writes audit events. The
    // payload's own session is an explicit identity, so it counts even without the environment.
    let identity = payload.session_id.is_some() || audit_identity_in_env(ctx.env);
    if feature.is_some() && identity && audit_log_present(&cwd, ctx.env) {
        return delegate("possible audit target");
    }
    if let Some((file, raw)) = consume
        && let Some(reason) = claim_dispatch(&file, &raw, ctx)?
    {
        return deny(reason);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{PATTERNS, iso_ms, verify_clause};

    #[test]
    fn iso_and_verify_follow_the_ts_regexes() {
        let Some(p) = PATTERNS.as_ref() else {
            panic!("gate patterns must compile");
        };
        assert_eq!(iso_ms("1970-01-01T00:00:00Z", p), Some(0.0));
        assert_eq!(
            iso_ms("2026-10-03T20:27:54.004865+00:00", p),
            Some(1_791_059_274_004.0)
        );
        assert_eq!(
            iso_ms("2026-10-03T22:27:54.5+02:00", p),
            Some(1_791_059_274_500.0)
        );
        assert!(iso_ms("2024-02-29T00:00:00Z", p).is_some());
        for bad in [
            "2023-02-29T00:00:00Z",
            "2026-10-03T24:00:00Z",
            "2026-10-03T20:27Z",
            "2026-10-03 20:27:54Z",
        ] {
            assert_eq!(iso_ms(bad, p), None, "{bad}");
        }
        let v = |t: &str| verify_clause(t, p);
        assert_eq!(
            v("verify: `bun x` → exit 0"),
            Some(("bun x".into(), "exit 0".into()))
        );
        assert_eq!(
            v("verify: ``a ` b`` -> ok"),
            Some(("a ` b".into(), "ok".into()))
        );
        assert_eq!(
            v("verify: `a|b` → x → y"),
            Some(("a|b".into(), "x → y".into()))
        );
        assert_eq!(v("verify: ``x` → y"), Some(("`x".into(), "y".into())));
        assert_eq!(v("verify:`a` → x"), None);
        assert_eq!(v("verify: `a` →"), None);
        assert_eq!(v("verify: `` → x"), None);
    }
}
