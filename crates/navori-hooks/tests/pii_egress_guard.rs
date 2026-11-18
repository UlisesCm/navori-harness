//! pii-egress-guard (the web half of #1445) against the shell's recorded verdicts and against the
//! real rendered script under bash. Policy parity only: registration and shadow run elsewhere.
//!
//! The identifier never reaches an assertion message: cases are named by index, and every
//! identifier is the fictitious `dev@example.test` or a variation of it.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use navori_hooks::hooks::pii_egress_guard::{Context, evaluate};
use navori_hooks::runner::{Evaluation, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::{Extractor, Profile};
use navori_hooks::shell::pii_egress::{
    Code, EmailRead, HostProbe, Matcher, Pii, Probe, Secret, stderr as pii_stderr,
};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;

const ID: &str = "dev@example.test";
const GREP: &str = "/usr/bin/grep";
const GIT: &str = "/usr/bin/git";

struct Temp(PathBuf);

impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "navori-pii-web-{}-{}",
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

fn script() -> PathBuf {
    repo().join(".claude/hooks/pii-egress-guard.sh")
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

fn os(key: &str, value: &str) -> (OsString, OsString) {
    (OsString::from(key), OsString::from(value))
}

/// The environment both lanes see: the machine's `PATH`, a glibc UTF-8 locale, no git config
/// of the host, and `extra`.
fn environment(extra: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    let mut env = vec![
        os("PATH", &std::env::var("PATH").unwrap_or_default()),
        os("LANG", "C.UTF-8"),
        os("GIT_CONFIG_GLOBAL", "/dev/null"),
        os("GIT_CONFIG_SYSTEM", "/dev/null"),
        os("GIT_CONFIG_NOSYSTEM", "1"),
    ];
    env.extend(extra.iter().map(|(key, value)| os(key, value)));
    env
}

fn context<'a>() -> Context<'a> {
    Context {
        profile: Profile {
            extractor: Extractor::JqAndNode,
            locale: Locale::GnuUtf8,
        },
        capture: CaptureContext {
            shell: ShellDialect::Bash5,
            script: Path::new("pii-egress-guard.sh"),
            input_line: 1,
            fallback_line: 1,
        },
    }
}

/// The native lane over the real `grep` and `git` of this machine; `grep` is `None` for a host
/// without one.
fn native_with(
    payload: &[u8],
    env: &[(OsString, OsString)],
    dir: &Path,
    grep: Option<&Path>,
) -> Evaluation {
    let pii = Pii::from_env(env, grep.map(Path::to_path_buf), Some(PathBuf::from(GIT)));
    let probe = HostProbe {
        env,
        grep: pii.grep.as_deref(),
        git: pii.git.as_deref(),
        pwd: dir,
        ids: pii.ids.as_ref(),
        until: None,
    };
    evaluate(payload, &context(), &probe)
}

fn native(payload: &[u8], env: &[(OsString, OsString)], dir: &Path) -> Evaluation {
    native_with(payload, env, dir, Some(Path::new(GREP)))
}

fn code(verdict: Verdict) -> i32 {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Error => 1,
        Verdict::Block => 2,
    }
}

/// The rendered script run under bash in `dir` with exactly `env`: its status and stderr.
fn shell(
    payload: &[u8],
    env: &[(OsString, OsString)],
    dir: &Path,
) -> Result<(i32, Vec<u8>), Box<dyn Error>> {
    let mut child = Command::new("bash")
        .arg(script())
        .current_dir(dir)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or("stdin")?.write_all(payload)?;
    let output = child.wait_with_output()?;
    assert!(output.stdout.is_empty(), "the hook prints nothing");
    Ok((output.status.code().unwrap_or(-1), output.stderr))
}

fn web(tool: &str, key: &str, value: &str) -> Vec<u8> {
    json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {key: value}})
        .to_string()
        .into_bytes()
}

// Covers: R70
#[test]
fn reproduces_every_recorded_verdict_and_audit_label() -> TestResult {
    let corpus = fs::read_to_string(repo().join(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/pii-egress-guard.sh.jsonl",
    ))?;
    let mut seen = 0;
    for (index, line) in corpus.lines().enumerate() {
        let case: Value = serde_json::from_str(line)?;
        let temp = Temp::new()?;
        let input = case["input"]
            .as_str()
            .ok_or("input")?
            .replace("@CWD@", temp.0.to_str().unwrap_or_default());
        let mut env = environment(&[]);
        for (key, value) in case["envDelta"].as_object().ok_or("envDelta")? {
            env.push(os(key, value.as_str().ok_or("env value")?));
        }
        let actual = native(input.as_bytes(), &env, &temp.0);
        let label = format!("case {}", index + 1);
        let off = &case["expected"]["off"];
        assert_eq!(
            i64::from(code(actual.verdict)),
            off["status"].as_i64().ok_or("status")?,
            "{label}"
        );
        assert_eq!(
            String::from_utf8_lossy(&actual.stderr),
            off["stderr"].as_str().ok_or("stderr")?,
            "{label}"
        );
        assert!(actual.stdout.is_empty(), "{label}");
        let event = &case["expected"]["active"]["event"][0]["metadata"];
        let audit = actual.audit.as_ref().ok_or("audit")?;
        assert_eq!(Some(audit.verdict), event["verdict"].as_str(), "{label}");
        // The core audit keeps a reason only when it is in its allowlist; the rest is
        // `unspecified`.
        let recorded = event["reason"].as_str().ok_or("reason")?;
        assert!(
            recorded == audit.reason || recorded == "unspecified",
            "{label}"
        );
        seen += 1;
    }
    assert_eq!(seen, 6, "the corpus changed");
    Ok(())
}

/// One edge case: a payload, an optional `NAVORI_PERSONAL_IDS` and whether it must block.
struct Edge {
    payload: Vec<u8>,
    ids: &'static str,
    blocks: bool,
}

fn edge(payload: Vec<u8>, ids: &'static str, blocks: bool) -> Edge {
    Edge {
        payload,
        ids,
        blocks,
    }
}

fn edges() -> Vec<Edge> {
    vec![
        // The gate reads the raw bytes: `"WebFetch"` inside another field passes it, and the
        // tool is then not a web one: allow (not skip).
        edge(
            json!({"tool_name": "Read", "tool_input": {"file_path": ID, "note": "WebFetch"}})
                .to_string()
                .into_bytes(),
            ID,
            false,
        ),
        // A `\u`-escaped tool name misses the gate in both lanes: skip.
        edge(
            br#"{"tool_name":"\u0057ebSearch","tool_input":{"query":"dev@example.test"}}"#.to_vec(),
            ID,
            false,
        ),
        edge(web("WebFetch", "url", ""), ID, false),
        edge(web("WebSearch", "query", ""), ID, false),
        edge(web("WebFetch", "url", "http://127.0.0.1/?u=dev@example.test"), ID, false),
        edge(web("WebFetch", "url", "http://172.16.0.9/?u=dev@example.test"), ID, false),
        edge(web("WebFetch", "url", "http://172.32.0.9/?u=dev@example.test"), ID, true),
        edge(web("WebFetch", "url", "http://[::1]:8080/?u=dev@example.test"), ID, false),
        edge(web("WebFetch", "url", "http://localhost:3000/dev@example.test"), ID, false),
        // `_pii_local` is case-sensitive: `LOCALHOST` is external.
        edge(web("WebFetch", "url", "http://LOCALHOST/?u=dev@example.test"), ID, true),
        // Userinfo is not the host; a `@` in a query is not userinfo.
        edge(web("WebFetch", "url", "http://localhost@example.com/dev@example.test"), ID, true),
        edge(web("WebFetch", "url", "http://localhost/?u=a@b.test&x=dev@example.test"), ID, false),
        // No scheme: the whole text is the authority.
        edge(web("WebFetch", "url", "example.com/?u=dev@example.test"), ID, true),
        edge(web("WebFetch", "url", "localhost/dev@example.test"), ID, false),
        // Encodings and case.
        edge(web("WebFetch", "url", "https://example.com/?u=dev%40example.test"), ID, true),
        edge(web("WebFetch", "url", "https://example.com/?u=DEV@EXAMPLE.TEST"), ID, true),
        edge(web("WebSearch", "query", "a%2Bb%40example.test"), "a+b@example.test", true),
        edge(web("WebSearch", "query", "a+b@example.test"), "a+b@example.test", true),
        edge(web("WebSearch", "query", "john%20smith john+smith"), "john smith", true),
        edge(web("WebSearch", "query", "john smith"), "john smith", true),
        edge(web("WebSearch", "query", "navori hooks"), ID, false),
        // An identifier under four characters is ignored; entries are trimmed and comma-split.
        edge(web("WebSearch", "query", "abc"), "abc", false),
        edge(web("WebSearch", "query", "x dev@example.test y"), " ab ,  dev@example.test ", true),
        // Only the URL of a `WebFetch` and only the query of a `WebSearch` are inspected.
        edge(
            json!({"tool_name": "WebFetch", "tool_input": {"url": "https://example.com", "prompt": ID, "query": ID}})
                .to_string()
                .into_bytes(),
            ID,
            false,
        ),
        edge(
            json!({"tool_name": "WebSearch", "tool_input": {"query": "x", "url": ID}})
                .to_string()
                .into_bytes(),
            ID,
            false,
        ),
        // Malformed JSON past the gate: both lanes decide the same.
        edge(br#"{"tool_name":"WebSearch","tool_input":"#.to_vec(), ID, false),
        edge(web("WebSearch", "query", "dev@example.test").into_iter().chain(*b"\n\n").collect(), ID, true),
    ]
}

// Covers: R70
#[test]
fn matches_the_real_script_on_the_edge_cases() -> TestResult {
    for (index, case) in edges().iter().enumerate() {
        let temp = Temp::new()?;
        let env = environment(&[("NAVORI_PERSONAL_IDS", case.ids)]);
        let label = format!("edge {}", index + 1);
        let (status, shell_stderr) = shell(&case.payload, &env, &temp.0)?;
        let actual = native(&case.payload, &env, &temp.0);
        assert_eq!(code(actual.verdict), status, "{label}");
        assert_eq!(actual.stderr, shell_stderr, "{label}");
        // Malformed JSON is only compared: the extraction fallback decides it.
        if serde_json::from_slice::<Value>(&case.payload).is_ok() {
            assert_eq!(status == 2, case.blocks, "{label}");
        }
        for secret in [ID, "a+b@example.test", "john smith"] {
            assert!(!contains(&actual.stderr, secret.as_bytes()), "{label}");
        }
    }
    Ok(())
}

// Covers: R70
#[test]
fn skips_and_allows_are_told_apart_by_the_audit_label() -> TestResult {
    let temp = Temp::new()?;
    let env = environment(&[("NAVORI_PERSONAL_IDS", ID)]);
    let label = |payload: &[u8]| -> Option<(&'static str, String)> {
        native(payload, &env, &temp.0)
            .audit
            .map(|audit| (audit.verdict, audit.reason))
    };
    let read = json!({"tool_name": "Read", "tool_input": {"file_path": "x"}}).to_string();
    assert_eq!(
        label(read.as_bytes()),
        Some(("skip", "no network gate".to_owned()))
    );
    let inside = json!({"tool_name": "Read", "tool_input": {"note": "WebFetch"}}).to_string();
    assert_eq!(
        label(inside.as_bytes()),
        Some(("allow", "no identifier in an external request".to_owned()))
    );
    assert_eq!(
        label(&web("WebSearch", "query", ID)),
        Some(("block", "pii-egress".to_owned()))
    );
    Ok(())
}

// Covers: R70
#[test]
fn a_hit_on_the_configured_email_is_code_41() -> TestResult {
    let temp = Temp::new()?;
    let git = |args: &[&str]| -> TestResult {
        let status = Command::new(GIT)
            .args(args)
            .current_dir(&temp.0)
            .env_clear()
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .stdout(Stdio::null())
            .status()?;
        assert!(status.success());
        Ok(())
    };
    git(&["init", "-q", "."])?;
    git(&["config", "user.email", "me.fixture@example.test"])?;
    let env = environment(&[]);
    let payload = web(
        "WebFetch",
        "url",
        "https://example.com/?e=me.fixture%40example.test",
    );
    let (status, shell_stderr) = shell(&payload, &env, &temp.0)?;
    let actual = native(&payload, &env, &temp.0);
    assert_eq!(status, 2);
    assert_eq!(code(actual.verdict), 2);
    assert_eq!(actual.stderr, shell_stderr);
    assert_eq!(actual.stderr, pii_stderr(Code::GitEmail).as_bytes());
    assert!(!contains(&actual.stderr, b"me.fixture"));
    let clean = web("WebFetch", "url", "https://example.com/");
    assert_eq!(code(native(&clean, &env, &temp.0).verdict), 0);
    assert_eq!(shell(&clean, &env, &temp.0)?.0, 0);
    Ok(())
}

// Covers: R70
#[test]
fn what_cannot_be_verified_is_denied_without_echo() -> TestResult {
    let temp = Temp::new()?;
    let env = environment(&[("NAVORI_PERSONAL_IDS", ID)]);
    let unverified = pii_stderr(Code::Unverified).as_bytes();
    let url = "https://example.com/?secret-path=dev@example.test";
    // No grep to ask.
    let missing = native_with(&web("WebFetch", "url", url), &env, &temp.0, None);
    assert_eq!(code(missing.verdict), 2);
    assert_eq!(missing.stderr, unverified);
    // A grep that cannot be launched.
    let broken = native_with(
        &web("WebFetch", "url", url),
        &env,
        &temp.0,
        Some(Path::new("/nonexistent/grep")),
    );
    assert_eq!(code(broken.verdict), 2);
    // The sed extraction lane reads raw bytes: a URL that is not valid UTF-8 cannot be handed
    // to the rule whole, so it is denied (the documented fail-closed divergence).
    let mut raw =
        br#"{"tool_name":"WebFetch","tool_input":{"url":"https://example.com/secret-path?q="#
            .to_vec();
    raw.extend_from_slice(b"\xff\xfe");
    raw.extend_from_slice(br#""}}"#);
    let mut sed = context();
    sed.profile.extractor = Extractor::Sed;
    let probe = HostProbe {
        env: &env,
        grep: Some(Path::new(GREP)),
        git: None,
        pwd: &temp.0,
        ids: None,
        until: None,
    };
    let denied = evaluate(&raw, &sed, &probe);
    assert_eq!(code(denied.verdict), 2);
    assert_eq!(denied.stderr, unverified);
    assert!(!contains(&denied.stderr, b"secret-path"));
    assert_eq!(
        denied.audit.as_ref().map(|audit| audit.reason.as_str()),
        Some("pii-egress")
    );
    Ok(())
}

// Covers: R70
#[test]
fn invalid_utf8_and_nul_decide_as_the_script_does() -> TestResult {
    let temp = Temp::new()?;
    let env = environment(&[("NAVORI_PERSONAL_IDS", ID)]);
    let mut invalid =
        br#"{"tool_name":"WebSearch","tool_input":{"query":"dev@example.test "#.to_vec();
    invalid.extend_from_slice(b"\xff\xfe");
    invalid.extend_from_slice(br#""}}"#);
    let payloads = [
        (invalid, true),
        (
            br#"{"tool_name":"WebSearch","tool_input":{"query":"dev@example.test\u0000x"}}"#
                .to_vec(),
            true,
        ),
        (
            b"{\"tool_name\":\"WebSearch\",\"tool_input\":{\"query\":\"dev@example.test\0x\"}}"
                .to_vec(),
            true,
        ),
        (
            b"{\"tool_name\":\"WebSearch\",\"tool_input\":{\"query\":\"q\0\"}}".to_vec(),
            false,
        ),
    ];
    for (index, (payload, blocks)) in payloads.iter().enumerate() {
        let (status, _) = shell(payload, &env, &temp.0)?;
        let actual = native(payload, &env, &temp.0);
        // The NUL warning names the script and a line of it: only the verdict is compared.
        assert_eq!(code(actual.verdict), status, "payload {index}");
        assert_eq!(status == 2, *blocks, "payload {index}");
        assert!(!contains(&actual.stderr, ID.as_bytes()), "payload {index}");
    }
    Ok(())
}

/// A probe that panics with a message holding the identifier and the URL.
struct Panicking(String);

impl Probe for Panicking {
    fn ids(&self) -> Option<&Secret> {
        panic!("{}", self.0)
    }

    fn email(&self) -> EmailRead {
        panic!("{}", self.0)
    }

    fn matcher(&self) -> Box<dyn Matcher + '_> {
        panic!("{}", self.0)
    }
}

const CHILD: &str = "NAVORI_PII_WEB_PANIC_CHILD";
const CHILD_TEST: &str = "a_panic_never_reaches_stderr";

/// Run this very test binary again on `CHILD_TEST` and return its stderr.
fn child_stderr(mode: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    let output = Command::new(std::env::current_exe()?)
        .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD, mode)
        .output()?;
    assert!(output.status.success(), "the child run failed");
    Ok(output.stderr)
}

// Covers: R70
#[test]
fn a_panic_never_reaches_stderr() -> TestResult {
    let message = format!("boom {ID} https://example.com/?q=secret-path");
    match std::env::var(CHILD).as_deref() {
        Ok("hook") => {
            let probe = Panicking(message);
            let payload = web("WebFetch", "url", "https://example.com/?q=secret-path");
            let done = evaluate(&payload, &context(), &probe);
            assert_eq!(code(done.verdict), 2);
            assert_eq!(done.stderr, pii_stderr(Code::Unverified).as_bytes());
            assert_eq!(
                done.audit.as_ref().map(|audit| audit.reason.as_str()),
                Some("pii-egress")
            );
            // The default hook is back afterwards: a later panic is reported as usual.
            let _ = panic::catch_unwind(AssertUnwindSafe(|| panic!("restored-hook-marker")));
        }
        Ok("control") => {
            // Without the guard the default hook prints the message: the check below can fail.
            let _ = panic::catch_unwind(AssertUnwindSafe(|| panic!("{message}")));
        }
        _ => {
            let silent = child_stderr("hook")?;
            assert!(!contains(&silent, ID.as_bytes()), "the identifier leaked");
            assert!(!contains(&silent, b"secret-path"), "the url leaked");
            assert!(!contains(&silent, b"boom"), "a panic message leaked");
            assert!(
                contains(&silent, b"restored-hook-marker"),
                "hook not restored"
            );
            let control = child_stderr("control")?;
            assert!(
                contains(&control, ID.as_bytes()),
                "the control prints nothing"
            );
        }
    }
    Ok(())
}
