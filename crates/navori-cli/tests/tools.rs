//! Spec 0059 T13 (R59): when `tools notice` or `tools session-context` reserves the daily refresh,
//! the worker is the `navori` of `PATH`, launched with the TS's private flag and the token written
//! to `attempts.json`. The fake `navori` only records its argv: `latest.json`, which only the
//! network worker writes, must stay absent, so the native process fetched nothing itself.

use std::error::Error;
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");
const WORKER_ARG: &str = "--navori-private-tool-version-worker";
type TestResult = Result<(), Box<dyn Error>>;

const CONFIG: &str = r#"{"name":"x","version":"1.0.0","harnessVersion":"0.12.2","engines":["claude"],"preset":"custom","language":"en","branchBase":"main","gitignoreHarness":"off","commits":"conventional-es","plugins":{"engram":{"enabled":true}},"qualityGate":{"fast":"bun run fast","full":"bun run check"}}"#;

fn executable(path: &Path, body: &str) -> TestResult {
    fs::write(path, body)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("tools-{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    for sub in ["repo", "bin", "home"] {
        fs::create_dir_all(dir.join(sub))?;
    }
    let dir = fs::canonicalize(dir)?;
    fs::write(dir.join("repo/navori.config.json"), CONFIG)?;
    executable(&dir.join("bin/engram"), "#!/bin/sh\necho engram 1.2.3\n")?;
    let record = dir.join("worker-argv");
    executable(
        &dir.join("bin/navori"),
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}.tmp' && mv '{0}.tmp' '{0}'\n",
            record.display()
        ),
    )?;
    Ok(dir)
}

fn wait_for(path: &Path) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(path) {
            return Some(text);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

struct Case {
    name: &'static str,
    args: &'static [&'static str],
    env: &'static [(&'static str, &'static str)],
    fresh_attempt: bool,
    spawns: bool,
}

// Covers: R59
#[test]
fn el_worker_de_versiones_lo_lanza_el_navori_de_path_con_flag_y_token_y_rust_no_abre_sockets()
-> TestResult {
    let cases = [
        Case {
            name: "notice-due",
            args: &["tools", "notice"],
            env: &[],
            fresh_attempt: false,
            spawns: true,
        },
        Case {
            name: "context-due",
            args: &["tools", "session-context"],
            env: &[],
            fresh_attempt: false,
            spawns: true,
        },
        Case {
            name: "context-reserve",
            args: &["tools", "session-context", "--notice-reserve", "512"],
            env: &[],
            fresh_attempt: false,
            spawns: true,
        },
        Case {
            name: "notice-fresh",
            args: &["tools", "notice"],
            env: &[],
            fresh_attempt: true,
            spawns: false,
        },
        Case {
            name: "notice-opted-out",
            args: &["tools", "notice"],
            env: &[("NAVORI_NO_UPDATE_NOTIFIER", "1")],
            fresh_attempt: false,
            spawns: false,
        },
        Case {
            name: "context-ci",
            args: &["tools", "session-context"],
            env: &[("CI", "1")],
            fresh_attempt: false,
            spawns: false,
        },
    ];
    let mut failures = Vec::new();
    for case in &cases {
        let dir = scratch(case.name)?;
        let state = dir.join("home/.navori/tool-versions");
        if case.fresh_attempt {
            fs::create_dir_all(&state)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis();
            fs::write(
                state.join("attempts.json"),
                format!(r#"{{"engram":{{"at":{now},"token":null}}}}"#),
            )?;
        }
        let out = Command::new(BIN)
            .args(case.args)
            .current_dir(dir.join("repo"))
            .env_clear()
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", dir.join("bin").display()),
            )
            .env("HOME", dir.join("home"))
            // Any delegation would fail loudly: these calls must stay native.
            .env("NAVORI_TS_CLI", "/nonexistent/index.js")
            .envs(case.env.iter().copied())
            .output()?;
        let attempts = fs::read_to_string(state.join("attempts.json")).unwrap_or_default();
        let record = dir.join("worker-argv");
        let argv = if case.spawns {
            wait_for(&record)
        } else {
            std::thread::sleep(Duration::from_millis(300));
            fs::read_to_string(&record).ok()
        };
        let token = attempts
            .split("\"token\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_default()
            .to_owned();
        let shape_ok = !case.spawns
            || (attempts.starts_with(r#"{"engram":{"at":"#)
                && attempts.ends_with(&format!(r#","token":"{token}"}}}}"#))
                && token.len() == 36);
        let argv_ok = match &argv {
            Some(argv) => case.spawns && *argv == format!("{WORKER_ARG}\n{token}\n"),
            None => !case.spawns,
        };
        if !out.status.success() && case.args[1] == "notice"
            || !shape_ok
            || !argv_ok
            || state.join("latest.json").exists()
        {
            failures.push(format!(
                "{}: exit {:?}, attempts {attempts:?}, worker argv {argv:?}, stderr {:?}",
                case.name,
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        fs::remove_dir_all(&dir)?;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}
