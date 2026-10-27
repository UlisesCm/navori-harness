//! `navori_core::render::claude_md` against the real `prepareClaudeEngine` (spec 0058 T14), on
//! the files it owns in step 1: `CLAUDE.md` and `.claude/context/*`. Repos are built from a
//! baseline render plus edits: stale and newer versions, hand edits, user prose and markers,
//! blocks out of order (with and without interleaved prose), legacy context files and symlinks.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::markers::{
    CommentStyle, InjectOptions, MarkerMeta, USER_SECTION_START, inject_managed_section,
    locate_managed_blocks,
};
use navori_core::render::block_plan::{PlanAsset, PlanOptions, UpdateAvailable};
use navori_core::render::claude_md::{RepoView, plan_claude_md};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst m = await import({:?});\nconst b = await import({:?});\n\
         const c = await import({:?});\n\
         const fs = await import('node:fs');\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/render/bundled-assets.ts"),
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(root, config, {\n\
         dryRun: true, skipIds: new Set(request.skip), forceIds: new Set(request.force),\n\
       });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const result = prepared.commit();\n\
       const inScope = (rel) => rel === 'CLAUDE.md' || rel.startsWith('.claude/context/');\n\
       const pluginsRoot = path.dirname(b.getPluginPath('x'));\n\
       const rel = (p) => path.isAbsolute(p) ? path.relative(pluginsRoot, p).split(path.sep).join('/') : p;\n\
       const u = (x) => [x.id, x.source, x.fromVersion, x.toVersion];\n\
       return {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status]),\n\
         removals: fin.removals.map((r) => path.relative(root, r.path)).filter(inScope),\n\
         skipped: fin.skipped.filter((s) => inScope(s.path)).map((s) => [s.path, s.reason, s.status ?? null, s.resolution ? s.resolution.content : null]),\n\
         entries: result.claudeMdEntries.map((x) => [x.asset.id, rel(x.asset.relPath), x.source, x.status, x.newContent]),\n\
         warnings: result.warnings.filter((w) => w.startsWith('CLAUDE.md:')),\n\
         updates: result.updatesAvailable.map(u), downgrades: result.downgrades.map(u),\n\
         fallbacks: result.languageFallbacks,\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> =
    LazyLock::new(|| std::env::temp_dir().join(format!("navori-claude-md-{}", std::process::id())));

struct Disk<'a>(&'a Path);

impl RepoView for Disk<'_> {
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(rel)).ok()
    }

    fn read_regular(&self, rel: &str) -> Option<String> {
        let path = self.0.join(rel);
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }
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
        field("auditor", flag()),
        field("publisher", flag()),
        field("scribe", flag()),
        field("architect", flag()),
        field("planTiers", flag()),
        field("scribeOwnsMarkdown", flag()),
    ]);
    let project = object(vec![
        field(
            "posture",
            pick(&[r#""greenfield""#, r#""production""#, r#""migration""#]),
        ),
        field(
            "libraryMigrations",
            pick(&[
                r#"[{"domain":"HTTP","preferred":"ky","legacy":"axios"}]"#,
                "[]",
            ]),
        ),
        field("reviewRigor", pick(&[r#""strict""#, r#""pragmatic""#])),
        field(
            "architectureRule",
            pick(&[
                r#""hexagonal""#,
                r#""""#,
                r#""layers\n<!-- /navori:managed -->""#,
            ]),
        ),
        field(
            "criticalAreas",
            pick(&[r#"["auth","billing"]"#, r#"["",""]"#, "[]"]),
        ),
        field(
            "testsForNewCode",
            pick(&[r#""always""#, r#""when-applicable""#, r#""none""#]),
        ),
        field("testsExclude", pick(&[r#"["e2e"]"#, "[]"])),
        field("codeLanguage", pick(&[r#""rust""#, r#""typescript""#])),
    ]);
    let plugins = pick(&[
        r#"{"engram":{"enabled":true}}"#,
        r#"{"gh":{"enabled":false},"cognitive":{"enabled":true}}"#,
        "{}",
    ]);
    let monorepo = pick(&[
        r#"{"enabled":true,"workspaces":[{"name":"web","path":"apps/web"}]}"#,
        r#"{"enabled":false,"workspaces":[{"name":"web","path":"apps/web"}]}"#,
    ]);
    vec![
        field("language", pick(&[r#""es""#, r#""en""#])),
        Just(Some(r#""name":"demo","engines":["claude"]"#.to_owned())).boxed(),
        field("projectName", pick(&[r#""demo""#])),
        field("branchBase", pick(&[r#""main""#])),
        pick(&[r#""custom""#, r#""astro""#])
            .prop_map(|p| Some(format!(r#""preset":{p}"#)))
            .boxed(),
        field("harness", harness),
        field("project", project),
        field(
            "sdd",
            pick(&[r#"{"enabled":false}"#, r#"{"enabled":true}"#]),
        ),
        field(
            "blocks",
            pick(&[r#"{"exclude":["sdd"]}"#, r#"{"exclude":["orquestacion"]}"#]),
        ),
        field("plugins", plugins),
        prop::option::weighted(0.1, monorepo.prop_map(|m| format!(r#""monorepo":{m}"#))).boxed(),
    ]
    .prop_map(|fields| {
        format!(
            "{{{}}}",
            fields.into_iter().flatten().collect::<Vec<_>>().join(",")
        )
    })
    .boxed()
}

/// Edits applied to the baseline repo.
#[derive(Debug, Clone)]
struct Recipe {
    baseline: Option<String>,
    restamp: Option<&'static str>,
    hand_edit: bool,
    user_prose: u8,
    move_first: bool,
    interleave: bool,
    skills_index: Option<&'static str>,
    legacy: Option<&'static str>,
    context_edit: u8,
}

fn recipe() -> BoxedStrategy<Recipe> {
    (
        prop::option::weighted(0.85, config()),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        any::<bool>(),
        0u8..6,
        any::<bool>(),
        any::<bool>(),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        0u8..5,
    )
        .prop_map(
            |(
                baseline,
                restamp,
                hand_edit,
                user_prose,
                move_first,
                interleave,
                skills_index,
                legacy,
                context_edit,
            )| {
                Recipe {
                    baseline,
                    restamp,
                    hand_edit,
                    user_prose,
                    move_first,
                    interleave,
                    skills_index,
                    legacy,
                    context_edit,
                }
            },
        )
        .boxed()
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, text);
}

/// Builds the repo under `root` and returns nothing; every file is on disk for both sides.
fn build_repo(root: &Path, recipe: &Recipe) {
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::create_dir_all(root);
    let mut files: Vec<(String, String)> = recipe
        .baseline
        .as_deref()
        .and_then(|text| config::read(text.as_bytes()).ok())
        .and_then(|config| {
            plan_claude_md(&Disk(root), &config.data, root, &PlanOptions::default()).ok()
        })
        .map(|plan| {
            plan.pending
                .into_iter()
                .map(|w| (w.rel_path, w.content))
                .collect()
        })
        .unwrap_or_default();
    for (rel, text) in &mut files {
        if let Some(version) = recipe.restamp {
            *text = text.replace(
                &format!("version=\"{STAMP_VERSION}\""),
                &format!("version=\"{version}\""),
            );
        }
        if rel == "CLAUDE.md" {
            edit_claude_md(text, recipe);
        } else {
            match recipe.context_edit {
                0 => *text = text.replacen("-->\n", "-->\nHand edit.\n", 1),
                1 => *text = format!("{text}\nUser tail.\n"),
                _ => {}
            }
        }
    }
    for (rel, text) in &files {
        write(root, rel, text);
    }
    if let Some(version) = recipe.legacy {
        let meta = MarkerMeta {
            source: Some("@navori/core".to_owned()),
            version: Some(version.to_owned()),
            ..MarkerMeta::default()
        };
        for id in ["orquestacion", "arranque-sesion", "agentes-disponibles"] {
            let body = inject_managed_section("", id, "Legacy.\n", &meta, InjectOptions::default());
            write(root, &format!(".claude/context/{id}.md"), &body.output);
        }
    }
    if recipe.context_edit == 4 {
        // A hand-edited context file reached through a symlink: skipped, never resolvable.
        let link = root.join(".claude/context/30-arranque-sesion.md");
        if let Ok(text) = std::fs::read_to_string(&link) {
            write(
                root,
                ".claude/context/real.md",
                &text.replacen("-->\n", "-->\nHand edit.\n", 1),
            );
            let _ = std::fs::remove_file(&link);
            let _ = std::os::unix::fs::symlink("real.md", &link);
        }
    }
}

fn edit_claude_md(text: &mut String, recipe: &Recipe) {
    if recipe.hand_edit {
        *text = text.replacen("-->\n", "-->\nHand edit.\n", 1);
    }
    if let Some(version) = recipe.skills_index {
        let meta = MarkerMeta {
            source: Some("@navori/core".to_owned()),
            version: Some(version.to_owned()),
            ..MarkerMeta::default()
        };
        for (id, body) in [
            ("skills-index", "## Skills\n"),
            ("contexto-monorepo", "## Monorepo\n"),
        ] {
            *text = inject_managed_section(text, id, body, &meta, InjectOptions::default()).output;
        }
    }
    if recipe.move_first {
        let blocks = locate_managed_blocks(text, CommentStyle::Html);
        if let Some(first) = blocks.first() {
            let block = text[first.open_start..first.close_end].to_owned();
            text.replace_range(first.open_start..first.close_end, "");
            let at = blocks
                .last()
                .map_or(text.len(), |last| last.close_end - block.len());
            text.insert_str(at, &format!("\n{block}"));
        }
    }
    if recipe.interleave {
        let blocks = locate_managed_blocks(text, CommentStyle::Html);
        if let Some(second) = blocks.get(1) {
            text.insert_str(second.open_start, "Interleaved prose.\n\n");
        }
    }
    match recipe.user_prose {
        1 => text.push_str("\n## My domain\n\nUser notes.\n"),
        2 => {
            *text = text.replace(
                USER_SECTION_START,
                &format!("{USER_SECTION_START}\nKept by me.\n"),
            )
        }
        3 => *text = text.trim_end().to_owned(),
        // No user zone at all and no trailing newline.
        4 => {
            if let Some(at) = text.find(USER_SECTION_START) {
                text.truncate(at);
            }
            *text = text.trim_end().to_owned();
        }
        // Prose of a repo onboarded before the user markers existed: auto-migrated.
        5 => {
            if let Some(at) = text.find(USER_SECTION_START) {
                text.truncate(at);
            }
            text.push_str("\n## Legacy notes\n\nOld prose.\n");
        }
        _ => {}
    }
}

fn updates(list: &[UpdateAvailable]) -> Value {
    list.iter()
        .map(|u| json!([u.id, u.source, u.from_version, u.to_version]))
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(250))]

    // Covers: R41
    #[test]
    fn claude_md_and_context_files_match(
        config in config(),
        recipe in recipe(),
        skip in prop::sample::subsequence(vec!["idioma-rol", "arranque-sesion", "sdd"], 0..=3),
        force in prop::sample::subsequence(vec!["idioma-rol", "contexto-proyecto"], 0..=2),
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        same_config in prop::bool::weighted(0.3),
    ) {
        let root = BASE.join("repo");
        // Re-rendering with the config that produced the repo is the common case.
        let recipe = if same_config {
            Recipe { baseline: Some(config.clone()), ..recipe }
        } else {
            recipe
        };
        build_repo(&root, &recipe);
        write(&root, "navori.config.json", &config);
        let ts = NODE
            .ask(&json!({
                "root": root.to_string_lossy(), "config": config, "skip": skip,
                "force": force, "floor": floor,
            }))
            .map_err(TestCaseError::fail)?;
        let Ok(parsed) = config::read(config.as_bytes()).map(|c| c.data) else {
            prop_assert!(ts.get("threw").is_some(), "rust rejected the config, ts: {}", ts);
            return Ok(());
        };
        let options = PlanOptions {
            skip_ids: skip.iter().map(|s| (*s).to_owned()).collect(),
            force_ids: force.iter().map(|s| (*s).to_owned()).collect(),
            ambient_floor: floor.map(str::to_owned),
            ..PlanOptions::default()
        };
        let Ok(rust) = plan_claude_md(&Disk(&root), &parsed, &root, &options) else {
            prop_assert!(
                ts.get("threw").is_some() || config.contains(r#""enabled":true,"workspaces""#),
                "rust delegated, ts: {} for {}", ts, config
            );
            return Ok(());
        };
        let entries: Vec<Value> = rust
            .plan
            .entries
            .iter()
            .map(|e| {
                let rel = match &e.asset {
                    PlanAsset::Core(asset) => asset.rel_path.to_owned(),
                    PlanAsset::Preset { rel_path, .. } | PlanAsset::Retired { rel_path, .. } => rel_path.clone(),
                    PlanAsset::Plugin { dir, path, .. } => format!("{dir}/{path}"),
                    PlanAsset::Computed { .. } => "(computed)".to_owned(),
                };
                json!([e.asset.id(), rel, e.source, e.status.as_str(), e.new_content])
            })
            .collect();
        let rust = json!({
            "pending": rust.pending.iter().map(|w| json!([w.rel_path, w.content, w.status.as_str()])).collect::<Vec<_>>(),
            "removals": rust.removals,
            "skipped": rust.skipped.iter().map(|s| json!([s.rel_path, s.reason, s.status.as_str(), s.resolution])).collect::<Vec<_>>(),
            "entries": entries,
            "warnings": rust.warnings,
            "updates": updates(&rust.plan.updates_available),
            "downgrades": updates(&rust.plan.downgrades),
            "fallbacks": rust.plan.language_fallbacks,
        });
        prop_assert!(ts == rust, "{}\n{}\n{:?}", first_difference(&ts, &rust), config, recipe);
    }
}
