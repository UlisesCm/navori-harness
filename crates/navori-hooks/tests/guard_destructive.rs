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
use navori_hooks::shell::repo::{Loss, Repo, System};
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
    fn holds(&self, dir: &str, loss: Loss) -> bool {
        assert!(dir == NONE, "corpus case asks whether {dir} holds {loss:?}");
        false
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

/// A directory with a `grep` and a `git` that log their pid and sleep, removed on drop.
struct Sleepers {
    dir: PathBuf,
}

impl Sleepers {
    fn new(tag: &str) -> Result<Self, Box<dyn Error>> {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("navori-deadline-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir)?;
        for name in ["grep", "git"] {
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

    fn holds(&self, _: &str, _: Loss) -> bool {
        self.call(Stall::Holds);
        false
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
    fn holds(&self, _: &str, _: Loss) -> bool {
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
