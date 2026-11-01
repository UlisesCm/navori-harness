//! Bounded child processes, the subset of `spawnSync` the ported primitives use.
//!
//! The child's stderr is discarded (no caller reads it), stdin is either the given bytes or
//! empty, and a run that outlives its budget is killed and reported as timed out, like
//! `spawnSync({ timeout })` (which sends `SIGTERM`; the outcome is the same failure value).
//!
//! Commands that run an external tool (`git`, `gh`, `acli`, `npm`, ...) take a [`ProcessRunner`]
//! (spec 0060 D42, R76): [`RealRunner`] in production and [`RecordedRunner`] in tests, which
//! answers from the same recordings the oracle's PATH stubs serve
//! (`scripts/js/rust-oracle/recordings/<tool>.json`) and keeps every call.

use std::ffi::OsString;
use std::io::{self, Read as _, Write as _};
use std::os::unix::process::ExitStatusExt as _;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Environment handed to a child verbatim (the parent's is cleared first).
pub type Env = [(OsString, OsString)];

/// What a finished child left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// Exit status (`code()` is `None` when a signal ended it).
    pub status: ExitStatus,
    /// Captured stdout bytes.
    pub stdout: Vec<u8>,
}

/// Why a run produced no [`Output`].
#[derive(Debug)]
pub enum Failure {
    /// The program could not be started, or its pipes failed.
    Spawn(io::Error),
    /// It outlived its budget and was killed.
    Timeout,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(error) => write!(f, "cannot run the process: {error}"),
            Self::Timeout => f.write_str("the process outlived its budget"),
        }
    }
}

impl std::error::Error for Failure {}

/// Runs `program args` in `cwd` with exactly `env`, feeding `input` on stdin, within `timeout`.
///
/// # Errors
/// [`Failure::Spawn`] when it cannot start, [`Failure::Timeout`] when it was killed.
pub fn run(
    program: &str,
    args: &[&str],
    cwd: &Path,
    env: &Env,
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output, Failure> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(Failure::Spawn)?;
    let writer = child.stdin.take().zip(input).map(|(mut stdin, bytes)| {
        let bytes = bytes.to_vec();
        // A child that exits without reading its stdin breaks the pipe; that is not our failure.
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        })
    });
    let Some(mut stdout) = child.stdout.take() else {
        stop(&mut child);
        return Err(Failure::Spawn(io::Error::other("stdout was not captured")));
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.read_to_end(&mut bytes).map(|_| bytes);
        let _ = sender.send(read);
    });
    let remaining = deadline.saturating_duration_since(Instant::now());
    let stdout = match receiver.recv_timeout(remaining) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            stop(&mut child);
            return Err(Failure::Spawn(error));
        }
        Err(_) => {
            stop(&mut child);
            return Err(Failure::Timeout);
        }
    };
    let status = wait_until(&mut child, deadline)?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    Ok(Output { status, stdout })
}

/// Waits for `child` to exit; it already closed stdout, so this is normally immediate.
fn wait_until(child: &mut Child, deadline: Instant) -> Result<ExitStatus, Failure> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_micros(200)),
            Ok(None) => {
                stop(child);
                return Err(Failure::Timeout);
            }
            Err(error) => {
                stop(child);
                return Err(Failure::Spawn(error));
            }
        }
    }
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// One child process: the arguments of [`run`].
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    /// Program name (looked up on the child's `PATH`) or path.
    pub program: &'a str,
    /// Arguments after the program.
    pub args: &'a [&'a str],
    /// Working directory.
    pub cwd: &'a Path,
    /// The child's whole environment.
    pub env: &'a Env,
    /// Bytes for stdin, or `None` for an empty stdin.
    pub input: Option<&'a [u8]>,
    /// Budget before the child is killed.
    pub timeout: Duration,
}

/// The injectable transport for external processes (spec 0060 D42).
pub trait ProcessRunner {
    /// Runs `request` to completion.
    ///
    /// # Errors
    /// [`Failure::Spawn`] when it cannot start (or has no recording), [`Failure::Timeout`] when
    /// it was killed.
    fn run(&self, request: &Request<'_>) -> Result<Output, Failure>;
}

/// Spawns the real program through [`run`].
#[derive(Debug, Clone, Copy, Default)]
pub struct RealRunner;

impl ProcessRunner for RealRunner {
    fn run(&self, request: &Request<'_>) -> Result<Output, Failure> {
        run(
            request.program,
            request.args,
            request.cwd,
            request.env,
            request.input,
            request.timeout,
        )
    }
}

/// One recorded answer of `tool` to exactly `args`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recording {
    /// Tool name (the program's file name).
    pub tool: String,
    /// `--version` line of the tool that produced the recording.
    pub version: String,
    /// Exact argv after the program.
    pub args: Vec<String>,
    /// Exit code.
    pub status: u8,
    /// Stdout.
    pub stdout: String,
    /// Stderr (served by the oracle stubs; [`Output`] does not carry it).
    pub stderr: String,
}

/// A call [`RecordedRunner`] received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    /// Tool name (the program's file name).
    pub tool: String,
    /// Argv after the program.
    pub args: Vec<String>,
    /// Version of the recording that answered; `None` when none matched.
    pub version: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordingFile {
    schema: u32,
    tool: String,
    version: String,
    responses: Vec<RecordedResponse>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedResponse {
    args: Vec<String>,
    status: u8,
    stdout: String,
    #[serde(default)]
    stderr: String,
}

/// Answers each call by tool and exact argv from recordings, and keeps every call.
#[derive(Debug, Default)]
pub struct RecordedRunner {
    recordings: Vec<Recording>,
    calls: Mutex<Vec<Call>>,
}

impl RecordedRunner {
    /// A runner over `recordings`.
    #[must_use]
    pub fn new(recordings: Vec<Recording>) -> Self {
        Self {
            recordings,
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Reads every `<tool>.json` of `dir` (`{ "schema": 1, "tool", "version", "responses" }`),
    /// the format the oracle's PATH stubs serve.
    ///
    /// # Errors
    /// An unreadable directory or file, or a file that is not a schema-1 recording of the tool
    /// its name says, with a version.
    pub fn load(dir: &Path) -> io::Result<Self> {
        let mut names: Vec<_> = std::fs::read_dir(dir)?
            .map(|entry| entry.map(|e| e.file_name()))
            .collect::<io::Result<_>>()?;
        names.sort();
        let mut recordings = Vec::new();
        for name in names {
            let Some(tool) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
                continue;
            };
            let text = std::fs::read_to_string(dir.join(&name))?;
            let file: RecordingFile = serde_json::from_str(&text)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{tool}: {e}")))?;
            if file.schema != 1 || file.tool != tool || file.version.trim().is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{tool}: needs schema 1, tool \"{tool}\" and a version"),
                ));
            }
            recordings.extend(file.responses.into_iter().map(|r| Recording {
                tool: file.tool.clone(),
                version: file.version.clone(),
                args: r.args,
                status: r.status,
                stdout: r.stdout,
                stderr: r.stderr,
            }));
        }
        Ok(Self::new(recordings))
    }

    /// Every call so far, in order.
    #[must_use]
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

impl ProcessRunner for RecordedRunner {
    fn run(&self, request: &Request<'_>) -> Result<Output, Failure> {
        let tool = Path::new(request.program)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(request.program)
            .to_owned();
        let found = self.recordings.iter().find(|r| {
            r.tool == tool
                && r.args
                    .iter()
                    .map(String::as_str)
                    .eq(request.args.iter().copied())
        });
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(Call {
                tool: tool.clone(),
                args: request.args.iter().map(|a| (*a).to_owned()).collect(),
                version: found.map(|r| r.version.clone()),
            });
        }
        let Some(recording) = found else {
            return Err(Failure::Spawn(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no recording for {tool} {}", request.args.join(" ")),
            )));
        };
        Ok(Output {
            status: ExitStatus::from_raw(i32::from(recording.status) << 8),
            stdout: recording.stdout.clone().into_bytes(),
        })
    }
}
