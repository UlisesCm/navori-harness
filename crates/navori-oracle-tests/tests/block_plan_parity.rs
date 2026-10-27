//! `navori_core::render::block_plan` against the real `computeRenderPlan` and
//! `canonicalManagedOrder` (spec 0058 T14): core assets, preset extras (bundled, local, broken),
//! declared plugins (enabled, disabled, retired, unknown), skip/force ids, workspace renders,
//! engines and the anti-rollback floor, over existing documents with stale, newer, hand-edited
//! and retired blocks.

mod support;

use std::path::PathBuf;
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::js_json;
use navori_core::markers::{InjectDetails, InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::block_plan::{
    PlanAsset, PlanOptions, RenderPlan, UpdateAvailable, canonical_managed_order,
    compute_render_plan,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const r = await import({:?});\nconst m = await import({:?});\nconst b = await import({:?});\n\
         const path = await import('node:path');",
        cli_module("lib/render/render-plan.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const config = JSON.parse(request.config);\n\
       const plan = r.computeRenderPlan(request.existing, config, request.root, {\n\
         skipIds: new Set(request.skip), forceIds: new Set(request.force),\n\
         omitRootOnly: request.omitRootOnly, engine: request.engine ?? undefined,\n\
       });\n\
       const pluginsRoot = path.dirname(b.getPluginPath('x'));\n\
       const rel = (p) => path.isAbsolute(p) ? path.relative(pluginsRoot, p).split(path.sep).join('/') : p;\n\
       const d = (x) => x ? [x.existingHash ?? null, x.actualHash, x.newHash, x.existingVersion ?? null, x.existingSource ?? null, x.versionDrift ?? null, x.downgrade ?? null] : null;\n\
       const u = (x) => [x.id, x.source, x.fromVersion, x.toVersion];\n\
       return {\n\
         next: plan.next, changed: plan.changed,\n\
         entries: plan.entries.map((e) => [e.asset.id, rel(e.asset.relPath), e.source, e.status, d(e.details), e.newContent]),\n\
         missing: plan.missingPlugins.map((x) => [x.id, x.reason]),\n\
         fallbacks: plan.languageFallbacks, updates: plan.updatesAvailable.map(u), downgrades: plan.downgrades.map(u),\n\
         order: r.canonicalManagedOrder(config, request.root, { omitRootOnly: request.omitRootOnly, computedBlockIds: ['agentes-disponibles'] }),\n\
       };\n\
     } catch (e) { return { threw: String(e && e.message || e) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

/// A repo root with three local presets: a valid one (`mine`), invalid JSON (`broken`) and one
/// whose extra points at a missing file (`ghost`).
static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    let root = std::env::temp_dir().join(format!("navori-block-plan-{}", std::process::id()));
    let presets = root.join(".navori/presets");
    let write = |rel: &str, text: &str| {
        let path = presets.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, text);
    };
    write(
        "mine/mine.json",
        r#"{"id":"mine","displayName":"Mine","extras":{"managed":[{"id":"mine-block","relPath":"./blocks//m.md"}]}}"#,
    );
    write("mine/blocks/m.md", "Local block for {{projectName}}.\n");
    write("broken/broken.json", "{");
    write(
        "ghost/ghost.json",
        r#"{"id":"ghost","displayName":"Ghost","extras":{"managed":[{"id":"ghost-block","relPath":"nope.md"}]}}"#,
    );
    root
});

fn details(details: Option<&InjectDetails>) -> Value {
    details.map_or(Value::Null, |d| {
        json!([
            d.existing_hash,
            d.actual_hash,
            d.new_hash,
            d.existing_version,
            d.existing_source,
            d.version_drift,
            d.downgrade
        ])
    })
}

fn updates(list: &[UpdateAvailable]) -> Value {
    list.iter()
        .map(|u| json!([u.id, u.source, u.from_version, u.to_version]))
        .collect()
}

fn plan_json(plan: &RenderPlan, order: &[String]) -> Value {
    let entries: Vec<Value> = plan
        .entries
        .iter()
        .map(|e| {
            let rel = match &e.asset {
                PlanAsset::Core(asset) => asset.rel_path.to_owned(),
                PlanAsset::Preset { rel_path, .. } | PlanAsset::Retired { rel_path, .. } => {
                    rel_path.clone()
                }
                PlanAsset::Plugin { dir, path, .. } => format!("{dir}/{path}"),
            };
            json!([
                e.asset.id(),
                rel,
                e.source,
                e.status.as_str(),
                details(e.details.as_ref()),
                e.new_content
            ])
        })
        .collect();
    json!({
        "next": plan.next,
        "changed": plan.changed(),
        "entries": entries,
        "missing": plan.missing_plugins.iter().map(|(id, reason)| json!([id, reason])).collect::<Vec<_>>(),
        "fallbacks": plan.language_fallbacks,
        "updates": updates(&plan.updates_available),
        "downgrades": updates(&plan.downgrades),
        "order": order,
    })
}

/// Reasons Rust reproduces; any other one in the TS means Rust had to delegate.
fn reproducible(id: &str, reason: &str) -> bool {
    reason == "unknown plugin id"
        || reason == format!("preset '{id}' not found (no .navori/presets/{id}/ nor bundled)")
}

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

fn subset(ids: &[&'static str]) -> BoxedStrategy<Vec<String>> {
    prop::sample::subsequence(ids.to_vec(), 0..=ids.len())
        .prop_shuffle()
        .prop_map(|ids| ids.into_iter().map(String::from).collect())
        .boxed()
}

const PLUGIN_IDS: &[&str] = &[
    "engram",
    "acli",
    "gh",
    "codegraph",
    "tgrep",
    "cognitive",
    "jscpd",
    "unknown-x",
];

fn config() -> BoxedStrategy<String> {
    let plugins = (
        subset(PLUGIN_IDS),
        prop::collection::vec(any::<bool>(), PLUGIN_IDS.len()),
    )
        .prop_map(|(ids, flags)| {
            let fields: Vec<String> = ids
                .iter()
                .zip(flags)
                .map(|(id, enabled)| format!(r#"{}:{{"enabled":{enabled}}}"#, json!(id)))
                .collect();
            format!("{{{}}}", fields.join(","))
        })
        .boxed();
    let exclude = subset(&["sdd", "orquestacion", "idioma-rol"])
        .prop_map(|ids| format!(r#"{{"exclude":{}}}"#, json!(ids)))
        .boxed();
    vec![
        field("language", pick(&[r#""es""#, r#""en""#, r#""fr""#])),
        field("projectName", pick(&[r#""demo""#])),
        field("branchBase", pick(&[r#""main""#])),
        field(
            "preset",
            pick(&[
                r#""custom""#,
                r#""astro""#,
                r#""nextjs""#,
                r#""mine""#,
                r#""broken""#,
                r#""ghost""#,
                r#""missing-x""#,
                r#""""#,
            ]),
        ),
        field("plugins", plugins),
        field(
            "sdd",
            pick(&[
                r#"{"enabled":false}"#,
                r#"{"enabled":true}"#,
                r#"{"enabled":""}"#,
                r#"{"enabled":"yes"}"#,
                r#"{"enabled":0}"#,
            ]),
        ),
        field(
            "project",
            pick(&[
                r#"{"codeLanguage":"rust"}"#,
                r#"{"codeLanguage":"typescript"}"#,
            ]),
        ),
        field(
            "harness",
            pick(&[r#"{"architect":true}"#, r#"{"planTiers":true}"#, "{}"]),
        ),
        field("blocks", exclude),
    ]
    .prop_map(|fields| fields.into_iter().flatten().collect::<Vec<_>>())
    .prop_shuffle()
    .prop_map(|fields| format!("{{{}}}", fields.join(",")))
    .boxed()
}

/// How the existing document is built from a baseline render.
#[derive(Debug, Clone)]
struct Recipe {
    baseline: Option<String>,
    prose: bool,
    restamp: Option<&'static str>,
    hand_edit: bool,
    retired: Vec<(&'static str, Option<&'static str>, bool)>,
}

fn recipe() -> BoxedStrategy<Recipe> {
    let version = prop::sample::select(vec![
        None,
        Some("0.1.0"),
        Some(STAMP_VERSION),
        Some("999.0.0"),
    ]);
    let retired = prop::collection::vec(
        (
            // Retired blocks, plus orchestrator blocks an earlier navori left in CLAUDE.md.
            prop::sample::select(vec![
                "cognitive-protocol",
                "jscpd-protocol",
                "engram-protocol",
                "gh-protocol",
                "arranque-sesion",
                "cierre-sesion",
            ]),
            version,
            any::<bool>(),
        ),
        0..3,
    );
    (
        prop::option::weighted(0.8, config()),
        any::<bool>(),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        any::<bool>(),
        retired,
    )
        .prop_map(|(baseline, prose, restamp, hand_edit, retired)| Recipe {
            baseline,
            prose,
            restamp,
            hand_edit,
            retired,
        })
        .boxed()
}

fn existing(recipe: &Recipe) -> String {
    let mut doc = recipe
        .baseline
        .as_deref()
        .and_then(js_json::parse)
        .and_then(|config| compute_render_plan("", &config, &ROOT, &PlanOptions::default()).ok())
        .map(|plan| plan.next)
        .unwrap_or_default();
    if let Some(version) = recipe.restamp {
        doc = doc.replace(
            &format!("version=\"{STAMP_VERSION}\""),
            &format!("version=\"{version}\""),
        );
    }
    if recipe.hand_edit {
        doc = doc.replacen("-->\n", "-->\nHand edit.\n", 1);
    }
    for (id, version, edited) in &recipe.retired {
        let meta = MarkerMeta {
            source: Some("@navori/plugin-x".to_owned()),
            version: version.map(str::to_owned),
            ..MarkerMeta::default()
        };
        let body = format!("Retired {id}.\n");
        doc = inject_managed_section(&doc, id, &body, &meta, InjectOptions::default()).output;
        if *edited {
            doc = doc.replacen(
                &format!("Retired {id}."),
                &format!("Retired {id}, edited."),
                1,
            );
        }
    }
    if recipe.prose {
        doc = format!("# Project\n\nUser notes.\n\n{doc}");
    }
    doc
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    // Covers: R41
    #[test]
    fn render_plan_matches(
        config in config(),
        recipe in recipe(),
        skip in subset(&["sdd", "idioma-rol", "engram-protocol", "mine-block"]),
        force in subset(&["idioma-rol", "tipado-fuerte", "mine-block"]),
        omit_root_only in any::<bool>(),
        engine in prop::sample::select(vec![None, Some("claude"), Some("codex")]),
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
    ) {
        let existing = existing(&recipe);
        let root = ROOT.to_string_lossy().into_owned();
        let ts = NODE
            .ask(&json!({
                "existing": existing, "config": config, "root": root, "skip": skip,
                "force": force, "omitRootOnly": omit_root_only, "engine": engine, "floor": floor,
            }))
            .map_err(TestCaseError::fail)?;
        let parsed = js_json::parse(&config).ok_or_else(|| TestCaseError::fail("config"))?;
        let options = PlanOptions {
            skip_ids: skip.into_iter().collect(),
            force_ids: force.into_iter().collect(),
            omit_root_only,
            engine: engine.map(str::to_owned),
            ambient_floor: floor.map(str::to_owned),
        };
        let rust = compute_render_plan(&existing, &parsed, &ROOT, &options).and_then(|plan| {
            let order = canonical_managed_order(&parsed, &ROOT, omit_root_only, &["agentes-disponibles"])?;
            Ok(plan_json(&plan, &order))
        });
        match rust {
            Ok(rust) => prop_assert_eq!(ts, rust, "{}", config),
            Err(_) => {
                let threw = ts.get("threw").is_some();
                let unreproduced = ts["missing"].as_array().is_some_and(|missing| {
                    missing.iter().any(|m| {
                        !reproducible(m[0].as_str().unwrap_or(""), m[1].as_str().unwrap_or(""))
                    })
                });
                prop_assert!(threw || unreproduced, "rust delegated, ts: {} for {}", ts, config);
            }
        }
    }
}
