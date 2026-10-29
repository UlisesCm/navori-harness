//! `navori-content/v1`, port of `primitives/content-identity.ts` (spec 0042 R16, D5).
//!
//! The fingerprint is a sha256 over the working tree (or, for [`index`], over the index): every
//! tracked or untracked-not-ignored regular file as `<mode> <blob>\t<path>\0`, ordered by the bytes
//! of the path, behind the `navori-content/v1\n` header. Git runs hardened and read-only
//! (`core.fsmonitor=false`, `core.hooksPath=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `hash-object`
//! without `-w`). Failures are values, never a partial hash.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::posix::js_trim;
use crate::process::{self, Env};

/// Name of the algorithm, also the first line of the hashed text.
pub const CONTENT_ALG: &str = "navori-content/v1";
/// Ceiling on the summed size of hashed files (256 MiB).
pub const CONTENT_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Wall-clock budget of one identity pass.
pub const CONTENT_TIMEOUT: Duration = Duration::from_secs(30);

/// State and sibling-worktree paths never part of the identity (`IDENTITY_EXCLUDES`).
pub const IDENTITY_EXCLUDES: &[&str] = &[
    ".claude/progress",
    ".codex/progress",
    ".navori/state",
    "progress",
    ".claude/worktrees",
];

/// Why an identity could not be computed (`ContentIdentityFailure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// `cwd` is not inside a work tree.
    NotACheckout,
    /// A path holds a line break or undecodable bytes.
    UnsafePath,
    /// The index has conflict stages.
    UnmergedIndex,
    /// Git failed or answered something unexpected.
    GitFailed,
    /// The hashed files exceed [`CONTENT_MAX_BYTES`].
    TooLarge,
    /// The pass outlived [`CONTENT_TIMEOUT`].
    Timeout,
}

/// The working-tree identity (`contentIdentity` without a target branch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// Hex sha256 of the hashed text.
    pub fingerprint: String,
    /// `HEAD` commit.
    pub head: String,
    /// Staged blobs differ from the working tree (informational, outside the hash).
    pub index_diverges: bool,
}

fn is_excluded(path: &str) -> bool {
    IDENTITY_EXCLUDES
        .iter()
        .any(|dir| path == *dir || path.strip_prefix(dir).is_some_and(|r| r.starts_with('/')))
}

fn is_unsafe(path: &str) -> bool {
    path.contains(['\r', '\n', '\u{fffd}'])
}

fn is_null_sha(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b == b'0')
}

/// One hardened, read-only git call within the remaining budget; `None` is a tolerated failure.
fn git(
    cwd: &Path,
    env: &Env,
    args: &[&str],
    deadline: Instant,
    input: Option<&[u8]>,
    allow_failure: bool,
) -> Result<Option<String>, Failure> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(Failure::Timeout);
    }
    let mut full: Vec<&str> = vec![
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
    ];
    full.extend_from_slice(args);
    let mut child_env: Vec<(OsString, OsString)> = env
        .iter()
        .filter(|(key, _)| key != "GIT_OPTIONAL_LOCKS")
        .cloned()
        .collect();
    child_env.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
    let output = match process::run("git", &full, cwd, &child_env, input, remaining) {
        Ok(output) => output,
        Err(process::Failure::Timeout) => return Err(Failure::Timeout),
        Err(process::Failure::Spawn(_)) => return Err(Failure::GitFailed),
    };
    if !output.status.success() {
        return if allow_failure {
            Ok(None)
        } else {
            Err(Failure::GitFailed)
        };
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

fn required(text: Option<String>) -> Result<String, Failure> {
    text.ok_or(Failure::GitFailed)
}

fn is_work_tree(cwd: &Path, env: &Env, deadline: Instant) -> Result<bool, Failure> {
    let answer = git(
        cwd,
        env,
        &["rev-parse", "--is-inside-work-tree"],
        deadline,
        None,
        true,
    )?;
    Ok(answer.is_some_and(|text| js_trim(&text) == "true"))
}

fn fingerprint(mut lines: Vec<(String, String)>) -> String {
    lines.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut hash = Sha256::new();
    hash.update(format!("{CONTENT_ALG}\n").as_bytes());
    for (_, line) in &lines {
        hash.update(line.as_bytes());
    }
    hex(&hash.finalize())
}

/// Lowercase hex of `bytes`.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

struct Entry {
    mode: &'static str,
    blob: String,
}

/// `contentIdentity(cwd)`: the working-tree identity of the checkout at `cwd`, git run with `env`.
///
/// # Errors
/// The [`Failure`] that made the identity unavailable.
pub fn working(cwd: &Path, env: &Env) -> Result<Identity, Failure> {
    working_within(cwd, env, CONTENT_TIMEOUT, CONTENT_MAX_BYTES)
}

/// [`working`] with an explicit budget and size ceiling.
///
/// # Errors
/// The [`Failure`] that made the identity unavailable.
pub fn working_within(
    cwd: &Path,
    env: &Env,
    timeout: Duration,
    max_bytes: u64,
) -> Result<Identity, Failure> {
    let deadline = Instant::now() + timeout;
    if !is_work_tree(cwd, env, deadline)? {
        return Err(Failure::NotACheckout);
    }
    if !required(git(
        cwd,
        env,
        &["ls-files", "-u", "-z"],
        deadline,
        None,
        false,
    )?)?
    .is_empty()
    {
        return Err(Failure::UnmergedIndex);
    }
    let head = git(
        cwd,
        env,
        &["rev-parse", "--verify", "-q", "HEAD"],
        deadline,
        None,
        true,
    )?
    .map(|text| js_trim(&text).to_owned())
    .filter(|head| !head.is_empty())
    .ok_or(Failure::GitFailed)?;

    let excludes: Vec<String> = IDENTITY_EXCLUDES
        .iter()
        .map(|path| format!(":(exclude,literal){path}"))
        .collect();
    let mut list_args = vec![
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
        "--",
        ".",
    ];
    list_args.extend(excludes.iter().map(String::as_str));
    let listed = required(git(cwd, env, &list_args, deadline, None, false)?)?;

    let mut files: Vec<(&str, &'static str)> = Vec::new();
    let mut links: Vec<(&str, String)> = Vec::new();
    let mut bytes: u64 = 0;
    for path in listed.split('\0').filter(|p| !p.is_empty()) {
        if is_unsafe(path) {
            return Err(Failure::UnsafePath);
        }
        let full = cwd.join(path);
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(Failure::GitFailed),
        };
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&full).map_err(|_| Failure::GitFailed)?;
            links.push((path, target.to_string_lossy().into_owned()));
        } else if meta.is_file() {
            bytes += meta.len();
            if bytes > max_bytes {
                return Err(Failure::TooLarge);
            }
            let executable = meta.permissions().mode() & 0o111 != 0;
            files.push((path, if executable { "100755" } else { "100644" }));
        }
    }

    let mut entries: HashMap<&str, Entry> = HashMap::new();
    if !files.is_empty() {
        // `./` keeps a leading `"` from being read as a quoted path by --stdin-paths.
        let input: String = files
            .iter()
            .map(|(path, _)| format!("./{path}\n"))
            .collect();
        let shas = required(git(
            cwd,
            env,
            &["hash-object", "--no-filters", "--stdin-paths"],
            deadline,
            Some(input.as_bytes()),
            false,
        )?)?;
        let shas: Vec<&str> = shas.split('\n').filter(|s| !s.is_empty()).collect();
        if shas.len() != files.len() {
            return Err(Failure::GitFailed);
        }
        for ((path, mode), blob) in files.iter().zip(shas) {
            entries.insert(
                path,
                Entry {
                    mode,
                    blob: blob.to_owned(),
                },
            );
        }
    }
    for (path, target) in &links {
        let blob = git(
            cwd,
            env,
            &["hash-object", "--no-filters", "--stdin"],
            deadline,
            Some(target.as_bytes()),
            false,
        )?
        .map(|text| js_trim(&text).to_owned())
        .filter(|blob| !blob.is_empty())
        .ok_or(Failure::GitFailed)?;
        entries.insert(
            path,
            Entry {
                mode: "120000",
                blob,
            },
        );
    }

    let lines = entries
        .iter()
        .map(|(path, entry)| {
            (
                (*path).to_owned(),
                format!("{} {}\t{path}\0", entry.mode, entry.blob),
            )
        })
        .collect();
    let fingerprint = fingerprint(lines);
    let staged = required(git(
        cwd,
        env,
        &[
            "diff-index",
            "--cached",
            "--raw",
            "-z",
            "--no-renames",
            &head,
        ],
        deadline,
        None,
        false,
    )?)?;
    Ok(Identity {
        fingerprint,
        index_diverges: diverges(&staged, &entries),
        head,
    })
}

/// Parses `diff-index --raw -z` (`:om nm osha nsha S\0path\0`) against the working tree.
fn diverges(raw: &str, working: &HashMap<&str, Entry>) -> bool {
    let parts: Vec<&str> = raw.split('\0').collect();
    let mut i = 0;
    while i + 1 < parts.len() {
        let meta: Vec<&str> = parts[i].split(' ').collect();
        let staged = meta.get(3).copied().unwrap_or("");
        let path = parts[i + 1];
        i += 2;
        if meta.first() == Some(&":160000") || meta.get(1) == Some(&"160000") || is_excluded(path) {
            continue;
        }
        let live = working.get(path);
        let differs = if is_null_sha(staged) {
            live.is_some()
        } else {
            live.is_none_or(|entry| entry.blob != staged)
        };
        if differs {
            return true;
        }
    }
    false
}

/// `indexContentIdentity(cwd)`: the same fingerprint over the index (`git ls-files -s`, which
/// honours an inherited `GIT_INDEX_FILE`), the bytes a commit would record.
///
/// # Errors
/// The [`Failure`] that made the identity unavailable.
pub fn index(cwd: &Path, env: &Env) -> Result<String, Failure> {
    let deadline = Instant::now() + CONTENT_TIMEOUT;
    if !is_work_tree(cwd, env, deadline)? {
        return Err(Failure::NotACheckout);
    }
    let listed = required(git(
        cwd,
        env,
        &["ls-files", "-s", "-z"],
        deadline,
        None,
        false,
    )?)?;
    let mut lines = Vec::new();
    for record in listed.split('\0').filter(|r| !r.is_empty()) {
        let Some(tab) = record.find('\t') else {
            return Err(Failure::GitFailed);
        };
        let mut meta = record[..tab].split(' ');
        let mode = meta.next().unwrap_or("");
        let blob = meta.next().unwrap_or("");
        let stage = meta.next().unwrap_or("");
        let path = &record[tab + 1..];
        if !matches!(stage, "0" | "1" | "2" | "3") {
            return Err(Failure::GitFailed);
        }
        if stage != "0" {
            return Err(Failure::UnmergedIndex);
        }
        if mode == "160000" || is_excluded(path) {
            continue;
        }
        if is_unsafe(path) {
            return Err(Failure::UnsafePath);
        }
        lines.push((path.to_owned(), format!("{mode} {blob}\t{path}\0")));
    }
    Ok(fingerprint(lines))
}
