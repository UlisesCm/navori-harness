//! Spec 0057 T28 (R11): the ported guard-destructive rules against the shell's recorded verdicts.

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use navori_hooks::hooks::guard_destructive::entry::{self, Context, Deadline, Pii};
use navori_hooks::hooks::guard_destructive::pii_bash::{self, HostProbe, Probe};
use navori_hooks::hooks::guard_destructive::{
    Outcome, Rendered, ask_answer, block_stderr, evaluate,
};
use navori_hooks::runner::{Engine, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::hook_input::{self, Host};
use navori_hooks::shell::payload::{Extractor, Profile};
use navori_hooks::shell::pii_egress::{self, EmailRead, Unverifiable};
use navori_hooks::shell::repo::{Holding, Loss, Repo, System};
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

/// The corpus asset leaves rule 1b off and every case runs outside a git repository: the only
/// state a case may read is the empty `none` dir (Codex and Pi landing, rule 7 discards). Any
/// other read must be replayed against real repositories instead.
struct NoState;

impl Repo for NoState {
    /// The empty dir a `none` case runs in exists (`runMode` creates it); the Codex and Pi
    /// landing reads it as the payload's cwd. Any other directory is outside the model.
    fn is_dir(&self, dir: &str) -> bool {
        assert!(dir == NONE, "corpus case asks whether {dir} exists");
        true
    }

    /// That dir is not a git work tree, so a discard there holds nothing (as `System::holds`).
    fn holds(&self, dir: &str, loss: Loss) -> Holding {
        assert!(dir == NONE, "corpus case asks whether {dir} holds {loss:?}");
        Holding::Clear
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

/// The corpus was recorded under bash 3.2 (`Locale::Utf8`), where the PII lane is not measured.
/// Its commands are ASCII, for which the glibc locale agrees with BSD, so they are re-evaluated
/// under `GnuUtf8` (the lane's own parity with bash 5 is `guard_pii_bash`'s).
const LANE: Locale = Locale::GnuUtf8;

/// The hook environment of a case: the host's `PATH`, a glibc locale for `grep` and the case's
/// `NAVORI_PERSONAL_IDS`, as the corpus replay sets it. `GIT_CONFIG_GLOBAL=/dev/null` and no
/// repository make the email absent, so no `git` is resolved.
fn corpus_env(case: &Value) -> Vec<(OsString, OsString)> {
    let mut env = vec![
        (
            OsString::from("PATH"),
            std::env::var_os("PATH").unwrap_or_default(),
        ),
        (OsString::from("LC_ALL"), OsString::from("C.UTF-8")),
    ];
    if let Some(ids) = case["envDelta"]["NAVORI_PERSONAL_IDS"].as_str() {
        env.push((OsString::from("NAVORI_PERSONAL_IDS"), OsString::from(ids)));
    }
    env
}

/// The corpus command's PII facts, resolved as production does (`NAVORI_PERSONAL_IDS` from the
/// environment, the system `grep`).
fn corpus_pii(env: &[(OsString, OsString)]) -> Pii<'_> {
    Pii::from_env(env, Some(PathBuf::from("/usr/bin/grep")), None)
}

fn corpus_probe<'a>(pii: &'a Pii<'a>) -> HostProbe<'a> {
    HostProbe {
        env: pii.env,
        grep: pii.grep.as_deref(),
        git: pii.git.as_deref(),
        pwd: Path::new("/"),
        ids: pii.ids.as_ref(),
        until: None,
    }
}

/// A gated command under `Utf8` is not measured: `Err(UNMEASURED)`, unless the byte ceiling
/// answers first. Returns whether it was the former.
fn assert_unmeasured_under_bsd(result: &Result<Outcome, String>, context: &str) -> bool {
    match result {
        Err(message) if message == pii_bash::UNMEASURED => true,
        Ok(Outcome::Block {
            reason: "oversize", ..
        }) => false,
        other => panic!("{context}: gated command under Utf8 gave {other:?}"),
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
    let mut unmeasured = 0;
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
        assert!(cmd.is_ascii(), "case {index}: the corpus is ASCII");
        let env = corpus_env(case);
        let pii = corpus_pii(&env);
        let probe = corpus_probe(&pii);
        if pii_bash::gate(&cmd, Locale::Utf8) {
            let bsd = evaluate(
                &cmd,
                &rendered,
                engine,
                &host,
                &NoState,
                Locale::Utf8,
                &probe,
            );
            unmeasured += usize::from(assert_unmeasured_under_bsd(&bsd, &format!("case {index}")));
        }
        let outcome = evaluate(&cmd, &rendered, engine, &host, &NoState, LANE, &probe)?;
        let label = match &outcome {
            Outcome::PiiEgress { code } => {
                let actual = corpus_text(pii_egress::stderr(*code));
                if status != 2 || actual != stderr || verdict != "block" || reason != "pii-egress" {
                    mismatches.push(format!(
                        "case {index}: rust blocks pii-egress {code:?}, shell {status}/{verdict}/{reason}"
                    ));
                }
                "block/pii-egress".to_owned()
            }
            Outcome::Block {
                message,
                reason: code,
                route,
            } => {
                let actual = corpus_text(&String::from_utf8(block_stderr(
                    &cmd, message, *route, LANE,
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
                    Some(prefix) => (ask_answer(prefix, LANE).0, "ask"),
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
        "block/pii-egress",
        "skip",
        "allow/allow",
    ] {
        assert!(
            decided.get(label).is_some_and(|n| *n > 0),
            "{label}: {decided:?}"
        );
    }
    assert_eq!(decided.values().sum::<usize>(), cases.len());
    // The 23 gated commands of the recorded corpus (14 block, 9 skip or allow) are all unmeasured
    // under BSD and answered under glibc.
    assert_eq!(unmeasured, 23, "gated corpus commands");
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
    let mut unmeasured = 0;
    let cases = corpus()?;
    for (index, case) in cases.iter().enumerate() {
        let cwd = if case["cwdKind"] == "repo" {
            PROJECT
        } else {
            NONE
        };
        let input = expand(case["input"].as_str().ok_or("input")?, cwd);
        let engine = engine(case["engine"].as_str().ok_or("engine")?).ok_or("engine name")?;
        let command = expand(
            &command(case["input"].as_str().ok_or("input")?).ok_or("command")?,
            cwd,
        );
        let mut host = Host {
            claude_project_dir: case["envDelta"]["CLAUDE_PROJECT_DIR"]
                .as_str()
                .map(|v| expand(v, cwd)),
            ..host(case, engine, cwd)?
        };
        if pii_bash::gate(&command, Locale::Utf8) {
            // The replay's scratch cwd does not exist here, and the lane runs `grep` in it.
            "/".clone_into(&mut host.pwd);
        }
        let env = corpus_env(case);
        let context = Context {
            engine,
            profile: Profile {
                extractor: Extractor::JqAndNode,
                locale: LANE,
            },
            capture: CaptureContext {
                shell: ShellDialect::Bash3,
                script: Path::new("guard-destructive.sh"),
                input_line: 1,
                fallback_line: 1,
            },
            rendered: rendered.clone(),
            host,
            pii: corpus_pii(&env),
        };
        if pii_bash::gate(&command, Locale::Utf8) {
            let bsd = Context {
                profile: Profile {
                    extractor: Extractor::JqAndNode,
                    locale: Locale::Utf8,
                },
                ..context.clone()
            };
            match entry::evaluate(input.as_bytes(), &bsd, &NoState) {
                Err(failure) if pii_bash::is_unmeasured(&failure) => unmeasured += 1,
                Ok(evaluation) if evaluation.verdict == Verdict::Block => {}
                other => panic!("case {index}: gated command under Utf8 gave {other:?}"),
            }
        }
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
    assert!(unmeasured >= 23, "gated corpus commands: {unmeasured}");
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

// Covers: R50
#[test]
fn veredictos_sin_cambio_tras_mover_los_parciales_a_shell() -> TestResult {
    // `hook-input`'s `nv_project_dir`, now shared from `shell::hook_input`: Claude reads only
    // `CLAUDE_PROJECT_DIR`; Codex and Pi take the git toplevel of the payload's cwd, else that
    // cwd, else `.`.
    assert_eq!(
        hook_input::project_dir(Engine::Claude, Some("/p"), "/elsewhere", &NoState),
        "/p"
    );
    assert_eq!(
        hook_input::project_dir(Engine::Claude, None, "/x", &NoState),
        ""
    );
    for engine in [Engine::Codex, Engine::Pi] {
        assert_eq!(
            hook_input::project_dir(engine, Some("/p"), "", &NoState),
            "."
        );
        assert_eq!(hook_input::project_dir(engine, None, "/x", &NoState), "/x");
    }
    let checkout = workspace().to_str().ok_or("workspace path")?;
    let top = System
        .toplevel(checkout)
        .ok_or("the checkout is a git work tree")?;
    assert_ne!(top, checkout, "toplevel normalizes the `..` components");
    assert_eq!(
        hook_input::project_dir(Engine::Codex, None, checkout, &System),
        top
    );
    // The corpus verdicts themselves are pinned by `cada_regla_…` above, by the Rust replay and
    // by the fuzz (A1), which run unchanged before and after the move.
    Ok(())
}

/// The shipped asset's rendered values and a context nothing in the host reaches.
fn plain_context() -> Result<Context<'static>, Box<dyn Error>> {
    let source = fs::read_to_string(
        workspace().join("packages/core/core-assets/hooks/guard-destructive.sh"),
    )?;
    Ok(Context {
        engine: Engine::Claude,
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
        rendered: Rendered::from_script(&source).ok_or("rendered assignments")?,
        host: Host::default(),
        pii: Pii::default(),
    })
}

/// `started` this long ago, so a deadline can be expired without waiting for it.
fn ago(seconds: u64) -> Result<Instant, Box<dyn Error>> {
    Ok(Instant::now()
        .checked_sub(Duration::from_secs(seconds))
        .ok_or("clock too close to its origin")?)
}

const HARMLESS: &[u8] = br#"{"tool_name":"Bash","tool_input":{"command":"echo hi"}}"#;

/// #1671: past its own deadline the guard blocks, with the message of the shell's
/// `nv_on_deadline`, no command and no reason code; never a permit.
#[test]
fn deadline_expired_blocks_even_a_harmless_command() -> TestResult {
    let context = plain_context()?;
    let live = Deadline::from_env(None, Instant::now());
    let evaluation = entry::evaluate_until(HARMLESS, &context, NoState, live)?;
    assert_eq!(evaluation.verdict, Verdict::Permit);

    let expired = Deadline::from_env(Some("3"), ago(4)?);
    let evaluation = entry::evaluate_until(HARMLESS, &context, NoState, expired)?;
    assert_eq!(evaluation.verdict, Verdict::Block);
    assert!(evaluation.stdout.is_empty());
    assert_eq!(
        String::from_utf8(evaluation.stderr)?,
        "[navori] BLOCKED by guard-destructive: inspection did not finish within 3s — nothing was approved\n"
    );
    let label = evaluation.audit.ok_or("audit label")?;
    assert_eq!((label.verdict, label.reason.as_str()), ("block", ""));
    Ok(())
}

/// #1731: the shell blocks `rm -rf /` in these payloads, but serde_json rejects the document jq
/// reads, or (300 levels) reads one some accredited jq rejects. The answer must be a failure (the
/// call defers), never the empty permit.
#[test]
fn a_payload_jq_reads_and_serde_rejects_is_never_a_permit_in_jq_modes() -> TestResult {
    let deep = format!(
        r#"{{"tool_input":{{"command":"rm -rf /"}},"x":{}1{}}}"#,
        "[".repeat(300),
        "]".repeat(300)
    );
    let payloads: [&[u8]; 10] = [
        br#"{"tool_input":{"command":"rm -rf /"},"x":NaN}"#,
        br#"{"tool_input":{"command":"rm -rf /"},"x":nan123}"#,
        b"{\"tool_input\":{\"command\":\"rm -rf /\"},\"x\":\"\x1f\"}",
        br#"{"tool_input":{"command":"rm -rf /"}}{"x":1}"#,
        br#"{"tool_input":{"command":"rm -rf /"}} x"#,
        b"\xef\xbb\xbf{\"tool_input\":{\"command\":\"rm -rf /\"}}",
        deep.as_bytes(),
        br#"{"tool_input":{"command":"rm -rf /"},"x":01}"#,
        br#"{"tool_input":{"command":"rm -rf /"},"x":.5}"#,
        br#"{"tool_input":{"command":"rm -rf /"},"x":sNaN}"#,
    ];
    for payload in payloads {
        for extractor in [Extractor::JqAndNode, Extractor::JqOnly] {
            let mut context = plain_context()?;
            context.profile.extractor = extractor;
            let live = Deadline::from_env(None, Instant::now());
            let result = entry::evaluate_until(payload, &context, NoState, live);
            assert!(
                result.is_err(),
                "{extractor:?} must defer: {}",
                String::from_utf8_lossy(&payload[..payload.len().min(40)])
            );
        }
    }
    Ok(())
}

/// NAVORI_GUARD_DEADLINE only lowers the deadline: one digit 1..8, anything else keeps 8s.
#[test]
fn deadline_variable_can_only_lower_it() -> TestResult {
    let context = plain_context()?;
    let started = ago(9)?;
    for value in [
        None,
        Some("9"),
        Some("0"),
        Some("08"),
        Some("12"),
        Some("-1"),
        Some(" 3"),
        Some(""),
    ] {
        let deadline = Deadline::from_env(value, started);
        let evaluation = entry::evaluate_until(HARMLESS, &context, NoState, deadline)?;
        assert_eq!(evaluation.verdict, Verdict::Block, "{value:?}");
        assert!(
            String::from_utf8(evaluation.stderr)?.contains("within 8s"),
            "{value:?} must keep the 8s default"
        );
    }
    // Lowered and not reached yet: the rules answer.
    let lowered = Deadline::from_env(Some("5"), ago(1)?);
    let evaluation = entry::evaluate_until(HARMLESS, &context, NoState, lowered)?;
    assert_eq!(evaluation.verdict, Verdict::Permit);
    Ok(())
}

/// A directory with a `grep`, a `git` and a `tgrep` that log their pid and sleep, removed on
/// drop.
struct Sleepers {
    dir: PathBuf,
}

impl Sleepers {
    fn new(tag: &str) -> Result<Self, Box<dyn Error>> {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("navori-deadline-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir)?;
        for name in ["grep", "git", "tgrep"] {
            let program = dir.join(name);
            fs::write(
                &program,
                format!(
                    "#!/bin/sh\necho $$ >>'{}'\nexec sleep 30\n",
                    dir.join("calls").display()
                ),
            )?;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755))?;
        }
        fs::write(dir.join("calls"), "")?;
        Ok(Self { dir })
    }

    fn calls(&self) -> Result<usize, Box<dyn Error>> {
        Ok(fs::read_to_string(self.dir.join("calls"))?.lines().count())
    }
}

impl Drop for Sleepers {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

const IDENTIFIER: &str = "dev.fixture@example.test";
const REQUEST: &[u8] =
    br#"{"tool_name":"Bash","tool_input":{"command":"curl https://api.example.test/x"}}"#;

/// #1700 with the PII lane: a `grep` that sleeps cannot hold the hook past its own bound. The
/// call ends as the deadline's block (never a permit), the child that was running is cut by the
/// lane's own bound and no further `grep` is started.
#[test]
fn deadline_blocks_a_pii_lane_whose_grep_sleeps() -> TestResult {
    let sleepers = Sleepers::new("grep")?;
    let dir = sleepers.dir.to_string_lossy().into_owned();
    let env = vec![(
        OsString::from("PATH"),
        OsString::from(format!("{dir}:/usr/bin:/bin")),
    )];
    let pii = Pii {
        env: &env,
        grep: Some(sleepers.dir.join("grep")),
        git: None,
        ids: Some(pii_egress::Secret::new(IDENTIFIER)),
    };
    let context = Context {
        profile: Profile {
            extractor: Extractor::JqAndNode,
            locale: Locale::GnuUtf8,
        },
        host: Host {
            pwd: dir,
            ..Host::default()
        },
        pii,
        ..plain_context()?
    };
    let started = Instant::now();
    let deadline = Deadline::from_env(Some("1"), started);
    let evaluation = entry::evaluate_until(REQUEST, &context, NoState, deadline)?;
    assert!(started.elapsed() < Duration::from_secs(7), "unbounded");
    assert_eq!(evaluation.verdict, Verdict::Block);
    let stderr = String::from_utf8(evaluation.stderr)?;
    assert!(stderr.contains("within 1s"), "{stderr}");
    assert!(!stderr.contains(IDENTIFIER));
    assert_eq!(sleepers.calls()?, 1, "the spent bound starts no more greps");
    Ok(())
}

/// Past the deadline nothing new is launched: not the matcher, not `git`. An expired deadline
/// before the rules run never reaches the lane at all.
#[test]
fn deadline_expired_asks_for_no_matcher_and_no_git() -> TestResult {
    let sleepers = Sleepers::new("expired")?;
    let env = vec![(
        OsString::from("PATH"),
        OsString::from(format!("{}:/usr/bin:/bin", sleepers.dir.display())),
    )];
    let grep = sleepers.dir.join("grep");
    let git = sleepers.dir.join("git");
    let ids = pii_egress::Secret::new(IDENTIFIER);
    let probe = HostProbe {
        env: &env,
        grep: Some(&grep),
        git: Some(&git),
        pwd: &sleepers.dir,
        ids: Some(&ids),
        until: Some(ago(1)?),
    };
    assert_eq!(probe.matcher().has(b"abcd", "text"), Err(Unverifiable));
    assert_eq!(probe.email(), EmailRead::Unreadable);
    assert_eq!(sleepers.calls()?, 0);

    let context = Context {
        profile: Profile {
            extractor: Extractor::JqAndNode,
            locale: Locale::GnuUtf8,
        },
        pii: Pii::from_env(&env, Some(grep), Some(git)),
        ..plain_context()?
    };
    let expired = Deadline::from_env(Some("2"), ago(3)?);
    let evaluation = entry::evaluate_until(REQUEST, &context, NoState, expired)?;
    assert_eq!(evaluation.verdict, Verdict::Block);
    assert_eq!(sleepers.calls()?, 0);
    Ok(())
}

/// The `Repo` call a [`Stuck`] repository never returns from, until the test lets it go.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stall {
    IsDir,
    Toplevel,
    Holds,
    TgrepStatus,
}

/// A repository that hangs on one call (`stall`) and answers the others as an empty tree.
/// `entered` tells the test the call was reached; dropping the paired sender lets it go.
struct Stuck {
    stall: Stall,
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

impl Stuck {
    fn at(stall: Stall) -> (Self, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered, reached) = mpsc::channel();
        let (hold, release) = mpsc::channel();
        (
            Self {
                stall,
                entered,
                release,
            },
            reached,
            hold,
        )
    }

    fn call(&self, at: Stall) {
        if self.stall == at {
            let _ = self.entered.send(());
            // Returns an error once the test drops its sender.
            let _ = self.release.recv();
        }
    }
}

impl Repo for Stuck {
    fn is_dir(&self, _: &str) -> bool {
        self.call(Stall::IsDir);
        true
    }

    fn holds(&self, _: &str, _: Loss) -> Holding {
        self.call(Stall::Holds);
        Holding::Clear
    }

    fn toplevel(&self, _: &str) -> Option<String> {
        self.call(Stall::Toplevel);
        None
    }

    fn superproject(&self, _: &str) -> Option<String> {
        None
    }

    fn repo_id(&self, _: &str) -> Option<String> {
        None
    }

    fn physical(&self, _: &str) -> Option<String> {
        None
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
        self.call(Stall::TgrepStatus);
        None
    }
}

/// A repository whose every read panics.
struct Panicky;

impl Repo for Panicky {
    fn is_dir(&self, _: &str) -> bool {
        panic!("rule exploded");
    }
    fn holds(&self, _: &str, _: Loss) -> Holding {
        panic!("rule exploded");
    }
    fn toplevel(&self, _: &str) -> Option<String> {
        panic!("rule exploded");
    }
    fn superproject(&self, _: &str) -> Option<String> {
        panic!("rule exploded");
    }
    fn repo_id(&self, _: &str) -> Option<String> {
        panic!("rule exploded");
    }
    fn physical(&self, _: &str) -> Option<String> {
        panic!("rule exploded");
    }
    fn ignored(&self, _: &str, _: &str) -> bool {
        panic!("rule exploded");
    }
    fn file_size(&self, _: &str, _: &str) -> u64 {
        panic!("rule exploded");
    }
    fn blob_size(&self, _: &str, _: &str) -> u64 {
        panic!("rule exploded");
    }
    fn is_file(&self, _: &str) -> bool {
        panic!("rule exploded");
    }
    fn tgrep_status(&self, _: Option<&str>) -> Option<String> {
        panic!("rule exploded");
    }
}

/// A call that never returns ends as the deadline's block: same message, nothing on stdout,
/// the `block` audit label, well before the host's own kill.
fn assert_stalled_block(
    engine: Engine,
    stall: Stall,
    command: &str,
    search_lane: bool,
) -> TestResult {
    let mut context = plain_context()?;
    context.engine = engine;
    context.rendered.search_lane = search_lane;
    context.host.path = Some("/usr/bin:/bin".to_owned());
    let payload = format!(
        r#"{{"tool_name":"Bash","cwd":"/tmp/stalled","tool_input":{{"command":"{command}"}}}}"#
    );
    let (repo, reached, hold) = Stuck::at(stall);
    let started = Instant::now();
    let deadline = Deadline::from_env(Some("1"), started);
    let evaluation = entry::evaluate_until(payload.as_bytes(), &context, repo, deadline)?;
    let elapsed = started.elapsed();
    reached
        .try_recv()
        .map_err(|_| "the stalled call was never reached")?;
    drop(hold);
    assert!(elapsed < Duration::from_secs(3), "took {elapsed:?}");
    assert_eq!(evaluation.verdict, Verdict::Block);
    assert!(evaluation.stdout.is_empty());
    assert_eq!(
        String::from_utf8(evaluation.stderr)?,
        "[navori] BLOCKED by guard-destructive: inspection did not finish within 1s — nothing was approved\n"
    );
    let label = evaluation.audit.ok_or("audit label")?;
    assert_eq!((label.verdict, label.reason.as_str()), ("block", ""));
    Ok(())
}

/// The deadline cuts a hung project-directory read (Codex and Pi ask git for the toplevel).
#[test]
fn deadline_cuts_a_hung_toplevel() -> TestResult {
    for engine in [Engine::Codex, Engine::Pi] {
        assert_stalled_block(engine, Stall::Toplevel, "echo hi", false)?;
    }
    Ok(())
}

/// The deadline cuts a hung rule: rule 7's directory test and its work-tree read.
#[test]
fn deadline_cuts_a_hung_discard_rule() -> TestResult {
    assert_stalled_block(Engine::Claude, Stall::IsDir, "git checkout -- .", false)?;
    assert_stalled_block(Engine::Claude, Stall::Holds, "git checkout -- .", false)
}

/// The deadline cuts a hung `tgrep status` of the search lane.
#[test]
fn deadline_cuts_a_hung_search_lane() -> TestResult {
    assert_stalled_block(Engine::Claude, Stall::TgrepStatus, "grep -rn foo src", true)
}

/// A real `tgrep status` that hangs is killed at the deadline, not left running as an orphan
/// once the process exits.
#[test]
fn the_deadline_kills_the_hung_tgrep_it_abandons() -> TestResult {
    let sleepers = Sleepers::new("orphan")?;
    let mut context = plain_context()?;
    context.rendered.search_lane = true;
    context.host.path = Some(format!("{}:/usr/bin:/bin", sleepers.dir.display()));
    let payload =
        br#"{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"grep -rn foo src"}}"#;
    let deadline = Deadline::from_env(Some("1"), Instant::now());
    let evaluation = entry::evaluate_until(payload, &context, System, deadline)?;
    assert_eq!(evaluation.verdict, Verdict::Block);
    let calls = fs::read_to_string(sleepers.dir.join("calls"))?;
    let pid = calls.lines().next().ok_or("tgrep never ran")?.to_owned();
    let alive = || {
        std::process::Command::new("kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    let limit = Instant::now() + Duration::from_secs(2);
    while alive() {
        if Instant::now() > limit {
            return Err(format!("tgrep {pid} outlived the deadline").into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// A rule that panics is an error, never a permit, and the answer carries nothing for stdout.
#[test]
fn a_panicking_rule_is_an_error_never_a_permit() -> TestResult {
    let mut context = plain_context()?;
    context.engine = Engine::Codex;
    let deadline = Deadline::from_env(None, Instant::now());
    let result = entry::evaluate_until(HARMLESS, &context, Panicky, deadline);
    let failure = result.err().ok_or("a panic must not permit")?;
    assert!(
        failure.0.starts_with("panic: rule exploded"),
        "{}",
        failure.0
    );
    Ok(())
}

/// A `Repo` whose rule-7 read answers a fixed [`Holding`] for an existing directory.
struct Fixed(Holding);

impl Repo for Fixed {
    fn is_dir(&self, _: &str) -> bool {
        true
    }
    fn holds(&self, _: &str, _: Loss) -> Holding {
        self.0
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
    fn physical(&self, _: &str) -> Option<String> {
        None
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

/// A `Repo` where only `/dirty` holds work; every directory exists.
struct ByDir;

impl Repo for ByDir {
    fn is_dir(&self, _: &str) -> bool {
        true
    }
    fn holds(&self, dir: &str, _: Loss) -> Holding {
        if dir == "/dirty" {
            Holding::Holds
        } else {
            Holding::Clear
        }
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
    fn physical(&self, _: &str) -> Option<String> {
        None
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

/// `command` run from `cwd` under `locale`, where only `/dirty` holds work: whether it blocks.
fn blocked_at(command: &str, cwd: &str, locale: Locale) -> Result<bool, Box<dyn Error>> {
    let mut context = plain_context()?;
    context.profile.locale = locale;
    let payload = serde_json::json!({
        "tool_name": "Bash",
        "cwd": cwd,
        "tool_input": { "command": command },
    })
    .to_string();
    let evaluation = entry::evaluate_until(
        payload.as_bytes(),
        &context,
        ByDir,
        Deadline::from_env(None, Instant::now()),
    )?;
    Ok(evaluation.verdict == Verdict::Block)
}

/// #1801 round 3: assignment prefixes of a non-git segment are peeled again, so the `cd` walk
/// follows `FOO=1 cd <dir>` as on base; `export` matches only at a token start.
#[test]
fn rule_7_follows_cd_behind_assignments() -> TestResult {
    let utf8 = Locale::Utf8;
    let deny_from_clean = [
        "FOO=1 cd /dirty && git reset --hard",
        "FOO=1 BAR=2 cd /dirty && git reset --hard",
        "GIT_DIR=x FOO=1 cd /dirty && git reset --hard",
        // Documented exception: quotes are dropped before the peel.
        "\"FOO\"=1 cd /dirty && git reset --hard",
        "F\"O\"O=1 cd /dirty && git reset --hard",
    ];
    for command in deny_from_clean {
        assert!(blocked_at(command, "/work", utf8)?, "{command}");
    }
    // Base behaviour: `env` is not peeled, so the cd is not followed.
    assert!(!blocked_at(
        "env FOO=1 cd /dirty && git reset --hard",
        "/work",
        utf8
    )?);
    assert!(!blocked_at(
        "FOO=1 cd /clean && git reset --hard",
        "/dirty",
        utf8
    )?);
    for command in [
        "export MY_GIT_DIR=x; git reset --hard",
        "export FOO=GIT_DIR=x; git reset --hard",
        "FOO=GIT_DIR=x git reset --hard",
    ] {
        assert!(!blocked_at(command, "/work", utf8)?, "{command}");
    }
    assert!(blocked_at(
        "export A=1 GIT_DIR=x; git reset --hard",
        "/work",
        utf8
    )?);
    Ok(())
}

/// U+2000 is a blank in the UTF-8 locales and not in `C`: `GIT_DIR=x<U+2000>git` is a prefix
/// only where the blank class says so, as the shell's `sed` decides.
#[test]
fn rule_7_blank_class_follows_the_locale() -> TestResult {
    let command = "GIT_DIR=x\u{2000}git reset --hard";
    assert!(blocked_at(command, "/work", Locale::Utf8)?);
    assert!(blocked_at(command, "/work", Locale::GnuUtf8)?);
    assert!(!blocked_at(command, "/work", Locale::C)?);
    Ok(())
}

/// The anchored `export` match stays linear on a long line (nested `*` in the shell's regex).
#[test]
fn rule_7_export_line_stays_fast() -> TestResult {
    let command = format!("export {} ; git reset --hard", "A=1 ".repeat(3000));
    let started = Instant::now();
    assert!(!blocked_at(&command, "/work", Locale::Utf8)?);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    Ok(())
}

/// `git reset --hard` in an existing directory, rule 7 reading `holding`: the stderr, or `None`
/// when it is allowed.
fn discard_verdict(holding: Holding) -> Result<Option<String>, Box<dyn Error>> {
    let context = plain_context()?;
    let payload =
        br#"{"tool_name":"Bash","cwd":"/work","tool_input":{"command":"git reset --hard"}}"#;
    let started = Instant::now();
    let evaluation = entry::evaluate_until(
        payload,
        &context,
        Fixed(holding),
        Deadline::from_env(None, started),
    )?;
    Ok((evaluation.verdict == Verdict::Block)
        .then(|| String::from_utf8_lossy(&evaluation.stderr).into_owned()))
}

/// #1776: a Repo that cannot inspect the directory blocks like an uninspectable directory;
/// a clean one allows and one holding work blocks with its own message.
#[test]
fn rule_7_fails_closed_when_git_cannot_inspect() -> TestResult {
    assert_eq!(discard_verdict(Holding::Clear)?, None);
    let holds = discard_verdict(Holding::Holds)?.ok_or("holds must block")?;
    assert!(
        holds.contains("git reset would discard uncommitted work"),
        "{holds}"
    );
    let unknown = discard_verdict(Holding::Unknown)?.ok_or("unknown must block")?;
    assert!(
        unknown.contains(
            "git reset discards work and its target directory cannot be inspected (the repository tool is missing"
        ),
        "{unknown}"
    );
    assert!(
        unknown.contains("use a literal existing directory"),
        "{unknown}"
    );
    Ok(())
}

/// `command` in an existing directory, rule 7 reading `holding`: whether it is blocked.
fn blocked(command: &str, holding: Holding) -> Result<bool, Box<dyn Error>> {
    let context = plain_context()?;
    let payload = serde_json::json!({
        "tool_name": "Bash",
        "cwd": "/work",
        "tool_input": { "command": command },
    })
    .to_string();
    let evaluation = entry::evaluate_until(
        payload.as_bytes(),
        &context,
        Fixed(holding),
        Deadline::from_env(None, Instant::now()),
    )?;
    Ok(evaluation.verdict == Verdict::Block)
}

/// #1801: git as a path, behind `env` or escaped is a rule-7 candidate, and a `GIT_DIR`/
/// `GIT_WORK_TREE` written in the command (prefix or an earlier segment) makes the directory
/// uninspectable, so it blocks even when the inspected directory is clean.
#[test]
fn rule_7_reads_other_forms_of_git() -> TestResult {
    let uninspectable = [
        "GIT_DIR=/r/.git GIT_WORK_TREE=/r git -C /n reset --hard",
        "GIT_WORK_TREE=/r GIT_DIR=/r/.git git -C /n checkout -- .",
        "export GIT_DIR=/r/.git; git -C /n reset --hard",
        "GIT_DIR=/r/.git; git -C /n reset --hard",
        "declare -x GIT_WORK_TREE=/r && git -C /n clean -fd",
        "env GIT_DIR=/r/.git git -C /n reset --hard",
        "GIT_DIR=/r/.git /usr/bin/git -C /n reset --hard",
        "git -C /n --git-dir=/r/.git reset --hard",
    ];
    for command in uninspectable {
        assert!(blocked(command, Holding::Clear)?, "{command}");
    }
    let holds = [
        "git reset --hard",
        "/usr/bin/git reset --hard",
        "./git reset --hard",
        "/usr/bin/git -C /r clean -fd",
        "env git reset --hard",
        "env FOO=1 git reset --hard",
        "\\git reset --hard",
        "FOO=1 git reset --hard",
        "command git reset --hard",
    ];
    for command in holds {
        assert!(blocked(command, Holding::Holds)?, "{command}");
        assert!(!blocked(command, Holding::Clear)?, "{command} on clean");
    }
    let allowed = [
        "/usr/bin/git status",
        "env git status",
        "GIT_DIR=/r/.git git status",
        "export GIT_DIR=/r/.git; git status",
        "export FOO=1; git reset --soft HEAD~1",
        "sudo git reset --hard",
        "sh -c 'git reset --hard'",
        "eval git reset --hard",
        "/usr/bin/mygit reset --hard",
    ];
    for command in allowed {
        assert!(!blocked(command, Holding::Holds)?, "{command}");
    }
    Ok(())
}

const PROBE_DIR: &str = "NAVORI_HOLDS_PROBE_DIR";

/// Child half of [`system_holds_under`]: `System` caches its `git` per process, so each PATH
/// variant needs its own. A no-op unless the parent sets [`PROBE_DIR`].
#[test]
fn system_holds_probe_child() {
    if let Some(dir) = std::env::var_os(PROBE_DIR) {
        let dir = dir.to_string_lossy().into_owned();
        println!("HOLDING={:?}", System.holds(&dir, Loss::Tracked));
    }
}

/// `System::holds(dir, Tracked)` in a child process whose `PATH` is `path`.
fn system_holds_under(path: &str, dir: &Path) -> Result<String, Box<dyn Error>> {
    let mut child = std::process::Command::new(std::env::current_exe()?);
    hermetic(&mut child, path, dir)
        .args([
            "--exact",
            "system_holds_probe_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(PROBE_DIR, dir);
    let out = child.output()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.split_once("HOLDING=")
        .map(|(_, rest)| rest.lines().next().unwrap_or_default().to_owned())
        .ok_or_else(|| format!("child printed no verdict: {text}").into())
}

/// A clean environment for `command`: only `path`, a scratch `HOME` and no system or global git
/// configuration, so neither the user's gitconfig nor an inherited `GIT_DIR`/`GIT_INDEX_FILE`
/// can reach the real repository (as `navori-cli/tests/quality_gate_git.rs` does).
fn hermetic<'a>(
    command: &'a mut std::process::Command,
    path: &str,
    home: &Path,
) -> &'a mut std::process::Command {
    command
        .env_clear()
        .env("PATH", path)
        .env("HOME", home)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
}

/// Removes the scratch dirs a test created, also when it fails half way.
struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for dir in &self.0 {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("navori-holds-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn git_ok(dir: &Path, args: &[&str]) -> TestResult {
    let mut git = std::process::Command::new("git");
    hermetic(&mut git, &std::env::var("PATH")?, dir)
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args);
    let status = git.status()?;
    assert!(status.success(), "git {args:?}");
    Ok(())
}

/// A fake `git` in its own dir: `body` as the script, with `mode` permissions.
fn fake_git(name: &str, body: &str, mode: u32) -> Result<String, Box<dyn Error>> {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch(name)?;
    let git = dir.join("git");
    fs::write(&git, body)?;
    fs::set_permissions(&git, fs::Permissions::from_mode(mode))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// #1776 through `System`: only a git that runs can say "nothing to lose"; a missing,
/// non-executable or failing git is `Unknown`, and a repo's dirty/clean state is unchanged.
#[test]
fn system_holds_is_unknown_when_git_is_unusable() -> TestResult {
    let real = std::env::var("PATH")?;
    let names = [
        "repo",
        "plain",
        "empty-path",
        "noexec",
        "fails",
        "status-fails",
    ];
    let _cleanup = Cleanup(
        names
            .iter()
            .map(|name| {
                std::env::temp_dir().join(format!("navori-holds-{}-{name}", std::process::id()))
            })
            .collect(),
    );
    let repo = scratch("repo")?;
    git_ok(&repo, &["init", "-q"])?;
    fs::write(repo.join("f"), "a")?;
    git_ok(&repo, &["add", "f"])?;
    git_ok(&repo, &["commit", "-qm", "init"])?;
    assert_eq!(system_holds_under(&real, &repo)?, "Clear");
    fs::write(repo.join("f"), "b")?;
    assert_eq!(system_holds_under(&real, &repo)?, "Holds");

    let plain = scratch("plain")?;
    assert_eq!(system_holds_under(&real, &plain)?, "Clear");

    let empty = scratch("empty-path")?;
    let missing = empty.to_string_lossy().into_owned();
    assert_eq!(system_holds_under(&missing, &repo)?, "Unknown");
    let noexec = fake_git("noexec", "#!/bin/sh\nexec /usr/bin/git \"$@\"\n", 0o644)?;
    assert_eq!(system_holds_under(&noexec, &repo)?, "Unknown");
    let fails = fake_git("fails", "#!/bin/sh\nexit 128\n", 0o755)?;
    assert_eq!(system_holds_under(&fails, &repo)?, "Unknown");
    assert_eq!(system_holds_under(&fails, &plain)?, "Unknown");
    // Usable for rev-parse and `--version`, failing on status.
    let status_fails = fake_git(
        "status-fails",
        "#!/bin/sh\ncase \"$*\" in *status*) exit 1 ;; esac\nexec /usr/bin/git \"$@\"\n",
        0o755,
    )?;
    assert_eq!(system_holds_under(&status_fails, &repo)?, "Unknown");
    Ok(())
}
