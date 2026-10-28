//! `navori_core::render::nested_gitignore` against the real `renderNestedGitignore` (spec 0058
//! T14): `.claude/`, `.codex/` and `.navori/` with their engine enabled or not, legacy ephemeral
//! paths, files with and without the block, hand edits, newer stamps, `force` and the floor.
//! The TS reports no content in a dry run, so it writes into a scratch copy (backups go to a
//! scratch `NAVORI_BACKUP_ROOT`) and the file is read back.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::render::collect::RepoView;
use navori_core::render::context::Lang;
use navori_core::render::nested_gitignore::{
    EPHEMERAL_HARNESS_PATHS, NESTED_GITIGNORE_DIRS, plan_nested_gitignore,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const g = await import({:?});\nconst m = await import({:?});\nconst p = await import({:?});\nconst fs = await import('node:fs');\nconst path = await import('node:path');",
        cli_module("engines/shared/nested-gitignore-harness.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("engines/shared/ephemeral-paths.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'table') return p.EPHEMERAL_HARNESS_PATHS;\n\
     process.env.NAVORI_BACKUP_ROOT = request.backups;\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const out = [];\n\
       for (const dir of request.dirs) {\n\
         const engines = dir === '.navori' ? undefined : request.engines;\n\
         try {\n\
           const r = g.renderNestedGitignore(request.root, dir, { dryRun: false, force: request.force, lang: request.lang, enabledEngines: engines });\n\
           if (r === null) { out.push(null); continue; }\n\
           const file = path.join(request.root, r.path);\n\
           const written = r.status === 'created' || r.status === 'updated';\n\
           out.push([r.path, r.status, written ? fs.readFileSync(file, 'utf-8') : null, r.skippedReason ?? null]);\n\
         } catch (err) { out.push('threw'); }\n\
       }\n\
       return out;\n\
     } finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-nested-gitignore-{}", std::process::id()))
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

    fn lexists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.0.join(rel)).is_ok()
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

/// What a `.gitignore` holds before the render.
#[derive(Debug, Clone, Copy)]
enum State {
    Absent,
    UserOnly,
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
        State::Fresh,
        State::Stale,
        State::Edited,
        State::Newer,
        State::Directory,
    ])
    .boxed()
}

fn block(entries: &str, version: &str) -> String {
    let meta = navori_core::markers::MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some(version.to_owned()),
        ..navori_core::markers::MarkerMeta::default()
    };
    let options = navori_core::markers::InjectOptions {
        shell: true,
        ..navori_core::markers::InjectOptions::default()
    };
    navori_core::markers::inject_managed_section(
        "node_modules/\n",
        "nested-gitignore-harness",
        entries,
        &meta,
        options,
    )
    .output
}

fn place(root: &Path, dir: &str, state: State) {
    let rel = format!("{dir}/.gitignore");
    let current = match dir {
        ".claude" => {
            "settings.local.json\nworktrees/\nprogress/\n.managed-drift-stamp\n.routing-watch/"
        }
        ".codex" => "progress/",
        _ => "state/",
    };
    match state {
        State::Absent => {}
        State::UserOnly => write(root, &rel, "dist/\n"),
        State::Fresh => write(root, &rel, &block(current, STAMP_VERSION)),
        State::Stale => write(root, &rel, &block("progress/", "0.1.0")),
        State::Edited => write(
            root,
            &rel,
            &block(current, "0.1.0").replacen("progress/", "progress/\nmine/", 1),
        ),
        State::Newer => write(root, &rel, &block("progress/", "999.0.0")),
        State::Directory => {
            let _ = std::fs::create_dir_all(root.join(&rel));
        }
    }
}

// Covers: R41
#[test]
fn ephemeral_paths_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "table" }))?;
    if ts != json!(EPHEMERAL_HARNESS_PATHS) {
        return Err(format!("EPHEMERAL_HARNESS_PATHS drifted: {ts}"));
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R41
    #[test]
    fn nested_gitignores_match(
        states in prop::collection::vec(state(), 3),
        engines in prop::sample::select(vec![vec!["claude"], vec!["claude", "codex"], vec!["codex"]]),
        legacy in prop::collection::vec(prop::bool::weighted(0.2), 3),
        force in prop::bool::weighted(0.2),
        es in prop::bool::ANY,
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
    ) {
        let root = BASE.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(&root);
        for (dir, state) in NESTED_GITIGNORE_DIRS.iter().zip(&states) {
            place(&root, dir, *state);
        }
        // Legacy ephemeral state of an engine that is not enabled.
        for (path, on) in [".claude/progress/x", ".codex/progress/x", ".claude/settings.local.json"].iter().zip(&legacy) {
            if *on {
                write(&root, path, "{}");
            }
        }
        let lang = if es { "es" } else { "en" };
        let engines: Vec<String> = engines.iter().map(|e| (*e).to_owned()).collect();
        // Plan on a pristine copy first: the TS writes.
        let rust: Vec<Value> = NESTED_GITIGNORE_DIRS
            .iter()
            .map(|dir| {
                let engines = (*dir != ".navori").then_some(engines.as_slice());
                match plan_nested_gitignore(&Disk(&root), dir, engines, force, Lang::resolve(Some(lang)), floor) {
                    Err(_) => json!("threw"),
                    Ok(None) => Value::Null,
                    Ok(Some(plan)) => {
                        let written = matches!(plan.status.as_str(), "created" | "updated");
                        json!([plan.rel_path, plan.status.as_str(), written.then_some(plan.content), plan.skipped_reason])
                    }
                }
            })
            .collect();
        let ts = NODE
            .ask(&json!({
                "root": root.to_string_lossy(), "dirs": NESTED_GITIGNORE_DIRS, "engines": engines,
                "force": force, "lang": lang, "floor": floor,
                "backups": BASE.join("backups").to_string_lossy(),
            }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(ts, json!(rust), "{:?}", states);
    }
}
