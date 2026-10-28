//! `navori_core::render::settings_file` against the real TS (spec 0058 T15): `mergeCoexistSettings`
//! over hand-written settings (foreign hooks and rules, a previous render's tracking, malformed
//! shapes, array-index keys) and `planStampedJson` over stamped files (an older, newer or missing
//! stamp, the registry floor, `force`, an unparseable side).

mod support;

use navori_core::STAMP_VERSION;
use navori_core::js_json::{self, JsValue};
use navori_core::render::settings_file::{StampedPlan, merge_coexist_settings, plan_stamped_json};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const co = await import({:?});\nconst own = await import({:?});",
        cli_module("engines/claude/coexist-settings.ts"),
        cli_module("lib/primitives/json-ownership.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'merge') {\n\
       const merged = co.mergeCoexistSettings(JSON.parse(request.existing), JSON.parse(request.navori));\n\
       return { json: JSON.stringify(merged, null, 2) + '\\n' };\n\
     }\n\
     const plan = own.planStampedJson(request.current, request.candidate, request.cli, request.floor ?? undefined, request.force);\n\
     return plan.kind === 'write' ? ['write', plan.content] : plan.kind === 'noop' ? ['noop'] : ['downgrade', plan.existingVersion];",
);

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

fn object(fields: Vec<BoxedStrategy<Option<String>>>) -> BoxedStrategy<String> {
    fields
        .prop_map(|fields| {
            format!(
                "{{{}}}",
                fields.into_iter().flatten().collect::<Vec<_>>().join(",")
            )
        })
        .boxed()
}

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

/// A hook object: navori's commands (`A`–`C`), a foreign one, odd shapes.
fn hook() -> BoxedStrategy<String> {
    pick(&[
        r#"{"type":"command","command":"A"}"#,
        r#"{"type":"command","command":"B","timeout":5}"#,
        r#"{"type":"command","command":"C"}"#,
        r#"{"type":"command","command":"mine"}"#,
        r#"{"type":"command","command":7}"#,
        r#"{"type":"command"}"#,
        r#""raw""#,
        "null",
    ])
}

fn bucket() -> BoxedStrategy<String> {
    (
        prop::option::of(pick(&[r#""Bash""#, r#""Edit|Write""#, "3"])),
        prop::option::weighted(0.85, prop::collection::vec(hook(), 0..3)),
    )
        .prop_map(|(matcher, hooks)| {
            let mut fields = Vec::new();
            if let Some(m) = matcher {
                fields.push(format!(r#""matcher":{m}"#));
            }
            fields.push(match hooks {
                Some(h) => format!(r#""hooks":[{}]"#, h.join(",")),
                None => r#""hooks":"x""#.to_owned(),
            });
            format!("{{{}}}", fields.join(","))
        })
        .boxed()
}

fn events(names: &'static [&'static str]) -> BoxedStrategy<String> {
    let entries = prop_oneof![
        8 => prop::collection::vec(prop_oneof![6 => bucket(), 1 => pick(&["1", r#""s""#])], 0..3)
            .prop_map(|b| format!("[{}]", b.join(","))),
        1 => pick(&[r#""str""#, "{}"]),
    ];
    prop::collection::vec((prop::sample::select(names.to_vec()), entries), 0..4)
        .prop_map(|events| {
            let body: Vec<String> = events
                .into_iter()
                .map(|(name, value)| format!("{}:{value}", json!(name)))
                .collect();
            format!("{{{}}}", body.join(","))
        })
        .boxed()
}

fn rules() -> BoxedStrategy<String> {
    prop_oneof![
        6 => prop::collection::vec(pick(&[r#""R1""#, r#""R2""#, r#""R3""#, r#""own""#, "4"]), 0..4)
            .prop_map(|r| format!("[{}]", r.join(","))),
        1 => pick(&[r#""R1""#, "{}"]),
    ]
    .boxed()
}

fn tracked() -> BoxedStrategy<String> {
    prop_oneof![
        5 => prop::collection::vec(pick(&[r#""A""#, r#""B""#, r#""C""#, r#""R1""#, r#""R2""#, r#""mine""#, "0"]), 0..4)
            .prop_map(|r| format!("[{}]", r.join(","))),
        1 => pick(&[r#""A""#, "null"]),
    ]
    .boxed()
}

/// A user-owned settings file, possibly carrying a previous render's tracking.
fn existing() -> BoxedStrategy<String> {
    object(vec![
        field("model", pick(&[r#""opus""#])),
        field(
            "hooks",
            prop_oneof![8 => events(&["PreToolUse", "Stop", "2", "SessionStart"]), 1 => pick(&["[]", r#""h""#])].boxed(),
        ),
        field(
            "permissions",
            prop_oneof![
                8 => object(vec![field("allow", rules()), field("deny", rules()), field("ask", rules())]),
                1 => pick(&["[]", "1"]),
            ]
            .boxed(),
        ),
        field(
            "$navori",
            prop_oneof![
                8 => object(vec![
                    field("managed", pick(&["false"])),
                    field("managedHooks", tracked()),
                    field("managedDeny", tracked()),
                    field("managedAsk", tracked()),
                    field("note", pick(&[r#""old""#])),
                ]),
                1 => pick(&["[]", r#""x""#]),
            ]
            .boxed(),
        ),
        field("env", pick(&[r#"{"A":"1"}"#])),
    ])
}

/// The settings `buildClaudeSettings` would hand to the merge.
fn navori() -> BoxedStrategy<String> {
    object(vec![
        field("$schema", pick(&[r#""s""#])),
        field("hooks", events(&["PreToolUse", "Stop", "1", "PostToolUse"])),
        field(
            "permissions",
            object(vec![
                field("allow", rules()),
                field("deny", rules()),
                field("ask", rules()),
            ]),
        ),
    ])
}

fn rust_merge(existing: &str, navori: &str) -> Option<String> {
    let (Some(JsValue::Object(existing)), Some(JsValue::Object(navori))) =
        (js_json::parse(existing), js_json::parse(navori))
    else {
        return None;
    };
    let merged = JsValue::Object(merge_coexist_settings(&existing, &navori));
    Some(format!("{}\n", merged.stringify(Some(2))?))
}

/// A stamped file: `$navori` first, then a body that may differ from the candidate's.
fn stamped(version: Option<&str>, body: &str, navori_extra: &str) -> String {
    let version = version.map_or_else(String::new, |v| format!(r#","version":{}"#, json!(v)));
    let text = format!(r#"{{"$navori":{{"managed":true{version}{navori_extra}}},{body}}}"#);
    js_json::parse(&text)
        .and_then(|v| v.stringify(Some(2)))
        .map_or(text, |pretty| format!("{pretty}\n"))
}

#[derive(Debug, Clone)]
struct StampCase {
    current: String,
    candidate: String,
    floor: Option<&'static str>,
    force: bool,
}

fn stamp_case() -> BoxedStrategy<StampCase> {
    let body = pick(&[r#""a":1"#, r#""a":2"#, r#""a":1,"b":[]"#]);
    let version = prop::sample::select(vec![
        None,
        Some(""),
        Some("0.1.0"),
        Some(STAMP_VERSION),
        Some("999.0.0"),
        Some("garbage"),
    ]);
    let shape = prop::sample::select(vec!["stamped", "same", "broken", "plain"]);
    (
        version,
        body.clone(),
        body,
        shape,
        prop::sample::select(vec!["", r#","x":1"#]),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(
            |(version, current_body, candidate_body, shape, extra, floor, force, bad_candidate)| {
                let candidate = if bad_candidate {
                    format!(r#"{{"$navori":"x",{candidate_body}}}"#)
                } else {
                    stamped(Some(STAMP_VERSION), &candidate_body, extra)
                };
                let current = match shape {
                    "same" => candidate.clone(),
                    "broken" => "{not json".to_owned(),
                    "plain" => format!("{{{current_body}}}\n"),
                    _ => stamped(version, &current_body, extra),
                };
                StampCase {
                    current,
                    candidate,
                    floor,
                    force,
                }
            },
        )
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    // Covers: R41
    #[test]
    fn coexist_merge_matches(existing in existing(), navori in navori()) {
        let ts = NODE
            .ask(&json!({ "op": "merge", "existing": existing, "navori": navori }))
            .map_err(TestCaseError::fail)?;
        let rust = rust_merge(&existing, &navori);
        let ts = ts.get("json").and_then(Value::as_str).map(str::to_owned);
        if ts != rust {
            let parse = |s: &Option<String>| s.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
            prop_assert!(false, "{}\nexisting {existing}\nnavori {navori}", first_difference(&parse(&ts), &parse(&rust)));
        }
    }

    // Covers: R37
    #[test]
    fn stamped_json_matches(case in stamp_case()) {
        let ts = NODE
            .ask(&json!({
                "op": "stamp",
                "current": case.current,
                "candidate": case.candidate,
                "cli": STAMP_VERSION,
                "floor": case.floor,
                "force": case.force,
            }))
            .map_err(TestCaseError::fail)?;
        let rust = match plan_stamped_json(&case.current, &case.candidate, case.floor, case.force) {
            StampedPlan::Noop => json!(["noop"]),
            StampedPlan::Write(content) => json!(["write", content]),
            StampedPlan::Downgrade(version) => json!(["downgrade", version]),
        };
        prop_assert!(ts == rust, "ts {ts}\nrust {rust}\n{case:?}");
    }
}
