//! Deterministic eligibility rejection before collection/input (0057 R11-R13).

use navori_hooks::hooks::subagent_no_background::prepare::{
    Facts, Limits, Output, Request, Tool, plan,
};
use navori_hooks::runner::Engine;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

const SOURCE:&[u8]=b"payload=${payload-$(cat)}\n    printf -v \"${_pf_spec%%=*}\" '%s' \"$(payload_field \"${_pf_spec#*=}\")\"\n";
fn request(env: &[(OsString, OsString)]) -> Request<'_> {
    Request {
        engine: Engine::Claude,
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
        b"# payload=${payload-$(cat)}\n".as_slice(),
    ] {
        let mut bad = request(&env);
        bad.source = source;
        assert!(plan(bad, Limits::default()).is_err());
    }
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
