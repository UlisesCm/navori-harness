//! `navori_core::render::ignore_files` against the real `renderGitignore`, `ensurePrettierIgnore`
//! and `scanOrphanedEngineOutputs` (spec 0058 E3 M6): every `gitignoreHarness` mode, search
//! plugins, each prettier signal, files with and without the block, hand edits, newer stamps,
//! user rules that already cover the harness, `force`, the floor and orphaned engine outputs.
//! The TS reports no content in a dry run, so it writes into the scratch repo (backups go to a
//! scratch `NAVORI_BACKUP_ROOT`) after Rust planned on the pristine tree, and the file is read back.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::js_json;
use navori_core::render::collect::DiskView;
use navori_core::render::context::Lang;
use navori_core::render::ignore_files::{
    ENGINE_OUTPUTS, IgnoreFile, engine_output_paths, engine_owned_paths, plan_gitignore,
    plan_prettierignore, scan_orphaned_engine_outputs,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const gi = await import({:?});\nconst pi = await import({:?});\nconst h = await import({:?});\nconst m = await import({:?});\nconst fs = await import('node:fs');\nconst path = await import('node:path');",
        cli_module("engines/shared/gitignore-harness.ts"),
        cli_module("engines/shared/prettierignore-harness.ts"),
        cli_module("lib/diagnose/health.ts"),
        cli_module("lib/render/marker.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'table') return [\n\
       h.ENGINE_OUTPUTS.map((e) => [e.engine, h.engineOwnedPaths(e.engine)]),\n\
       gi.engineOutputPaths(h.ENGINE_OUTPUTS.map((e) => e.engine)),\n\
     ];\n\
     process.env.NAVORI_BACKUP_ROOT = request.backups;\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const one = (fn) => {\n\
         try {\n\
           const r = fn();\n\
           if (r === null) return null;\n\
           const written = r.status === 'created' || r.status === 'updated';\n\
           const content = written ? fs.readFileSync(path.join(request.root, r.path), 'utf-8') : null;\n\
           return [r.path, r.status, content, r.skippedReason ?? null, r.entries ?? []];\n\
         } catch (err) { return 'threw'; }\n\
       };\n\
       const options = { dryRun: false, force: request.force, lang: request.lang };\n\
       return [\n\
         one(() => gi.renderGitignore(request.root, request.config, options)),\n\
         one(() => pi.ensurePrettierIgnore(request.root, request.config, options)),\n\
         h.scanOrphanedEngineOutputs(request.root, request.config).map((o) => [o.engine, o.paths]),\n\
       ];\n\
     } finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-ignore-files-{}", std::process::id()))
});

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, text);
}

/// What a harness ignore file holds before the render.
#[derive(Debug, Clone, Copy)]
enum State {
    Absent,
    UserOnly,
    /// User rules that already cover the Claude outputs (`.prettierignore` only matters).
    Covering,
    Fresh,
    Stale,
    Edited,
    Newer,
    Directory,
}

fn state() -> BoxedStrategy<State> {
    prop::sample::select(vec![
        State::Absent,
        State::Absent,
        State::UserOnly,
        State::Covering,
        State::Fresh,
        State::Stale,
        State::Edited,
        State::Newer,
        State::Directory,
    ])
    .boxed()
}

fn block(id: &str, entries: &str, version: &str) -> String {
    let meta = navori_core::markers::MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some(version.to_owned()),
        ..navori_core::markers::MarkerMeta::default()
    };
    let options = navori_core::markers::InjectOptions {
        shell: true,
        ..navori_core::markers::InjectOptions::default()
    };
    navori_core::markers::inject_managed_section("node_modules/\n", id, entries, &meta, options)
        .output
}

fn place(root: &Path, rel: &str, id: &str, current: &str, state: State) {
    match state {
        State::Absent => {}
        State::UserOnly => write(root, rel, "dist/\n"),
        State::Covering => write(root, rel, "# mine\n.claude\n  CLAUDE.md  \n.mcp.json/\n"),
        State::Fresh => write(root, rel, &block(id, current, STAMP_VERSION)),
        State::Stale => write(root, rel, &block(id, ".claude/", "0.1.0")),
        State::Edited => write(
            root,
            rel,
            &block(id, current, "0.1.0").replacen(".claude/", ".claude/\nmine/", 1),
        ),
        State::Newer => write(root, rel, &block(id, ".claude/", "999.0.0")),
        State::Directory => {
            let _ = std::fs::create_dir_all(root.join(rel));
        }
    }
}

/// The prettier signal of the repo.
const PRETTIER: [(&str, &str); 12] = [
    ("", ""),
    (".prettierrc", "{}"),
    ("prettier.config.mjs", "export default {}"),
    ("package.json", r#"{"devDependencies":{"prettier":"^3"}}"#),
    ("package.json", r#"{"dependencies":{"prettier":null}}"#),
    ("package.json", r#"{"prettier":"@acme/prettier-config"}"#),
    (
        "package.json",
        r#"{"scripts":{"format":"prettier --write ."}}"#,
    ),
    (
        "package.json",
        r#"{"scripts":{"fmt":"pnpm exec ./node_modules/.bin/prettier"}}"#,
    ),
    (
        "package.json",
        r#"{"scripts":{"lint":"prettier-plugin-foo --check","x":"noprettier"}}"#,
    ),
    ("package.json", r#"{"scripts":["prettier\u3000-w"]}"#),
    ("package.json", "\u{feff}{\"scripts\":\"prettier\"}"),
    ("package.json", r#"["prettier"]"#),
];

/// The repo's `.prettierignore` content for each state (Claude-only body).
const CLAUDE_BODY: &str = ".claude/\n.mcp.json\nCLAUDE.md";

fn summary(plan: Result<Option<IgnoreFile>, impl std::fmt::Debug>) -> Value {
    match plan {
        Err(_) => json!("threw"),
        Ok(None) => Value::Null,
        Ok(Some(file)) => {
            let written = matches!(file.status.as_str(), "created" | "updated");
            json!([
                file.rel_path,
                file.status.as_str(),
                written.then_some(file.content),
                file.skipped_reason,
                file.entries
            ])
        }
    }
}

// Covers: R41
#[test]
fn engine_outputs_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "table" }))?;
    let owned: Vec<Value> = ENGINE_OUTPUTS
        .iter()
        .map(|(engine, _)| json!([engine, engine_owned_paths(engine)]))
        .collect();
    let all: Vec<String> = ENGINE_OUTPUTS
        .iter()
        .map(|(e, _)| (*e).to_owned())
        .collect();
    let rust = json!([owned, engine_output_paths(&all)]);
    if ts != rust {
        return Err(format!("ENGINE_OUTPUTS drifted:\nts   {ts}\nrust {rust}"));
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R41
    #[test]
    fn ignore_files_match(
        mode in prop::sample::select(vec![None, Some("off"), Some("local"), Some("full")]),
        engines in prop::sample::select(vec![vec!["claude"], vec!["claude", "codex"], vec!["codex", "pi"], vec!["cursor"]]),
        plugins in prop::sample::select(vec![
            "{}",
            r#"{"tgrep":{"enabled":true}}"#,
            r#"{"codegraph":{"enabled":true},"tgrep":{"enabled":false}}"#,
            r#"{"codegraph":{"enabled":"true"}}"#,
        ]),
        gitignore in state(),
        prettierignore in state(),
        prettier in 0..PRETTIER.len(),
        orphans in prop::collection::vec(prop::bool::weighted(0.3), 7),
        force in prop::bool::weighted(0.2),
        es in prop::bool::ANY,
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
    ) {
        let root = BASE.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(&root);
        let mode_json = mode.map_or_else(String::new, |m| format!(r#","gitignoreHarness":"{m}""#));
        let config_text = format!(r#"{{"engines":{},"plugins":{plugins}{mode_json}}}"#, json!(engines));
        let config = js_json::parse(&config_text).ok_or_else(|| TestCaseError::fail("config"))?;
        let git_body = navori_core::render::ignore_files::gitignore_body(&config).unwrap_or_default();
        place(&root, ".gitignore", "gitignore-harness", &git_body, gitignore);
        place(&root, ".prettierignore", "prettierignore-harness", CLAUDE_BODY, prettierignore);
        let (file, text) = PRETTIER[prettier];
        if !file.is_empty() {
            write(&root, file, text);
        }
        for (path, on) in ["AGENTS.md", ".codex/config.toml", ".agents/skills/x/SKILL.md", ".pi/x", ".cursor/rules/navori.mdc", ".github/copilot-instructions.md", ".mcp.json"].iter().zip(&orphans) {
            if *on {
                write(&root, path, "x");
            }
        }
        let lang = if es { "es" } else { "en" };
        let l = Lang::resolve(Some(lang));
        let view = DiskView(&root);
        let rust = json!([
            summary(plan_gitignore(&view, &config, force, l, floor)),
            summary(plan_prettierignore(&view, &config, force, l, floor)),
            scan_orphaned_engine_outputs(&view, &config),
        ]);
        let ts = NODE
            .ask(&json!({
                "root": root.to_string_lossy(), "config": serde_json::from_str::<Value>(&config_text).map_err(|e| TestCaseError::fail(e.to_string()))?,
                "force": force, "lang": lang, "floor": floor,
                "backups": BASE.join("backups").to_string_lossy(),
            }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(ts, rust, "{:?} {:?} {}", gitignore, prettierignore, prettier);
    }
}
