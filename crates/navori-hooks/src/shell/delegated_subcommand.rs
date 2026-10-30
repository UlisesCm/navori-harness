//! A subcommand a native hook leaves to the `navori` the `PATH` resolves (spec 0059 D30, R52): the
//! shell's `$(printf '%s' "$payload" | navori <args> 2>&1)`. Same arguments, same stdin, same
//! environment and the same bound (the host's own hook timeout, unless the caller sets one), and
//! the result read as the shell reads it: the two streams merged into one, NUL bytes dropped, the
//! final newlines stripped and the status as `$?`.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// One call of the `navori` of `PATH`.
#[derive(Debug, Clone)]
pub struct Call<'a> {
    /// The binary `command -v navori` resolved.
    pub program: &'a Path,
    /// The subcommand and its arguments, after the program name.
    pub args: &'a [OsString],
    /// What the shell pipes in: `printf '%s' "$payload"`, so a payload the shell already normalized
    /// (NULs and final newlines gone) and nothing appended.
    pub stdin: &'a [u8],
    /// The complete environment of the call, as the shell hook runs under it. It replaces the
    /// inherited one: `NAVORI_HOOK_ENGINE=codex` is part of it where the script sets it.
    pub env: &'a [(OsString, OsString)],
    /// The working directory of the hook.
    pub cwd: &'a Path,
    /// `None` leaves the bound to the host, as the shell does; `Some` kills the child when it
    /// expires.
    pub deadline: Option<Duration>,
}

/// How the child ended, as `$?` would say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// `$?` after a normal exit.
    Exited(i32),
    /// Killed by a signal: `$?` is `128 + signal`.
    Signaled(i32),
    /// The `deadline` expired and the child was killed.
    TimedOut,
}

impl Status {
    /// The value of `$?`; a timeout reads as a `SIGKILL` (137).
    #[must_use]
    pub const fn code(self) -> i32 {
        match self {
            Self::Exited(code) => code,
            Self::Signaled(signal) => 128 + signal,
            Self::TimedOut => 137,
        }
    }
}

/// What the call produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    /// How it ended.
    pub status: Status,
    /// Standard output and standard error in the order they were written, one pipe (`2>&1`).
    pub merged: Vec<u8>,
}

impl Captured {
    /// `"$(…)"`: the merged output without NUL bytes (Bash drops them) and without final newlines.
    #[must_use]
    pub fn substituted(&self) -> Vec<u8> {
        let mut text: Vec<u8> = self.merged.iter().copied().filter(|b| *b != 0).collect();
        while text.last() == Some(&b'\n') {
            text.pop();
        }
        text
    }
}

/// Run `call` and wait for it.
///
/// A program that cannot start is what the shell's `navori` would be: `127` when it is missing and
/// `126` when it cannot be executed, with nothing printed.
#[must_use]
pub fn run(call: &Call<'_>) -> Captured {
    let spawn_failed = |error: &io::Error| Captured {
        status: Status::Exited(if error.kind() == io::ErrorKind::NotFound {
            127
        } else {
            126
        }),
        merged: Vec::new(),
    };
    let Ok((mut reader, writer)) = io::pipe() else {
        return spawn_failed(&io::Error::other("pipe"));
    };
    let Ok(error_writer) = writer.try_clone() else {
        return spawn_failed(&io::Error::other("pipe"));
    };
    let mut child = match Command::new(call.program)
        .args(call.args)
        .current_dir(call.cwd)
        .env_clear()
        .envs(call.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(writer)
        .stderr(error_writer)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return spawn_failed(&error),
    };
    // The writer handles inside the `Command` are closed once it is dropped, so the reader sees
    // EOF when the child (and anything it left running) closes its ends.
    let mut stdin = child.stdin.take();
    let payload = call.stdin.to_vec();
    let feeder = thread::spawn(move || {
        if let Some(stdin) = stdin.as_mut() {
            // A child that exits without reading closes the pipe: the shell ignores that too.
            let _ = stdin.write_all(&payload);
        }
        drop(stdin);
    });
    let collector = thread::spawn(move || {
        let mut merged = Vec::new();
        let _ = reader.read_to_end(&mut merged);
        merged
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status_of(status),
            Ok(None) => {}
            Err(_) => break Status::Exited(126),
        }
        if call
            .deadline
            .is_some_and(|limit| started.elapsed() >= limit)
        {
            let _ = child.kill();
            let _ = child.wait();
            break Status::TimedOut;
        }
        thread::sleep(Duration::from_millis(1));
    };
    let _ = feeder.join();
    let merged = collector.join().unwrap_or_default();
    Captured { status, merged }
}

fn status_of(status: std::process::ExitStatus) -> Status {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => Status::Exited(code),
        (None, Some(signal)) => Status::Signaled(signal),
        (None, None) => Status::Exited(1),
    }
}
