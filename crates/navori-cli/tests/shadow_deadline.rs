//! Shadow wall-clock deadline: process-group kill, non-blocking stdin and the deadline table.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use navori_cli::delegate::Locations;
use navori_cli::journal::{CliJournal, ShadowJournal};
use navori_cli::shadow::{Comparison, SHADOW_DEADLINES, ShellInvocation, deadline_for, run_until};
use navori_core::js_json;
use navori_core::render::claude_settings::build_claude_settings;
use navori_core::render::codex_hooks::resolve_codex_hooks;
use navori_core::render::harness_plan::{AssetRef, HarnessPlan, PlannedUnit};
use navori_core::render::pi_projection::active_pi_hook_bindings;
use navori_core::render::presets::AssetRoot;
use navori_hooks::runner::{Context, Engine, Evaluation, Verdict};

type TestResult = Result<(), Box<dyn Error>>;

fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "navori-shadow-deadline-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn permit(_: &[u8]) -> Result<Evaluation, navori_hooks::runner::Failure> {
    Ok(Evaluation {
        verdict: Verdict::Permit,
        stdout: Vec::new(),
        stderr: Vec::new(),
        audit: None,
    })
}

// Covers: A1
#[test]
fn deadline_kills_the_process_group_and_returns_despite_unread_stdin() -> TestResult {
    let dir = scratch("group")?;
    let script = dir.join("hook.sh");
    let pidfile = dir.join("grandchild.pid");
    // The grandchild inherits stdin/stdout/stderr; the script never reads stdin.
    fs::write(
        &script,
        format!("sleep 30 &\necho $! > '{}'\nsleep 30\n", pidfile.display()),
    )?;
    let env: Vec<(OsString, OsString)> = vec![("PATH".into(), "/usr/bin:/bin".into())];
    let payload = vec![b'x'; 256 * 1024];
    let context = Context {
        engine: Engine::Claude,
        hook: "guard-destructive",
        gating: true,
    };
    let started = Instant::now();
    let result = run_until(
        context,
        &payload,
        ShellInvocation {
            script: &script,
            args: &[],
            cwd: &dir,
            env: &env,
        },
        Some(started + Duration::from_millis(300)),
        permit,
    );
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "returned after {elapsed:?}"
    );
    assert!(result.comparison.shell_failed);
    let pid = fs::read_to_string(&pidfile)?.trim().to_owned();
    std::thread::sleep(Duration::from_millis(200));
    let survived = alive(&pid);
    let _ = fs::remove_dir_all(&dir);
    assert!(!survived, "grandchild {pid} survived the group kill");
    // Claude + gating: the safe response is `ask`, never an approval.
    let output: serde_json::Value = serde_json::from_slice(result.shell.stdout())?;
    assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "ask");
    Ok(())
}

// Covers: A1
#[test]
fn an_expired_deadline_never_starts_the_shell() -> TestResult {
    let native_ran = std::cell::Cell::new(false);
    let dir = scratch("expired")?;
    let script = dir.join("hook.sh");
    let marker = dir.join("ran");
    fs::write(&script, format!("touch '{}'\n", marker.display()))?;
    let env: Vec<(OsString, OsString)> = vec![("PATH".into(), "/usr/bin:/bin".into())];
    let context = Context {
        engine: Engine::Codex,
        hook: "guard-destructive",
        gating: true,
    };
    let result = run_until(
        context,
        b"{}",
        ShellInvocation {
            script: &script,
            args: &[],
            cwd: &dir,
            env: &env,
        },
        Some(Instant::now()),
        |bytes| {
            native_ran.set(true);
            permit(bytes)
        },
    );
    let ran = marker.exists();
    let _ = fs::remove_dir_all(&dir);
    assert!(!ran);
    // The native lane would only delay the fail-safe: past the deadline it does not run either.
    assert!(!native_ran.get());
    assert!(result.comparison.native_unobserved);
    assert!(result.comparison.shell_failed);
    assert_eq!(result.shell.code(), 2);
    Ok(())
}

/// A plan that registers only `hook`, so the settings render keeps its registration.
fn plan_with(hook: &str) -> HarnessPlan {
    HarnessPlan {
        hooks: vec![PlannedUnit {
            id: hook.to_owned(),
            asset: AssetRef {
                root: AssetRoot::Bundled,
                rel: format!("hooks/{hook}.sh"),
            },
            managed_id: hook.to_owned(),
            main_thread_only: false,
        }],
        ..HarnessPlan::default()
    }
}

/// Lowest timeout (seconds) the Claude settings render registers for `hook`.
fn claude_timeout(hook: &str) -> Result<Option<f64>, Box<dyn Error>> {
    let config = js_json::parse("{}").ok_or("config")?;
    let settings = build_claude_settings(&config, &plan_with(hook), &[])
        .map_err(|_| "claude settings")?
        .stringify(None)
        .ok_or("stringify")?;
    let settings: serde_json::Value = serde_json::from_str(&settings)?;
    let mut lowest: Option<f64> = None;
    for groups in settings["hooks"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
    {
        for group in groups.as_array().into_iter().flatten() {
            for entry in group["hooks"].as_array().into_iter().flatten() {
                let command = entry["command"].as_str().unwrap_or_default();
                if command.contains(hook)
                    && let Some(timeout) = entry["timeout"].as_f64()
                {
                    lowest = Some(lowest.map_or(timeout, |low| low.min(timeout)));
                }
            }
        }
    }
    Ok(lowest)
}

/// Lowest timeout (seconds) the Codex hooks render registers for `hook`.
fn codex_timeout(hook: &str) -> Result<Option<u32>, Box<dyn Error>> {
    let config = js_json::parse("{}").ok_or("config")?;
    let hooks = resolve_codex_hooks(&config, &[]).ok_or("codex hooks")?;
    Ok(hooks
        .iter()
        .filter(|resolved| resolved.script == hook)
        .map(|resolved| resolved.timeout)
        .min())
}

// Covers: A3
#[test]
fn deadline_table_is_guard_destructive_only_and_below_every_render_timeout() -> TestResult {
    let ids: Vec<&str> = SHADOW_DEADLINES.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, ["guard-destructive"]);
    assert_eq!(SHADOW_DEADLINES[0].1, Duration::from_millis(8500));
    let claude = claude_timeout("guard-destructive")?.ok_or("claude registers no timeout")?;
    let codex = codex_timeout("guard-destructive")?.ok_or("codex registers no timeout")?;
    let config = js_json::parse("{}").ok_or("config")?;
    let pi_ms = active_pi_hook_bindings(&config)
        .iter()
        .filter(|binding| binding.script == "guard-destructive")
        .map(|binding| binding.timeout_ms)
        .min()
        .ok_or("pi binds no guard-destructive")?;
    for (id, budget) in SHADOW_DEADLINES {
        let lowest = claude.min(f64::from(codex)).min(f64::from(pi_ms) / 1000.0);
        assert!(
            budget.as_secs_f64() < lowest,
            "{id}: {budget:?} >= {lowest}s"
        );
    }
    let start = Instant::now();
    assert_eq!(
        deadline_for("guard-destructive", start),
        Some(start + Duration::from_millis(8500))
    );
    assert_eq!(deadline_for("plan-gate", start), None);
    Ok(())
}

const MATCH: Comparison = Comparison {
    native_unobserved: false,
    native_failed: false,
    shell_failed: false,
    code_differs: false,
    stdout_differs: false,
    stderr_differs: false,
    shell_code: None,
    native_code: None,
};

/// A journal backed by a fake TS CLI whose body is `script`.
fn fake_journal(dir: &Path, script: &str) -> Result<CliJournal, Box<dyn Error>> {
    let cli = dir.join("fake-navori");
    fs::write(&cli, format!("#!/bin/sh\n{script}\n"))?;
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755))?;
    CliJournal::from_locations(&Locations {
        ts_cli: Some(cli.into_os_string()),
        checkout_dist: dir.join("missing/index.js"),
        path: None,
        self_exe: None,
    })
    .ok_or_else(|| "fake CLI not resolved".into())
}

// Covers: A2
#[test]
fn a_slow_begin_is_killed_with_its_group_at_the_deadline() -> TestResult {
    let dir = scratch("begin")?;
    let pidfile = dir.join("grandchild.pid");
    let journal = fake_journal(
        &dir,
        &format!("sleep 30 &\necho $! > '{}'\nsleep 30", pidfile.display()),
    )?;
    let started = Instant::now();
    let receipt = journal.begin_until(
        Path::new("/repo"),
        "guard-destructive",
        Engine::Claude,
        "impl",
        Some(started + Duration::from_millis(300)),
    );
    let elapsed = started.elapsed();
    assert!(receipt.is_none());
    assert!(elapsed < Duration::from_secs(2), "begin took {elapsed:?}");
    let pid = fs::read_to_string(&pidfile)?.trim().to_owned();
    std::thread::sleep(Duration::from_millis(200));
    let survived = alive(&pid);
    let _ = fs::remove_dir_all(&dir);
    assert!(!survived, "grandchild {pid} survived");
    Ok(())
}

// Covers: A2
#[test]
fn a_prompt_begin_still_acknowledges_under_a_deadline() -> TestResult {
    let dir = scratch("begin-ok")?;
    let journal = fake_journal(&dir, "printf '{\"kind\":\"begin\",\"id\":\"r1\"}\\n'")?;
    let receipt = journal.begin_until(
        Path::new("/repo"),
        "guard-destructive",
        Engine::Claude,
        "impl",
        Some(Instant::now() + Duration::from_secs(5)),
    );
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(
        receipt.as_deref(),
        Some("{\"kind\":\"begin\",\"id\":\"r1\"}")
    );
    Ok(())
}

// Covers: A2
#[test]
fn a_slow_complete_is_abandoned_at_the_deadline() -> TestResult {
    let dir = scratch("complete")?;
    let pidfile = dir.join("grandchild.pid");
    // Never reads stdin and never exits on its own.
    let journal = fake_journal(
        &dir,
        &format!("sleep 30 &\necho $! > '{}'\nsleep 30", pidfile.display()),
    )?;
    let started = Instant::now();
    journal.complete_until(
        Path::new("/repo"),
        "{\"kind\":\"begin\",\"id\":\"r1\"}",
        MATCH,
        Some(started + Duration::from_millis(300)),
    );
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "complete took {elapsed:?}"
    );
    let pid = fs::read_to_string(&pidfile)?.trim().to_owned();
    std::thread::sleep(Duration::from_millis(200));
    let survived = alive(&pid);
    let _ = fs::remove_dir_all(&dir);
    assert!(!survived, "grandchild {pid} survived");
    Ok(())
}
