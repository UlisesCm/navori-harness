//! Spec 0060 T13 (R70): engram-write-guard and role-guard against the shell's recorded verdicts,
//! plus role-guard's path branches over a scripted host. Policy parity only: registration and
//! shadow run elsewhere; the end-to-end replay of every corpus case through the binary is
//! `hook-verdict-replay --impl rust`.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use navori_hooks::hooks::{engram_write_guard, role_guard};
use navori_hooks::runner::{Evaluation, Failure, Verdict};
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::Profile;
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The asset as the corpus records it: partials expanded and the policy rendered.
fn corpus_asset(name: &str) -> Result<String, Box<dyn Error>> {
    let output = std::process::Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            "const { corpusAsset } = await import(process.argv[1]); process.stdout.write(corpusAsset(process.argv[2], process.argv[3]));",
        ])
        .arg(repo().join("scripts/js/corpus-asset.mjs"))
        .arg(repo().join("packages/core/core-assets/hooks"))
        .arg(name)
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn corpus(name: &str) -> Result<Vec<Value>, Box<dyn Error>> {
    fs::read_to_string(repo().join(format!(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/{name}.jsonl"
    )))?
    .lines()
    .map(|line| serde_json::from_str(line).map_err(Into::into))
    .collect()
}

fn code(verdict: Verdict) -> u64 {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Error => 1,
        Verdict::Block => 2,
    }
}

fn capture(script: &Path) -> CaptureContext<'_> {
    CaptureContext {
        shell: ShellDialect::Bash5,
        script,
        input_line: 0,
        fallback_line: 0,
    }
}

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

// Covers: R70
#[test]
fn engram_write_guard_reproduces_every_recorded_verdict() -> TestResult {
    let script = repo().join("packages/core/core-assets/hooks/engram-write-guard.sh");
    let context = engram_write_guard::Context {
        profile: Profile::default(),
        capture: capture(&script),
        rendered: engram_write_guard::Rendered::from_script(&corpus_asset(
            "engram-write-guard.sh",
        )?)?,
    };
    let mut seen = 0;
    for (index, case) in corpus("engram-write-guard.sh")?.iter().enumerate() {
        if case["envDelta"].get("PATH").is_some() {
            continue;
        }
        let input = case["input"].as_str().ok_or("input")?;
        let actual = engram_write_guard::evaluate(input.as_bytes(), &context)?;
        check(case, &actual, &format!("case {}", index + 1));
        seen += 1;
    }
    assert!(seen >= 140, "corpus shrank to {seen} cases");
    Ok(())
}

/// A scripted file system: physical directories, symlinks and the reviewer binding answer.
#[derive(Default)]
struct FakeHost {
    dirs: BTreeSet<String>,
    links: BTreeMap<String, String>,
    bound: Option<(bool, String)>,
}

impl role_guard::Host for FakeHost {
    fn exists(&self, path: &str) -> bool {
        self.dirs.contains(path)
    }
    fn is_symlink(&self, path: &str) -> bool {
        self.links.contains_key(path)
    }
    fn is_dir(&self, path: &str) -> bool {
        self.dirs.contains(path)
    }
    fn physical(&self, dir: &str) -> Option<String> {
        self.dirs.contains(dir).then(|| dir.to_owned())
    }
    fn readlink(&self, path: &str) -> Option<String> {
        self.links.get(path).cloned()
    }
    fn git(&self, args: &[&str]) -> Result<Option<String>, Failure> {
        // The repo root is /repo; no nested worktree.
        Ok(match args {
            ["-C", _, "rev-parse", "--show-toplevel"] => Some("/repo".to_owned()),
            _ => None,
        })
    }
    fn tmpdir(&self) -> Option<String> {
        None
    }
    fn bind(&self, _: &str, _: &[&str]) -> Result<Option<(bool, String)>, Failure> {
        Ok(self.bound.clone())
    }
}

fn patch(role: &str, path: &str) -> String {
    json!({
        "agent_type": role,
        "agent_id": "a-1",
        "cwd": "/repo",
        "tool_name": "apply_patch",
        "tool_input": {"command": format!("*** Begin Patch\n*** Add File: {path}\n+x\n*** End Patch")},
    })
    .to_string()
}

// Covers: R70
#[test]
fn role_guard_reproduces_the_recorded_skips_and_spawn_blocks() -> TestResult {
    let script = repo().join("packages/core/core-assets/hooks/role-guard.sh");
    let context = role_guard::Context {
        profile: Profile::default(),
        capture: capture(&script),
        rendered: role_guard::Rendered::from_script(&corpus_asset("role-guard.sh")?)?,
    };
    let host = FakeHost::default();
    let mut seen = 0;
    for (index, case) in corpus("role-guard.sh")?.iter().enumerate() {
        let input = case["input"].as_str().ok_or("input")?;
        let parsed: Value = serde_json::from_str(input).unwrap_or(Value::Null);
        // Path verdicts depend on the case's own directory tree: the native replay covers them.
        if case["envDelta"].get("PATH").is_some() || parsed["tool_name"] == "apply_patch" {
            continue;
        }
        let actual = role_guard::evaluate(input.as_bytes(), &context, &host)?;
        check(case, &actual, &format!("case {}", index + 1));
        seen += 1;
    }
    assert!(seen >= 14, "corpus shrank to {seen} cases");
    Ok(())
}

// Covers: R70
#[test]
fn role_guard_judges_each_path_by_where_it_lands() -> TestResult {
    let script = repo().join("packages/core/core-assets/hooks/role-guard.sh");
    let context = role_guard::Context {
        profile: Profile::default(),
        capture: capture(&script),
        rendered: role_guard::Rendered::from_script(&corpus_asset("role-guard.sh")?)?,
    };
    let dirs = [
        "/",
        "/repo",
        "/repo/specs",
        "/repo/src",
        "/tmp",
        "/elsewhere",
    ];
    let mut host = FakeHost {
        dirs: dirs.iter().map(|d| (*d).to_owned()).collect(),
        ..FakeHost::default()
    };
    host.links
        .insert("/repo/specs/out".to_owned(), "/elsewhere/x".to_owned());
    let run = |host: &FakeHost, role: &str, path: &str| -> Result<Evaluation, Failure> {
        role_guard::evaluate(patch(role, path).as_bytes(), &context, host)
    };
    // Granted prefix, compared by component.
    assert_eq!(run(&host, "scout", "specs/a.md")?.verdict, Verdict::Permit);
    let evil = run(&host, "scout", "specs-evil/a.md")?;
    assert_eq!(evil.verdict, Verdict::Block);
    assert!(String::from_utf8_lossy(&evil.stderr).contains("scout no escribe 'specs-evil/a.md'"));
    // `..` cannot climb out, a symlink is judged by where it lands, temp passes.
    assert_eq!(
        run(&host, "scout", "specs/../src/a.ts")?.verdict,
        Verdict::Block
    );
    let link = run(&host, "scout", "specs/out")?;
    assert!(String::from_utf8_lossy(&link.stderr).contains("fuera del repo"));
    assert_eq!(
        run(&host, "scout", "/tmp/scratch.txt")?.verdict,
        Verdict::Permit
    );
    // The reviewer's outside write needs its binding.
    let denied = run(&host, "reviewer", "/elsewhere/review_x.md")?;
    assert!(String::from_utf8_lossy(&denied.stderr).contains("(node-unavailable)"));
    host.bound = Some((false, "invalid-index".to_owned()));
    let invalid = run(&host, "reviewer", "/elsewhere/review_x.md")?;
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("(invalid-index)"));
    host.bound = Some((true, "bound-review-output".to_owned()));
    let bound = run(&host, "reviewer", "/elsewhere/review_x.md")?;
    assert_eq!(bound.verdict, Verdict::Permit);
    assert_eq!(bound.stderr, b"[navori] role-guard: bound-review-output\n");
    Ok(())
}
