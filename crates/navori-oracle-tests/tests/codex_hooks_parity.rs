//! `navori_core::render::codex_hooks` against the real `hook-registrations.ts` and
//! `lib/codex/trust.ts` (spec 0059 T19, R66): the registered hooks, their command and the trust
//! hash Codex keys them by must match for generated configs and workspace subpaths.

mod support;

use navori_core::js_json::JsValue;
use navori_core::render::codex_hooks::{
    canonical_json, codex_hook_command, codex_hook_hash, resolve_codex_hooks,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const h = await import({:?}); const t = await import({:?});",
        cli_module("engines/codex/hook-registrations.ts"),
        cli_module("lib/codex/trust.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return h.resolveCodexHooks(request.config, []).map((hook) => { \
       const command = h.codexHookCommand(hook, request.ws); \
       return { hook, command, hash: t.codexHookHash(hook, command) }; });",
);

/// Values for a flag: JS truthy and falsy shapes, and absence.
fn flag() -> impl Strategy<Value = Option<Value>> {
    prop_oneof![
        3 => Just(None),
        2 => Just(Some(json!(true))),
        1 => Just(Some(json!(false))),
        1 => prop_oneof![
            Just(json!("x")), Just(json!("")), Just(json!(1)), Just(json!(0)), Just(json!("true")),
            Just(Value::Null),
        ].prop_map(Some),
    ]
}

fn section(entries: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v)))
            .collect(),
    )
}

fn config() -> impl Strategy<Value = Value> {
    (flag(), flag(), flag(), flag(), flag(), flag()).prop_map(
        |(fast, scribe, stop, master, tiers, codex)| {
            json!({
                "qualityGate": section(vec![("fast", fast)]),
                "harness": section(vec![
                    ("scribeOwnsMarkdown", scribe), ("masterPlan", master), ("planTiers", tiers),
                    ("codexIntegration", codex),
                ]),
                "hooks": section(vec![("verifyOnStop", stop)]),
            })
        },
    )
}

fn ws() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => Just(String::new()),
        2 => "[a-z]{1,5}(/[a-z]{1,5})?",
        1 => prop_oneof![Just("a b"), Just("$x"), Just("q\"t"), Just("b`t"), Just("w\\s"), Just("é")]
            .prop_map(str::to_owned),
    ]
}

fn js(value: &Value) -> Result<JsValue, TestCaseError> {
    navori_core::js_json::parse(&value.to_string()).ok_or_else(|| TestCaseError::fail("js_json"))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    // Covers: R62, R66
    #[test]
    fn codex_hooks_match_hook_registrations_ts(config in config(), ws in ws()) {
        let reply = NODE.ask(&json!({ "config": config, "ws": ws })).map_err(TestCaseError::fail)?;
        let hooks = resolve_codex_hooks(&js(&config)?, &[]).ok_or_else(|| TestCaseError::fail("delegated"))?;
        let rust: Vec<Value> = hooks.iter().map(|hook| {
            let command = codex_hook_command(hook, &ws);
            let mut shape = serde_json::Map::new();
            shape.insert("script".into(), json!(hook.script));
            shape.insert("event".into(), json!(hook.event));
            if let Some(m) = &hook.matcher { shape.insert("matcher".into(), json!(m)); }
            shape.insert("timeout".into(), json!(hook.timeout));
            if let Some(s) = &hook.status_message { shape.insert("statusMessage".into(), json!(s)); }
            if let Some(a) = &hook.args { shape.insert("args".into(), json!(a)); }
            json!({ "hook": Value::Object(shape), "hash": codex_hook_hash(hook, &command), "command": command })
        }).collect();
        prop_assert_eq!(reply, json!(rust));
    }

    // Covers: R66
    #[test]
    fn canonical_json_sorts_keys_by_code_unit(keys in prop::collection::vec("[a-zA-Z_é𝒳]{0,3}", 0..6)) {
        let object = Value::Object(keys.iter().enumerate().map(|(i, k)| (k.clone(), json!([i, {"z": 1, "a": null}]))).collect());
        let mut entries: Vec<(Vec<u16>, String)> = Vec::new();
        if let Value::Object(map) = &object {
            for (key, value) in map {
                entries.push((key.encode_utf16().collect(), format!("{}:{}", json!(key), canonical_inner(value))));
            }
        }
        entries.sort();
        let expected = format!("{{{}}}", entries.into_iter().map(|(_, e)| e).collect::<Vec<_>>().join(","));
        prop_assert_eq!(canonical_json(&js(&object)?), Some(expected));
    }
}

/// The two value shapes the key test nests, written canonically by hand.
fn canonical_inner(value: &Value) -> String {
    format!("[{},{{\"a\":null,\"z\":1}}]", value[0])
}
