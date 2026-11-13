//! `navori_core::diagnose::doctor_local` against the TS `doctor` scans (spec 0060 T23 slice 3a).
//!
//! Every case is a small repo written to a temp dir, with an explicit config. For each case the
//! TS side runs every scan on that dir and the Rust side does the same; replies are compared
//! as normalised JSON. Scans the TS does not export (`listContextMarkers`, the `presetOverride`
//! expression) are read from the fields of the TS `doctor --json` report of the same dir
//! (`managedBlocks`, `presetOverride`), never from its provenance. The Node side runs with an
//! empty `HOME`, a minimal `PATH` and no global git config.
//!
//! A scan the Rust port declines ([`Unmodeled`], the CLI then delegates) must be listed in the
//! case's `delegates`; the list is checked both ways, so it cannot rot. `scanCorruptedSettings`
//! (doctor.ts:1911) has no public Rust twin: only its readable, parseable branch exists, inside
//! the shared verdict, and a corrupted file delegates there (`verdict.rs:100`).

mod support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::diagnose::doctor_local::{
    McpCoherenceIssue, Unmodeled, classify_local_skills, is_placeholder_name,
    list_available_external_providers, list_context_markers, needs_external_provider_setup_hint,
    preset_override, scan_claude_hook_scripts, scan_excluded_blocks, scan_legacy_agents,
    scan_malformed_markers, scan_managed_order, scan_mcp_coherence, scan_monorepo_drift,
    scan_name_mismatch, scan_permission_mode, scan_retired_assets, scan_retired_plugin_leftovers,
};
use serde_json::{Map, Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const fs = await import('node:fs');\nconst path = await import('node:path');\n\
         const cp = await import('node:child_process');\n\
         const c = await import({:?});\nconst h = await import({:?});\nconst d = await import({:?});\n\
         const det = await import({:?});\nconst lsp = await import({:?});\nconst hp = await import({:?});\n\
         const pr = await import({:?});\nconst ba = await import({:?});\nconst ep = await import({:?});\n\
         const cl = await import({:?});\n\
         process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = '/dev/null';",
        cli_module("lib/config/config.ts"),
        cli_module("lib/diagnose/health.ts"),
        cli_module("commands/doctor.ts"),
        cli_module("lib/diagnose/detect.ts"),
        cli_module("engines/shared/local-skill-pointer.ts"),
        cli_module("engines/shared/harness-plan.ts"),
        cli_module("lib/config/presets.ts"),
        cli_module("lib/render/bundled-assets.ts"),
        cli_module("lib/config/external-providers.ts"),
        cli_module("engines/claude/index.ts"),
    )
}

/// One request = one fixture dir; the reply maps each scan name to `{ ok }` or `{ err }`.
static NODE: Shared = Shared::new(
    prelude,
    "process.env.HOME = request.home; process.env.PATH = request.nodeDir + ':/usr/bin:/bin';\n\
     const cfg = c.readConfig(path.join(request.dir, 'navori.config.json'));\n\
     const dir = request.dir;\n\
     const out = {};\n\
     const run = (name, f) => { try { out[name] = { ok: f() ?? null }; } catch (e) { out[name] = { err: String(e && e.message || e) }; } };\n\
     run('managedOrder', () => h.scanManagedOrder(dir, cfg, cl.CLAUDE_COMPUTED_BLOCK_IDS));\n\
     run('malformed', () => h.scanMalformedMarkers(dir, cfg));\n\
     run('excluded', () => h.scanExcludedBlocks(cfg));\n\
     run('legacyAgents', () => h.scanLegacyAgents(dir, cfg));\n\
     run('retiredAssets', () => h.scanRetiredAssets(dir));\n\
     run('retiredPlugins', () => h.scanRetiredPluginLeftovers(dir, cfg));\n\
     run('permission', () => h.scanPermissionMode(dir));\n\
     run('nameMismatch', () => d.scanNameMismatch(dir, cfg));\n\
     run('placeholder', () => det.isPlaceholderName(cfg.name));\n\
     run('hookScripts', () => d.scanClaudeHookScripts(dir, cfg));\n\
     run('mcp', () => d.scanMcpCoherence(dir, cfg));\n\
     run('monorepo', () => d.scanMonorepoDrift(dir, cfg));\n\
     run('providers', () => ep.listAvailableExternalProviders(cfg, dir));\n\
     run('localSkills', () => {\n\
       let preset = null;\n\
       if (cfg.preset && cfg.preset !== 'custom') { try { preset = pr.loadPreset(cfg.preset, dir); } catch { preset = null; } }\n\
       const ids = new Set(hp.resolveHarnessPlan(cfg, path.resolve(ba.getCoreRoot(), 'core-assets'), preset).skills.map((s) => s.id));\n\
       return lsp.classifyLocalSkills(dir, cfg.project?.localSkills ?? [], ids);\n\
     });\n\
     if (request.doctor) {\n\
       const r = cp.spawnSync(process.execPath, [request.cli, 'doctor', '--json'], { cwd: dir, encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NO_COLOR: '1' } });\n\
       const report = JSON.parse(r.stdout);\n\
       out.contextMarkers = { ok: report.managedBlocks };\n\
       out.presetOverride = { ok: report.presetOverride ?? null };\n\
     }\n\
     return out;",
);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A repo to scan.
struct Case {
    name: &'static str,
    /// `navori.config.json` as a JSON value (merged over `{ name, preset: "custom", engines }`).
    config: Value,
    /// `(path, body)` written under the repo root.
    files: Vec<(String, String)>,
    /// Paths that get `chmod 755`.
    exec: Vec<&'static str>,
    /// Name of the repo directory (matters to `scanNameMismatch`).
    dir_name: &'static str,
    /// Also compare the `doctor --json` fields (slow: one Node process).
    doctor: bool,
    /// The repo is a git repo with a GitHub `origin`.
    github: bool,
    /// Scans the Rust port must decline for this case.
    delegates: &'static [&'static str],
    /// Scans whose reply must be non-trivial here (guards against a vacuous comparison).
    hits: &'static [&'static str],
}

fn case(name: &'static str, config: Value) -> Case {
    Case {
        name,
        config,
        files: Vec::new(),
        exec: Vec::new(),
        dir_name: "proj",
        doctor: false,
        github: false,
        delegates: &[],
        hits: &[],
    }
}

impl Case {
    fn file(mut self, path: impl Into<String>, body: impl Into<String>) -> Self {
        self.files.push((path.into(), body.into()));
        self
    }
    fn exec(mut self, path: &'static str) -> Self {
        self.exec.push(path);
        self
    }
    fn dir(mut self, dir_name: &'static str) -> Self {
        self.dir_name = dir_name;
        self
    }
    fn doctor(mut self) -> Self {
        self.doctor = true;
        self
    }
    fn github(mut self) -> Self {
        self.github = true;
        self
    }
    fn hits(mut self, scans: &'static [&'static str]) -> Self {
        self.hits = scans;
        self
    }
    fn delegates(mut self, scans: &'static [&'static str]) -> Self {
        self.delegates = scans;
        self
    }

    /// Writes the repo and returns `(repo root, home)`.
    fn write(&self) -> Result<(PathBuf, PathBuf), String> {
        let base = std::env::temp_dir().join(format!(
            "navori-doctor-local-{}-{}-{}",
            self.name.replace(['/', ' '], "-"),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join(self.dir_name);
        let home = base.join("home");
        for dir in [&root, &home] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut config = json!({ "name": "proj", "preset": "custom", "engines": ["claude"] });
        if let (Some(base), Some(extra)) = (config.as_object_mut(), self.config.as_object()) {
            for (k, v) in extra {
                base.insert(k.clone(), v.clone());
            }
        }
        put(&root, "navori.config.json", &config.to_string())?;
        for (rel, body) in &self.files {
            put(&root, rel, body)?;
        }
        if self.github {
            put(&root, ".git/HEAD", "ref: refs/heads/main\n")?;
            for dir in [".git/objects", ".git/refs"] {
                std::fs::create_dir_all(root.join(dir)).map_err(|e| e.to_string())?;
            }
            put(
                &root,
                ".git/config",
                "[remote \"origin\"]\n\turl = https://github.com/acme/proj.git\n",
            )?;
        }
        for rel in &self.exec {
            set_mode(&root.join(rel), 0o755)?;
        }
        Ok((root, home))
    }
}

fn put(root: &Path, rel: &str, body: &str) -> Result<(), String> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, body).map_err(|e| format!("{rel}: {e}"))
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// A managed block as `listMarkers` reads it.
fn block(id: &str, extra: &str) -> String {
    format!(
        "<!-- navori:managed id=\"{id}\"{extra} -->\nbody\n<!-- /navori:managed id=\"{id}\" -->\n"
    )
}

// ---------------------------------------------------------------------------------------------
// Rust side
// ---------------------------------------------------------------------------------------------

fn strs<I, S>(items: I) -> Value
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    Value::Array(items.into_iter().map(|s| json!(s.as_ref())).collect())
}

/// Drops `null`-valued object members on both sides: the TS result went through
/// `JSON.stringify`, where `undefined` vanishes, and the Rust mapping omits `None` the same way.
fn strip(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, strip(v)))
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(strip).collect()),
        other => other,
    }
}

fn opt<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

/// A scan name with the Rust answer (`Err` = the port declines).
type Scan = (&'static str, Result<Value, Unmodeled>);

/// Every scan on `root`, as `name -> Ok(json) | Err(Unmodeled)`.
fn rust_scans(case: &Case, root: &Path) -> Result<Vec<Scan>, String> {
    let bytes = std::fs::read(root.join("navori.config.json")).map_err(|e| e.to_string())?;
    let cfg =
        config::read(&bytes).map_err(|e| format!("rust rejects the fixture config: {e:?}"))?;
    let mut out: Vec<Scan> = Vec::new();
    out.push((
        "managedOrder",
        scan_managed_order(root, &cfg).map(|r| {
            r.map_or(Value::Null, |o| {
                json!({
                    "current": o.current, "expected": o.expected, "interleaved": o.interleaved,
                    "misplacedFirst": o.misplaced_first.map(|m| json!({
                        "id": m.id, "currentPos": m.current_pos, "total": m.total })),
                })
            })
        }),
    ));
    out.push((
        "malformed",
        scan_malformed_markers(root, &cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|m| {
                        json!({ "filePath": m.file_path, "line": m.line,
                                "snippet": m.snippet, "reason": m.reason.as_str() })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "excluded",
        scan_excluded_blocks(&cfg).map(|r| {
            r.map_or(Value::Null, |e| {
                json!({ "excluded": e.excluded, "nonExcludable": e.non_excludable, "unknown": e.unknown })
            })
        }),
    ));
    out.push((
        "legacyAgents",
        scan_legacy_agents(root, &cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|a| json!({ "legacyName": a.legacy_name, "canonical": a.canonical }))
                    .collect(),
            )
        }),
    ));
    out.push((
        "retiredAssets",
        scan_retired_assets(root).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|a| {
                        json!({ "path": a.path, "id": a.id, "successor": opt(a.successor),
                                "reason": opt(a.reason) })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "retiredPlugins",
        scan_retired_plugin_leftovers(root, &cfg).map(|r| {
            json!({ "declared": [], "assets": [], "references": [],
                    "blocks": r.blocks.into_iter()
                        .map(|b| json!({ "path": b.path, "id": b.id })).collect::<Vec<_>>() })
        }),
    ));
    out.push((
        "permission",
        scan_permission_mode(root).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|c| json!({ "mode": c.mode, "path": c.path, "missing": c.missing }))
                    .collect(),
            )
        }),
    ));
    out.push((
        "nameMismatch",
        scan_name_mismatch(root, &cfg).map(|r| {
            r.map_or(Value::Null, |n| {
                json!({ "configName": n.config_name, "dirName": n.dir_name,
                        "suggestedName": n.suggested_name })
            })
        }),
    ));
    let written: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let name = written["name"].as_str().unwrap_or_default().to_owned();
    out.push(("placeholder", Ok(json!(is_placeholder_name(&name)))));
    out.push((
        "hookScripts",
        scan_claude_hook_scripts(root, &cfg).map(|r| {
            r.map_or(
                Value::Null,
                |h| json!({ "missing": h.missing, "notExecutable": h.not_executable }),
            )
        }),
    ));
    out.push((
        "mcp",
        scan_mcp_coherence(root, &cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|i| match i {
                        McpCoherenceIssue::MissingEntry { plugin_id } => {
                            json!({ "kind": "missing-entry", "pluginId": plugin_id })
                        }
                        McpCoherenceIssue::CommandMismatch {
                            plugin_id,
                            expected,
                            actual,
                        } => {
                            json!({ "kind": "command-mismatch", "pluginId": plugin_id,
                                    "expected": expected, "actual": actual })
                        }
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "monorepo",
        scan_monorepo_drift(&cfg).map(|r| {
            r.map_or(Value::Null, |m| {
                json!({ "disabled": m.disabled, "added": m.added, "orphan": m.orphan,
                        "emptyDeclared": m.empty_declared })
            })
        }),
    ));
    let github = case.github;
    out.push((
        "providers",
        list_available_external_providers(&cfg, &mut || Ok(github)).map(strs),
    ));
    out.push((
        "localSkills",
        classify_local_skills(root, &cfg)
            .map(|l| json!({ "emit": l.emit, "missing": l.missing, "foreign": l.foreign })),
    ));
    if case.doctor {
        out.push((
            "contextMarkers",
            list_context_markers(root).map(|v| {
                Value::Array(
                    v.into_iter()
                        .map(|m| {
                            json!({ "id": m.id, "hash": opt(m.hash), "version": opt(m.version),
                                    "source": opt(m.source) })
                        })
                        .collect(),
                )
            }),
        ));
        out.push(("presetOverride", preset_override(root, &cfg).map(opt)));
    }
    Ok(out)
}

fn node_dir() -> String {
    let out = std::process::Command::new("node")
        .args(["-p", "require('path').dirname(process.execPath)"])
        .output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

/// A reply with no finding: `null`, `false`, `[]`, or an object whose every field is trivial
/// (`hookScripts`, `retiredPlugins` and `localSkills` always reply with an object of lists).
fn is_trivial(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Array(items) => items.is_empty(),
        Value::Object(fields) => fields.values().all(is_trivial),
        _ => false,
    }
}

/// Runs one case and removes its scratch directory when it passes (a failure keeps it to inspect).
fn check(case: &Case) -> Result<(), String> {
    let (root, home) = case.write()?;
    let result = check_in(case, &root, &home);
    if result.is_ok()
        && let Some(base) = root.parent()
    {
        let _ = std::fs::remove_dir_all(base);
    }
    result
}

fn check_in(case: &Case, root: &Path, home: &Path) -> Result<(), String> {
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/cli/src/index.ts");
    let ts = NODE.ask(&json!({
        "dir": root, "home": home, "nodeDir": node_dir(), "doctor": case.doctor,
        "cli": cli.canonicalize().map_err(|e| e.to_string())?,
    }))?;
    let mut failures = Vec::new();
    for (scan, rust) in rust_scans(case, root)? {
        let declared = case.delegates.contains(&scan);
        match rust {
            Err(Unmodeled) if declared => {}
            Err(Unmodeled) => failures.push(format!("{scan}: rust delegates, not declared")),
            Ok(_) if declared => {
                failures.push(format!("{scan}: declared as delegating, but rust answered"))
            }
            Ok(rust) => {
                let reply = &ts[scan];
                let Some(ok) = reply.get("ok") else {
                    failures.push(format!("{scan}: ts threw {reply}; rust answered {rust}"));
                    continue;
                };
                let (ts_v, rust_v) = (strip(ok.clone()), strip(rust));
                if is_trivial(&ts_v) && case.hits.contains(&scan) {
                    failures.push(format!("{scan}: expected a finding, ts replied {ts_v}"));
                }
                if ts_v != rust_v {
                    failures.push(format!("{scan}:\n  ts   {ts_v}\n  rust {rust_v}"));
                }
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("[{}]\n{}", case.name, failures.join("\n")))
    }
}

fn run_all(cases: Vec<Case>) -> Result<(), String> {
    let errors: Vec<String> = cases.iter().filter_map(|c| check(c).err()).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n\n"))
    }
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

/// A clean config: every scan finds nothing.
#[test]
fn empty_repo() -> Result<(), String> {
    run_all(vec![case("empty", json!({}))])
}

/// `scanNameMismatch` / `isPlaceholderName`: placeholder, mismatch, kebab-cased dir, no kebab form.
#[test]
fn names() -> Result<(), String> {
    run_all(vec![
        case("placeholder-temp-app", json!({ "name": "temp-app" })),
        case("placeholder-my-app", json!({ "name": "my-app" })),
        case("name-matches-dir", json!({ "name": "my-repo" })).dir("my-repo"),
        case("name-mismatch", json!({ "name": "other" }))
            .dir("my-repo")
            .hits(&["nameMismatch"]),
        case("underscore-dir", json!({ "name": "my-repo" })).dir("My_Repo"),
        case("dir-without-kebab", json!({ "name": "x" })).dir("___"),
    ])
}

/// `scanExcludedBlocks`: none, excludable, non-excludable, unknown, mixed.
#[test]
fn excluded_blocks() -> Result<(), String> {
    run_all(vec![
        case("excl-empty-list", json!({ "blocks": { "exclude": [] } })),
        case("excl-unknown", json!({ "blocks": { "exclude": ["nope"] } })),
        case(
            "excl-mixed",
            json!({ "blocks": { "exclude": ["sdd", "nope", "language", "sdd"] } }),
        ),
    ])
}

/// `scanManagedOrder` and `scanMalformedMarkers` over `CLAUDE.md`.
#[test]
fn order_and_malformed_markers() -> Result<(), String> {
    let ids = navori_core::render::claude_md::CLAUDE_COMPUTED_BLOCK_IDS;
    let (first, last) = (ids[0], ids[2]);
    let ordered = [block(first, ""), block(last, "")].concat();
    let swapped = [block(last, ""), block(first, "")].concat();
    run_all(vec![
        case("claude-md-absent", json!({})),
        case("claude-md-ordered", json!({})).file("CLAUDE.md", ordered),
        case("claude-md-swapped", json!({}))
            .file("CLAUDE.md", swapped)
            .hits(&["managedOrder"]),
        case("malformed-unterminated", json!({})).hits(&["malformed"]).file(
            "CLAUDE.md",
            "<!-- navori:managed id=\"a\" hash=\"x\"\ntext\n<!-- /navori:managed id=\"a\" -->\n",
        ),
        case("malformed-missing-id", json!({})).file(
            "CLAUDE.md",
            "text\n<!-- navori:managed hash=\"x\" -->\nbody\n<!-- /navori:managed -->\n",
        ),
        case("malformed-long-snippet", json!({})).file(
            "CLAUDE.md",
            format!("<!-- navori:managed id=\"a\" {} \n", "x".repeat(120)),
        ),
        case("malformed-in-agents-md", json!({ "engines": ["claude", "codex"] }))
            .file("AGENTS.md", "<!-- navori:managed hash=\"x\" -->\n"),
    ])
}

/// `listContextMarkers` through `doctor --json`'s `managedBlocks`.
#[test]
fn context_markers() -> Result<(), String> {
    run_all(vec![
        case("ctx-absent", json!({})).doctor(),
        case("ctx-two-files", json!({}))
            .hits(&["contextMarkers"])
            .file(
                ".claude/context/b.md",
                block("b-block", " hash=\"h2\" version=\"2\" source=\"s2\""),
            )
            .file(
                ".claude/context/a.md",
                block("a-block", " hash=\"h1\" version=\"1\" source=\"s1\""),
            )
            .file(".claude/context/notes.txt", block("ignored", ""))
            .doctor(),
        case("ctx-closing-only", json!({}))
            .file(
                ".claude/context/a.md",
                "<!-- /navori:managed id=\"x\" -->\n",
            )
            .doctor(),
        case("ctx-uppercase-name-sorts-first", json!({}))
            .file(".claude/context/B.md", block("upper", ""))
            .file(".claude/context/a.md", block("lower", ""))
            .doctor(),
    ])
}

/// `presetOverride` expression (doctor.ts:346): local preset shadowing a bundled one.
#[test]
fn preset_override_branches() -> Result<(), String> {
    let local = |id: &str| json!({ "id": id, "displayName": "Mine" }).to_string();
    let nextjs = local("nextjs");
    let mine = local("my-preset");
    run_all(vec![
        case("preset-custom", json!({})).doctor(),
        case("preset-bundled", json!({ "preset": "nextjs" })).doctor(),
        case(
            "preset-local-shadows-bundled",
            json!({ "preset": "nextjs" }),
        )
        .hits(&["presetOverride"])
        .file(".navori/presets/nextjs/nextjs.json", nextjs)
        .doctor(),
        case("preset-local-only", json!({ "preset": "my-preset" }))
            .file(".navori/presets/my-preset/my-preset.json", mine)
            .doctor(),
        case("preset-phantom", json!({ "preset": "does-not-exist" })).doctor(),
    ])
}

/// `scanLegacyAgents` and `scanRetiredAssets`.
#[test]
fn legacy_agents_and_retired_assets() -> Result<(), String> {
    use navori_core::render::retirements::{RETIRED_AGENTS, RETIRED_HOOKS, RETIRED_SKILLS};
    // First entry of each retirement table: user-authored (no marker) and navori-owned (marker).
    let (agent, skill, hook) = (&RETIRED_AGENTS[0], &RETIRED_SKILLS[0], &RETIRED_HOOKS[0]);
    let owned = |marker: &str| format!("<!-- navori:managed id=\"{marker}\" -->\nx\n");
    let engines = json!({ "engines": ["claude", "codex"] });
    let retired = case("retired-user-authored", engines.clone())
        .hits(&["retiredAssets"])
        .file(format!(".claude/agents/{}.md", agent.id), "# mine\n")
        .file(format!(".codex/agents/{}.toml", agent.id), "# mine\n")
        .file(format!(".claude/skills/{}.md", skill.id), "# mine\n")
        .file(format!(".claude/skills/{}/SKILL.md", skill.id), "# mine\n")
        .file(format!(".agents/skills/{}/SKILL.md", skill.id), "# mine\n")
        .file(format!(".claude/hooks/{}.sh", hook.id), "#!/bin/sh\n")
        .file(format!(".codex/hooks/{}.sh", hook.id), "#!/bin/sh\n");
    let retired_owned = case("retired-navori-owned", engines)
        .file(
            format!(".claude/agents/{}.md", agent.id),
            owned(agent.claude_marker),
        )
        .file(
            format!(".claude/skills/{}/SKILL.md", skill.id),
            owned(skill.claude_marker),
        )
        .file(
            format!(".claude/hooks/{}.sh", hook.id),
            format!(
                "#!/bin/sh\n# navori:managed start id=\"{}\"\n",
                hook.claude_marker
            ),
        );
    run_all(vec![
        case("legacy-agent-aliases", json!({}))
            .hits(&["legacyAgents"])
            .file(".claude/agents/sdd-leader.md", "# x\n")
            .file(".claude/agents/sdd-implementer.md", "# x\n")
            .file(".claude/agents/sdd-explorer.md", "# x\n")
            .file(".claude/agents/deep-auditor.md", "# x\n")
            .file(".claude/agents/implementer.md", "# canonical, not legacy\n")
            .file(".claude/agents/notes.txt", "ignored"),
        case(
            "legacy-agent-role-disabled",
            json!({ "harness": { "implementer": false, "scout": true } }),
        )
        .file(".claude/agents/sdd-implementer.md", "# x\n")
        .file(".claude/agents/sdd-explorer.md", "# x\n"),
        case("agents-dir-absent", json!({})),
        retired,
        retired_owned,
    ])
}

/// `scanRetiredPluginLeftovers`: retired blocks and sub-blocks; a declared retired plugin delegates.
#[test]
fn retired_plugins() -> Result<(), String> {
    use navori_core::render::plugins::{RETIRED_PLUGIN_BLOCKS, RETIRED_PLUGINS};
    let mut cases = vec![case("retired-none", json!({}))];
    if let Some((plugin, _)) = RETIRED_PLUGINS.first() {
        cases.push(
            case(
                "retired-declared",
                json!({ "plugins": { *plugin: { "enabled": true } } }),
            )
            .delegates(&["retiredPlugins"]),
        );
    }
    for (_, _, block_ids) in RETIRED_PLUGIN_BLOCKS {
        for block_id in *block_ids {
            cases.push(
                case("retired-block-on-disk", json!({}))
                    .hits(&["retiredPlugins"])
                    .file("CLAUDE.md", block(block_id, "")),
            );
        }
    }
    for (_, retired) in RETIRED_PLUGINS {
        for block_id in retired.block_ids {
            cases.push(
                case("retired-plugin-block-ids", json!({}))
                    .hits(&["retiredPlugins"])
                    .file("CLAUDE.md", block(block_id, "")),
            );
        }
    }
    for (_, _, entries) in navori_core::render::plugins::RETIRED_PLUGIN_SUB_BLOCKS {
        for (id, target) in *entries {
            let Some(rest) = target.strip_prefix(".claude/skills/") else {
                continue;
            };
            let codex = format!(".agents/skills/{}", rest);
            cases.push(
                case("retired-sub-block-codex-skill", json!({}))
                    .hits(&["retiredPlugins"])
                    .file(codex, block(id, "")),
            );
        }
    }
    if let Some((_, retired)) = RETIRED_PLUGINS.iter().find(|(_, r)| !r.assets.is_empty()) {
        let asset = retired.assets[0];
        cases.push(
            case("retired-script-delegates", json!({}))
                .delegates(&["retiredPlugins"])
                .file(asset, "#!/bin/sh\n"),
        );
    }
    run_all(cases)
}

/// `scanPermissionMode`: both settings files, every cycle-tool combination.
#[test]
fn permission_mode() -> Result<(), String> {
    let acc = |allow: Value| {
        json!({ "permissions": { "defaultMode": "dontAsk", "allow": allow } }).to_string()
    };
    run_all(vec![
        case("perm-none", json!({})),
        case("perm-dont-ask-granted", json!({}))
            .file(".claude/settings.json", acc(json!(["Edit", "Write"]))),
        case("perm-dont-ask-missing-both", json!({}))
            .hits(&["permission"])
            .file(".claude/settings.json", acc(json!([]))),
        case("perm-top-level-mode", json!({})).file(
            ".claude/settings.json",
            json!({ "defaultMode": "dontAsk", "allow": ["Edit"] }).to_string(),
        ),
        case("perm-missing-write", json!({}))
            .file(".claude/settings.local.json", acc(json!(["Edit"])))
            .hits(&["permission"]),
        case("perm-plan-mode", json!({})).file(
            ".claude/settings.json",
            json!({ "permissions": { "defaultMode": "plan" } }).to_string(),
        ),
        case("perm-no-allow-key", json!({})).file(
            ".claude/settings.json",
            json!({ "permissions": { "defaultMode": "dontAsk" } }).to_string(),
        ),
        case("perm-settings-not-an-object", json!({})).file(".claude/settings.json", "[1]"),
    ])
}

/// `scanClaudeHookScripts`: referenced scripts missing, present, executable or not.
#[test]
fn claude_hook_scripts() -> Result<(), String> {
    let hooks = |cmds: &[&str]| {
        let entries: Vec<Value> = cmds
            .iter()
            .map(|c| json!({ "type": "command", "command": c }))
            .collect();
        json!({ "hooks": { "PreToolUse": [{ "matcher": "*", "hooks": entries }] } }).to_string()
    };
    run_all(vec![
        case("hooks-no-settings", json!({})),
        case("hooks-not-claude", json!({ "engines": ["codex"] })),
        case("hooks-missing", json!({}))
            .file(
                ".claude/settings.json",
                hooks(&["sh .claude/hooks/gone.sh"]),
            )
            .hits(&["hookScripts"]),
        case("hooks-present-not-exec", json!({}))
            .hits(&["hookScripts"])
            .file(
                ".claude/settings.json",
                hooks(&["bash .claude/hooks/a.sh --x"]),
            )
            .file(".claude/hooks/a.sh", "#!/bin/sh\n"),
        case("hooks-present-exec", json!({}))
            .file(
                ".claude/settings.json",
                hooks(&["\"$CLAUDE_PROJECT_DIR\"/.claude/scripts/b.sh"]),
            )
            .file(".claude/scripts/b.sh", "#!/bin/sh\n")
            .exec(".claude/scripts/b.sh"),
        case("hooks-repeated-ref", json!({})).file(
            ".claude/settings.json",
            hooks(&[".claude/hooks/x.sh", ".claude/hooks/x.sh"]),
        ),
        case("hooks-settings-local", json!({})).file(
            ".claude/settings.local.json",
            hooks(&[".claude/hooks/l.sh"]),
        ),
        case("hooks-unparseable-settings", json!({}))
            .file(".claude/settings.json", "{ nope")
            // V8's JSON.parse message / a corrupted settings file: not modelled, the CLI delegates.
            .delegates(&["permission", "hookScripts"]),
    ])
}

/// `scanMcpCoherence` for an enabled plugin with an external tool.
#[test]
fn mcp_coherence() -> Result<(), String> {
    let plugins = || json!({ "plugins": { "engram": { "enabled": true } } });
    run_all(vec![
        case("mcp-no-plugins", json!({})),
        case("mcp-missing-file", plugins()),
        case("mcp-missing-entry", plugins())
            .file(".mcp.json", json!({ "mcpServers": {} }).to_string())
            .hits(&["mcp"]),
        case("mcp-matching", plugins()).file(
            ".mcp.json",
            json!({ "mcpServers": { "engram": { "command": "engram" } } }).to_string(),
        ),
        case("mcp-non-string-command", plugins())
            .file(
                ".mcp.json",
                json!({ "mcpServers": { "engram": { "command": 7 } } }).to_string(),
            )
            .delegates(&[]),
        case("mcp-wrong-command", plugins()).hits(&["mcp"]).file(
            ".mcp.json",
            json!({ "mcpServers": { "engram": { "command": "other" } } }).to_string(),
        ),
        case(
            "mcp-not-claude",
            json!({ "engines": ["codex"], "plugins": { "engram": { "enabled": true } } }),
        ),
    ])
}

/// `scanMonorepoDrift`: absent, disabled with workspaces declared; enabled delegates.
#[test]
fn monorepo_drift() -> Result<(), String> {
    run_all(vec![
        case("mono-absent", json!({})),
        case("mono-disabled", json!({ "monorepo": { "enabled": false } })),
        case(
            "mono-disabled-declared",
            json!({ "monorepo": { "enabled": false, "workspaces": [] } }),
        ),
        case("mono-enabled", json!({ "monorepo": { "enabled": true } })).delegates(&["monorepo"]),
    ])
}

/// `listAvailableExternalProviders`: `gh` only in a GitHub repo; enabled plugins are skipped.
#[test]
fn available_external_providers() -> Result<(), String> {
    run_all(vec![
        case("prov-default", json!({})),
        case("prov-github", json!({})).github().hits(&["providers"]),
        case(
            "prov-tgrep-enabled",
            json!({ "plugins": { "tgrep": { "enabled": true } } }),
        ),
        case(
            "prov-tgrep-disabled",
            json!({ "plugins": { "tgrep": { "enabled": false } } }),
        ),
    ])
}

/// `classifyLocalSkills`: missing, emit and foreign pointers.
#[test]
fn local_skills() -> Result<(), String> {
    let skills = |ids: &[&str]| json!({ "project": { "localSkills": ids } });
    run_all(vec![
        case("skills-none", json!({})),
        case("skills-missing", skills(&["alpha"])).hits(&["localSkills"]),
        case("skills-present", skills(&["alpha"]))
            .file(".claude/skills/alpha/SKILL.md", "---\nname: alpha\n---\n"),
        case("skills-foreign-pointer", skills(&["alpha"]))
            .file(".claude/skills/alpha/SKILL.md", "---\nname: alpha\n---\n")
            .file(".agents/skills/alpha/SKILL.md", "mine, not navori's\n"),
        case("skills-unsafe-id", skills(&["../evil", "a/b"])),
    ])
}

/// `needsExternalProviderSetupHint`: every input combination, against `doctor.ts:2041`.
#[test]
fn setup_hint_truth_table() -> Result<(), String> {
    static HINT: Shared = Shared::new(
        prelude,
        "return d.needsExternalProviderSetupHint(request.missing.map((pluginId) => ({ pluginId })), request.available, request.tgrep ? {} : null, request.codegraph ? {} : null);",
    );
    for missing in [vec![], vec!["gh"], vec!["tgrep"], vec!["codegraph"]] {
        for available in [vec![], vec!["gh"], vec!["codegraph"], vec!["acli", "tgrep"]] {
            for tgrep in [false, true] {
                for codegraph in [false, true] {
                    let ts = HINT.ask(&json!({
                        "missing": missing, "available": available, "tgrep": tgrep, "codegraph": codegraph }))?;
                    let avail: Vec<String> = available.iter().map(|s| (*s).to_owned()).collect();
                    let rust =
                        needs_external_provider_setup_hint(&missing, &avail, tgrep, codegraph);
                    if ts != json!(rust) {
                        return Err(format!(
                            "{missing:?} {available:?} {tgrep} {codegraph}: ts {ts} rust {rust}"
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}
