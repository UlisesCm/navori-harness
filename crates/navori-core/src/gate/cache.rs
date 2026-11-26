//! Read side of the quality-gate result cache, port of `lib/gate/cache.ts` (spec 0054 D1, 0059
//! D33): `probeGreen` and everything it reaches (`lookupSatisfying`, `lookupGreen`,
//! `fastCoveredByFull`, `toolchainKey`). Writing a record (`recordGreen`, under `withFileLock`)
//! stays in the TS: only `navori gate <fast|full>` records, and that command is not ported.
//!
//! A hit needs every key field equal and the recorded log to still hash to `logSha256` and end
//! with the success sentinel. Any error is a miss. A document [`js_json::parse`] does not read is
//! [`Probe::Delegate`]: the caller hands the invocation to the TS before writing anything.

use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::STAMP_VERSION;
use crate::content_identity::{self, hex};
use crate::integrity::{is_js_whitespace, js_trim_end};
use crate::js_json::{self, JsObject, JsString, JsValue};
use crate::posix::{self, js_trim};
use crate::process::{self, Env};
use crate::state_root::has_symlink_ancestor;

/// State directory of the gate, relative to the checkout.
pub const GATE_DIR: &str = ".navori/state/gate";
const RESULTS_FILE: &str = "results.json";
const LOCKFILES: &[&str] = &[
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
];
const TOOL_TIMEOUT: Duration = Duration::from_secs(5);

/// Which bytes `gate probe` keys on (`ProbeMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeMode {
    /// The working tree.
    Working,
    /// The index (git's pre-commit hook).
    Index,
    /// Index, working tree and record must agree.
    Clean,
}

/// `qualityGate.{fast,full}` as the config holds them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Commands {
    /// `qualityGate.fast`.
    pub fast: Option<String>,
    /// `qualityGate.full`.
    pub full: Option<String>,
}

/// Answer of [`probe_green`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// A recorded green `fast` (or a covering `full`) matches these bytes.
    Hit,
    /// No usable record.
    Miss,
    /// A document Rust does not read like the TS; the TS must answer.
    Delegate,
}

/// Where the probe runs.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// Physical checkout root (`root.cwd`).
    pub repo: &'a Path,
    /// Directory of the process; `bun`/`node --version` run there, as the TS children do.
    pub process_cwd: &'a Path,
    /// Environment every child gets (the caller already scrubbed it).
    pub env: &'a Env,
}

/// A document [`js_json::parse`] refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Delegate;

/// The toolchain half of a key (`toolchainKey`).
#[derive(Debug, Clone)]
struct Tools {
    lock_hash: String,
    bun_version: String,
    node_version: String,
}

/// A record whose fields are all strings (`isEntry`).
struct Entry<'a>(&'a JsObject);

impl Entry<'_> {
    /// Whether field `name` equals `value`.
    fn is(&self, name: &str, value: &str) -> bool {
        matches!(self.0.get(name), Some(JsValue::String(text)) if text.is(value))
    }

    /// Field `name` as Rust text, lone surrogates replaced as Node's UTF-8 encoder does.
    fn text(&self, name: &str) -> String {
        match self.0.get(name) {
            Some(JsValue::String(text)) => String::from_utf16_lossy(text.units()),
            _ => String::new(),
        }
    }
}

const ENTRY_FIELDS: &[&str] = &[
    "fingerprint",
    "kind",
    "commandHash",
    "lockHash",
    "navoriVersion",
    "bunVersion",
    "nodeVersion",
    "ts",
    "log",
    "logSha256",
];

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `passSentinel(kind, fingerprint)`: the last line of a green log.
#[must_use]
pub fn pass_sentinel(kind: &str, fingerprint: &str) -> String {
    format!("[navori gate] PASS {kind} {fingerprint}")
}

/// `readFileSync(path, "utf8")` then `JSON.parse`: `Ok(None)` when the read fails. Text
/// [`js_json::parse`] refuses is [`Delegate`], invalid JSON included: telling the two apart is
/// the TS's job, and the probe only gets slower.
fn read_json(path: &Path) -> Result<Option<JsValue>, Delegate> {
    let Ok(bytes) = fs::read(path) else {
        return Ok(None);
    };
    js_json::parse(&String::from_utf8_lossy(&bytes))
        .map(Some)
        .ok_or(Delegate)
}

/// `readEntries`' file: unreadable, or behind a symlink, is an empty record.
fn read_record(repo: &Path) -> Result<Option<JsValue>, Delegate> {
    let path = repo.join(GATE_DIR).join(RESULTS_FILE);
    match has_symlink_ancestor(repo, &path) {
        Ok(false) => read_json(&path),
        _ => Ok(None),
    }
}

/// `readEntries`: a record of an unknown version holds nothing.
fn entries(record: Option<&JsValue>) -> Vec<Entry<'_>> {
    let Some(JsValue::Object(record)) = record else {
        return Vec::new();
    };
    if !matches!(record.get("v"), Some(JsValue::Number(v)) if *v == 1.0) {
        return Vec::new();
    }
    let Some(JsValue::Array(items)) = record.get("entries") else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            JsValue::Object(object)
                if ENTRY_FIELDS
                    .iter()
                    .all(|f| matches!(object.get(f), Some(JsValue::String(_)))) =>
            {
                Some(Entry(object))
            }
            _ => None,
        })
        .collect()
}

/// `logProvesGreen`: the log lies inside the checkout, hashes to `logSha256` and its last
/// non-blank line is the success sentinel.
fn log_proves_green(repo: &Path, entry: &Entry<'_>) -> bool {
    let Some(base) = repo.to_str() else {
        return false;
    };
    let path = posix::resolve(base, &entry.text("log"));
    if posix::relative(base, &path).starts_with("..") {
        return false;
    }
    let Ok(bytes) = fs::read(&path) else {
        return false;
    };
    if !entry.is("logSha256", &sha256_hex(&bytes)) {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    let last = js_trim_end(&text).rsplit('\n').next().unwrap_or("");
    last == pass_sentinel(&entry.text("kind"), &entry.text("fingerprint"))
}

/// `toolVersion`: `<tool> --version`, or `unavailable`.
fn tool_version(tool: &str, ctx: &Context<'_>) -> String {
    match process::run(
        tool,
        &["--version"],
        ctx.process_cwd,
        ctx.env,
        None,
        TOOL_TIMEOUT,
    ) {
        Ok(output) if output.status.code() == Some(0) => {
            js_trim(&String::from_utf8_lossy(&output.stdout)).to_owned()
        }
        _ => "unavailable".to_owned(),
    }
}

/// `toolchainKey(repo)`; `None` where the TS throws (a lockfile that exists but cannot be read).
fn toolchain(ctx: &Context<'_>) -> Option<Tools> {
    let mut hash = Sha256::new();
    for name in LOCKFILES {
        let path = ctx.repo.join(name);
        if path.exists() {
            hash.update(name.as_bytes());
            hash.update([0]);
            hash.update(fs::read(&path).ok()?);
            hash.update([0]);
        }
    }
    Some(Tools {
        lock_hash: hex(&hash.finalize()),
        bun_version: tool_version("bun", ctx),
        node_version: tool_version("node", ctx),
    })
}

/// Toolchain computed on first use, so a probe without a candidate record spawns nothing.
struct Lazy<'a> {
    ctx: Context<'a>,
    tools: Option<Option<Tools>>,
}

impl Lazy<'_> {
    fn get(&mut self) -> Option<&Tools> {
        let ctx = self.ctx;
        self.tools.get_or_insert_with(|| toolchain(&ctx)).as_ref()
    }
}

/// `lookupGreen(root, key)` for the key of `kind`/`command`; `None` is the TS throwing (a miss).
/// Fields that need no spawn are compared first, so the toolchain is probed only when a
/// candidate record exists.
fn lookup_green(
    repo: &Path,
    entries: &[Entry<'_>],
    fingerprint: &str,
    kind: &str,
    command: &str,
    tools: &mut Lazy<'_>,
) -> Option<bool> {
    let command_hash = sha256_hex(command.as_bytes());
    let candidates: Vec<&Entry<'_>> = entries
        .iter()
        .filter(|e| {
            e.is("fingerprint", fingerprint)
                && e.is("kind", kind)
                && e.is("commandHash", &command_hash)
                && e.is("navoriVersion", STAMP_VERSION)
        })
        .collect();
    if candidates.is_empty() {
        return Some(false);
    }
    let tools = tools.get()?;
    Some(candidates.into_iter().any(|e| {
        e.is("lockHash", &tools.lock_hash)
            && e.is("bunVersion", &tools.bun_version)
            && e.is("nodeVersion", &tools.node_version)
            && log_proves_green(repo, e)
    }))
}

/// `stepsWithCwd`: the `&&` steps of a chain with the effective cwd of each (`cd X` updates it,
/// is not a step); `None` for `||` / `;` chains or an empty step.
fn steps_with_cwd(chain: &str) -> Option<Vec<(String, String)>> {
    if chain.contains("||") || chain.contains(';') {
        return None;
    }
    let mut out = Vec::new();
    let mut cwd = ".".to_owned();
    for raw in chain.split("&&") {
        let step = collapse_whitespace(js_trim(raw));
        if step.is_empty() {
            return None;
        }
        match step.strip_prefix("cd ") {
            Some(dir) if !dir.is_empty() && !dir.contains(' ') => {
                cwd = posix::normalize(&posix::join(&[&cwd, dir]));
            }
            _ => out.push((cwd.clone(), step)),
        }
    }
    Some(out)
}

/// `replace(/\s+/g, " ")` with JS whitespace.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for ch in text.chars() {
        if is_js_whitespace(ch) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out
}

/// `scripts[name]` when it is a string; any other value makes the TS throw (a miss) or skip.
fn script<'a>(scripts: Option<&'a JsValue>, name: &str) -> Option<&'a JsString> {
    let value = match scripts? {
        JsValue::Object(object) => object.get(name),
        JsValue::Array(items) => JsString::from(name)
            .array_index()
            .and_then(|index| items.get(usize::try_from(index).ok()?)),
        _ => None,
    };
    match value {
        Some(JsValue::String(text)) => Some(text),
        _ => None,
    }
}

/// `fastCoveredByFull(fast, full, scripts)`: every `&&` step of `fast`, with its cwd, appears
/// literally in `full`, or is a root `bun|npm run <script>` whose body (one level) does.
fn fast_covered_by_full(fast: &str, full: &str, scripts: Option<&JsValue>) -> bool {
    let (Some(fast_steps), Some(full_steps)) = (steps_with_cwd(fast), steps_with_cwd(full)) else {
        return false;
    };
    if fast_steps.is_empty() {
        return false;
    }
    let literal = |cwd: &str, step: &str| full_steps.iter().any(|(c, s)| c == cwd && s == step);
    fast_steps.iter().all(|(cwd, step)| {
        if literal(cwd, step) {
            return true;
        }
        let name = (cwd == ".")
            .then(|| {
                step.strip_prefix("bun run ")
                    .or_else(|| step.strip_prefix("npm run "))
            })
            .flatten()
            .filter(|name| !name.is_empty() && !name.contains(' '));
        let Some(body) = name
            .and_then(|name| script(scripts, name))
            .and_then(JsString::to_rust)
        else {
            return false;
        };
        steps_with_cwd(&body)
            .is_some_and(|inner| !inner.is_empty() && inner.iter().all(|(c, s)| literal(c, s)))
    })
}

/// `readRootScripts(repo)`: the root `package.json` `scripts`, when it is an object.
fn root_scripts(repo: &Path) -> Result<Option<JsValue>, Delegate> {
    let Some(JsValue::Object(package)) = read_json(&repo.join("package.json"))? else {
        return Ok(None);
    };
    Ok(match package.get("scripts") {
        Some(scripts @ (JsValue::Object(_) | JsValue::Array(_))) => Some(scripts.clone()),
        _ => None,
    })
}

/// The fingerprint the probe keys on, or `None` (a miss).
fn probe_fingerprint(mode: ProbeMode, ctx: &Context<'_>) -> Option<String> {
    let working = match mode {
        ProbeMode::Index => None,
        ProbeMode::Working | ProbeMode::Clean => Some(
            content_identity::working(ctx.repo, ctx.env)
                .ok()?
                .fingerprint,
        ),
    };
    let index = match mode {
        ProbeMode::Working => None,
        ProbeMode::Index | ProbeMode::Clean => {
            Some(content_identity::index(ctx.repo, ctx.env).ok()?)
        }
    };
    if mode == ProbeMode::Clean && working != index {
        return None;
    }
    index.or(working)
}

/// `probeGreen(root, mode, commands)`: is there a green `fast` (or a covering `full`) for the
/// bytes about to be committed?
#[must_use]
pub fn probe_green(mode: ProbeMode, commands: &Commands, ctx: &Context<'_>) -> Probe {
    let Some(fingerprint) = probe_fingerprint(mode, ctx) else {
        return Probe::Miss;
    };
    let Ok(record) = read_record(ctx.repo) else {
        return Probe::Delegate;
    };
    let entries = entries(record.as_ref());
    let mut tools = Lazy {
        ctx: *ctx,
        tools: None,
    };
    if let Some(fast) = &commands.fast {
        match lookup_green(ctx.repo, &entries, &fingerprint, "fast", fast, &mut tools) {
            Some(true) => return Probe::Hit,
            Some(false) => {}
            None => return Probe::Miss,
        }
    }
    let (Some(fast), Some(full)) = (&commands.fast, &commands.full) else {
        return Probe::Miss;
    };
    let Ok(scripts) = root_scripts(ctx.repo) else {
        return Probe::Delegate;
    };
    if !fast_covered_by_full(fast, full, scripts.as_ref()) {
        return Probe::Miss;
    }
    match lookup_green(ctx.repo, &entries, &fingerprint, "full", full, &mut tools) {
        Some(true) => Probe::Hit,
        _ => Probe::Miss,
    }
}

/// The environment `gate probe` gives its children: every `GIT_*` but `GIT_INDEX_FILE` removed,
/// so a probe never reads another repository's state (`PROBE_SCRUBBED`).
#[must_use]
pub fn probe_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(key, _)| {
            let bytes = key.as_encoded_bytes();
            !bytes.starts_with(b"GIT_") || bytes == b"GIT_INDEX_FILE"
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{fast_covered_by_full, steps_with_cwd};
    use crate::js_json;

    // Covers: R56
    #[test]
    fn steps_follow_cd_and_reject_unsafe_chains() {
        assert_eq!(
            steps_with_cwd(" a  b && cd x && c && cd .. && d"),
            Some(vec![
                (".".into(), "a b".into()),
                ("x".into(), "c".into()),
                (".".into(), "d".into()),
            ])
        );
        assert_eq!(steps_with_cwd("a || b"), None);
        assert_eq!(steps_with_cwd("a;b"), None);
        assert_eq!(steps_with_cwd("a && "), None);
    }

    // Covers: R56
    #[test]
    fn coverage_expands_one_root_script() {
        let scripts = js_json::parse(r#"{"lint":"x && y","nested":"bun run lint"}"#);
        let scripts = scripts.as_ref();
        assert!(fast_covered_by_full("x", "x && z", scripts));
        assert!(fast_covered_by_full("bun run lint", "x && y && z", scripts));
        assert!(!fast_covered_by_full("bun run nested", "x && y", scripts));
        assert!(!fast_covered_by_full(
            "cd sub && bun run lint",
            "x && y",
            scripts
        ));
        assert!(!fast_covered_by_full("npm run absent", "x", scripts));
        assert!(!fast_covered_by_full("cd sub", "x", scripts));
    }
}
