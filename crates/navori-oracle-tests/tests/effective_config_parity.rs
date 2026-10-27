//! `navori_core::config::effective_config` against the real `effectiveConfig` (spec 0058 T14):
//! output text, key order (spread semantics) and an own `prTarget: undefined`.

mod support;

use navori_core::config::effective_config;
use navori_core::js_json::{self, JsObject, JsValue};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const c = await import({:?});",
        cli_module("lib/config/config.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const r = c.effectiveConfig(JSON.parse(request.text));\n\
     return [JSON.stringify(r), Object.keys(r), Object.keys(r.project), Object.keys(r.sdd), 'prTarget' in r && r.prTarget === undefined];",
);

fn keys(object: Option<&JsValue>) -> Vec<String> {
    match object {
        Some(JsValue::Object(object)) => object
            .ordered()
            .iter()
            .map(|(key, _)| String::from_utf16_lossy(key.units()))
            .collect(),
        _ => Vec::new(),
    }
}

fn rust_effective(text: &str) -> Result<Value, String> {
    let raw = js_json::parse(text).ok_or("generated config is not JSON")?;
    let out = effective_config(&raw);
    let JsValue::Object(object) = &out else {
        return Err("effective config is not an object".to_owned());
    };
    let undefined_target = matches!(object.get("prTarget"), Some(JsValue::Undefined));
    Ok(json!([
        out.stringify(None),
        keys(Some(&out)),
        keys(JsObject::get(object, "project")),
        keys(JsObject::get(object, "sdd")),
        undefined_target,
    ]))
}

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

/// `"key":value` when present; values are JSON text so key order survives.
fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

fn shuffled(fields: Vec<BoxedStrategy<Option<String>>>) -> BoxedStrategy<String> {
    fields
        .prop_map(|fields| fields.into_iter().flatten().collect::<Vec<_>>())
        .prop_shuffle()
        .prop_map(|fields| format!("{{{}}}", fields.join(",")))
        .boxed()
}

fn config() -> BoxedStrategy<String> {
    let scalar = || pick(&["null", r#""main""#, r#""""#, "1", "false"]);
    let project = prop_oneof![
        1 => pick(&["null", r#""ab""#, r#"["x"]"#, "7"]),
        4 => shuffled(vec![
            field(
                "codeLanguage",
                pick(&[
                    r#""python""#, r#""rust""#, r#""go""#, r#""typescript""#, r#""Rust""#,
                    "null", "1",
                ]),
            ),
            field("typedLanguage", pick(&["true", "false"])),
            field("1", pick(&[r#""one""#])),
            field("name", pick(&[r#""p""#])),
        ]),
    ];
    let list = || pick(&["null", "[]", r#"["a"]"#]);
    let sdd = prop_oneof![
        1 => pick(&["null", r#""on""#, "[1]"]),
        4 => shuffled(vec![
            field("enabled", pick(&["null", "false", "true", "0"])),
            field("specsDir", pick(&["null", r#""docs""#, r#""""#])),
            field("applyWhen", list()),
            field("doesNotApplyTo", list()),
            field("extra", pick(&["1"])),
            field("0", pick(&["2"])),
        ]),
    ];
    shuffled(vec![
        field("prTarget", scalar()),
        field("branchBase", scalar()),
        field("project", project.boxed()),
        field("sdd", sdd.boxed()),
        field("name", pick(&[r#""n""#])),
        field("5", pick(&["5"])),
    ])
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    // Covers: R41
    #[test]
    fn effective_config_matches(text in config()) {
        let ts = NODE
            .ask(&json!({ "text": text }))
            .map_err(TestCaseError::fail)?;
        let rust = rust_effective(&text).map_err(TestCaseError::fail)?;
        prop_assert_eq!(ts, rust, "{}", text);
    }
}
