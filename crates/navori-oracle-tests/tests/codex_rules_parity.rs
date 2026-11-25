//! `navori_core::render::codex_rules` against the real `build-rules.ts` and
//! `permission-rules.ts` (spec 0059 T19, D37): generated `ask`/`deny` lists must translate, drop,
//! narrow and serialize exactly as in the TS CLI.

mod support;

use navori_core::js_json::JsValue;
use navori_core::render::codex_rules::{
    Decision, DropReason, build_codex_rules, translate_shell_pattern,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const r = await import({:?}); const p = await import({:?});",
        cli_module("engines/codex/build-rules.ts"),
        cli_module("engines/shared/permission-rules.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return { translated: request.ask.map((x) => p.translateShellPattern(x)), \
     rules: r.buildCodexRules({ allow: [], ask: request.ask, deny: request.deny }) };",
);

/// Pieces that reach every branch: the `Bash(` frame, trailing ` *`/`:*`, glued and inner
/// wildcards, JS whitespace (also non-ASCII and line terminators) and plain tokens.
fn piece() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => "[a-z-]{1,6}",
        2 => Just(" ".to_owned()),
        1 => prop_oneof![
            Just("*"), Just(" *"), Just(":*"), Just("?"), Just("["), Just("/"), Just("--force"),
        ].prop_map(str::to_owned),
        1 => prop_oneof![
            Just("\t"), Just("\u{a0}"), Just("\u{3000}"), Just("\n"), Just("\u{2028}"), Just("\u{feff}"),
        ].prop_map(str::to_owned),
        1 => prop_oneof![Just("é"), Just("𝒳"), Just(")"), Just("(")].prop_map(str::to_owned),
    ]
}

fn pattern() -> impl Strategy<Value = String> {
    let inner = || prop::collection::vec(piece(), 0..7).prop_map(|p| p.concat());
    prop_oneof![
        6 => inner().prop_map(|i| format!("Bash({i})")),
        1 => inner().prop_map(|i| format!("Agent({i})")),
        1 => inner(),
    ]
}

fn decision(d: Decision) -> &'static str {
    match d {
        Decision::Prompt => "prompt",
        Decision::Forbidden => "forbidden",
    }
}

fn strings(items: &[String]) -> Vec<JsValue> {
    items.iter().map(|s| JsValue::string(s)).collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    // Covers: R62, R66
    #[test]
    fn codex_rules_match_build_rules_ts(
        ask in prop::collection::vec(pattern(), 0..5),
        deny in prop::collection::vec(pattern(), 0..5),
    ) {
        let reply = NODE.ask(&json!({ "ask": ask, "deny": deny })).map_err(TestCaseError::fail)?;
        for (index, item) in ask.iter().enumerate() {
            let rust = translate_shell_pattern(item)
                .map(|t| json!({ "tokens": t.tokens, "narrowed": t.narrowed }))
                .unwrap_or(Value::Null);
            prop_assert_eq!(&reply["translated"][index], &rust, "{:?}", item);
        }
        let rules = build_codex_rules(&strings(&ask), &strings(&deny)).ok_or_else(|| TestCaseError::fail("delegated"))?;
        let dropped: Vec<Value> = rules.dropped.iter().map(|(pattern, reason)| json!({
            "pattern": pattern,
            "reason": match reason { DropReason::NotBash => "not-bash", DropReason::InnerWildcard => "inner-wildcard" },
        })).collect();
        let narrowed: Vec<Value> = rules.narrowed.iter()
            .map(|(pattern, d)| json!({ "pattern": pattern, "decision": decision(*d) }))
            .collect();
        prop_assert_eq!(&reply["rules"]["body"], &json!(rules.body));
        prop_assert_eq!(&reply["rules"]["dropped"], &json!(dropped));
        prop_assert_eq!(&reply["rules"]["narrowed"], &json!(narrowed));
    }
}
