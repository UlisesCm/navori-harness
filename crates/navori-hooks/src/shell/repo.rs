//! Repository and host facts the stateful shell code reads: `hook-input`'s project directory,
//! the `resolve-worktree` and `progress-ratchet` partials, and guard-destructive's rule 7
//! (discards) and tgrep search lane. The rules stay
//! pure; every fact arrives through [`Repo`], and [`System`] is the one adapter that runs
//! `git` or `tgrep`.

use std::cell::RefCell;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// What a discard destroys, as `_dsc_dirty` measures it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loss {
    /// Tracked changes: `git status --porcelain --untracked-files=no`.
    Tracked,
    /// Untracked, not ignored: `git ls-files --others --exclude-standard`.
    Untracked,
    /// Untracked including ignored (`clean -x`/`-X`): `git ls-files --others`.
    All,
}

/// Facts the shell reads from the host. Directories are passed as the shell spells them.
pub trait Repo {
    /// `[ -d dir ]`.
    fn is_dir(&self, dir: &str) -> bool;
    /// `_dsc_dirty dir kind`: `dir` is a git work tree holding what `loss` destroys.
    fn holds(&self, dir: &str, loss: Loss) -> bool;
    /// `git -C dir rev-parse --show-toplevel`, `None` on failure or empty output.
    fn toplevel(&self, dir: &str) -> Option<String>;
    /// `git -C dir rev-parse --show-superproject-working-tree`, `None` on failure.
    fn superproject(&self, dir: &str) -> Option<String>;
    /// `navori_repo_id`: the physical path of the shared git dir, `None` outside a work tree.
    fn repo_id(&self, dir: &str) -> Option<String>;
    /// `cd dir && pwd -P`, `None` when the `cd` fails.
    fn physical(&self, dir: &str) -> Option<String>;
    /// `git check-ignore -q -- path`, run from `root`.
    fn ignored(&self, root: &str, path: &str) -> bool;
    /// `[ -f path ]` and `wc -c <path` from `root`; 0 when either fails.
    fn file_size(&self, root: &str, path: &str) -> u64;
    /// `git cat-file -s <spec>` from `root`; 0 when it fails or prints no number.
    fn blob_size(&self, root: &str, spec: &str) -> u64;
    /// `[ -f path ]`.
    fn is_file(&self, path: &str) -> bool;
    /// `command -v tgrep` under `PATH`, then `tgrep status 2>&1`; `None` when tgrep is not
    /// found or the status command fails.
    fn tgrep_status(&self, path: Option<&str>) -> Option<String>;
}

/// The host's file system and `git`, read as the shell reads them. Residual: a non-empty
/// `CDPATH` can redirect the shell's relative `cd`; this adapter never consults it.
///
/// On a thread that [`Children::track_this_thread`] marked, every `git`/`tgrep` it starts is
/// recorded there, so whoever abandons that thread can kill them.
#[derive(Debug, Clone, Copy, Default)]
pub struct System;

/// The `git`/`tgrep` processes [`System`] started on one thread and has not reaped yet.
///
/// A deadline that abandons a rule (guard-destructive's `entry::evaluate_until`) calls
/// [`Children::stop`]: without it a hung `git` would outlive the hook process as an orphan.
#[derive(Debug, Default)]
pub struct Children(Mutex<Running>);

#[derive(Debug, Default)]
struct Running {
    /// No new child may start; one that started meanwhile kills itself.
    stopped: bool,
    pids: Vec<u32>,
}

thread_local! {
    static CHILDREN: RefCell<Option<Arc<Children>>> = const { RefCell::new(None) };
}

impl Children {
    fn running(&self) -> MutexGuard<'_, Running> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Record here every child [`System`] starts from now on on the calling thread.
    pub fn track_this_thread(self: &Arc<Self>) {
        CHILDREN.set(Some(Arc::clone(self)));
    }

    /// Kill (`SIGKILL`) every recorded child still running and refuse new ones. Best effort:
    /// it runs `kill`, since the standard library cannot signal a process by pid. A pid is
    /// dropped right after its child is reaped, so the window for a reused pid is that gap.
    pub fn stop(&self) {
        let pids = {
            let mut running = self.running();
            running.stopped = true;
            std::mem::take(&mut running.pids)
        };
        if pids.is_empty() {
            return;
        }
        let _ = Command::new("kill")
            .arg("-KILL")
            .args(pids.iter().map(u32::to_string))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// One started child, recorded in its thread's [`Children`] until dropped.
struct Tracked(Option<(Arc<Children>, u32)>);

impl Tracked {
    /// Record `child`; when the record is already stopped, kill and reap it instead.
    fn new(child: &mut Child) -> io::Result<Self> {
        let Some(children) = CHILDREN.with_borrow(Clone::clone) else {
            return Ok(Self(None));
        };
        let pid = child.id();
        {
            let mut running = children.running();
            if !running.stopped {
                running.pids.push(pid);
                drop(running);
                return Ok(Self(Some((children, pid))));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Err(io::Error::other("the evaluation was abandoned"))
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        if let Some((children, pid)) = &self.0 {
            children.running().pids.retain(|running| running != pid);
        }
    }
}

/// Whether this thread's [`Children`] refuses new children.
fn stopped() -> bool {
    CHILDREN.with_borrow(|children| children.as_ref().is_some_and(|c| c.running().stopped))
}

/// `command.output()`, recorded in this thread's [`Children`]. The caller sets every stream.
fn finish(command: &mut Command) -> io::Result<Output> {
    if stopped() {
        return Err(io::Error::other("the evaluation was abandoned"));
    }
    let mut child = command.spawn()?;
    let _tracked = Tracked::new(&mut child)?;
    child.wait_with_output()
}

/// `$(…)`: stdout with every trailing newline dropped, `None` when the command fails.
fn capture(command: &mut Command) -> Option<String> {
    let output = finish(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.trim_end_matches('\n').to_owned())
}

fn git_in(dir: &str) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir);
    command
}

fn git_from(root: &str) -> Command {
    let mut command = Command::new("git");
    command.current_dir(root);
    command
}

/// `command -v name`: the first executable regular file named `name` along `path`; an empty
/// entry is the working directory.
fn which(name: &str, path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    path.split(':')
        .map(|dir| Path::new(if dir.is_empty() { "." } else { dir }).join(name))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

/// The logical path `cd` reaches: `..` pops a component of the text, as bash does.
fn logical(base: &Path, rel: &Path) -> PathBuf {
    let mut out = if rel.is_absolute() {
        PathBuf::new()
    } else {
        base.to_path_buf()
    };
    for component in rel.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `cd a && cd b && pwd -P`: logical first, physical fallback, then the physical name.
fn enter(dir: &str, then: &str) -> Option<String> {
    if dir.is_empty() {
        return None;
    }
    let pwd = std::env::var_os("PWD")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::current_dir().ok())?;
    let first = logical(&pwd, Path::new(dir));
    let first = if first.is_dir() {
        first
    } else {
        std::fs::canonicalize(dir).ok()?
    };
    let target = logical(&first, Path::new(then));
    let target = if target.is_dir() {
        target
    } else {
        std::fs::canonicalize(&first).ok()?.join(then)
    };
    let physical = std::fs::canonicalize(target).ok()?;
    physical
        .is_dir()
        .then(|| physical.to_string_lossy().into_owned())
}

impl Repo for System {
    fn is_dir(&self, dir: &str) -> bool {
        !dir.is_empty() && Path::new(dir).is_dir()
    }

    fn holds(&self, dir: &str, loss: Loss) -> bool {
        let inside = finish(
            git_in(dir)
                .args(["rev-parse", "--git-dir"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .is_ok_and(|out| out.status.success());
        if !inside {
            return false;
        }
        let mut command = git_in(dir);
        match loss {
            Loss::Tracked => command.env("GIT_OPTIONAL_LOCKS", "0").args([
                "status",
                "--porcelain",
                "--untracked-files=no",
            ]),
            Loss::Untracked => command.args(["ls-files", "--others", "--exclude-standard"]),
            Loss::All => command.args(["ls-files", "--others"]),
        };
        // `[ -n "$(…)" ]` and `head -n 1` ignore git's exit status.
        finish(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        )
        .is_ok_and(|out| out.stdout.iter().any(|b| *b != b'\n'))
    }

    fn toplevel(&self, dir: &str) -> Option<String> {
        capture(git_in(dir).args(["rev-parse", "--show-toplevel"])).filter(|t| !t.is_empty())
    }

    fn superproject(&self, dir: &str) -> Option<String> {
        capture(git_in(dir).args(["rev-parse", "--show-superproject-working-tree"]))
    }

    fn repo_id(&self, dir: &str) -> Option<String> {
        let common = capture(git_in(dir).args(["rev-parse", "--git-common-dir"]))?;
        if common.is_empty() {
            return None;
        }
        enter(dir, &common)
    }

    fn physical(&self, dir: &str) -> Option<String> {
        enter(dir, ".")
    }

    fn ignored(&self, root: &str, path: &str) -> bool {
        finish(
            git_from(root)
                .args(["check-ignore", "-q", "--", path])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .is_ok_and(|out| out.status.success())
    }

    fn file_size(&self, root: &str, path: &str) -> u64 {
        let path = Path::new(root).join(path);
        if !path.is_file() {
            return 0;
        }
        File::open(&path)
            .and_then(|file| file.metadata())
            .map_or(0, |meta| meta.len())
    }

    fn is_file(&self, path: &str) -> bool {
        !path.is_empty() && Path::new(path).is_file()
    }

    fn tgrep_status(&self, path: Option<&str>) -> Option<String> {
        let program = which("tgrep", path?)?;
        if stopped() {
            return None;
        }
        let (mut reader, writer) = std::io::pipe().ok()?;
        let mut child = Command::new(program)
            .arg("status")
            .env("PATH", path?)
            .stdin(Stdio::null())
            .stdout(writer.try_clone().ok()?)
            .stderr(writer)
            .spawn()
            .ok()?;
        let _tracked = Tracked::new(&mut child).ok()?;
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut out).ok()?;
        child.wait().ok()?.success().then(|| {
            String::from_utf8_lossy(&out)
                .trim_end_matches('\n')
                .to_owned()
        })
    }

    fn blob_size(&self, root: &str, spec: &str) -> u64 {
        capture(git_from(root).args(["cat-file", "-s", spec]))
            .and_then(|text| {
                (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| text.parse().ok())
                    .flatten()
            })
            .unwrap_or(0)
    }
}
