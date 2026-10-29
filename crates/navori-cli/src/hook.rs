//! Internal native hook entry point (spec 0057 D6-D8 / R12-R13).
//!
//! The production registry stays empty until a hook is ported. Selection, path validation and
//! exact-byte integrity all run before reading stdin, so a shell fallback receives the payload.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::sync::LazyLock;

use navori_core::audit::{self, AuditContext, AuditSnapshot, HookLabels, HookPayload, Host};
use navori_core::integrity;
use navori_core::manifest::{HookMode, Manifest};
use navori_hooks::runner::{self, AuditLabel, Context, Engine, Evaluation, Failure, Verdict};

use crate::journal::{self, CliJournal, ShadowJournal};
use crate::{hook_facts, quality_gate, shadow};

/// Read-only facts captured before stdin for handlers that select a profile from the host.
#[derive(Debug, Clone, Copy)]
pub struct Snapshot<'a> {
    /// Script bytes that already passed the integrity check.
    pub source: &'a [u8],
    /// Complete environment of this invocation, unchanged.
    pub env: &'a [(OsString, OsString)],
    /// Working directory of this invocation.
    pub cwd: &'a Path,
}

/// What a prepared evaluation may ask of the runtime while it decides.
pub trait Recorder {
    /// Whether this is the native lane of a shadow call: a branch with effects must answer
    /// [`navori_hooks::runner::unobserved`] instead of running (spec 0059 D40).
    fn shadow(&self) -> bool;
    /// Record one audit event now, ahead of the decision's own (`gate-started`).
    fn record(&self, label: &AuditLabel);
}

/// Buffered payload evaluation produced by a successful preparation.
pub type Evaluator<'a> = Box<dyn Fn(&[u8], &dyn Recorder) -> Result<Evaluation, Failure> + 'a>;

/// The native lane of a shadow call: no effects, nothing recorded.
struct ShadowLane;

impl Recorder for ShadowLane {
    fn shadow(&self) -> bool {
        true
    }

    fn record(&self, _: &AuditLabel) {}
}

/// How a compiled hook turns payload bytes into a buffered evaluation.
pub enum Handler {
    /// Pure evaluation that needs nothing but the payload and the verified invocation.
    Pure(fn(&[u8], &Invocation) -> Result<Evaluation, Failure>),
    /// Host facts are collected before stdin; an error defers the call to the shell.
    Prepared(for<'a> fn(&'a Invocation, Snapshot<'a>) -> Result<Evaluator<'a>, String>),
}

/// One hook implementation actually compiled into this binary.
pub struct NativeHook {
    /// Manifest hook id.
    pub id: &'static str,
    /// SHA-256 of this implementation and the shared runtime, fixed at build time.
    pub implementation: &'static str,
    /// Buffered evaluation. It never receives stdout/stderr writers.
    pub handler: Handler,
    /// Audit phase the shell hook declares (`navori_audit_phase`) for the hook arguments, the
    /// script's `case "$mode"` table. `None` is a mode this binary does not port: the call
    /// defers to the shell before stdin (spec 0059 D31).
    pub phase: fn(&[OsString]) -> Option<&'static str>,
    /// Tool the shell hook declares (`navori_audit_tool`), if any.
    pub tool: Option<&'static str>,
}

/// Phase of a hook without modes: the shell reads no mode argument, so none is checked.
fn pre_tool_use(_: &[OsString]) -> Option<&'static str> {
    Some("PreToolUse")
}

/// Compiled implementations. Listing one here enables nothing: the embedded manifest must also
/// select the hook (R7), and a missing build hash never matches a manifest entry.
pub static NATIVE_HOOKS: LazyLock<[NativeHook; 3]> = LazyLock::new(|| {
    [
        NativeHook {
            id: "subagent-no-background",
            implementation: navori_hooks::compiled::implementation_hash("subagent-no-background")
                .unwrap_or_default(),
            handler: Handler::Prepared(hook_facts::prepare_subagent_no_background),
            phase: pre_tool_use,
            tool: None,
        },
        NativeHook {
            id: "guard-destructive",
            implementation: navori_hooks::compiled::implementation_hash("guard-destructive")
                .unwrap_or_default(),
            handler: Handler::Prepared(hook_facts::prepare_guard_destructive),
            phase: pre_tool_use,
            tool: Some("Bash"),
        },
        NativeHook {
            id: "quality-gate-pre-commit",
            implementation: navori_hooks::compiled::implementation_hash("quality-gate-pre-commit")
                .unwrap_or_default(),
            handler: Handler::Prepared(quality_gate::prepare),
            phase: pre_tool_use,
            tool: Some("Bash"),
        },
    ]
});

/// User-selected runtime override; automatic mode is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Defer unsupported calls to the shell.
    Auto,
    /// Force the shell without consuming stdin.
    Shell,
    /// Evaluate native only, including shadow descriptors, and make deferral explicit for parity.
    Rust,
}

impl Mode {
    /// Decode the supported override values. Other values keep automatic behavior.
    #[must_use]
    pub fn from_env(value: Option<&OsStr>) -> Self {
        match value {
            Some(value) if value == "shell" => Self::Shell,
            Some(value) if value == "rust" => Self::Rust,
            _ => Self::Auto,
        }
    }
}

/// Validated invocation metadata supplied to a compiled handler.
#[derive(Debug, Clone)]
pub struct Invocation {
    /// Host inferred from the script's engine directory.
    pub engine: Engine,
    /// Manifest id inferred from the script basename.
    pub id: String,
    /// Canonical script path, the one integrity reads.
    pub script: PathBuf,
    /// The script path exactly as invoked: the shell's `$0`, run again by the shadow lane.
    pub requested: PathBuf,
    /// Canonical engine root containing `hooks/` and sibling `scripts/`.
    pub engine_root: PathBuf,
    /// Claude event passed by the registered command, if any.
    pub event: Option<String>,
    /// Hook-specific arguments, unchanged after the runtime arguments are removed.
    pub args: Vec<OsString>,
    /// Shadow execution was requested by the renderer.
    pub shadow: bool,
}

/// Parse the two internal invocation forms and pin the script to an engine hook directory.
/// A missing file, unsafe redirect or unsupported shape is a deferral, not a read.
fn parse(args: &[OsString]) -> Result<Invocation, &'static str> {
    let (script_index, event) = match args.first().map(OsString::as_os_str) {
        Some(flag) if flag == "--via-script" => (1, None),
        Some(flag) if flag == "--via-command" => {
            let event = args
                .get(1)
                .and_then(|value| value.to_str())
                .ok_or("missing hook event")?;
            (2, Some(event.to_owned()))
        }
        _ => return Err("unsupported hook invocation"),
    };
    let requested = Path::new(args.get(script_index).ok_or("missing hook script")?);
    let script = fs::canonicalize(requested).map_err(|_| "hook script is unavailable")?;
    let hooks = script.parent().ok_or("missing hooks directory")?;
    if hooks.file_name() != Some(OsStr::new("hooks")) {
        return Err("hook script is outside an engine hooks directory");
    }
    let engine_root = hooks.parent().ok_or("missing engine root")?;
    let engine = engine_at(engine_root).ok_or("unknown hook engine")?;
    // A lexical script path may not redirect one engine's invocation into another engine/root.
    let requested_parent = requested
        .parent()
        .ok_or("missing requested hooks directory")?;
    let lexical_root = requested_parent
        .parent()
        .ok_or("missing requested engine root")?;
    if engine_at(lexical_root) != Some(engine) {
        return Err("hook path redirects into a different engine");
    }
    // Resolve the lexical root itself: `hooks/..` would follow a symlinked hooks directory first.
    let requested_root =
        fs::canonicalize(lexical_root).map_err(|_| "missing requested engine root")?;
    if requested_root != engine_root || hooks != requested_root.join("hooks") {
        return Err("hook path escapes its engine root");
    }
    if script.extension() != Some(OsStr::new("sh")) {
        return Err("hook script must have a .sh extension");
    }
    let id = requested
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or("invalid hook id")?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid hook id");
    }
    let mut tail = &args[script_index + 1..];
    let shadow = tail.first().is_some_and(|arg| arg == "--shadow");
    if shadow {
        tail = &tail[1..];
    }
    Ok(Invocation {
        engine,
        id: id.to_owned(),
        script: script.clone(),
        requested: requested.to_path_buf(),
        engine_root: engine_root.to_path_buf(),
        event,
        args: tail.to_vec(),
        shadow,
    })
}

fn engine_at(root: &Path) -> Option<Engine> {
    match root.file_name().and_then(OsStr::to_str) {
        Some(".claude") => Some(Engine::Claude),
        Some(".codex") => Some(Engine::Codex),
        Some("navori") if root.parent().and_then(Path::file_name) == Some(OsStr::new(".pi")) => {
            Some(Engine::Pi)
        }
        _ => None,
    }
}

fn defer<E: Write>(mode: Mode, cause: &str, stderr: &mut E) -> u8 {
    if mode != Mode::Rust {
        return 3;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        stderr.write_all(format!("navori-rust: hook deferred: {cause}\n").as_bytes())
    }));
    1
}

/// Resolve dependencies beneath the same physical engine root, in manifest key order.
fn dependencies(root: &Path, names: impl Iterator<Item = impl AsRef<str>>) -> Option<Vec<PathBuf>> {
    names
        .map(|name| {
            let rel = Path::new(name.as_ref()).to_path_buf();
            if rel.as_os_str().is_empty()
                || rel
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return None;
            }
            let path = fs::canonicalize(root.join(rel)).ok()?;
            path.starts_with(root).then_some(path)
        })
        .collect()
}

/// Select and evaluate a native hook using an explicit registry and owned I/O handles, without
/// a shadow journal (parity checks and tests). Production calls go through [`run_with_journal`].
pub fn run_with<R: Read, W: Write, E: Write>(
    args: &[OsString],
    manifest: &Manifest,
    registry: &[NativeHook],
    mode: Mode,
    input: &mut R,
    stdout: &mut W,
    stderr: &mut E,
) -> u8 {
    run_with_journal(args, manifest, registry, mode, None, input, stdout, stderr)
}

/// Select and evaluate a native hook using an explicit registry and owned I/O handles.
///
/// Registration and integrity precede stdin. Automatic shadow calls return the shell result;
/// forced Rust evaluates only the native callback and never starts the shadow shell. With a
/// journal, an automatic shadow call is acknowledged before stdin (no acknowledgement keeps the
/// shell route) and its comparison is recorded after the shell answers.
#[allow(
    clippy::too_many_arguments,
    reason = "owned I/O handles and the journal are explicit seams for byte-exact tests"
)]
pub fn run_with_journal<R: Read, W: Write, E: Write>(
    args: &[OsString],
    manifest: &Manifest,
    registry: &[NativeHook],
    mode: Mode,
    journal: Option<&dyn ShadowJournal>,
    input: &mut R,
    stdout: &mut W,
    stderr: &mut E,
) -> u8 {
    if mode == Mode::Shell {
        return 3;
    }
    let invocation = match parse(args) {
        Ok(invocation) => invocation,
        Err(cause) => return defer(mode, cause, stderr),
    };
    let Some(hook) = manifest.hooks.get(&invocation.id) else {
        return defer(mode, "hook is not ported", stderr);
    };
    let Some(handler) = registry.iter().find(|handler| handler.id == invocation.id) else {
        return defer(mode, "hook has no compiled implementation", stderr);
    };
    if hook.r#impl != handler.implementation {
        return defer(
            mode,
            "compiled implementation does not match manifest",
            stderr,
        );
    }
    let Some(phase) = (handler.phase)(&invocation.args) else {
        return defer(mode, "hook mode is not ported", stderr);
    };
    let Some(deps) = dependencies(&invocation.engine_root, hook.deps.keys()) else {
        return defer(
            mode,
            "hook dependency escapes its engine root or is unavailable",
            stderr,
        );
    };
    // Read once: the bytes that pass integrity are the same bytes a preparation inspects.
    let Some((source, dependency_bytes)) = read_integrity_inputs(&invocation.script, &deps) else {
        return defer(mode, "hook integrity mismatch", stderr);
    };
    let dependency_slices: Vec<&[u8]> = dependency_bytes.iter().map(Vec::as_slice).collect();
    if !integrity::verify(&source, &dependency_slices, handler.implementation) {
        return defer(mode, "hook integrity mismatch", stderr);
    }
    let context = Context {
        engine: invocation.engine,
        hook: &invocation.id,
        gating: hook.gating
            && (invocation.engine != Engine::Claude
                || invocation
                    .event
                    .as_deref()
                    .is_none_or(|event| event == "PreToolUse")),
    };
    let use_shadow = mode == Mode::Auto && (invocation.shadow || hook.mode == HookMode::Shadow);
    let prepares = matches!(handler.handler, Handler::Prepared(_));
    // Capture before stdin/native evaluation. A shadow callback cannot change the shell's
    // environment snapshot. Unavailable setup still defers before input is consumed.
    let environment = if use_shadow || prepares {
        let Ok(cwd) = std::env::current_dir() else {
            let cause = if use_shadow {
                "shadow working directory unavailable"
            } else {
                "working directory unavailable"
            };
            return defer(mode, cause, stderr);
        };
        Some((cwd, std::env::vars_os().collect::<Vec<_>>()))
    } else {
        None
    };
    let prepared = match (&handler.handler, &environment) {
        (Handler::Prepared(prepare), Some((cwd, env))) => {
            let snapshot = Snapshot {
                source: &source,
                env,
                cwd,
            };
            match prepare(&invocation, snapshot) {
                Ok(evaluator) => Some(evaluator),
                Err(cause) => {
                    return defer(mode, &format!("hook is ineligible: {cause}"), stderr);
                }
            }
        }
        _ => None,
    };
    let evaluate = |bytes: &[u8], recorder: &dyn Recorder| match (&prepared, &handler.handler) {
        (Some(evaluator), _) => evaluator(bytes, recorder),
        (None, Handler::Pure(evaluate)) => evaluate(bytes, &invocation),
        (None, Handler::Prepared(_)) => Err(Failure("hook preparation is missing".to_owned())),
    };
    let shell_environment = environment.as_ref().filter(|_| use_shadow);
    // Acknowledge before stdin: an observation that cannot be recorded never runs.
    let observation = match (journal, shell_environment) {
        (Some(journal), Some(_)) => {
            let Some(root) = journal::project_root(invocation.engine, &invocation.engine_root)
            else {
                return defer(mode, "shadow project root unavailable", stderr);
            };
            let Some(receipt) = journal.begin(
                root,
                &invocation.id,
                invocation.engine,
                handler.implementation,
            ) else {
                return defer(mode, "shadow journal unavailable", stderr);
            };
            Some((journal, root, receipt))
        }
        _ => None,
    };
    let response = runner::run(
        context,
        input,
        || Ok(true),
        |payload| {
            if let Some((cwd, env)) = shell_environment {
                let observed = shadow::run(
                    context,
                    payload,
                    shadow::ShellInvocation {
                        script: &invocation.requested,
                        args: &invocation.args,
                        cwd,
                        env,
                    },
                    |bytes| evaluate(bytes, &ShadowLane),
                );
                if let Some((journal, root, receipt)) = &observation {
                    journal.complete(root, receipt, observed.comparison, payload);
                }
                let verdict = match observed.shell.code() {
                    0 => Verdict::Permit,
                    1 => Verdict::Error,
                    2 => Verdict::Block,
                    _ => {
                        return Err(Failure(
                            "shadow returned a non-terminal response".to_owned(),
                        ));
                    }
                };
                return Ok(Evaluation {
                    verdict,
                    stdout: observed.shell.stdout().to_vec(),
                    stderr: observed.shell.stderr().to_vec(),
                    audit: None,
                });
            }
            audited(&invocation, handler, phase, payload, evaluate)
        },
    );
    runner::emit(context, &response, stdout, stderr)
}

/// Evaluate a decision Rust makes (never a shadow one: the shell audits those) and record its
/// audit event the way `audit-log.sh` does: activity snapshot before evaluation, closed metadata
/// after it, then the session spool or the `navori` CLI bridge. Recording is best-effort and
/// never changes the verdict.
fn audited(
    invocation: &Invocation,
    handler: &NativeHook,
    phase: &str,
    payload: &[u8],
    evaluate: impl FnOnce(&[u8], &dyn Recorder) -> Result<Evaluation, Failure>,
) -> Result<Evaluation, Failure> {
    let root = audit_root();
    let parsed = HookPayload::parse(payload);
    let snapshot = root
        .as_deref()
        .zip(parsed.as_ref())
        .map(|(root, parsed)| AuditSnapshot::begin(root, phase, parsed, false, audit::now_ms));
    let recorder = Audited {
        invocation,
        tool: handler.tool,
        phase,
        state: root
            .as_deref()
            .zip(parsed.as_ref())
            .zip(snapshot.as_ref())
            .map(|((root, parsed), snapshot)| (root, parsed, snapshot)),
    };
    let evaluation = evaluate(payload, &recorder)?;
    if let Some(label) = &evaluation.audit {
        recorder.record(label);
    }
    Ok(evaluation)
}

/// Records a decision Rust makes the way `navori_audit_log` does, against the activity snapshot
/// taken before evaluation. Best-effort: nothing it does changes the verdict.
struct Audited<'a> {
    invocation: &'a Invocation,
    tool: Option<&'static str>,
    phase: &'a str,
    state: Option<(&'a Path, &'a HookPayload, &'a AuditSnapshot)>,
}

impl Recorder for Audited<'_> {
    fn shadow(&self) -> bool {
        false
    }

    fn record(&self, label: &AuditLabel) {
        let Some((root, parsed, snapshot)) = self.state else {
            return;
        };
        let labels = HookLabels {
            name: &self.invocation.id,
            phase: self.phase,
            verdict: label.verdict,
            source: "core",
            tool: self.tool,
            reason: Some(&label.reason),
            kind: None,
        };
        let skip_noops = std::env::var_os("NAVORI_AUDIT_SKIP_NOOPS").is_some_and(|v| v == "1");
        let host = match self.invocation.engine {
            Engine::Claude => Host::Claude,
            Engine::Codex => Host::Codex,
            Engine::Pi => Host::Pi,
        };
        let cwd = std::env::current_dir().unwrap_or_default();
        if let Some(metadata) = snapshot.metadata(parsed, labels, skip_noops, audit::now_ms)
            && let Some(target) =
                AuditContext::resolve(root, parsed, &cwd, &self.invocation.requested, Some(host))
        {
            let _ = target.record_metadata(&metadata, OsStr::new("navori"));
        }
    }
}

/// `${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}`, absent when both are unset or empty.
fn audit_root() -> Option<PathBuf> {
    let set = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    set("NAVORI_AUDITS_ROOT")
        .map(PathBuf::from)
        .or_else(|| set("HOME").map(|home| PathBuf::from(home).join(".navori/audits")))
}

/// Without a TS CLI nothing can be recorded, so every shadow observation stays on the shell.
struct Unavailable;

impl ShadowJournal for Unavailable {
    fn begin(&self, _: &Path, _: &str, _: Engine, _: &str) -> Option<String> {
        None
    }

    fn complete(&self, _: &Path, _: &str, _: shadow::Comparison, _: &[u8]) {}
}

/// Script and dependency bytes, or None when any of them cannot be read.
fn read_integrity_inputs(script: &Path, deps: &[PathBuf]) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
    let source = fs::read(script).ok()?;
    let dependencies = deps.iter().map(fs::read).collect::<io::Result<_>>().ok()?;
    Some((source, dependencies))
}

/// Production CLI adapter. No unknown hook is delegated to the TS command namespace.
#[must_use]
pub fn run(args: &[OsString]) -> ExitCode {
    let mode = Mode::from_env(std::env::var_os("NAVORI_HOOK_IMPL").as_deref());
    let mut stderr = io::stderr().lock();
    let manifest = match Manifest::embedded() {
        Ok(manifest) => manifest,
        Err(_) => return ExitCode::from(defer(mode, "invalid embedded manifest", &mut stderr)),
    };
    let journal = CliJournal::from_process();
    let unavailable = Unavailable;
    let journal: &dyn ShadowJournal = journal
        .as_ref()
        .map_or(&unavailable, |journal| journal as &dyn ShadowJournal);
    ExitCode::from(run_with_journal(
        args,
        &manifest,
        &*NATIVE_HOOKS,
        mode,
        Some(journal),
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
        &mut stderr,
    ))
}
