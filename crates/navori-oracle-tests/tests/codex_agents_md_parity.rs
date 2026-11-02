//! `navori_core::render::codex_agents_md` against the real `prepareCodexEngine` and
//! `compactAgentDescription` (spec 0059 T19): `AGENTS.md` (harness prose, agent catalog, plugin
//! blocks aimed at the orchestrator) and `.codex/orchestrator.md` must plan the same writes and
//! skips over destinations that are missing, the user's, navori's, hand-edited or newer.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::codex_agents::collect_codex_agents;
use navori_core::render::codex_agents_md::{
    agents_md_body, collect_agents_md, collect_orchestrator, compact_agent_description,
};
use navori_core::render::collect::{Collected, DiskView};
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
    "if (request.compact !== undefined) return e.compactAgentDescription(request.compact);\n\
     process.env.CODEX_HOME = request.home;\n\
     try {\n\
       const config = c.readConfig(path.join(request.root, 'navori.config.json'));\n\
       const prepared = e.prepareCodexEngine(request.root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const inScope = (rel) => rel === 'AGENTS.md' || rel === '.codex/orchestrator.md';\n\
       return {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status]),\n\
         skipped: fin.skipped.filter((x) => inScope(x.path)).map((x) => [x.path, x.reason, x.status ?? null, x.resolution ? x.resolution.content : null]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-agents-md-{}", std::process::id()))
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

fn block(existing: &str, id: &str, body: &str, version: &str) -> String {
    let meta = MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some(version.to_owned()),
        fm_keys: None,
        floor_version: None,
    };
    inject_managed_section(existing, id, body, &meta, InjectOptions::default()).output
}

/// What a destination holds before the render.
#[derive(Debug, Clone, Copy)]
enum State {
    Missing,
    User,
    Ours,
    Edited,
    Newer,
}

fn place(root: &Path, rel: &str, id: &str, state: State) -> Result<(), TestCaseError> {
    let path = root.join(rel);
    let ours = block("# Mine\n\nKeep this.\n\n", id, "Old body.", "0.1.0");
    match state {
        State::Missing => Ok(()),
        State::User => write(&path, "# Mine\n\nKeep this.\n"),
        State::Ours => write(&path, &ours),
        State::Edited => write(&path, &ours.replacen("Old body.", "Mine.", 1)),
        State::Newer => write(&path, &block("", id, "Old body.", "999.0.0")),
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
            r#"{"publisher":false,"scout":false}"#,
            r#"{"planTiers":true,"masterPlan":true}"#,
            r#"{"codexIntegration":true}"#,
        ])),
        pick(&[r#""es""#, r#""en""#]),
        prop::option::of(pick(&[
            r#"{"posture":"production","libraries":["zod"]}"#,
            r#"{"posture":"prototype"}"#,
        ])),
    )
        .prop_map(|(preset, states, harness, lang, project)| {
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
                r#"{{"name":"demo","preset":{preset},"engines":["codex"],"language":{lang}{}{},"plugins":{{{}}}}}"#,
                opt("harness", harness),
                opt("project", project),
                plugins.join(",")
            )
        })
        .boxed()
}

fn state() -> BoxedStrategy<State> {
    prop::sample::select(vec![
        State::Missing,
        State::Missing,
        State::User,
        State::Ours,
        State::Edited,
        State::Newer,
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

fn rust_files(root: &Path, text: &str, catalog: &Path) -> Option<Value> {
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
    let view = DiskView(root);
    let agents = collect_codex_agents(
        &view,
        root,
        &plan.agents,
        &config,
        &plugins.loaded,
        Some(catalog),
        None,
        lang,
    )
    .ok()?;
    let body = agents_md_body(&config, root, &plugins.loaded, &agents.catalog, None, lang).ok()?;
    let files: Vec<Collected> = vec![
        collect_agents_md(&view, &body, None, lang).ok()?,
        collect_orchestrator(&view, &config, None, lang).ok()?,
    ];
    let pending: Vec<Value> = files
        .iter()
        .filter_map(|c| c.write.as_ref())
        .map(|w| json!([w.rel_path, w.content, w.status.as_str()]))
        .collect();
    let skipped: Vec<Value> = files
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

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    // Covers: R62
    #[test]
    fn agents_md_and_orchestrator_match_prepare_codex_engine(
        text in config(), agents_md in state(), orchestrator in state(),
    ) {
        let root = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let home = root.join("home");
        write(&repo.join("navori.config.json"), &text)?;
        place(&repo, "AGENTS.md", "navori-agents", agents_md)?;
        place(&repo, ".codex/orchestrator.md", "orchestrator-codex-base", orchestrator)?;
        let reply = NODE
            .ask(&json!({ "root": repo, "home": home }))
            .map_err(TestCaseError::fail)?;
        prop_assume!(reply.get("threw").is_none());
        let rust = rust_files(&repo, &text, &home.join("models_cache.json"))
            .ok_or_else(|| fail("unexpected delegate"))?;
        prop_assert!(reply == rust, "{text}\n{}", support::first_difference(&reply, &rust));
    }
}

fn sentence() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        3 => "[a-z ]{0,8}".prop_map(|s| s),
        2 => prop::sample::select(vec!["Use ", ". ", ".", ",", "Use when", " .", "\n", "é", "\u{a0}"])
            .prop_map(str::to_owned),
    ];
    prop::collection::vec(piece, 0..8).prop_map(|p| p.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    // Covers: R62
    #[test]
    fn compact_description_matches_ts(text in sentence()) {
        let reply = NODE.ask(&json!({ "compact": text })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!(compact_agent_description(&text)), "{:?}", text);
    }
}
