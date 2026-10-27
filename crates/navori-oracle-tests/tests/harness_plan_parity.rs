//! `navori_core::render::harness_plan` against the real `resolveHarnessPlan` (spec 0058 T14):
//! agents, skills and hooks for every engine scope, with bundled and local presets (conditioned
//! extras, ids colliding with core skills), libraries and the config flags that add hooks.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::config;
use navori_core::render::harness_plan::{AssetRef, resolve_harness_plan};
use navori_core::render::presets::{AssetRoot, load_preset};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const h = await import({:?});\nconst c = await import({:?});\nconst p = await import({:?});\n\
         const b = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/shared/harness-plan.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("lib/config/presets.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "try {\n\
       const config = c.effectiveConfig(c.readConfig(path.join(request.root, 'navori.config.json')));\n\
       const preset = config.preset && config.preset !== 'custom' ? p.loadPreset(config.preset, request.root) : null;\n\
       const core = path.resolve(b.getCoreRoot(), 'core-assets');\n\
       const ref = (abs) => abs.startsWith(core + path.sep)\n\
         ? 'core:' + path.relative(core, abs).split(path.sep).join('/')\n\
         : 'local:' + path.relative(preset.assetRoot, abs).split(path.sep).join('/');\n\
       const plan = h.resolveHarnessPlan(config, core, preset, { includeOrchestrator: request.orchestrator, engine: request.engine ?? undefined });\n\
       return {\n\
         agents: plan.agents.map((a) => [a.id, ref(a.assetPath), a.managedId, a.modelKey ?? null, a.sandbox ?? null]),\n\
         skills: plan.skills.map((s) => [s.id, ref(s.assetPath), s.managedId]),\n\
         hooks: plan.hooks.map((x) => [x.id, ref(x.assetPath), x.managedId, x.mainThreadOnly === true]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

/// A repo root with a local preset whose extras carry conditions and ids that collide.
static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    let root = std::env::temp_dir().join(format!("navori-harness-plan-{}", std::process::id()));
    let write = |rel: &str, text: &str| {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, text);
    };
    write(
        ".navori/presets/mine/mine.json",
        r#"{"id":"mine","displayName":"Mine","libraries":["zod-validation","unknown-lib"],
            "extras":{"agents":[{"id":"designer","relPath":"./agents//designer.md","destRelPath":".claude/agents/designer.md"},
                                {"id":"gated","relPath":"agents/gated.md","destRelPath":".claude/agents/gated.md","condition":"harness.planTiers"},
                                {"id":"always","relPath":"agents/always.md","destRelPath":".claude/agents/always.md","condition":""}],
                      "skills":[{"id":"review-diff","relPath":"skills/dup.md","destRelPath":".claude/skills/review-diff/SKILL.md"},
                                {"id":"house-style","relPath":"skills/house.md","destRelPath":".claude/skills/house-style/SKILL.md","condition":"sdd.enabled"},
                                {"id":"house-style","relPath":"skills/twice.md","destRelPath":".claude/skills/house-style/SKILL.md"}]}}"#,
    );
    root
});

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
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

fn config() -> BoxedStrategy<String> {
    let flag = || pick(&["true", "false"]);
    let harness = object(vec![
        field("orchestrator", flag()),
        field("implementer", flag()),
        field("reviewer", flag()),
        field("scout", flag()),
        field("publisher", flag()),
        field("architect", flag()),
        field("planTiers", flag()),
    ]);
    let project = object(vec![
        field(
            "libraries",
            pick(&[r#"["zod","tanstack-query"]"#, r#"["astro-islands"]"#, "[]"]),
        ),
        field(
            "extraLibraries",
            pick(&[r#"["zod-validation","stripe"]"#, r#"["review-diff"]"#]),
        ),
    ]);
    vec![
        Just(Some(r#""name":"demo","engines":["claude"]"#.to_owned())).boxed(),
        pick(&[
            r#""custom""#,
            r#""astro""#,
            r#""vite-react-ts-mantine""#,
            r#""fastapi-python""#,
            r#""mine""#,
            r#""missing-x""#,
        ])
        .prop_map(|p| Some(format!(r#""preset":{p}"#)))
        .boxed(),
        field("harness", harness),
        field("project", project),
        field(
            "sdd",
            pick(&[r#"{"enabled":false}"#, r#"{"enabled":true}"#]),
        ),
        field(
            "qualityGate",
            pick(&[r#"{"fast":"bun run check:fast","full":"bun run check"}"#]),
        ),
        field(
            "hooks",
            pick(&[r#"{"verifyOnStop":true}"#, r#"{"verifyOnStop":false}"#]),
        ),
    ]
    .prop_map(|fields| {
        format!(
            "{{{}}}",
            fields.into_iter().flatten().collect::<Vec<_>>().join(",")
        )
    })
    .boxed()
}

fn asset(asset: &AssetRef) -> String {
    match asset.root {
        AssetRoot::Bundled => format!("core:{}", asset.rel),
        AssetRoot::Local(_) => format!("local:{}", asset.rel),
    }
}

fn rust_plan(root: &Path, text: &str, orchestrator: bool, engine: Option<&str>) -> Option<Value> {
    let config = config::read(text.as_bytes()).ok()?.data;
    let config = config::effective_config(&config);
    let preset_id = match &config {
        navori_core::js_json::JsValue::Object(object) => match object.get("preset") {
            Some(navori_core::js_json::JsValue::String(id)) => id.to_rust(),
            _ => None,
        },
        _ => None,
    };
    let preset = match preset_id.as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let plan = resolve_harness_plan(&config, preset.as_ref(), orchestrator, engine);
    Some(json!({
        "agents": plan.agents.iter().map(|a| json!([a.id, asset(&a.asset), a.managed_id, a.model_key, a.sandbox])).collect::<Vec<_>>(),
        "skills": plan.skills.iter().map(|s| json!([s.id, asset(&s.asset), s.managed_id])).collect::<Vec<_>>(),
        "hooks": plan.hooks.iter().map(|h| json!([h.id, asset(&h.asset), h.managed_id, h.main_thread_only])).collect::<Vec<_>>(),
    }))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(800))]

    // Covers: R41
    #[test]
    fn harness_plan_matches(
        config in config(),
        orchestrator in any::<bool>(),
        engine in prop::sample::select(vec![None, Some("claude"), Some("codex"), Some("pi")]),
    ) {
        let root = ROOT.clone();
        std::fs::write(root.join("navori.config.json"), &config).map_err(|e| TestCaseError::fail(e.to_string()))?;
        let ts = NODE
            .ask(&json!({ "root": root.to_string_lossy(), "orchestrator": orchestrator, "engine": engine }))
            .map_err(TestCaseError::fail)?;
        match rust_plan(&root, &config, orchestrator, engine) {
            Some(rust) => prop_assert_eq!(ts, rust, "{}", config),
            None => prop_assert!(ts.get("threw").is_some(), "rust declined, ts: {} for {}", ts, config),
        }
    }
}
