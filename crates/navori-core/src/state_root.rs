//! The read-only half of `primitives/state-root.ts`: the physical checkout root and the symlink
//! checks a state directory or artifact must pass before it is read.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use crate::posix::js_trim;
use crate::process::Env;

/// Why a state root was refused (the TS throws; every caller treats it as a failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused;

/// Lexical `path.resolve(base, path)` on native paths.
fn lexical(base: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in base.join(path).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// `checkoutRoot(cwd)`: rejects any symlinked component of the requested path, asks git for the
/// top level and returns its real path, which must contain the requested directory.
///
/// `process_cwd` resolves a relative `cwd`; git runs with exactly `env`.
///
/// # Errors
/// [`Refused`] wherever the TS throws.
pub fn checkout_root(cwd: &Path, process_cwd: &Path, env: &Env) -> Result<PathBuf, Refused> {
    let requested = lexical(process_cwd, cwd);
    let mut current = PathBuf::from("/");
    for component in requested.components().skip(1) {
        current.push(component);
        let meta = fs::symlink_metadata(&current).map_err(|_| Refused)?;
        if meta.file_type().is_symlink() {
            return Err(Refused);
        }
    }
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&requested)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| Refused)?;
    if !output.status.success() {
        return Err(Refused);
    }
    let top = String::from_utf8_lossy(&output.stdout);
    let canonical = fs::canonicalize(js_trim(&top)).map_err(|_| Refused)?;
    let physical = fs::canonicalize(&requested).map_err(|_| Refused)?;
    if physical.starts_with(&canonical) {
        Ok(canonical)
    } else {
        Err(Refused)
    }
}

/// `hasSymlinkAncestor(root, target)`: true when `target` escapes `root` or any component below
/// `root` that exists (following links) is itself a symlink.
///
/// # Errors
/// [`Refused`] where `lstat` of an existing component fails.
pub fn has_symlink_ancestor(root: &Path, target: &Path) -> Result<bool, Refused> {
    let Ok(rest) = target.strip_prefix(root) else {
        return Ok(true);
    };
    let mut current = root.to_path_buf();
    for component in rest.components() {
        match component {
            Component::Normal(part) => current.push(part),
            Component::CurDir => continue,
            _ => return Ok(true),
        }
        if fs::metadata(&current).is_ok()
            && fs::symlink_metadata(&current)
                .map_err(|_| Refused)?
                .file_type()
                .is_symlink()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `containedDir(root, value)` for a relative `value` without `..`: the directory, or [`Refused`]
/// when a component is a symlink.
///
/// # Errors
/// [`Refused`] when the TS would throw.
pub fn contained_dir(root: &Path, value: &str) -> Result<PathBuf, Refused> {
    if value.starts_with('/') || value.split(['/', '\\']).any(|part| part == "..") {
        return Err(Refused);
    }
    let path = lexical(root, Path::new(value));
    if has_symlink_ancestor(root, &path)? {
        return Err(Refused);
    }
    Ok(path)
}
