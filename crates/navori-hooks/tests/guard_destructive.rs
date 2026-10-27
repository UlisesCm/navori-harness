//! Spec 0057 T28 (R11): the ported guard-destructive rules against the shell's recorded verdicts.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::Path;

use navori_hooks::hooks::guard_destructive::entry::{self, Context};
use navori_hooks::hooks::guard_destructive::repo::{Loss, Repo};
use navori_hooks::hooks::guard_destructive::{
    Host, Outcome, Rendered, ask_answer, block_stderr, evaluate,
};
use navori_hooks::runner::{Engine, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::{Extractor, Profile};
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

/// No corpus case reaches rule 7 with a discard it would measure, and the corpus asset leaves
/// rule 1b off; a case that reads state must be replayed against real repositories instead.
struct NoState;

impl Repo for NoState {
    fn is_dir(&self, dir: &str) -> bool {
        panic!("corpus case asks whether {dir} exists");
    }

    fn holds(&self, dir: &str, loss: Loss) -> bool {
        panic!("corpus case asks whether {dir} holds {loss:?}");
    }

    /// Every case runs outside a git repository (the progress lane, the other reader, is off).
    fn toplevel(&self, _dir: &str) -> Option<String> {
        None
    }

    fn superproject(&self, dir: &str) -> Option<String> {
        panic!("corpus case asks for the superproject of {dir}");
    }

    fn repo_id(&self, dir: &str) -> Option<String> {
        panic!("corpus case asks for the repository of {dir}");
    }

    fn physical(&self, dir: &str) -> Option<String> {
        panic!("corpus case asks for the physical path of {dir}");
    }

    fn ignored(&self, root: &str, path: &str) -> bool {
        panic!("corpus case asks whether {root}/{path} is ignored");
    }

    fn file_size(&self, root: &str, path: &str) -> u64 {
        panic!("corpus case asks for the size of {root}/{path}");
    }

    fn blob_size(&self, root: &str, spec: &str) -> u64 {
        panic!("corpus case asks for the size of {spec} in {root}");
    }

    fn is_file(&self, path: &str) -> bool {
        panic!("corpus case asks whether {path} is a file");
    }

    fn tgrep_status(&self, path: Option<&str>) -> Option<String> {
        panic!("corpus case asks for tgrep status along {path:?}");
    }
}

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
    let home = case["envDelta"]["HOME"]
        .as_str()
        .map_or_else(|| HOME.to_owned(), |v| expand(v, cwd));
    Ok(Host {
        project_dir,
        cwd: field,
        pwd: cwd.to_owned(),
        home: Some(home),
        ..Host::default()
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
        let stdout = off["stdout"].as_str().ok_or("stdout")?;
        let outcome = evaluate(&cmd, &rendered, engine, &host, &NoState, Locale::Utf8)?;
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
            Outcome::Allow { copy_only, ask } => {
                let (want_stdout, want_verdict) = match ask {
                    Some(prefix) => (ask_answer(prefix, Locale::Utf8).0, "ask"),
                    None if *copy_only => (String::new(), "skip"),
                    None => (String::new(), "allow"),
                };
                if status != 0
                    || !stderr.is_empty()
                    || stdout != want_stdout
                    || verdict != want_verdict
                {
                    mismatches.push(format!(
                        "case {index}: rust allows ({want_verdict}), shell {status}/{verdict}/{reason}: {cmd:?}"
                    ));
                }
                format!("allow/{want_verdict}")
            }
            Outcome::Ratchet { .. } => {
                mismatches.push(format!("case {index}: progress lane is not rendered"));
                "ratchet".to_owned()
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
        "block/unspecified",
        "skip",
        "allow/allow",
    ] {
        assert!(
            decided.get(label).is_some_and(|n| *n > 0),
            "{label}: {decided:?}"
        );
    }
    assert_eq!(decided.values().sum::<usize>(), cases.len());
    Ok(())
}

// Covers: R11, R12
#[test]
fn el_payload_crudo_llega_al_veredicto_del_shell_por_la_cascada_de_extraccion() -> TestResult {
    let source = fs::read_to_string(
        workspace().join("packages/core/core-assets/hooks/guard-destructive.sh"),
    )?;
    let rendered = Rendered::from_script(&source).ok_or("rendered assignments")?;
    let mut mismatches = Vec::new();
    let cases = corpus()?;
    for (index, case) in cases.iter().enumerate() {
        let cwd = if case["cwdKind"] == "repo" {
            PROJECT
        } else {
            NONE
        };
        let input = expand(case["input"].as_str().ok_or("input")?, cwd);
        let engine = engine(case["engine"].as_str().ok_or("engine")?).ok_or("engine name")?;
        let host = Host {
            claude_project_dir: case["envDelta"]["CLAUDE_PROJECT_DIR"]
                .as_str()
                .map(|v| expand(v, cwd)),
            ..host(case, engine, cwd)?
        };
        let context = Context {
            engine,
            profile: Profile {
                extractor: Extractor::JqAndNode,
                locale: Locale::Utf8,
            },
            capture: CaptureContext {
                shell: ShellDialect::Bash3,
                script: Path::new("guard-destructive.sh"),
                input_line: 1,
                fallback_line: 1,
            },
            rendered: rendered.clone(),
            host,
        };
        let evaluation = entry::evaluate(input.as_bytes(), &context, &NoState)?;
        let off = &case["expected"]["off"];
        let event = &case["expected"]["active"]["event"][0]["metadata"];
        let status = match evaluation.verdict {
            Verdict::Permit => 0,
            Verdict::Error => 1,
            Verdict::Block => 2,
        };
        let label = evaluation.audit.ok_or("audit label")?;
        let reason = event["reason"].as_str().unwrap_or("unspecified");
        let actual = (
            status,
            String::from_utf8(evaluation.stdout)?,
            corpus_text(&String::from_utf8(evaluation.stderr)?),
            label.verdict,
        );
        let expected = (
            off["status"].as_i64().ok_or("status")?,
            off["stdout"].as_str().ok_or("stdout")?.to_owned(),
            off["stderr"].as_str().ok_or("stderr")?.to_owned(),
            event["verdict"].as_str().ok_or("verdict")?,
        );
        if actual != expected || (reason != "unspecified" && reason != label.reason) {
            mismatches.push(format!(
                "case {index}: {input}\n  expected: {expected:?} {reason}\n  actual:   {actual:?} {}",
                label.reason
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    Ok(())
}

// Covers: R11
#[test]
fn rendered_values_are_read_as_the_shell_assigns_them() {
    let script = "x=1\nbase='release'\\''s'\nnv_pi_rules='deny rm -rf\nask git push'\nnv_owned_paths=-\nf() {\n  navori_progress_hard_cap=8000\n}\nnavori_pg_lane=1\n";
    let rendered = Rendered::from_script(script);
    assert_eq!(
        rendered,
        Some(Rendered {
            base: "release's".to_owned(),
            pi_rules: "deny rm -rf\nask git push".to_owned(),
            owned_paths: "-".to_owned(),
            progress_lane: "1".to_owned(),
            progress_cap: Some("8000".to_owned()),
            search_lane: false,
        })
    );
    assert_eq!(
        Rendered::from_script("base=\"$X\"\nnv_pi_rules=-\nnv_owned_paths=-\nnavori_pg_lane=0\n"),
        None
    );
}
