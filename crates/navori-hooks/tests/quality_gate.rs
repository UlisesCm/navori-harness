//! Spec 0059 T7 (R50): quality-gate-pre-commit's decision per verdict class in Claude, Codex
//! and Pi, and where it stops for an effect (D40). The recorded corpus itself is replayed
//! byte for byte by `hook-verdict-replay.mjs --impl rust`; this suite pins each class on the
//! pure decision with stub host facts.

use std::error::Error;
use std::path::Path;

use navori_hooks::hooks::quality_gate_pre_commit::{
    Context, Gate, Rendered, Step, after_foreign, after_gate, evaluate,
};
use navori_hooks::runner::{Engine, Evaluation, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::hook_input::Host;
use navori_hooks::shell::payload::{Extractor, Profile};
use navori_hooks::shell::repo::{Loss, Repo};

type TestResult = Result<(), Box<dyn Error>>;

/// A host outside any git repository with no session-state file.
struct NoRepo;

impl Repo for NoRepo {
    fn is_dir(&self, dir: &str) -> bool {
        dir == "/work"
    }
    fn holds(&self, _: &str, _: Loss) -> bool {
        false
    }
    fn toplevel(&self, _: &str) -> Option<String> {
        None
    }
    fn superproject(&self, _: &str) -> Option<String> {
        None
    }
    fn repo_id(&self, _: &str) -> Option<String> {
        None
    }
    fn physical(&self, dir: &str) -> Option<String> {
        Some(dir.to_owned())
    }
    fn ignored(&self, _: &str, _: &str) -> bool {
        false
    }
    fn file_size(&self, _: &str, _: &str) -> u64 {
        0
    }
    fn blob_size(&self, _: &str, _: &str) -> u64 {
        0
    }
    fn is_file(&self, _: &str) -> bool {
        false
    }
    fn tgrep_status(&self, _: Option<&str>) -> Option<String> {
        None
    }
}

/// `PATH` holds `found`; the probe answers `hit`.
struct Stub {
    found: &'static [&'static str],
    hit: bool,
}

impl Gate for Stub {
    fn on_path(&self, name: &str, _: &str) -> bool {
        self.found.contains(&name)
    }
    fn probe_hit(&self, _: &str) -> bool {
        self.hit
    }
    fn read(&self, _: &str) -> Option<Vec<u8>> {
        None
    }
    fn cd_error(&self, _: &str) -> Result<Option<&'static str>, String> {
        Ok(None)
    }
}

fn context(engine: Engine, native_fast: &str) -> Context<'static> {
    let script = match engine {
        Engine::Claude => ".claude/hooks/quality-gate-pre-commit.sh",
        Engine::Codex => ".codex/hooks/quality-gate-pre-commit.sh",
        Engine::Pi => ".pi/navori/hooks/quality-gate-pre-commit.sh",
    };
    Context {
        engine,
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
            gate: "pnpm run check".to_owned(),
            native_fast: native_fast.to_owned(),
            progress_cap: Some("{{navori.progressHardCapBytes}}".to_owned()),
            cd_line: 1,
            functions: vec!["run_gate".to_owned()],
        },
        host: Host {
            pwd: "/work".to_owned(),
            ..Host::default()
        },
        script: script.to_owned(),
    }
}

fn payload(command: &str, mode: &str) -> Vec<u8> {
    serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "permission_mode": mode,
        "tool_input": { "command": command },
    })
    .to_string()
    .into_bytes()
}

fn done(step: Step) -> Result<Evaluation, Box<dyn Error>> {
    match step {
        Step::Done(evaluation) => Ok(evaluation),
        other => Err(format!("expected a finished decision, got {other:?}").into()),
    }
}

fn audit(evaluation: &Evaluation) -> (&str, &str) {
    evaluation
        .audit
        .as_ref()
        .map_or(("", ""), |label| (label.verdict, label.reason.as_str()))
}

// Covers: R50
#[test]
fn veredictos_del_corpus_en_claude_codex_y_pi() -> TestResult {
    let missing = Stub {
        found: &[],
        hit: false,
    };
    // Not a commit: nothing printed, audited as a skip.
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        let e = done(evaluate(
            &payload("ls -la", "default"),
            &context(engine, "{{x}}"),
            &NoRepo,
            &missing,
        )?)?;
        assert_eq!(
            (e.verdict, e.stdout.len(), e.stderr.len()),
            (Verdict::Permit, 0, 0)
        );
        assert_eq!(audit(&e), ("skip", "el comando no es un commit"));
    }
    // Runner missing: block where nobody can be asked, ask in Claude's prompting modes.
    let blocked = |engine, mode| -> Result<Evaluation, Box<dyn Error>> {
        done(evaluate(
            &payload("git commit -m x", mode),
            &context(engine, "{{x}}"),
            &NoRepo,
            &missing,
        )?)
    };
    for (engine, mode) in [
        (Engine::Claude, "bypassPermissions"),
        (Engine::Codex, "default"),
        (Engine::Pi, "plan"),
    ] {
        let e = blocked(engine, mode)?;
        assert_eq!(e.verdict, Verdict::Block);
        assert_eq!(
            String::from_utf8(e.stderr.clone())?,
            "[navori] quality-gate NOT run: 'pnpm' is not on PATH and no alternative package manager was detected that could run it.\n[navori] Commit BLOCKED to avoid skipping the gate silently. Install 'pnpm', or if you really want to skip it run the commit yourself outside the agent.\n"
        );
        assert_eq!(audit(&e).0, "block");
    }
    let asked = blocked(Engine::Claude, "default")?;
    assert_eq!(asked.verdict, Verdict::Permit);
    assert!(String::from_utf8(asked.stdout.clone())?.contains("\"permissionDecision\":\"ask\""));
    assert_eq!(audit(&asked).0, "ask");
    // A cached green skips the gate; nativeHooks skips it before the probe.
    let cached = Stub {
        found: &["pnpm"],
        hit: true,
    };
    let e = done(evaluate(
        &payload("git commit -m x", "default"),
        &context(Engine::Codex, "{{x}}"),
        &NoRepo,
        &cached,
    )?)?;
    assert!(String::from_utf8(e.stderr.clone())?.contains("a green fast result is cached"));
    let e = done(evaluate(
        &payload("git commit -m x", "default"),
        &context(Engine::Pi, "1"),
        &NoRepo,
        &cached,
    )?)?;
    assert_eq!(audit(&e), ("skip", "native-hook"));
    Ok(())
}

// Covers: R50
#[test]
fn the_gate_run_is_an_effect_and_its_outcome_reads_like_run_gate() -> TestResult {
    let present = Stub {
        found: &["pnpm"],
        hit: false,
    };
    // Pi gates `git push` too; Claude does not.
    let push = payload("git push origin feature", "default");
    let claude = done(evaluate(
        &push,
        &context(Engine::Claude, "{{x}}"),
        &NoRepo,
        &present,
    )?)?;
    assert_eq!(audit(&claude).0, "skip");
    let Step::Gate(pending, run) =
        evaluate(&push, &context(Engine::Pi, "{{x}}"), &NoRepo, &present)?
    else {
        return Err("Pi must run the gate on a push".into());
    };
    assert_eq!(
        (run.command.as_str(), run.pwd.as_str()),
        ("pnpm run check", "/work")
    );
    assert_eq!(
        String::from_utf8(pending.stderr.clone())?,
        "[navori] running quality-gate fast: pnpm run check\n"
    );
    let green = after_gate(pending.clone(), &run, 0, b"out\n", b"log\n");
    assert_eq!(
        (green.verdict, green.stdout.as_slice()),
        (Verdict::Permit, b"out\n".as_slice())
    );
    assert_eq!(audit(&green), ("allow", "gate ejecutado y verde"));
    let red = after_gate(pending, &run, 1, b"", b"lint fail\n");
    assert_eq!(red.verdict, Verdict::Block);
    let stderr = String::from_utf8(red.stderr.clone())?;
    assert!(stderr.starts_with("[navori] running quality-gate fast: pnpm run check\nlint fail\n[navori] quality-gate fast failed. Commit aborted.\n[navori] The gate ran in this working tree: /work\n"));
    assert_eq!(
        audit(&red),
        (
            "block",
            "quality gate en rojo: 'pnpm run check' fallo, commit abortado"
        )
    );
    // An empty command still runs the gate, saying so first.
    let Step::Gate(pending, _) =
        evaluate(b"{}", &context(Engine::Codex, "{{x}}"), &NoRepo, &present)?
    else {
        return Err("an unreadable command must run the gate".into());
    };
    assert!(String::from_utf8(pending.stderr)?.starts_with("[navori] no command could be read"));
    Ok(())
}

// Covers: R50, R52
#[test]
fn the_destination_gate_outcome_follows_the_first_output_line() -> TestResult {
    let present = Stub {
        found: &["pnpm"],
        hit: false,
    };
    let Step::Gate(pending, _) = evaluate(
        &payload("git commit -m x", "default"),
        &context(Engine::Claude, "{{x}}"),
        &NoRepo,
        &present,
    )?
    else {
        return Err("expected a gate run".into());
    };
    let green = after_foreign(
        pending.clone(),
        "/dest",
        0,
        b"navori gate foreign: exit 0 ok\nlog\n",
    );
    assert_eq!(audit(&green), ("allow", "foreign-gate"));
    let red = after_foreign(
        pending.clone(),
        "/dest",
        3,
        b"navori gate foreign: exit 3 x\n",
    );
    assert_eq!(
        (red.verdict, audit(&red)),
        (Verdict::Block, ("block", "foreign-gate"))
    );
    let none = after_foreign(pending, "/dest", 9, b"boom\n");
    assert_eq!(none.verdict, Verdict::Permit);
    assert!(String::from_utf8(none.stdout)?.contains("gave no verdict (/dest)"));
    Ok(())
}
