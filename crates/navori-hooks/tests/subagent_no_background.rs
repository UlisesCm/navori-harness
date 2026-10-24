//! Pure policy parity only. These tests do not prove auditing, CLI registration or shadow mode.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use navori_hooks::hooks::subagent_no_background::{
    CaptureContext, Extractor, Locale, Profile, ShellDialect, evaluate, evaluate_with_capture,
};
use navori_hooks::runner::{Engine, Verdict};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        let path = std::env::temp_dir().join(format!(
            "navori-background-{}-{}",
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

fn payload(command: &str) -> Vec<u8> {
    json!({"agent_id":"child","tool_name":"Bash","tool_input":{"command":command}})
        .to_string()
        .into_bytes()
}

fn code(verdict: Verdict) -> u8 {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Error => 1,
        Verdict::Block => 2,
    }
}

/// The live oracle uses the host's system sed/grep, not a cross-platform UTF-8 approximation.
fn host_utf8_locale() -> Locale {
    if cfg!(target_os = "linux") {
        Locale::GnuUtf8
    } else {
        Locale::Utf8
    }
}

fn host_profile() -> Profile {
    Profile {
        extractor: Extractor::JqAndNode,
        locale: host_utf8_locale(),
    }
}

/// Identify the actual oracle binary; unsupported diagnostic dialects fail instead of guessing.
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

struct ShellOracle {
    output: std::process::Output,
    script: PathBuf,
    input_line: usize,
    fallback_line: usize,
    shell: ShellDialect,
    _temp: Temp,
}

/// Expand the real include partials into a scratch shell oracle, without Node/Bun or signatures.
fn shell_source() -> Result<String, Box<dyn Error>> {
    let hooks = repo().join("packages/core/core-assets/hooks");
    let source = fs::read_to_string(hooks.join("subagent-no-background.sh"))?;
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

/// Capture the real, audit-disabled shell oracle without relaxing any observable output.
fn shell_oracle(bytes: &[u8], profile: Profile) -> Result<ShellOracle, Box<dyn Error>> {
    let temp = Temp::new()?;
    let script = temp.0.join("subagent-no-background.sh");
    let source = shell_source()?;
    let input_line = source
        .lines()
        .position(|line| line == "payload=${payload-$(cat)}")
        .ok_or("initial capture not found in expanded oracle")?
        + 1;
    let fallback_line = source
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("printf -v") && line.contains("$(payload_field"))
        .map(|(index, _)| index + 1)
        .last()
        .ok_or("individual fallback not found in expanded oracle")?;
    let shell = bash_dialect()?;
    fs::write(&script, source)?;
    let mut command = Command::new("/bin/bash");
    command
        .arg(&script)
        .env("NAVORI_AUDITS_ROOT", temp.0.join("audit-off"));
    command.env(
        "LC_ALL",
        match profile.locale {
            Locale::Utf8 | Locale::GnuUtf8 => "en_US.UTF-8",
            Locale::C => "C",
        },
    );
    if !matches!(profile.extractor, Extractor::JqAndNode) {
        let bin = temp.0.join("bin");
        fs::create_dir(&bin)?;
        let mut tools = vec!["sed", "grep", "tr", "cat"];
        match profile.extractor {
            Extractor::JqOnly => tools.push("jq"),
            Extractor::Node => tools.push("node"),
            _ => {}
        }
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
        command.env("PATH", bin);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or("stdin")?.write_all(bytes)?;
    Ok(ShellOracle {
        output: child.wait_with_output()?,
        script,
        input_line,
        fallback_line,
        shell,
        _temp: temp,
    })
}

fn shell_output(bytes: &[u8], profile: Profile) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(shell_oracle(bytes, profile)?.output)
}

/// Compare all observable policy fields with a real audit-disabled shell invocation.
fn compare_shell(bytes: &[u8], profile: Profile) -> TestResult {
    let oracle = shell_oracle(bytes, profile)?;
    let expected = &oracle.output;
    let actual = evaluate_with_capture(
        bytes,
        Engine::Claude,
        profile,
        CaptureContext {
            shell: oracle.shell,
            script: &oracle.script,
            input_line: oracle.input_line,
            fallback_line: oracle.fallback_line,
        },
    )?;
    assert_eq!(
        i32::from(code(actual.verdict)),
        expected.status.code().ok_or("shell signal")?,
        "profile {profile:?}, payload {}",
        String::from_utf8_lossy(bytes)
            .chars()
            .take(140)
            .collect::<String>()
    );
    assert_eq!(actual.stdout, expected.stdout);
    assert_eq!(
        actual.stderr,
        expected.stderr,
        "payload bytes {}",
        bytes.len()
    );
    Ok(())
}

// Covers: R11, R12
#[test]
fn consumed_depth_limit_is_an_explicit_failure_not_an_empty_permitted_command() -> TestResult {
    let command = format!(
        "{}\"{}\"{}",
        "[".repeat(130),
        "x".repeat(131_000),
        "]".repeat(130)
    );
    assert_eq!(command.len(), 131_262);
    let bytes =
        format!(r#"{{"agent_id":"x","tool_name":"Bash","tool_input":{{"command":{command}}}}}"#)
            .into_bytes();
    assert_eq!(bytes.len(), 131_323);
    let profile = Profile {
        extractor: Extractor::JqAndNode,
        locale: Locale::C,
    };
    let legacy = shell_output(&bytes, profile)?;
    assert_eq!(legacy.status.code(), Some(2));
    assert!(legacy.stdout.is_empty());
    assert!(String::from_utf8_lossy(&legacy.stderr).contains("131262 > 131072"));
    let failure = match evaluate(&bytes, Engine::Claude, profile) {
        Err(failure) => failure,
        Ok(output) => {
            return Err(format!(
                "consumed decoding error returned {:?} instead of explicit failure",
                output.verdict
            )
            .into());
        }
    };
    assert!(failure.0.contains("recursion limit exceeded"));
    // This is the supported safe failure route, not a claim of legacy verdict parity. A bounded
    // deep-value implementation is still needed before enabling a productive native handler.
    for engine in [Engine::Claude, Engine::Pi] {
        let response = navori_hooks::runner::run(
            navori_hooks::runner::Context {
                engine,
                hook: "subagent-no-background",
                gating: true,
            },
            &mut bytes.as_slice(),
            || Ok(true),
            |payload| evaluate(payload, engine, profile),
        );
        if engine == Engine::Claude {
            assert_eq!(response.code(), 0);
            assert_eq!(
                serde_json::from_slice::<Value>(response.stdout())?["hookSpecificOutput"]["permissionDecision"],
                "ask"
            );
        } else {
            assert_eq!(response.code(), 2);
            assert!(response.stdout().is_empty());
        }
    }
    Ok(())
}

// Covers: R11
#[test]
fn reproduces_all_232_claude_pi_policy_verdicts_without_claiming_audit_or_shadow() -> TestResult {
    let corpus = fs::read_to_string(repo().join(
        "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/subagent-no-background.sh.jsonl",
    ))?;
    let mut counts = [0, 0, 0, 0];
    for (index, line) in corpus.lines().enumerate() {
        let case: Value = serde_json::from_str(line)?;
        let engine = match case["engine"].as_str() {
            Some("claude") => {
                counts[0] += 1;
                Engine::Claude
            }
            Some("pi") => {
                counts[1] += 1;
                Engine::Pi
            }
            _ => return Err("unexpected corpus engine".into()),
        };
        match case["shell"].as_str() {
            Some("bash") => counts[2] += 1,
            Some("zsh") => counts[3] += 1,
            _ => return Err("unexpected corpus shell".into()),
        }
        let actual = evaluate(
            case["input"].as_str().ok_or("input")?.as_bytes(),
            engine,
            Profile::default(),
        )?;
        let expected = &case["expected"]["off"];
        assert_eq!(
            u64::from(code(actual.verdict)),
            expected["status"].as_u64().ok_or("status")?,
            "case {}",
            index + 1
        );
        assert_eq!(
            actual.stdout,
            expected["stdout"].as_str().ok_or("stdout")?.as_bytes(),
            "case {}",
            index + 1
        );
        assert_eq!(
            actual.stderr,
            expected["stderr"].as_str().ok_or("stderr")?.as_bytes(),
            "case {}",
            index + 1
        );
    }
    assert_eq!(counts, [156, 76, 116, 116]);
    Ok(())
}

// Covers: R11, R12
#[test]
fn malformed_non_utf8_raw_presence_and_null_bytes_follow_extraction_profiles() -> TestResult {
    let cases: Vec<Vec<u8>> = vec![
        b"".to_vec(), b"{".to_vec(), b"\xff".to_vec(),
        br#"{"agent_id":null,"tool_name":"Monitor"}"#.to_vec(),
        br#"{"text":"agent_id","tool_name":"Monitor"}"#.to_vec(),
        br#"{"agent_id":"","tool_name":"Bash","tool_input":{"command":"sleep &","run_in_background":false}}"#.to_vec(),
        br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"sleep \u0000&","run_in_background":true}}"#.to_vec(),
        br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"sleep &"}"#.to_vec(),
        b"{\"agent_id\":\"x\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo \xff &\"}}".to_vec(),
    ];
    for extractor in [
        Extractor::JqAndNode,
        Extractor::JqOnly,
        Extractor::Node,
        Extractor::Sed,
    ] {
        for bytes in &cases {
            compare_shell(
                bytes,
                Profile {
                    extractor,
                    locale: Locale::C,
                },
            )?;
        }
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn unknown_and_consumed_surrogates_and_large_numbers_preserve_each_extractor() -> TestResult {
    let mut cases = vec![
        r#"{"agent_id":"x","tool_name":"Monitor","unused":"\ud800"}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Monitor","unused":1e400}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Monitor","tool_input":{"command":1e400}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"sleep \ud800 &"}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"sleep \udc00 &"}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"echo \ud83d\ude80 &"}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"echo \\ud800 &"}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":1e400}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":-1e400,"run_in_background":"\u0000"}}"#.to_owned(),
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":["sleep &"],"run_in_background":"\u0000"}}"#.to_owned(),
    ];
    // jq retains a decimal exponent; Node JSON.stringify turns Infinity into null. Their widths
    // differ at CMD_MAX and must not hide either extractor's policy outcome.
    cases.push(format!(r#"{{"agent_id":"x","tool_name":"Bash","tool_input":{{"command":{{"n":1e400,"s":"{}"}}}}}}"#, "x".repeat(131_054)));
    for extractor in [
        Extractor::JqAndNode,
        Extractor::JqOnly,
        Extractor::Node,
        Extractor::Sed,
    ] {
        for bytes in &cases {
            compare_shell(
                bytes.as_bytes(),
                Profile {
                    extractor,
                    locale: Locale::C,
                },
            )?;
        }
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn gnu_bsd_and_c_space_classes_remain_explicit_in_extraction_and_policy() -> TestResult {
    let c_profile = Profile {
        extractor: Extractor::JqAndNode,
        locale: Locale::C,
    };
    // POSIX C space has six members, including vertical tab (unlike is_ascii_whitespace).
    for space in ['\t', '\n', '\u{000b}', '\u{000c}', '\r', ' '] {
        let command = payload(&format!("{space}nohup x"));
        assert_eq!(
            code(evaluate(&command, Engine::Claude, c_profile)?.verdict),
            2
        );
        compare_shell(&command, c_profile)?;
    }
    // A vertical-tab-trimmed closing delimiter must expose the subsequent live command.
    let vertical_tab_heredoc = payload("cat <<'EOF'\ntext\n\u{000b}EOF\u{000b}\nnohup x");
    assert_eq!(
        code(evaluate(&vertical_tab_heredoc, Engine::Claude, c_profile)?.verdict),
        2
    );
    compare_shell(&vertical_tab_heredoc, c_profile)?;
    // glibc-2.41 localedata/locales/i18n_ctype:520–522 excludes four Unicode
    // White_Space characters. BSD excludes NEL too, but includes the other three.
    for (space, bsd_space, gnu_space) in [
        ('\u{0085}', false, false),
        ('\u{00a0}', true, false),
        ('\u{2007}', true, false),
        ('\u{202f}', true, false),
        ('\u{2003}', true, true),
    ] {
        let raw = format!(r#"{{"agent_id":"x","tool_name":{space}"Monitor"}}"#);
        let command = payload(&format!("{space}nohup x"));
        for (locale, is_space) in [
            (Locale::Utf8, bsd_space),
            (Locale::GnuUtf8, gnu_space),
            (Locale::C, false),
        ] {
            for (bytes, extractor) in [
                (raw.as_bytes(), Extractor::JqOnly),
                (command.as_slice(), Extractor::JqAndNode),
            ] {
                let actual = evaluate(bytes, Engine::Claude, Profile { extractor, locale })?;
                assert_eq!(
                    code(actual.verdict),
                    if is_space { 2 } else { 0 },
                    "U+{:04X}, {locale:?}, {extractor:?}",
                    u32::from(space)
                );
                assert!(actual.stdout.is_empty());
                assert_eq!(actual.stderr.is_empty(), !is_space);
            }
        }
        compare_shell(
            raw.as_bytes(),
            Profile {
                extractor: Extractor::JqOnly,
                locale: host_utf8_locale(),
            },
        )?;
        compare_shell(&command, host_profile())?;
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn raw_fallback_whitespace_and_escaped_strings_preserve_locale_rules() -> TestResult {
    for text in [
        "{\"agent_id\":\"x\",\"tool_name\": \"Monitor\"}",
        "{\"agent_id\":\"x\",\"tool_name\": \"Monitor\"}",
        r#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"echo \"quoted\" &"}}"#,
    ] {
        for extractor in [
            Extractor::JqAndNode,
            Extractor::JqOnly,
            Extractor::Node,
            Extractor::Sed,
        ] {
            for locale in [Locale::C, host_utf8_locale()] {
                compare_shell(text.as_bytes(), Profile { extractor, locale })?;
            }
        }
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn complete_inert_and_prefix_frontier_matches_the_real_partial() -> TestResult {
    for command in [
        "sleep 1 &",
        "sleep 1 && echo done",
        "sleep 1 |& cat",
        "echo x 2>&1",
        "echo x &> out",
        "echo x \\&",
        "FOO=1 BAR=x sudo env nohup job",
        "time exec setsid job",
        "echo x; disown",
        "echo 'nohup x'",
        "echo \"a & b\"",
        "cat > notes.txt <<'EOF'\nnohup x &\nEOF",
        "cat > run.SH <<'EOF'\nnohup x &\nEOF",
        "cat <<EOF\n$(sleep 1 &)\nEOF",
        "cat <<'EOF'\n$(sleep 1 &)\nEOF",
        "cat <<\\EOF\nnohup x &\nEOF",
        "echo \"a \\\" << EOF\"\nnohup x",
        "cat < input <<'EOF'\nnohup x &\nEOF",
        "echo <<< 'nohup x &'",
        "cat <<'EOF'\nnohup x &\nEOF\nFOO=1 sudo -u user bash x",
        "git commit -m 'nohup x &'",
        "git commit -m \"it's $(sleep 1 &)\"",
        "echo << A\nx\n A ",
        "cat <<-EOF\n\tnohup x &\n\tEOF",
        "echo x\\\n && command nohup job",
        "\\nohup job",
        "(nohup job)",
    ] {
        compare_shell(&payload(command), host_profile())?;
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn original_work_limits_and_locale_character_counts_are_preserved() -> TestResult {
    for command in [
        "x".repeat(131_072),
        "x".repeat(131_073),
        "é".repeat(70_000),
        format!("echo <<\n{}", "x\n".repeat(4096)),
        "echo << nope\n".repeat(65),
        " nohup x".to_owned(),
        " nohup x".to_owned(),
        " nohup x".to_owned(),
    ] {
        for locale in [Locale::C, host_utf8_locale()] {
            compare_shell(
                &payload(&command),
                Profile {
                    extractor: Extractor::JqAndNode,
                    locale,
                },
            )?;
        }
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn sed_c_locale_counts_original_invalid_utf8_bytes_at_the_limit() -> TestResult {
    let mut bytes = br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":""#.to_vec();
    bytes.extend(std::iter::repeat_n(b'x', 131_071));
    bytes.push(0xff);
    bytes.extend_from_slice(br#""}}"#);
    compare_shell(
        &bytes,
        Profile {
            extractor: Extractor::Sed,
            locale: Locale::C,
        },
    )
}
