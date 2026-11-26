//! `navori_core::render::codex_agents` against the real `prepareCodexEngine` (spec 0059 T19): the
//! `.codex/agents/*.toml` the Codex engine plans (writes and skips) must match for core roles and
//! preset extras, plugin skills injected into an agent, model profiles over a catalog, and
//! destinations that are missing, navori's, hand-edited, newer or user-owned.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::codex_agents::collect_codex_agents;
use navori_core::render::collect::DiskView;
use navori_core::render::context::Lang;
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::plugins::load_enabled_plugins;
use navori_core::render::presets::load_preset;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?}); const c = await import({:?}); const path = await import('node:path');",
        cli_module("engines/codex/index.ts"),
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "process.env.CODEX_HOME = request.home;\n\
     try {\n\
       const config = c.readConfig(path.join(request.root, 'navori.config.json'));\n\
       const prepared = e.prepareCodexEngine(request.root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const inScope = (rel) => rel.startsWith('.codex/agents/');\n\
       return {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status]),\n\
         skipped: fin.skipped.filter((x) => inScope(x.path)).map((x) => [x.path, x.reason, x.status ?? null, x.resolution ? x.resolution.content : null]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-agents-{}", std::process::id()))
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

/// What an agent destination holds before the render.
#[derive(Debug, Clone, Copy)]
enum State {
    Missing,
    Ours,
    Edited,
    Newer,
    Foreign,
}

fn block(id: &str, body: &str, version: &str) -> String {
    let meta = MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some(version.to_owned()),
        fm_keys: None,
        floor_version: None,
    };
    let options = InjectOptions {
        shell: true,
        ..InjectOptions::default()
    };
    inject_managed_section("", id, body, &meta, options).output
}

fn place(root: &Path, id: &str, state: State) -> Result<(), TestCaseError> {
    let path = root.join(format!(".codex/agents/{id}.toml"));
    let managed = format!("{id}-codex-base");
    let body = format!("name = \"{id}\"\nmodel = \"gpt-6.4-sol\"");
    match state {
        State::Missing => Ok(()),
        State::Ours => write(&path, &block(&managed, &body, "0.1.0")),
        State::Edited => write(
            &path,
            &block(&managed, &body, "0.1.0").replacen("gpt-6.4-sol", "mine", 1),
        ),
        State::Newer => write(&path, &block(&managed, &body, "999.0.0")),
        State::Foreign => write(&path, &format!("name = \"{id}\"\nmodel = \"custom\"\n")),
    }
}

fn pick(options: &[&'static str]) -> BoxedStrategy<&'static str> {
    prop::sample::select(options.to_vec()).boxed()
}

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""nextjs""#, r#""express""#]),
        prop::collection::vec(0u8..3, 4),
        prop::option::of(pick(&[
            r#"{"publisher":false}"#,
            r#"{"planTiers":true,"scout":false}"#,
            r#"{"masterPlan":true}"#,
        ])),
        prop::option::of(pick(&[
            r#"{"implementer":"sonnet","reviewer":"opus","scout":"haiku"}"#,
            r#"{"implementer":"opus","codexMap":{"opus":"gpt-6-custom"},"codexProfiles":{"reviewer":{"model":"luna","effort":"low"}}}"#,
        ])),
        prop::option::of(pick(&[
            r#"{"implementer":"medium","reviewer":"high"}"#,
            r#"{"scout":"max"}"#,
        ])),
        pick(&[r#""es""#, r#""en""#]),
    )
        .prop_map(|(preset, states, harness, models, effort, lang)| {
            let plugins: Vec<String> = ["engram", "codegraph", "gh", "acli"]
                .iter()
                .zip(states)
                .filter(|(_, s)| *s > 0)
                .map(|(id, s)| format!(r#""{id}":{{"enabled":{}}}"#, s == 1))
                .collect();
            let opt = |key: &str, value: Option<&str>| {
                value.map_or_else(String::new, |v| format!(r#","{key}":{v}"#))
            };
            format!(
                r#"{{"name":"demo","preset":{preset},"engines":["codex"],"language":{lang}{}{}{},"plugins":{{{}}}}}"#,
                opt("harness", harness),
                opt("models", models),
                opt("effort", effort),
                plugins.join(",")
            )
        })
        .boxed()
}

fn state() -> BoxedStrategy<State> {
    prop::sample::select(vec![
        State::Missing,
        State::Missing,
        State::Ours,
        State::Edited,
        State::Newer,
        State::Foreign,
    ])
    .boxed()
}

fn string_at(config: &JsValue, key: &str) -> Option<String> {
    match config {
        JsValue::Object(object) => match object.get(key) {
            Some(JsValue::String(text)) => text.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

fn rust_agents(root: &Path, text: &str, catalog: &Path) -> Option<Value> {
    let read = config::read(text.as_bytes()).ok()?;
    let config = config::effective_config(&read.data);
    let preset = match string_at(&config, "preset").as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let plugins = match &config {
        JsValue::Object(object) => load_enabled_plugins(object.get("plugins")).ok()?,
        _ => return None,
    };
    let plan = resolve_harness_plan(&config, preset.as_ref(), false, Some("codex"));
    let lang = Lang::resolve(string_at(&config, "language").as_deref());
    let agents = collect_codex_agents(
        &DiskView(root),
        root,
        &plan.agents,
        &config,
        &plugins.loaded,
        Some(catalog),
        None,
        lang,
    )
    .ok()?;
    let pending: Vec<Value> = agents
        .files
        .iter()
        .filter_map(|c| c.write.as_ref())
        .map(|w| json!([w.rel_path, w.content, w.status.as_str()]))
        .collect();
    let skipped: Vec<Value> = agents
        .files
        .iter()
        .filter_map(|c| c.skip.as_ref())
        .map(|s| {
            json!([
                s.rel_path,
                s.reason,
                s.status.map(|st| st.as_str()),
                s.resolution
            ])
        })
        .collect();
    Some(json!({ "pending": pending, "skipped": skipped }))
}

const AGENT_IDS: [&str; 4] = ["implementer", "reviewer", "scout", "frontend-specialist"];

proptest! {
    #![proptest_config(ProptestConfig::with_cases(150))]

    // Covers: R62
    #[test]
    fn codex_agents_match_prepare_codex_engine(
        text in config(), states in prop::collection::vec(state(), AGENT_IDS.len()),
        catalog in prop::option::of(pick(&[
            r#"{"models":[{"slug":"gpt-6.1-sol"},{"slug":"gpt-6-luna"}]}"#,
            r#"{"models":[{"slug":"gpt-6.5-sol"}]}"#,
        ])),
    ) {
        let root = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let home = root.join("home");
        write(&repo.join("navori.config.json"), &text)?;
        if let Some(catalog) = catalog {
            write(&home.join("models_cache.json"), catalog)?;
        }
        for (id, state) in AGENT_IDS.iter().zip(&states) {
            place(&repo, id, *state)?;
        }
        let reply = NODE
            .ask(&json!({ "root": repo, "home": home }))
            .map_err(TestCaseError::fail)?;
        prop_assume!(reply.get("threw").is_none());
        let rust = rust_agents(&repo, &text, &home.join("models_cache.json"))
            .ok_or_else(|| fail("unexpected delegate"))?;
        prop_assert_eq!(reply, rust, "{}", text);
    }
}
