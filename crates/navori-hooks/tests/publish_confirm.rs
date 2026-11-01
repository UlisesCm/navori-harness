//! Spec 0060 T14 (R70, R72): comment-draft-confirm and pr-publisher-confirm against the shell's
//! recorded verdicts. Policy parity only: registration and shadow run elsewhere; the end-to-end
//! replay of every corpus case through the binary is `hook-verdict-replay --impl rust`.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use navori_hooks::hooks::{comment_draft_confirm, pr_publisher_confirm};
use navori_hooks::runner::{Engine, Evaluation, Failure, Verdict};
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::draft_body::DraftHost;
use navori_hooks::shell::payload::Profile;
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The real asset with its include partials expanded.
fn expanded(name: &str) -> Result<String, Box<dyn Error>> {
    let hooks = repo().join("packages/core/core-assets/hooks");
    let mut out = String::new();
    for line in fs::read_to_string(hooks.join(name))?.lines() {
        // An include may sit indented inside a `case` arm (the Pi arm of pr-publisher-confirm).
        if let Some(partial) = line.trim_start().strip_prefix("# navori:include ") {
            out.push_str(&fs::read_to_string(
                hooks.join("_partials").join(format!("{partial}.sh")),
            )?);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    Ok(out)
}

/// This machine's files and tools, from the process directory.
struct ToolHost;

impl ToolHost {
    fn run(program: &str, args: &[&str], input: &[u8]) -> Option<(i32, Vec<u8>)> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        let _ = stdin.write_all(input);
        drop(stdin);
        let out = child.wait_with_output().ok()?;
        Some((out.status.code().unwrap_or(128), out.stdout))
    }
}

impl DraftHost for ToolHost {
    fn read_head(&self, path: &str) -> Option<Vec<u8>> {
        if !Path::new(path).is_file() {
            return None;
        }
        let mut bytes = fs::read(path).ok()?;
        bytes.truncate(200_000);
        Some(bytes)
    }

    fn output(&self, program: &str, args: &[&str]) -> Result<Vec<u8>, Failure> {
        Ok(Self::run(program, args, &[])
            .map(|(_, out)| out)
            .unwrap_or_default())
    }
}

impl pr_publisher_confirm::Host for ToolHost {
    fn on_path(&self, name: &str) -> bool {
        Command::new("/bin/sh")
            .args(["-c", "command -v \"$1\" >/dev/null", "probe", name])
            .status()
            .is_ok_and(|status| status.success())
    }

    fn request_approval(&self, program: &str, payload: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
        Ok(match Self::run("node", &["-e", program], payload) {
            Some((0, out)) => Some(out),
            _ => None,
        })
    }
}

fn code(verdict: Verdict) -> u64 {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Error => 1,
        Verdict::Block => 2,
    }
}

fn engine(case: &Value) -> Engine {
    match case["engine"].as_str() {
        Some("codex") => Engine::Codex,
        Some("pi") => Engine::Pi,
        _ => Engine::Claude,
    }
}

/// Compare one evaluation with the case's recorded `off` verdict and audit label.
fn check(case: &Value, actual: &Evaluation, label: &str) {
    let off = &case["expected"]["off"];
    assert_eq!(
        Some(code(actual.verdict)),
        off["status"].as_u64(),
        "{label}"
    );
    assert_eq!(
        String::from_utf8_lossy(&actual.stdout),
        off["stdout"].as_str().unwrap_or_default(),
        "{label}"
    );
    assert_eq!(
        String::from_utf8_lossy(&actual.stderr),
        off["stderr"].as_str().unwrap_or_default(),
        "{label}"
    );
    let recorded = case["expected"]["active"]["event"][0]["metadata"]["verdict"].as_str();
    assert_eq!(
        actual.audit.as_ref().map(|a| a.verdict),
        recorded,
        "{label}"
    );
}

/// Corpus cases that run with this machine's own tools: no narrowed PATH and no fixture (those
/// replace a tool and run end to end in the native replay).
fn cases(hook: &str) -> Result<Vec<Value>, Box<dyn Error>> {
    let text = fs::read_to_string(repo().join(format!(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/{hook}.sh.jsonl"
    )))?;
    let mut out = Vec::new();
    for line in text.lines() {
        let case: Value = serde_json::from_str(line)?;
        if case["envDelta"].get("PATH").is_none() && case.get("fixture").is_none() {
            out.push(case);
        }
    }
    Ok(out)
}

// Covers: R70, R72
#[test]
fn comment_draft_confirm_reproduces_the_recorded_verdicts() -> TestResult {
    let script = repo().join("packages/core/core-assets/hooks/comment-draft-confirm.sh");
    let source = expanded("comment-draft-confirm.sh")?;
    let rendered = comment_draft_confirm::Rendered::from_script(&source)?;
    let cases = cases("comment-draft-confirm")?;
    for (index, case) in cases.iter().enumerate() {
        let context = comment_draft_confirm::Context {
            engine: engine(case),
            profile: Profile::default(),
            capture: CaptureContext {
                shell: ShellDialect::Bash5,
                script: &script,
                input_line: 0,
                fallback_line: 0,
            },
            rendered: rendered.clone(),
        };
        let input = case["input"].as_str().ok_or("input")?;
        let actual = comment_draft_confirm::evaluate(input.as_bytes(), &context, &ToolHost)?;
        check(case, &actual, &format!("case {}", index + 1));
    }
    assert!(cases.len() >= 80, "corpus shrank to {}", cases.len());
    Ok(())
}

// Covers: R70, R72
#[test]
fn pr_publisher_confirm_reproduces_the_recorded_verdicts() -> TestResult {
    let script = repo().join("packages/core/core-assets/hooks/pr-publisher-confirm.sh");
    let source = expanded("pr-publisher-confirm.sh")?;
    let rendered = pr_publisher_confirm::Rendered::from_script(&source)?;
    let cases = cases("pr-publisher-confirm")?;
    for (index, case) in cases.iter().enumerate() {
        let context = pr_publisher_confirm::Context {
            engine: engine(case),
            profile: Profile::default(),
            capture: CaptureContext {
                shell: ShellDialect::Bash5,
                script: &script,
                input_line: 0,
                fallback_line: 0,
            },
            rendered: rendered.clone(),
        };
        let input = case["input"].as_str().ok_or("input")?;
        let actual = pr_publisher_confirm::evaluate(input.as_bytes(), &context, &ToolHost)?;
        check(case, &actual, &format!("case {}", index + 1));
    }
    assert!(cases.len() >= 30, "corpus shrank to {}", cases.len());
    Ok(())
}
