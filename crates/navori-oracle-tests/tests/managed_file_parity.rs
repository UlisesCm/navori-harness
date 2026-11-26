//! `navori_core::render::managed_file` against the real `renderManagedFile` and
//! `forcedManagedFileContent` (spec 0058 T14): fresh and re-rendered destinations, frontmatter
//! merge (retired keys, `mcp__` grants, foreign files), user sections, shell and html styles,
//! includes, conditions, versions, force and the anti-rollback floor.

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::LazyLock;

use navori_core::js_json;
use navori_core::markers::{CommentStyle, InjectDetails};
use navori_core::render::managed_file::{
    RenderManagedFileInput, forced_managed_file_content, render_managed_file,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const r = await import({:?});\nconst m = await import({:?});\nconst fs = await import('node:fs');\n\
         const path = await import('node:path');",
        cli_module("engines/shared/render-managed-file.ts"),
        cli_module("lib/render/marker.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const assetPath = path.join(request.dir, `asset.${request.ext}`);\n\
     fs.writeFileSync(assetPath, request.asset);\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const input = {\n\
         assetPath, existingContent: request.existing, managedId: request.id,\n\
         meta: { source: request.source, version: request.version }, config: JSON.parse(request.config),\n\
         extraVars: request.extraVars, engine: request.engine ?? undefined, forceOverwrite: request.force,\n\
       };\n\
       const res = r.renderManagedFile(input);\n\
       const d = res.details;\n\
       return {\n\
         content: res.content, status: res.status,\n\
         details: d ? [d.existingHash ?? null, d.actualHash, d.newHash, d.existingVersion ?? null, d.existingSource ?? null, d.versionDrift ?? null, d.downgrade ?? null] : null,\n\
         collision: res.collision ? res.collision.overwrittenKeys : null,\n\
         forced: r.forcedManagedFileContent(input),\n\
       };\n\
     } catch (e) { return { threw: String(e && e.message || e) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("navori-managed-file-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
});

fn details(d: &InjectDetails) -> Value {
    json!([
        d.existing_hash,
        d.actual_hash,
        d.new_hash,
        d.existing_version,
        d.existing_source,
        d.version_drift,
        d.downgrade
    ])
}

/// One asset: frontmatter lines, body, optional user template, style.
#[derive(Debug, Clone)]
struct Asset {
    fm: Vec<&'static str>,
    body: Vec<&'static str>,
    template: Option<&'static str>,
    shell: bool,
}

impl Asset {
    fn text(&self) -> String {
        let mut out = String::new();
        if self.shell {
            out.push_str("#!/usr/bin/env bash\n");
        } else if !self.fm.is_empty() {
            out.push_str(&format!("---\n{}\n---\n", self.fm.join("\n")));
        }
        out.push('\n');
        out.push_str(&self.body.join("\n"));
        out.push('\n');
        if let Some(template) = self.template {
            out.push_str(if self.shell {
                "# navori:user-section\n"
            } else {
                "<!-- navori:user-section -->\n"
            });
            out.push_str(template);
        }
        out
    }
}

fn asset() -> BoxedStrategy<Asset> {
    let fm = prop::sample::subsequence(
        vec![
            "name: implementer",
            "description: Writes code: for one task",
            "tools: Read, Grep, Agent(scout, scribe)",
            "model: {{modelVar}}",
            "color: {{projectName}}",
            "x-custom: 1",
            "toString: legacy",
            "tools: Read, mcp__engram__mem_save",
        ],
        0..=8,
    );
    let body = prop::collection::vec(
        prop::sample::select(vec![
            "Body for {{projectName}}.",
            "Plain line.",
            "<!-- navori:if scribeOwnsMarkdown -->\nScribe on.\n<!-- /navori:if -->",
            "<!-- navori:if-not planTiers -->\nNo tiers.\n<!-- /navori:if-not -->",
            "<!-- navori:if planTiers -->\nUnbalanced.",
            "# navori:include extract-cmd",
            "# navori:include missing-partial",
            "Uses {{extra}} var.",
            "echo hi # navori:user-section inline",
            "# navori:user-section trailing",
            "echo # navori:user-section",
        ]),
        1..4,
    );
    let template = prop::option::of(prop::sample::select(vec![
        "User notes for {{projectName}}.\n",
        "",
        "\n\n",
    ]));
    (fm, body, template, prop::bool::weighted(0.25))
        .prop_map(|(fm, body, template, shell)| Asset {
            fm,
            body,
            template,
            shell,
        })
        .boxed()
}

/// How the destination exists before this render.
#[derive(Debug, Clone)]
struct Dest {
    /// Re-render of the same asset (the update case) instead of a different one.
    same: bool,
    prior: Asset,
    prior_version: &'static str,
    edits: Vec<u8>,
}

fn dest() -> BoxedStrategy<Option<Dest>> {
    prop::option::weighted(
        0.8,
        (
            any::<bool>(),
            asset(),
            prop::sample::select(vec!["0.9.0", "1.0.0", "2.0.0"]),
            prop::collection::vec(0u8..6, 0..3),
        )
            .prop_map(|(same, prior, prior_version, edits)| Dest {
                same,
                prior,
                prior_version,
                edits,
            }),
    )
    .boxed()
}

fn input<'a>(
    asset: &'a str,
    shell: bool,
    existing: Option<&'a str>,
    version: &'a str,
    config: &'a js_json::JsValue,
) -> RenderManagedFileInput<'a> {
    RenderManagedFileInput {
        asset,
        style: if shell {
            CommentStyle::Shell
        } else {
            CommentStyle::Html
        },
        existing,
        managed_id: "block",
        source: "@navori/core",
        version,
        config,
        extra_vars: BTreeMap::from([("extra".to_owned(), "EXTRA".to_owned())]),
        transform: None,
        engine: None,
        force_overwrite: false,
        ambient_floor: None,
    }
}

/// The destination text: a prior render of `prior`, then hand edits.
fn existing(dest: &Dest, current: &Asset, config: &js_json::JsValue) -> Option<String> {
    let shell = current.shell;
    let prior = if dest.same {
        current.text()
    } else {
        Asset {
            shell,
            ..dest.prior.clone()
        }
        .text()
    };
    let rendered =
        render_managed_file(&input(&prior, shell, None, dest.prior_version, config)).ok()?;
    let mut text = rendered.content;
    for edit in &dest.edits {
        text = match edit {
            0 => text.replacen("Plain line.", "Plain line, edited.", 1),
            1 => text.replacen("---\n", "---\nowner: me\n", 1),
            2 => text.replacen("tools: Read", "tools: mcp__engram__mem_save, Read", 1),
            3 => format!(
                "---\nname: foreign\nmodel: opus\n---\n{}",
                text.replace("navori:managed", "x")
            ),
            4 => format!("{text}\nTrailing user prose.\n"),
            _ => text.replacen("name: implementer", "name: renamed", 1),
        };
    }
    Some(text)
}

const CONFIG: &str = r#"{"projectName":"demo","harness":{"planTiers":true},"language":"es"}"#;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    // Covers: R41
    #[test]
    fn render_managed_file_matches(
        asset in asset(),
        dest in dest(),
        version in prop::sample::select(vec!["1.0.0", "1.5.0"]),
        force in any::<bool>(),
        floor in prop::sample::select(vec![None, Some("0.5.0"), Some("3.0.0")]),
        engine in prop::sample::select(vec![None, Some("codex")]),
    ) {
        let config = js_json::parse(CONFIG).ok_or_else(|| TestCaseError::fail("config"))?;
        let text = asset.text();
        let existing = dest.as_ref().and_then(|d| existing(d, &asset, &config));
        let ts = NODE
            .ask(&json!({
                "dir": DIR.to_string_lossy(), "ext": if asset.shell { "sh" } else { "md" },
                "asset": text, "existing": existing, "id": "block", "source": "@navori/core",
                "version": version, "config": CONFIG, "extraVars": { "extra": "EXTRA" },
                "engine": engine, "force": force, "floor": floor,
            }))
            .map_err(TestCaseError::fail)?;
        let rust_input = RenderManagedFileInput {
            force_overwrite: force,
            ambient_floor: floor,
            engine,
            ..input(&text, asset.shell, existing.as_deref(), version, &config)
        };
        let rust = match (render_managed_file(&rust_input), forced_managed_file_content(&rust_input)) {
            (Ok(result), Ok(forced)) => json!({
                "content": result.content,
                "status": result.status.as_str(),
                "details": details(&result.details),
                "collision": result.collision,
                "forced": forced,
            }),
            _ => {
                prop_assert!(ts.get("threw").is_some(), "rust delegated, ts: {} for {}", ts, text);
                return Ok(());
            }
        };
        prop_assert_eq!(ts, rust, "{}\n--- existing\n{:?}", text, existing);
    }
}
