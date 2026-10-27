//! `navori_core::render::plan` against the real `render-plan.ts` (spec 0058 T14): the core asset
//! table, per-language asset paths and `navori:if` resolution.

mod support;

use navori_core::config;
use navori_core::render::plan::{
    Audience, CORE_MANAGED_ASSETS, condition_orchestration, resolve_asset_path,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const p = await import({:?});\nconst b = await import({:?});\nconst path = await import('node:path');",
        cli_module("lib/render/render-plan.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "switch (request.op) {\n\
       case 'assets': return p.CORE_MANAGED_ASSETS.map((a) => [a.id, a.relPath, a.condition ?? null, a.baseLanguage ?? 'es', a.rootOnly === true, a.audience ?? null]);\n\
       case 'path': {\n\
         const asset = p.CORE_MANAGED_ASSETS.find((a) => a.id === request.id);\n\
         const r = p.resolveAssetPath(asset, request.lang);\n\
         return [path.relative(b.getCoreRoot(), r.path), r.fallback];\n\
       }\n\
       case 'condition':\n\
         try { return { ok: p.conditionOrchestration(request.content, request.config, request.engine) }; }\n\
         catch (e) { return { error: e.message }; }\n\
       default: throw new Error('unknown op');\n\
     }",
);

// Covers: R41
#[test]
fn core_asset_table_and_language_paths_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "assets" }))?;
    let rust: Vec<Value> = CORE_MANAGED_ASSETS
        .iter()
        .map(|a| {
            json!([
                a.id,
                a.rel_path,
                a.condition,
                a.base_language,
                a.root_only,
                (a.audience == Audience::Orchestrator).then_some("orchestrator"),
            ])
        })
        .collect();
    if ts != Value::Array(rust.clone()) {
        return Err(format!(
            "asset table differs:\nts   {ts}\nrust {}",
            Value::Array(rust)
        ));
    }
    for asset in CORE_MANAGED_ASSETS.iter() {
        for lang in ["es", "en", "fr"] {
            let ts = NODE.ask(&json!({ "op": "path", "id": asset.id, "lang": lang }))?;
            let (path, fallback) = resolve_asset_path(asset, lang);
            if ts != json!([path, fallback]) {
                return Err(format!(
                    "{} {lang}: ts {ts} rust {path} {fallback}",
                    asset.id
                ));
            }
        }
    }
    Ok(())
}

fn piece() -> BoxedStrategy<String> {
    let keys = prop::sample::select(vec![
        "planTiers",
        "auditor",
        "onCodex",
        "onClaude",
        "onPi",
        "sdd",
        "scribeOwnsMarkdown",
        "unknownKey",
        "constructor",
        "masterPlan",
    ]);
    prop_oneof![
        2 => keys.clone().prop_map(|k| format!("<!-- navori:if {k} -->")),
        2 => keys.prop_map(|k| format!("<!-- navori:if-not {k} -->")),
        2 => Just("<!-- /navori:if -->".to_owned()),
        2 => Just("<!-- /navori:if-not -->".to_owned()),
        3 => prop::sample::select(vec!["\n", "text", "\nbody\n", "<!-- navori:if bad key -->", "é"])
            .prop_map(str::to_owned),
    ]
    .boxed()
}

/// Balanced nests most of the time, raw token soup otherwise (to reach every error message).
fn content() -> BoxedStrategy<String> {
    let balanced = prop::collection::vec(
        (
            prop::sample::select(vec!["if", "if-not"]),
            prop::sample::select(vec!["planTiers", "auditor", "onCodex", "sdd", "x"]),
            prop::sample::select(vec!["\nA\n", "B", "\n", ""]),
        ),
        0..4,
    )
    .prop_map(|frames| {
        let mut out = String::new();
        for (kind, key, _) in &frames {
            out.push_str(&format!("<!-- navori:{kind} {key} -->\n"));
        }
        for (kind, _, body) in frames.iter().rev() {
            out.push_str(body);
            out.push_str(&format!("\n<!-- /navori:{kind} -->"));
        }
        out
    });
    prop_oneof![
        2 => balanced,
        1 => prop::collection::vec(piece(), 0..8).prop_map(|parts| parts.concat()),
    ]
    .boxed()
}

fn config_value() -> BoxedStrategy<Value> {
    (
        prop::option::of(any::<bool>()),
        prop::option::of(any::<bool>()),
        prop::option::of(any::<bool>()),
    )
        .prop_map(|(plan, auditor, sdd)| {
            let mut config = json!({ "name": "r", "engines": ["claude"], "preset": "node" });
            if plan.is_some() || auditor.is_some() {
                let mut harness = json!({});
                if let Some(plan) = plan {
                    harness["planTiers"] = json!(plan);
                }
                if let Some(auditor) = auditor {
                    harness["auditor"] = json!(auditor);
                }
                config["harness"] = harness;
            }
            if let Some(sdd) = sdd {
                config["sdd"] = json!({ "enabled": sdd });
            }
            config
        })
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    // Covers: R41
    #[test]
    fn condition_orchestration_matches(
        content in content(),
        raw in config_value(),
        engine in prop::sample::select(vec!["claude", "codex", "pi", "cursor"]),
    ) {
        let parsed = config::read(raw.to_string().as_bytes())
            .map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let data: Value = serde_json::from_str(&parsed.data.stringify(None).unwrap_or_default())
            .map_err(|e| TestCaseError::fail(e.to_string()))?;
        let ts = NODE
            .ask(&json!({ "op": "condition", "content": content, "config": data, "engine": engine }))
            .map_err(TestCaseError::fail)?;
        let rust = match condition_orchestration(&content, &parsed.data, engine) {
            Ok(text) => json!({ "ok": text }),
            Err(error) => json!({ "error": error.0 }),
        };
        prop_assert_eq!(ts, rust, "{:?}", content);
    }
}
