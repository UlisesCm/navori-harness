//! Spec 0057 T28 (R11): the ported guard-destructive rules against the shell's recorded verdicts.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::Path;

use navori_hooks::hooks::guard_destructive::{Host, Outcome, Rendered, block_stderr, evaluate};
use navori_hooks::runner::Engine;
use navori_hooks::shell::Locale;
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

/// Audit reasons the ported rules own. A shell block with one of them must be a Rust block.
const PORTED: &[&str] = &[
    "no-verify",
    "force-push-base",
    "rm-root",
    "rm-var",
    "no-preserve-root",
    "fork-bomb",
    "block-device",
    "managed-rewrite",
];

/// The replay's scratch layout (`createScratch`/`runMode`), deep enough that no root or home
/// rule can see it. A case runs in its project copy (`repo`) or in an empty dir (`none`).
const SCRATCH: &str = "/scratch/replay";
const CASE: &str = "/scratch/replay/cases/0";
const PROJECT: &str = "/scratch/replay/cases/0/project";
const NONE: &str = "/scratch/replay/cases/0/none";
const TMP: &str = "/scratch/replay/tmp";
const HOME: &str = "/scratch/replay/home";

fn workspace() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn corpus() -> Result<Vec<Value>, Box<dyn Error>> {
    let path = workspace()
        .join("packages/cli/src/__tests__/fixtures/hook-verdict-corpus/guard-destructive.sh.jsonl");
    fs::read_to_string(path)?
        .lines()
        .map(|line| Ok(serde_json::from_str(line)?))
        .collect()
}

/// `jq -r '.tool_input.command // empty'` inside `$(…)`: a string, trailing newlines dropped.
fn command(input: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(input).ok()?;
    let command = match payload.pointer("/tool_input/command") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) if !text.contains('\0') => text.clone(),
        Some(_) => return None,
    };
    Some(command.trim_end_matches('\n').to_owned())
}

fn engine(name: &str) -> Option<Engine> {
    match name {
        "claude" => Some(Engine::Claude),
        "codex" => Some(Engine::Codex),
        "pi" => Some(Engine::Pi),
        _ => None,
    }
}

/// `hostPaths`: the replay's tokens expanded for one case.
fn expand(text: &str, cwd: &str) -> String {
    text.replace("@CWD@", cwd)
        .replace("@REPO@", PROJECT)
        .replace("@TMP@", TMP)
        .replace("@R@", "XXXXXX")
}

/// `runMode`'s output normalization, in its order.
fn corpus_text(text: &str) -> String {
    text.replace(PROJECT, "@REPO@")
        .replace(CASE, "@CASE@")
        .replace(TMP, "@TMP@")
        .replace(HOME, "@HOME@")
        .replace(SCRATCH, "@SCRATCH@")
}

/// What hook-input.sh and copy-dest.sh read from the case's environment.
fn host(case: &Value, engine: Engine, cwd: &str) -> Result<Host, Box<dyn Error>> {
    let payload: Value = serde_json::from_str(case["input"].as_str().ok_or("input")?)?;
    let field = payload["cwd"]
        .as_str()
        .map(|v| expand(v, cwd))
        .unwrap_or_default();
    let project_dir = if engine == Engine::Claude {
        case["envDelta"]["CLAUDE_PROJECT_DIR"]
            .as_str()
            .map(|v| expand(v, cwd))
            .unwrap_or_default()
    } else {
        // Codex and Pi cases run outside any git repository: no toplevel, so the payload's
        // cwd, else `.`.
        assert_eq!(
            case["cwdKind"], "none",
            "model covers non-git Codex/Pi cases"
        );
        if field.is_empty() {
            ".".to_owned()
        } else {
            field.clone()
        }
    };
    Ok(Host {
        project_dir,
        cwd: field,
        pwd: cwd.to_owned(),
    })
}

// Covers: R11, R12
#[test]
fn cada_regla_bloquea_pregunta_o_permite_igual_que_el_shell() -> TestResult {
    // The corpus replays the asset with includes expanded but templates unrendered, so these
    // assignments hold their placeholders, exactly as the shell read them.
    let source = fs::read_to_string(
        workspace().join("packages/core/core-assets/hooks/guard-destructive.sh"),
    )?;
    let rendered = Rendered::from_script(&source).ok_or("rendered assignments")?;
    assert_eq!(rendered.base, "{{shq:branchBase}}");
    let mut decided: BTreeMap<String, usize> = BTreeMap::new();
    let mut mismatches = Vec::new();
    let cases = corpus()?;
    for (index, case) in cases.iter().enumerate() {
        let input = case["input"].as_str().ok_or("input")?;
        let cwd = if case["cwdKind"] == "repo" {
            PROJECT
        } else {
            NONE
        };
        let cmd = expand(&command(input).ok_or("command")?, cwd);
        let engine = engine(case["engine"].as_str().ok_or("engine")?).ok_or("engine name")?;
        let host = host(case, engine, cwd)?;
        let off = &case["expected"]["off"];
        let status = off["status"].as_i64().ok_or("status")?;
        let stderr = off["stderr"].as_str().ok_or("stderr")?;
        let event = &case["expected"]["active"]["event"][0]["metadata"];
        let verdict = event["verdict"].as_str().unwrap_or("none");
        let reason = event["reason"].as_str().unwrap_or("-");
        let outcome = evaluate(&cmd, &rendered, engine, &host, Locale::Utf8)?;
        let label = match &outcome {
            Outcome::Block {
                message,
                reason: code,
                route,
            } => {
                let actual = corpus_text(&String::from_utf8(block_stderr(
                    &cmd,
                    message,
                    *route,
                    Locale::Utf8,
                ))?);
                if status != 2 || actual != stderr || verdict != "block" || reason != *code {
                    mismatches.push(format!(
                        "case {index}: rust blocks {code}, shell {status}/{verdict}/{reason}\n  expected: {stderr:?}\n  actual:   {actual:?}"
                    ));
                }
                format!("block/{code}")
            }
            Outcome::Skip { .. } => {
                if status != 0 || !stderr.is_empty() || verdict != "skip" {
                    mismatches.push(format!(
                        "case {index}: rust skips, shell {status}/{verdict}/{reason}: {cmd:?}"
                    ));
                }
                "skip".to_owned()
            }
            Outcome::Continue { copy_only } => {
                // Rule 6c (Pi control plane) and rule 7 (discards) are not ported yet.
                let ported_block = verdict == "block"
                    && ((PORTED.contains(&reason) && !stderr.contains("Pi control plane"))
                        || (reason == "oversize" && !stderr.contains("discard commands")));
                if ported_block || (verdict == "skip" && !copy_only) {
                    mismatches.push(format!(
                        "case {index}: rust continues, shell {status}/{verdict}/{reason}: {cmd:?}"
                    ));
                }
                "continue".to_owned()
            }
            Outcome::ProgressLane => {
                mismatches.push(format!("case {index}: progress lane is not rendered"));
                "progress".to_owned()
            }
        };
        *decided.entry(label).or_default() += 1;
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    // Every ported rule the corpus exercises is decided natively at least once.
    for label in [
        "block/no-verify",
        "block/rm-root",
        "block/rm-var",
        "block/no-preserve-root",
        "block/fork-bomb",
        "block/block-device",
        "block/oversize",
        "block/managed-rewrite",
        "skip",
    ] {
        assert!(
            decided.get(label).is_some_and(|n| *n > 0),
            "{label}: {decided:?}"
        );
    }
    assert_eq!(decided.values().sum::<usize>(), cases.len());
    Ok(())
}

// Covers: R11
#[test]
fn rendered_values_are_read_as_the_shell_assigns_them() {
    let script = "x=1\nbase='release'\\''s'\nnv_pi_rules='deny rm -rf\nask git push'\nnv_owned_paths=-\nnavori_pg_lane=1\n";
    let rendered = Rendered::from_script(script);
    assert_eq!(
        rendered,
        Some(Rendered {
            base: "release's".to_owned(),
            pi_rules: "deny rm -rf\nask git push".to_owned(),
            owned_paths: "-".to_owned(),
            progress_lane: "1".to_owned(),
        })
    );
    assert_eq!(
        Rendered::from_script("base=\"$X\"\nnv_pi_rules=-\nnv_owned_paths=-\nnavori_pg_lane=0\n"),
        None
    );
}
