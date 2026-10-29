//! Spec 0060 M1 (R70): general-purpose-confirm against the shell's recorded verdicts and a live,
//! audit-disabled shell oracle. Policy parity only: registration and shadow run elsewhere.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use navori_hooks::hooks::general_purpose_confirm::{evaluate, evaluate_with_capture};
use navori_hooks::runner::{Engine, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::{Extractor, Profile};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        let path = std::env::temp_dir().join(format!(
            "navori-gp-confirm-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path)?;
        Ok(Self(path.canonicalize()?))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn code(verdict: Verdict) -> u8 {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Error => 1,
        Verdict::Block => 2,
    }
}

fn host_utf8_locale() -> Locale {
    if cfg!(target_os = "linux") {
        Locale::GnuUtf8
    } else {
        Locale::Utf8
    }
}

fn bash_dialect() -> Result<ShellDialect, Box<dyn Error>> {
    static DIALECT: OnceLock<Result<ShellDialect, String>> = OnceLock::new();
    let result = DIALECT.get_or_init(|| {
        let output = Command::new("/bin/bash")
            .arg("--version")
            .output()
            .map_err(|error| error.to_string())?;
        let version = String::from_utf8_lossy(&output.stdout);
        if output.status.success() && version.starts_with("GNU bash, version 3.") {
            Ok(ShellDialect::Bash3)
        } else if output.status.success() && version.starts_with("GNU bash, version 5.") {
            Ok(ShellDialect::Bash5)
        } else {
            Err(format!("unsupported oracle Bash dialect: {version}"))
        }
    });
    result
        .as_ref()
        .copied()
        .map_err(|error| error.clone().into())
}

/// The real asset with its include partials expanded, without Node/Bun or signatures.
fn shell_source() -> Result<String, Box<dyn Error>> {
    let hooks = repo().join("packages/core/core-assets/hooks");
    let source = fs::read_to_string(hooks.join("general-purpose-confirm.sh"))?;
    let mut expanded = String::new();
    for line in source.lines() {
        if let Some(name) = line.strip_prefix("# navori:include ") {
            expanded.push_str(&fs::read_to_string(
                hooks.join("_partials").join(format!("{name}.sh")),
            )?);
            expanded.push('\n');
        } else {
            expanded.push_str(line);
            expanded.push('\n');
        }
    }
    Ok(expanded)
}

/// Run the expanded asset from the engine's hook directory (the script reads its `$0`) with
/// auditing off, and compare every observable field with the Rust evaluation.
fn compare_shell(bytes: &[u8], engine: Engine, profile: Profile) -> TestResult {
    let temp = Temp::new()?;
    let hooks = temp.0.join(match engine {
        Engine::Codex => ".codex/hooks",
        _ => ".claude/hooks",
    });
    fs::create_dir_all(&hooks)?;
    let script = hooks.join("general-purpose-confirm.sh");
    let source = shell_source()?;
    let input_line = source
        .lines()
        .position(|line| line == "payload=${payload-\"$(cat)\"}")
        .ok_or("initial capture not found in expanded oracle")?
        + 1;
    let fallback_line = source
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("printf -v") && line.contains("$(payload_field"))
        .map(|(index, _)| index + 1)
        .last()
        .ok_or("individual fallback not found in expanded oracle")?;
    fs::write(&script, source)?;
    let mut command = Command::new("/bin/bash");
    command
        .arg(&script)
        .env("NAVORI_AUDITS_ROOT", temp.0.join("audit-off"))
        .env(
            "LC_ALL",
            match profile.locale {
                Locale::Utf8 | Locale::GnuUtf8 => "en_US.UTF-8",
                Locale::C => "C",
            },
        );
    if !matches!(profile.extractor, Extractor::JqAndNode) {
        let bin = temp.0.join("bin");
        fs::create_dir(&bin)?;
        let mut tools = vec!["sed", "grep", "tr", "cat"];
        match profile.extractor {
            Extractor::JqOnly => tools.push("jq"),
            Extractor::Node => tools.push("node"),
            _ => {}
        }
        for tool in tools {
            let located = Command::new("/bin/sh")
                .args(["-c", "command -v \"$1\"", "lookup", tool])
                .output()?;
            let path = String::from_utf8(located.stdout)?.trim().to_owned();
            if path.is_empty() {
                return Err(format!("oracle needs {tool}").into());
            }
            std::os::unix::fs::symlink(path, bin.join(tool))?;
        }
        command.env("PATH", bin);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or("stdin")?.write_all(bytes)?;
    let expected = child.wait_with_output()?;
    let actual = evaluate_with_capture(
        bytes,
        engine,
        profile,
        CaptureContext {
            shell: bash_dialect()?,
            script: &script,
            input_line,
            fallback_line,
        },
    )?;
    let shown = String::from_utf8_lossy(bytes)
        .chars()
        .take(140)
        .collect::<String>();
    assert_eq!(
        i32::from(code(actual.verdict)),
        expected.status.code().ok_or("shell signal")?,
        "{engine:?} {profile:?} {shown}"
    );
    assert_eq!(
        actual.stdout, expected.stdout,
        "{engine:?} {profile:?} {shown}"
    );
    assert_eq!(
        actual.stderr, expected.stderr,
        "{engine:?} {profile:?} {shown}"
    );
    Ok(())
}

// Covers: R70
#[test]
fn reproduces_every_recorded_verdict_and_audit_label() -> TestResult {
    let corpus = fs::read_to_string(repo().join(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/general-purpose-confirm.sh.jsonl",
    ))?;
    let mut seen = 0;
    for (index, line) in corpus.lines().enumerate() {
        let case: Value = serde_json::from_str(line)?;
        let engine = match case["engine"].as_str() {
            Some("claude") => Engine::Claude,
            Some("codex") => Engine::Codex,
            _ => return Err(format!("case {}: unexpected engine", index + 1).into()),
        };
        let actual = evaluate(
            case["input"].as_str().ok_or("input")?.as_bytes(),
            engine,
            Profile::default(),
        )?;
        let off = &case["expected"]["off"];
        assert_eq!(
            u64::from(code(actual.verdict)),
            off["status"].as_u64().ok_or("status")?,
            "case {}",
            index + 1
        );
        assert_eq!(
            actual.stdout,
            off["stdout"].as_str().ok_or("stdout")?.as_bytes(),
            "case {}",
            index + 1
        );
        assert_eq!(
            actual.stderr,
            off["stderr"].as_str().ok_or("stderr")?.as_bytes(),
            "case {}",
            index + 1
        );
        let recorded = case["expected"]["active"]["event"][0]["metadata"]["verdict"].as_str();
        assert_eq!(
            actual.audit.as_ref().map(|label| label.verdict),
            recorded,
            "case {}",
            index + 1
        );
        seen += 1;
    }
    assert!(seen >= 14, "corpus shrank to {seen} cases");
    Ok(())
}

// Covers: R70
#[test]
fn matches_the_live_shell_in_both_engines_under_every_extraction_profile() -> TestResult {
    let payloads = [
        json!({"tool_name":"Agent","tool_input":{"subagent_type":"general-purpose"}}).to_string(),
        json!({"tool_name":"spawn_agent","tool_input":{"agent_type":"general-purpose"}})
            .to_string(),
        json!({"tool_name":"Agent","tool_input":{"subagent_type":"scout","prompt":"general-purpose"}})
            .to_string(),
        json!({"tool_name":"Agent","tool_input":{"subagent_type":"","agent_type":"general-purpose"}})
            .to_string(),
        json!({"tool_name":"Agent","tool_input":{"subagent_type":"general-purpose-lite"}})
            .to_string(),
        json!({"tool_name":"Agent","tool_input":{"subagent_type":["general-purpose"]}}).to_string(),
        json!({"tool_name":"Agent","tool_input":{"subagent_type":"implementer"}}).to_string(),
        "{\"tool_input\":{\"subagent_type\":\"general-purpose\"".to_owned(),
        "general-purpose".to_owned(),
        String::new(),
    ];
    let profiles = [
        Extractor::JqAndNode,
        Extractor::JqOnly,
        Extractor::Node,
        Extractor::Sed,
    ]
    .map(|extractor| Profile {
        extractor,
        locale: host_utf8_locale(),
    });
    for engine in [Engine::Claude, Engine::Codex] {
        for profile in profiles {
            for payload in &payloads {
                compare_shell(payload.as_bytes(), engine, profile)?;
            }
        }
    }
    Ok(())
}

// Covers: R70
#[test]
fn nul_bytes_carry_the_same_capture_diagnostics_as_bash() -> TestResult {
    let profile = Profile {
        extractor: Extractor::JqAndNode,
        locale: host_utf8_locale(),
    };
    for payload in [
        b"{\"tool_input\":{\"subagent_type\":\"general-purpose\"}}\0".as_slice(),
        b"{\"tool_input\":{\"subagent_type\":\"gene\0ral-purpose\"}}".as_slice(),
        b"\0{\"tool_input\":{\"subagent_type\":\"scout\"}}".as_slice(),
    ] {
        for engine in [Engine::Claude, Engine::Codex] {
            compare_shell(payload, engine, profile)?;
        }
    }
    Ok(())
}
