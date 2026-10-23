//! Internal native hook entry point (spec 0057 D6-D8 / R12-R13).
//!
//! The production registry stays empty until a hook is ported. Selection, path validation and
//! exact-byte integrity all run before reading stdin, so a shell fallback receives the payload.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use navori_core::integrity;
use navori_core::manifest::{HookMode, Manifest};
use navori_hooks::runner::{self, Context, Engine, Evaluation, Failure};

/// One hook implementation actually compiled into this binary.
pub struct NativeHook {
    /// Manifest hook id.
    pub id: &'static str,
    /// SHA-256 of this implementation and the shared runtime, fixed at build time.
    pub implementation: &'static str,
    /// Buffered evaluation. It never receives stdout/stderr writers.
    pub evaluate: fn(&[u8], &Invocation) -> Result<Evaluation, Failure>,
}

/// No native hook is enabled merely by adding a manifest entry (R7).
pub const NATIVE_HOOKS: &[NativeHook] = &[];

/// User-selected runtime override; automatic mode is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Defer unsupported calls to the shell.
    Auto,
    /// Force the shell without consuming stdin.
    Shell,
    /// Make a deferral an explicit error for replay and fuzz.
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
    /// Canonical script path.
    pub script: PathBuf,
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

/// Select and evaluate a native hook using an explicit registry and owned I/O handles.
///
/// Registration and integrity precede stdin. Shadow currently defers until its shell executor
/// lands with the first port, rather than accidentally returning an active Rust verdict.
pub fn run_with<R: Read, W: Write, E: Write>(
    args: &[OsString],
    manifest: &Manifest,
    registry: &[NativeHook],
    mode: Mode,
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
    if invocation.shadow || hook.mode == HookMode::Shadow {
        return defer(mode, "shadow executor is not available", stderr);
    }
    if hook.r#impl != handler.implementation {
        return defer(
            mode,
            "compiled implementation does not match manifest",
            stderr,
        );
    }
    let Some(deps) = dependencies(&invocation.engine_root, hook.deps.keys()) else {
        return defer(
            mode,
            "hook dependency escapes its engine root or is unavailable",
            stderr,
        );
    };
    if !integrity::verify_file(&invocation.script, &deps, handler.implementation).unwrap_or(false) {
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
    let response = runner::run(
        context,
        input,
        || Ok(true),
        |payload| (handler.evaluate)(payload, &invocation),
    );
    runner::emit(context, &response, stdout, stderr)
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
    ExitCode::from(run_with(
        args,
        &manifest,
        NATIVE_HOOKS,
        mode,
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
        &mut stderr,
    ))
}
