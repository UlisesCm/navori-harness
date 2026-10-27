//! Spec 0057 T28 (R11): the ported guard-destructive rules against the shell's recorded verdicts.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::Path;

use navori_hooks::hooks::guard_destructive::{Outcome, Rendered, block_stderr, evaluate};
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
];

/// Deep scratch paths like the replay's, so no root/home rule can see them.
const TOKENS: &[(&str, &str)] = &[
    ("@CWD@", "/scratch/replay/cases/0/project"),
    ("@TMP@", "/scratch/replay/tmp"),
    ("@R@", "XXXXXX"),
];

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

fn host(text: &str) -> String {
    TOKENS.iter().fold(text.to_owned(), |text, (token, path)| {
        text.replace(token, path)
    })
}

fn corpus_text(text: &str) -> String {
    TOKENS.iter().fold(text.to_owned(), |text, (token, path)| {
        text.replace(path, token)
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
        let cmd = host(&command(input).ok_or("command")?);
        let engine = engine(case["engine"].as_str().ok_or("engine")?).ok_or("engine name")?;
        let off = &case["expected"]["off"];
        let status = off["status"].as_i64().ok_or("status")?;
        let stderr = off["stderr"].as_str().ok_or("stderr")?;
        let event = &case["expected"]["active"]["event"][0]["metadata"];
        let verdict = event["verdict"].as_str().unwrap_or("none");
        let reason = event["reason"].as_str().unwrap_or("-");
        let outcome = evaluate(&cmd, &rendered, engine, Locale::Utf8)?;
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
                let ported_block = verdict == "block"
                    && (PORTED.contains(&reason)
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
