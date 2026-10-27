//! `navori_core::render::interpolate` against the real `interpolate.ts` (spec 0058 T14): generated
//! templates over generated configs must render byte for byte alike.

mod support;

use std::collections::BTreeMap;

use navori_core::config;
use navori_core::render::interpolate::{InterpolateOptions, interpolate};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const i = await import({:?});",
        cli_module("lib/render/interpolate.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return i.interpolate(request.content, request.config, { extraVars: request.extra, omitUnresolvedKeyLines: request.omit });",
);

const PATHS: &[&str] = &[
    "name",
    "branchBase",
    "language",
    "preset",
    "prTarget",
    "constructor",
    "missing.path",
    "qualityGate.fast",
    "qualityGate.full",
    "qualityGate.scoped",
    "gateRun.fast",
    "gateRun.full",
    "gateRun.other",
    "project.legacyPaths",
    "project.legacyPaths.0",
    "project.legacyPaths.1",
    "project.legacyPaths.length",
    "project.legacyPaths.01",
    "project.criticalAreas",
    "project.custom",
    "project.posture",
    "project.libraryMigrations",
    "project.flag",
    "project.count",
    "harness.compactAdviceTokens",
    "harness.planTiers",
    "navori.scopedGate",
    "navori.progressGuardLane",
    "navori.nativeHooks",
    "navori.nonImplementerRoles",
    "navori.progressSoftCapBytes",
    "piPermissionRules",
    "navoriOwnedPaths",
    "extra.key",
    "a..b",
    "project.",
    "models",
    "engines",
    "engines.0",
    "sdd.enabled",
    "audit.mode",
];

fn placeholder() -> BoxedStrategy<String> {
    (
        prop::sample::select(vec!["", " ", "\t", "\u{feff}", "\u{85}"]),
        prop::sample::select(vec!["", "shq:", "raw:", "shq: ", "SHQ:"]),
        prop::sample::select(PATHS.to_vec()),
        prop::sample::select(vec!["", " ", "\u{a0}"]),
    )
        .prop_map(|(lead, marker, path, trail)| format!("{{{{{lead}{marker}{path}{trail}}}}}"))
        .boxed()
}

fn line() -> BoxedStrategy<String> {
    prop_oneof![
        3 => prop::collection::vec(
            prop_oneof![
                3 => placeholder(),
                2 => prop::sample::select(vec![
                    "text ", "'quoted' ", "style={{...}}", "{{ marginTop: 16 }}", "{{", "}}", "{",
                    "é😀", "<!-- x -->", "$(cmd)",
                ]).prop_map(str::to_owned),
            ],
            0..4,
        ).prop_map(|parts| parts.concat()),
        1 => (
            prop::sample::select(vec!["model", "effort", "_k", "9bad", "name"]),
            prop::sample::select(vec!["", " ", "\t"]),
            placeholder(),
            prop::sample::select(vec!["", " ", "\r", " x"]),
        ).prop_map(|(key, gap, ph, tail)| format!("{key}:{gap}{ph}{tail}")),
    ]
    .boxed()
}

fn template() -> BoxedStrategy<String> {
    prop::collection::vec(line(), 0..5)
        .prop_map(|lines| lines.join("\n"))
        .boxed()
}

fn config_json() -> BoxedStrategy<Value> {
    let gate = prop::sample::select(vec![
        None,
        Some("pnpm lint"),
        Some("pnpm lint && pnpm test"),
        Some("make check"),
        Some("  "),
    ]);
    let list = prop::sample::select(vec![
        json!([]),
        json!(["legacy/"]),
        json!(["", "auth", " "]),
        json!(["a<!--b-->", "line\nbreak\t x"]),
    ]);
    let custom = prop::sample::select(vec![
        json!(null),
        json!("  multi\r\nline  <!-- navori:managed -->  "),
        json!(""),
        json!(7.5),
        json!(true),
        json!(["x", 1, false]),
        json!([{"a": 1}]),
        json!({"nested": "x"}),
    ]);
    (
        gate.clone(),
        gate,
        any::<bool>(),
        list.clone(),
        list,
        custom,
        prop::option::of(prop::sample::select(vec![0.0, 175_000.0, 42.0])),
        prop::sample::select(vec!["es", "en"]),
        any::<bool>(),
    )
        .prop_map(
            |(fast, full, native, legacy, critical, custom, compact, language, scoped)| {
                let mut config = json!({
                    "name": "my-repo",
                    "engines": ["claude"],
                    "preset": "node",
                    "language": language,
                    "project": {
                        "legacyPaths": legacy,
                        "criticalAreas": critical,
                        "posture": "production\n- injected",
                        "flag": false,
                        "count": 0,
                        "libraryMigrations": [{"legacy": "a", "preferred": "b", "domain": "c"}],
                    },
                });
                if let Some(project) = config["project"].as_object_mut()
                    && !custom.is_null()
                {
                    project.insert("custom".into(), custom);
                }
                if let (Some(fast), Some(full)) = (fast, full) {
                    let mut gate = json!({ "fast": fast, "full": full });
                    if native {
                        gate["nativeHooks"] = json!(true);
                    }
                    if scoped {
                        gate["scoped"] = json!("pnpm test --changed");
                    }
                    config["qualityGate"] = gate;
                }
                if let Some(compact) = compact {
                    config["harness"] =
                        json!({ "compactAdviceTokens": compact, "planTiers": true });
                }
                config
            },
        )
        .boxed()
}

fn extra() -> BoxedStrategy<BTreeMap<String, String>> {
    prop::collection::btree_map(
        prop::sample::select(vec![
            "extra.key",
            "name",
            "navori.scopedGate",
            "piPermissionRules",
        ])
        .prop_map(str::to_owned),
        prop::sample::select(vec!["value", "", "  ", "x'y", "\u{feff}", "\u{85}"])
            .prop_map(str::to_owned),
        0..3,
    )
    .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(3000))]

    // Covers: R41
    #[test]
    fn interpolate_matches_interpolate_ts(
        raw in config_json(),
        content in template(),
        extra_vars in extra(),
        omit in any::<bool>(),
    ) {
        let text = raw.to_string();
        let parsed = config::read(text.as_bytes())
            .map_err(|e| TestCaseError::fail(format!("generated config rejected: {e:?}")))?;
        let data_text = parsed.data.stringify(None).unwrap_or_default();
        let data: Value = serde_json::from_str(&data_text).map_err(|e| TestCaseError::fail(e.to_string()))?;
        let ts = NODE
            .ask(&json!({ "content": content, "config": data, "extra": extra_vars, "omit": omit }))
            .map_err(TestCaseError::fail)?;
        let rust = interpolate(
            &content,
            &parsed.data,
            &InterpolateOptions { extra_vars: extra_vars.clone(), omit_unresolved_key_lines: omit },
        );
        prop_assert_eq!(ts.as_str(), Some(rust.as_str()), "{:?} / {}", content, text);
    }
}
