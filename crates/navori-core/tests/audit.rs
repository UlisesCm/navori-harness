//! Spec 0057 R11: parity with the shell metadata DTO and the authoritative TS writer.

use std::cell::Cell;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use navori_core::audit::{
    AuditContext, AuditSnapshot, HookLabels, HookMetadata, HookPayload, Host, repo_from_cwd,
};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;

/// A private fixture directory that also holds the file's exec lock while it lives.
///
/// Fixtures write a script and execute it at once. On Linux, a `fork` by another test thread
/// while that script is still open for writing leaves the child holding the descriptor, and
/// the `execve` fails with `ETXTBSY` (about 5% of runs in CI). Every test here spawns, so they
/// run one at a time.
struct TempDir {
    path: PathBuf,
    _serial: MutexGuard<'static, ()>,
}

static EXEC: Mutex<()> = Mutex::new(());

impl TempDir {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let serial = EXEC.lock().unwrap_or_else(PoisonError::into_inner);
        for _ in 0..100 {
            let path = std::env::temp_dir().join(format!(
                "navori-rust-audit-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
                    return Ok(Self {
                        path: fs::canonicalize(path)?,
                        _serial: serial,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err("could not create unique fixture".into())
    }

    fn root(&self) -> &Path {
        &self.path
    }

    fn write(
        &self,
        relative: &str,
        content: impl AsRef<[u8]>,
        mode: u32,
    ) -> Result<PathBuf, Box<dyn Error>> {
        let path = self.path.join(relative);
        let parent = path.parent().ok_or("missing parent")?;
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        fs::write(&path, content)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        Ok(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn repo() -> Result<PathBuf, Box<dyn Error>> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest
        .parent()
        .and_then(Path::parent)
        .ok_or("workspace root")?
        .to_path_buf())
}

fn labels<'a>(verdict: &'a str) -> HookLabels<'a> {
    HookLabels {
        name: "test",
        phase: "PreToolUse",
        verdict,
        source: "core",
        tool: Some("Bash"),
        reason: Some("oversize"),
        kind: None,
    }
}

fn payload(cwd: &Path) -> Result<HookPayload, Box<dyn Error>> {
    HookPayload::parse(
        json!({"session_id":"session-1","cwd":cwd,"agent_id":"worker","tool_use_id":"call:1"})
            .to_string()
            .as_bytes(),
    )
    .ok_or_else(|| "payload parse".into())
}

fn metadata(
    root: &Path,
    payload: &HookPayload,
    observation: HookLabels<'_>,
) -> Result<HookMetadata, Box<dyn Error>> {
    AuditSnapshot::begin(root, observation.phase, payload, false, || 1000)
        .metadata(payload, observation, false, || 1500)
        .ok_or_else(|| "no metadata".into())
}

fn shell_metadata(raw: &[u8], observation: HookLabels<'_>) -> Result<String, Box<dyn Error>> {
    let source = repo()?.join("packages/core/core-assets/hooks/_partials/audit-log.sh");
    let script = r#"
source "$1"
payload=$(cat)
navori_audit_on=1
navori_audit_t0=1000
navori_audit_now() { printf '%s' 1500; }
navori_audit_record_metadata() { printf '%s' "$1"; }
navori_audit_log "$TEST_VERDICT" "$TEST_REASON" "$TEST_KIND"
"#;
    let mut child = Command::new("bash")
        .args([
            OsStr::new("-c"),
            OsStr::new(script),
            OsStr::new("fixture"),
            source.as_os_str(),
        ])
        .env("navori_audit_name", observation.name)
        .env("navori_audit_phase", observation.phase)
        .env("navori_audit_source", observation.source)
        .env("navori_audit_tool", observation.tool.unwrap_or(""))
        .env("TEST_VERDICT", observation.verdict)
        .env("TEST_REASON", observation.reason.unwrap_or(""))
        .env("TEST_KIND", observation.kind.unwrap_or(""))
        .env("NAVORI_AUDIT_SKIP_NOOPS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or("stdin")?.write_all(raw)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!("shell failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

// Covers: R11
#[test]
fn metadata_matches_the_real_shell_partial_without_human_content() -> TestResult {
    let temp = TempDir::new()?;
    temp.write("project/session-session-1.log", "marker\n", 0o600)?;
    let cases = [
        (
            json!({"session_id":"session-1","agent_id":"worker","tool_use_id":"call:1","command":"NEVER_LOG_THIS","prompt":"NEVER_LOG_THIS"}),
            labels("block"),
        ),
        (
            json!({"session_id":"session-1","agent_id":"bad actor","subagent_id":"pi-tool-call:1","tool_use_id":"bad call"}),
            labels("ask"),
        ),
        (
            json!({"session_id":"session-1","agent_id":"bad actor","subagent_id":null,"tool_use_id":42}),
            HookLabels {
                name: "human words",
                phase: "unsupported",
                verdict: "unsupported",
                source: "bad source",
                tool: Some("secret tool"),
                reason: Some("human reason"),
                kind: Some("invalid"),
            },
        ),
        (
            json!({"session_id":"session-1"}),
            HookLabels {
                source: "",
                ..labels("allow")
            },
        ),
        (
            json!({"session_id":"session-1"}),
            HookLabels {
                name: "plugin.hook:1",
                phase: "Stop",
                verdict: "skip",
                source: "plugin:tgrep",
                tool: None,
                reason: None,
                kind: Some("advisory"),
            },
        ),
    ];
    for (value, observation) in cases {
        let raw = value.to_string();
        let parsed = HookPayload::parse(raw.as_bytes()).ok_or("parse")?;
        let native = metadata(temp.root(), &parsed, observation)?;
        let shell = shell_metadata(raw.as_bytes(), observation)?;
        assert_eq!(native.as_json(), shell);
        assert!(!native.as_json().contains("NEVER_LOG_THIS"));
        let closed: Value = serde_json::from_str(native.as_json())?;
        for key in [
            "command",
            "prompt",
            "transcript",
            "wireVersion",
            "eventId",
            "rootSessionId",
            "host",
        ] {
            assert!(closed.get(key).is_none(), "{key}");
        }
    }
    assert!(HookPayload::parse(b"not JSON").is_none());
    assert!(HookPayload::parse(b"[]").is_none());
    Ok(())
}

// Covers: R11
#[test]
fn activity_avoids_clock_work_when_off_and_handles_a_late_log_with_zero_ms() -> TestResult {
    let temp = TempDir::new()?;
    let parsed = payload(Path::new("/repo/project"))?;
    let off = AuditSnapshot::begin(
        &temp.root().join("absent"),
        "PreToolUse",
        &parsed,
        false,
        || panic!("off clock"),
    );
    assert!(
        off.metadata(&parsed, labels("allow"), false, || panic!("off end clock"))
            .is_none()
    );
    let late = AuditSnapshot::begin(temp.root(), "PreToolUse", &parsed, false, || {
        panic!("pending clock")
    });
    assert!(
        late.metadata(&parsed, labels("allow"), false, || panic!(
            "unmarked end clock"
        ))
        .is_none()
    );
    temp.write(".hidden/session-session-1.log", "marker\n", 0o600)?;
    let value: Value = serde_json::from_str(
        late.metadata(&parsed, labels("allow"), false, || 2000)
            .ok_or("late")?
            .as_json(),
    )?;
    assert_eq!(value["ms"], 0);
    assert_eq!(value["tsMs"], 2000);
    let calls = Cell::new(0);
    let active = AuditSnapshot::begin(temp.root(), "PreToolUse", &parsed, false, || {
        calls.set(calls.get() + 1);
        2000
    });
    let value: Value = serde_json::from_str(
        active
            .metadata(&parsed, labels("allow"), false, || {
                calls.set(calls.get() + 1);
                1000
            })
            .ok_or("active")?
            .as_json(),
    )?;
    assert_eq!(value["ms"], 0);
    assert_eq!(calls.get(), 2);
    assert!(
        active
            .metadata(&parsed, labels("noop"), true, || panic!("skipped clock"))
            .is_none()
    );
    let shadow = AuditSnapshot::begin(temp.root(), "PreToolUse", &parsed, true, || {
        panic!("shadow clock")
    });
    assert!(
        shadow
            .metadata(&parsed, labels("allow"), false, || panic!(
                "shadow end clock"
            ))
            .is_none()
    );
    Ok(())
}

// Covers: R11
#[test]
fn ambiguous_or_escaped_session_ids_keep_the_conservative_start_snapshot() -> TestResult {
    let temp = TempDir::new()?;
    for raw in [
        r#"{"session_id":"old","session_id":"session-1"}"#,
        r#"{"session_id":"session\u002d1"}"#,
    ] {
        let parsed = HookPayload::parse(raw.as_bytes()).ok_or("parse")?;
        let snapshot = AuditSnapshot::begin(temp.root(), "PreToolUse", &parsed, false, || 1000);
        let value: Value = serde_json::from_str(
            snapshot
                .metadata(&parsed, labels("allow"), false, || 1500)
                .ok_or("metadata")?
                .as_json(),
        )?;
        assert_eq!(value["ms"], 500);
    }
    Ok(())
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

// Covers: R11
#[test]
fn bridge_receives_exact_identity_and_stdin_without_writing_a_log_or_arm() -> TestResult {
    let temp = TempDir::new()?;
    let marker = temp.write("audits/project/session-session-1.log", "untouched\n", 0o600)?;
    let root = temp.root().join("audits");
    let parsed = payload(Path::new("/repo/project/.claude/worktrees/agent-1"))?;
    let context = AuditContext::resolve(
        &root,
        &parsed,
        Path::new("/fallback"),
        Path::new("/repo/.codex/hooks/example.sh"),
        None,
    )
    .ok_or("context")?;
    let event = metadata(&root, &parsed, labels("block"))?;
    let args = temp.root().join("args");
    let input = temp.root().join("input");
    let program = temp.write(
        "bridge",
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\ncat > {}\nprintf ignored\nprintf ignored >&2\n",
            quote(&args),
            quote(&input)
        ),
        0o700,
    )?;
    assert!(context.record_metadata(&event, program.as_os_str()));
    assert_eq!(
        fs::read_to_string(args)?,
        format!(
            "audit\n--record-metadata\n--host\ncodex\n--root-session\nsession-1\n--repo\nproject\n--root\n{}\n",
            root.display()
        )
    );
    assert_eq!(fs::read_to_string(input)?, event.as_json());
    assert_eq!(fs::read_to_string(&marker)?, "untouched\n");
    assert!(!root.join("project/.armed").exists());
    assert!(!root.join("project/spool-session-1").exists());
    assert!(!context.record_metadata(&event, temp.root().join("missing").as_os_str()));
    let failed = temp.write("failed", "#!/bin/sh\nexit 7\n", 0o700)?;
    assert!(!context.record_metadata(&event, failed.as_os_str()));
    assert_eq!(fs::read_to_string(marker)?, "untouched\n");
    assert_eq!(
        repo_from_cwd("/repo/project/.claude/worktrees"),
        Some("project".to_owned())
    );
    assert_eq!(repo_from_cwd("/repo/project/"), Some("project".to_owned()));
    assert_eq!(
        repo_from_cwd("/repo/project/.claude/worktrees-old/child/.claude/worktrees/agent"),
        Some("project".to_owned())
    );
    assert_eq!(
        repo_from_cwd("/repo/project/.claude/worktrees-old"),
        Some("worktrees-old".to_owned())
    );
    assert_eq!(repo_from_cwd("/repo/bad repo"), None);
    assert_eq!(
        Host::from_script(Path::new(".pi/navori/hooks/example.sh")),
        Host::Pi
    );
    Ok(())
}

// Covers: R11
#[test]
fn exact_markers_are_required_and_pi_cannot_offer_a_startup_arm() -> TestResult {
    let temp = TempDir::new()?;
    let parsed = payload(Path::new("/repo/project"))?;
    temp.write("project/.armed", "untouched arm", 0o600)?;
    let observation = HookLabels {
        phase: "SessionStart",
        ..labels("allow")
    };
    let event = metadata(temp.root(), &parsed, observation)?;
    let output = temp.root().join("unexpected");
    let program = temp.write(
        "bridge",
        format!("#!/bin/sh\ncat > {}\n", quote(&output)),
        0o700,
    )?;
    let pi = AuditContext::resolve(
        temp.root(),
        &parsed,
        Path::new("/fallback"),
        Path::new("script"),
        Some(Host::Pi),
    )
    .ok_or("pi")?;
    assert!(!pi.record_metadata(&event, program.as_os_str()));
    assert!(!output.exists());
    let codex = AuditContext::resolve(
        temp.root(),
        &parsed,
        Path::new("/fallback"),
        Path::new("script"),
        Some(Host::Codex),
    )
    .ok_or("codex")?;
    assert!(codex.record_metadata(&event, program.as_os_str()));
    assert_eq!(
        fs::read_to_string(temp.root().join("project/.armed"))?,
        "untouched arm"
    );
    fs::remove_file(output)?;
    let normal = metadata(temp.root(), &parsed, labels("allow"));
    assert!(normal.is_err());
    temp.write("other/session-session-1.log", "other repo marker\n", 0o600)?;
    let normal = metadata(temp.root(), &parsed, labels("allow"))?;
    assert!(!codex.record_metadata(&normal, program.as_os_str()));
    let other = temp.root().join("other/session-session-1.log");
    symlink(other, temp.root().join("project/session-session-1.log"))?;
    assert!(!codex.record_metadata(&normal, program.as_os_str()));
    Ok(())
}

// Covers: R11
#[test]
fn real_ts_writer_remains_authoritative_for_identity_modes_and_wire_ids() -> TestResult {
    let temp = TempDir::new()?;
    let cwd = temp.root().join("project");
    fs::create_dir(&cwd)?;
    let root = temp.root().join("audits");
    fs::create_dir(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let header =
        json!({"event":"start","host":"codex","sessionId":"session-1","repo":"project","cwd":cwd});
    let original = format!("{header}\n");
    let marker = temp.write("audits/project/session-session-1.log", &original, 0o600)?;
    let parsed = payload(&cwd)?;
    let event = metadata(&root, &parsed, labels("block"))?;
    let context = AuditContext::resolve(
        &root,
        &parsed,
        Path::new("/fallback"),
        Path::new(".codex/hooks/test.sh"),
        None,
    )
    .ok_or("context")?;
    let module = repo()?.join("packages/cli/src/lib/audit/cli-event.ts");
    let module_json = serde_json::to_string(&module.to_string_lossy())?;
    // Node 24 needs transform mode for the real writer's TypeScript parameter properties.
    let bridge = temp.write("writer.mjs", format!(r#"#!/usr/bin/env -S node --experimental-transform-types
import {{ recordAuditMetadata }} from {module_json};
const args = process.argv.slice(2);
const field = name => args[args.indexOf(name) + 1];
let input = '';
for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk;
const event = JSON.parse(input);
const result = recordAuditMetadata({{ event, host: field('--host'), rootSessionId: field('--root-session'), repo: field('--repo'), auditRoot: field('--root') }});
process.exit(result.status === 'recorded' ? 0 : 1);
"#), 0o700)?;
    assert!(context.record_metadata(&event, bridge.as_os_str()));
    let stored = fs::read_to_string(&marker)?;
    let lines: Vec<&str> = stored.lines().collect();
    assert_eq!(lines.len(), 2);
    let value: Value = serde_json::from_str(lines[1])?;
    assert_eq!(value["wireVersion"], 1);
    assert_eq!(value["host"], "codex");
    assert_eq!(value["rootSessionId"], "session-1");
    assert!(value["eventId"].as_str().is_some_and(|id| id.len() == 36));
    let mut metadata: Value = value;
    for key in ["wireVersion", "eventId", "host", "rootSessionId"] {
        metadata.as_object_mut().ok_or("stored object")?.remove(key);
    }
    assert_eq!(metadata, serde_json::from_str::<Value>(event.as_json())?);
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o644))?;
    assert!(!context.record_metadata(&event, bridge.as_os_str()));
    assert_eq!(fs::read_to_string(&marker)?, stored);
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))?;
    let wrong = AuditContext::resolve(
        &root,
        &parsed,
        Path::new("/fallback"),
        Path::new(".claude/hooks/test.sh"),
        Some(Host::Claude),
    )
    .ok_or("wrong")?;
    assert!(!wrong.record_metadata(&event, bridge.as_os_str()));
    assert_eq!(fs::read_to_string(marker)?, stored);
    Ok(())
}

/// One spool file as (name, mode, content).
type SpoolFile = (String, u32, String);

/// Files of a spool directory.
fn spool_files(spool: &Path) -> Result<Vec<SpoolFile>, Box<dyn Error>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(spool)? {
        let path = entry?.path();
        let name = path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or("spool name")?
            .to_owned();
        let mode = fs::metadata(&path)?.permissions().mode() & 0o777;
        files.push((name, mode, fs::read_to_string(&path)?));
    }
    Ok(files)
}

/// The real partial's `navori_audit_spool_write` for one metadata JSON and host.
fn shell_spool_write(spool: &Path, host: &str, metadata: &str) -> TestResult {
    let source = repo()?.join("packages/core/core-assets/hooks/_partials/audit-log.sh");
    let status = Command::new("bash")
        .args([
            OsStr::new("-c"),
            OsStr::new(r#"source "$1"; navori_audit_spool="$2"; navori_audit_host="$3"; navori_audit_spool_write "$4""#),
            OsStr::new("fixture"),
            source.as_os_str(),
            spool.as_os_str(),
            OsStr::new(host),
            OsStr::new(metadata),
        ])
        .status()?;
    if !status.success() {
        return Err("shell spool write failed".into());
    }
    Ok(())
}

/// A spool file name of `count` numeric parts: the native writer uses `<stamp>-<pid>-<rand>.json`,
/// the shell `<stamp>-<pid>-<seq>-<rand>.json` (#1439).
fn spool_name(name: &str, count: usize) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let parts: Vec<&str> = stem.split('-').collect();
    parts.len() == count
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

// Covers: R11
#[test]
fn spool_lane_writes_the_shell_event_privately_and_never_starts_the_cli() -> TestResult {
    let temp = TempDir::new()?;
    temp.write("project/session-session-1.log", "", 0o600)?;
    let spool = temp.root().join("project/spool-session-1");
    fs::create_dir(&spool)?;
    fs::set_permissions(&spool, fs::Permissions::from_mode(0o700))?;
    let parsed = payload(Path::new("/repo/project"))?;
    let event = metadata(temp.root(), &parsed, labels("block"))?;
    let context = AuditContext::resolve(
        temp.root(),
        &parsed,
        Path::new("/fallback"),
        Path::new("/repo/.pi/navori/hooks/example.sh"),
        None,
    )
    .ok_or("context")?;
    let started = temp.root().join("cli-started");
    let program = temp.write(
        "bridge",
        format!("#!/bin/sh\n: > {}\nexit 7\n", quote(&started)),
        0o700,
    )?;
    assert!(context.record_metadata(&event, program.as_os_str()));
    assert!(!started.exists());
    let native = spool_files(&spool)?;
    let shell_spool = temp.root().join("shell-spool");
    fs::create_dir(&shell_spool)?;
    shell_spool_write(&shell_spool, "pi", event.as_json())?;
    let shell = spool_files(&shell_spool)?;
    assert_eq!(native.len(), 1);
    assert_eq!(shell.len(), 1);
    assert_eq!(native[0].1, 0o600);
    assert_eq!(native[0].1, shell[0].1);
    assert_eq!(native[0].2, shell[0].2);
    assert!(spool_name(&native[0].0, 3), "{}", native[0].0);
    assert!(spool_name(&shell[0].0, 4), "{}", shell[0].0);
    Ok(())
}

// Covers: R11
#[test]
fn a_symlinked_or_non_directory_spool_falls_back_to_the_cli_bridge() -> TestResult {
    let temp = TempDir::new()?;
    temp.write("project/session-session-1.log", "", 0o600)?;
    let elsewhere = temp.root().join("elsewhere");
    fs::create_dir(&elsewhere)?;
    let spool = temp.root().join("project/spool-session-1");
    symlink(&elsewhere, &spool)?;
    let parsed = payload(Path::new("/repo/project"))?;
    let event = metadata(temp.root(), &parsed, labels("allow"))?;
    let context = AuditContext::resolve(
        temp.root(),
        &parsed,
        Path::new("/fallback"),
        Path::new("/repo/.claude/hooks/example.sh"),
        None,
    )
    .ok_or("context")?;
    let input = temp.root().join("cli-input");
    let program = temp.write(
        "bridge",
        format!("#!/bin/sh\ncat > {}\n", quote(&input)),
        0o700,
    )?;
    assert!(context.record_metadata(&event, program.as_os_str()));
    assert_eq!(fs::read_to_string(&input)?, event.as_json());
    assert!(spool_files(&elsewhere)?.is_empty());
    fs::remove_file(&spool)?;
    fs::remove_file(&input)?;
    fs::write(&spool, "not a directory")?;
    assert!(context.record_metadata(&event, program.as_os_str()));
    assert_eq!(fs::read_to_string(&input)?, event.as_json());
    assert_eq!(fs::read_to_string(&spool)?, "not a directory");
    Ok(())
}
