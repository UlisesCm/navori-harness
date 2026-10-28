//! `navori_core::render::removable` and `retirements` against the real TS (spec 0058 T14): the
//! authorship verdict file by file, and the removals and `kept …` notes `prepareClaudeEngine`
//! plans for disabled plugins' scripts, removed, orphaned and retired skills, retired hooks and
//! agents and flat skill twins, over files navori wrote (old, current or newer), edited, foreign,
//! symlinked, sharing a directory, or JSON it generated.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::claude_files::collect_claude_files;
use navori_core::render::collect::RepoView;
use navori_core::render::context::Lang;
use navori_core::render::harness_files::{collect_harness_files, filter_inventory};
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::plugins::{RETIRED_PLUGINS, load_disabled_plugins, load_enabled_plugins};
use navori_core::render::presets::load_preset;
use navori_core::render::removable::navori_authorship;
use navori_core::render::retirements::{
    RETIRED_AGENTS, RETIRED_HOOKS, RETIRED_SKILLS, RetirementInput, plan_retirements,
};
use navori_core::render::sub_blocks::{SubBlockCtx, apply_sub_blocks};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst m = await import({:?});\nconst c = await import({:?});\n\
         const r = await import({:?});\nconst h = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("lib/render/removable.ts"),
        cli_module("engines/shared/harness-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'registry') {\n\
       const row = (x) => [x.id, x.successor, x.markerIdByAdapter.claude ?? null];\n\
       return [h.RETIRED_SKILLS.map(row), h.RETIRED_HOOKS.map(row), h.RETIRED_AGENTS.map(row)];\n\
     }\n\
     if (request.op === 'authorship') {\n\
       return r.navoriAuthorship(path.join(request.root, request.rel), request.marker ?? undefined,\n\
         request.verify ? { verifyHash: true } : undefined);\n\
     }\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const result = prepared.commit();\n\
       const inScope = (rel) => /^\\.claude\\/(skills|hooks|agents|scripts)(\\/|$)/.test(rel);\n\
       const ours = (w) => (w.startsWith('kept ') && !w.includes(' \\u2014 retired block '))\n\
         || w.includes('registrado en .claude/settings.json') || w.includes('registered in .claude/settings.json');\n\
       return {\n\
         settingsSkipped: fin.skipped.some((s) => s.path === '.claude/settings.json'),\n\
         report: {\n\
           removals: fin.removals.map((x) => [path.relative(root, x.path), x.recursive === true]).filter((x) => inScope(x[0])),\n\
           warnings: result.warnings.filter(ours),\n\
         },\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-retirements-{}", std::process::id()))
});

struct Disk<'a>(&'a Path);

impl RepoView for Disk<'_> {
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(rel)).ok()
    }

    fn read_regular(&self, rel: &str) -> Option<String> {
        let path = self.0.join(rel);
        if !std::fs::symlink_metadata(&path).ok()?.is_file() {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }

    fn exists(&self, rel: &str) -> bool {
        self.0.join(rel).exists()
    }

    fn list_dir(&self, rel: &str) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(self.0.join(rel)).ok()?;
        Some(
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect(),
        )
    }
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, text);
}

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

/// How a candidate file is written.
#[derive(Debug, Clone, Copy)]
enum Shape {
    /// A block with this id at this version (`None`: no `version=`).
    Block {
        id: Which,
        version: Option<&'static str>,
        edited: bool,
    },
    /// Text without a marker.
    Foreign,
    /// Generated JSON (`$navori.managed`).
    Json(bool, &'static str),
    /// Literal text, for marker lines the renderer never emits.
    Raw(&'static str),
    /// A symlink to a navori-looking file.
    Symlink,
    /// A directory at the path.
    Directory,
    /// `SKILL.md` with a sibling file.
    WithSibling,
}

/// Marker lines the renderer never emits (`ID` is the checked id): an empty `version=` before
/// a real one, an empty `hash=`, and a stale hash on another id's block.
const RAW: [&str; 4] = [
    "<!-- navori:managed id=\"ID\" hash=\"x\" version=\"\" source=\"s\" version=\"999.0.0\" -->\nBody\n<!-- /navori:managed id=\"ID\" -->\n",
    "<!-- navori:managed id=\"ID\" hash=\"\" version=\"0.1.0\" -->\nBody\n<!-- /navori:managed id=\"ID\" -->\n",
    "<!-- navori:managed id=\"other\" hash=\"deadbeef\" version=\"0.1.0\" -->\nBody\n<!-- /navori:managed id=\"other\" -->\n<!-- navori:managed id=\"ID\" version=\"0.1.0\" -->\nBody\n<!-- /navori:managed id=\"ID\" -->\n",
    "# navori:managed start id=\"ID\" hash=\"deadbeef\" version=\"0.1.0\"\necho\n# navori:managed end id=\"ID\"\n",
];

/// Which marker id the block carries.
#[derive(Debug, Clone, Copy)]
enum Which {
    /// The id the planner checks.
    Expected,
    /// Another id.
    Other,
}

fn shape() -> BoxedStrategy<Shape> {
    let version = prop::sample::select(vec![
        None,
        Some("0.1.0"),
        Some(STAMP_VERSION),
        Some("999.0.0"),
        Some(""),
    ]);
    prop_oneof![
        5 => (prop::sample::select(vec![Which::Expected, Which::Other]), version, prop::bool::weighted(0.3))
            .prop_map(|(id, version, edited)| Shape::Block { id, version, edited }),
        1 => Just(Shape::Foreign),
        1 => (prop::bool::ANY, prop::sample::select(vec![r#","version":"0.1.0""#, r#","version":"""#, r#","version":"999.0.0""#, ""]))
            .prop_map(|(managed, version)| Shape::Json(managed, version)),
        1 => prop::sample::select(RAW.to_vec()).prop_map(Shape::Raw),
        1 => Just(Shape::Symlink),
        1 => Just(Shape::Directory),
        1 => Just(Shape::WithSibling),
    ]
    .boxed()
}

fn block(marker: &str, shell: bool, version: Option<&str>, edited: bool) -> String {
    let meta = MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: version.map(str::to_owned),
        fm_keys: None,
        floor_version: None,
    };
    let base = if shell {
        "#!/usr/bin/env bash\n"
    } else {
        "---\nname: x\n---\n\n"
    };
    let options = InjectOptions {
        shell,
        ..InjectOptions::default()
    };
    let text = inject_managed_section(base, marker, "Navori body.", &meta, options).output;
    if edited {
        text.replacen("Navori body.", "Edited body.", 1)
    } else {
        text
    }
}

fn place(root: &Path, rel: &str, marker: &str, shape: Shape) {
    let shell = rel.ends_with(".sh");
    match shape {
        Shape::Block {
            id,
            version,
            edited,
        } => {
            let id = match id {
                Which::Expected => marker.to_owned(),
                Which::Other => format!("{marker}-other"),
            };
            write(root, rel, &block(&id, shell, version, edited));
        }
        Shape::Foreign => write(root, rel, "# mine\n"),
        Shape::Json(managed, version) => write(
            root,
            rel,
            &format!(r#"{{"$navori":{{"managed":{managed}{version}}},"x":1}}"#),
        ),
        Shape::Raw(text) => write(root, rel, &text.replace("ID", marker)),
        Shape::Symlink => {
            let real = format!("{rel}.real");
            write(root, &real, &block(marker, shell, Some("0.1.0"), false));
            if let Some(name) = Path::new(&real).file_name() {
                let _ = std::os::unix::fs::symlink(name, root.join(rel));
            }
        }
        Shape::Directory => {
            let _ = std::fs::create_dir_all(root.join(rel));
        }
        Shape::WithSibling => {
            write(root, rel, &block(marker, shell, Some("0.1.0"), false));
            if let Some(parent) = Path::new(rel).parent() {
                write(root, &parent.join("notes.md").to_string_lossy(), "mine\n");
            }
        }
    }
}

/// Candidate paths and the marker id each planner checks.
fn candidates() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let skill = |out: &mut Vec<(String, String)>, id: &str, marker: &str| {
        out.push((format!(".claude/skills/{id}.md"), marker.to_owned()));
        out.push((format!(".claude/skills/{id}/SKILL.md"), marker.to_owned()));
    };
    for id in ["formik", "socketio"] {
        skill(&mut out, id, id);
    }
    for id in [
        "axios",
        "zod-validation",
        "react-router",
        "mantine-ui-patterns",
    ] {
        skill(&mut out, id, id);
    }
    for unit in RETIRED_SKILLS.iter().take(3) {
        skill(&mut out, unit.id, unit.claude_marker);
    }
    for unit in RETIRED_HOOKS {
        out.push((
            format!(".claude/hooks/{}.sh", unit.id),
            unit.claude_marker.to_owned(),
        ));
    }
    for unit in RETIRED_AGENTS.iter().take(2) {
        out.push((
            format!(".claude/agents/{}.md", unit.id),
            unit.claude_marker.to_owned(),
        ));
    }
    // Flat twins of planned skills.
    out.push((
        ".claude/skills/review-diff.md".to_owned(),
        "review-diff-base".to_owned(),
    ));
    out.push((
        ".claude/skills/resolve-ticket.md".to_owned(),
        "resolve-ticket".to_owned(),
    ));
    // A disabled plugin's script.
    out.push((
        ".claude/scripts/guard-search-routing.sh".to_owned(),
        "tgrep-script-guard-search-routing".to_owned(),
    ));
    out
}

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""astro""#, r#""missing-preset""#, r#""vite-react-ts-mantine""#]),
        prop::collection::vec(pick(&["axios", "zod-validation", "socketio"]), 0..3),
        prop::collection::vec(pick(&["react-router", "formik"]), 0..2),
        prop::collection::vec(pick(&["pr-create", "axios", "debug-error"]), 0..2),
        pick(&["", r#","plugins":{"tgrep":{"enabled":false}}"#, r#","plugins":{"tgrep":{"enabled":true}}"#]),
        pick(&[r#""es""#, r#""en""#]),
    )
        .prop_map(|(preset, libs, extra, local, plugins, lang)| {
            format!(
                r#"{{"name":"demo","engines":["claude"],"preset":{preset},"language":{lang},"project":{{"libraries":{},"extraLibraries":{},"localSkills":{}}}{plugins}}}"#,
                json!(libs),
                json!(extra),
                json!(local),
            )
        })
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

/// A destination another step cannot read (a directory where a file goes) makes the TS throw
/// there, and the Rust port of that step delegates.
fn sub_blocks_delegate(root: &Path, text: &str) -> bool {
    let Some(config) = config::read(text.as_bytes())
        .ok()
        .map(|c| config::effective_config(&c.data))
    else {
        return false;
    };
    let plugins = match &config {
        JsValue::Object(object) => object.get("plugins").cloned(),
        _ => None,
    };
    let (Ok(enabled), Ok(disabled)) = (
        load_enabled_plugins(plugins.as_ref()),
        load_disabled_plugins(plugins.as_ref()),
    ) else {
        return true;
    };
    let view = Disk(root);
    let ctx = SubBlockCtx {
        view: &view,
        config: &config,
        lang: Lang::Es,
        ambient_floor: None,
    };
    let preset = match string_at(&config, "preset").as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok().flatten(),
    };
    let plan = filter_inventory(resolve_harness_plan(
        &config,
        preset.as_ref(),
        true,
        Some("claude"),
    ));
    collect_harness_files(&view, &plan, &config, Lang::Es, None, Some("-")).is_err()
        || collect_claude_files(&view, &config, Lang::Es, None, &enabled.loaded, None).is_err()
        || apply_sub_blocks(&ctx, &enabled.loaded, &disabled.loaded, &mut Vec::new()).is_err()
}

fn rust_plan(root: &Path, text: &str, settings_skipped: bool) -> Option<Value> {
    let config = config::effective_config(&config::read(text.as_bytes()).ok()?.data);
    let preset_id = string_at(&config, "preset");
    let preset = match preset_id.as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let preset_loaded = match preset_id.as_deref() {
        None | Some("" | "custom") => true,
        Some(id) => preset
            .as_ref()
            .is_some_and(|p| string_at(&p.def, "id").as_deref() == Some(id)),
    };
    let disabled = match &config {
        JsValue::Object(object) => load_disabled_plugins(object.get("plugins")).ok()?,
        _ => return None,
    };
    let plan = filter_inventory(resolve_harness_plan(
        &config,
        preset.as_ref(),
        true,
        Some("claude"),
    ));
    let settings = settings_skipped
        .then(|| std::fs::read_to_string(root.join(".claude/settings.json")).ok())
        .flatten();
    let input = RetirementInput {
        config: &config,
        lang: Lang::resolve(string_at(&config, "language").as_deref()),
        plan: &plan,
        preset_loaded,
        disabled: &disabled.loaded,
        skipped_settings: settings.as_deref(),
    };
    let out = plan_retirements(&Disk(root), &input).ok()?;
    Some(json!({
        "removals": out.removals.iter().map(|r| json!([r.rel_path, r.recursive])).collect::<Vec<_>>(),
        "warnings": out.warnings,
    }))
}

// Covers: R41
#[test]
fn retired_registries_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "registry" }))?;
    let row =
        |r: &navori_core::render::retirements::Retired| json!([r.id, r.successor, r.claude_marker]);
    let rust = json!([
        RETIRED_SKILLS.iter().map(row).collect::<Vec<_>>(),
        RETIRED_HOOKS.iter().map(row).collect::<Vec<_>>(),
        RETIRED_AGENTS.iter().map(row).collect::<Vec<_>>(),
    ]);
    if ts != rust {
        return Err(first_difference(&ts, &rust));
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    // Covers: R41
    #[test]
    fn authorship_matches(
        shape in shape(),
        shell in prop::bool::ANY,
        with_marker in prop::bool::weighted(0.7),
        verify in prop::bool::ANY,
        missing in prop::bool::weighted(0.05),
    ) {
        let root = BASE.join("authorship");
        let _ = std::fs::remove_dir_all(&root);
        let rel = if shell { "dir/file.sh" } else { "dir/SKILL.md" };
        if !missing {
            place(&root, rel, "unit-base", shape);
        }
        let marker = with_marker.then_some("unit-base");
        let ts = NODE
            .ask(&json!({ "op": "authorship", "root": root.to_string_lossy(), "rel": rel, "marker": marker, "verify": verify }))
            .map_err(TestCaseError::fail)?;
        let rust = navori_authorship(&Disk(&root), rel, marker, verify).as_str();
        prop_assert_eq!(ts, json!(rust), "{:?}", shape);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R41
    #[test]
    fn retirements_match(
        config in config(),
        shapes in prop::collection::vec(prop::option::weighted(0.6, shape()), candidates().len()),
        // A hand-written settings file the render merges into, or one it must skip (broken JSON,
        // not an object), each naming the plugin script.
        settings in prop::option::weighted(0.6, pick(&[
            r#"{"hooks":{"x":"bash .claude/scripts/guard-search-routing.sh"}}"#,
            r#"{"hooks": "bash .claude/scripts/guard-search-routing.sh""#,
            r#"["guard-search-routing.sh"]"#,
        ])),
        retired_asset in prop::bool::weighted(0.05),
    ) {
        let root = BASE.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        for ((rel, marker), shape) in candidates().iter().zip(&shapes) {
            if let Some(shape) = shape {
                place(&root, rel, marker, *shape);
            }
        }
        if let Some(settings) = &settings {
            write(&root, ".claude/settings.json", settings);
        }
        if retired_asset {
            write(&root, ".claude/scripts/check-jscpd.sh", "echo old\n");
        }
        write(&root, "navori.config.json", &config);
        let ts = NODE
            .ask(&json!({ "op": "render", "root": root.to_string_lossy() }))
            .map_err(TestCaseError::fail)?;
        let skipped = ts["settingsSkipped"].as_bool().unwrap_or(false);
        let leftover = RETIRED_PLUGINS.iter().any(|(_, p)| p.assets.iter().any(|a| root.join(a).exists()));
        match rust_plan(&root, &config, skipped) {
            Some(_) if ts.get("threw").is_some() => prop_assert!(sub_blocks_delegate(&root, &config), "ts threw: {}", ts),
            Some(rust) => prop_assert!(ts["report"] == rust, "{}\n{}\n{:?}", first_difference(&ts["report"], &rust), config, shapes),
            None => prop_assert!(ts.get("threw").is_some() || leftover, "rust declined, ts: {} for {}", ts, config),
        }
    }
}
