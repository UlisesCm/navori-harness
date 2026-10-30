//! Bounded child processes, the subset of `spawnSync` the ported primitives use.
//!
//! The child's stderr is discarded (no caller reads it), stdin is either the given bytes or
//! empty, and a run that outlives its budget is killed and reported as timed out, like
//! `spawnSync({ timeout })` (which sends `SIGTERM`; the outcome is the same failure value).

use std::ffi::OsString;
use std::io::{self, Read as _, Write as _};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
