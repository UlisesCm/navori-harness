//! `navori_core::render::codex_engine` against the real `prepareCodexEngine` (spec 0059 T19): the
//! whole Codex engine of a codex-only root render — every planned write (hooks with the guard's
//! sealed inventory, native wrapping, plugin scripts and extensions, `config.toml`, rules, agents,
//! skills, `AGENTS.md`), removals, skips and warnings — must match, also after a first render
//! leaves its tree on disk.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::i18n::markerless_collision;
use navori_core::render::codex_engine::{
    CodexEngineInput, MIN_CODEX_VERSION, codex_observed, plan_codex_engine, seal_observed,
};
use navori_core::render::collect::DiskView;
use navori_core::render::context::Lang;
use navori_core::render::native_hooks::embedded_native_hooks;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?}); const c = await import({:?}); const h = await import({:?}); const path = await import('node:path'); const fs = await import('node:fs');",
        cli_module("engines/codex/index.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("engines/codex/hook-registrations.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.version) return h.minCodexVersion();\n\
     process.env.CODEX_HOME = request.home;\n\
     try {\n\
       const config = c.readConfig(path.join(request.root, 'navori.config.json'));\n\
       const prepared = e.prepareCodexEngine(request.root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const result = prepared.commit();\n\
       if (request.write) {\n\
         for (const p of fin.pending) { fs.mkdirSync(path.dirname(p.path), { recursive: true }); fs.writeFileSync(p.path, p.content); }\n\
         return null;\n\
       }\n\
       return {\n\
         pending: fin.pending.map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         removals: fin.removals.map((r) => [path.relative(request.root, r.path), r.recursive === true]),\n\
         skipped: fin.skipped.map((x) => [x.path, x.reason, x.status ?? null]),\n\
         warnings: result.warnings,\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-engine-{}", std::process::id()))
});
static CASE: AtomicUsize = AtomicUsize::new(0);

fn fail(error: impl ToString) -> TestCaseError {
    TestCaseError::fail(error.to_string())
}

fn write(path: &Path, text: &str) -> Result<(), TestCaseError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    std::fs::write(path, text).map_err(fail)
}

fn pick(options: &[&'static str]) -> BoxedStrategy<&'static str> {
    prop::sample::select(options.to_vec()).boxed()
}

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""nextjs""#, r#""express""#, r#""ghost""#]),
        prop::collection::vec(0u8..3, 4),
        prop::option::of(pick(&[
            r#"{"publisher":false}"#,
            r#"{"codexIntegration":true,"planTiers":true}"#,
            r#"{"masterPlan":true,"scribeOwnsMarkdown":true}"#,
        ])),
        prop::option::of(pick(&[r#"{"full":"bun check","fast":"bun run check:fast"}"#])),
        pick(&[r#""es""#, r#""en""#]),
        prop::option::of(pick(&[
            r#"{"implementer":"sonnet","reviewer":"opus","orchestrator":"opus"}"#,
            r#"{"codexProfiles":{"orchestrator":{"model":"luna","effort":"high"}}}"#,
        ])),
        prop::option::of(pick(&[r#"{"libraries":["zod","nope"]}"#])),
    )
        .prop_map(|(preset, states, harness, gate, lang, models, project)| {
            let plugins: Vec<String> = ["engram", "codegraph", "gh", "tgrep"]
                .iter()
                .zip(states)
                .filter(|(_, s)| *s > 0)
                .map(|(id, s)| format!(r#""{id}":{{"enabled":{}}}"#, s == 1))
                .collect();
            let opt = |key: &str, value: Option<&str>| {
                value.map_or_else(String::new, |v| format!(r#","{key}":{v}"#))
            };
            format!(
                r#"{{"name":"demo","preset":{preset},"engines":["codex"],"language":{lang}{}{}{}{},"plugins":{{{}}}}}"#,
                opt("harness", harness),
                opt("qualityGate", gate),
                opt("models", models),
                opt("project", project),
                plugins.join(",")
            )
        })
        .boxed()
}

fn rust_engine(root: &Path, home: &Path, text: &str) -> Option<Value> {
    let read = config::read(text.as_bytes()).ok()?;
    let manifest = embedded_native_hooks();
    let input = CodexEngineInput {
        config: &read.data,
        repo_root: root,
        ambient_floor: None,
        native_manifest: &manifest,
        catalog: Some(home.join("models_cache.json")),
    };
    let view = DiskView(root);
    let observed = codex_observed(&view, &input).ok()?;
    let seal = seal_observed(&view, &observed).ok()?;
    let plan = plan_codex_engine(&view, &input, &seal).ok()?;
    let lang = Lang::resolve(
        match &read.data {
            navori_core::js_json::JsValue::Object(o) => match o.get("language") {
                Some(navori_core::js_json::JsValue::String(s)) => s.to_rust(),
                _ => None,
            },
            _ => None,
        }
        .as_deref(),
    );
    let mut warnings = plan.warnings.clone();
    warnings.extend(
        plan.collisions
            .iter()
            .map(|(path, keys)| markerless_collision(lang, path, keys, None)),
    );
    Some(json!({
        "pending": plan.pending.iter().map(|w| json!([w.rel_path, w.content, w.status.as_str(), w.chmod_exec])).collect::<Vec<_>>(),
        "removals": plan.removals.iter().map(|r| json!([r.rel_path, r.recursive])).collect::<Vec<_>>(),
        "skipped": plan.skipped.iter().map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str())])).collect::<Vec<_>>(),
        "warnings": warnings,
    }))
}

// Covers: R62
#[test]
fn min_codex_version_matches_ts() {
    assert_eq!(
        NODE.ask(&json!({ "version": true })),
        Ok(json!(MIN_CODEX_VERSION))
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    // Covers: R62, R66
    #[test]
    fn codex_engine_matches_prepare_codex_engine(
        text in config(), first in config(), rendered in any::<bool>(),
        catalog in prop::option::of(pick(&[r#"{"models":[{"slug":"gpt-6.1-sol"},{"slug":"gpt-6-luna"}]}"#])),
    ) {
        let case = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        let _ = std::fs::remove_dir_all(&case);
        let root = case.join("repo");
        let home = case.join("home");
        std::fs::create_dir_all(&root).map_err(fail)?;
        if let Some(catalog) = catalog {
            write(&home.join("models_cache.json"), catalog)?;
        }
        if rendered {
            write(&root.join("navori.config.json"), &first)?;
            let seeded = NODE
                .ask(&json!({ "root": root, "home": home, "write": true }))
                .map_err(TestCaseError::fail)?;
            prop_assume!(seeded.is_null());
        }
        write(&root.join("navori.config.json"), &text)?;
        let reply = NODE
            .ask(&json!({ "root": root, "home": home }))
            .map_err(TestCaseError::fail)?;
        prop_assume!(reply.get("threw").is_none());
        let rust = rust_engine(&root, &home, &text).ok_or_else(|| fail("unexpected delegate"))?;
        prop_assert!(reply == rust, "{text}\n{}", support::first_difference(&reply, &rust));
    }
}
