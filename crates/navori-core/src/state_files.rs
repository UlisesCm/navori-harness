//! The reporting half of `primitives/state-root.ts`: `resolveStateRoot`, `stateArtifactPath` and
//! `writeStateFileAtomic` with the messages the TS throws, for the commands that print them
//! (`handoff render`, `handoff log-review`).
//!
//! Paths are handled as UTF-8 text, as the TS prints them. Whatever this port does not reproduce
//! exactly (a non-UTF-8 path, an `lstat` error other than `ENOENT`/`ENOTDIR`, git that cannot
//! start, a `realpath` failure) is [`Refusal::Unmodeled`]: the caller hands the invocation to the
//! TS before any output or write.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

use regex::Regex;

use crate::fs::{Fs, Syscall, node_message};
use crate::js_json::JsValue;
use crate::js_re::non_ws;
use crate::posix::{js_trim, relative, resolve};

/// `FEATURE_SLUG`.
#[must_use]
pub fn is_feature_slug(feature: &str) -> bool {
    let mut chars = feature.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
}

const NEUTRAL_DIR: &str = ".navori/state/handoffs";
const LEGACY_DIRS: [&str; 2] = [".claude/progress", ".codex/progress"];

/// Why a state root or artifact was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The TS throws an `Error` with this message.
    Message(String),
    /// The TS behaves in a way this port does not model.
    Unmodeled,
}

type Refused<T> = Result<T, Refusal>;

fn message<T>(text: String) -> Refused<T> {
    Err(Refusal::Message(text))
}

/// A resolved state root (`StateRoot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateRoot {
    /// The physical checkout root.
    pub cwd: String,
    /// `relative(cwd, path) || "."`.
    pub dir: String,
    /// The state directory.
    pub path: String,
}

fn utf8(path: &Path) -> Refused<String> {
    path.to_str().map(str::to_owned).ok_or(Refusal::Unmodeled)
}

fn exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}

fn is_symlink(path: &str) -> Refused<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.file_type().is_symlink()),
        Err(_) => Err(Refusal::Unmodeled),
    }
}

fn escapes(rel: &str) -> bool {
    rel == ".." || rel.starts_with("../") || rel.starts_with('/')
}

/// `hasSymlinkAncestor(root, target)`.
fn has_symlink_ancestor(root: &str, target: &str) -> Refused<bool> {
    let rel = relative(root, target);
    if escapes(&rel) {
        return Ok(true);
    }
    let mut current = root.to_owned();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        current = resolve(&current, part);
        if exists(&current) && is_symlink(&current)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Node's `error.message` for a failed `lstatSync`, for the two errnos a missing `--cwd` gives.
fn lstat_message(error: &io::Error, path: &str) -> Refused<String> {
    match error.raw_os_error() {
        Some(2) => Ok(format!("ENOENT: no such file or directory, lstat '{path}'")),
        Some(20) => Ok(format!("ENOTDIR: not a directory, lstat '{path}'")),
        _ => Err(Refusal::Unmodeled),
    }
}

/// `checkoutRoot(cwd)`: `cwd` as the TS received it, resolved against `process_cwd`.
fn checkout_root(cwd: &str, process_cwd: &str) -> Refused<String> {
    let requested = resolve(process_cwd, cwd);
    let mut current = String::new();
    for part in requested.split('/').filter(|p| !p.is_empty()) {
        current = format!("{current}/{part}");
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return message(format!("symlinked --cwd is not allowed: {cwd}"));
            }
            Ok(_) => {}
            Err(error) => return message(lstat_message(&error, &current)?),
        }
    }
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&requested)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| Refusal::Unmodeled)?;
    if !output.status.success() {
        return message(format!("--cwd is not a Git checkout: {cwd}"));
    }
    let top = std::str::from_utf8(&output.stdout).map_err(|_| Refusal::Unmodeled)?;
    let canonical = utf8(&fs::canonicalize(js_trim(top)).map_err(|_| Refusal::Unmodeled)?)?;
    let physical = utf8(&fs::canonicalize(&requested).map_err(|_| Refusal::Unmodeled)?)?;
    if escapes(&relative(&canonical, &physical)) {
        return message(format!("--cwd is outside its Git checkout: {cwd}"));
    }
    Ok(canonical)
}

/// `containedDir(root, value)`: `(path, dir)`.
fn contained_dir(root: &str, value: &str) -> Refused<(String, String)> {
    let absolute = value.starts_with('/');
    if !absolute && value.split(['/', '\\']).any(|part| part == "..") {
        return message(format!("state directory contains traversal: {value}"));
    }
    let path = resolve(root, value);
    let rel = relative(root, &path);
    if escapes(&rel) {
        return message(format!("state directory escapes checkout: {value}"));
    }
    if has_symlink_ancestor(root, &path)? {
        return message(format!("state directory contains a symlink: {value}"));
    }
    let dir = if rel.is_empty() { ".".to_owned() } else { rel };
    Ok((path, dir))
}

/// `stateArtifactPath(root, name)` for a `name` without separators (the callers build it from a
/// valid slug).
///
/// # Errors
/// The TS's message when the artifact escapes the checkout.
pub fn artifact_path(root: &StateRoot, name: &str) -> Result<String, Refusal> {
    if name.contains('/') || name.contains('\\') || name.is_empty() || name == "." || name == ".." {
        return Err(Refusal::Unmodeled);
    }
    let path = resolve(&root.path, name);
    if has_symlink_ancestor(&root.cwd, &path)? {
        return message(format!("state artifact escapes checkout: {name}"));
    }
    Ok(path)
}

fn receipt_owner(text: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r"^# navori-receipt v[0-9]+ feature=({}+)",
        non_ws()
    ))
    .ok()?;
    pattern
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

/// `rootMatches(root, feature)`.
fn root_matches(root: &StateRoot, feature: &str) -> Refused<bool> {
    if !exists(&root.path) || is_symlink(&root.path)? {
        return Ok(false);
    }
    for name in [
        format!("workplan_{feature}.json"),
        format!("workplan_{feature}.md"),
        format!("impl_{feature}.json"),
        format!("impl_{feature}.md"),
        format!("review_{feature}.md"),
        format!("workplan_{feature}.gate.jsonl"),
    ] {
        if exists(&artifact_path(root, &name)?) {
            return Ok(true);
        }
    }
    for name in ["receipt.txt", "receipt.consumed.txt"] {
        let path = artifact_path(root, name)?;
        if !exists(&path) {
            continue;
        }
        let bytes = fs::read(&path).map_err(|_| Refusal::Unmodeled)?;
        let text = String::from_utf8(bytes).map_err(|_| Refusal::Unmodeled)?;
        if receipt_owner(&text).as_deref() == Some(feature) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `resolveStateRoot({ cwd, feature, dir })`, with `cwd` as the TS received it.
///
/// # Errors
/// The message the TS throws, or [`Refusal::Unmodeled`].
pub fn resolve_state_root(
    cwd: &str,
    process_cwd: &str,
    feature: &str,
    dir: Option<&str>,
) -> Result<StateRoot, Refusal> {
    if !is_feature_slug(feature) {
        let quoted = JsValue::string(feature)
            .stringify(None)
            .ok_or(Refusal::Unmodeled)?;
        return message(format!("invalid feature slug: {quoted}"));
    }
    let cwd = checkout_root(cwd, process_cwd)?;
    let root = |(path, dir): (String, String)| StateRoot {
        cwd: cwd.clone(),
        dir,
        path,
    };
    if let Some(dir) = dir {
        return contained_dir(&cwd, dir).map(root);
    }
    let neutral = root(contained_dir(&cwd, NEUTRAL_DIR)?);
    if root_matches(&neutral, feature)? {
        return Ok(neutral);
    }
    let mut legacy = Vec::new();
    for dir in LEGACY_DIRS {
        let candidate = root(contained_dir(&cwd, dir)?);
        if root_matches(&candidate, feature)? {
            legacy.push(candidate);
        }
    }
    match legacy.len() {
        0 => Ok(neutral),
        1 => Ok(legacy.remove(0)),
        _ => message(format!(
            "multiple legacy state roots match feature \"{feature}\"; pass --dir explicitly"
        )),
    }
}

/// The directories `ensureStateDirectory` would create, or the message it throws, computed
/// without writing.
///
/// # Errors
/// The message `ensureStateDirectory` throws, or [`Refusal::Unmodeled`].
pub fn plan_state_dirs(root: &StateRoot) -> Result<Vec<String>, Refusal> {
    let rel = relative(&root.cwd, &root.path);
    if escapes(&rel) {
        return message(format!("state directory escapes checkout: {}", root.path));
    }
    let mut missing = Vec::new();
    let mut current = root.cwd.clone();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        current = resolve(&current, part);
        if !missing.is_empty() || !exists(&current) {
            missing.push(current.clone());
            continue;
        }
        let meta = fs::symlink_metadata(&current).map_err(|_| Refusal::Unmodeled)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return message(format!(
                "state directory contains an unsafe component: {current}"
            ));
        }
    }
    Ok(missing)
}

/// A write `writeStateFileAtomic` would do, planned before the first byte (D24).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateWrite {
    mkdirs: Vec<String>,
    temporary: String,
    destination: String,
}

impl StateWrite {
    /// The artifact the write replaces (`stateArtifactPath(root, name)`).
    #[must_use]
    pub fn destination(&self) -> &str {
        &self.destination
    }
}

/// Plans `writeStateFileAtomic(root, name, _)`: `Ok(Err(message))` is what the TS throws before
/// it creates anything.
///
/// # Errors
/// [`Refusal::Unmodeled`] where the TS would behave in a way this port does not model (a stale
/// temporary, which `wx` refuses).
pub fn plan_state_write(
    root: &StateRoot,
    name: &str,
    pid: u32,
) -> Result<Result<StateWrite, String>, Refusal> {
    let planned = (|| -> Refused<StateWrite> {
        let mkdirs = plan_state_dirs(root)?;
        let destination = artifact_path(root, name)?;
        let temporary = artifact_path(root, &format!(".{name}.tmp-{pid}"))?;
        if fs::symlink_metadata(&temporary).is_ok() {
            return Err(Refusal::Unmodeled);
        }
        Ok(StateWrite {
            mkdirs,
            temporary,
            destination,
        })
    })();
    match planned {
        Ok(write) => Ok(Ok(write)),
        Err(Refusal::Message(text)) => Ok(Err(text)),
        Err(Refusal::Unmodeled) => Err(Refusal::Unmodeled),
    }
}

/// Runs a planned `writeStateFileAtomic` over `fs`: the missing directories one by one, an
/// exclusive temporary with mode `0644`, `fsync`, `close` and `rename`.
///
/// # Errors
/// Node's `error.message` for the failed call; the temporary is removed first.
pub fn write_state_file(fs: &mut dyn Fs, write: &StateWrite, content: &str) -> Result<(), String> {
    for dir in &write.mkdirs {
        fs.mkdir_all(Path::new(dir))
            .map_err(|e| node_message(&e, Syscall::Mkdir, Path::new(dir), None))?;
    }
    let temporary = Path::new(&write.temporary);
    let destination = Path::new(&write.destination);
    let file = fs
        .create(temporary, 0o644)
        .map_err(|e| node_message(&e, Syscall::Open, temporary, None))?;
    let result = (|| -> Result<(), String> {
        let written = fs
            .write(file, content.as_bytes())
            .map_err(|e| node_message(&e, Syscall::Write, temporary, None))
            .and_then(|()| {
                fs.fsync(file)
                    .map_err(|e| node_message(&e, Syscall::Fsync, temporary, None))
            });
        let closed = fs
            .close(file)
            .map_err(|e| node_message(&e, Syscall::Close, temporary, None));
        closed.and(written)?;
        fs.rename(temporary, destination)
            .map_err(|e| node_message(&e, Syscall::Rename, temporary, Some(destination)))
    })();
    if result.is_err() {
        let _ = fs.remove(temporary, false);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn feature_slug_matches_the_ts_pattern() {
        for ok in ["a", "0", "a-b.c_d", "t10"] {
            assert!(is_feature_slug(ok), "{ok}");
        }
        for bad in ["", "-a", ".a", "A", "a/b", "a b", "ñ"] {
            assert!(!is_feature_slug(bad), "{bad}");
        }
    }

    // Covers: R73
    #[test]
    fn receipt_owner_reads_the_first_line_only() {
        assert_eq!(
            receipt_owner("# navori-receipt v2 feature=x y\n").as_deref(),
            Some("x")
        );
        assert_eq!(receipt_owner("\n# navori-receipt v2 feature=x\n"), None);
    }
}
