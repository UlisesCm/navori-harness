//! `config::read` outcomes that hand the invocation back to the TS (spec 0058 T9, Q4). The exact
//! acceptance and output parity against zod lives in `navori-oracle-tests/tests/config_parity.rs`.

use navori_core::config::{self, Delegate};
use navori_core::js_json::JsValue;
use navori_core::render::context::Lang;

const MINIMAL: &str = r#"{"name":"my-repo","engines":["claude"],"preset":"node"}"#;

// Covers: R33
#[test]
fn every_config_the_ts_must_report_is_delegated() {
    let cases: [(&[u8], Delegate); 6] = [
        (b"{\"name\":\"a\xff\"}", Delegate::NotUtf8),
        (b"{\"name\":\"my-repo\",}", Delegate::Json),
        (b"", Delegate::Json),
        (
            br#"{"name":"my-repo","engines":["claude"],"preset":"node","harness":{"leader":true}}"#,
            Delegate::RetiredKeys,
        ),
        (
            br#"{"name":"My Repo","engines":["claude"],"preset":"node"}"#,
            Delegate::Schema,
        ),
        (
            br#"{"name":"my-repo","engines":[],"preset":"node"}"#,
            Delegate::Schema,
        ),
    ];
    for (bytes, expected) in cases {
        assert_eq!(
            config::read(bytes).err(),
            Some(expected),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
}

// Covers: R33
#[test]
fn text_the_rust_parser_does_not_model_is_delegated_not_guessed() {
    // JS accepts these; Rust declines them, which only costs a delegation.
    for text in [
        r#"{"name":"my-repo","engines":["claude"],"preset":"node","x":"\ud800"}"#,
        r#"{"name":"my-repo","engines":["claude"],"preset":"node","x":1e400}"#,
        r#"{"name":"my-repo","engines":["claude"],"preset":"node","__proto__":{}}"#,
    ] {
        assert_eq!(
            config::read(text.as_bytes()).err(),
            Some(Delegate::Json),
            "{text}"
        );
    }
}

// Covers: R32, R34
#[test]
fn a_leading_bom_is_ignored_and_defaults_are_filled() {
    let with_bom = format!("\u{feff}{MINIMAL}");
    let config = config::read(with_bom.as_bytes()).map_err(|e| format!("{e:?}"));
    let Ok(config) = config else {
        panic!("minimal config rejected: {config:?}");
    };
    assert_eq!(config.lang(), Lang::Es);
    assert_eq!(config.harness_version(), None);
    assert!(config.warnings.is_empty());
    let JsValue::Object(data) = &config.data else {
        panic!("config data is not an object");
    };
    assert_eq!(data.get("branchBase"), Some(&JsValue::string("main")));
    assert_eq!(
        data.get("commits"),
        Some(&JsValue::string("conventional-es"))
    );
}

fn with_claude_plugins(value: &str) -> String {
    format!(r#"{{"name":"my-repo","engines":["claude"],"preset":"node","claudePlugins":{value}}}"#)
}

// Covers: R33
#[test]
fn claude_plugins_accepts_ids_with_boolean_values_like_the_ts_schema() {
    for value in ["{}", r#"{"b@m":true,"a@m":false}"#, r#"{"x-y.z@mkt":true}"#] {
        assert!(
            config::read(with_claude_plugins(value).as_bytes()).is_ok(),
            "{value}"
        );
    }
}

// Covers: R33
#[test]
fn claude_plugins_rejects_bad_ids_and_non_boolean_values() {
    for value in [
        r#"{"noat":true}"#,
        r#"{"a@b@c":true}"#,
        r#"{"@m":true}"#,
        r#"{"p@":true}"#,
        r#"{"a b@m":true}"#,
        r#"{"a@m":"yes"}"#,
        r#"{"a@m":1}"#,
        r#"{"a@m":null}"#,
        "[]",
        r#""a@m""#,
        "null",
    ] {
        assert_eq!(
            config::read(with_claude_plugins(value).as_bytes()).err(),
            Some(Delegate::Schema),
            "{value}"
        );
    }
}

// Covers: R33
#[test]
fn claude_plugins_ids_follow_js_whitespace_not_unicode_whitespace() {
    // JS `\s` includes U+FEFF, U+00A0 and U+2028, but not U+0085 or U+180E.
    for value in [
        r#"{"a\ufeff@m":true}"#,
        r#"{"a\u00a0@m":true}"#,
        r#"{"a\u2028@m":true}"#,
        r#"{"a@m\u00a0":true}"#,
    ] {
        assert_eq!(
            config::read(with_claude_plugins(value).as_bytes()).err(),
            Some(Delegate::Schema),
            "{value}"
        );
    }
    for value in [r#"{"a\u0085@m":true}"#, r#"{"a\u180e@m":false}"#] {
        assert!(
            config::read(with_claude_plugins(value).as_bytes()).is_ok(),
            "{value}"
        );
    }
}
