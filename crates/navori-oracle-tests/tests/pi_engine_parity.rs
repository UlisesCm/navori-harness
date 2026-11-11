//! `navori_core::render::pi_engine` against the real `preparePiEngine` (spec 0059 T20): every
//! planned write, removal, skip and warning of a Pi-only render must match, on an empty tree and
//! on one a previous render left and the user then edited. The extension is compared by path and
//! status only: the bridge runs the TS sources, whose `serializeAnonymousFunction` bytes differ
//! from the bundle the asset comes from (D29); the oracle compares it against `dist`.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::render::collect::DiskView;
use navori_core::render::native_hooks::embedded_native_hooks;
use navori_core::render::pi_engine::{PiEngineInput, pi_observed, pi_seal, plan_pi_engine};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?}); const c = await import({:?}); const path = await import('node:path');",
        cli_module("engines/pi/index.ts"),
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "try {\n\
       const config = c.readConfig(path.join(request.root, 'navori.config.json'));\n\
       if (request.write) { e.renderPiEngine(request.root, config, { dryRun: false }); return null; }\n\
       const prepared = e.preparePiEngine(request.root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const result = prepared.commit();\n\
       const ext = '.pi/extensions/navori.ts';\n\
       return {\n\
         pending: fin.pending.filter((p) => p.relPath !== ext).map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         removals: fin.removals.map((r) => path.relative(request.root, r.path)),\n\
         written: result.written.filter((w) => w.path !== ext).map((w) => [w.path, w.status]),\n\
         skipped: result.skipped.map((x) => [x.path, x.reason, x.status ?? null]),\n\
         warnings: result.warnings,\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static ROOT: LazyLock<PathBuf> =
    LazyLock::new(|| std::env::temp_dir().join(format!("navori-pi-engine-{}", std::process::id())));
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

fn pick(options: &[&'static str]) -> BoxedStrategy<&'static str> {
    prop::sample::select(options.to_vec()).boxed()
}

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""nextjs""#]),
        prop::collection::vec(0u8..3, 4),
        prop::option::of(pick(&[
            r#"{"planTiers":true,"masterPlan":true}"#,
            r#"{"scribeOwnsMarkdown":true}"#,
            r#"{"scribeOwnsMarkdown":true,"scribe":false,"publisher":false}"#,
        ])),
        prop::option::of(pick(&[r#"{"full":"bun check","fast":"bun run check:fast"}"#])),
        prop::option::of(pick(&[
            r#"{"implementer":"sonnet","reviewer":"opus","piMap":{"sonnet":"anthropic/claude-sonnet"}}"#,
            r#"{"implementer":"opus","codexMap":{"opus":"gpt-6-sol"}}"#,
        ])),
        pick(&[r#"["pi"]"#, r#"["pi","agents-md"]"#, r#"["pi","codex"]"#]),
        prop::option::of(pick(&[r#","audit":{"mode":"always"}"#, r#","hooks":{"verifyOnStop":true}"#])),
    )
        .prop_map(|(preset, states, harness, gate, models, engines, extra)| {
            let plugins: Vec<String> = ["engram", "codegraph", "gh", "tgrep"]
                .iter()
                .zip(states)
                .filter(|(_, s)| *s > 0)
                .map(|(id, s)| format!(r#""{id}":{{"enabled":{}}}"#, s == 1))
                .collect();
            let opt = |key: &str, value: Option<&str>| {
                value.map_or_else(String::new, |v| format!(r#","{key}":{v}"#))
            };
            format!(
                r#"{{"name":"demo","preset":{preset},"engines":{engines},"language":"en"{}{}{}{},"plugins":{{{}}}}}"#,
                opt("harness", harness),
                opt("qualityGate", gate),
                opt("models", models),
                extra.unwrap_or(""),
                plugins.join(",")
            )
        })
        .boxed()
}

/// An edit after the first render.
#[derive(Debug, Clone, Copy)]
enum Edit {
    None,
    Agent,
    Manifest,
    ForeignExtension,
    OrphanAgent,
    HookBlock,
    /// The orchestrator file edited by hand (a retirement beside Codex keeps it).
    Orchestrator,
    /// The orchestrator path replaced by a symlink.
    OrchestratorLink,
}

fn apply_edit(root: &Path, edit: Edit) -> Result<(), TestCaseError> {
    let append = |rel: &str, extra: &str| -> Result<(), TestCaseError> {
        let path = root.join(rel);
        match std::fs::read_to_string(&path) {
            Ok(text) => write(&path, &format!("{text}{extra}")),
            Err(_) => Ok(()),
        }
    };
    match edit {
        Edit::None => Ok(()),
        Edit::Agent => append(".pi/agents/scout.md", "mine\n"),
        Edit::Manifest => append(".pi/navori.json", " "),
        Edit::ForeignExtension => write(
            &root.join(".pi/extensions/navori.ts"),
            "export default function () {}\n",
        ),
        Edit::OrphanAgent => write(
            &root.join(".pi/agents/publisher.md"),
            "---\nname: publisher\n---\nmine\n",
        ),
        Edit::Orchestrator => append(".pi/navori/orchestrator.md", "mine\n"),
        Edit::OrchestratorLink => {
            let path = root.join(".pi/navori/orchestrator.md");
            if path.exists() {
                std::fs::remove_file(&path).map_err(fail)?;
                #[cfg(unix)]
                std::os::unix::fs::symlink("../../navori.config.json", &path).map_err(fail)?;
            }
            Ok(())
        }
        Edit::HookBlock => {
            let path = root.join(".pi/navori/hooks/comment-draft-confirm.sh");
            match std::fs::read_to_string(&path) {
                Ok(text) => write(&path, &text.replacen("set -", "#x\nset -", 1)),
                Err(_) => Ok(()),
            }
        }
    }
}

fn rust_engine(root: &Path, text: &str) -> Option<Value> {
    let read = config::read(text.as_bytes()).ok()?;
    let manifest = embedded_native_hooks();
    let input = PiEngineInput {
        config: &read.data,
        repo_root: root,
        ambient_floor: None,
        native_manifest: &manifest,
    };
    let view = DiskView(root);
    let (observed, excluded) = pi_observed(&view, &input).ok()?;
    let seal = pi_seal(&observed, &excluded).ok()?;
    let plan = plan_pi_engine(&view, &input, &seal).ok()?;
    let ext = ".pi/extensions/navori.ts";
    let mut written: Vec<Value> = plan
        .pending
        .iter()
        .filter(|w| w.rel_path != ext)
        .map(|w| json!([w.rel_path, w.status.as_str()]))
        .chain(
            plan.removals
                .iter()
                .map(|r| json!([r.rel_path, "removed-condition-false"])),
        )
        .collect();
    let mut skipped: Vec<Value> = plan
        .skipped
        .iter()
        .map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str())]))
        .collect();
    if let Some(context) = &plan.context {
        written.extend(
            context
                .write
                .iter()
                .map(|w| json!([w.rel_path, w.status.as_str()])),
        );
        skipped.extend(
            context
                .skipped
                .iter()
                .map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str())])),
        );
    }
    Some(json!({
        "pending": plan.pending.iter().filter(|w| w.rel_path != ext).map(|w| json!([
            w.rel_path, w.content, w.status.as_str(), w.chmod_exec,
        ])).collect::<Vec<_>>(),
        "removals": plan.removals.iter().map(|r| json!(r.rel_path)).collect::<Vec<_>>(),
        "written": written,
        "skipped": skipped,
        "warnings": plan.warnings,
    }))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]

    // Covers: R62, R67, R68
    #[test]
    fn pi_engine_matches_prepare_pi_engine(
        text in config(), first in config(), rendered in any::<bool>(),
        edit in prop::sample::select(vec![Edit::None, Edit::Agent, Edit::Manifest, Edit::ForeignExtension, Edit::OrphanAgent, Edit::HookBlock, Edit::Orchestrator, Edit::OrchestratorLink]),
    ) {
        let root = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).map_err(fail)?;
        if rendered {
            write(&root.join("navori.config.json"), &first)?;
            let seeded = NODE.ask(&json!({ "root": root, "write": true })).map_err(TestCaseError::fail)?;
            prop_assume!(seeded.is_null());
            apply_edit(&root, edit)?;
        }
        write(&root.join("navori.config.json"), &text)?;
        let reply = NODE.ask(&json!({ "root": root })).map_err(TestCaseError::fail)?;
        prop_assume!(reply.get("threw").is_none());
        let rust = rust_engine(&root, &text).ok_or_else(|| fail("unexpected delegate"))?;
        prop_assert!(reply == rust, "{text}\n{}", support::first_difference(&reply, &rust));
    }
}
