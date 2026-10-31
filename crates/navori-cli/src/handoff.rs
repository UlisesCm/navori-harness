//! `navori handoff check|render|log-review <feature>`, native (spec 0060 T10, R73/R74).
//!
//! The command layer of `commands/handoff.ts` over `navori_core::handoff`. Everything is read and
//! decided before the first byte of output or the first write, so whatever Rust does not
//! reproduce returns `None` and the invocation goes to the TS: an argv citty might read
//! differently, a config `readConfig` rejects, a JSON `JSON.parse` or zod would reject (their
//! messages are V8's and zod's), a file that is not UTF-8, the consumers that need the review
//! evidence (`--for publisher`, `--produced-by`, `--parallel`), a state root the TS would throw on
//! outside a caught path, and a possible audit event (`log-review` with an audit session).
//! The parallel producers (`prepare-parallel`, `begin-parallel`, `complete-parallel`,
//! `finalize-parallel`) and `attest` are not in the manifest: they always delegate.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

use navori_core::config::Config;
use navori_core::fs::{Fs, RealFs};
use navori_core::handoff::implementation::{self, ImplHandoff};
use navori_core::handoff::review::{self, FINDINGS_LOG_NAME};
use navori_core::js_json::{self, JsValue};
use navori_core::posix::js_trim;
use navori_core::state_files::{self, Refusal, StateRoot};
use sha2::{Digest as _, Sha256};

use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::{Output, json_line, member, number, object, read_config, string};
use crate::{NativeCall, Outcome};

const FEATURE: ArgDef = ArgDef {
    name: "feature",
    kind: ArgKind::Positional,
    description: "Feature slug",
};
const JSON: ArgDef = ArgDef {
    name: "json",
    kind: ArgKind::Boolean,
    description: "Output as JSON",
};

const CHECK: CommandDef = CommandDef {
    name: "check",
    description: "Validate impl_<feature>.json (or .md under scribeOwnsMarkdown:false) before dispatch",
    args: &[
        FEATURE,
        ArgDef {
            name: "for",
            kind: ArgKind::String,
            description: "Consumer running the check: orchestrator (default), scribe or publisher",
        },
        ArgDef {
            name: "produced-by",
            kind: ArgKind::String,
            description: "Validate the handoff a role produced instead of one a consumer needs: reviewer (review_<feature>.md/.json + sealed evidence)",
        },
        ArgDef {
            name: "since",
            kind: ArgKind::String,
            description: "With --produced-by reviewer: ISO UTC time the review must have begun at or after",
        },
        ArgDef {
            name: "target",
            kind: ArgKind::String,
            description: "Current review target branch",
        },
        ArgDef {
            name: "dir",
            kind: ArgKind::String,
            description: "Progress directory",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Checkout to validate (scribe: the one it will edit)",
        },
        JSON,
        ArgDef {
            name: "parallel",
            kind: ArgKind::Boolean,
            description: "Validate prior parallel authority for the scribe",
        },
    ],
    sub_commands: &[],
};

const LOG_REVIEW: CommandDef = CommandDef {
    name: "log-review",
    description: "Validate review_<feature>.json and append findings with score >= 50 to findings.jsonl (deduped)",
    args: &[
        FEATURE,
        ArgDef {
            name: "dir",
            kind: ArgKind::String,
            description: "Progress directory",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Checkout to operate on",
        },
        JSON,
    ],
    sub_commands: &[],
};

const RENDER: CommandDef = CommandDef {
    name: "render",
    description: "Render impl_<feature>.md from impl_<feature>.json (only with harness.scribeOwnsMarkdown: true)",
    args: &[
        FEATURE,
        ArgDef {
            name: "dir",
            kind: ArgKind::String,
            description: "State directory",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Checkout to operate on",
        },
        JSON,
    ],
    sub_commands: &[],
};

const HANDOFF: CommandDef = CommandDef {
    name: "handoff",
    description: "Validate the implementer's handoff before dispatch",
    args: &[],
    sub_commands: &[
        (
            "prepare-parallel",
            "Bind immutable approved level-3 parallel scope",
        ),
        (
            "begin-parallel",
            "Start the native producer's immutable parallel work interval",
        ),
        (
            "complete-parallel",
            "Seal the native producer's own parallel paths",
        ),
        (
            "finalize-parallel",
            "Join both producers after serial render and shared checks",
        ),
        (
            "attest",
            "Attest delivery ownership from the native producer context",
        ),
        ("check", CHECK.description),
        ("log-review", LOG_REVIEW.description),
        ("render", RENDER.description),
    ],
};

/// Names `name in subCommands` finds on `Object.prototype`: citty would run them as commands.
const PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

const ROOT: Parent<'static> = Parent {
    name: "navori",
    version: Some(navori_core::VERSION),
};

const HANDOFF_PARENT: Parent<'static> = Parent {
    name: "handoff",
    version: None,
};

/// Which manifest entry selected the invocation: each row runs only its own subcommand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    Check,
    Render,
    LogReview,
}

/// `handoff` alone: usage, `--help` and unknown subcommands.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Group))
}

/// `handoff check`.
#[must_use]
pub fn run_check(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Check))
}

/// `handoff render`.
#[must_use]
pub fn run_render(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Render))
}

/// `handoff log-review`.
#[must_use]
pub fn run_log_review(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::LogReview))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "handoff" || rest.contains(&"--") {
        return None;
    }
    let is_help = |a: &&str| *a == "--help" || *a == "-h";
    let help = rest.iter().any(is_help);
    let at = rest.iter().position(|a| !a.starts_with('-'));
    if rest[..at.unwrap_or(rest.len())].iter().any(|a| !is_help(a)) {
        return None;
    }
    let Some(at) = at else {
        if row != Row::Group {
            return None;
        }
        let error = (!help).then(|| "No command specified.".to_owned());
        return Some(Output::usage(&HANDOFF, ROOT, error).emit());
    };
    let (leaf, leaf_row) = match rest[at] {
        "check" => (&CHECK, Row::Check),
        "render" => (&RENDER, Row::Render),
        "log-review" => (&LOG_REVIEW, Row::LogReview),
        name if row != Row::Group
            || PROTOTYPE_KEYS.contains(&name)
            || HANDOFF.sub_commands.iter().any(|(sub, _)| *sub == name) =>
        {
            return None;
        }
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&HANDOFF, ROOT, error).emit());
        }
    };
    if leaf_row != row {
        return None;
    }
    if help {
        return Some(Output::usage(leaf, HANDOFF_PARENT, None).emit());
    }
    let strings: &[&str] = match row {
        Row::Check => &["for", "target", "dir", "cwd"],
        _ => &["dir", "cwd"],
    };
    let options = parse_leaf(&rest[at + 1..], strings)?;
    let Some(feature) = options.feature else {
        let error = "Missing required positional argument: FEATURE".to_owned();
        return Some(Output::usage(leaf, HANDOFF_PARENT, Some(error)).emit());
    };
    let process_cwd = std::env::current_dir().ok()?;
    let process_cwd = process_cwd.to_str()?;
    let out = match row {
        Row::Check => check(feature, &options, process_cwd)?,
        Row::Render => render(feature, &options, process_cwd)?,
        Row::LogReview => log_review(feature, &options, process_cwd)?,
        Row::Group => return None,
    };
    Some(out.emit())
}

/// The args of a leaf as citty would read them.
#[derive(Debug, Default, PartialEq, Eq)]
struct LeafOptions<'a> {
    feature: Option<&'a str>,
    strings: Vec<(&'static str, &'a str)>,
    json: bool,
}

impl<'a> LeafOptions<'a> {
    fn get(&self, name: &str) -> Option<&'a str> {
        self.strings
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| *value)
    }
}

/// `None` for any shape whose citty reading is not certain: unknown or short options, `--no-*`,
/// `--json=<v>`, a repeated string option, or a value that is empty or looks like an option.
fn parse_leaf<'a>(tokens: &[&'a str], names: &[&'static str]) -> Option<LeafOptions<'a>> {
    let mut options = LeafOptions::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token == "--json" {
            options.json = true;
            continue;
        }
        let Some(body) = token.strip_prefix("--") else {
            if token.starts_with('-') {
                return None;
            }
            if options.feature.is_none() {
                options.feature = Some(token);
            }
            continue;
        };
        let (name, inline) = body
            .split_once('=')
            .map_or((body, None), |(n, v)| (n, Some(v)));
        let name = *names.iter().find(|known| **known == name)?;
        if options.get(name).is_some() {
            return None;
        }
        let value = if let Some(inline) = inline {
            inline
        } else {
            let next = *tokens.get(index)?;
            index += 1;
            next
        };
        if value.is_empty() || value.starts_with('-') {
            return None;
        }
        options.strings.push((name, value));
    }
    Some(options)
}

/// `git <args>` in `cwd` as `spawnSync` runs it: the trimmed stdout, or `None` when git fails.
/// `Err` when its output is not UTF-8.
fn git(cwd: &str, args: &[&str]) -> Result<Option<String>, ()> {
    let Ok(output) = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ())?;
    Ok(Some(js_trim(&text).to_owned()))
}

fn realpath(path: &str) -> Option<Option<String>> {
    match std::fs::canonicalize(path) {
        Ok(real) => real.to_str().map(|s| Some(s.to_owned())),
        Err(_) => Some(None),
    }
}

fn print_warnings(out: &mut Output, config: &Config) {
    for warning in &config.warnings {
        out.stderr.push_str(warning);
        out.stderr.push('\n');
    }
}

/// `readConfig(...).harness?.scribeOwnsMarkdown ?? false`.
fn scribe_owns_markdown(config: &Config) -> bool {
    matches!(
        member(member(Some(&config.data), "harness"), "scribeOwnsMarkdown"),
        Some(JsValue::Bool(true))
    )
}

/// Reads a state artifact as text: `Ok(None)` when absent, `None` when Rust cannot reproduce the
/// read (an error the TS would throw, or bytes that are not UTF-8).
fn read_artifact(path: &str) -> Option<Option<String>> {
    if std::fs::metadata(path).is_err() {
        return Some(None);
    }
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok().map(Some)
}

// ---------------------------------------------------------------------------------------------
// check

/// `HandoffCheckResult`.
struct CheckResult {
    consumer: &'static str,
    status: &'static str,
    failures: Vec<(&'static str, String)>,
    warnings: Vec<(&'static str, String)>,
    worktree: Option<String>,
    branch: Option<String>,
}

impl CheckResult {
    fn new(consumer: &'static str) -> Self {
        Self {
            consumer,
            status: "ok",
            failures: Vec::new(),
            warnings: Vec::new(),
            worktree: None,
            branch: None,
        }
    }

    fn settle(mut self) -> Self {
        self.status = if self.failures.is_empty() {
            "ok"
        } else {
            "findings"
        };
        self
    }

    /// The `catch` of `checkHandoffBase`.
    fn error(consumer: &'static str, detail: String) -> Self {
        let mut result = Self::new(consumer);
        result.status = "error";
        result.failures.push(("exists", detail));
        result
    }

    fn to_json(&self, feature: &str) -> JsValue {
        let entries = |list: &[(&str, String)]| {
            JsValue::Array(
                list.iter()
                    .map(|(check, detail)| {
                        object(vec![("check", string(check)), ("detail", string(detail))])
                    })
                    .collect(),
            )
        };
        let nullable = |v: &Option<String>| v.as_deref().map_or(JsValue::Null, string);
        object(vec![
            ("formatVersion", number(1)),
            ("feature", string(feature)),
            ("consumer", string(self.consumer)),
            ("status", string(self.status)),
            ("failures", entries(&self.failures)),
            ("warnings", entries(&self.warnings)),
            ("worktree", nullable(&self.worktree)),
            ("branch", nullable(&self.branch)),
        ])
    }

    /// `formatResult`.
    fn text(&self) -> String {
        if self.status == "ok" && self.warnings.is_empty() {
            return "OK".to_owned();
        }
        let lines: Vec<String> = self
            .failures
            .iter()
            .map(|(check, detail)| format!("FAIL[{check}]: {detail}"))
            .chain(
                self.warnings
                    .iter()
                    .map(|(check, detail)| format!("WARN[{check}]: {detail}")),
            )
            .collect();
        if lines.is_empty() {
            "OK".to_owned()
        } else {
            lines.join("\n")
        }
    }

    const fn exit_code(&self) -> u8 {
        match self.status.as_bytes() {
            b"ok" => 0,
            b"error" => 1,
            _ => 2,
        }
    }
}

/// An artifact path for `checkHandoffBase`: its message is a caught `error` result.
fn check_artifact(
    root: &StateRoot,
    name: &str,
    consumer: &'static str,
) -> Option<Result<String, CheckResult>> {
    match state_files::artifact_path(root, name) {
        Ok(path) => Some(Ok(path)),
        Err(Refusal::Message(detail)) => Some(Err(CheckResult::error(consumer, detail))),
        Err(Refusal::Unmodeled) => None,
    }
}

/// `checkLegacyMarkdown`.
fn check_legacy(root: &StateRoot, feature: &str, consumer: &'static str) -> Option<CheckResult> {
    let path = match check_artifact(root, &format!("impl_{feature}.md"), consumer)? {
        Ok(path) => path,
        Err(error) => return Some(error),
    };
    let mut result = CheckResult::new(consumer);
    result.warnings.push((
        "legacy-md",
        "harness.scribeOwnsMarkdown is off; checked impl_<feature>.md instead of the JSON handoff"
            .to_owned(),
    ));
    match read_artifact(&path)? {
        None => result
            .failures
            .push(("exists", format!("{path} not found"))),
        Some(content) if js_trim(&content).is_empty() => {
            result.failures.push(("exists", format!("{path} is empty")));
        }
        Some(content) if !implementation::has_status_line(&content)? => {
            result
                .failures
                .push(("parse", format!("{path} has no \"Status:\" line")));
        }
        Some(_) => {}
    }
    Some(result.settle())
}

/// The scribe's identity check (R16) over a handoff whose feature matched.
fn check_scribe(
    result: &mut CheckResult,
    data: &ImplHandoff,
    cwd: &str,
    process_cwd: &str,
) -> Option<()> {
    let toplevel = git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let real_toplevel = match &toplevel {
        Some(top) => realpath(top)?,
        None => None,
    };
    let real_worktree = realpath(&data.worktree)?;
    if real_toplevel.is_none() || real_worktree.is_none() || real_toplevel != real_worktree {
        let shown = real_toplevel
            .clone()
            .or_else(|| toplevel.clone())
            .unwrap_or_else(|| "(unknown)".to_owned());
        result.failures.push((
            "worktree",
            format!(
                "--cwd resolves to {shown}, registered worktree is {}",
                data.worktree
            ),
        ));
    }
    let branch = git(cwd, &["branch", "--show-current"]).ok()?;
    if branch.as_deref() != Some(data.branch.as_str()) {
        result.failures.push((
            "branch",
            format!(
                "--cwd is on branch \"{}\", registered branch is \"{}\"",
                branch.as_deref().unwrap_or("(unknown)"),
                data.branch
            ),
        ));
    }
    let worktree = real_worktree.as_deref().unwrap_or(&data.worktree);
    for request in &data.markdown_requests {
        if let Some(detail) =
            implementation::validate_request_path(worktree, &request.path, process_cwd)?
        {
            result.failures.push(("path", detail));
        }
    }
    Some(())
}

/// `checkHandoffBase` for the orchestrator and the scribe.
fn check_base(
    root: &StateRoot,
    feature: &str,
    consumer: &'static str,
    legacy: bool,
    process_cwd: &str,
) -> Option<CheckResult> {
    if legacy {
        return check_legacy(root, feature, consumer);
    }
    let path = match check_artifact(root, &format!("impl_{feature}.json"), consumer)? {
        Ok(path) => path,
        Err(error) => return Some(error),
    };
    let mut result = CheckResult::new(consumer);
    let Some(raw) = read_artifact(&path)? else {
        result
            .failures
            .push(("exists", format!("{path} not found")));
        return Some(result.settle());
    };
    // A JSON or zod failure prints V8's or zod's text: the TS's.
    let data = implementation::parse(&js_json::parse(&raw)?)?;
    if data.feature != feature {
        result.failures.push((
            "feature",
            format!(
                "{path} belongs to feature \"{}\", not \"{feature}\"",
                data.feature
            ),
        ));
    }
    result.worktree = Some(realpath(&data.worktree)?.unwrap_or_else(|| data.worktree.clone()));
    result.branch = Some(data.branch.clone());
    match &data.head {
        None => result.warnings.push((
            "head",
            "impl_<feature>.json has no `head`; the checkout may have moved since the handoff"
                .to_owned(),
        )),
        Some(head) => {
            if let Some(actual) = git(&root.cwd, &["rev-parse", "HEAD"]).ok()?
                && actual != *head
            {
                result.warnings.push((
                    "head",
                    format!(
                        "the checkout has moved since the handoff (handoff head {head}, checkout head {actual})"
                    ),
                ));
            }
        }
    }
    if consumer == "scribe" && result.failures.is_empty() {
        check_scribe(&mut result, &data, &root.cwd, process_cwd)?;
    }
    Some(result.settle())
}

/// `handoff check` for the orchestrator and the scribe.
fn check(feature: &str, options: &LeafOptions<'_>, process_cwd: &str) -> Option<Output> {
    let consumer = match options.get("for") {
        Some("scribe") => "scribe",
        // The publisher consumes the review evidence (`reviewEvidenceWarning`).
        Some("publisher") => return None,
        _ => "orchestrator",
    };
    let cwd = options.get("cwd").unwrap_or(process_cwd);
    // An uncaught throw in the TS: its stack trace is the TS's.
    let root =
        state_files::resolve_state_root(cwd, process_cwd, feature, options.get("dir")).ok()?;
    // `readConfig` twice: for `scribeOwnsMarkdown` (a failure is caught) and in
    // `resolveReceiptOptions` (a failure throws). Only a config both accept stays native.
    let config = read_config(&root.cwd)??;
    let mut out = Output::default();
    print_warnings(&mut out, &config);
    print_warnings(&mut out, &config);
    let legacy = !scribe_owns_markdown(&config);
    let result = check_base(&root, feature, consumer, legacy, process_cwd)?;
    if options.json {
        json_line(&mut out, &result.to_json(feature));
    } else {
        out.stdout.push_str(&result.text());
        out.stdout.push('\n');
    }
    out.code = result.exit_code();
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// render

/// A state root for the commands that catch its errors: `Err(message)` is what they report.
fn caught_root(
    feature: &str,
    options: &LeafOptions<'_>,
    process_cwd: &str,
) -> Option<Result<StateRoot, String>> {
    let cwd = options.get("cwd").unwrap_or(process_cwd);
    match state_files::resolve_state_root(cwd, process_cwd, feature, options.get("dir")) {
        Ok(root) => Some(Ok(root)),
        Err(Refusal::Message(message)) => Some(Err(message)),
        Err(Refusal::Unmodeled) => None,
    }
}

fn caught_artifact(root: &StateRoot, name: &str) -> Option<Result<String, String>> {
    match state_files::artifact_path(root, name) {
        Ok(path) => Some(Ok(path)),
        Err(Refusal::Message(message)) => Some(Err(message)),
        Err(Refusal::Unmodeled) => None,
    }
}

/// `renderHandoff`: `Ok(path)` written, `Err(message)` refused.
fn render_handoff(
    out: &mut Output,
    feature: &str,
    options: &LeafOptions<'_>,
    process_cwd: &str,
) -> Option<Result<String, String>> {
    let root = match caught_root(feature, options, process_cwd)? {
        Ok(root) => root,
        Err(message) => return Some(Err(message)),
    };
    // A missing or unreadable config reads as `false`; one Rust does not model is the TS's.
    let owns = match read_config(&root.cwd)? {
        Some(config) => {
            print_warnings(out, &config);
            scribe_owns_markdown(&config)
        }
        None => false,
    };
    if !owns {
        return Some(Err(
            "harness.scribeOwnsMarkdown is not true: the implementer writes impl_<feature>.md itself in this mode, so `handoff render` will not overwrite it. FIX: set the flag in navori.config.json, or skip this step.".to_owned(),
        ));
    }
    let json_file = match caught_artifact(&root, &format!("impl_{feature}.json"))? {
        Ok(path) => path,
        Err(message) => return Some(Err(message)),
    };
    let Some(raw) = read_artifact(&json_file)? else {
        return Some(Err(format!(
            "impl_{feature}.json not found in {}",
            root.dir
        )));
    };
    let data = implementation::parse(&js_json::parse(&raw)?)?;
    if data.feature != feature {
        return Some(Err(format!(
            "impl_{feature}.json belongs to feature \"{}\", not \"{feature}\"",
            data.feature
        )));
    }
    let content = implementation::render(&data)?;
    let name = format!("impl_{feature}.md");
    let write = match state_files::plan_state_write(&root, &name, std::process::id()).ok()? {
        Ok(write) => write,
        Err(message) => return Some(Err(message)),
    };
    let mut fs = RealFs::default();
    if let Err(message) = state_files::write_state_file(&mut fs, &write, &content) {
        return Some(Err(message));
    }
    Some(Ok(write.destination().to_owned()))
}

/// `handoff render`.
fn render(feature: &str, options: &LeafOptions<'_>, process_cwd: &str) -> Option<Output> {
    let mut out = Output::default();
    let result = render_handoff(&mut out, feature, options, process_cwd)?;
    let (value, text) = match &result {
        Ok(path) => (
            object(vec![("status", string("ok")), ("path", string(path))]),
            format!("OK: {path}"),
        ),
        Err(message) => (
            object(vec![
                ("status", string("error")),
                ("message", string(message)),
            ]),
            format!("FAIL: {message}"),
        ),
    };
    if options.json {
        json_line(&mut out, &value);
    } else {
        out.stdout.push_str(&text);
        out.stdout.push('\n');
    }
    out.code = u8::from(result.is_err());
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// log-review

/// `LogReviewResult`.
enum LogResult {
    Appended {
        hash: String,
        appended: usize,
    },
    Duplicate {
        hash: String,
    },
    Error(String),
    /// A write failed after every check: the TS throws uncaught, so only stderr reports it.
    Crash(String),
}

fn reject(error: &str, why: &str, fix: &str) -> LogResult {
    LogResult::Error(format!("ERROR: {error}\nWHY: {why}\nFIX: {fix}"))
}

/// `logReview`, with every write planned before the first one.
fn log_review_result(
    feature: &str,
    options: &LeafOptions<'_>,
    process_cwd: &str,
    fs: &mut dyn Fs,
) -> Option<LogResult> {
    let name = format!("review_{feature}.json");
    let unsafe_path = |message: &str| {
        reject(
            message,
            "the feature slug or state directory is not a safe path inside this checkout",
            "use a lowercase feature slug and a --dir inside the checkout",
        )
    };
    let root = match caught_root(feature, options, process_cwd)? {
        Ok(root) => root,
        Err(message) => return Some(unsafe_path(&message)),
    };
    let sidecar_path = match caught_artifact(&root, &name)? {
        Ok(path) => path,
        Err(message) => return Some(unsafe_path(&message)),
    };
    let Some(raw) = read_artifact(&sidecar_path)? else {
        return Some(reject(
            &format!("{name} not found in {}", root.dir),
            "the reviewer must write the sidecar before logging it",
            &format!("write {name} next to review_{feature}.md and re-run"),
        ));
    };
    let sidecar = review::parse_sidecar(&js_json::parse(&raw)?)?;
    if sidecar.feature != feature {
        return Some(reject(
            &format!(
                "{name} declares feature \"{}\", expected \"{feature}\"",
                sidecar.feature
            ),
            "a mismatched sidecar would log findings under the wrong feature",
            "set the sidecar's feature to the slug passed on the command line",
        ));
    }
    let hash: String = Sha256::digest(raw.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // `ensureStateDirectory` and `stateArtifactPath` throw uncaught here: those are the TS's.
    if !state_files::plan_state_dirs(&root).ok()?.is_empty() {
        return None;
    }
    let log_path = state_files::artifact_path(&root, FINDINGS_LOG_NAME).ok()?;
    let existing = match std::fs::symlink_metadata(&log_path) {
        Ok(meta) if meta.is_file() => read_artifact(&log_path)??,
        Ok(_) => return None,
        Err(_) => String::new(),
    };
    if existing.contains(&format!("\"sidecarHash\":\"{hash}\"")) {
        return Some(LogResult::Duplicate { hash });
    }
    let at = review::iso_now();
    let lines = review::findings_lines(&sidecar, &hash, &at)?;
    if !lines.is_empty() {
        let prefix = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let text = format!("{prefix}{}\n", lines.join("\n"));
        if let Err(error) = fs.append(Path::new(&log_path), text.as_bytes()) {
            return Some(LogResult::Crash(format!(
                "navori-rust: cannot append {log_path}: {error}"
            )));
        }
    }
    Some(LogResult::Appended {
        hash,
        appended: lines.len(),
    })
}

/// `handoff log-review`.
fn log_review(feature: &str, options: &LeafOptions<'_>, process_cwd: &str) -> Option<Output> {
    // `emitReviewOutcome` writes an audit event when a session is in the environment (T18).
    if crate::master_write::audit_may_write() {
        return None;
    }
    let mut fs = RealFs::default();
    let result = log_review_result(feature, options, process_cwd, &mut fs)?;
    if let LogResult::Crash(message) = &result {
        return Some(Output {
            stderr: format!("{message}\n"),
            code: 1,
            ..Output::default()
        });
    }
    let (value, text) = match &result {
        LogResult::Appended { hash, appended } => (
            object(vec![
                ("status", string("appended")),
                ("hash", string(hash)),
                ("appended", number(*appended)),
            ]),
            format!("OK: {appended} finding(s) appended"),
        ),
        LogResult::Duplicate { hash } => (
            object(vec![
                ("status", string("duplicate")),
                ("hash", string(hash)),
                ("appended", number(0)),
            ]),
            "DUPLICATE: 0 finding(s) appended".to_owned(),
        ),
        LogResult::Error(message) | LogResult::Crash(message) => (
            object(vec![
                ("status", string("error")),
                ("message", string(message)),
            ]),
            message.clone(),
        ),
    };
    let mut out = Output::default();
    if options.json {
        json_line(&mut out, &value);
    } else {
        out.stdout.push_str(&text);
        out.stdout.push('\n');
    }
    out.code = u8::from(matches!(result, LogResult::Error(_) | LogResult::Crash(_)));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn leaf_args_delegate_every_uncertain_shape() {
        let names = &["for", "dir", "cwd"];
        let ok = parse_leaf(&["x", "--json", "--for", "scribe", "--cwd=d", "y"], names);
        assert_eq!(
            ok,
            Some(LeafOptions {
                feature: Some("x"),
                strings: vec![("for", "scribe"), ("cwd", "d")],
                json: true,
            })
        );
        for argv in [
            &["x", "--no-json"][..],
            &["x", "--json=false"],
            &["x", "--cwd"],
            &["x", "--cwd="],
            &["x", "--cwd", "--json"],
            &["x", "--cwd", "a", "--cwd", "b"],
            &["x", "-j"],
            &["x", "--target", "main"],
        ] {
            assert_eq!(parse_leaf(argv, names), None, "{argv:?}");
        }
    }
}
