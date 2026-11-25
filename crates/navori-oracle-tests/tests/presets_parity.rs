//! `navori_core::render::{presets, library_skills}` against the real TS (spec 0058 T14): every
//! bundled preset, generated local presets and the lib-skill registry.

mod support;

use std::path::PathBuf;

use navori_core::diagnose::detect::detect_project;
use navori_core::process::RealRunner;
use navori_core::render::library_skills::{
    LIBRARY_SKILL_SIGNALS, LIBRARY_SKILLS, MIGRATION_PAIRS, MIN_ADOPTION_FILES,
    MIN_PREFERRED_RATIO, REMOVED_LIB_SKILL_SUCCESSORS, REMOVED_LIB_SKILLS,
};
use navori_core::render::presets::{AssetRoot, dropped_libraries_warnings, load_preset};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    let detect = format!(
        "\nconst d = await import({:?});",
        cli_module("lib/diagnose/detect.ts")
    );
    detect
        + &format!(
            "const p = await import({:?});\nconst l = await import({:?});\nconst b = await import({:?});\n\
         const fs = await import('node:fs');\nconst path = await import('node:path');",
            cli_module("lib/config/presets.ts"),
            cli_module("lib/assets/library-skills.ts"),
            cli_module("lib/render/bundled-assets.ts"),
        )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'signals') return [l.LIBRARY_SKILLS.map((s) => [s.id, s.deps, s.paths ?? [], s.minMajor ?? null]), l.MIGRATION_PAIRS.map((m) => [m.legacy, m.preferred, m.domain]), l.MIN_ADOPTION_FILES, l.MIN_PREFERRED_RATIO];\n\
     if (request.op === 'detect') {\n\
       fs.rmSync(request.dir, { recursive: true, force: true });\n\
       for (const [rel, text] of request.files) {\n\
         fs.mkdirSync(path.dirname(path.join(request.dir, rel)), { recursive: true });\n\
         fs.writeFileSync(path.join(request.dir, rel), text);\n\
       }\n\
       const r = d.detectProject(request.dir);\n\
       return { name: r.name, framework: r.stack.framework, libraries: r.libraries, migrations: r.migrations, preset: r.suggestedPreset, gap: r.suggestedPresetGap };\n\
     }\n\
     if (request.op === 'registry') return [l.LIBRARY_SKILLS.map((s) => [s.id, s.label]), l.REMOVED_LIB_SKILLS, Object.entries(l.REMOVED_LIB_SKILL_SUCCESSORS)];\n\
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
       return { def: JSON.stringify(loaded.def), source: loaded.source, dropped: loaded.droppedLibraries, warnings: p.droppedLibrariesWarnings(loaded) };\n\
     } catch (e) { if (e instanceof p.PresetError) return { error: true }; throw e; }",
);

fn rust_load(id: &str, root: &std::path::Path) -> Value {
    match load_preset(id, root) {
        Err(_) => json!({ "error": true }),
        Ok(None) => json!({ "none": true }),
        Ok(Some(loaded)) => {
            // Text, not `Value`: serde_json sorts object keys, and zod's key order is part of the port.
            let def = loaded.def.stringify(None);
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

// Covers: R41
#[test]
fn detection_signals_and_migration_tables_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "signals" }))?;
    let signals: Vec<Value> = LIBRARY_SKILL_SIGNALS
        .iter()
        .map(|s| json!([s.id, s.deps, s.paths, s.min_major]))
        .collect();
    let pairs: Vec<Value> = MIGRATION_PAIRS
        .iter()
        .map(|(legacy, preferred, domain)| json!([legacy, preferred, domain]))
        .collect();
    let rust = json!([signals, pairs, MIN_ADOPTION_FILES, MIN_PREFERRED_RATIO]);
    if ts != rust {
        return Err(format!(
            "detection tables drifted from library-skills.ts\nts   {ts}\nrust {rust}"
        ));
    }
    Ok(())
}

/// One `detectProject` case: a directory name, its `package.json` and any further files.
struct DetectCase {
    dir: &'static str,
    package_json: Value,
    files: Vec<(String, String)>,
}

fn case(dir: &'static str, package_json: Value) -> DetectCase {
    DetectCase {
        dir,
        package_json,
        files: Vec::new(),
    }
}

fn with_files(mut c: DetectCase, files: &[(&str, &str)]) -> DetectCase {
    c.files.extend(
        files
            .iter()
            .map(|(p, t)| ((*p).to_owned(), (*t).to_owned())),
    );
    c
}

fn deps(names: &[&str]) -> Value {
    let map: serde_json::Map<String, Value> = names
        .iter()
        .map(|n| ((*n).to_owned(), json!("^1.0.0")))
        .collect();
    json!({ "name": "@acme/My App", "dependencies": map })
}

/// `count` source files importing `dep`.
fn imports(dep: &str, count: usize) -> Vec<(String, String)> {
    let slug = dep.replace(['@', '/'], "_");
    (0..count)
        .map(|i| {
            (
                format!("src/{slug}{i}.ts"),
                format!("import x from \"{dep}\";\n"),
            )
        })
        .collect()
}

fn detect_cases() -> Vec<DetectCase> {
    // Every framework candidate `detect.rs` models, one directory each.
    let frameworks = [
        ("next", "fw-next"),
        ("@nestjs/core", "fw-nest"),
        ("@medusajs/medusa", "fw-medusa"),
        ("@keystone-6/core", "fw-keystone"),
        ("expo", "fw-expo"),
        ("react-native", "fw-rn"),
        ("remix", "fw-remix"),
        ("astro", "fw-astro"),
        ("@sveltejs/kit", "fw-kit"),
        ("@builder.io/qwik", "fw-qwik"),
        ("solid-js", "fw-solid"),
        ("@tauri-apps/api", "fw-tauri"),
        ("electron", "fw-electron"),
        ("svelte", "fw-svelte"),
        ("vue", "fw-vue"),
        ("vite", "fw-vite"),
        ("react", "fw-react"),
        ("@angular/core", "fw-angular"),
        ("fastify", "fw-fastify"),
        ("hono", "fw-hono"),
        ("elysia", "fw-elysia"),
        ("express", "fw-express"),
    ];
    let mut cases: Vec<DetectCase> = frameworks
        .iter()
        .map(|(dep, dir)| case(dir, deps(&[dep])))
        .collect();
    cases.push(case("no-deps", json!({ "name": "plain" })));
    cases.push(case(
        "nameless",
        json!({ "dependencies": { "react": "18" } }),
    ));
    // Priority between frameworks, and the UI / state / worker / mongoose refinements.
    let combos: &[(&'static str, &[&str])] = &[
        ("prio-next-react", &["react", "next", "vite"]),
        ("prio-vite-react", &["react", "vite"]),
        ("prio-express-fastify", &["express", "fastify"]),
        ("next-apollo", &["next", "@apollo/client"]),
        ("next-redux", &["next", "@reduxjs/toolkit", "redux"]),
        ("vite-mantine", &["vite", "react", "@mantine/core"]),
        ("vite-mui", &["vite", "@mui/material"]),
        ("ui-tailwind-tamagui", &["tailwindcss", "tamagui"]),
        ("ui-radix", &["@radix-ui/themes", "react"]),
        ("state-zustand", &["zustand", "jotai", "valtio"]),
        ("state-query", &["@tanstack/react-query", "react"]),
        ("express-mongoose", &["express", "mongoose"]),
        ("express-bullmq", &["express", "bullmq"]),
        (
            "express-worker-mongoose",
            &["express", "bullmq", "mongoose"],
        ),
        ("worker-only", &["agenda"]),
        ("worker-only-2", &["kafkajs", "amqplib"]),
        ("worker-with-react", &["react", "node-cron"]),
        (
            "worker-misc",
            &["sqs-consumer", "rhea", "bree", "cron", "bee-queue", "bull"],
        ),
        ("worker-amqp-cm", &["amqp-connection-manager"]),
        (
            "libs-mixed",
            &[
                "react-router-dom",
                "axios",
                "socket.io",
                "socket.io-client",
                "zod",
            ],
        ),
        ("libs-redux", &["@reduxjs/toolkit", "redux", "react"]),
    ];
    cases.extend(combos.iter().map(|(dir, names)| case(dir, deps(names))));
    // devDependencies / peerDependencies and the version gate of `minMajor`.
    cases.push(case(
        "dev-and-peer",
        json!({ "name": "d", "devDependencies": { "vite": "^5" }, "peerDependencies": { "react": "*" } }),
    ));
    for (dir, range) in [
        ("tw-v3", "^3.4.1"),
        ("tw-v4", "^4.0.0"),
        ("tw-tilde", "~3.9.0"),
        ("tw-latest", "latest"),
        ("tw-workspace", "workspace:*"),
        ("tw-gte", ">=4"),
    ] {
        cases.push(case(
            dir,
            json!({ "name": "t", "dependencies": { "tailwindcss": range } }),
        ));
    }
    cases.push(case(
        "tw-deps-wins",
        json!({ "name": "t", "dependencies": { "tailwindcss": "^4.0.0" }, "devDependencies": { "tailwindcss": "^3.0.0" } }),
    ));
    cases.push(with_files(
        case("path-signal", json!({ "name": "m" })),
        &[(".maestro/flow.yaml", "appId: x\n")],
    ));
    // Package manager (`packageManager`, then lockfile order) only shows through the preset:
    // a turbo monorepo is `monorepo-turbopnpm` only when pnpm is detected.
    for (dir, pm, lock) in [
        ("pm-pnpm-field", Some("pnpm@9.0.0"), None),
        ("pm-yarn-field", Some("yarn@4"), Some("pnpm-lock.yaml")),
        (
            "pm-unknown-field-lock",
            Some("deno@1"),
            Some("pnpm-lock.yaml"),
        ),
        ("pm-npm-lock", None, Some("package-lock.json")),
        ("pm-yarn-lock", None, Some("yarn.lock")),
        ("pm-bun-lock", None, Some("bun.lock")),
        ("pm-bun-lockb", None, Some("bun.lockb")),
        ("pm-pnpm-lock", None, Some("pnpm-lock.yaml")),
    ] {
        let mut pkg = json!({ "name": "p", "dependencies": { "express": "4" } });
        if let Some(pm) = pm {
            pkg["packageManager"] = json!(pm);
        }
        let mut c = with_files(case(dir, pkg), &[("turbo.json", "{}")]);
        if let Some(lock) = lock {
            c.files.push((lock.to_owned(), String::new()));
        }
        cases.push(c);
    }
    // Monorepo tools.
    let ws = json!({ "name": "root", "dependencies": { "react": "18" } });
    let pnpm_ws = ("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    cases.push(with_files(
        case("mono-pnpm", ws.clone()),
        &[pnpm_ws, ("packages/a/package.json", "{}")],
    ));
    cases.push(with_files(
        case("mono-turbo-pnpm", ws.clone()),
        &[
            pnpm_ws,
            ("turbo.json", "{}"),
            ("packages/a/package.json", "{}"),
        ],
    ));
    cases.push(with_files(
        case("mono-turbo-npm", ws.clone()),
        &[("turbo.json", "{}"), ("package-lock.json", "")],
    ));
    cases.push(with_files(
        case("mono-nx", ws.clone()),
        &[("nx.json", "{}")],
    ));
    cases.push(with_files(
        case("mono-rush", ws.clone()),
        &[("rush.json", "{}")],
    ));
    cases.push(with_files(
        case("mono-lerna", ws.clone()),
        &[("lerna.json", "{}")],
    ));
    cases.push(with_files(
        case("mono-pnpm-empty", ws.clone()),
        &[("pnpm-workspace.yaml", "")],
    ));
    let mut npm_ws = ws.clone();
    npm_ws["workspaces"] = json!(["packages/*"]);
    cases.push(with_files(
        case("mono-npm-workspaces", npm_ws),
        &[("packages/a/package.json", "{}")],
    ));
    // A `Cargo.toml` beside `package.json`: the Rust stack wins and Node deps are ignored.
    cases.push(with_files(
        case("rust-with-node", deps(&["react", "zod"])),
        &[("Cargo.toml", "[package]\nname = \"crate-name\"\n")],
    ));
    cases.push(with_files(
        case(
            "rust-nameless-pkg",
            json!({ "dependencies": { "react": "18" } }),
        ),
        &[("Cargo.toml", "[package]\nname = \"Crate_Name\"\n")],
    ));
    cases.push(with_files(
        case("rust-mono", ws),
        &[
            ("Cargo.toml", "[package]\nname = \"c\"\n"),
            ("nx.json", "{}"),
        ],
    ));
    // Migrations: presence only, then the dominance gate over import counts.
    cases.push(case(
        "mig-presence",
        deps(&["moment", "dayjs", "yup", "zod", "antd", "@mantine/core"]),
    ));
    cases.push(case(
        "mig-both-preferred",
        deps(&["moment", "dayjs", "date-fns", "joi", "@hapi/joi", "zod"]),
    ));
    cases.push(case("mig-no-target", deps(&["moment", "formik"])));
    cases.push(case(
        "mig-chakra-redux",
        deps(&[
            "@chakra-ui/react",
            "@mantine/core",
            "redux",
            "@reduxjs/toolkit",
        ]),
    ));
    // (dir, deps, [(dep, importing files)])
    type Gated<'a> = (&'static str, &'a [&'a str], &'a [(&'a str, usize)]);
    let gated: &[Gated<'_>] = &[
        (
            "mig-gated-out",
            &["moment", "dayjs"],
            &[("moment", 8), ("dayjs", 1)],
        ),
        (
            "mig-adopted",
            &["moment", "dayjs", "date-fns"],
            &[("moment", 4), ("date-fns", 3), ("dayjs", 1)],
        ),
        ("mig-ratio-edge", &["yup", "zod"], &[("yup", 6), ("zod", 3)]),
        (
            "mig-ratio-below",
            &["yup", "zod"],
            &[("yup", 7), ("zod", 3)],
        ),
        ("mig-legacy-unused", &["yup", "zod"], &[("zod", 1)]),
    ];
    for (dir, names, usage) in gated {
        let mut c = case(dir, deps(names));
        for (dep, count) in *usage {
            c.files.extend(imports(dep, *count));
        }
        cases.push(c);
    }
    cases
}

// Covers: R41
#[test]
fn detect_project_matches_for_every_modeled_stack() -> Result<(), String> {
    let env: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().collect();
    let base = temp_root("detect").join("cases");
    for c in detect_cases() {
        let dir = base.join(c.dir);
        let mut files = vec![("package.json".to_owned(), c.package_json.to_string())];
        files.extend(c.files.iter().cloned());
        let ts = NODE.ask(&json!({ "op": "detect", "dir": dir, "files": files }))?;
        let project = detect_project(&dir, &RealRunner, &env)
            .map_err(|_| format!("{}: detect.rs declined (Unmodeled)", c.dir))?;
        let migrations: Vec<Value> = project
            .migrations
            .iter()
            .map(|m| json!({ "legacy": m.legacy, "preferred": m.preferred, "domain": m.domain }))
            .collect();
        let rust = json!({
            "name": project.name,
            "framework": project.framework,
            "libraries": project.libraries,
            "migrations": migrations,
            "preset": project.suggested_preset,
            "gap": project.suggested_preset_gap,
        });
        if ts != rust {
            return Err(format!("{}:\nts   {ts}\nrust {rust}", c.dir));
        }
    }
    Ok(())
}
