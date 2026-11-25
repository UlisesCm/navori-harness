//! `navori_core::render::{codex_catalog, codex_profile}` against the real `model-catalog.ts` and
//! `model-profile.ts` (spec 0059 T19, R62): family resolution over generated catalogs, the
//! profile of each input, the native TOML fields and the projection diagnostics the Codex render
//! prints must match.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::codex_catalog::{CodexModelResolution, resolve_codex_model_value};
use navori_core::render::codex_profile::{
    CodexProfileInput, NativeFields, ProfileRow, ProfileValue, project_codex_profiles,
    read_native_codex_profile, resolve_codex_profile,
};
use navori_core::render::harness_plan::resolve_harness_plan;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const m = await import({:?}); const p = await import({:?}); \
         const h = await import({:?}); const b = await import({:?}); \
         const path = await import('node:path');",
        cli_module("lib/codex/model-catalog.ts"),
        cli_module("lib/assets/model-profile.ts"),
        cli_module("engines/shared/harness-plan.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "switch (request.kind) {\n\
       case 'value': return m.resolveCodexModelValue(request.value, request.catalog, request.previous);\n\
       case 'profile': return p.resolveCodexProfile(request.config, request.input, request.catalog);\n\
       case 'native': return p.readNativeCodexProfile(request.root, request.id);\n\
       default: {\n\
         const agents = h.resolveHarnessPlan(request.config, path.join(b.getCoreRoot(), 'core-assets'), null, { engine: 'codex' }).agents;\n\
         return p.projectCodexProfiles(request.root, request.config, { catalogPath: request.catalog, plannedAgents: agents })\n\
           .map((r) => ({ nativeName: r.nativeName, origin: r.origin, path: r.path, model: r.model, effort: r.effort, rendered: r.rendered, diagnostics: r.diagnostics }));\n\
       }\n\
     }",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-profile-{}", std::process::id()))
});
static CASE: AtomicUsize = AtomicUsize::new(0);

/// A fresh, empty directory for one case.
fn case_dir() -> Result<PathBuf, TestCaseError> {
    let dir = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| TestCaseError::fail(e.to_string()))?;
    Ok(dir)
}

fn write(path: &Path, text: &str) -> Result<(), TestCaseError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
    std::fs::write(path, text).map_err(|e| TestCaseError::fail(e.to_string()))
}

fn to_js(value: &Value) -> Result<JsValue, TestCaseError> {
    navori_core::js_json::parse(&value.to_string())
        .ok_or_else(|| TestCaseError::fail("generated JSON"))
}

fn opt(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |v| json!(v))
}

fn resolution_json(resolution: &CodexModelResolution) -> Value {
    let mut out = json!({ "model": resolution.model, "source": resolution.source.as_str() });
    if let Some(family) = &resolution.family {
        out["family"] = json!(family);
    }
    out
}

fn profile_value_json(value: &ProfileValue) -> Value {
    let mut out = json!({
        "configured": opt(value.configured.as_deref()),
        "origin": value.origin.as_str(),
        "wouldRender": opt(value.would_render.as_deref()),
        "effectiveObserved": null,
    });
    if let Some(configured) = value.configured_mapping {
        out["mapping"] = json!(if configured { "configured" } else { "built-in" });
    }
    if let Some(source) = value.source {
        out["source"] = json!(source.as_str());
    }
    out
}

fn native_json(native: &NativeFields) -> Value {
    let mut out = json!({
        "name": opt(native.name.as_deref()),
        "model": opt(native.model.as_deref()),
        "effort": opt(native.effort.as_deref()),
        "managed": native.managed,
    });
    if let Some(model) = &native.user_model {
        out["userModel"] = json!(model);
    }
    if let Some(effort) = &native.user_effort {
        out["userEffort"] = json!(effort);
    }
    if let Some(diagnostic) = native.diagnostic {
        out["diagnostic"] = json!(diagnostic);
    }
    out
}

fn row_json(row: &ProfileRow) -> Value {
    let origin = match row.origin {
        navori_core::render::codex_profile::ProfileRowOrigin::Main => "main",
        navori_core::render::codex_profile::ProfileRowOrigin::Core => "core",
        navori_core::render::codex_profile::ProfileRowOrigin::Extra => "extra",
        navori_core::render::codex_profile::ProfileRowOrigin::Local => "local",
    };
    json!({
        "nativeName": row.native_name,
        "origin": origin,
        "path": row.path,
        "model": profile_value_json(&row.model),
        "effort": profile_value_json(&row.effort),
        "rendered": row.rendered.as_ref().map_or(Value::Null, |(model, effort)| json!({
            "model": opt(model.as_deref()), "effort": opt(effort.as_deref()),
        })),
        "diagnostics": row.diagnostics,
    })
}

fn slug() -> impl Strategy<Value = Value> {
    prop_oneof![
        8 => prop::sample::select(vec![
            "gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-luna", "gpt-6-luna", "gpt-07-sol", "gpt-6.0-sol",
            "gpt-10-astra", "gpt-6-sol-x", "sol", "gpt-6-Sol", "gpt-9007199254740992-sol",
            "gpt-6-nova", "gpt-6.1.2-luna", "gpt--sol", "gpt-6-constructor", "gpt-6.0-luna",
            "gpt-06-luna", "gpt-6.0.0-luna", "gpt-06.1-sol",
        ]).prop_map(|slug| json!({ "slug": slug, "extra": 1 })),
        1 => prop_oneof![Just(json!({ "slug": 6 })), Just(json!("gpt-6-sol")), Just(json!({}))],
    ]
}

/// A catalog file body, or `None` for no file.
fn catalog() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        1 => Just(None),
        6 => prop::collection::vec(slug(), 0..6)
            .prop_map(|models| Some(json!({ "models": models, "etag": "x" }).to_string())),
        1 => prop::sample::select(vec![r#"{"models":3}"#, "[]", r#"{"other":[]}"#, "null"])
            .prop_map(|text| Some(text.to_owned())),
    ]
}

fn family_value() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "sol",
        "luna",
        "astra",
        "nova",
        "gpt-6-sol",
        "o3",
        "",
        "Sol",
    ])
    .prop_map(str::to_owned)
}

fn previous() -> impl Strategy<Value = Option<String>> {
    prop::option::of(
        prop::sample::select(vec![
            "gpt-6-sol",
            "gpt-7-sol",
            "gpt-5-sol",
            "gpt-6.2-luna",
            "pinned",
            "gpt-6-astra",
            "gpt-6.1-sol",
        ])
        .prop_map(str::to_owned),
    )
}

/// Writes the catalog (if any) and returns the path both sides read.
fn catalog_path(dir: &Path, body: Option<&str>) -> Result<PathBuf, TestCaseError> {
    let path = dir.join("models_cache.json");
    if let Some(body) = body {
        write(&path, body)?;
    }
    Ok(path)
}

fn config() -> impl Strategy<Value = Value> {
    let tier = || prop::option::of(prop::sample::select(vec!["opus", "sonnet", "haiku"]));
    let effort = || {
        prop::option::of(prop::sample::select(vec![
            "low", "medium", "high", "xhigh", "max",
        ]))
    };
    let profile = (
        prop::option::of(family_value().prop_filter("non-empty", |v| !v.is_empty())),
        effort(),
    );
    (
        (tier(), tier(), tier()),
        (effort(), effort()),
        prop::option::of((
            prop::option::of(family_value()),
            prop::option::of(family_value()),
        )),
        prop::collection::vec(
            (
                prop::sample::select(vec!["orchestrator", "implementer", "scout", "ghost"]),
                profile,
            ),
            0..3,
        ),
        prop::sample::select(vec![None, Some(false)]),
    )
        .prop_map(
            |(
                (orch, implementer, scout),
                (orch_effort, implementer_effort),
                map,
                profiles,
                off,
            )| {
                let mut models = serde_json::Map::new();
                for (key, value) in [
                    ("orchestrator", orch),
                    ("implementer", implementer),
                    ("scout", scout),
                ] {
                    if let Some(value) = value {
                        models.insert(key.to_owned(), json!(value));
                    }
                }
                if let Some((opus, sonnet)) = map {
                    let mut entries = serde_json::Map::new();
                    if let Some(opus) = opus {
                        entries.insert("opus".to_owned(), json!(opus));
                    }
                    if let Some(sonnet) = sonnet {
                        entries.insert("sonnet".to_owned(), json!(sonnet));
                    }
                    models.insert("codexMap".to_owned(), Value::Object(entries));
                }
                if !profiles.is_empty() {
                    let mut entries = serde_json::Map::new();
                    for (name, (model, effort)) in profiles {
                        let mut entry = serde_json::Map::new();
                        if let Some(model) = model {
                            entry.insert("model".to_owned(), json!(model));
                        }
                        if let Some(effort) = effort {
                            entry.insert("effort".to_owned(), json!(effort));
                        }
                        entries.insert(name.to_owned(), Value::Object(entry));
                    }
                    models.insert("codexProfiles".to_owned(), Value::Object(entries));
                }
                let mut effort = serde_json::Map::new();
                if let Some(value) = orch_effort {
                    effort.insert("orchestrator".to_owned(), json!(value));
                }
                if let Some(value) = implementer_effort {
                    effort.insert("implementer".to_owned(), json!(value));
                }
                let mut config =
                    json!({ "engines": ["codex"], "models": models, "effort": effort });
                if let Some(off) = off {
                    config["harness"] = json!({ "scout": off });
                }
                config
            },
        )
}

fn block(id: &str, body: &str) -> String {
    let meta = MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some("0.12.3".to_owned()),
        fm_keys: None,
        floor_version: None,
    };
    let options = InjectOptions {
        shell: true,
        ..InjectOptions::default()
    };
    inject_managed_section("", id, body, &meta, options).output
}

/// A native TOML document from pieces, valid or not.
fn native_doc() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        Just("model = \"gpt-6-sol\"\n".to_owned()),
        Just("model = 3\n".to_owned()),
        Just("model = 1979-05-27\n".to_owned()),
        Just("model_reasoning_effort = \"high\"\n".to_owned()),
        Just("model_reasoning_effort = \"turbo\"\n".to_owned()),
        Just("name = \"scout\"\n".to_owned()),
        Just("name = \"bad name\"\n".to_owned()),
        Just("name = 1\n".to_owned()),
        Just("[features]\nhooks = true\n".to_owned()),
        Just("a = {\n b = 1,\n}\n".to_owned()),
        Just("esc = \"a\\eb\"\n".to_owned()),
        Just("= broken\n".to_owned()),
        Just("# comment\n".to_owned()),
        Just(block(
            "codex-config-base",
            "model = \"gpt-6-luna\"\nsandbox_mode = \"x\""
        )),
        Just(block("scout-codex-base", "name = \"scout\"")),
        Just(block("codex-config-base", "broken = ")),
    ];
    prop::collection::vec(piece, 0..5).prop_map(|pieces| pieces.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    // Covers: R62
    #[test]
    fn family_resolution_matches_model_catalog_ts(
        body in catalog(), value in family_value(), previous in previous(), null_path in any::<bool>(),
    ) {
        let dir = case_dir()?;
        let path = catalog_path(&dir, body.as_deref())?;
        let catalog = (!null_path).then_some(path.as_path());
        let rust = resolve_codex_model_value(&value, catalog, previous.as_deref())
            .map_err(|_| TestCaseError::fail("unexpected delegate"))?;
        let reply = NODE
            .ask(&json!({ "kind": "value", "value": value, "catalog": catalog, "previous": previous }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, resolution_json(&rust));
    }

    // Covers: R62
    #[test]
    fn profile_matches_resolve_codex_profile(
        config in config(), body in catalog(), previous in previous(),
        name in prop::sample::select(vec!["orchestrator", "implementer", "ghost"]),
        tier in prop::option::of(prop::sample::select(vec!["opus", "sonnet", "haiku", "inherit", "\n", ""])),
        effort in prop::option::of(prop::sample::select(vec!["medium", "high", "low", "weird", ""])),
    ) {
        let dir = case_dir()?;
        let path = catalog_path(&dir, body.as_deref())?;
        let input = CodexProfileInput {
            name: name.to_owned(),
            tier: tier.map(str::to_owned),
            effort: effort.map(str::to_owned),
            previous,
        };
        let rust = resolve_codex_profile(&to_js(&config)?, &input, Some(&path))
            .map_err(|_| TestCaseError::fail("unexpected delegate"))?;
        let mut ts_input = json!({ "name": input.name });
        if let Some(tier) = &input.tier { ts_input["tier"] = json!(tier); }
        if let Some(effort) = &input.effort { ts_input["effort"] = json!(effort); }
        if let Some(previous) = &input.previous { ts_input["previous"] = json!(previous); }
        let reply = NODE
            .ask(&json!({ "kind": "profile", "config": config, "input": ts_input, "catalog": path }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!({
            "model": profile_value_json(&rust.model),
            "effort": profile_value_json(&rust.effort),
            "diagnostics": rust.diagnostics,
        }));
    }

    // Covers: R62
    #[test]
    fn native_fields_match_read_native_codex_profile(
        doc in native_doc(), id in prop::sample::select(vec!["orchestrator", "scout", "config", "bad id"]),
        present in prop::bool::weighted(0.9),
    ) {
        let dir = case_dir()?;
        if present && id != "bad id" {
            let rel = if id == "orchestrator" { ".codex/config.toml".to_owned() } else { format!(".codex/agents/{id}.toml") };
            write(&dir.join(rel), &doc)?;
        }
        let rust = read_native_codex_profile(&dir, id);
        let reply = NODE
            .ask(&json!({ "kind": "native", "root": dir, "id": id }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, native_json(&rust), "{:?}", doc);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    // Covers: R62
    #[test]
    fn projection_matches_project_codex_profiles(
        config in config(), body in catalog(),
        main in prop::option::of(native_doc()),
        agents in prop::collection::vec(
            (prop::sample::select(vec!["implementer", "scout", "local-a", "local-b", "config"]), native_doc()),
            0..4,
        ),
    ) {
        let dir = case_dir()?;
        let path = catalog_path(&dir, body.as_deref())?;
        if let Some(main) = main {
            write(&dir.join(".codex/config.toml"), &main)?;
        }
        for (id, doc) in &agents {
            write(&dir.join(format!(".codex/agents/{id}.toml")), doc)?;
        }
        let js = to_js(&config)?;
        let plan = resolve_harness_plan(&js, None, false, Some("codex"));
        let rust = project_codex_profiles(&dir, &js, Some(&path), &plan.agents)
            .map_err(|_| TestCaseError::fail("unexpected delegate"))?;
        let reply = NODE
            .ask(&json!({ "kind": "projection", "root": dir, "config": config, "catalog": path }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, Value::Array(rust.iter().map(row_json).collect()));
    }
}
