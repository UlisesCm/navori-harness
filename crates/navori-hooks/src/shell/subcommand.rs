//! A hook branch that runs the `navori` of `PATH` (spec 0059 R52, D30): the same argv, stdin,
//! environment, working directory and time bound as the shell's call, and its result read the
//! way the shell reads it. Which branch calls it, and when it runs in process instead, is the
//! hook's decision.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// What the call reads on stdin.
#[derive(Debug, Clone, Copy)]
pub enum Input<'a> {
    /// `</dev/null`.
    Null,
    /// A pipe that receives these bytes, then EOF (`printf '%s' "$payload" | navori …`). An
    /// already drained hook stdin is `Bytes(&[])`.
    Bytes(&'a [u8]),
}

/// Where the call's output goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capture {
    /// stdout and stderr read apart (`out=$(navori … 2>"$err")`).
    Separate,
    /// Both into one stream, in write order (`out=$(navori … 2>&1)`); read back as stdout.
    Merged,
    /// Both discarded (`navori … >/dev/null 2>&1`).
    Discard,
}

/// One call, spelled as the shell runs it.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    /// The `navori` that `PATH` resolves, as `command -v` prints it.
    pub program: &'a Path,
    /// Arguments after the program name.
    pub args: &'a [OsString],
    /// The shell's working directory at the call.
    pub cwd: &'a Path,
    /// The child's complete environment; see [`child_env`].
    pub env: &'a [(OsString, OsString)],
    /// stdin of the call.
    pub input: Input<'a>,
    /// Output routing.
    pub capture: Capture,
    /// Wall-time bound, `None` when the shell waits as long as the call runs (`$(…)`).
    pub timeout: Option<Duration>,
}

/// How the call ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    /// The shell's `$?`: the exit code, or 128 plus the signal number.
    pub status: i32,
    /// stdout, or both streams under [`Capture::Merged`]; empty under [`Capture::Discard`].
    pub stdout: Vec<u8>,
    /// stderr under [`Capture::Separate`], else empty.
    pub stderr: Vec<u8>,
    /// The bound expired and the child was killed (`SIGKILL`); `status` is then 137 and the
    /// output is empty.
    pub timed_out: bool,
}

/// The environment Bash hands a command it runs: the hook's own, with `PWD` set to the shell's
/// logical working directory, `OLDPWD` to the previous one after a `cd`, `SHLVL` one above the
/// hook's (`1` when it is unset or not a number) and `_` set to the program path. `extra`
/// assignments (`NAVORI_HOOK_ENGINE=codex navori …`) are applied last.
#[must_use]
pub fn child_env(
    hook: &[(OsString, OsString)],
    pwd: &OsStr,
    oldpwd: Option<&OsStr>,
    program: &Path,
    extra: &[(&str, &OsStr)],
) -> Vec<(OsString, OsString)> {
    let level = hook
        .iter()
        .rev()
        .find(|(name, _)| name == "SHLVL")
        .and_then(|(_, value)| value.to_str()?.trim().parse::<i64>().ok())
        .filter(|level| *level >= 0)
        .map_or(1, |level| level + 1);
    let mut set: Vec<(OsString, OsString)> = vec![
        ("PWD".into(), pwd.to_owned()),
        ("SHLVL".into(), level.to_string().into()),
        ("_".into(), program.as_os_str().to_owned()),
    ];
    if let Some(oldpwd) = oldpwd {
        set.push(("OLDPWD".into(), oldpwd.to_owned()));
    }
    set.extend(
        extra
            .iter()
            .map(|(name, value)| (OsString::from(name), (*value).to_owned())),
    );
    let mut env: Vec<(OsString, OsString)> = hook
        .iter()
        .filter(|(name, _)| !set.iter().any(|(key, _)| key == name))
        .cloned()
        .collect();
    env.extend(set);
    env
}

/// `$(…)`: the output with every trailing newline removed.
#[must_use]
pub fn substitution(output: &[u8]) -> &[u8] {
    let end = output
        .iter()
        .rposition(|byte| *byte != b'\n')
        .map_or(0, |at| at + 1);
    &output[..end]
}

/// Run the call and wait for it, its output and, within the bound, its exit.
///
/// # Errors
/// The program cannot be spawned or waited for; the hook answers as the shell does when the
/// command cannot run.
pub fn run(call: &Call<'_>) -> io::Result<Finished> {
    let mut command = Command::new(call.program);
    command
        .args(call.args)
        .current_dir(call.cwd)
        .env_clear()
        .envs(call.env.iter().map(|(name, value)| (name, value)));
    command.stdin(match call.input {
        Input::Null => Stdio::null(),
        Input::Bytes(_) => Stdio::piped(),
    });
    let merged = match call.capture {
        Capture::Separate => {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
            None
        }
        Capture::Merged => {
            let (reader, writer) = io::pipe()?;
            command.stdout(writer.try_clone()?).stderr(writer);
            Some(reader)
        }
        Capture::Discard => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
            None
        }
    };
    let mut child = command.spawn()?;
    // Drop the parent's copies of the merged pipe's write end (moved into `command`).
    drop(command);
    let feeder = match (call.input, child.stdin.take()) {
        (Input::Bytes(bytes), Some(stdin)) => Some(feed(stdin, bytes.to_vec())),
        _ => None,
    };
    let stdout = merged.map(drain).or_else(|| child.stdout.take().map(drain));
    let stderr = child.stderr.take().map(drain);
    let (status, timed_out) = wait(&mut child, call.timeout)?;
    // After a timeout a descendant may still hold the pipes: the readers are left behind
    // rather than letting them stretch the bound.
    let collect = |reader: Option<JoinHandle<Vec<u8>>>| {
        reader
            .filter(|_| !timed_out)
            .map(|handle| handle.join().unwrap_or_default())
            .unwrap_or_default()
    };
    let finished = Finished {
        status: status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
            .unwrap_or(128),
        stdout: collect(stdout),
        stderr: collect(stderr),
        timed_out,
    };
    if let Some(feeder) = feeder.filter(|_| !timed_out) {
        let _ = feeder.join();
    }
    Ok(finished)
}

/// Write the input and close the pipe; a child that stops reading ends the write quietly, as
/// the shell's `printf` does on `SIGPIPE`.
fn feed(mut stdin: ChildStdin, bytes: Vec<u8>) -> JoinHandle<()> {
    thread::spawn(move || {
        let _ = stdin.write_all(&bytes);
    })
}

fn drain(mut reader: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = reader.read_to_end(&mut output);
        output
    })
}

/// Wait for the exit, killing the child when the bound expires first.
fn wait(child: &mut Child, timeout: Option<Duration>) -> io::Result<(ExitStatus, bool)> {
    let Some(timeout) = timeout else {
        return Ok((child.wait()?, false));
    };
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((status, false));
        }
        if Instant::now() >= deadline {
            child.kill()?;
            return Ok((child.wait()?, true));
        }
        thread::sleep(Duration::from_millis(2));
    }
}
