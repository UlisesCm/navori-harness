//! `navori_core::render::codex_skills` against the real `prepareCodexEngine` (spec 0059 T19): the
//! `.agents/skills/**` the Codex engine plans — each skill adapted to Codex, the `openai.yaml` of a
//! manual-only skill and the retired plugin sub-blocks stripped or kept — must match over skill
//! destinations that are missing, navori's, hand-edited, newer or foreign.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::i18n::markerless_collision;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::codex_skills::{
    apply_codex_skill_sub_blocks, collect_codex_skills, collect_openai_policies,
};
use navori_core::render::collect::{Collected, DiskView, PendingWrite, SkippedFile};
use navori_core::render::context::Lang;
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::plugins::{load_disabled_plugins, load_enabled_plugins};
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
    "try {\n\
       const config = c.readConfig(path.join(request.root, 'navori.config.json'));\n\
       const prepared = e.prepareCodexEngine(request.root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const result = prepared.commit();\n\
       const inScope = (rel) => rel.startsWith('.agents/skills/');\n\
       return {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status]),\n\
         skipped: fin.skipped.filter((x) => inScope(x.path)).map((x) => [x.path, x.reason, x.status ?? null, x.resolution ? x.resolution.content : null]),\n\
         // Kept orphans belong to the orphan scans, not to these placements.\n\
         warnings: result.warnings.filter((w) => w.includes('.agents/skills/')\n\
           && !fin.kept.some((k) => w.includes(path.isAbsolute(k.path) ? path.relative(request.root, k.path) : k.path))),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-skills-{}", std::process::id()))
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

fn block(existing: &str, id: &str, body: &str, version: &str, shell: bool) -> String {
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
    inject_managed_section(existing, id, body, &meta, options).output
}

/// What a skill destination holds before the render.
#[derive(Debug, Clone, Copy)]
enum State {
    Missing,
    Ours,
    Edited,
    Newer,
    Foreign,
    /// navori's block plus a retired plugin sub-block, pristine.
    Retired,
    /// navori's block plus a retired plugin sub-block edited by hand.
    RetiredEdited,
}

/// Skills a test can perturb, with the retired sub-block aimed at each (if any).
const SKILLS: [(&str, Option<&str>); 5] = [
    ("review-diff", Some("jscpd-review-extension")),
    ("security-invariants", Some("semgrep-review-extension")),
    ("structural-search", Some("codegraph-search-extension")),
    ("context-intake", None),
    ("plan-simple", None),
];

fn place(root: &Path, id: &str, retired: Option<&str>, state: State) -> Result<(), TestCaseError> {
    let path = root.join(format!(".agents/skills/{id}/SKILL.md"));
    let base = format!("{id}-base");
    let ours = block("", &base, "Old body.", "0.1.0", false);
    let with_retired = |body: &str| {
        let full = block(&ours, retired.unwrap_or("x"), "Retired.", "0.1.0", false);
        full.replacen("Retired.", body, 1)
    };
    match state {
        State::Missing => Ok(()),
        State::Ours => write(&path, &ours),
        State::Edited => write(&path, &ours.replacen("Old body.", "Mine.", 1)),
        State::Newer => write(&path, &block("", &base, "Old body.", "999.0.0", false)),
        State::Foreign => write(&path, "# My skill\n"),
        State::Retired => write(&path, &with_retired("Retired.")),
        State::RetiredEdited => write(&path, &with_retired("Retired, edited.")),
    }
}

fn pick(options: &[&'static str]) -> BoxedStrategy<&'static str> {
    prop::sample::select(options.to_vec()).boxed()
}

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""nextjs""#]),
        prop::collection::vec(0u8..3, 3),
        prop::option::of(pick(&[
            r#"{"planTiers":true}"#,
            r#"{"masterPlan":true,"scribeOwnsMarkdown":true}"#,
        ])),
        pick(&[r#""es""#, r#""en""#]),
        prop::option::of(pick(&[r#"{"enabled":false}"#])),
    )
        .prop_map(|(preset, states, harness, lang, sdd)| {
            let plugins: Vec<String> = ["engram", "codegraph", "gh"]
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
                opt("sdd", sdd),
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
        State::Retired,
        State::RetiredEdited,
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

/// Splits collected files; returns the collisions as `collisionWarnings` reports them.
fn split(
    files: Vec<Collected>,
    pending: &mut Vec<PendingWrite>,
    skipped: &mut Vec<SkippedFile>,
    lang: Lang,
) -> Vec<String> {
    let mut collisions = Vec::new();
    for file in files {
        if let (Some(keys), Some(write)) = (&file.collision, &file.write) {
            collisions.push(markerless_collision(lang, &write.rel_path, keys, None));
        }
        pending.extend(file.write);
        skipped.extend(file.skip);
    }
    collisions
}

fn rust_skills(root: &Path, text: &str) -> Option<Value> {
    let read = config::read(text.as_bytes()).ok()?;
    let config = config::effective_config(&read.data);
    let preset = match string_at(&config, "preset").as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let (enabled, disabled) = match &config {
        JsValue::Object(object) => (
            load_enabled_plugins(object.get("plugins")).ok()?,
            load_disabled_plugins(object.get("plugins")).ok()?,
        ),
        _ => return None,
    };
    let plan = resolve_harness_plan(&config, preset.as_ref(), false, Some("codex"));
    let lang = Lang::resolve(string_at(&config, "language").as_deref());
    let view = DiskView(root);
    let skills = collect_codex_skills(&view, &plan.skills, &config, None, lang).ok()?;
    let policies = collect_openai_policies(&view, &skills.manual_only, None, lang).ok()?;
    let (mut pending, mut skipped) = (Vec::new(), Vec::new());
    let mut collisions = split(skills.files, &mut pending, &mut skipped, lang);
    collisions.extend(split(policies, &mut pending, &mut skipped, lang));
    let mut warnings = apply_codex_skill_sub_blocks(
        &view,
        &mut pending,
        &enabled.loaded,
        &disabled.loaded,
        &config,
        None,
        lang,
    )
    .ok()?;
    warnings.extend(collisions);
    Some(json!({
        "pending": pending.iter().map(|w| json!([w.rel_path, w.content, w.status.as_str()])).collect::<Vec<_>>(),
        "skipped": skipped.iter().map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str()), s.resolution])).collect::<Vec<_>>(),
        "warnings": warnings,
    }))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(150))]

    // Covers: R62
    #[test]
    fn codex_skills_match_prepare_codex_engine(
        text in config(), states in prop::collection::vec(state(), SKILLS.len()),
    ) {
        let root = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        let _ = std::fs::remove_dir_all(&root);
        write(&root.join("navori.config.json"), &text)?;
        for ((id, retired), state) in SKILLS.iter().zip(&states) {
            place(&root, id, *retired, *state)?;
        }
        let reply = NODE.ask(&json!({ "root": root })).map_err(TestCaseError::fail)?;
        prop_assume!(reply.get("threw").is_none());
        let rust = rust_skills(&root, &text).ok_or_else(|| fail("unexpected delegate"))?;
        prop_assert!(reply == rust, "{text}\n{}", support::first_difference(&reply, &rust));
    }
}
