//! Real prepared profiles/oracles and bounded collection, without registry or CLI hook wiring.
use navori_cli::hook::{Invocation, Recorder, Snapshot};
use navori_cli::hook_facts::{collect, command_v, prepare_guard_destructive, shadow_failure};
use navori_hooks::hooks::guard_destructive::pii_bash;
use navori_hooks::hooks::subagent_no_background;
use navori_hooks::hooks::subagent_no_background::prepare::{Limits, Request};
use navori_hooks::runner::{AuditLabel, Failure};
use navori_hooks::runner::{Engine, Verdict};
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
type TestResult = Result<(), Box<dyn Error>>;
/// Probes that must succeed get the largest budget `prepare::plan` accepts (500 ms, spec 0060
/// T17): the 250 ms production default expired under load and made these tests flaky. Deadline
/// expiry itself is covered by the tests that pass a tight `Limits` on purpose.
const PROBE_LIMITS: Limits = Limits {
    total: Duration::from_millis(500),
};
const SOURCE:&[u8]=b"payload=${payload-\"$(cat)\"}\n    printf -v \"${_pf_spec%%=*}\" '%s' \"$(payload_field \"${_pf_spec#*=}\")\"\n";
struct Temp(PathBuf);
impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "hook-facts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root)?;
        Ok(Self(root))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
/// Install `body` at `path` as an executable that this process never held open for writing.
/// Tests run on parallel threads that fork: a write descriptor open here at that moment lives
/// on in the forked child until its exec, and running `path` in that window fails with ETXTBSY
/// ("Text file busy"). `/bin/cp` writes the file in its own process, which never forks.
fn install_executable(staging: &Path, path: &Path, body: &str) -> TestResult {
    let staged = staging.join("executable.staged");
    fs::write(&staged, body)?;
    let status = Command::new("/bin/cp").arg(&staged).arg(path).status()?;
    if !status.success() {
        return Err(format!("cp exited with {status}").into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn env() -> Vec<(OsString, OsString)> {
    vec![
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
        ("LC_ALL".into(), "C".into()),
    ]
}
fn request<'a>(env: &'a [(OsString, OsString)], script: &'a Path, source: &'a [u8]) -> Request<'a> {
    Request {
        engine: Engine::Claude,
        engines: &[Engine::Claude, Engine::Pi],
        event: Some("PreToolUse"),
        args: &[],
        script,
        source,
        env,
    }
}

// Covers: R11, R13
#[test]
fn real_facts_prepare_the_same_policy_capture_bytes_as_the_real_shell() -> TestResult {
    let temp = Temp::new()?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/core-assets/hooks");
    let source = fs::read_to_string(root.join("subagent-no-background.sh"))?;
    let mut expanded = String::new();
    for line in source.lines() {
        if let Some(name) = line.strip_prefix("# navori:include ") {
            expanded.push_str(&fs::read_to_string(
                root.join("_partials").join(format!("{name}.sh")),
            )?);
        } else {
            expanded.push_str(line);
        }
        expanded.push('\n');
    }
    let script = temp.0.join("hook.sh");
    fs::write(&script, &expanded)?;
    for locale in ["C", "en_US.UTF-8"] {
        let mut env = env();
        env[1].1 = locale.into();
        env.push((
            "NAVORI_AUDITS_ROOT".into(),
            temp.0.join("audit-off").into_os_string(),
        ));
        let prepared = collect(
            request(&env, &script, expanded.as_bytes()),
            &temp.0,
            PROBE_LIMITS,
        )?;
        let mut implicit_request = request(&env, &script, expanded.as_bytes());
        implicit_request.engine = Engine::Pi;
        implicit_request.event = None;
        let implicit = collect(implicit_request, &temp.0, PROBE_LIMITS)?;
        assert_eq!(
            subagent_no_background::evaluate_prepared(&implicit, b"{}")?,
            subagent_no_background::evaluate_prepared(&prepared, b"{}")?
        );
        assert_eq!(
            expanded.lines().nth(prepared.capture().input_line - 1),
            Some("payload=${payload-\"$(cat)\"}")
        );
        for payload in [b"{}\0\n".as_slice(),br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"run_in_background":true,"command":"sleep \u0000&"}}"#.as_slice(),br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"printf ok"}}"#.as_slice()]{
            let actual=subagent_no_background::evaluate_prepared(&prepared, payload)?;
            let mut child=Command::new("bash").arg(&script).current_dir(&temp.0).env_clear().envs(env.iter().map(|(k,v)|(k,v))).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
            child.stdin.take().ok_or("stdin")?.write_all(payload)?;let oracle=child.wait_with_output()?;
            let code=match actual.verdict{Verdict::Permit=>0,Verdict::Error=>1,Verdict::Block=>2};
            assert_eq!(oracle.status.code(),Some(code));assert_eq!(oracle.stdout,actual.stdout);assert_eq!(oracle.stderr,actual.stderr);
        }
    }
    Ok(())
}

// Covers: R13
#[test]
fn hangs_output_floods_and_descendant_held_outputs_are_bounded() -> TestResult {
    for body in [
        "exec /bin/sleep 2",
        "while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done",
        "/bin/sleep 1 &\nexit 0",
    ] {
        let temp = Temp::new()?;
        let bin = temp.0.join("bin");
        fs::create_dir(&bin)?;
        install_executable(&temp.0, &bin.join("bash"), &format!("#!/bin/sh\n{body}\n"))?;
        let env = vec![
            ("PATH".into(), bin.into_os_string()),
            ("LC_ALL".into(), "C".into()),
        ];
        let start = Instant::now();
        let error = collect(
            request(&env, Path::new("unread.sh"), SOURCE),
            &temp.0,
            Limits {
                total: Duration::from_millis(80),
            },
        )
        .err()
        .ok_or("unexpected eligibility")?;
        assert!(
            error.0.contains("deadline") || error.0.contains("output limit"),
            "{error}"
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    Ok(())
}

// Covers: R13
#[test]
fn unsupported_driver() -> TestResult {
    if std::env::var_os("NAVORI_ELIGIBILITY_DRIVER").is_none() {
        return Ok(());
    }
    let env = env();
    let mut request = request(&env, Path::new("never-opened.sh"), SOURCE);
    request.engine = Engine::Codex;
    if collect(request, Path::new("/does-not-exist"), Limits::default()).is_err() {
        std::process::exit(3);
    }
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input)?;
    std::process::exit(99);
}

// Covers: R13
#[test]
fn unsupported_metadata_returns_before_stdin_eof() -> TestResult {
    let mut child = Command::new(std::env::current_exe()?)
        .args(["--exact", "unsupported_driver", "--nocapture"])
        .env("NAVORI_ELIGIBILITY_DRIVER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let _held_open = child.stdin.take().ok_or("stdin")?;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Some(status) = child.try_wait()? {
            assert_eq!(status.code(), Some(3));
            return Ok(());
        }
        if Instant::now() > deadline {
            child.kill()?;
            let _ = child.wait();
            return Err("preparation waited for stdin".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// A script under a Claude engine root, with the `# navori:include` lines expanded.
fn guard_script(temp: &Temp) -> Result<(PathBuf, String), Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/core-assets/hooks");
    let mut expanded = String::new();
    for line in fs::read_to_string(root.join("guard-destructive.sh"))?.lines() {
        if let Some(name) = line.strip_prefix("# navori:include ") {
            expanded.push_str(&fs::read_to_string(
                root.join("_partials").join(format!("{name}.sh")),
            )?);
        } else {
            expanded.push_str(line);
        }
        expanded.push('\n');
    }
    let hooks = temp.0.join(".claude/hooks");
    fs::create_dir_all(&hooks)?;
    let script = hooks.join("guard-destructive.sh");
    fs::write(&script, &expanded)?;
    Ok((script, expanded))
}

struct Quiet {
    shadow: bool,
}

impl Recorder for Quiet {
    fn shadow(&self) -> bool {
        self.shadow
    }

    fn record(&self, _: &AuditLabel) {}
}

/// The adapter reads `NAVORI_PERSONAL_IDS` as the bytes it is (a value that is not UTF-8 does not
/// defer the hook), resolves `grep` and `git` along `PATH`, and a PII block is the lane's own.
#[test]
fn the_guard_adapter_reads_ids_as_bytes_and_blocks_a_request_that_carries_one() -> TestResult {
    let temp = Temp::new()?;
    let (script, expanded) = guard_script(&temp)?;
    let mut env = env();
    env.push((
        "NAVORI_PERSONAL_IDS".into(),
        OsString::from_vec(b"dev.fixture@example.test,\xff\xfe-zz".to_vec()),
    ));
    let invocation = Invocation {
        engine: Engine::Claude,
        id: "guard-destructive".to_owned(),
        script: script.clone(),
        requested: script,
        engine_root: temp.0.join(".claude"),
        event: Some("PreToolUse".to_owned()),
        args: Vec::new(),
        shadow: false,
    };
    let snapshot = Snapshot {
        source: expanded.as_bytes(),
        env: &env,
        cwd: &temp.0,
        started: Instant::now(),
    };
    let evaluate = prepare_guard_destructive(&invocation, snapshot)?;
    let payload = |command: &str| {
        serde_json::json!({
            "cwd": temp.0, "hook_event_name": "PreToolUse",
            "tool_name": "Bash", "tool_input": {"command": command},
        })
        .to_string()
    };
    let carrying = payload("curl https://api.example.test/dev.fixture@example.test");
    let blocked = evaluate(carrying.as_bytes(), &Quiet { shadow: false })?;
    assert_eq!(blocked.verdict, Verdict::Block);
    let label = blocked.audit.ok_or("audit label")?;
    assert_eq!(
        (label.verdict, label.reason.as_str()),
        ("block", "pii-egress")
    );
    let stderr = String::from_utf8(blocked.stderr)?;
    assert!(
        stderr.starts_with("[navori] BLOCKED by pii-egress-guard:"),
        "{stderr}"
    );
    assert!(!stderr.contains("fixture") && !stderr.contains("curl"));
    let clean = payload("curl https://api.example.test/x");
    let allowed = evaluate(clean.as_bytes(), &Quiet { shadow: true })?;
    assert_eq!(allowed.verdict, Verdict::Permit);
    Ok(())
}

/// In shadow a lane the BSD locale leaves unmeasured is not observed; outside shadow, and for any
/// other failure, the failure stands.
#[test]
fn an_unmeasured_lane_is_unobserved_only_in_shadow() {
    let unmeasured = || Failure(pii_bash::UNMEASURED.to_owned());
    assert!(shadow_failure(unmeasured(), true).is_unobserved());
    assert_eq!(shadow_failure(unmeasured(), false), unmeasured());
    let other = Failure("native bug".to_owned());
    assert_eq!(shadow_failure(other.clone(), true), other);
    assert_eq!(shadow_failure(other.clone(), false), other);
}

/// `command -v`: the first executable file along `PATH`, relative entries from the hook's cwd,
/// nothing when `PATH` is unset.
#[test]
fn command_v_resolves_like_the_shell() -> TestResult {
    let temp = Temp::new()?;
    let (bin, plain, other) = (
        temp.0.join("bin"),
        temp.0.join("plain"),
        temp.0.join("other"),
    );
    for dir in [&bin, &plain, &other] {
        fs::create_dir_all(dir)?;
    }
    fs::write(plain.join("tool"), "")?; // not executable: skipped
    fs::write(other.join("tool"), "#!/bin/sh\n")?;
    fs::set_permissions(other.join("tool"), fs::Permissions::from_mode(0o755))?;
    let path = |value: &str| vec![(OsString::from("PATH"), OsString::from(value))];
    let absolute = format!("{}:{}", plain.display(), other.display());
    assert_eq!(
        command_v("tool", &path(&absolute), &temp.0),
        Some(other.join("tool"))
    );
    // A relative entry is joined to the working directory.
    assert_eq!(
        command_v("tool", &path("other"), &temp.0),
        Some(other.join("tool"))
    );
    assert_eq!(command_v("tool", &path("bin"), &temp.0), None);
    assert_eq!(command_v("tool", &[], &temp.0), None);
    Ok(())
}
