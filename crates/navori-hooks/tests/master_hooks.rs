//! Spec 0060 T9 (R70): the master-plan hooks against the shell's recorded verdicts and a live,
//! audit-disabled shell oracle. Policy parity only: registration and shadow run elsewhere.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use navori_hooks::hooks::master_accept_confirm::{evaluate, evaluate_with_capture};
use navori_hooks::hooks::master_plan_context::{self as plan_context, Rendered};
use navori_hooks::runner::{Engine, Failure, Verdict};
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
            "navori-master-hooks-{}-{}",
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
fn shell_source(name: &str) -> Result<String, Box<dyn Error>> {
    let hooks = repo().join("packages/core/core-assets/hooks");
    let source = fs::read_to_string(hooks.join(name))?;
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

fn engine_dir(engine: Engine) -> &'static str {
    match engine {
        Engine::Codex => ".codex/hooks",
        Engine::Pi => ".pi/navori/hooks",
        _ => ".claude/hooks",
    }
}

/// A `PATH` holding only `tools` (and what the extractor needs), linked from the host.
fn tool_path(dir: &Path, tools: &[&str]) -> Result<PathBuf, Box<dyn Error>> {
    let bin = dir.join("bin");
    fs::create_dir(&bin)?;
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
    Ok(bin)
}

/// Run the expanded master-accept-confirm from the engine's hook directory (the script reads its
/// `$0`) with auditing off, and compare every observable field with the Rust evaluation.
fn compare_accept(bytes: &[u8], engine: Engine, profile: Profile) -> TestResult {
    let temp = Temp::new()?;
    let hooks = temp.0.join(engine_dir(engine));
    fs::create_dir_all(&hooks)?;
    let script = hooks.join("master-accept-confirm.sh");
    let source = shell_source("master-accept-confirm.sh")?;
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
        let mut tools = vec!["sed", "grep", "tr", "cat"];
        match profile.extractor {
            Extractor::JqOnly => tools.push("jq"),
            Extractor::Node => tools.push("node"),
            _ => {}
        }
        command.env("PATH", tool_path(&temp.0, &tools)?);
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
        .take(160)
        .collect::<String>();
    assert_eq!(
        i32::from(code(actual.verdict)),
        expected.status.code().ok_or("shell signal")?,
        "{engine:?} {profile:?} {shown}"
    );
    assert_eq!(
        String::from_utf8_lossy(&actual.stdout),
        String::from_utf8_lossy(&expected.stdout),
        "{engine:?} {profile:?} {shown}"
    );
    assert_eq!(
        String::from_utf8_lossy(&actual.stderr),
        String::from_utf8_lossy(&expected.stderr),
        "{engine:?} {profile:?} {shown}"
    );
    Ok(())
}

fn corpus(name: &str) -> Result<Vec<Value>, Box<dyn Error>> {
    let text = fs::read_to_string(repo().join(format!(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/{name}.jsonl"
    )))?;
    text.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn engine_of(case: &Value) -> Result<Engine, Box<dyn Error>> {
    match case["engine"].as_str() {
        Some("claude") => Ok(Engine::Claude),
        Some("codex") => Ok(Engine::Codex),
        Some("pi") => Ok(Engine::Pi),
        other => Err(format!("unexpected engine {other:?}").into()),
    }
}

// Covers: R70
#[test]
fn master_accept_confirm_reproduces_every_recorded_verdict_and_audit_label() -> TestResult {
    let mut seen = 0;
    for (index, case) in corpus("master-accept-confirm.sh")?.iter().enumerate() {
        // A narrowed PATH picks the extractor from whatever the host has there: the live
        // comparison below covers every extractor instead.
        if case["envDelta"].get("PATH").is_some() {
            continue;
        }
        let actual = evaluate(
            case["input"].as_str().ok_or("input")?.as_bytes(),
            engine_of(case)?,
            Profile::default(),
        )?;
        let off = &case["expected"]["off"];
        let label = format!("case {}", index + 1);
        assert_eq!(
            u64::from(code(actual.verdict)),
            off["status"].as_u64().ok_or("status")?,
            "{label}"
        );
        assert_eq!(
            String::from_utf8_lossy(&actual.stdout),
            off["stdout"].as_str().ok_or("stdout")?,
            "{label}"
        );
        assert_eq!(
            String::from_utf8_lossy(&actual.stderr),
            off["stderr"].as_str().ok_or("stderr")?,
            "{label}"
        );
        let recorded = case["expected"]["active"]["event"][0]["metadata"]["verdict"].as_str();
        assert_eq!(
            actual.audit.as_ref().map(|label| label.verdict),
            recorded,
            "{label}"
        );
        seen += 1;
    }
    assert!(seen >= 280, "corpus shrank to {seen} cases");
    Ok(())
}

fn bash_payload(command: &str) -> String {
    json!({"tool_name":"Bash","tool_input":{"command":command}}).to_string()
}

// Covers: R70
#[test]
fn master_accept_confirm_matches_the_live_shell_in_every_engine_and_profile() -> TestResult {
    let commands = [
        "navori master part P1 --status done --approved-by ana",
        "navori master part P1 --approved-by=ana",
        "npx -y navori@1.2.3 master close",
        "bunx navori master close --abandon",
        "pnpm exec ./node_modules/.bin/navori master close;",
        "cd x && navori master close",
        "echo \"navori master close\"",
        "sh -c 'navori master close'",
        "x=$(navori master close)",
        "navori master closer",
        "navori master delivery-review D1",
        "navori master delivery-decision D1 --accept",
        "navori master delivery-publication D1 --ref v1",
        "navori master delivery-revoke D1",
        "navori master delivery-slice S1 --refresh",
        "navori master delivery-criterion C1 --approved-by ana",
        "navori master delivery-baseline --approved-by ana",
        "navori master delivery-queue --approved-by ana",
        "navori plan escalation-reset f --approved-by ana",
        "navori master part P1 --status done",
        "navori master status",
        "cat <<EOF\nnavori master close\nEOF",
        "git commit -m 'navori master close'",
        "NAVORI=1 navori\\\n master close",
        "echo navori master",
        "",
    ];
    let mut payloads: Vec<String> = commands.iter().map(|c| bash_payload(c)).collect();
    payloads.push(
        json!({"tool_name":"Bash","tool_input":{"command":["navori master close"]}}).to_string(),
    );
    payloads.push("{\"tool_input\":{\"command\":\"navori master close\"".to_owned());
    payloads.push("navori master close".to_owned());
    payloads.push(String::new());
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
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        for profile in profiles {
            for payload in &payloads {
                compare_accept(payload.as_bytes(), engine, profile)?;
            }
        }
    }
    let c = Profile {
        extractor: Extractor::JqAndNode,
        locale: Locale::C,
    };
    for payload in [
        bash_payload("navori\u{a0}master close"),
        bash_payload("navori master close\u{2003}x"),
    ] {
        compare_accept(payload.as_bytes(), Engine::Claude, c)?;
        compare_accept(
            payload.as_bytes(),
            Engine::Claude,
            Profile {
                extractor: Extractor::JqAndNode,
                locale: host_utf8_locale(),
            },
        )?;
    }
    Ok(())
}

/// A case's cwd with its declared fixture: `bin/navori` answers `master status --line`.
struct CaseHost {
    cwd: PathBuf,
}

impl plan_context::Host for CaseHost {
    fn toplevel(&self) -> Result<Option<Vec<u8>>, Failure> {
        // Every corpus cwd is a fresh, non-git directory.
        Ok(None)
    }

    fn on_path(&self, name: &str) -> bool {
        // The corpus PATH is the case's `bin/` and the system dirs, which hold no `navori`.
        self.cwd.join("bin").join(name).is_file()
    }

    fn status_line(&self, project_dir: &str) -> Result<(i32, Vec<u8>), Failure> {
        let out = Command::new(self.cwd.join("bin/navori"))
            .args(["master", "status", "--line"])
            .current_dir(project_dir)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| Failure(e.to_string()))?;
        Ok((out.status.code().unwrap_or(128), out.stdout))
    }

    fn first_line(&self, path: &str) -> Result<Option<Vec<u8>>, Failure> {
        Ok(fs::read(path).ok().map(|bytes| {
            let end = bytes
                .iter()
                .position(|b| *b == b'\n')
                .unwrap_or(bytes.len());
            bytes[..end].to_vec()
        }))
    }
}

// Covers: R70, R72
#[test]
fn master_plan_context_reproduces_every_recorded_verdict_and_audit_label() -> TestResult {
    let rendered = Rendered::from_script(&shell_source("master-plan-context.sh")?)?;
    let mut seen = 0;
    for (index, case) in corpus("master-plan-context.sh")?.iter().enumerate() {
        let temp = Temp::new()?;
        for file in case["fixture"].as_array().map_or(&[][..], Vec::as_slice) {
            let path = temp.0.join(file["path"].as_str().ok_or("fixture path")?);
            fs::create_dir_all(path.parent().ok_or("fixture parent")?)?;
            fs::write(&path, file["content"].as_str().ok_or("fixture content")?)?;
            if let Some(mode) = file["mode"].as_u64() {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(u32::try_from(mode)?))?;
            }
        }
        let cwd = temp.0.to_str().ok_or("cwd")?.to_owned();
        let context = plan_context::Context {
            engine: engine_of(case)?,
            rendered: rendered.clone(),
            pwd: cwd.clone(),
            project_dir: case["envDelta"]["CLAUDE_PROJECT_DIR"]
                .as_str()
                .map(|dir| dir.replace("@CWD@", &cwd)),
        };
        let host = CaseHost {
            cwd: temp.0.clone(),
        };
        let actual = plan_context::evaluate(
            case["input"].as_str().ok_or("input")?.as_bytes(),
            &context,
            &host,
        )?;
        let off = &case["expected"]["off"];
        let label = format!("case {}", index + 1);
        assert_eq!(
            u64::from(code(actual.verdict)),
            off["status"].as_u64().ok_or("status")?,
            "{label}"
        );
        assert_eq!(
            String::from_utf8_lossy(&actual.stdout),
            off["stdout"].as_str().ok_or("stdout")?,
            "{label}"
        );
        assert_eq!(
            String::from_utf8_lossy(&actual.stderr),
            off["stderr"].as_str().ok_or("stderr")?,
            "{label}"
        );
        let recorded = case["expected"]["active"]["event"][0]["metadata"]["verdict"].as_str();
        assert_eq!(
            actual.audit.as_ref().map(|label| label.verdict),
            recorded,
            "{label}"
        );
        seen += 1;
    }
    assert!(seen >= 19, "corpus shrank to {seen} cases");
    Ok(())
}

// Covers: R70
#[test]
fn master_accept_confirm_nul_bytes_carry_the_same_capture_diagnostics_as_bash() -> TestResult {
    let profile = Profile {
        extractor: Extractor::JqAndNode,
        locale: host_utf8_locale(),
    };
    for payload in [
        b"{\"tool_input\":{\"command\":\"navori master close\"}}\0".as_slice(),
        b"{\"tool_input\":{\"command\":\"navori mas\0ter close\"}}".as_slice(),
        b"\0{\"tool_input\":{\"command\":\"ls\"}}".as_slice(),
    ] {
        for engine in [Engine::Claude, Engine::Codex] {
            compare_accept(payload, engine, profile)?;
        }
    }
    Ok(())
}
