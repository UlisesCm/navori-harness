//! subagent-stop-handoff.sh (spec 0059 T15): the rendered script end to end.
//!
//! Facts arrive through [`Host`]. Its writes (the per-session stamp and compaction mark) and the
//! Codex child capture come last or feed nothing the script reads afterwards, so a shadow host
//! skips them and the whole decision stays observed; a failed redirection still prints Bash's
//! error, which [`Host::write`] predicts in shadow. `codex capture-start` defers (D31).

pub mod rendered;

pub use rendered::Rendered;

use std::ffi::OsString;
use std::sync::LazyLock;

use navori_core::js_json::{self, JsValue};
use regex::bytes::Regex as BytesRegex;

use crate::runner::{AuditLabel, Evaluation, Failure, Verdict};
use crate::shell::Locale;
use crate::shell::capture::{self, CaptureContext};
use crate::shell::gate_ask::jq_string;
use crate::shell::payload::{self, Profile};

/// `navori_audit_phase` (`PostToolUse` in every registration) for the arguments the hosts pass:
/// none under Claude, `codex` for Codex `SubagentStop`. `None` defers to the shell before
/// stdin: `codex capture-start` registers the start of a Codex child capture (spec 0042), which
/// this phase does not port (D31), and any other shape is never guessed.
#[must_use]
pub fn phase(args: &[OsString]) -> Option<&'static str> {
    match args {
        [] => Some("PostToolUse"),
        [mode] if mode == "codex" => Some("PostToolUse"),
        _ => None,
    }
}

/// `nv_payload_fields`, in the script's order.
const FIELDS: [&str; 13] = [
    "agent_id",
    "agent_transcript_path",
    "agent_type",
    "cwd",
    "hook_event_name",
    "session_id",
    "tool_input.agent_type",
    "tool_input.command",
    "tool_input.file_path",
    "tool_input.notebook_path",
    "tool_input.subagent_type",
    "tool_name",
    "transcript_path",
];
const AGENT_ID: usize = 0;
const AGENT_TRANSCRIPT: usize = 1;
const AGENT_TYPE: usize = 2;
const CWD: usize = 3;
const EVENT: usize = 4;
const SESSION_ID: usize = 5;
const INPUT_AGENT_TYPE: usize = 6;
const SUBAGENT_TYPE: usize = 10;
const TRANSCRIPT: usize = 12;

const REQUIRED: [&str; 8] = [
    "feature",
    "status",
    "worktree",
    "branch",
    "commits",
    "filesTouched",
    "verification",
    "markdownRequests",
];
const TAIL: u64 = 262_144;

/// Host facts and the script's writes, from the shell's working directory.
pub trait Host {
    /// `command -v name`.
    fn on_path(&self, name: &str) -> bool;
    /// `[ -d path ]`.
    fn is_dir(&self, path: &str) -> bool;
    /// `[ -f path ]`.
    fn is_file(&self, path: &str) -> bool;
    /// `[ -L path ]`.
    fn is_symlink(&self, path: &str) -> bool;
    /// The bytes of `path` (following links), `None` when it cannot be read.
    fn read(&self, path: &str) -> Option<Vec<u8>>;
    /// Why `<path` fails to open (`strerror`), `None` when it opens.
    fn open_error(&self, path: &str) -> Option<String>;
    /// `find dir -maxdepth 1 -name '<prefix>*<suffix>' -mmin -2880`, in directory order.
    ///
    /// # Errors
    /// A name the script's `while read` would split.
    fn recent(&self, dir: &str, prefix: &str, suffix: &str) -> Result<Vec<String>, Failure>;
    /// `tail -c <n> path`, `None` when it cannot be read.
    fn tail(&self, path: &str, bytes: u64) -> Option<Vec<u8>>;
    /// `git -C dir rev-parse --show-toplevel`.
    fn toplevel(&self, dir: &str) -> Option<String>;
    /// `navori audit --capture-child …` with its output discarded; a shadow host skips it.
    fn capture_child(&self, child: &str, root: &str, rollout: &str, cwd: &str);
    /// `>path` with `content`: the `strerror` Bash prints when the redirection fails. A shadow
    /// host writes nothing and predicts it.
    fn write(&self, path: &str, content: &[u8]) -> Option<String>;
}

/// Everything fixed before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    pub profile: Profile,
    pub capture: CaptureContext<'a>,
    pub rendered: Rendered,
    /// `$0`.
    pub script: String,
    /// `$1`.
    pub mode: String,
    /// `$PWD`.
    pub pwd: String,
    /// `${TMPDIR:-/tmp}`.
    pub tmpdir: String,
    /// `CLAUDE_PROJECT_DIR`.
    pub claude_project_dir: String,
    /// `${NAVORI_AUDITS_ROOT:-}`, then `$HOME/.navori/audits`; `None` without either.
    pub audits_root: Option<String>,
}

impl Context<'_> {
    fn engine(&self) -> &'static str {
        if self.script.contains(".codex/hooks/") {
            "codex"
        } else if self.script.contains("/.pi/navori/") {
            "pi"
        } else {
            "claude"
        }
    }
}

fn id_ok(text: &str, extra: &[u8]) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || extra.contains(&b))
}

/// POSIX `cksum`: CRC-32 (0x04C11DB7) over the bytes and their length, complemented.
fn cksum(bytes: &[u8]) -> String {
    static TABLE: LazyLock<[u32; 256]> = LazyLock::new(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut crc = (i as u32) << 24;
            for _ in 0..8 {
                crc = if crc & 0x8000_0000 == 0 {
                    crc << 1
                } else {
                    (crc << 1) ^ 0x04C1_1DB7
                };
            }
            *slot = crc;
        }
        table
    });
    let step = |crc: u32, byte: u8| (crc << 8) ^ TABLE[((crc >> 24) as u8 ^ byte) as usize];
    let mut crc = bytes.iter().fold(0, |crc, b| step(crc, *b));
    let mut length = bytes.len() as u64;
    while length > 0 {
        crc = step(crc, (length & 0xff) as u8);
        length >>= 8;
    }
    format!("{}-{}", !crc, bytes.len())
}

/// The lines `grep` reads, as text; invalid UTF-8 under a UTF-8 locale is not modeled.
fn lines(bytes: &[u8], locale: Locale) -> Result<Vec<String>, Failure> {
    bytes
        .split(|b| *b == b'\n')
        .map(|line| match std::str::from_utf8(line) {
            Ok(text) => Ok(text.to_owned()),
            Err(_) if locale == Locale::C => Ok(line.iter().map(|b| char::from(*b)).collect()),
            Err(_) => Err(Failure("a handoff is not UTF-8".to_owned())),
        })
        .collect()
}

/// `! grep -q '[^[:space:]]' file`: unreadable counts as blank.
fn is_blank(bytes: Option<&[u8]>, locale: Locale) -> Result<bool, Failure> {
    let Some(bytes) = bytes else {
        return Ok(true);
    };
    Ok(lines(bytes, locale)?
        .iter()
        .all(|line| line.chars().all(|c| locale.whitespace(c))))
}

/// `grep -qE pattern file` with the locale's `[:space:]`.
fn grep(bytes: &[u8], pattern: &str, locale: Locale) -> Result<bool, Failure> {
    let re = locale
        .ere(pattern)
        .map_err(|e| Failure(format!("grep pattern: {e}")))?;
    Ok(lines(bytes, locale)?.iter().any(|line| re.is_match(line)))
}

/// `JSON.parse` of text Node read as UTF-8: `Ok(None)` for text it rejects.
fn json(text: &str) -> Result<Option<JsValue>, Failure> {
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        // serde rejects a lone surrogate escape that `JSON.parse` accepts.
        let lower = text.to_ascii_lowercase();
        if [
            "\\ud8", "\\ud9", "\\uda", "\\udb", "\\udc", "\\udd", "\\ude", "\\udf",
        ]
        .iter()
        .any(|escape| lower.contains(escape))
        {
            return Err(Failure("JSON with a surrogate escape".to_owned()));
        }
        return Ok(None);
    }
    js_json::parse(text)
        .map(Some)
        .ok_or_else(|| Failure("JSON outside the modeled shape".to_owned()))
}

fn member<'v>(value: &'v JsValue, key: &str) -> Option<&'v JsValue> {
    match value {
        JsValue::Object(o) => o.get(key),
        _ => None,
    }
}

fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null | JsValue::Bool(false)) => false,
        Some(JsValue::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(JsValue::String(s)) => !s.units().is_empty(),
        Some(_) => true,
    }
}

/// The node verdict of `navori_check_impl_json`.
fn node_verdict(bytes: &[u8]) -> Result<String, Failure> {
    let Some(data) = json(&String::from_utf8_lossy(bytes))? else {
        return Ok("parse".to_owned());
    };
    // `k in data` throws on a primitive: node exits 1 and the script reads `parse`.
    let has = |key: &str| match &data {
        JsValue::Object(o) => Some(o.has(key)),
        JsValue::Array(_) => Some(false),
        _ => None,
    };
    let mut missing = Vec::new();
    for key in REQUIRED {
        match has(key) {
            None => return Ok("parse".to_owned()),
            Some(false) => missing.push(key),
            Some(true) => {}
        }
    }
    if !missing.is_empty() {
        return Ok(format!("missing:{}", missing.join(",")));
    }
    let status = member(&data, "status");
    let valid = matches!(status, Some(JsValue::String(s)) if s.is("DONE") || s.is("BLOCKED"));
    Ok(if valid { "ok" } else { "status" }.to_owned())
}

/// The grep fallback of `navori_check_impl_json`.
fn grep_verdict(bytes: &[u8], locale: Locale) -> Result<String, Failure> {
    let mut missing = Vec::new();
    for key in REQUIRED {
        if !grep(bytes, &format!("\"{key}\"[[:space:]]*:"), locale)? {
            missing.push(key);
        }
    }
    if !missing.is_empty() {
        return Ok(format!("missing:{}", missing.join(",")));
    }
    let ok = grep(
        bytes,
        "\"status\"[[:space:]]*:[[:space:]]*\"(DONE|BLOCKED)\"",
        locale,
    )?;
    Ok(if ok { "ok" } else { "status" }.to_owned())
}

/// The scan's state: the problems, their fingerprint and the stderr of failed `cksum` opens.
struct Scan<'a> {
    host: &'a dyn Host,
    context: &'a Context<'a>,
    problems: Vec<String>,
    fingerprint: String,
    stderr: Vec<u8>,
}

impl Scan<'_> {
    fn locale(&self) -> Locale {
        self.context.profile.locale
    }

    fn note(&mut self, file: &str, problem: String) {
        self.problems.push(problem);
        match self.host.open_error(file) {
            None => {
                if let Some(bytes) = self.host.read(file) {
                    self.fingerprint.push_str(&cksum(&bytes));
                }
            }
            Some(error) => self.stderr.extend_from_slice(
                format!(
                    "{}: line {}: {file}: {error}\n",
                    self.context.script, self.context.rendered.lines.cksum
                )
                .as_bytes(),
            ),
        }
        self.fingerprint.push(';');
    }

    fn impl_json(&mut self, file: &str) -> Result<(), Failure> {
        let bytes = self.host.read(file);
        if is_blank(bytes.as_deref(), self.locale())? {
            self.note(file, format!("{file} vacío"));
            return Ok(());
        }
        let bytes = bytes.unwrap_or_default();
        let verdict = if self.host.on_path("node") {
            node_verdict(&bytes)?
        } else {
            grep_verdict(&bytes, self.locale())?
        };
        match verdict.as_str() {
            "ok" => {}
            "status" => self.note(
                file,
                format!("{file} con 'status' inválido (no DONE/BLOCKED)"),
            ),
            other => match other.strip_prefix("missing:") {
                Some(keys) => self.note(file, format!("{file} sin clave '{keys}'")),
                None => self.note(file, format!("{file} no parsea como JSON")),
            },
        }
        Ok(())
    }

    fn impl_md(&mut self, file: &str) -> Result<(), Failure> {
        static STATUS: LazyLock<Option<BytesRegex>> =
            LazyLock::new(|| BytesRegex::new(r"(?i-u)^\*{0,2}status").ok());
        let bytes = self.host.read(file);
        if is_blank(bytes.as_deref(), self.locale())? {
            self.note(file, format!("{file} vacío"));
            return Ok(());
        }
        let re = STATUS
            .as_ref()
            .ok_or_else(|| Failure("status pattern".to_owned()))?;
        let found = bytes
            .unwrap_or_default()
            .split(|b| *b == b'\n')
            .any(|line| re.is_match(line));
        if !found {
            self.note(file, format!("{file} sin línea 'Status:'"));
        }
        Ok(())
    }

    fn review(&mut self, file: &str) -> Result<(), Failure> {
        let bytes = self.host.read(file);
        if is_blank(bytes.as_deref(), self.locale())? {
            self.note(file, format!("{file} vacío"));
            return Ok(());
        }
        let found = bytes
            .unwrap_or_default()
            .split(|b| *b == b'\n')
            .any(|line| {
                line.windows(8).any(|w| w == b"APPROVED")
                    || line.windows(17).any(|w| w == b"CHANGES_REQUESTED")
            });
        if !found {
            self.note(
                file,
                format!("{file} sin veredicto (APPROVED/CHANGES_REQUESTED)"),
            );
        }
        Ok(())
    }
}

/// `{ IFS= read -r x <file; } 2>/dev/null || x=""`: the first line, only when a newline ends it.
fn read_first_line(host: &dyn Host, path: &str) -> Vec<u8> {
    let bytes = host.read(path).unwrap_or_default();
    match bytes.iter().position(|b| *b == b'\n') {
        Some(end) => bytes[..end].iter().copied().filter(|b| *b != 0).collect(),
        None => Vec::new(),
    }
}

/// The partial-handoff lane's `node -e` over the payload.
fn turn_limit(captured: &[u8]) -> Result<bool, Failure> {
    static LIMIT: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
        regex::Regex::new(r"(?-u:\b)stopped at its [0-9]+-turn limit(?-u:\b)").ok()
    });
    let Some(event) = json(&String::from_utf8_lossy(captured))? else {
        return Ok(false);
    };
    let is = |key: &str, text: &str| matches!(member(&event, key), Some(JsValue::String(s)) if s.is(text));
    let background = member(&event, "tool_input")
        .and_then(|t| member(t, "run_in_background"))
        .is_some_and(|v| matches!(v, JsValue::Bool(true)));
    if !is("hook_event_name", "PostToolUse") || !is("tool_name", "Agent") || background {
        return Ok(false);
    }
    let re = LIMIT
        .as_ref()
        .ok_or_else(|| Failure("turn limit pattern".to_owned()))?;
    let Some(JsValue::Array(items)) =
        member(&event, "tool_response").and_then(|r| member(r, "content"))
    else {
        return Ok(false);
    };
    Ok(items.iter().any(|item| {
        matches!(member(item, "type"), Some(JsValue::String(s)) if s.is("text"))
            && matches!(member(item, "text"), Some(JsValue::String(text))
                if re.is_match(&String::from_utf16_lossy(text.units())))
    }))
}

/// The compaction lane's `node -e` over the transcript tail: the last parseable usage total.
fn usage_total(tail: &[u8]) -> Result<String, Failure> {
    let text = String::from_utf8_lossy(tail);
    for line in text.split('\n').rev() {
        let Some(o) = json(line)? else {
            continue;
        };
        let nested = truthy(Some(&o))
            .then(|| member(&o, "message"))
            .flatten()
            .filter(|m| truthy(Some(m)))
            .and_then(|m| member(m, "usage"))
            .filter(|u| truthy(Some(u)));
        let u = match nested {
            Some(u) => Some(u),
            None => truthy(Some(&o)).then(|| member(&o, "usage")).flatten(),
        };
        let Some(u) = u.filter(|u| matches!(u, JsValue::Object(_) | JsValue::Array(_))) else {
            continue;
        };
        let n = |key: &str| match member(u, key) {
            Some(JsValue::Number(v)) => *v,
            _ => 0.0,
        };
        let total =
            n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        return Ok(js_json::number_to_js(total));
    }
    Ok(String::new())
}

/// `[ a -gt b ]` for plain decimal strings of any length.
fn greater(a: &str, b: u64) -> bool {
    let a = a.trim_start_matches('0');
    let b = b.to_string();
    a.len() > b.len() || (a.len() == b.len() && a > b.as_str())
}

/// `navori_emit`: the JSON document and its newline, `None` without node or jq.
fn emit(host: &dyn Host, codex_mode: bool, message: &[u8]) -> Option<Vec<u8>> {
    let message = String::from_utf8_lossy(message);
    let out = if host.on_path("node") {
        let m = JsValue::string(&message).stringify(None)?;
        if codex_mode {
            format!("{{\"systemMessage\":{m}}}")
        } else {
            format!(
                "{{\"systemMessage\":{m},\"hookSpecificOutput\":{{\"hookEventName\":\"PostToolUse\",\"additionalContext\":{m}}}}}"
            )
        }
    } else if host.on_path("jq") {
        let m = jq_string(&message);
        if codex_mode {
            format!("{{\n  \"systemMessage\": {m}\n}}")
        } else {
            format!(
                "{{\n  \"systemMessage\": {m},\n  \"hookSpecificOutput\": {{\n    \"hookEventName\": \"PostToolUse\",\n    \"additionalContext\": {m}\n  }}\n}}"
            )
        }
    } else {
        return None;
    };
    Some(format!("{out}\n").into_bytes())
}

/// The compaction and partial-handoff lanes, as `navori_emit_advice` reads them.
struct Lanes<'a> {
    partial: &'a str,
    compact: &'a str,
    total: &'a str,
    subagent: &'a str,
    mark: &'a str,
    codex_mode: bool,
}

/// What the script prints, and its writes.
struct Output<'a> {
    host: &'a dyn Host,
    script: &'a str,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Output<'_> {
    /// `printf … >path 2>/dev/null || true`: the redirection fails before `2>` applies.
    fn write(&mut self, path: &str, content: &[u8], line: usize) {
        if let Some(error) = self.host.write(path, content) {
            self.stderr.extend_from_slice(
                format!("{}: line {line}: {path}: {error}\n", self.script).as_bytes(),
            );
        }
    }

    /// `navori_emit_advice`: the verdict it sets, `None` when nothing was emitted.
    fn advise(&mut self, lanes: &Lanes<'_>, mark_line: usize) -> Option<AuditLabel> {
        let mut advice = lanes.partial.to_owned();
        if !lanes.compact.is_empty() {
            if !advice.is_empty() {
                advice.push(' ');
            }
            advice.push_str(lanes.compact);
        }
        if advice.is_empty() {
            return None;
        }
        let json = emit(self.host, lanes.codex_mode, advice.as_bytes())?;
        self.stdout.extend_from_slice(&json);
        if !lanes.compact.is_empty() {
            self.write(lanes.mark, b"1\n", mark_line);
            return Some(AuditLabel {
                verdict: "compact-advice",
                reason: lanes.total.to_owned(),
            });
        }
        Some(AuditLabel {
            verdict: "partial",
            reason: lanes.subagent.to_owned(),
        })
    }
}

/// Evaluate one payload.
///
/// # Errors
/// An extraction the cascade does not model, or text whose handling by `grep`, `node` or
/// `cksum` the port does not reproduce.
#[allow(
    clippy::too_many_lines,
    reason = "a literal port of the script's single flow"
)]
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    host: &dyn Host,
) -> Result<Evaluation, Failure> {
    let captured = payload::capture(payload);
    let fields = payload::extract(&captured, &FIELDS, context.profile)?;
    let field = |i: usize| fields.values.get(i).cloned().unwrap_or_default();
    let mut stderr = capture::prepend(
        context.capture,
        payload.contains(&0),
        fields.nul_substitutions,
        Vec::new(),
    );
    let engine = context.engine();

    // hook-input's project dir, then `navori_capture_child`.
    let cwd = field(CWD);
    let project_dir = if engine == "claude" {
        context.claude_project_dir.clone()
    } else {
        let dir = if cwd.is_empty() { "." } else { cwd.as_str() };
        host.toplevel(dir).unwrap_or_else(|| dir.to_owned())
    };
    if engine == "codex" {
        let source = match field(EVENT).as_str() {
            "SubagentStart" => Some(field(TRANSCRIPT)),
            "SubagentStop" => Some(field(AGENT_TRANSCRIPT)),
            _ => None,
        };
        let (root, child) = (field(SESSION_ID), field(AGENT_ID));
        if let Some(source) = source.filter(|s| !s.is_empty())
            && id_ok(&root, b"")
            && id_ok(&child, b"")
            && let Some(audits) = &context.audits_root
            && let Some(repo) = navori_core::audit::repo_from_cwd(&project_dir)
        {
            let log = format!("{audits}/{repo}/session-{root}.log");
            if host.is_file(&log) && !host.is_symlink(&log) && host.on_path("navori") {
                let at = if cwd.is_empty() {
                    if project_dir.is_empty() {
                        ".".to_owned()
                    } else {
                        project_dir.clone()
                    }
                } else {
                    cwd.clone()
                };
                host.capture_child(&child, &root, &source, &at);
            }
        }
    }

    let session = field(SESSION_ID);
    let key = if id_ok(&session, b"") {
        session
    } else {
        "anon".to_owned()
    };
    let repo = context.pwd.rsplit('/').next().unwrap_or_default();
    let repo = if id_ok(repo, b".") { repo } else { "repo" };
    let stamp = format!("{}/navori-handoff-{repo}-{key}", context.tmpdir);
    let mark = format!("{}/navori-compact-{repo}-{key}", context.tmpdir);

    let subagent = if engine == "codex" {
        let t = field(INPUT_AGENT_TYPE);
        if t.is_empty() { field(AGENT_TYPE) } else { t }
    } else {
        field(SUBAGENT_TYPE)
    };
    let codex_mode = context.mode == "codex";
    let main_thread = !codex_mode && engine != "codex" && field(AGENT_ID).is_empty();

    let mut partial = String::new();
    if main_thread
        && captured.windows(15).any(|w| w == b"stopped at its ")
        && host.on_path("node")
        && turn_limit(&captured)?
    {
        let who = if subagent.is_empty() {
            "subagente"
        } else {
            subagent.as_str()
        };
        partial = format!(
            "navori: handoff PARCIAL de {who} — alcanzó su límite de turnos. Continúa con SendMessage para conservar su estado; usa un redespacho fresco solo si el trabajo restante está acotado."
        );
    }

    let threshold = context.rendered.threshold;
    let mut compact = String::new();
    let mut total = String::new();
    if main_thread
        && threshold > 0
        && subagent == "publisher"
        && read_first_line(host, &mark).is_empty()
        && host.on_path("node")
    {
        let transcript = field(TRANSCRIPT);
        if !transcript.is_empty() {
            total = usage_total(&host.tail(&transcript, TAIL).unwrap_or_default())?;
        }
        if !total.is_empty()
            && total.bytes().all(|b| b.is_ascii_digit())
            && greater(&total, threshold)
        {
            compact = format!(
                "navori: el contexto del hilo principal va en {total} tokens (umbral {threshold}). Guarda el resumen de la sesión y usa /compact o /clear antes del siguiente ciclo."
            );
        }
    }

    let mut scan = Scan {
        host,
        context,
        problems: Vec::new(),
        fingerprint: String::new(),
        stderr: Vec::new(),
    };
    for dir in [
        ".navori/state/handoffs",
        ".claude/progress",
        ".codex/progress",
        "progress",
    ] {
        if !host.is_dir(dir) {
            continue;
        }
        if subagent != "scribe" {
            for file in host.recent(dir, "impl_", ".json")? {
                scan.impl_json(&file)?;
            }
        }
        if subagent != "implementer" {
            for file in host.recent(dir, "impl_", ".md")? {
                scan.impl_md(&file)?;
            }
        }
        for file in host.recent(dir, "review_", ".md")? {
            scan.review(&file)?;
        }
    }
    stderr.extend_from_slice(&scan.stderr);
    let problems = scan.problems.join("; ");

    let mut out = Output {
        host,
        script: &context.script,
        stdout: Vec::new(),
        stderr,
    };
    let lines = context.rendered.lines;
    let lanes = Lanes {
        partial: &partial,
        compact: &compact,
        total: &total,
        subagent: &subagent,
        mark: &mark,
        codex_mode,
    };
    let label = |verdict: &'static str, reason: &str| AuditLabel {
        verdict,
        reason: reason.to_owned(),
    };
    let audit = if problems.is_empty() {
        out.write(&stamp, b"", lines.truncate);
        out.advise(&lanes, lines.mark_advice)
            .unwrap_or_else(|| label("clean", ""))
    } else {
        let signature = format!("{problems}|{}", scan.fingerprint);
        if read_first_line(host, &stamp) == signature.as_bytes() {
            out.advise(&lanes, lines.mark_advice)
                .unwrap_or_else(|| label("repeat", &problems))
        } else {
            let mut message = format!(
                "navori: handoff(s) de subagente incompletos — {problems}. Revisa que el reporte quedó bien escrito antes de consolidarlo."
            );
            for extra in [&partial, &compact] {
                if !extra.is_empty() {
                    message.push(' ');
                    message.push_str(extra);
                }
            }
            if let Some(json) = emit(host, codex_mode, message.as_bytes()) {
                out.stdout.extend_from_slice(&json);
                out.write(&stamp, format!("{signature}\n").as_bytes(), lines.stamp);
                if !compact.is_empty() {
                    out.write(&mark, b"1\n", lines.mark_dirty);
                }
            }
            label("dirty", &problems)
        }
    };
    let Output { stdout, stderr, .. } = out;
    Ok(Evaluation {
        verdict: Verdict::Permit,
        stdout,
        stderr,
        audit: Some(audit),
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    use super::{cksum, greater};

    // Covers: R50
    #[test]
    fn cksum_matches_the_system_binary() {
        let inputs: [&[u8]; 5] = [
            b"",
            b"a",
            b"{\"feature\":\"f\"}",
            &[0u8; 300],
            &[0xffu8; 70_000],
        ];
        for input in inputs {
            let child = Command::new("cksum")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn();
            let Ok(mut child) = child else {
                return; // no cksum on this host: nothing to compare against
            };
            if let Some(mut stdin) = child.stdin.take() {
                assert!(stdin.write_all(input).is_ok());
            }
            let out = child
                .wait_with_output()
                .map(|o| o.stdout)
                .unwrap_or_default();
            let expected = String::from_utf8_lossy(&out).trim_end().replace(' ', "-");
            assert_eq!(cksum(input), expected, "{} bytes", input.len());
        }
    }

    // Covers: R50
    #[test]
    fn decimal_comparison_has_no_width_limit() {
        assert!(greater("1001", 1000));
        assert!(!greater("0001000", 1000));
        assert!(greater("99999999999999999999999", 1000));
        assert!(!greater("999", 1000));
    }
}
