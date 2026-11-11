//! Deterministic eligibility rejection before collection/input (0057 R11-R13).

use navori_hooks::hooks::subagent_no_background::prepare::{
    Facts, Limits, Output, Request, Tool, plan,
};
use navori_hooks::runner::Engine;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

const SOURCE:&[u8]=b"payload=${payload-\"$(cat)\"}\n    printf -v \"${_pf_spec%%=*}\" '%s' \"$(payload_field \"${_pf_spec#*=}\")\"\n";
fn request(env: &[(OsString, OsString)]) -> Request<'_> {
    Request {
        engine: Engine::Claude,
        engines: &[Engine::Claude, Engine::Pi],
        event: Some("PreToolUse"),
        args: &[],
        script: Path::new("unopened.sh"),
        source: SOURCE,
        env,
    }
}
fn environment() -> Vec<(OsString, OsString)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("LC_ALL".into(), "C".into()),
    ]
}
fn output(bytes: &[u8]) -> Output {
    Output {
        code: Some(0),
        stdout: bytes.to_vec(),
        stderr: Vec::new(),
    }
}

const BASH3_MESSAGES: &[u8] = b"messages-probe: /dev/null/navori-probe: Not a directory\n";
const BASH5_MESSAGES: &[u8] = b"messages-probe: line 1: /dev/null/navori-probe: Not a directory\n";

fn failed(code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> Output {
    Output {
        code,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    }
}

fn bootstrap(version: &[u8]) -> Vec<u8> {
    let mut bytes = version.to_vec();
    bytes.push(0);
    for tool in Tool::ALL {
        bytes.extend_from_slice(format!("{}\00\0/bin/{}\0", tool.name(), tool.name()).as_bytes());
    }
    bytes
}

/// Facts that pass every check up to the messages one; the first failure after it is jq being
/// present but unaccredited.
fn message_facts(version: &[u8], messages: Output) -> Facts {
    Facts {
        bootstrap: output(&bootstrap(version)),
        system: output(b"Darwin\n"),
        charmap: output(b"US-ASCII\n"),
        text: output(b"not needed"),
        messages,
        jq: Some(output(b"jq-unknown\n")),
        node: Some(output(b"v24.22.0\n")),
    }
}

// Covers: R11, R13
#[test]
fn english_bash_diagnostics_are_eligible_per_dialect() -> Result<(), Box<dyn std::error::Error>> {
    let env = environment();
    let p = plan(request(&env), Limits::default())?;
    for (version, text) in [
        (b"3.2.57(1)-release".as_slice(), BASH3_MESSAGES),
        (b"5.3.0(1)-release".as_slice(), BASH5_MESSAGES),
    ] {
        assert!(
            p.prepare(&message_facts(version, failed(Some(1), text, b"")))
                .err()
                .is_some_and(|error| error.0.contains("jq is present but unaccredited")),
            "{version:?}"
        );
    }
    Ok(())
}

// Covers: R11, R13
#[test]
fn translated_or_foreign_dialect_diagnostics_defer_to_the_shell()
-> Result<(), Box<dyn std::error::Error>> {
    let env = environment();
    let p = plan(request(&env), Limits::default())?;
    let translated =
        "messages-probe: línea 1: /dev/null/navori-probe: No es un directorio\n".as_bytes();
    let cause = |version: &[u8], messages: Output| {
        p.prepare(&message_facts(version, messages))
            .err()
            .map(|error| error.0)
            .unwrap_or_default()
    };
    let bash5 = b"5.3.0(1)-release";
    let bash3 = b"3.2.57(1)-release";
    assert!(cause(bash5, failed(Some(1), translated, b"")).contains("translated"));
    // Each dialect's text is wrong for the other one.
    assert!(cause(bash5, failed(Some(1), BASH3_MESSAGES, b"")).contains("translated"));
    assert!(cause(bash3, failed(Some(1), BASH5_MESSAGES, b"")).contains("translated"));
    for broken in [
        failed(Some(0), BASH5_MESSAGES, b""),
        failed(None, BASH5_MESSAGES, b""),
        failed(Some(1), BASH5_MESSAGES, b"stray"),
        failed(Some(2), BASH5_MESSAGES, b""),
    ] {
        assert!(cause(bash5, broken).contains("messages probe failed"));
    }
    Ok(())
}

// Covers: R11, R13
#[test]
fn strict_utf8_locale_names_reach_the_probes_and_everything_else_is_unsupported() {
    let plans = |pairs: &[(&str, &str)]| {
        let mut env: Vec<(OsString, OsString)> = vec![("PATH".into(), "/bin".into())];
        env.extend(pairs.iter().map(|(k, v)| ((*k).into(), (*v).into())));
        plan(request(&env), Limits::default()).map(|_| ())
    };
    assert!(plans(&[("LANG", "es_ES.UTF-8"), ("LC_MESSAGES", "C")]).is_ok());
    for name in ["es_MX.utf8", "fil_PH.UTF-8", "pt.UTF-8", "de_DE.UTF-8"] {
        assert!(plans(&[("LANG", name)]).is_ok(), "{name}");
        assert!(plans(&[("LC_CTYPE", name)]).is_ok(), "{name}");
    }
    for name in [
        "es_ES",
        "es_ES.ISO-8859-1",
        "de_DE.UTF-8@euro",
        "ES_es.UTF-8",
        "x.UTF-8",
        "abcd_EF.UTF-8",
        "es_E.UTF-8",
        "es_ESP.UTF-8",
        "es_ES.UTF8",
        ".UTF-8",
    ] {
        assert!(
            plans(&[("LANG", name)])
                .err()
                .is_some_and(|error| error.0 == "unsupported locale"),
            "{name}"
        );
    }
    // LANGUAGE keeps the host ineligible, whatever the locale names say.
    assert!(plans(&[("LANG", "es_ES.UTF-8"), ("LANGUAGE", "es")]).is_err());
}

// Covers: R11, R13
#[test]
fn metadata_locale_and_budget_rejections_do_not_need_a_script_or_process() {
    let env = environment();
    assert!(plan(request(&env), Limits::default()).is_ok());
    let mut bad = request(&env);
    bad.engine = Engine::Codex;
    assert!(plan(bad, Limits::default()).is_err());
    for engine in [Engine::Claude, Engine::Pi] {
        for event in [None, Some("PreToolUse")] {
            let mut supported = request(&env);
            supported.engine = engine;
            supported.event = event;
            assert!(plan(supported, Limits::default()).is_ok());
        }
    }
    let args = [OsString::from("unexpected")];
    let mut bad = request(&env);
    bad.args = &args;
    assert!(plan(bad, Limits::default()).is_err());
    let mut bad = request(&env);
    bad.event = Some("Stop");
    assert!(plan(bad, Limits::default()).is_err());
    assert!(
        plan(
            request(&env),
            Limits {
                total: Duration::from_millis(501)
            }
        )
        .is_err()
    );
    let env = vec![
        ("PATH".into(), "/bin".into()),
        ("LC_ALL".into(), "unknown_LOCALE".into()),
    ];
    assert!(plan(request(&env), Limits::default()).is_err());
    // macOS Terminal's default (LANG=C.UTF-8, LC_CTYPE=UTF-8) reaches the probes.
    let env = vec![
        ("PATH".into(), "/bin".into()),
        ("LANG".into(), "C.UTF-8".into()),
        ("LC_CTYPE".into(), "UTF-8".into()),
    ];
    assert!(plan(request(&env), Limits::default()).is_ok());
}

// Covers: R13
#[test]
fn duplicate_environment_keys_are_rejected_before_collection() {
    for key in ["PATH", "LC_ALL", "LANG"] {
        let mut env = environment();
        if key == "LANG" {
            env.push(("LANG".into(), "C".into()));
        }
        env.push((key.into(), "C".into()));
        assert!(
            plan(request(&env), Limits::default())
                .err()
                .is_some_and(|error| error.0.contains("duplicate environment key"))
        );
    }
}

// Covers: R11, R13
#[test]
fn startup_functions_node_and_cached_payload_modifiers_are_rejected_before_probes() {
    for key in [
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "BASHOPTS",
        "NODE_OPTIONS",
        "BASH_FUNC_jq%%",
        "payload",
        "_nv_pf_loaded",
        "LD_PRELOAD",
        "IFS",
        "GREP_OPTIONS",
    ] {
        let mut env = environment();
        env.push((key.into(), "unexpected".into()));
        assert!(plan(request(&env), Limits::default()).is_err(), "{key}");
    }
    let mut env = environment();
    env.push(("jq".into(), "() { echo forged; }".into()));
    assert!(plan(request(&env), Limits::default()).is_err());
}

// Covers: R13
#[test]
fn capture_contracts_are_exact_unique_and_not_an_assumed_line_184() {
    let env = environment();
    for source in [
        b"missing".as_slice(),
        [SOURCE, SOURCE].concat().as_slice(),
        b"# payload=${payload-\"$(cat)\"}\n".as_slice(),
    ] {
        let mut bad = request(&env);
        bad.source = source;
        assert!(plan(bad, Limits::default()).is_err());
    }
}

// Covers: R11, R13
#[test]
fn only_the_exact_measured_jq_version_strings_are_accredited()
-> Result<(), Box<dyn std::error::Error>> {
    let env = environment();
    let p = plan(request(&env), Limits::default())?;
    let mut bootstrap = b"3.2.57(1)-release\0".to_vec();
    for tool in Tool::ALL {
        bootstrap
            .extend_from_slice(format!("{}\00\0/bin/{}\0", tool.name(), tool.name()).as_bytes());
    }
    let facts = |jq: &[u8]| Facts {
        bootstrap: output(&bootstrap),
        system: output(b"Darwin\n"),
        charmap: output(b"US-ASCII\n"),
        // A wrong text fact makes an accredited jq fail at the next check, after the jq one.
        text: output(b"not needed"),
        messages: failed(Some(1), BASH3_MESSAGES, b""),
        jq: Some(output(jq)),
        node: Some(output(b"v24.22.0\n")),
    };
    let unaccredited = |jq: &[u8]| {
        p.prepare(&facts(jq))
            .err()
            .is_some_and(|error| error.0.contains("jq is present but unaccredited"))
    };
    for accepted in [
        b"jq-1.7\n".as_slice(),
        b"jq-1.7.1\n".as_slice(),
        b"jq-1.7.1-apple\n".as_slice(),
        b"jq-1.8.1\n".as_slice(),
    ] {
        assert!(!unaccredited(accepted), "{accepted:?} must be accredited");
        assert!(
            p.prepare(&facts(accepted))
                .err()
                .is_some_and(|error| error.0.contains("legacy text behavior differs"))
        );
    }
    for rejected in [
        b"jq-1.6\n".as_slice(),
        b"jq-1.7.0\n".as_slice(),
        b"jq-1.8.0\n".as_slice(),
        b"jq-1.8.2\n".as_slice(),
        b"jq-1.9.0\n".as_slice(),
        b"jq-1.7.1-dirty\n".as_slice(),
        b"jq-1.8.1-4ubuntu2\n".as_slice(),
        b"jq-1.8.1".as_slice(),
        b"jq-1.8.1\n\n".as_slice(),
        b" jq-1.8.1\n".as_slice(),
    ] {
        assert!(
            unaccredited(rejected),
            "{rejected:?} must stay unaccredited"
        );
    }
    Ok(())
}

// Covers: R11, R13
#[test]
fn unknown_present_jq_and_lookup_errors_never_become_node_fallback()
-> Result<(), Box<dyn std::error::Error>> {
    let env = environment();
    let p = plan(request(&env), Limits::default())?;
    let mut bootstrap = b"3.2.57(1)-release\0".to_vec();
    for tool in Tool::ALL {
        bootstrap
            .extend_from_slice(format!("{}\00\0/bin/{}\0", tool.name(), tool.name()).as_bytes());
    }
    let mut facts = Facts {
        bootstrap: output(&bootstrap),
        system: output(b"Darwin\n"),
        charmap: output(b"US-ASCII\n"),
        text: output(b"not needed"),
        messages: failed(Some(1), BASH3_MESSAGES, b""),
        jq: Some(output(b"jq-unknown\n")),
        node: Some(output(b"v24.22.0\n")),
    };
    assert!(
        p.prepare(&facts)
            .err()
            .is_some_and(|error| error.0.contains("jq is present but unaccredited"))
    );
    facts.jq = Some(Output {
        code: Some(1),
        stdout: Vec::new(),
        stderr: b"failed".to_vec(),
    });
    assert!(
        p.prepare(&facts)
            .err()
            .is_some_and(|error| error.0.contains("probe failed"))
    );
    facts.jq = Some(output(b"jq-1.7\n"));
    for version in [
        b"v24.garbage\n".as_slice(),
        b"v26.0.0-nightly\n".as_slice(),
        b"v24.0.0\0\n".as_slice(),
        b"v22.0.0\n".as_slice(),
    ] {
        facts.node = Some(output(version));
        assert!(
            p.prepare(&facts)
                .err()
                .is_some_and(|error| error.0.contains("node is present but unaccredited"))
        );
    }
    let mut failed = b"5.2.0\0".to_vec();
    for tool in Tool::ALL {
        if tool == Tool::Jq {
            failed.extend_from_slice(b"jq\x00127\0\0");
        } else {
            failed.extend_from_slice(
                format!("{}\00\0/bin/{}\0", tool.name(), tool.name()).as_bytes(),
            );
        }
    }
    facts.bootstrap = output(&failed);
    assert!(
        p.prepare(&facts)
            .err()
            .is_some_and(|error| error.0.contains("discovery failed, not absent"))
    );
    Ok(())
}
