//! `navori_core::render::codex_orphans` against the real `prepareCodexEngine` (spec 0059 T19):
//! the removals and kept orphans of the Codex scans must match for agents, skill directories,
//! policy sidecars, hooks and plugin scripts that are navori's and pristine, hand-edited, carry
//! the user's text, newer or foreign. Hooks and scripts are seeded by a real render with
//! everything on, so a pristine copy is navori's exact bytes.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::codex_hooks::codex_installed_scripts;
use navori_core::render::codex_orphans::collect_codex_orphans;
use navori_core::render::collect::DiskView;
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::plugins::load_enabled_plugins;
use navori_core::render::presets::load_preset;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?}); const c = await import({:?}); const path = await import('node:path'); const fs = await import('node:fs');",
        cli_module("engines/codex/index.ts"),
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const plan = (root, text) => {\n\
       fs.writeFileSync(path.join(root, 'navori.config.json'), text);\n\
       const prepared = e.prepareCodexEngine(root, c.readConfig(path.join(root, 'navori.config.json')), { dryRun: true });\n\
       prepared.inventory.seal();\n\
       return prepared.finalize();\n\
     };\n\
     try {\n\
       if (request.seed) {\n\
         for (const p of plan(request.root, request.seed).pending) {\n\
           if (!/^\\.codex\\/(hooks|scripts)\\//.test(p.relPath)) continue;\n\
           fs.mkdirSync(path.dirname(p.path), { recursive: true });\n\
           fs.writeFileSync(p.path, p.content);\n\
         }\n\
         return null;\n\
       }\n\
       const fin = plan(request.root, request.config);\n\
       return {\n\
         removals: fin.removals.map((r) => [path.relative(request.root, r.path), r.recursive === true]),\n\
         kept: fin.kept.map((k) => [path.isAbsolute(k.path) ? path.relative(request.root, k.path) : k.path, k.reason]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-orphans-{}", std::process::id()))
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

fn block(id: &str, version: &str, shell: bool) -> String {
    let meta = MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some(version.to_owned()),
        fm_keys: None,
        floor_version: None,
    };
    let options = InjectOptions {
        shell,
        ..InjectOptions::default()
    };
    inject_managed_section("", id, "Body.", &meta, options).output
}

/// A markerful or foreign file of one of the hand-built orphan kinds.
#[derive(Debug, Clone, Copy)]
enum State {
    Missing,
    Ours,
    Edited,
    Newer,
    Foreign,
}

fn place(path: &Path, id: &str, shell: bool, state: State) -> Result<(), TestCaseError> {
    match state {
        State::Missing => Ok(()),
        State::Ours => write(path, &block(id, "0.1.0", shell)),
        State::Edited => write(
            path,
            &block(id, "0.1.0", shell).replacen("Body.", "Mine.", 1),
        ),
        State::Newer => write(path, &block(id, "999.0.0", shell)),
        State::Foreign => write(path, "mine\n"),
    }
}

/// What happens to a seeded hook or script before the render under test.
#[derive(Debug, Clone, Copy)]
enum Tamper {
    None,
    UserLine,
    EditedBody,
    Signature,
}

fn tamper(path: &Path, how: Tamper) -> Result<(), TestCaseError> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let changed = match how {
        Tamper::None => return Ok(()),
        Tamper::UserLine => format!("{text}# my own line\n"),
        Tamper::EditedBody => match text.find("set -") {
            Some(at) => format!("{}#x\n{}", &text[..at], &text[at..]),
            None => format!("{text}\n"),
        },
        Tamper::Signature => format!(
            "# navori:native-hook v=1 file=sha256:{} impl=sha256:{}\n{text}",
            "a".repeat(64),
            "b".repeat(64)
        ),
    };
    write(path, &changed)
}

fn pick(options: &[&'static str]) -> BoxedStrategy<&'static str> {
    prop::sample::select(options.to_vec()).boxed()
}

const SEED: &str = r#"{"name":"demo","preset":"custom","engines":["codex"],"language":"es","qualityGate":{"full":"bun check","fast":"bun run check:fast"},"harness":{"codexIntegration":true,"planTiers":true,"masterPlan":true,"scribeOwnsMarkdown":true},"hooks":{"verifyOnStop":true},"plugins":{"tgrep":{"enabled":true},"engram":{"enabled":true}}}"#;

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""nextjs""#]),
        prop::option::of(pick(&[
            r#"{"publisher":false}"#,
            r#"{"codexIntegration":true}"#,
            r#"{"planTiers":true,"scout":false}"#,
        ])),
        pick(&[
            r#"{}"#,
            r#"{"tgrep":{"enabled":true}}"#,
            r#"{"tgrep":{"enabled":false},"engram":{"enabled":true}}"#,
        ]),
        prop::option::of(pick(&[r#"{"full":"bun check","fast":"bun run check:fast"}"#])),
    )
        .prop_map(|(preset, harness, plugins, gate)| {
            let opt = |key: &str, value: Option<&str>| {
                value.map_or_else(String::new, |v| format!(r#","{key}":{v}"#))
            };
            format!(
                r#"{{"name":"demo","preset":{preset},"engines":["codex"],"language":"es"{}{},"plugins":{plugins}}}"#,
                opt("harness", harness),
                opt("qualityGate", gate),
            )
        })
        .boxed()
}

fn state() -> BoxedStrategy<State> {
    prop::sample::select(vec![
        State::Missing,
        State::Ours,
        State::Edited,
        State::Newer,
        State::Foreign,
    ])
    .boxed()
}

fn tamper_strategy() -> BoxedStrategy<Tamper> {
    prop::sample::select(vec![
        Tamper::None,
        Tamper::None,
        Tamper::UserLine,
        Tamper::EditedBody,
        Tamper::Signature,
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

fn rust_orphans(root: &Path, text: &str) -> Option<Value> {
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
    let installed = codex_installed_scripts(&config, &plugins.loaded)?;
    let orphans = collect_codex_orphans(
        &DiskView(root),
        root,
        &plan,
        &installed,
        &config,
        &plugins.loaded,
    )
    .ok()?;
    Some(json!({
        "removals": orphans.removals.iter().map(|r| json!([r.rel_path, r.recursive])).collect::<Vec<_>>(),
        "kept": orphans.kept.iter().map(|k| json!([k.rel_path, k.reason.as_str()])).collect::<Vec<_>>(),
    }))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(120))]

    // Covers: R62
    #[test]
    fn codex_orphans_match_prepare_codex_engine(
        text in config(), seed in any::<bool>(),
        hook_tamper in tamper_strategy(), script_tamper in tamper_strategy(),
        agent in state(), skill in state(), sidecar in state(), extra_child in any::<bool>(),
    ) {
        let root = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).map_err(fail)?;
        if seed {
            let reply = NODE.ask(&json!({ "root": root, "seed": SEED })).map_err(TestCaseError::fail)?;
            prop_assume!(reply.is_null());
            tamper(&root.join(".codex/hooks/plan-gate.sh"), hook_tamper)?;
            tamper(&root.join(".codex/scripts/guard-search-routing.sh"), script_tamper)?;
        }
        place(&root.join(".codex/agents/old-agent.toml"), "old-agent-codex-base", true, agent)?;
        place(&root.join(".agents/skills/old-skill/SKILL.md"), "old-skill-base", false, skill)?;
        if extra_child {
            write(&root.join(".agents/skills/old-skill/notes.md"), "notes\n")?;
            write(&root.join(".agents/skills/plan-simple/agents/other.yaml"), "x: 1\n")?;
        }
        place(&root.join(".agents/skills/plan-simple/agents/openai.yaml"), "plan-simple-openai-policy", true, sidecar)?;
        let reply = NODE
            .ask(&json!({ "root": root, "config": text }))
            .map_err(TestCaseError::fail)?;
        prop_assume!(reply.get("threw").is_none());
        let rust = rust_orphans(&root, &text).ok_or_else(|| fail("unexpected delegate"))?;
        prop_assert!(reply == rust, "{text}\n{}", support::first_difference(&reply, &rust));
    }
}
