//! Real prepared profiles/oracles and bounded collection, without registry or CLI hook wiring.
use navori_cli::hook_facts::collect;
use navori_hooks::hooks::subagent_no_background;
use navori_hooks::hooks::subagent_no_background::prepare::{Limits, Request};
use navori_hooks::runner::{Engine, Verdict};
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
type TestResult = Result<(), Box<dyn Error>>;
const SOURCE:&[u8]=b"payload=${payload-$(cat)}\n    printf -v \"${_pf_spec%%=*}\" '%s' \"$(payload_field \"${_pf_spec#*=}\")\"\n";
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
            Limits::default(),
        )?;
        let mut implicit_request = request(&env, &script, expanded.as_bytes());
        implicit_request.engine = Engine::Pi;
        implicit_request.event = None;
        let implicit = collect(implicit_request, &temp.0, Limits::default())?;
        assert_eq!(
            subagent_no_background::evaluate_prepared(&implicit, b"{}")?,
            subagent_no_background::evaluate_prepared(&prepared, b"{}")?
        );
        assert_eq!(
            expanded.lines().nth(prepared.capture().input_line - 1),
            Some("payload=${payload-$(cat)}")
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
        let bash = bin.join("bash");
        fs::write(&bash, format!("#!/bin/sh\n{body}\n"))?;
        fs::set_permissions(&bash, fs::Permissions::from_mode(0o700))?;
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
