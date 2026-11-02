//! `navori_core::render::codex_config` against the real `build-config-toml.ts` (spec 0059 T19,
//! D37): the `.codex/config.toml` body and its warnings must match for generated configs, plugins,
//! workspace subpaths, `AGENTS.md` sizes around Codex's default cap and a main profile on disk.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::codex_config::build_codex_config_toml;
use navori_core::render::plugins::{LoadedPlugin, PluginScript};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const t = await import({:?});",
        cli_module("engines/codex/build-config-toml.ts")
    )
}

// `defaultCodexCatalogPath()` reads `CODEX_HOME` on every call, so the case sets it per request.
static NODE: Shared = Shared::new(
    prelude,
    "process.env.CODEX_HOME = request.home;\n\
     return t.buildCodexConfigToml(request.config, request.plugins, request.ws, request.bytes, request.cwd ?? undefined);",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-config-{}", std::process::id()))
});
static CASE: AtomicUsize = AtomicUsize::new(0);

fn fail(error: impl ToString) -> TestCaseError {
    TestCaseError::fail(error.to_string())
}

fn case_dir() -> Result<PathBuf, TestCaseError> {
    let dir = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(fail)?;
    Ok(dir)
}

fn write(path: &Path, text: &str) -> Result<(), TestCaseError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    std::fs::write(path, text).map_err(fail)
}

fn to_js(value: &Value) -> Result<JsValue, TestCaseError> {
    navori_core::js_json::parse(&value.to_string()).ok_or_else(|| fail("generated JSON"))
}

fn insert(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    }
}

fn flag() -> impl Strategy<Value = Option<Value>> {
    prop_oneof![
        3 => Just(None),
        2 => Just(Some(json!(true))),
        1 => Just(Some(json!(false))),
    ]
}

fn pick(options: Vec<&'static str>) -> impl Strategy<Value = Option<Value>> {
    prop::option::of(prop::sample::select(options).prop_map(|v| json!(v)))
}

fn config() -> impl Strategy<Value = Value> {
    (
        (
            pick(vec!["opus", "sonnet", "haiku"]),
            pick(vec!["low", "medium", "high", "max"]),
            prop::option::of((
                pick(vec!["sol", "luna", "gpt-6.2-sol", "nova"]),
                pick(vec!["low", "xhigh"]),
            )),
            pick(vec!["luna", "gpt-6-custom", ""]),
        ),
        (flag(), flag(), flag(), flag(), flag(), flag()),
    )
        .prop_map(
            |((tier, effort, profile, map), (fast, scribe, master, tiers, codex, stop))| {
                let mut models = serde_json::Map::new();
                insert(&mut models, "orchestrator", tier);
                if let Some(map) = map {
                    models.insert("codexMap".to_owned(), json!({ "opus": map, "sonnet": map }));
                }
                if let Some((model, effort)) = profile {
                    let mut entry = serde_json::Map::new();
                    insert(&mut entry, "model", model);
                    insert(&mut entry, "effort", effort);
                    models.insert("codexProfiles".to_owned(), json!({ "orchestrator": entry }));
                }
                let mut config = serde_json::Map::new();
                config.insert("engines".to_owned(), json!(["codex"]));
                if !models.is_empty() {
                    config.insert("models".to_owned(), Value::Object(models));
                }
                if let Some(effort) = effort {
                    config.insert("effort".to_owned(), json!({ "orchestrator": effort }));
                }
                let mut gate = serde_json::Map::new();
                insert(
                    &mut gate,
                    "fast",
                    fast.map(|f| {
                        if f == json!(true) {
                            json!("bun run check:fast")
                        } else {
                            json!("")
                        }
                    }),
                );
                config.insert("qualityGate".to_owned(), Value::Object(gate));
                let mut harness = serde_json::Map::new();
                insert(&mut harness, "scribeOwnsMarkdown", scribe);
                insert(&mut harness, "masterPlan", master);
                insert(&mut harness, "planTiers", tiers);
                insert(&mut harness, "codexIntegration", codex);
                config.insert("harness".to_owned(), Value::Object(harness));
                let mut hooks = serde_json::Map::new();
                insert(&mut hooks, "verifyOnStop", stop);
                config.insert("hooks".to_owned(), Value::Object(hooks));
                Value::Object(config)
            },
        )
}

/// A plugin as both sides read it: id, optional `mcpServer` (with or without `env`), optional
/// `externalTool` and script destinations (collisions included).
fn plugin() -> impl Strategy<Value = Value> {
    (
        prop::sample::select(vec!["tgrep", "engram", "codegraph", "a-b"]),
        prop::option::of((
            prop::sample::select(vec!["npx", "engram", "a \"q\" \\ $x"]),
            prop::collection::vec(prop::sample::select(vec!["mcp", "--flag", "é", "\u{2028}"]), 0..3),
            prop::option::of(prop::collection::vec(
                (
                    prop::sample::select(vec!["KEY", "A B", "π"]),
                    prop::sample::select(vec!["1", "x\"y", ""]),
                ),
                0..3,
            )),
        )),
        any::<bool>(),
        prop::collection::vec(prop::sample::select(vec!["run.sh", "guard.sh"]), 0..2),
    )
        .prop_map(|(id, server, external, scripts)| {
            let mut manifest = serde_json::Map::new();
            manifest.insert("id".to_owned(), json!(id));
            if let Some((command, args, env)) = server {
                let mut server = json!({ "command": command, "args": args });
                if let Some(env) = env {
                    let env: serde_json::Map<String, Value> =
                        env.into_iter().map(|(k, v)| (k.to_owned(), json!(v))).collect();
                    server["env"] = Value::Object(env);
                }
                manifest.insert("mcpServer".to_owned(), server);
            }
            if external {
                manifest.insert("externalTool".to_owned(), json!({ "name": id }));
            }
            json!({
                "manifest": manifest,
                "scriptAssets": scripts.iter().map(|dest| json!({ "dest": dest })).collect::<Vec<_>>(),
            })
        })
}

fn loaded(plugin: &Value) -> Result<LoadedPlugin, TestCaseError> {
    let scripts = plugin["scriptAssets"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| PluginScript {
                    src: String::new(),
                    dest: item["dest"].as_str().unwrap_or_default().to_owned(),
                    exec: false,
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(LoadedPlugin {
        dir: String::new(),
        manifest: to_js(&plugin["manifest"])?,
        native_hook_omitted: false,
        managed_assets: Vec::new(),
        script_assets: scripts,
        hook_extension_assets: Vec::new(),
        skill_assets: Vec::new(),
    })
}

fn block(body: &str) -> String {
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
    inject_managed_section("", "codex-config-base", body, &meta, options).output
}

/// The main `.codex/config.toml` on disk: absent, navori's only, or with user keys around it.
fn main_doc() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        2 => Just(None),
        1 => Just(Some(block("model = \"gpt-7-sol\"\nmodel_reasoning_effort = \"high\""))),
        1 => Just(Some(format!("model = \"user-model\"\n{}", block("sandbox_mode = \"x\"")))),
        1 => Just(Some(format!("model_reasoning_effort = \"low\"\n{}", block("model = \"gpt-5-sol\"")))),
        1 => Just(Some("= broken\n".to_owned())),
    ]
}

fn catalog() -> impl Strategy<Value = Option<&'static str>> {
    prop::option::of(prop::sample::select(vec![
        r#"{"models":[{"slug":"gpt-6.1-sol"},{"slug":"gpt-6-luna"}]}"#,
        r#"{"models":[{"slug":"gpt-6.3-luna"}]}"#,
        r#"{"models":[]}"#,
    ]))
}

fn bytes() -> impl Strategy<Value = u64> {
    prop_oneof![
        2 => prop::sample::select(vec![0_u64, 32767, 32768, 32769, 57343, 57344, 57345, 1_000_000]),
        1 => 30000_u64..70000,
    ]
}

fn ws() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec![
        "",
        "",
        "apps/web",
        "a b",
        "a\"b",
        "$x",
        "`c`",
        "é/ñ",
        "back\\slash",
    ])
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(800))]

    // Covers: R62, R66
    #[test]
    fn codex_config_matches_build_config_toml(
        config in config(), plugins in prop::collection::vec(plugin(), 0..3), ws in ws(),
        bytes in bytes(), main in main_doc(), catalog in catalog(), with_cwd in prop::bool::weighted(0.8),
    ) {
        let dir = case_dir()?;
        let home = dir.join("home");
        if let Some(catalog) = catalog {
            write(&home.join("models_cache.json"), catalog)?;
        }
        let cwd = dir.join("repo");
        std::fs::create_dir_all(&cwd).map_err(fail)?;
        if let Some(main) = &main {
            write(&cwd.join(".codex/config.toml"), main)?;
        }
        let loaded = plugins.iter().map(loaded).collect::<Result<Vec<_>, _>>()?;
        let rust = build_codex_config_toml(
            &to_js(&config)?, &loaded, ws, bytes, with_cwd.then_some(cwd.as_path()),
            Some(&home.join("models_cache.json")),
        ).ok_or_else(|| fail("unexpected delegate"))?;
        let reply = NODE.ask(&json!({
            "home": home, "config": config, "plugins": plugins, "ws": ws, "bytes": bytes,
            "cwd": with_cwd.then_some(&cwd),
        })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!({ "body": rust.body, "warnings": rust.warnings }));
    }
}
