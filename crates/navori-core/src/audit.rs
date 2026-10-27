//! Hook audit metadata and the existing CLI bridge (spec 0057 T22 / R11).
//!
//! The CLI remains the only log writer and authority on session headers, private modes and
//! wire identities. This module never appends logs, creates arms or creates a spool directory;
//! like the shell partial, it may drop one event file into a spool the CLI already created.

use std::collections::hash_map::RandomState;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::js_json::{JsObject, JsValue};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Largest spool event, without its trailing newline, the shell partial accepts.
const MAX_SPOOL_EVENT: usize = 4096;
const PHASES: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
    "PreCompact",
];
const VERDICTS: &[&str] = &[
    "allow",
    "ask",
    "block",
    "deny",
    "skip",
    "noop",
    "clean",
    "dirty",
    "inject",
    "repeat",
    "partial",
    "compact-advice",
    "gate-started",
    "gate-killed",
];
const TOOLS: &[&str] = &[
    "Bash",
    "Edit",
    "Read",
    "Write",
    "Agent",
    "Task",
    "NotebookEdit",
];
const REASONS: &[&str] = &[
    "oversize",
    "no-verify",
    "force-push-base",
    "rm-root",
    "rm-var",
    "no-preserve-root",
    "fork-bomb",
    "block-device",
    "managed-rewrite",
    "binary-missing",
    "plan-denied",
    "subcommand-unavailable",
    "native-hook",
    "foreign-repo",
    "foreign-gate",
];

/// Engine supplied to the existing metadata bridge, never inferred from a log header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    /// Claude Code.
    Claude,
    /// Codex.
    Codex,
    /// Pi, which does not support startup capture or spool creation.
    Pi,
}

impl Host {
    /// CLI spelling of this host.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    /// Same fallback as audit-log.sh when no shared input adapter selected an engine.
    #[must_use]
    pub fn from_script(script: &Path) -> Self {
        let script = script.to_string_lossy();
        if script.contains(".codex/hooks/") || script.contains(".codex/scripts/") {
            Self::Codex
        } else if script.contains(".pi/navori/hooks/") || script.contains(".pi/navori/scripts/") {
            Self::Pi
        } else {
            Self::Claude
        }
    }
}

fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn invocation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':'))
}

fn agent(value: &str) -> bool {
    if id(value) {
        return true;
    }
    let Some(tail) = value.strip_prefix("pi-") else {
        return false;
    };
    let Some((kind, suffix)) = tail.split_once('-') else {
        return false;
    };
    value.len() <= 256
        && !kind.is_empty()
        && kind.bytes().all(|b| b.is_ascii_lowercase())
        && invocation(suffix)
}

fn technical_label(value: &str) -> &str {
    if !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        value
    } else {
        "unknown"
    }
}

/// The shell's cheap gate deliberately declines escaped or duplicate session-id keys/values.
fn gate_session_id(raw: &str) -> Option<String> {
    let (_, tail) = raw.split_once("\"session_id\"")?;
    if tail.contains("\"session_id\"") {
        return None;
    }
    let tail = tail
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let value = tail.split_once('"')?.0;
    id(value).then(|| value.to_owned())
}

/// Only the bounded technical fields needed for auditing; human payload content is not retained.
#[derive(Debug, Clone)]
pub struct HookPayload {
    session_id: Option<String>,
    gate_session_id: Option<String>,
    cwd: Option<String>,
    agent_id: String,
    tool_use_id: Option<String>,
}

impl HookPayload {
    /// Extract the same identity scalars as jq. Invalid or non-object JSON cannot audit.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
        let object = value.as_object()?;
        let string = |key: &str| object.get(key).and_then(serde_json::Value::as_str);
        Some(Self {
            session_id: string("session_id").filter(|s| id(s)).map(str::to_owned),
            gate_session_id: gate_session_id(std::str::from_utf8(bytes).ok()?),
            cwd: string("cwd").map(str::to_owned),
            agent_id: [string("agent_id"), string("subagent_id")]
                .into_iter()
                .flatten()
                .find(|s| agent(s))
                .unwrap_or("orchestrator")
                .to_owned(),
            tool_use_id: string("tool_use_id")
                .filter(|s| invocation(s))
                .map(str::to_owned),
        })
    }
}

/// Explicit technical labels supplied by the compiled hook, not copied from human input.
#[derive(Debug, Clone, Copy)]
pub struct HookLabels<'a> {
    /// Hook id.
    pub name: &'a str,
    /// Host event name.
    pub phase: &'a str,
    /// Shell verdict category.
    pub verdict: &'a str,
    /// Core/plugin source category.
    pub source: &'a str,
    /// Optional tool category.
    pub tool: Option<&'a str>,
    /// Optional closed reason category; unknown text becomes `unspecified`.
    pub reason: Option<&'a str>,
    /// Optional `hard`, `ask` or `advisory`; absent derives from block/ask verdicts.
    pub kind: Option<&'a str>,
}

/// Complete closed scalar DTO. No wireVersion, eventId, rootSessionId or host is minted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookMetadata {
    json: String,
    phase: String,
}

impl HookMetadata {
    /// Compact JSON with the shell's insertion order and JS serialization rules.
    #[must_use]
    pub fn as_json(&self) -> &str {
        &self.json
    }
}

#[derive(Debug, Clone, Copy)]
enum Activity {
    Disabled,
    Pending,
    Active(u64),
}

/// Snapshot before evaluation; a late log appearance is recorded with ms=0 like the shell.
#[derive(Debug, Clone)]
pub struct AuditSnapshot {
    root: PathBuf,
    session_id: Option<String>,
    activity: Activity,
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

fn has_file(root: &Path, name: &str) -> bool {
    fs::read_dir(root).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| regular_file(&entry.path().join(name)))
    })
}

impl AuditSnapshot {
    /// Resolve activity with no timestamp cost when definitely off. Shadow never observes.
    #[must_use]
    pub fn begin(
        root: &Path,
        phase: &str,
        payload: &HookPayload,
        shadow: bool,
        clock: impl FnOnce() -> u64,
    ) -> Self {
        let activity = if shadow || !root.is_dir() {
            Activity::Disabled
        } else if let Some(sid) = &payload.gate_session_id {
            if has_file(root, &format!("session-{sid}.log"))
                || (["SessionStart", "UserPromptSubmit"].contains(&phase)
                    && has_file(root, ".armed"))
            {
                Activity::Active(clock())
            } else {
                Activity::Pending
            }
        } else {
            Activity::Active(clock())
        };
        Self {
            root: root.to_path_buf(),
            session_id: payload.gate_session_id.clone(),
            activity,
        }
    }

    /// Produce bounded metadata after evaluation; no filesystem writes or process launches occur.
    #[must_use]
    pub fn metadata(
        &self,
        payload: &HookPayload,
        labels: HookLabels<'_>,
        skip_noops: bool,
        clock: impl FnOnce() -> u64,
    ) -> Option<HookMetadata> {
        let started = match self.activity {
            Activity::Disabled => return None,
            Activity::Pending => {
                if !self
                    .session_id
                    .as_ref()
                    .is_some_and(|sid| has_file(&self.root, &format!("session-{sid}.log")))
                {
                    return None;
                }
                None
            }
            Activity::Active(started) => Some(started),
        };
        if skip_noops && ["skip", "noop"].contains(&labels.verdict) {
            return None;
        }
        let end = clock();
        let elapsed = started.map_or(0, |start| end.saturating_sub(start));
        if end > MAX_SAFE_INTEGER || elapsed > MAX_SAFE_INTEGER {
            return None;
        }
        let phase = if PHASES.contains(&labels.phase) {
            labels.phase
        } else {
            "unknown"
        };
        let verdict = if VERDICTS.contains(&labels.verdict) {
            labels.verdict
        } else {
            "unknown"
        };
        let mut out = JsObject::new();
        for (key, value) in [
            ("event", "hook"),
            ("name", technical_label(labels.name)),
            (
                "source",
                technical_label(if labels.source.is_empty() {
                    "core"
                } else {
                    labels.source
                }),
            ),
        ] {
            out.insert(key, JsValue::string(value));
        }
        out.insert("ms", JsValue::Number(elapsed as f64));
        out.insert("tsMs", JsValue::Number(end as f64));
        for (key, value) in [
            ("phase", phase),
            ("verdict", verdict),
            ("agentId", payload.agent_id.as_str()),
        ] {
            out.insert(key, JsValue::string(value));
        }
        if let Some(value) = &payload.tool_use_id {
            out.insert("toolUseId", JsValue::string(value));
        }
        if let Some(value) = labels.tool.filter(|tool| TOOLS.contains(tool)) {
            out.insert("tool", JsValue::string(value));
        }
        if let Some(value) = labels.reason.filter(|s| !s.is_empty()) {
            out.insert(
                "reason",
                JsValue::string(if REASONS.contains(&value) {
                    value
                } else {
                    "unspecified"
                }),
            );
        }
        let kind = labels
            .kind
            .filter(|s| !s.is_empty())
            .unwrap_or(match labels.verdict {
                "block" => "hard",
                "ask" => "ask",
                _ => "",
            });
        if ["hard", "ask", "advisory"].contains(&kind) {
            out.insert("kind", JsValue::string(kind));
        }
        let json = JsValue::Object(out).stringify(None)?;
        (json.len() <= 2048).then(|| HookMetadata {
            json,
            phase: phase.to_owned(),
        })
    }
}

/// Milliseconds since epoch, or zero when the platform clock cannot supply a non-negative time.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Repo identity follows audit-repo.sh, including nested Claude worktrees.
#[must_use]
pub fn repo_from_cwd(cwd: &str) -> Option<String> {
    let marker = "/.claude/worktrees";
    let cwd = if cwd.ends_with(marker) || cwd.contains("/.claude/worktrees/") {
        cwd.split_once(marker).map_or(cwd, |(root, _)| root)
    } else {
        cwd
    };
    let repo = cwd.trim_end_matches('/').rsplit('/').next()?;
    (!repo.is_empty()
        && repo != "."
        && repo != ".."
        && repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')))
    .then(|| repo.to_owned())
}

/// An exact transport target, still subject to the CLI writer's authoritative validation.
#[derive(Debug, Clone)]
pub struct AuditContext {
    root: PathBuf,
    session_id: String,
    repo: String,
    host: Host,
}

impl AuditContext {
    /// Bind only a valid session/repo. This never consumes an arm or reads a log header.
    #[must_use]
    pub fn resolve(
        root: &Path,
        payload: &HookPayload,
        fallback_cwd: &Path,
        script: &Path,
        host: Option<Host>,
    ) -> Option<Self> {
        let cwd = payload
            .cwd
            .as_deref()
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| fallback_cwd.to_str())?;
        Some(Self {
            root: root.to_path_buf(),
            session_id: payload.session_id.clone()?,
            repo: repo_from_cwd(cwd)?,
            host: host.unwrap_or_else(|| Host::from_script(script)),
        })
    }

    /// Record through the session spool when the CLI created it, otherwise through the CLI
    /// bridge, silently returning false on observation gaps. `program` is the existing trusted
    /// CLI executable (`navori`), never a field from the hook payload.
    #[must_use]
    pub fn record_metadata(&self, metadata: &HookMetadata, program: &OsStr) -> bool {
        if !self.root.is_dir() || (self.host == Host::Pi && metadata.phase == "SessionStart") {
            return false;
        }
        let repo = self.root.join(&self.repo);
        if !regular_file(&repo.join(format!("session-{}.log", self.session_id)))
            && !(metadata.phase == "SessionStart"
                && self.host != Host::Pi
                && regular_file(&repo.join(".armed")))
        {
            return false;
        }
        if self.spool_write(&repo, metadata) {
            return true;
        }
        let Ok(mut child) = Command::new(program)
            .args([
                OsStr::new("audit"),
                OsStr::new("--record-metadata"),
                OsStr::new("--host"),
                OsStr::new(self.host.as_str()),
                OsStr::new("--root-session"),
                OsStr::new(&self.session_id),
                OsStr::new("--repo"),
                OsStr::new(&self.repo),
                OsStr::new("--root"),
                self.root.as_os_str(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let sent = child
            .stdin
            .take()
            .is_some_and(|mut input| input.write_all(metadata.json.as_bytes()).is_ok());
        let status = child.wait();
        sent && status.is_ok_and(|status| status.success())
    }

    /// Spool lane (spec 0054 R26 / D8), as `navori_audit_spool_write`: one
    /// `{"v":1,"host":…,"metadata":…}` file created exclusively (never overwritten, never
    /// through a symlink at that name) with mode 0600 inside the CLI-created spool directory,
    /// which must be a real directory owned by this process. std exposes no effective uid, so
    /// ownership is compared on the file just created (always owned by the effective uid) and a
    /// mismatch unlinks it. Any failure leaves no file and falls through to the CLI bridge; the
    /// CLI re-validates host, categories and size when it consolidates the spool.
    fn spool_write(&self, repo: &Path, metadata: &HookMetadata) -> bool {
        let spool = repo.join(format!("spool-{}", self.session_id));
        let Ok(directory) = fs::symlink_metadata(&spool) else {
            return false;
        };
        let event = format!(
            "{{\"v\":1,\"host\":\"{}\",\"metadata\":{}}}",
            self.host.as_str(),
            metadata.json
        );
        if !directory.is_dir() || event.len() > MAX_SPOOL_EVENT {
            return false;
        }
        let micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_micros());
        let random = RandomState::new().build_hasher().finish() % 32_768;
        let path = spool.join(format!("{micros}-{}-{random}.json", std::process::id()));
        let Ok(mut file) = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        else {
            return false;
        };
        let owned = file
            .metadata()
            .is_ok_and(|created| created.uid() == directory.uid());
        if owned && file.write_all(format!("{event}\n").as_bytes()).is_ok() {
            return true;
        }
        drop(file);
        let _ = fs::remove_file(&path);
        false
    }
}
