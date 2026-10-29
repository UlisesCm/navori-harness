//! `navori plan gate` native (spec 0059 T11, R58): with an audit session in the environment and a
//! regular session log in the repo's audit directory, the whole invocation goes to the TS before
//! stdin is read; otherwise Rust decides. The "TS CLI" is a stub that records its stdin.

use std::error::Error;
use std::fs;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");
type TestResult = Result<(), Box<dyn Error>>;

fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Where the session log of a case lives, if any.
enum Log {
    None,
    AuditsRoot(&'static str),
    Home(&'static str),
    Directory,
}

struct Case {
    name: &'static str,
    env: &'static [(&'static str, &'static str)],
    log: Log,
    delegated: bool,
}

// Covers: R58
#[test]
fn con_log_de_audit_mode_re_delega_antes_de_leer_stdin() -> TestResult {
    let cases = [
        Case {
            name: "claude session + log",
            env: &[("CLAUDE_CODE_SESSION_ID", "s1")],
            log: Log::AuditsRoot("proj"),
            delegated: true,
        },
        Case {
            name: "audit pair + log under HOME",
            env: &[
                ("NAVORI_AUDIT_HOST", "codex"),
                ("NAVORI_AUDIT_SESSION_ID", "s1"),
            ],
            log: Log::Home("proj"),
            delegated: true,
        },
        Case {
            name: "codex thread + log",
            env: &[("CODEX_THREAD_ID", "t1")],
            log: Log::AuditsRoot("proj"),
            delegated: true,
        },
        Case {
            name: "identity without log",
            env: &[("CLAUDE_CODE_SESSION_ID", "s1")],
            log: Log::None,
            delegated: false,
        },
        Case {
            name: "log without identity",
            env: &[],
            log: Log::AuditsRoot("proj"),
            delegated: false,
        },
        Case {
            name: "blank identity",
            env: &[("CLAUDE_CODE_SESSION_ID", "  ")],
            log: Log::AuditsRoot("proj"),
            delegated: false,
        },
        Case {
            name: "log is a directory",
            env: &[("CLAUDE_CODE_SESSION_ID", "s1")],
            log: Log::Directory,
            delegated: false,
        },
        Case {
            name: "log of another repo",
            env: &[("CLAUDE_CODE_SESSION_ID", "s1")],
            log: Log::AuditsRoot("other"),
            delegated: false,
        },
    ];
    // A non-implementer spawn: the native gate allows it silently, before any config read.
    let payload = r#"{"session_id":"s1","tool_input":{"subagent_type":"scout","prompt":"x"}}"#;
    let mut failures = Vec::new();
    for case in &cases {
        let dir = scratch(&format!("plan-gate-{}", case.name.replace(' ', "-")))?;
        let repo = dir.join("proj");
        let (home, audits) = (dir.join("home"), dir.join("audits"));
        for d in [&repo, &home, &audits] {
            fs::create_dir_all(d)?;
        }
        let ts = dir.join("ts.sh");
        fs::write(
            &ts,
            "#!/bin/sh\n{ echo \"args:$*\"; echo \"stdin:$(cat)\"; } > \"$OUT\"\nexit 42\n",
        )?;
        fs::set_permissions(&ts, fs::Permissions::from_mode(0o755))?;
        match case.log {
            Log::None => {}
            Log::AuditsRoot(repo_name) => {
                fs::create_dir_all(audits.join(repo_name))?;
                fs::write(audits.join(repo_name).join("session-s1.log"), "")?;
            }
            Log::Home(repo_name) => {
                let d = home.join(".navori/audits").join(repo_name);
                fs::create_dir_all(&d)?;
                fs::write(d.join("session-s1.log"), "")?;
            }
            Log::Directory => fs::create_dir_all(audits.join("proj/session-s1.log"))?,
        }
        let record = dir.join("record.txt");
        let mut command = Command::new(BIN);
        command
            .args(["plan", "gate"])
            .current_dir(&repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("NAVORI_AUDITS_ROOT", &audits)
            .env("NAVORI_TS_CLI", &ts)
            .env("OUT", &record)
            .envs(case.env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(payload.as_bytes())?;
        let out = child.wait_with_output()?;
        let recorded = fs::read_to_string(&record).unwrap_or_default();
        let expected_code = if case.delegated { 42 } else { 0 };
        let stdin_intact = recorded.contains(&format!("stdin:{payload}"));
        if out.status.code() != Some(expected_code)
            || stdin_intact != case.delegated
            || (case.delegated && !recorded.contains("args:plan gate"))
            || (!case.delegated && (!out.stdout.is_empty() || !out.stderr.is_empty()))
        {
            failures.push(format!(
                "{}: exit {:?}, record {recorded:?}, stderr {:?}",
                case.name,
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}
