//! Pure capture-diagnostic contracts, not productive handler registration or Bash5 host parity.

use std::error::Error;
use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use navori_hooks::hooks::subagent_no_background::{
    CaptureContext, Extractor, Locale, Profile, ShellDialect, evaluate, evaluate_with_capture,
};
use navori_hooks::runner::{Engine, Verdict};

type TestResult = Result<(), Box<dyn Error>>;
const RAW: &[u8] =
    b"/tmp/original hook.sh: line 17: warning: command substitution: ignored null byte in input\n";
const FIELD: &[u8] =
    b"/tmp/original hook.sh: line 31: warning: command substitution: ignored null byte in input\n";

/// Expected counts come from the supplied payload/extraction lane, never an oracle stderr copy.
fn compare(
    payload: &[u8],
    extractor: Extractor,
    raw: usize,
    fields: usize,
    verdict: Verdict,
) -> TestResult {
    let profile = Profile {
        extractor,
        locale: Locale::C,
    };
    let pure = evaluate(payload, Engine::Claude, profile)?;
    assert_eq!(pure.verdict, verdict);
    let mut expected = RAW.repeat(raw);
    expected.extend(FIELD.repeat(fields));
    expected.extend_from_slice(&pure.stderr);
    for engine in [Engine::Claude, Engine::Pi] {
        for shell in [ShellDialect::Bash3, ShellDialect::Bash5] {
            let context = CaptureContext {
                shell,
                script: Path::new("/tmp/original hook.sh"),
                input_line: 17,
                fallback_line: 31,
            };
            let actual = evaluate_with_capture(payload, engine, profile, context)?;
            assert_eq!(actual.verdict, pure.verdict);
            assert_eq!(actual.stdout, pure.stdout);
            assert_eq!(
                actual.stderr,
                if shell == ShellDialect::Bash5 {
                    &expected
                } else {
                    &pure.stderr
                }
                .as_slice()
            );
        }
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn raw_nuls_warn_once_before_the_agent_presence_gate_and_bash3_stays_silent() -> TestResult {
    compare(
        b"not-json\0\0\n\0",
        Extractor::JqAndNode,
        1,
        0,
        Verdict::Permit,
    )
}

// Covers: R11, R12
#[test]
fn decoded_command_and_background_nuls_keep_the_two_ci_policy_outcomes() -> TestResult {
    let command = br#"{"agent_id":"child","tool_name":"Bash","tool_input":{"command":"sleep \u0000&","run_in_background":true}}"#;
    let background = br#"{"agent_id":"child","tool_name":"Bash","tool_input":{"command":-1e400,"run_in_background":"\u0000"}}"#;
    for extractor in [Extractor::JqAndNode, Extractor::JqOnly, Extractor::Node] {
        compare(command, extractor, 0, 1, Verdict::Block)?;
        compare(background, extractor, 0, 1, Verdict::Permit)?;
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn each_individual_nul_output_warns_once_without_a_second_cached_read_warning() -> TestResult {
    let payload = br#"{"agent_id":"child","tool_name":"B\u0000ash","tool_input":{"command":"sleep\u0000\u0000 &","run_in_background":"tr\u0000ue"}}"#;
    for extractor in [Extractor::JqAndNode, Extractor::JqOnly, Extractor::Node] {
        compare(payload, extractor, 0, 3, Verdict::Block)?;
    }
    // The sed leaf lane cannot decode JSON escapes and never creates a new NUL.
    compare(payload, Extractor::Sed, 0, 0, Verdict::Permit)
}

// Covers: R11, R12
#[test]
fn raw_and_field_captures_have_distinct_lines_and_precede_policy_diagnostics() -> TestResult {
    let mut payload = vec![0, 0];
    payload.extend_from_slice(
        br#"{"agent_id":"child","tool_name":"Monitor","tool_input":{"command":"\u0000"}}"#,
    );
    compare(&payload, Extractor::JqAndNode, 1, 1, Verdict::Block)
}

// Covers: R11
#[test]
fn unconsumed_nul_escapes_and_safe_bulk_json_do_not_create_capture_warnings() -> TestResult {
    let unconsumed = br#"{"agent_id":"child\u0000","tool_name":"Bash","ignored":"\u0000","tool_input":{"command":"printf ok"}}"#;
    let encoded =
        br#"{"agent_id":"child","tool_name":"Bash","tool_input":{"command":["printf\u0000 ok"]}}"#;
    for extractor in [Extractor::JqAndNode, Extractor::JqOnly, Extractor::Node] {
        compare(unconsumed, extractor, 0, 0, Verdict::Permit)?;
        compare(encoded, extractor, 0, 0, Verdict::Permit)?;
    }
    // No extraction occurs at all without the agent_id presence marker.
    compare(
        br#"{"tool_name":"Bash","tool_input":{"command":"\u0000"}}"#,
        Extractor::Node,
        0,
        0,
        Verdict::Permit,
    )
}

// Covers: R11
#[test]
fn individual_node_array_coercion_is_counted_only_after_a_real_bulk_fallback() -> TestResult {
    let payload = br#"{"agent_id":"child","tool_name":"Bash","tool_input":{"command":["printf\u0000 ok"],"run_in_background":"\u0000"}}"#;
    compare(payload, Extractor::Node, 0, 2, Verdict::Permit)?;
    compare(payload, Extractor::JqAndNode, 0, 1, Verdict::Permit)?;
    compare(payload, Extractor::JqOnly, 0, 1, Verdict::Permit)
}

// Covers: R11
#[test]
fn diagnostic_script_prefix_preserves_non_utf8_unix_path_bytes() -> TestResult {
    let script = PathBuf::from(OsString::from_vec(b"/tmp/native-\xff.sh".to_vec()));
    let context = CaptureContext {
        shell: ShellDialect::Bash5,
        script: &script,
        input_line: 201,
        fallback_line: 202,
    };
    let output = evaluate_with_capture(b"\0", Engine::Claude, Profile::default(), context)?;
    assert_eq!(output.verdict, Verdict::Permit);
    assert_eq!(output.stderr, b"/tmp/native-\xff.sh: line 201: warning: command substitution: ignored null byte in input\n");
    Ok(())
}

// Covers: R12
#[test]
fn capture_context_never_turns_a_consumed_decoding_failure_into_permit() -> TestResult {
    let command = format!("{}0{}", "[".repeat(130), "]".repeat(130));
    let payload = format!(
        r#"{{"agent_id":"child","tool_name":"Bash","tool_input":{{"command":{command}}}}}"#
    );
    let context = CaptureContext {
        shell: ShellDialect::Bash5,
        script: Path::new("original.sh"),
        input_line: 17,
        fallback_line: 31,
    };
    let pure = evaluate(payload.as_bytes(), Engine::Claude, Profile::default());
    assert!(pure.is_err());
    assert_eq!(
        evaluate_with_capture(
            payload.as_bytes(),
            Engine::Claude,
            Profile::default(),
            context
        ),
        pure
    );
    Ok(())
}
