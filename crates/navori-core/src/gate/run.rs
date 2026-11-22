//! Port of the `gate foreign` side of `lib/gate/run.ts` (#1097): the shell-free chain runner,
//! the private per-run log and its retention, and the order in which the destination repo is
//! trusted (registry, then config, then `nativeHooks`, then `isSafeGateChain`).
//!
//! Signals (decided option A): no handler is installed and the steps stay in navori's own process
//! group, so a signal to the group ends navori and the steps together. A step that dies of a
//! signal is reported as the TS does: `128 + n` for SIGINT/SIGTERM, 129 for any other, with the
//! note `killed by <NAME>`.

use std::ffi::OsString;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::os::unix::process::ExitStatusExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use crate::atomic::random_bytes;
use crate::config;
use crate::gate::summary::{render_verdict, sentinel_line};
use crate::integrity::is_js_whitespace;
use crate::js_json::JsValue;
use crate::posix::{js_trim, resolve};
use crate::process::{Env, ProcessRunner};
use crate::workspace::registry::{self, Stop};

/// Exit code of a `navori gate foreign` refusal; the caller pairs it with the first output line.
pub const FOREIGN_REFUSED_EXIT: i32 = 64;
/// Prefix of the private per-run log directories; pruned to [`FOREIGN_LOG_KEEP`].
pub const FOREIGN_LOG_PREFIX: &str = "navori-gate-foreign-";
/// How many log directories survive a prune.
pub const FOREIGN_LOG_KEEP: usize = 20;
const KIND: &str = "foreign";

/// `timestamp(now)`: `toISOString()` without `-`, `:` and `.` (`20260102T030405678Z`).
#[must_use]
pub fn timestamp(now: jiff::Timestamp) -> String {
    now.strftime("%Y%m%dT%H%M%S%3fZ").to_string()
}

/// The operator that joins a chain step to the previous one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainOp {
    /// `;` (also the first step).
    Seq,
    /// `&&`.
    And,
    /// `||`.
    Or,
}

/// One step of a parsed chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainStep {
    /// Operator before this step.
    pub op: ChainOp,
    /// The step's text, trimmed.
    pub text: String,
}

fn trim_js_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `parseChain`: splits a validated gate on `&&`, `||` and `;`, keeping the operator before each
/// step. Whitespace around an operator belongs to the operator.
#[must_use]
pub fn parse_chain(gate: &str) -> Vec<ChainStep> {
    let gate = js_trim(gate);
    let mut steps = Vec::new();
    let mut op = ChainOp::Seq;
    let mut rest = gate;
    loop {
        let found = rest.char_indices().find_map(|(index, ch)| match ch {
            ';' => Some((index, 1, ChainOp::Seq)),
            '&' if rest[index..].starts_with("&&") => Some((index, 2, ChainOp::And)),
            '|' if rest[index..].starts_with("||") => Some((index, 2, ChainOp::Or)),
            _ => None,
        });
        match found {
            Some((index, len, next)) => {
                steps.push(ChainStep {
                    op,
                    text: js_trim(&rest[..index]).to_owned(),
                });
                op = next;
                rest = trim_js_start(&rest[index + len..]);
            }
            None => {
                steps.push(ChainStep {
                    op,
                    text: js_trim(rest).to_owned(),
                });
                return steps;
            }
        }
    }
}

/// Node's `signo_string` for the platform's signal numbers: the name, or `None` without one.
fn signal_name(number: i32) -> Option<&'static str> {
    #[cfg(target_os = "linux")]
    const TABLE: &[(i32, &str)] = &[
        (1, "SIGHUP"),
        (2, "SIGINT"),
        (3, "SIGQUIT"),
        (4, "SIGILL"),
        (5, "SIGTRAP"),
        (6, "SIGABRT"),
        (7, "SIGBUS"),
        (8, "SIGFPE"),
        (9, "SIGKILL"),
        (10, "SIGUSR1"),
        (11, "SIGSEGV"),
        (12, "SIGUSR2"),
        (13, "SIGPIPE"),
        (14, "SIGALRM"),
        (15, "SIGTERM"),
        (16, "SIGSTKFLT"),
        (17, "SIGCHLD"),
        (18, "SIGCONT"),
        (19, "SIGSTOP"),
        (20, "SIGTSTP"),
        (21, "SIGTTIN"),
        (22, "SIGTTOU"),
        (23, "SIGURG"),
        (24, "SIGXCPU"),
        (25, "SIGXFSZ"),
        (26, "SIGVTALRM"),
        (27, "SIGPROF"),
        (28, "SIGWINCH"),
        (29, "SIGIO"),
        (30, "SIGPWR"),
        (31, "SIGSYS"),
    ];
    #[cfg(target_os = "macos")]
    const TABLE: &[(i32, &str)] = &[
        (1, "SIGHUP"),
        (2, "SIGINT"),
        (3, "SIGQUIT"),
        (4, "SIGILL"),
        (5, "SIGTRAP"),
        (6, "SIGABRT"),
        (8, "SIGFPE"),
        (9, "SIGKILL"),
        (10, "SIGBUS"),
        (11, "SIGSEGV"),
        (12, "SIGSYS"),
        (13, "SIGPIPE"),
        (14, "SIGALRM"),
        (15, "SIGTERM"),
        (16, "SIGURG"),
        (17, "SIGSTOP"),
        (18, "SIGTSTP"),
        (19, "SIGCONT"),
        (20, "SIGCHLD"),
        (21, "SIGTTIN"),
        (22, "SIGTTOU"),
        (23, "SIGIO"),
        (24, "SIGXCPU"),
        (25, "SIGXFSZ"),
        (26, "SIGVTALRM"),
        (27, "SIGPROF"),
        (28, "SIGWINCH"),
        (29, "SIGINFO"),
        (30, "SIGUSR1"),
        (31, "SIGUSR2"),
    ];
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    const TABLE: &[(i32, &str)] = &[];
    TABLE
        .iter()
        .find(|(value, _)| *value == number)
        .map(|(_, name)| *name)
}

/// What [`run_chain`] saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainResult {
    /// Status of the last step that ran (1 for a step ended by a signal).
    pub code: i32,
    /// The signal that ended a step: its Node name, `""` when Node has no name for the number.
    pub signal: Option<&'static str>,
}

impl ChainResult {
    /// Exit code navori reports: `128 + n` for SIGINT (2) and SIGTERM (15), 129 for any other
    /// signal (the TS `SIGNAL_NUMBER[sig] ?? 1`), else the last status.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self.signal {
            Some("SIGINT") => 130,
            Some("SIGTERM") => 143,
            Some(_) => 129,
            None => self.code,
        }
    }
}

/// Runs the validated chain without a shell; the steps' stdout and stderr go to `log` (one shared
/// offset) and they see exactly `env`. `cd` is emulated in process. A missing binary is 127.
pub fn run_chain(gate: &str, repo_cwd: &str, log: &File, env: &Env) -> ChainResult {
    let mut cwd = repo_cwd.to_owned();
    let mut status = 0;
    let mut signal = None;
    for ChainStep { op, text } in parse_chain(gate) {
        if signal.is_some() {
            break;
        }
        if (op == ChainOp::And && status != 0) || (op == ChainOp::Or && status == 0) {
            continue;
        }
        let mut words = text.split(is_js_whitespace).filter(|word| !word.is_empty());
        let head = words.next().unwrap_or("");
        if head == "cd" {
            let dir = words.next().unwrap_or("");
            let target = resolve(&cwd, dir);
            if fs::metadata(&target).is_ok_and(|meta| meta.is_dir()) {
                cwd = target;
                status = 0;
            } else {
                // Same `File` as the steps: one offset, so the note lands in order.
                let _ = (&*log)
                    .write_all(format!("[navori gate] cd: {dir}: no such directory\n").as_bytes());
                status = 1;
            }
            continue;
        }
        let (code, received) = spawn_step(head, words, &cwd, log, env);
        status = code;
        signal = received;
    }
    ChainResult {
        code: status,
        signal,
    }
}

fn spawn_step<'a>(
    program: &str,
    args: impl Iterator<Item = &'a str>,
    cwd: &str,
    log: &File,
    env: &Env,
) -> (i32, Option<&'static str>) {
    let (Ok(out), Ok(err)) = (log.try_clone(), log.try_clone()) else {
        return (127, None);
    };
    let spawned = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn();
    let Ok(mut child) = spawned else {
        return (127, None);
    };
    let Ok(status) = child.wait() else {
        return (127, None);
    };
    match status.signal() {
        Some(number) => (1, Some(signal_name(number).unwrap_or(""))),
        None => (status.code().unwrap_or(1), None),
    }
}

/// `os.tmpdir()` on POSIX: `TMPDIR`, else `TMP`, else `TEMP` (empty counts as unset), else
/// `/tmp`; one trailing `/` is dropped when the path is longer than one character.
#[must_use]
pub fn tmpdir(env: &Env) -> PathBuf {
    let var = |name: &str| {
        env.iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
    };
    let mut bytes = var("TMPDIR")
        .or_else(|| var("TMP"))
        .or_else(|| var("TEMP"))
        .unwrap_or_else(|| OsString::from("/tmp"))
        .into_vec();
    if bytes.len() > 1 && bytes.last() == Some(&b'/') {
        bytes.pop();
    }
    PathBuf::from(OsString::from_vec(bytes))
}

/// A freshly created private log: its directory, path and the open file.
#[derive(Debug)]
pub struct PrivateLog {
    /// `<base>/navori-gate-foreign-XXXXXX`, mode 0700.
    pub dir: PathBuf,
    /// `<dir>/fast-<timestamp>.log`, mode 0600.
    pub path: PathBuf,
    /// The log, open for writing.
    pub file: File,
}

const ALPHABET: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// `mkdtemp(base/navori-gate-foreign-)` (mode 0700, six `[A-Za-z0-9]`) plus `fast-<ts>.log`
/// created with `O_EXCL` and mode 0600.
///
/// # Errors
/// Any filesystem or randomness failure; the directory is removed best-effort.
pub fn private_log(base: &Path, now: jiff::Timestamp) -> io::Result<PrivateLog> {
    let mut attempts = 0;
    let dir = loop {
        let random = random_bytes::<6>()?;
        let suffix: String = random
            .iter()
            .map(|byte| char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()]))
            .collect();
        let dir = base.join(format!("{FOREIGN_LOG_PREFIX}{suffix}"));
        match DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => break dir,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && attempts < 100 => {
                attempts += 1;
            }
            Err(error) => return Err(error),
        }
    };
    let path = dir.join(format!("fast-{}.log", timestamp(now)));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => Ok(PrivateLog { dir, path, file }),
        Err(error) => {
            let _ = fs::remove_dir(&dir);
            Err(error)
        }
    }
}

/// `pruneForeignLogs`: keeps the newest `keep` own-prefix directories under `base` that belong to
/// `own_uid` (never `skip`, the run's own directory); symlinks are not followed. Best effort.
pub fn prune_foreign_logs(base: &Path, keep: usize, own_uid: u32, skip: &Path) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    let mut dirs: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .as_bytes()
                .starts_with(FOREIGN_LOG_PREFIX.as_bytes())
        })
        .filter(|entry| entry.path() != skip)
        .filter_map(|entry| {
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            (meta.is_dir() && meta.uid() == own_uid)
                .then(|| meta.modified().ok().map(|mtime| (mtime, entry.path())))
                .flatten()
        })
        .collect();
    dirs.sort_by_key(|dir| std::cmp::Reverse(dir.0));
    for (_, path) in dirs.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(path);
    }
}

/// What [`prepare_foreign`] decided, before any byte was printed.
#[derive(Debug)]
pub enum Prepared {
    /// Hand the argv to the TS.
    Delegate(&'static str),
    /// Refuse: print `warnings` (stderr), then `message` (stderr), exit [`FOREIGN_REFUSED_EXIT`].
    Refuse {
        /// Lines `readConfig` wrote to stderr first.
        warnings: Vec<String>,
        /// `navori gate foreign: refused — <reason>`.
        message: String,
    },
    /// Run the chain.
    Ready {
        /// Lines `readConfig` writes to stderr first.
        warnings: Vec<String>,
        /// `qualityGate.fast`.
        gate: String,
        /// Canonical toplevel of the destination.
        top: String,
        /// The private log, with old ones already pruned.
        log: PrivateLog,
    },
}

fn refuse(warnings: Vec<String>, reason: &str) -> Prepared {
    Prepared::Refuse {
        warnings,
        message: format!("navori gate {KIND}: refused — {reason}"),
    }
}

fn delegate(stop: Stop) -> Prepared {
    match stop {
        Stop::Delegate(reason) => Prepared::Delegate(reason),
        Stop::Throw => Prepared::Delegate("the registry cannot be read"),
    }
}

/// The decision half of `runForeignGate`. In the TS order: toplevel, registry (BEFORE the
/// destination's config is parsed), config, `fast` set, `nativeHooks`, `isSafeGateChain`; only
/// then the private log. It prints nothing and `env` reaches git and the steps whole.
pub fn prepare_foreign(
    env: &Env,
    process_cwd: &str,
    cwd_arg: &str,
    now: jiff::Timestamp,
    runner: &dyn ProcessRunner,
) -> Prepared {
    let cwd = resolve(process_cwd, cwd_arg);
    let not_a_checkout = || {
        refuse(
            Vec::new(),
            &format!("--cwd is not a Git checkout: {cwd_arg}"),
        )
    };
    let out = match registry::git_out(
        runner,
        Path::new(&cwd),
        &["rev-parse", "--show-toplevel"],
        env,
    ) {
        Ok(Some(out)) => out,
        Ok(None) => return not_a_checkout(),
        Err(stop) => return delegate(stop),
    };
    let out = js_trim(&out);
    if out.is_empty() {
        return not_a_checkout();
    }
    let Ok(real) = fs::canonicalize(out) else {
        return not_a_checkout();
    };
    let Ok(top) = real.into_os_string().into_string() else {
        return Prepared::Delegate("real path is not UTF-8");
    };
    match registry::is_registered_checkout(env, process_cwd, &top, runner) {
        Ok(true) => {}
        Ok(false) => {
            return refuse(
                Vec::new(),
                &format!(
                    "{top} is not registered in any navori workspace; run 'navori workspace link <workspace> --cwd {top}' to opt in"
                ),
            );
        }
        Err(stop) => return delegate(stop),
    }
    let Ok(bytes) = fs::read(Path::new(&top).join("navori.config.json")) else {
        return Prepared::Delegate("navori.config.json cannot be read");
    };
    let Ok(config) = config::read(&bytes) else {
        return Prepared::Delegate("navori.config.json is outside what Rust reads");
    };
    let warnings = config.warnings;
    let quality = match &config.data {
        JsValue::Object(root) => match root.get("qualityGate") {
            Some(JsValue::Object(quality)) => Some(quality),
            _ => None,
        },
        _ => None,
    };
    let gate = match quality.and_then(|quality| quality.get("fast")) {
        Some(JsValue::String(text)) => match text.to_rust() {
            Some(text) => text,
            None => return Prepared::Delegate("qualityGate.fast is not UTF-8"),
        },
        _ => String::new(),
    };
    if js_trim(&gate).is_empty() {
        return refuse(
            warnings,
            "qualityGate.fast is not set in navori.config.json",
        );
    }
    if quality.and_then(|quality| quality.get("nativeHooks")) == Some(&JsValue::Bool(true)) {
        return refuse(
            warnings,
            "qualityGate.nativeHooks is true; the destination's native pre-commit runs its gate",
        );
    }
    if !config::is_safe_gate_chain(&gate) {
        return refuse(
            warnings,
            &format!(
                "qualityGate.fast is not a plain command chain; run it by hand in the destination: {}",
                js_trim(&gate)
            ),
        );
    }
    let base = tmpdir(env);
    let Ok(log) = private_log(&base, now) else {
        return Prepared::Delegate("the private log cannot be created");
    };
    if let Ok(meta) = fs::metadata(&log.dir) {
        prune_foreign_logs(&base, FOREIGN_LOG_KEEP, meta.uid(), &log.dir);
    }
    Prepared::Ready {
        warnings,
        gate,
        top,
        log,
    }
}

/// The verdict of a foreign run: `stdout` (without the final newline) and the exit code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// Exit code navori ends with.
    pub exit_code: i32,
    /// stdout, starting with the sentinel line.
    pub stdout: String,
}

/// The run half of `runForeignGate`: the chain in `top`, then the verdict. A step ended by a
/// signal appends `killed by <NAME>` to the log and to stdout. An unreadable log renders empty.
pub fn run_foreign(gate: &str, top: &str, log: PrivateLog, env: &Env) -> Verdict {
    let result = run_chain(gate, top, &log.file, env);
    let shown = log.path.to_string_lossy().into_owned();
    if let Some(name) = result.signal {
        let exit_code = result.exit_code();
        let note = format!("killed by {name}");
        let _ = (&log.file).write_all(format!("\n[navori gate] {note}\n").as_bytes());
        return Verdict {
            exit_code,
            stdout: format!("{}\n{note}", sentinel_line(KIND, exit_code, &shown)),
        };
    }
    let text = fs::read(&log.path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    Verdict {
        exit_code: result.code,
        stdout: render_verdict(KIND, result.code, &shown, &text),
    }
}

#[cfg(test)]
mod tests;
