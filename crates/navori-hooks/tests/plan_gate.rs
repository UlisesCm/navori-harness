//! Spec 0059 T12 (R50, R53): plan-gate's decision and its one effect, `navori plan gate`.
//!
//! With the `navori` of `PATH` at this build's version the call runs in process; with another
//! version it runs that `navori` as the shell does. Both lanes must leave the same verdict, audit
//! label, output and state. The other-version `navori` is a shell script whose `plan gate` execs
//! this test binary (`navori_helper`), which answers with the same core decision a TS CLI of
//! that version would compute; `--version` prints the other version.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use navori_core::plan::gate as core_gate;
use navori_hooks::hooks::plan_gate::call::{self, Lane, Navori};
use navori_hooks::hooks::plan_gate::{Context, Rendered, Step, after_call, evaluate, stale_hint};
use navori_hooks::runner::{AuditLabel, Evaluation, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::{Extractor, Profile};

type TestResult = Result<(), Box<dyn Error>>;

const HELPER_ENV: &str = "NAVORI_T12_HELPER";
const OTHER_VERSION: &str = "0.0.9";
const ROLES: &str = " scout architect auditor reviewer scribe publisher explorer ";

/// The other-version `navori plan gate`: the core decision, printed as the CLI prints it.
#[test]
fn navori_helper() {
    if std::env::var_os(HELPER_ENV).is_none() {
        return;
    }
    let mut stdin = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut stdin);
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let ctx = core_gate::Context {
        process_cwd: &cwd,
        env: &env,
        now_ms: now_ms as f64,
        pid: std::process::id(),
    };
    let codex = std::env::var_os("NAVORI_HOOK_ENGINE").is_some_and(|v| v == "codex");
    let Some((code, stderr)) = core_gate::evaluate(&stdin, codex, &ctx).report() else {
        std::process::exit(99);
    };
    // Written to the descriptor: libtest captures `eprint!` inside a test.
    let _ = std::io::stderr().lock().write_all(stderr.as_bytes());
    std::process::exit(i32::from(code));
}

fn scratch() -> Result<PathBuf, Box<dyn Error>> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // Outside any git checkout: the gate resolves the repository from the working directory.
    let root = std::env::temp_dir().join(format!(
        "navori-t12-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    for dir in [
        "bin",
        "home",
        "audits",
        "proj/src",
        "proj/.navori/state/handoffs",
    ] {
        fs::create_dir_all(root.join(dir))?;
    }
    Ok(fs::canonicalize(root)?)
}

fn config(plan_tiers: bool, harness: &str) -> String {
    format!(
        r#"{{"name":"x","version":"1.0.0","harnessVersion":"{harness}","engines":["claude","codex"],"preset":"custom","language":"es","branchBase":"main","gitignoreHarness":"off","commits":"conventional-es","harness":{{"planTiers":{plan_tiers}}},"qualityGate":{{"fast":"bun run fast","full":"bun run check"}}}}"#
    )
}

const WORKPLAN: &str = r#"{"feature": "wp-ok", "level": 1, "classification": {"score": 0, "level": 0, "signals": []}, "objective": "o", "acceptance": [{"id": "A1", "description": "d", "command": "bun x", "expected": "exit 0"}], "files": [{"path": "src/a.ts", "new": false}], "progress": {"A1": "pendiente"}}"#;

/// The current UTC time in the ISO shape a dispatch marker's `createdAt` carries.
fn now_iso() -> Result<String, Box<dyn Error>> {
    let out = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%S.000Z"])
        .output()?;
    Ok(String::from_utf8(out.stdout)?.trim().to_owned())
}

struct Case {
    name: &'static str,
    codex: bool,
    payload: &'static str,
    plan_tiers: bool,
    harness: &'static str,
    marker: bool,
    verdict: Verdict,
    audit: (&'static str, &'static str),
    hint: bool,
}

fn context(codex: bool) -> Context<'static> {
    let script = if codex {
        "/r/.codex/hooks/plan-gate.sh"
    } else {
        "/r/.claude/hooks/plan-gate.sh"
    };
    Context {
        profile: Profile {
            extractor: Extractor::JqAndNode,
            locale: Locale::Utf8,
        },
        capture: CaptureContext {
            shell: ShellDialect::Bash5,
            script: Path::new(script),
            input_line: 1,
            fallback_line: 1,
        },
        rendered: Rendered {
            roles: ROLES.to_owned(),
            input_line: 1,
        },
        script: script.to_owned(),
    }
}

/// One case through the whole script in a fresh project, with `navori` at `version`.
fn run_case(case: &Case, version: &str) -> Result<(Evaluation, Lane, bool), Box<dyn Error>> {
    let root = scratch()?;
    let proj = root.join("proj");
    // A repository, so the audit directory of the project is derivable (and holds no log).
    let git = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&proj)
        .status()?;
    if !git.success() {
        return Err("git init failed".into());
    }
    fs::write(
        proj.join("navori.config.json"),
        config(case.plan_tiers, case.harness),
    )?;
    fs::write(proj.join("src/a.ts"), "")?;
    let handoffs = proj.join(".navori/state/handoffs");
    fs::write(handoffs.join("workplan_wp-ok.json"), WORKPLAN)?;
    let marker = handoffs.join("dispatch_n0.json");
    if case.marker {
        fs::write(
            &marker,
            format!(
                r#"{{"feature": "n0", "opening": "nivel-0: src/a.ts n0 | verify: `bun x` → exit 0", "createdAt": "{}", "sessionId": "s1"}}"#,
                now_iso()?
            ),
        )?;
    }
    let exe = std::env::current_exe()?;
    let navori = root.join("bin/navori");
    fs::write(
        &navori,
        format!(
            "#!/bin/sh\ncase \"$1\" in\n  --version) echo \"navori {OTHER_VERSION}\" ;;\n  plan) exec '{}' --exact navori_helper --quiet --test-threads=1 >/dev/null ;;\nesac\n",
            exe.display()
        ),
    )?;
    fs::set_permissions(&navori, fs::Permissions::from_mode(0o755))?;
    let env: Vec<(OsString, OsString)> = vec![
        (
            "PATH".into(),
            format!("{}:/usr/bin:/bin", root.join("bin").display()).into(),
        ),
        ("HOME".into(), root.join("home").into()),
        ("NAVORI_AUDITS_ROOT".into(), root.join("audits").into()),
        (HELPER_ENV.into(), "1".into()),
    ];
    let context = context(case.codex);
    let Step::Call(pending, request) = evaluate(case.payload.as_bytes(), &context, || true)? else {
        return Err(format!("{}: stopped before navori plan gate", case.name).into());
    };
    let lane = Navori {
        program: &navori,
        version: Some(version),
        env: &env,
        cwd: &proj,
        pwd: proj.as_os_str(),
    };
    let answer = call::run(&lane, &request)?;
    let evaluation = after_call(pending, answer.status, &answer.output, || {
        let bytes = fs::read(proj.join("navori.config.json")).ok();
        stale_hint(
            bytes.as_deref(),
            || call::cli_version(&lane, answer.lane),
            Locale::Utf8,
        )
    })?;
    let claimed = case.marker && !marker.exists();
    fs::remove_dir_all(&root)?;
    // Each lane runs in its own project: compare messages without the scratch path.
    let stderr =
        String::from_utf8(evaluation.stderr)?.replace(&root.display().to_string(), "<root>");
    let evaluation = Evaluation {
        stderr: stderr.into_bytes(),
        ..evaluation
    };
    Ok((evaluation, answer.lane, claimed))
}

// Covers: R53
#[test]
fn con_otra_version_de_navori_usa_el_subproceso_y_da_el_mismo_veredicto() -> TestResult {
    let cases = [
        Case {
            name: "claude workplan verde",
            codex: false,
            payload: r#"{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"implementer","prompt":"workplan: wp-ok\nresto"}}"#,
            plan_tiers: true,
            harness: "0.0.1",
            marker: false,
            verdict: Verdict::Permit,
            audit: ("allow", ""),
            hint: false,
        },
        Case {
            name: "claude workplan ausente",
            codex: false,
            payload: r#"{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"implementer","prompt":"workplan: missing"}}"#,
            plan_tiers: true,
            harness: "0.0.1",
            marker: false,
            verdict: Verdict::Block,
            audit: ("block", "plan-denied"),
            hint: false,
        },
        Case {
            name: "claude sin apertura con CLI viejo",
            codex: false,
            payload: r#"{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"implementer","prompt":"haz algo"}}"#,
            plan_tiers: true,
            harness: "99.0.0",
            marker: false,
            verdict: Verdict::Block,
            audit: ("block", "plan-denied"),
            hint: true,
        },
        Case {
            name: "claude rol con mayúsculas fuera del atajo",
            codex: false,
            payload: r#"{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"Scout","prompt":"x"}}"#,
            plan_tiers: true,
            harness: "99.0.0",
            marker: false,
            verdict: Verdict::Permit,
            audit: ("allow", ""),
            hint: false,
        },
        Case {
            name: "claude sin planTiers",
            codex: false,
            payload: r#"{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"implementer","prompt":"workplan: missing"}}"#,
            plan_tiers: false,
            harness: "99.0.0",
            marker: false,
            verdict: Verdict::Permit,
            audit: ("allow", ""),
            hint: false,
        },
        Case {
            name: "codex marcador de nivel 0",
            codex: true,
            payload: r#"{"hook_event_name":"PreToolUse","tool_name":"spawn_agent","tool_input":{"agent_type":"default","message":"gAAAAAxyz"},"session_id":"s1"}"#,
            plan_tiers: true,
            harness: "0.0.1",
            marker: true,
            verdict: Verdict::Permit,
            audit: ("allow", ""),
            hint: false,
        },
        Case {
            name: "codex sin marcador",
            codex: true,
            payload: r#"{"hook_event_name":"PreToolUse","tool_name":"spawn_agent","tool_input":{"agent_type":"default","message":"gAAAAAxyz"},"session_id":"s1"}"#,
            plan_tiers: true,
            harness: "99.0.0",
            marker: false,
            verdict: Verdict::Block,
            audit: ("block", "plan-denied"),
            hint: true,
        },
    ];
    let mut failures = Vec::new();
    for case in &cases {
        let (native, native_lane, native_claim) = run_case(case, navori_core::STAMP_VERSION)?;
        let (shell, shell_lane, shell_claim) = run_case(case, OTHER_VERSION)?;
        let expected_audit = AuditLabel {
            verdict: case.audit.0,
            reason: case.audit.1.to_owned(),
        };
        let stamp = format!("it is {} but", navori_core::STAMP_VERSION);
        let other = format!("it is {OTHER_VERSION} but");
        let hinted = |e: &Evaluation, text: &str| String::from_utf8_lossy(&e.stderr).contains(text);
        let same_text = String::from_utf8_lossy(&native.stderr)
            == String::from_utf8_lossy(&shell.stderr).replace(&other, &stamp);
        if native_lane != Lane::InProcess
            || shell_lane != Lane::Subprocess
            || native.verdict != case.verdict
            || shell.verdict != case.verdict
            || native.audit.as_ref() != Some(&expected_audit)
            || shell.audit != native.audit
            || native.stdout != shell.stdout
            || !same_text
            || hinted(&native, &stamp) != case.hint
            || hinted(&shell, &other) != case.hint
            || native_claim != case.marker
            || shell_claim != case.marker
        {
            failures.push(format!(
                "{}: lanes {native_lane:?}/{shell_lane:?}, verdicts {:?}/{:?}, audit {:?}/{:?}, claim {native_claim}/{shell_claim}\n  native stderr {:?}\n  shell stderr  {:?}",
                case.name,
                native.verdict,
                shell.verdict,
                native.audit,
                shell.audit,
                String::from_utf8_lossy(&native.stderr),
                String::from_utf8_lossy(&shell.stderr),
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}

// Covers: R50
#[test]
fn sin_veredicto_pregunta_en_claude_y_bloquea_en_codex_o_sin_prompt() -> TestResult {
    let payload = |mode: &str| {
        format!(
            r#"{{"hook_event_name":"PreToolUse","permission_mode":"{mode}","tool_name":"Agent","tool_input":{{"subagent_type":"implementer","prompt":"x"}}}}"#
        )
    };
    // (codex copy, permission mode, navori on PATH, exit of plan gate) → verdict, audit, ask.
    type Row = (
        bool,
        &'static str,
        bool,
        i32,
        Verdict,
        &'static str,
        &'static str,
        bool,
    );
    let cases: [Row; 12] = [
        (
            false,
            "default",
            false,
            0,
            Verdict::Permit,
            "ask",
            "binary-missing",
            true,
        ),
        (
            false,
            "bypassPermissions",
            false,
            0,
            Verdict::Block,
            "block",
            "binary-missing",
            false,
        ),
        (
            true,
            "default",
            false,
            0,
            Verdict::Block,
            "block",
            "binary-missing",
            false,
        ),
        (false, "auto", true, 0, Verdict::Permit, "allow", "", false),
        (
            false,
            "auto",
            true,
            2,
            Verdict::Block,
            "block",
            "plan-denied",
            false,
        ),
        (
            true,
            "default",
            true,
            2,
            Verdict::Block,
            "block",
            "plan-denied",
            false,
        ),
        (
            false,
            "acceptEdits",
            true,
            1,
            Verdict::Permit,
            "ask",
            "subcommand-unavailable",
            true,
        ),
        (
            false,
            "default",
            true,
            127,
            Verdict::Permit,
            "ask",
            "subcommand-unavailable",
            true,
        ),
        (
            false,
            "plan",
            true,
            137,
            Verdict::Block,
            "block",
            "subcommand-unavailable",
            false,
        ),
        (
            true,
            "default",
            true,
            1,
            Verdict::Block,
            "block",
            "subcommand-unavailable",
            false,
        ),
        (true, "auto", true, 0, Verdict::Permit, "allow", "", false),
        (
            false,
            "dontAsk",
            true,
            3,
            Verdict::Block,
            "block",
            "subcommand-unavailable",
            false,
        ),
    ];
    let mut failures = Vec::new();
    for (codex, mode, found, status, verdict, audit, reason, ask) in cases {
        let context = context(codex);
        let evaluation = match evaluate(payload(mode).as_bytes(), &context, || found)? {
            Step::Done(evaluation) => evaluation,
            Step::Call(pending, request) => {
                if request.codex != codex {
                    failures.push(format!("{codex}/{mode}: codex flag {}", request.codex));
                }
                after_call(pending, status, b"plan gate said\n\n", || Ok(None))?
            }
        };
        let stdout = String::from_utf8_lossy(&evaluation.stdout);
        let stderr = String::from_utf8_lossy(&evaluation.stderr);
        let exit_text = format!("(exit {status})");
        let replayed = !found || stderr.starts_with("plan gate said\n");
        let names_exit = reason != "subcommand-unavailable"
            || if ask {
                stdout.contains(&exit_text)
            } else {
                stderr.contains(&exit_text)
            };
        if evaluation.verdict != verdict
            || evaluation.audit
                != Some(AuditLabel {
                    verdict: audit,
                    reason: reason.to_owned(),
                })
            || stdout.contains("\"permissionDecision\":\"ask\"") != ask
            || !replayed
            || !names_exit
        {
            failures.push(format!(
                "{codex}/{mode}/{found}/{status}: {:?} {:?}\n  stdout {stdout:?}\n  stderr {stderr:?}",
                evaluation.verdict, evaluation.audit
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}

// Covers: R50
#[test]
fn la_pista_de_cli_viejo_compara_versiones_como_el_script() -> TestResult {
    let config = |harness: &str| {
        format!("{{\n  \"name\": \"x\",\n  \"harnessVersion\" : \"{harness}\"\n}}\n")
    };
    // (harnessVersion, `navori --version` line, hint expected)
    let cases = [
        ("0.12.3", "navori 0.12.2", true),
        ("0.12.3", "0.12.3", false),
        ("0.12.3", "navori 1.0.0-beta", false),
        ("1.0.0", "0.99.999", true),
        ("0.12.3", "", false),
        ("0.12.3", "navori v0.1.0", false),
        ("", "0.1.0", false),
        ("next", "0.1.0", false),
    ];
    let mut failures = Vec::new();
    for (harness, cli, expected) in cases {
        let bytes = config(harness).into_bytes();
        let hint = stale_hint(Some(&bytes), || Ok(cli.to_owned()), Locale::Utf8)?;
        if hint.is_some() != expected
            || hint
                .as_deref()
                .is_some_and(|h| !h.contains(&format!("harnessVersion {harness},")))
        {
            failures.push(format!("{harness}/{cli}: {hint:?}"));
        }
    }
    // Unreadable config: no hint and `navori --version` never runs.
    let hint = stale_hint(
        None,
        || Err(navori_hooks::runner::Failure("ran".into())),
        Locale::Utf8,
    )?;
    if hint.is_some() {
        failures.push("unreadable config hinted".to_owned());
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}
