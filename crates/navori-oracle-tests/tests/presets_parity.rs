//! `navori_core::render::{presets, library_skills}` against the real TS (spec 0058 T14): every
//! bundled preset, generated local presets and the lib-skill registry.

mod support;

use std::path::PathBuf;

use navori_core::render::library_skills::{
    LIBRARY_SKILLS, REMOVED_LIB_SKILL_SUCCESSORS, REMOVED_LIB_SKILLS,
};
use navori_core::render::presets::{AssetRoot, dropped_libraries_warnings, load_preset};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const p = await import({:?});\nconst l = await import({:?});\nconst b = await import({:?});\n\
         const fs = await import('node:fs');\nconst path = await import('node:path');",
        cli_module("lib/config/presets.ts"),
        cli_module("lib/assets/library-skills.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'registry') return [l.LIBRARY_SKILLS.map((s) => [s.id, s.label]), l.REMOVED_LIB_SKILLS, Object.entries(l.REMOVED_LIB_SKILL_SUCCESSORS)];\n\
     if (request.op === 'bundled') return fs.readdirSync(path.join(b.getCoreRoot(), 'core-assets/presets')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();\n\
     if (request.local !== null) {\n\
       const dir = path.join(request.root, '.navori/presets', request.id);\n\
       fs.rmSync(path.join(request.root, '.navori'), { recursive: true, force: true });\n\
       fs.mkdirSync(dir, { recursive: true });\n\
       fs.writeFileSync(path.join(dir, `${request.id}.json`), request.local);\n\
     } else { fs.rmSync(path.join(request.root, '.navori'), { recursive: true, force: true }); }\n\
     try {\n\
       const loaded = p.loadPreset(request.id, request.root);\n\
       if (loaded === null) return { none: true };\n\
       return { def: loaded.def, source: loaded.source, dropped: loaded.droppedLibraries, warnings: p.droppedLibrariesWarnings(loaded) };\n\
     } catch (e) { if (e instanceof p.PresetError) return { error: true }; throw e; }",
);

fn rust_load(id: &str, root: &std::path::Path) -> Value {
    match load_preset(id, root) {
        Err(_) => json!({ "error": true }),
        Ok(None) => json!({ "none": true }),
        Ok(Some(loaded)) => {
            let def: Value = serde_json::from_str(&loaded.def.stringify(None).unwrap_or_default())
                .unwrap_or(Value::Null);
            let source = match loaded.asset_root {
                AssetRoot::Local(_) => "local",
                AssetRoot::Bundled => "bundled",
            };
            json!({
                "def": def,
                "source": source,
                "dropped": loaded.dropped_libraries,
                "warnings": dropped_libraries_warnings(Some(&loaded)),
            })
        }
    }
}

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "navori-presets-parity-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// Covers: R41
#[test]
fn registry_and_every_bundled_preset_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "registry" }))?;
    let rust = json!([
        LIBRARY_SKILLS,
        REMOVED_LIB_SKILLS,
        REMOVED_LIB_SKILL_SUCCESSORS
    ]);
    if ts != rust {
        return Err(format!(
            "lib-skill registry drifted; regenerate render/library_skills.rs\nts   {ts}\nrust {rust}"
        ));
    }
    let root = temp_root("bundled");
    let bundled = NODE.ask(&json!({ "op": "bundled" }))?;
    let ids: Vec<String> = serde_json::from_value(bundled).map_err(|e| e.to_string())?;
    if ids.len() < 5 {
        return Err(format!("only {} bundled presets", ids.len()));
    }
    for id in ids.iter().map(String::as_str).chain([
        "custom",
        "missing-preset",
        "../escape",
        ".",
        "..",
        "",
    ]) {
        let ts = NODE.ask(&json!({ "op": "load", "id": id, "root": root, "local": null }))?;
        let rust = rust_load(id, &root);
        // Rust declines path-like ids; the TS may load or miss them. Both stay out of native.
        if id.contains('/') || matches!(id, "" | "." | "..") {
            if rust != json!({ "error": true }) {
                return Err(format!("{id}: rust must delegate, got {rust}"));
            }
            continue;
        }
        if ts != rust {
            return Err(format!("{id}:\nts   {ts}\nrust {rust}"));
        }
    }
    Ok(())
}

// Covers: R41
#[test]
fn local_custom_manifest_is_ignored() -> Result<(), String> {
    let root = temp_root("custom");
    let local = json!({ "id": "custom", "displayName": "Custom" }).to_string();
    let ts = NODE.ask(&json!({ "op": "load", "id": "custom", "root": root, "local": local }))?;
    let rust = rust_load("custom", &root);
    if ts != json!({ "none": true }) || rust != ts {
        return Err(format!("custom:\nts   {ts}\nrust {rust}"));
    }
    Ok(())
}

fn local_preset() -> BoxedStrategy<String> {
    let extra = prop::sample::select(vec![
        json!({"id": "x", "relPath": "managed/x.md"}),
        json!({"id": "x", "relPath": "../x.md"}),
        json!({"id": "", "relPath": "x.md"}),
        json!({"id": "s", "relPath": "s.md", "destRelPath": ".claude/skills/s/SKILL.md", "condition": "project.posture", "extra": 1}),
        json!({"id": "s", "relPath": "s.md"}),
    ]);
    (
        prop_oneof![4 => Just("my-preset"), 1 => Just("other"), 1 => Just("Bad")],
        prop::option::weighted(0.9, prop_oneof![4 => Just("Mine"), 1 => Just("")]),
        prop::option::of(prop::sample::select(vec![json!("core"), json!("base")])),
        prop::option::of(prop::collection::vec(extra, 0..3)),
        prop::option::of(prop::sample::select(vec![
            json!(["zod", "axios"]),
            json!(["unknown-lib", "axios", "nope"]),
            json!([""]),
        ])),
        prop::sample::select(vec!["", "\u{feff}", "{"]),
    )
        .prop_map(|(id, display, extends, skills, libraries, prefix)| {
            let mut def = json!({ "id": id, "invariants": ["must stay"] });
            if let Some(display) = display {
                def["displayName"] = json!(display);
            }
            if let Some(extends) = extends {
                def["extends"] = extends;
            }
            if let Some(skills) = skills {
                def["extras"] = json!({ "skills": skills });
            }
            if let Some(libraries) = libraries {
                def["libraries"] = libraries;
            }
            format!("{prefix}{def}")
        })
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    // Covers: R41
    #[test]
    fn local_presets_match(text in local_preset()) {
        let root = temp_root("local");
        let ts = NODE
            .ask(&json!({ "op": "load", "id": "my-preset", "root": root, "local": text }))
            .map_err(TestCaseError::fail)?;
        let rust = rust_load("my-preset", &root);
        prop_assert_eq!(ts, rust, "{}", text);
    }
}
