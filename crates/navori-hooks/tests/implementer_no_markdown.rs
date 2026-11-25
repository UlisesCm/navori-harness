//! Spec 0060 T12 (R70): implementer-no-markdown against the shell's recorded verdicts. Policy
//! parity only: registration and shadow run elsewhere; the end-to-end replay of every corpus
//! case through the binary is `hook-verdict-replay --impl rust`.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use navori_hooks::hooks::implementer_no_markdown::{Analyzer, Context, Host, Rendered, evaluate};
use navori_hooks::runner::{Engine, Failure, Verdict};
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::Profile;
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

struct Temp(PathBuf);

impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "navori-inm-{}-{}",
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

/// The real tools of this machine, run from the case's cwd as the script runs them.
struct ToolHost {
    cwd: PathBuf,
}

impl ToolHost {
    fn run(&self, program: &str, args: &[&str], input: &[u8]) -> Option<(i32, Vec<u8>)> {
        let mut child = Command::new(program)
            .args(args)
            .current_dir(&self.cwd)
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

fn substitution(mut bytes: Vec<u8>) -> String {
    while bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

impl Host for ToolHost {
    fn on_path(&self, name: &str) -> bool {
        Command::new("/bin/sh")
            .args(["-c", "command -v \"$1\" >/dev/null", "probe", name])
            .status()
            .is_ok_and(|status| status.success())
    }

    fn git(&self, args: &[&str]) -> Result<Option<String>, Failure> {
        Ok(match self.run("git", args, &[]) {
            Some((0, out)) => Some(substitution(out)),
            _ => None,
        })
    }

    fn is_symlink(&self, path: &str) -> bool {
        fs::symlink_metadata(self.cwd.join(path)).is_ok_and(|m| m.file_type().is_symlink())
    }

    fn is_dir(&self, path: &str) -> bool {
        self.cwd.join(path).is_dir()
    }

    fn analyze(
        &self,
        analyzer: Analyzer,
        program: &str,
        input: &[u8],
    ) -> Result<Option<String>, Failure> {
        let run = match analyzer {
            Analyzer::Python => self.run("python3", &["-I", "-S", "-c", program], input),
            _ => self.run("node", &["-e", program], input),
        };
        Ok(match run {
            Some((0, out)) => Some(substitution(out)),
            _ => None,
        })
    }
}

/// `text` with the single-quoted path of the block line removed.
fn unquoted(text: &str) -> String {
    match (text.find(" sobre '"), text.find("'\n")) {
        (Some(start), Some(end)) if start < end => format!("{}{}", &text[..start], &text[end..]),
        _ => text.to_owned(),
    }
}

fn code(verdict: Verdict) -> u64 {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Error => 1,
        Verdict::Block => 2,
    }
}

// Covers: R70
#[test]
fn reproduces_every_recorded_verdict_and_audit_label() -> TestResult {
    let script = repo().join("packages/core/core-assets/hooks/implementer-no-markdown.sh");
    let rendered = Rendered::from_script(&fs::read_to_string(&script)?)?;
    let corpus = fs::read_to_string(repo().join(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/implementer-no-markdown.sh.jsonl",
    ))?;
    let mut seen = 0;
    for (index, line) in corpus.lines().enumerate() {
        let case: Value = serde_json::from_str(line)?;
        // Only the recorded machine PATH (or none) means "the host's own tools"; the cases that
        // shadow a tool with a fixture directory run end to end in the native replay.
        let path = case["envDelta"]["PATH"].as_str().unwrap_or("");
        if path.starts_with("@CWD@") || case.get("fixture").is_some() {
            continue;
        }
        let engine = match case["engine"].as_str() {
            Some("codex") => Engine::Codex,
            Some("pi") => Engine::Pi,
            _ => Engine::Claude,
        };
        let temp = Temp::new()?;
        let token = |text: &str| text.replace("@CWD@", temp.0.to_str().unwrap_or_default());
        let input = token(case["input"].as_str().ok_or("input")?);
        let context = Context {
            engine,
            profile: Profile::default(),
            capture: CaptureContext {
                shell: ShellDialect::Bash5,
                script: &script,
                input_line: 0,
                fallback_line: 0,
            },
            rendered: rendered.clone(),
            claude_project_dir: case["envDelta"]["CLAUDE_PROJECT_DIR"]
                .as_str()
                .map(token)
                .filter(|dir| !dir.is_empty()),
        };
        let host = ToolHost {
            cwd: temp.0.clone(),
        };
        let actual = evaluate(input.as_bytes(), &context, &host)?;
        let off = &case["expected"]["off"];
        let label = format!("case {}", index + 1);
        assert_eq!(
            code(actual.verdict),
            off["status"].as_u64().ok_or("status")?,
            "{label}"
        );
        // The replay writes temp paths as its own tokens: the quoted path is compared apart.
        assert_eq!(
            unquoted(&String::from_utf8_lossy(&actual.stderr)),
            unquoted(off["stderr"].as_str().ok_or("stderr")?),
            "{label}"
        );
        assert!(actual.stdout.is_empty(), "{label}");
        let recorded = case["expected"]["active"]["event"][0]["metadata"]["verdict"].as_str();
        assert_eq!(
            actual.audit.as_ref().map(|a| a.verdict),
            recorded,
            "{label}"
        );
        seen += 1;
    }
    assert!(seen >= 650, "corpus shrank to {seen} cases");
    Ok(())
}
