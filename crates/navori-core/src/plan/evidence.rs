//! The tree fingerprint and HEAD behind recorded acceptance evidence (`lib/plan/evidence.ts`,
//! spec 0060 T10/T11 and the delivery commands of T8). Git runs through a
//! [`ProcessRunner`] (D42) with the TS's hardening flags.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::content_identity::{IDENTITY_EXCLUDES, hex};
use crate::process::{Env, ProcessRunner, Request};

/// `FINGERPRINT_VERSION`: the `fp` an evidence line records for the current exclude set.
pub const FINGERPRINT_VERSION: u32 = 2;

/// The exclude set of evidence lines recorded before `fp` existed.
const LEGACY_FINGERPRINT_EXCLUDES: &[&str] = &[
    ".navori/state",
    ".claude/progress",
    ".codex/progress",
    ".claude/worktrees",
];

/// `PURE_EVIDENCE_RUNNERS`: test runners whose result does not depend on HEAD.
const PURE_EVIDENCE_RUNNERS: &[&[&str]] = &[
    &["bun", "run", "test"],
    &["bun", "run", "test:golden"],
    &["bun", "x", "vitest", "run"],
];

/// `/^[\w@.:/=,+%-]+$/`.
fn pure_arg(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_@.:/=,+%-".contains(&b))
}

/// `/^cd[ \t]+([^\s&;|<>$`"'\\*?[\]{}()~]+)$/`: the directory of a plain `cd`.
fn cd_dir(segment: &str) -> Option<&str> {
    let rest = segment.strip_prefix("cd")?;
    let dir = rest.trim_start_matches([' ', '\t']);
    if dir.len() == rest.len() || dir.is_empty() {
        return None;
    }
    let bad =
        |c: char| crate::integrity::is_js_whitespace(c) || "&;|<>$`\"'\\*?[]{}()~".contains(c);
    (!dir.contains(bad)).then_some(dir)
}

/// `isPureEvidenceRunner`: `cd <relative dir> && … && <pure runner> [args]`, nothing else.
#[must_use]
pub fn is_pure_evidence_runner(command: &str) -> bool {
    if command.contains([
        ';', '|', '$', '`', '<', '>', '(', ')', '\n', '\r', '\\', '\'', '"',
    ]) || command.replace("&&", "").contains('&')
    {
        return false;
    }
    let mut segments: Vec<&str> = command.split("&&").map(crate::posix::js_trim).collect();
    let runner = segments.pop().unwrap_or_default();
    for segment in segments {
        let Some(dir) = cd_dir(segment) else {
            return false;
        };
        if dir.starts_with('/')
            || dir
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return false;
        }
    }
    // `runner.split(/\s+/)` on a trimmed runner: whitespace runs collapse, and an empty runner
    // is `[""]`, which no token rule accepts.
    let tokens: Vec<&str> = runner
        .split(crate::integrity::is_js_whitespace)
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() || !tokens.iter().all(|t| pure_arg(t)) {
        return false;
    }
    PURE_EVIDENCE_RUNNERS.iter().any(|prefix| {
        prefix
            .iter()
            .enumerate()
            .all(|(i, w)| tokens.get(i) == Some(w))
    })
}

/// What git calls, with the TS's hardening flags and remaining budget.
pub struct Git<'a> {
    /// The transport.
    pub runner: &'a dyn ProcessRunner,
    /// The environment the TS process would hand to git.
    pub env: &'a Env,
    /// Absolute deadline, if any.
    pub deadline: Option<Instant>,
}

impl Git<'_> {
    fn remaining(&self) -> Option<Duration> {
        match self.deadline {
            None => Some(Duration::from_secs(60 * 60)),
            Some(deadline) => {
                let now = Instant::now();
                (now < deadline).then(|| (deadline - now).max(Duration::from_millis(1)))
            }
        }
    }

    /// `git(cwd, args)`: stdout bytes, or `None` on any failure or an expired deadline.
    fn run(&self, cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
        let timeout = self.remaining()?;
        let mut full = vec![
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ];
        full.extend_from_slice(args);
        let output = self
            .runner
            .run(&Request {
                program: "git",
                args: &full,
                cwd,
                env: self.env,
                input: None,
                timeout,
            })
            .ok()?;
        output.status.success().then_some(output.stdout)
    }

    fn expired(&self) -> bool {
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }
}

/// `readHead(tree)`: `git rev-parse HEAD`, trimmed, or empty.
#[must_use]
pub fn read_head(git: &Git<'_>, tree: &Path) -> String {
    git.run(tree, &["rev-parse", "HEAD"])
        .map(|out| crate::posix::js_trim(&String::from_utf8_lossy(&out)).to_owned())
        .unwrap_or_default()
}

/// `Fingerprint`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fingerprint {
    /// The tree hash git would write for the working tree.
    Ok(String),
    /// Why it could not be computed.
    Failed(String),
}

fn failed(reason: &str) -> Fingerprint {
    Fingerprint::Failed(reason.to_owned())
}

#[derive(Clone, Copy)]
enum Format {
    Sha1,
    Sha256,
}

impl Format {
    fn digest(self, parts: &[&[u8]]) -> String {
        match self {
            Self::Sha1 => {
                let mut h = Sha1::new();
                for p in parts {
                    h.update(p);
                }
                hex(&h.finalize())
            }
            Self::Sha256 => {
                let mut h = Sha256::new();
                for p in parts {
                    h.update(p);
                }
                hex(&h.finalize())
            }
        }
    }

    fn blob(self, bytes: &[u8]) -> String {
        self.digest(&[format!("blob {}\0", bytes.len()).as_bytes(), bytes])
    }
}

/// `realpathSync`, or `None`.
fn real(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Options of `fingerprintTree`.
#[derive(Debug, Clone, Copy, Default)]
pub struct FingerprintOptions<'a> {
    /// `binding.stagePath` of a delivery: its `state.json` and `STATUS.md` are excluded.
    pub stage_path: Option<&'a str>,
    /// The exclude set of evidence recorded before `fp`.
    pub legacy: bool,
}

/// `DeliveryEvidenceBindingSchema.shape.stagePath`: relative, no empty, `.` or `..` segment,
/// no tab, CR, LF or backslash.
fn valid_stage_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\t', '\r', '\n', '\\'])
        && !path.starts_with('/')
        && !path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
}

/// `fingerprintTree(tree, binding, options)`: the git tree hash of the working tree (tracked
/// plus untracked, not ignored), without the state directories.
#[must_use]
pub fn fingerprint_tree(
    git: &Git<'_>,
    tree: &Path,
    options: FingerprintOptions<'_>,
) -> Fingerprint {
    let base = if options.legacy {
        LEGACY_FINGERPRINT_EXCLUDES
    } else {
        IDENTITY_EXCLUDES
    };
    let mut excludes: Vec<String> = base.iter().map(|e| (*e).to_owned()).collect();
    if let Some(stage_path) = options.stage_path {
        if !valid_stage_path(stage_path) {
            return failed("invalid delivery binding");
        }
        let root = real(tree);
        let stage = root.as_ref().map(|r| r.join(stage_path));
        let contained = match (&root, &stage) {
            (Some(root), Some(stage)) => {
                stage.starts_with(root) && stage != root && real(stage).as_ref() == Some(stage)
            }
            _ => false,
        };
        let (Some(_), Some(stage), true) = (root, stage, contained) else {
            return failed("delivery stage is not physically contained");
        };
        for name in ["state.json", "STATUS.md"] {
            let path = stage.join(name);
            if (name == "state.json" || path.exists()) && real(&path).as_ref() != Some(&path) {
                return failed("delivery lifecycle file is missing or redirected");
            }
            excludes.push(format!("{stage_path}/{name}"));
        }
    }
    let format = match git
        .run(tree, &["rev-parse", "--show-object-format"])
        .map(|out| crate::posix::js_trim(&String::from_utf8_lossy(&out)).to_owned())
        .as_deref()
    {
        Some("sha1") => Format::Sha1,
        Some("sha256") => Format::Sha256,
        _ => return failed("not a readable git checkout"),
    };
    let patterns: Vec<String> = excludes
        .iter()
        .map(|p| format!(":(exclude,literal){p}"))
        .collect();
    let mut args = vec![
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
        "--",
        ".",
    ];
    args.extend(patterns.iter().map(String::as_str));
    let Some(listed) = git.run(tree, &args) else {
        return failed("git ls-files failed");
    };
    let mut entries = Vec::new();
    for raw in listed.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        if git.expired() {
            return failed("timeout");
        }
        // `encoding: "utf8"` turns invalid bytes into U+FFFD: that path no longer exists.
        let Ok(path) = std::str::from_utf8(raw) else {
            continue;
        };
        if path.contains('\n') {
            return failed("a tracked path contains a newline");
        }
        let absolute = tree.join(path);
        let Ok(meta) = std::fs::symlink_metadata(&absolute) else {
            continue;
        };
        let file_type = meta.file_type();
        let entry = if file_type.is_symlink() {
            std::fs::read_link(&absolute)
                .ok()
                .map(|target| ("120000", format.blob(target.as_os_str().as_bytes())))
        } else if file_type.is_file() {
            let mode = if meta.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            };
            std::fs::read(&absolute)
                .ok()
                .map(|bytes| (mode, format.blob(&bytes)))
        } else {
            continue;
        };
        let Some((mode, hash)) = entry else {
            return failed(&format!("cannot hash {path}"));
        };
        entries.push((mode, hash, path.to_owned()));
    }
    memory_tree(&entries, format, git)
}

enum Node {
    Leaf { mode: &'static str, hash: String },
    Dir(BTreeMap<String, Node>),
}

fn memory_tree(
    entries: &[(&'static str, String, String)],
    format: Format,
    git: &Git<'_>,
) -> Fingerprint {
    let mut root: BTreeMap<String, Node> = BTreeMap::new();
    for (mode, hash, path) in entries {
        if git.expired() {
            return failed("timeout");
        }
        let parts: Vec<&str> = path.split('/').collect();
        let (last, dirs) = parts.split_last().unwrap_or((&"", &[]));
        let mut node = &mut root;
        for part in dirs {
            let child = node
                .entry((*part).to_owned())
                .or_insert_with(|| Node::Dir(BTreeMap::new()));
            node = match child {
                Node::Dir(map) => map,
                Node::Leaf { .. } => return failed("tree collision"),
            };
        }
        node.insert(
            (*last).to_owned(),
            Node::Leaf {
                mode,
                hash: hash.clone(),
            },
        );
    }
    match hash_tree(&root, format, git) {
        Some(hash) if !git.expired() => Fingerprint::Ok(hash),
        _ => failed("timeout"),
    }
}

fn hash_tree(node: &BTreeMap<String, Node>, format: Format, git: &Git<'_>) -> Option<String> {
    if git.expired() {
        return None;
    }
    let key = |name: &str, value: &Node| -> Vec<u8> {
        let mut bytes = name.as_bytes().to_vec();
        if matches!(value, Node::Dir(_)) {
            bytes.push(b'/');
        }
        bytes
    };
    let mut sorted: Vec<(&String, &Node)> = node.iter().collect();
    sorted.sort_by_key(|(name, value)| key(name, value));
    let mut bytes = Vec::new();
    for (name, value) in sorted {
        if git.expired() {
            return None;
        }
        let (mode, hash) = match value {
            Node::Dir(map) => ("40000", hash_tree(map, format, git)?),
            Node::Leaf { mode, hash } => (*mode, hash.clone()),
        };
        bytes.extend_from_slice(format!("{mode} {name}\0").as_bytes());
        bytes.extend_from_slice(&unhex(&hash)?);
    }
    if git.expired() {
        return None;
    }
    Some(format.digest(&[format!("tree {}\0", bytes.len()).as_bytes(), &bytes]))
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The environment a TS process inherits, as `(key, value)` pairs.
#[must_use]
pub fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}
