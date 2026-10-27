//! `navori_core::render::harness_files` against the real `prepareClaudeEngine` (spec 0058 T14):
//! the agents, skills and hooks it writes under `.claude/`, with a local preset, stale and newer
//! versions, hand edits, user frontmatter, markerless files adopted by name and symlinks.
//! `guard-destructive.sh` embeds the whole render's owned paths and is compared elsewhere; the
//! configs carry no plugins, whose sub-blocks rewrite these same files.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::render::collect::RepoView;
use navori_core::render::context::Lang;
use navori_core::render::harness_files::{
    CLAUDE_NATIVE_UNITS, collect_harness_files, filter_inventory,
};
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::presets::load_preset;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst m = await import({:?});\nconst c = await import({:?});\n\
         const n = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("engines/shared/native-overlap.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'native') return n.OVERLAP_ROWS.filter((r) => r.engines.claude === 'native').map((r) => `${r.unit.kind}:${r.unit.id}`);\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const inScope = (rel) => /^\\.claude\\/(agents|skills|hooks)\\//.test(rel) && !request.excluded.includes(rel);\n\
       return {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         skipped: fin.skipped.filter((s) => inScope(s.path)).map((s) => [s.path, s.reason, s.status ?? null, s.resolution ? s.resolution.content : null]),\n\
         collisions: fin.collisions.filter((x) => inScope(x.relPath)).map((x) => [x.relPath, x.overwrittenKeys]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-harness-files-{}", std::process::id()))
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
        field("implementer", flag()),
        field("reviewer", flag()),
        field("scout", flag()),
        field("publisher", flag()),
        field("planTiers", flag()),
        field("scribeOwnsMarkdown", flag()),
    ]);
    vec![
        Just(Some(r#""name":"demo","engines":["claude"]"#.to_owned())).boxed(),
        pick(&[r#""custom""#, r#""astro""#, r#""mine""#])
            .prop_map(|p| Some(format!(r#""preset":{p}"#)))
            .boxed(),
        field("language", pick(&[r#""es""#, r#""en""#])),
        field("projectName", pick(&[r#""demo""#, r#""other""#])),
        field("harness", harness),
        field(
            "project",
            pick(&[
                r#"{"libraries":["zod-validation"]}"#,
                r#"{"codeLanguage":"rust"}"#,
            ]),
        ),
        field(
            "sdd",
            pick(&[r#"{"enabled":false}"#, r#"{"enabled":true}"#]),
        ),
        field(
            "qualityGate",
            pick(&[r#"{"fast":"bun run check:fast","full":"bun run check"}"#]),
        ),
        field("hooks", pick(&[r#"{"verifyOnStop":true}"#])),
    ]
    .prop_map(|fields| {
        format!(
            "{{{}}}",
            fields.into_iter().flatten().collect::<Vec<_>>().join(",")
        )
    })
    .boxed()
}

#[derive(Debug, Clone)]
struct Recipe {
    baseline: Option<String>,
    restamp: Option<&'static str>,
    edits: Vec<(u8, u8)>,
}

fn recipe() -> BoxedStrategy<Recipe> {
    (
        prop::option::weighted(0.85, config()),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        prop::collection::vec((0u8..6, 0u8..40), 0..5),
    )
        .prop_map(|(baseline, restamp, edits)| Recipe {
            baseline,
            restamp,
            edits,
        })
        .boxed()
}

fn local_preset(root: &Path) {
    write(
        root,
        ".navori/presets/mine/mine.json",
        r#"{"id":"mine","displayName":"Mine",
            "extras":{"agents":[{"id":"designer","relPath":"agents/designer.md","destRelPath":".claude/agents/designer.md"}],
                      "skills":[{"id":"house-style","relPath":"./skills//house.md","destRelPath":".claude/skills/house-style/SKILL.md","condition":"sdd.enabled"}]}}"#,
    );
    write(
        root,
        ".navori/presets/mine/agents/designer.md",
        "---\nname: designer\ndescription: Designs {{projectName}}\ntools: Read, Grep\n---\n\nDesign carefully.\n<!-- navori:user-section -->\nNotes.\n",
    );
    write(
        root,
        ".navori/presets/mine/skills/house.md",
        "---\nname: house-style\n---\n\nHouse style for {{projectName}}.\n",
    );
}

/// Hooks this step does not finalize: `guard-destructive` (the whole render's owned paths) and
/// the hooks of `crates/ported.json`, which the native wiring rewrites afterwards.
static EXCLUDED: LazyLock<Vec<String>> = LazyLock::new(|| {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ported.json");
    let ported: Value = std::fs::read_to_string(manifest)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let mut ids: Vec<String> = ported["hooks"]
        .as_object()
        .map(|hooks| hooks.keys().cloned().collect())
        .unwrap_or_default();
    ids.push("guard-destructive".to_owned());
    ids.iter()
        .map(|id| format!(".claude/hooks/{id}.sh"))
        .collect()
});

fn in_scope(rel: &str) -> bool {
    !EXCLUDED.iter().any(|excluded| excluded == rel)
}

fn rust_files(root: &Path, text: &str, floor: Option<&str>) -> Option<Value> {
    let config = config::effective_config(&config::read(text.as_bytes()).ok()?.data);
    let preset_id = match &config {
        JsValue::Object(object) => match object.get("preset") {
            Some(JsValue::String(id)) => id.to_rust(),
            _ => None,
        },
        _ => None,
    };
    let preset = match preset_id.as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let language = match &config {
        JsValue::Object(object) => match object.get("language") {
            Some(JsValue::String(lang)) => lang.to_rust(),
            _ => None,
        },
        _ => None,
    };
    let plan = filter_inventory(resolve_harness_plan(
        &config,
        preset.as_ref(),
        true,
        Some("claude"),
    ));
    let files = collect_harness_files(
        &Disk(root),
        &plan,
        &config,
        Lang::resolve(language.as_deref()),
        floor,
        None,
    )
    .ok()?;
    Some(json!({
        "pending": files.pending.iter().filter(|w| in_scope(&w.rel_path)).map(|w| json!([w.rel_path, w.content, w.status.as_str(), w.chmod_exec])).collect::<Vec<_>>(),
        "skipped": files.skipped.iter().filter(|s| in_scope(&s.rel_path)).map(|s| json!([s.rel_path, s.reason, s.status.as_str(), s.resolution])).collect::<Vec<_>>(),
        "collisions": files.collisions.iter().filter(|(p, _)| in_scope(p)).map(|(p, k)| json!([p, k])).collect::<Vec<_>>(),
    }))
}

fn build_repo(root: &Path, recipe: &Recipe) {
    let _ = std::fs::remove_dir_all(root);
    local_preset(root);
    let Some(baseline) = recipe.baseline.as_deref() else {
        return;
    };
    let Some(Value::Array(files)) = rust_files(root, baseline, None).map(|v| v["pending"].clone())
    else {
        return;
    };
    let mut files: Vec<(String, String)> = files
        .iter()
        .filter_map(|f| Some((f[0].as_str()?.to_owned(), f[1].as_str()?.to_owned())))
        .collect();
    for (_, text) in &mut files {
        if let Some(version) = recipe.restamp {
            *text = text.replace(
                &format!("version=\"{STAMP_VERSION}\""),
                &format!("version=\"{version}\""),
            );
        }
    }
    let count = files.len().max(1);
    for (kind, index) in &recipe.edits {
        let Some((rel, text)) = files.get_mut(usize::from(*index) % count) else {
            continue;
        };
        match kind {
            0 => *text = text.replacen("-->\n", "-->\nHand edit.\n", 1),
            1 => *text = text.replacen("---\n", "---\nowner: me\n", 1),
            2 => "---\nname: foreign\nmodel: opus\n---\n\nMine.\n".clone_into(text),
            3 => *text = format!("{text}\nUser tail.\n"),
            4 => *text = String::new(),
            // A hand-edited file reached through a symlink: kept, never resolvable.
            _ => {
                *rel = format!("{rel}.symlink");
                *text = text.replacen("-->\n", "-->\nHand edit.\n", 1);
            }
        }
    }
    for (rel, text) in &files {
        if let Some(target) = rel.strip_suffix(".symlink") {
            write(root, &format!("{target}.real"), text);
            let name = Path::new(target)
                .file_name()
                .map(|n| format!("{}.real", n.to_string_lossy()));
            if let Some(name) = name {
                let _ = std::os::unix::fs::symlink(name, root.join(target));
            }
        } else if !text.is_empty() {
            write(root, rel, text);
        }
    }
}

// Covers: R41
#[test]
fn claude_has_no_native_units() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "native" }))?;
    if ts != json!(CLAUDE_NATIVE_UNITS) {
        return Err(format!(
            "native-overlap matrix drifted; update CLAUDE_NATIVE_UNITS: {ts}"
        ));
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Covers: R41
    #[test]
    fn harness_files_match(
        config in config(),
        recipe in recipe(),
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        same_config in prop::bool::weighted(0.3),
    ) {
        let root = BASE.join("repo");
        let recipe = if same_config { Recipe { baseline: Some(config.clone()), ..recipe } } else { recipe };
        build_repo(&root, &recipe);
        write(&root, "navori.config.json", &config);
        let ts = NODE
            .ask(&json!({
                "op": "files", "root": root.to_string_lossy(), "floor": floor,
                "excluded": *EXCLUDED,
            }))
            .map_err(TestCaseError::fail)?;
        match rust_files(&root, &config, floor) {
            Some(rust) => prop_assert!(ts == rust, "{}\n{}\n{:?}", first_difference(&ts, &rust), config, recipe),
            None => prop_assert!(ts.get("threw").is_some(), "rust declined, ts: {} for {}", ts, config),
        }
    }
}
