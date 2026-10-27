//! Repository and file-system facts the stateful rules read: rule 7 (discards) and rule 1b
//! (the progress ratchet with its landing and worktree resolution). The rules stay pure; every
//! fact arrives through [`Repo`], and [`System`] is the one adapter that runs `git`.

use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

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
}

/// The host's file system and `git`, read as the shell reads them. Residual: a non-empty
/// `CDPATH` can redirect the shell's relative `cd`; this adapter never consults it.
#[derive(Debug, Clone, Copy, Default)]
pub struct System;

/// `$(…)`: stdout with every trailing newline dropped, `None` when the command fails.
fn capture(command: &mut Command) -> Option<String> {
    let output = command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
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
        let inside = git_in(dir)
            .args(["rev-parse", "--git-dir"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
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
        command
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
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
        git_from(root)
            .args(["check-ignore", "-q", "--", path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
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
