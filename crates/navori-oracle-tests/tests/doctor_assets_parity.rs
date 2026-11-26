//! `navori_core::diagnose::doctor_assets` against the TS `doctor` asset and render scans (spec
//! 0060 T23 slice 3b).
//!
//! Every case is a small repo written to a temp dir, with an explicit config. For each case the
//! TS side runs every scan on that dir and the Rust side does the same; replies are compared as
//! normalised JSON. The Node side runs with `HOME` pointing at a per-case dir, a minimal `PATH`
//! and no global git config. `hasBinary` (slice 3c) is stubbed: the TS `PATH` is narrowed to a
//! per-case `bin/` dir while `scanQualityGateReadiness` runs, and the Rust stub answers "is there
//! an executable file of that name in that dir". `scanMasterPlan` is out of scope (slice 5e4).
//!
//! A scan the Rust port declines ([`Unmodeled`], the CLI then delegates) must be listed in the
//! case's `delegates`; the list is checked both ways, so it cannot rot.

mod support;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::diagnose::doctor_assets::{
    ArtifactReason, BlockKind, ContextDelivery, ControlState, DEFAULT_PROGRESS_THRESHOLD_BYTES,
    DocBudgetFile, DocBudgetLever, MissingTier, Unmodeled, doctor_skill_dirs, scan_control_gaps,
    scan_doc_budget, scan_empty_user_sections, scan_flat_skills, scan_foreign_skill_indexes,
    scan_git_hygiene, scan_gitignore_harness, scan_interpolation_artifacts,
    scan_missing_model_profile, scan_nested_worktrees, scan_prettier_ignore, scan_progress_size,
    scan_quality_gate_readiness, scan_stale_harness, scan_triggerless_local_skills,
    scan_workspace_full_harness,
};
use navori_core::process::RealRunner;
use navori_core::render::ignore_files::gitignore_body;
use serde_json::{Map, Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const fs = await import('node:fs');\nconst path = await import('node:path');\n\
         const c = await import({:?});\nconst d = await import({:?});\nconst ba = await import({:?});\n\
         const gr = await import({:?});\nconst us = await import({:?});\nconst tr = await import({:?});\n\
         const ia = await import({:?});\nconst mp = await import({:?});\nconst cg = await import({:?});\n\
         const ps = await import({:?});\nconst nw = await import({:?});\nconst sh = await import({:?});\n\
         const fl = await import({:?});\nconst fi = await import({:?});\nconst gi = await import({:?});\n\
         const pi = await import({:?});\n\
         process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = '/dev/null';",
        cli_module("lib/config/config.ts"),
        cli_module("commands/doctor.ts"),
        cli_module("lib/render/bundled-assets.ts"),
        cli_module("lib/config/gate-readiness.ts"),
        cli_module("lib/assets/skill-user-section.ts"),
        cli_module("lib/assets/skill-triggers.ts"),
        cli_module("lib/render/interpolation-artifacts.ts"),
        cli_module("lib/assets/model-profile.ts"),
        cli_module("lib/diagnose/control-gaps.ts"),
        cli_module("lib/diagnose/progress-size.ts"),
        cli_module("lib/workspace/nested-worktrees.ts"),
        cli_module("lib/diagnose/stale-harness.ts"),
        cli_module("lib/assets/flat-skills.ts"),
        cli_module("lib/assets/foreign-skill-index.ts"),
        cli_module("engines/shared/gitignore-harness.ts"),
        cli_module("engines/shared/prettierignore-harness.ts"),
    )
}

/// One request = one fixture dir; the reply maps each scan name to `{ ok }` or `{ err }`.
static NODE: Shared = Shared::new(
    prelude,
    "process.env.HOME = request.home; process.env.PATH = request.path;\n\
     const cfg = c.readConfig(path.join(request.dir, 'navori.config.json'));\n\
     const dir = request.dir;\n\
     const out = {};\n\
     const run = (name, f) => { try { out[name] = { ok: f() ?? null }; } catch (e) { out[name] = { err: String(e && e.message || e) }; } };\n\
     run('gate', () => { process.env.PATH = request.binDir; try { return gr.scanQualityGateReadiness(dir, cfg); } finally { process.env.PATH = request.path; } });\n\
     run('emptySections', () => us.scanEmptyUserSections(dir, ['.claude/skills', ...(cfg.engines.includes('codex') ? ['.agents/skills'] : [])]));\n\
     run('skillDirs', () => ['.claude/skills', ...(cfg.engines.includes('codex') ? ['.agents/skills'] : [])]);\n\
     run('triggerless', () => tr.scanTriggerlessLocalSkills(dir, cfg.project?.localSkills ?? []));\n\
     run('artifacts', () => ia.scanInterpolationArtifacts(dir, cfg));\n\
     run('modelProfile', () => mp.scanMissingModelProfile(cfg));\n\
     run('controlGaps', () => cg.scanControlGaps(cfg));\n\
     run('progress', () => ps.scanProgressSize(dir));\n\
     run('nestedWorktrees', () => nw.scanNestedWorktrees(dir));\n\
     run('stale', () => sh.scanStaleHarness(dir, cfg));\n\
     run('workspaceFull', () => d.scanWorkspaceFullHarness(cfg));\n\
     run('flatSkills', () => fl.scanFlatSkills(dir));\n\
     run('foreignIndexes', () => fi.scanForeignSkillIndexes(dir));\n\
     run('docBudget', () => d.scanDocBudget(dir, cfg));\n\
     run('gitignore', () => gi.scanGitignoreHarness(dir, cfg));\n\
     run('prettier', () => pi.scanPrettierIgnore(dir, cfg));\n\
     run('gitHygiene', () => d.scanGitHygiene(dir, cfg));\n\
     out.cliVersion = ba.readCliVersion();\n\
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
    /// `(path bytes, body bytes)` written under the repo root, for non-UTF-8 names and content.
    raw_files: Vec<(Vec<u8>, Vec<u8>)>,
    /// `(path, body)` written under `$HOME`.
    home_files: Vec<(String, String)>,
    /// Directories created under the repo root.
    dirs: Vec<&'static str>,
    /// Names of executables placed on the stubbed `PATH` of `scanQualityGateReadiness`.
    bins: Vec<&'static str>,
    /// `git init` the repo, then `git add -f` these paths.
    git_add: Option<Vec<&'static str>>,
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
        raw_files: Vec::new(),
        home_files: Vec::new(),
        dirs: Vec::new(),
        bins: Vec::new(),
        git_add: None,
        delegates: &[],
        hits: &[],
    }
}

impl Case {
    fn file(mut self, path: impl Into<String>, body: impl Into<String>) -> Self {
        self.files.push((path.into(), body.into()));
        self
    }
    fn raw(mut self, path: &[u8], body: &[u8]) -> Self {
        self.raw_files.push((path.to_vec(), body.to_vec()));
        self
    }
    fn home(mut self, path: impl Into<String>, body: impl Into<String>) -> Self {
        self.home_files.push((path.into(), body.into()));
        self
    }
    fn dir(mut self, path: &'static str) -> Self {
        self.dirs.push(path);
        self
    }
    fn bins(mut self, names: &[&'static str]) -> Self {
        self.bins.extend_from_slice(names);
        self
    }
    fn git(mut self, add: &[&'static str]) -> Self {
        self.git_add = Some(add.to_vec());
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

    /// Writes the repo and returns its layout.
    fn write(&self) -> Result<Layout, String> {
        let base = std::env::temp_dir().join(format!(
            "navori-doctor-assets-{}-{}-{}",
            self.name.replace(['/', ' '], "-"),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let layout = Layout {
            root: base.join("proj"),
            home: base.join("home"),
            bin: base.join("bin"),
            base,
        };
        for dir in [&layout.root, &layout.home, &layout.bin] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut config = json!({ "name": "proj", "preset": "custom", "engines": ["claude"] });
        if let (Some(base), Some(extra)) = (config.as_object_mut(), self.config.as_object()) {
            for (k, v) in extra {
                base.insert(k.clone(), v.clone());
            }
        }
        put(&layout.root, "navori.config.json", &config.to_string())?;
        for (rel, body) in &self.files {
            put(&layout.root, rel, body)?;
        }
        for (rel, body) in &self.home_files {
            put(&layout.home, rel, body)?;
        }
        for rel in &self.dirs {
            std::fs::create_dir_all(layout.root.join(rel)).map_err(|e| e.to_string())?;
        }
        for (rel, body) in &self.raw_files {
            use std::os::unix::ffi::OsStrExt;
            let path = layout.root.join(std::ffi::OsStr::from_bytes(rel));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, body).map_err(|e| e.to_string())?;
        }
        for name in &self.bins {
            put(&layout.bin, name, "#!/bin/sh\n")?;
            set_mode(&layout.bin.join(name), 0o755)?;
        }
        if let Some(add) = &self.git_add {
            git(&layout.root, &["init", "-q"])?;
            for rel in add {
                git(&layout.root, &["add", "-f", "--", rel])?;
            }
        }
        Ok(layout)
    }
}

struct Layout {
    base: PathBuf,
    root: PathBuf,
    home: PathBuf,
    bin: PathBuf,
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

fn git(root: &Path, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {args:?} failed"))
    }
}

/// A managed block as the skill/CLAUDE.md readers see it.
fn block(id: &str, extra: &str) -> String {
    format!(
        "<!-- navori:managed id=\"{id}\"{extra} -->\nbody\n<!-- /navori:managed id=\"{id}\" -->\n"
    )
}

/// A rendered skill: a managed block, then the user's half.
fn skill(id: &str, user_half: &str) -> String {
    format!("{}{user_half}", block(id, ""))
}

/// A project-local skill file with a frontmatter `description`.
fn local_skill(description: &str) -> String {
    format!("---\nname: x\ndescription: {description}\n---\nbody\n")
}

// ---------------------------------------------------------------------------------------------
// Rust side
// ---------------------------------------------------------------------------------------------

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

fn file_json(f: &DocBudgetFile) -> Value {
    json!({ "path": f.path, "words": f.words, "chars": f.chars })
}

/// A scan name with the Rust answer (`Err` = the port declines).
type Scan = (&'static str, Result<Value, Unmodeled>);

/// The environment both sides see: the test process's own, which Node inherits.
fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

/// Every scan on the fixture, as `name -> Ok(json) | Err(Unmodeled)`.
fn rust_scans(layout: &Layout, cli_version: &str, path: &str) -> Result<Vec<Scan>, String> {
    let root = layout.root.as_path();
    let bytes = std::fs::read(root.join("navori.config.json")).map_err(|e| e.to_string())?;
    let cfg =
        config::read(&bytes).map_err(|e| format!("rust rejects the fixture config: {e:?}"))?;
    let env = process_env();
    let bin = layout.bin.clone();
    let has_binary = move |name: &str| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(bin.join(name))
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    let mut out: Vec<Scan> = Vec::new();
    out.push((
        "gate",
        scan_quality_gate_readiness(root, &cfg, &has_binary).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|i| {
                        json!({ "gate": i.gate, "detail": i.detail, "reason": i.reason.as_str() })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "emptySections",
        doctor_skill_dirs(&cfg).and_then(|dirs| {
            scan_empty_user_sections(root, &dirs, &env).map(|v| {
                Value::Array(
                    v.into_iter()
                        .map(|s| json!({ "id": s.id, "path": s.path }))
                        .collect(),
                )
            })
        }),
    ));
    out.push(("skillDirs", doctor_skill_dirs(&cfg).map(|d| json!(d))));
    out.push((
        "triggerless",
        scan_triggerless_local_skills(root, &cfg, &env).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|s| json!({ "id": s.id, "path": s.path }))
                    .collect(),
            )
        }),
    ));
    out.push((
        "artifacts",
        scan_interpolation_artifacts(root, &cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|a| {
                        json!({ "path": a.path, "line": a.line, "token": a.token,
                                "reason": match a.reason {
                                    ArtifactReason::UnresolvedPlaceholder => "unresolved-placeholder",
                                    ArtifactReason::UnconfiguredGate => "unconfigured-gate",
                                } })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "modelProfile",
        scan_missing_model_profile(&cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|m| {
                        json!({ "agent": m.agent, "harnessKey": m.harness_key,
                                "missing": m.missing.iter().map(|t| match t {
                                    MissingTier::Model => "model",
                                    MissingTier::Effort => "effort",
                                }).collect::<Vec<_>>() })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "controlGaps",
        scan_control_gaps(&cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|g| {
                        json!({ "engine": g.engine, "control": g.control, "reason": g.reason,
                                "state": match g.state {
                                    ControlState::Advisory => "advisory",
                                    ControlState::Unsupported => "unsupported",
                                },
                                "severity": if g.warn { "warn" } else { "info" } })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "progress",
        Ok(scan_progress_size(root, DEFAULT_PROGRESS_THRESHOLD_BYTES).map_or(Value::Null, |p| {
            json!({ "path": p.path, "bytes": p.bytes, "thresholdBytes": p.threshold_bytes })
        })),
    ));
    out.push((
        "nestedWorktrees",
        scan_nested_worktrees(root).map(|r| {
            r.map_or(
                Value::Null,
                |n| json!({ "eslintConfig": n.eslint_config, "worktrees": n.worktrees }),
            )
        }),
    ));
    out.push((
        "stale",
        scan_stale_harness(root, &cfg, &env).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|s| {
                        json!({ "path": s.path, "reason": "undeclared-workspace",
                                "frozenAt": opt(s.frozen_at), "files": s.files })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "workspaceFull",
        scan_workspace_full_harness(&cfg)
            .map(|r| r.map_or(Value::Null, |w| json!({ "workspaces": w }))),
    ));
    out.push((
        "flatSkills",
        scan_flat_skills(root, &layout.home, &env).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|s| json!({ "path": s.path, "id": s.id, "suggested": s.suggested }))
                    .collect(),
            )
        }),
    ));
    out.push((
        "foreignIndexes",
        scan_foreign_skill_indexes(root).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|f| {
                        json!({ "path": f.path, "producer": f.producer, "indexed": f.indexed,
                                "frozenAt": opt(f.frozen_at) })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "docBudget",
        scan_doc_budget(root, &cfg, cli_version).map(|r| {
            r.map_or(Value::Null, |b| {
                json!({
                    "totalWords": b.total_words, "managedWords": b.managed_words,
                    "ownWords": b.own_words, "unbudgetedWords": b.unbudgeted_words,
                    "ceiling": b.ceiling, "overBy": b.over_by,
                    "blocks": b.blocks.iter().map(|k| json!({
                        "id": k.id, "words": k.words, "rows": k.rows, "ceiling": k.ceiling,
                        "kind": match k.kind {
                            BlockKind::Static => "static",
                            BlockKind::Computed => "computed",
                            BlockKind::Unbudgeted => "unbudgeted",
                        },
                        "over": k.over,
                        "lever": match k.lever {
                            DocBudgetLever::ProjectContext => "project-context",
                            DocBudgetLever::Preset => "preset",
                            DocBudgetLever::Plugins => "plugins",
                            DocBudgetLever::Core => "core",
                        } })).collect::<Vec<_>>(),
                    "cliVersion": b.cli_version,
                    "contextFiles": b.context_files.iter().map(|f| json!({
                        "path": f.file.path, "words": f.file.words, "chars": f.file.chars,
                        "delivered": match f.delivered {
                            ContextDelivery::Inline => "inline",
                            ContextDelivery::Pointer => "pointer",
                        },
                        "ctxCharsBefore": f.ctx_chars_before })).collect::<Vec<_>>(),
                    "contextWords": b.context_words, "contextChars": b.context_chars,
                    "contextDeliveryBudget": b.context_delivery_budget,
                    "agentsMd": b.agents_md.as_ref().map(file_json),
                    "agentsMdMaxBytes": b.agents_md_max_bytes,
                    "agentsMdCeiling": b.agents_md_ceiling, "agentsMdOverBy": b.agents_md_over_by,
                    "cursorRules": b.cursor_rules.as_ref().map(file_json),
                    "copilotInstructions": b.copilot_instructions.as_ref().map(file_json),
                    "perSubagentWords": b.per_subagent_words,
                    "mcpServers": b.mcp_servers.iter()
                        .map(|m| json!({ "id": m.id, "alwaysLoad": m.always_load }))
                        .collect::<Vec<_>>(),
                })
            })
        }),
    ));
    let health = |r: Option<navori_core::diagnose::doctor_assets::IgnoreHealth>| {
        r.map_or(
            Value::Null,
            |h| json!({ "missing": h.missing, "drift": h.drift }),
        )
    };
    out.push(("gitignore", scan_gitignore_harness(root, &cfg).map(health)));
    out.push(("prettier", scan_prettier_ignore(root, &cfg).map(health)));
    let git_env: Vec<(OsString, OsString)> = vec![
        ("PATH".into(), path.into()),
        ("HOME".into(), layout.home.clone().into_os_string()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
    ];
    out.push((
        "gitHygiene",
        scan_git_hygiene(root, &cfg, &RealRunner, &git_env).map(|r| {
            r.map_or(Value::Null, |g| {
                json!({
                    "specsIgnored": opt(g.specs_ignored),
                    "ephemeralNotIgnored": g.ephemeral_not_ignored,
                    "ephemeralTracked": g.ephemeral_tracked,
                    "presetsIgnored": g.presets_ignored,
                    "nestedStateUnprotected": g.nested_state_unprotected,
                })
            })
        }),
    ));
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

/// A reply with nothing in it: no finding.
fn is_trivial(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Array(items) => items.is_empty(),
        Value::Object(fields) => fields.values().all(is_trivial),
        _ => false,
    }
}

fn check(case: &Case) -> Result<(), String> {
    let layout = case.write()?;
    let result = check_in(case, &layout);
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(&layout.base);
    }
    result
}

fn check_in(case: &Case, layout: &Layout) -> Result<(), String> {
    let path = format!("{}:/usr/bin:/bin", node_dir());
    let ts = NODE.ask(&json!({
        "dir": layout.root, "home": layout.home, "binDir": layout.bin, "path": path,
    }))?;
    let cli_version = ts["cliVersion"].as_str().unwrap_or_default().to_owned();
    let mut failures = Vec::new();
    for (scan, rust) in rust_scans(layout, &cli_version, &path)? {
        let declared = case.delegates.contains(&scan);
        match rust {
            Err(Unmodeled) if declared => {}
            Err(Unmodeled) => failures.push(format!("{scan}: rust delegates, not declared")),
            Ok(_) if declared => {
                failures.push(format!("{scan}: declared as delegating, but rust answered"));
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

#[test]
fn empty_repo() -> Result<(), String> {
    run_all(vec![case("empty", json!({}))])
}

#[test]
fn gate_readiness() -> Result<(), String> {
    // The schema wants both gates; `true` is a shell builtin the scan skips.
    let gate = |fast: &str, full: &str| {
        let or_true = |c: &str| {
            if c.is_empty() {
                "true".to_owned()
            } else {
                c.to_owned()
            }
        };
        json!({ "qualityGate": { "fast": or_true(fast), "full": or_true(full) } })
    };
    let pm = &["pnpm", "npm", "bun"];
    run_all(vec![
        case("gate-none", json!({})),
        case("gate-missing-binary", gate("zzz-tool run && echo ok", "zzz-tool x"))
            .hits(&["gate"]),
        case("gate-binary-present", gate("fake-lint --all", "")).bins(&["fake-lint"]),
        case("gate-pm-missing-deps", gate("pnpm lint", "bun check"))
            .bins(pm)
            .file("package.json", r#"{"scripts":{"lint":"x","check":"y"}}"#)
            .hits(&["gate"]),
        case("gate-pm-missing-script", gate("pnpm lint && npm run build", "bun toString"))
            .bins(pm)
            .file("package.json", r#"{"scripts":{"test":"x"}}"#)
            .dir("node_modules")
            .hits(&["gate"]),
        case("gate-pm-script-present", gate("pnpm run lint; npm run-script build", ""))
            .bins(pm)
            .file("package.json", r#"{"scripts":{"lint":"x","build":"y"}}"#)
            .dir("node_modules"),
        case(
            "gate-cd-then-pm",
            gate("pnpm format:check && cd packages/cli && pnpm test", "cd ../.. && pnpm lint"),
        )
        .bins(pm)
        .file("package.json", r#"{"scripts":{"lint":"x"}}"#)
        .file("packages/cli/package.json", r#"{"scripts":{"build":"x"}}"#)
        .dir("node_modules")
        .hits(&["gate"]),
        case("gate-cd-deps-in-subdir", gate("cd packages/cli && pnpm test", ""))
            .bins(pm)
            .file("packages/cli/package.json", r#"{"scripts":{"test":"x"}}"#)
            .hits(&["gate"]),
        case(
            "gate-pm-shapes",
            gate(
                "CI=1 pnpm test && pnpm --filter x lint && npm install && pnpm exec foo && npm a b && pnpm i",
                "echo hi; cd -; export X=1 | true || false & pnpm",
            ),
        )
        .bins(pm)
        .file("package.json", r#"{"scripts":{"test":"x"}}"#)
        .dir("node_modules"),
        case("gate-dup-across-gates", gate("zzz a && zzz b", "zzz c")).hits(&["gate"]),
        case("gate-pkg-blank", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", "   ")
            .delegates(&["prettier"]),
        case("gate-pkg-array", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", "[]")
            .dir("node_modules"),
        case("gate-pkg-string", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", "\"x\""),
        case("gate-pkg-no-scripts", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", "{}")
            .dir("node_modules")
            .hits(&["gate"]),
        case("gate-pkg-bom-is-unparseable", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", "\u{feff}{\"scripts\":{}}"),
        // Delegations: a `scripts` array and text Rust cannot tell from JS's `JSON.parse`.
        case("gate-scripts-array-delegates", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", r#"{"scripts":["lint"]}"#)
            .dir("node_modules")
            .delegates(&["gate"]),
        case("gate-pkg-invalid-json-delegates", gate("pnpm lint", ""))
            .bins(pm)
            .file("package.json", "{ nope")
            .delegates(&["gate", "prettier"]),
    ])
}

#[test]
fn empty_user_sections() -> Result<(), String> {
    let codex = json!({ "engines": ["claude", "codex"] });
    run_all(vec![
        case("es-no-skills-dir", json!({})),
        case("es-template-only", json!({}))
            .file(
                ".claude/skills/a/SKILL.md",
                skill("a", "\n## Mine\n<!-- fill in -->\n"),
            )
            .hits(&["emptySections"]),
        case("es-filled", json!({})).file(
            ".claude/skills/a/SKILL.md",
            skill("a", "\n## Mine\nreal prose\n"),
        ),
        case("es-no-user-half", json!({})).file(".claude/skills/a/SKILL.md", skill("a", "")),
        case("es-whitespace-half", json!({}))
            .file(".claude/skills/a/SKILL.md", skill("a", "  \n\t\n")),
        case("es-no-managed-block", json!({})).file(".claude/skills/a/SKILL.md", "# just prose\n"),
        case("es-multiline-comment", json!({}))
            .file(
                ".claude/skills/a/SKILL.md",
                skill("a", "\n# H\n<!-- a\nb\n-->\n"),
            )
            .hits(&["emptySections"]),
        case("es-unterminated-comment", json!({}))
            .file(".claude/skills/a/SKILL.md", skill("a", "\n<!-- open\n")),
        case("es-last-close-marker-wins", json!({}))
            .file(
                ".claude/skills/a/SKILL.md",
                format!("{}{}", block("a", ""), skill("b", "\n# H\n")),
            )
            .hits(&["emptySections"]),
        case("es-flat-skill-files", json!({}))
            .file(".claude/skills/flat.md", skill("flat", "\n# H\n"))
            .file(".claude/skills/dir-no-skill-md/other.md", "x")
            .file(".claude/skills/notes.txt", "x")
            .hits(&["emptySections"]),
        case("es-sorted-by-id", json!({}))
            .file(".claude/skills/b/SKILL.md", skill("b", "\n# H\n"))
            .file(".claude/skills/A/SKILL.md", skill("A", "\n# H\n"))
            .file(".claude/skills/a-b/SKILL.md", skill("a-b", "\n# H\n"))
            .file(".claude/skills/a_b/SKILL.md", skill("a_b", "\n# H\n"))
            .file(".claude/skills/c10/SKILL.md", skill("c10", "\n# H\n"))
            .file(".claude/skills/c2/SKILL.md", skill("c2", "\n# H\n"))
            .hits(&["emptySections"]),
        case("es-codex-dir", codex.clone())
            .file(".claude/skills/a/SKILL.md", skill("a", "\n# H\n"))
            .file(".agents/skills/b/SKILL.md", skill("b", "\n# H\n"))
            .hits(&["emptySections"]),
        case("es-codex-dir-ignored-without-codex", json!({}))
            .file(".agents/skills/b/SKILL.md", skill("b", "\n# H\n")),
        // Delegations: a skills root that is a file (the TS crashes), non-UTF-8 names, and an id
        // `localeCompare` is not modelled for.
        case("es-root-is-a-file-delegates", json!({}))
            .file(".claude/skills", "not a dir")
            .delegates(&["emptySections"]),
        case("es-non-utf8-name-delegates", json!({}))
            .raw(b".claude/skills/\xff/SKILL.md", b"x")
            .delegates(&["emptySections", "artifacts", "flatSkills"]),
        case("es-non-ascii-id-delegates", json!({}))
            .file(
                ".claude/skills/\u{f1}and\u{fa}/SKILL.md",
                skill("n", "\n# H\n"),
            )
            .file(".claude/skills/z/SKILL.md", skill("z", "\n# H\n"))
            .delegates(&["emptySections"]),
    ])
}

#[test]
fn triggerless_local_skills() -> Result<(), String> {
    let skills = |ids: &[&str]| json!({ "project": { "localSkills": ids } });
    run_all(vec![
        case("tl-none", json!({})),
        case("tl-missing-file", skills(&["ghost"])),
        case("tl-no-trigger", skills(&["a"]))
            .file(
                ".claude/skills/a/SKILL.md",
                local_skill("Automate browser interactions."),
            )
            .hits(&["triggerless"]),
        case("tl-english-trigger", skills(&["a"])).file(
            ".claude/skills/a/SKILL.md",
            local_skill("Use when reviewing a diff"),
        ),
        case("tl-spanish-triggers", skills(&["a", "b", "c", "d", "e"]))
            .file(
                ".claude/skills/a/SKILL.md",
                local_skill("Usar cuando toques el modelo"),
            )
            .file(
                ".claude/skills/b/SKILL.md",
                local_skill("Se aplica al revisar"),
            )
            .file(
                ".claude/skills/c/SKILL.md",
                local_skill("Antes de commitear"),
            )
            .file(
                ".claude/skills/d/SKILL.md",
                local_skill("Para cuando falle"),
            )
            .file(".claude/skills/e/SKILL.md", local_skill("Usa esto")),
        case("tl-trigger-boundaries", skills(&["a", "b", "c", "d", "e"]))
            .file(".claude/skills/a/SKILL.md", local_skill("refuse whenever"))
            .file(
                ".claude/skills/b/SKILL.md",
                local_skill("aplicaci\u{f3}n web"),
            )
            .file(".claude/skills/c/SKILL.md", local_skill("Us\u{e1} esto"))
            .file(
                ".claude/skills/d/SKILL.md",
                local_skill("USE\u{a0}THIS for Y"),
            )
            .file(".claude/skills/e/SKILL.md", local_skill("US\u{c1}R algo"))
            .hits(&["triggerless"]),
        case("tl-no-frontmatter", skills(&["a"]))
            .file(".claude/skills/a/SKILL.md", "just body, use when ignored\n")
            .hits(&["triggerless"]),
        case("tl-no-description", skills(&["a"]))
            .file(".claude/skills/a/SKILL.md", "---\nname: a\n---\nbody\n")
            .hits(&["triggerless"]),
        case("tl-quoted-description", skills(&["a", "b"]))
            .file(
                ".claude/skills/a/SKILL.md",
                "---\ndescription: \"Use when quoted\"\n---\n",
            )
            .file(
                ".claude/skills/b/SKILL.md",
                "---\ndescription: 'nothing here'\n---\n",
            )
            .hits(&["triggerless"]),
        case("tl-folded-description", skills(&["a"])).file(
            ".claude/skills/a/SKILL.md",
            "---\ndescription: >\n  Use when folded\n---\n",
        ),
        case("tl-managed-skill-skipped", skills(&["a"]))
            .file(".claude/skills/a/SKILL.md", skill("a", "no trigger")),
        case(
            "tl-duplicates-and-unsafe-ids",
            skills(&["a", "a", "../a", "a/b", " a", "", "a\\b", "a..b"]),
        )
        .file(".claude/skills/a/SKILL.md", local_skill("nothing"))
        .file(".claude/skills/a..b/SKILL.md", local_skill("nothing"))
        .hits(&["triggerless"]),
        case("tl-flat-file-not-resolved", skills(&["a"]))
            .file(".claude/skills/a.md", local_skill("nothing")),
        case("tl-sorted", skills(&["b", "A", "a-b", "a_b", "c10", "c2"]))
            .file(".claude/skills/b/SKILL.md", local_skill("x"))
            .file(".claude/skills/A/SKILL.md", local_skill("x"))
            .file(".claude/skills/a-b/SKILL.md", local_skill("x"))
            .file(".claude/skills/a_b/SKILL.md", local_skill("x"))
            .file(".claude/skills/c10/SKILL.md", local_skill("x"))
            .file(".claude/skills/c2/SKILL.md", local_skill("x"))
            .hits(&["triggerless"]),
        case("tl-non-utf8-file-delegates", skills(&["a"]))
            .raw(
                b".claude/skills/a/SKILL.md",
                b"---\ndescription: \xff\n---\n",
            )
            .delegates(&["triggerless", "emptySections", "artifacts"]),
        case("tl-non-ascii-id-delegates", skills(&["\u{f1}and\u{fa}"]))
            .file(".claude/skills/\u{f1}and\u{fa}/SKILL.md", local_skill("x"))
            .delegates(&["triggerless"]),
    ])
}

#[test]
fn interpolation_artifacts() -> Result<(), String> {
    let hard = "see <not configured: project.x> here";
    let soft = "(quality gate not configured — run 'navori configure quality-gate')";
    run_all(vec![
        case("ia-clean", json!({})).file("CLAUDE.md", "all good\n"),
        case("ia-hard", json!({}))
            .file("CLAUDE.md", format!("ok\n{hard} and <not configured: y>\n"))
            .hits(&["artifacts"]),
        case("ia-soft", json!({}))
            .file("CLAUDE.md", format!("a\nb\n{soft}\n"))
            .hits(&["artifacts"]),
        case("ia-both-and-repeats", json!({}))
            .file(
                "CLAUDE.md",
                format!("{hard}\n{hard}{hard}\n{soft} {soft}\n"),
            )
            .hits(&["artifacts"]),
        case("ia-crlf-lines", json!({}))
            .file("CLAUDE.md", format!("a\r\n{hard}\r\n"))
            .hits(&["artifacts"]),
        case("ia-near-misses", json!({})).file(
            "CLAUDE.md",
            "<not configured:> <not configured x> (quality gate not configured)\n",
        ),
        case(
            "ia-per-engine-files",
            json!({ "engines": ["claude", "codex"] }),
        )
        .file("CLAUDE.md", hard)
        .file("AGENTS.md", format!("x\n{hard}\n"))
        .file(".claude/agents/a.md", hard)
        .file(".agents/skills/s/SKILL.md", soft)
        .hits(&["artifacts"]),
        case(
            "ia-engine-without-files-is-not-scanned",
            json!({ "engines": ["claude"] }),
        )
        .file("AGENTS.md", hard)
        .file(".claude/progress/note.md", hard)
        .file(".claude/worktrees/w/CLAUDE.md", hard),
        case("ia-non-utf8-delegates", json!({}))
            .raw(b"CLAUDE.md", b"\xff <not configured: x>")
            .delegates(&["artifacts", "docBudget"]),
    ])
}

#[test]
fn model_profile_and_control_gaps() -> Result<(), String> {
    run_all(vec![
        case("mp-default", json!({})).hits(&["modelProfile"]),
        case(
            "mp-prose-engines-only",
            json!({ "engines": ["cursor", "copilot", "agents-md"] }),
        ),
        case("mp-codex", json!({ "engines": ["codex"] })).hits(&["modelProfile"]),
        case(
            "mp-partial",
            json!({
                "harness": { "reviewer": false, "scribeOwnsMarkdown": true },
                "models": { "implementer": "opus" },
                "effort": { "orchestrator": "high", "implementer": "low" },
            }),
        )
        .hits(&["modelProfile"]),
        case(
            "mp-all-set",
            json!({
                "harness": { "scribeOwnsMarkdown": true },
                "models": { "orchestrator": "opus", "implementer": "opus", "reviewer": "opus", "scout": "opus",
                            "auditor": "opus", "publisher": "opus", "scribe": "opus", "architect": "opus" },
                "effort": { "orchestrator": "high", "implementer": "high", "reviewer": "high", "scout": "high",
                            "auditor": "high", "publisher": "high", "scribe": "high", "architect": "high" },
            }),
        ),
        case(
            "mp-all-agents-off",
            json!({ "harness": {
            "orchestrator": false, "implementer": false, "reviewer": false, "scout": false,
            "auditor": false, "publisher": false } }),
        ),
        case("cg-claude", json!({})).hits(&["controlGaps"]),
        case(
            "cg-every-engine",
            json!({ "engines": ["claude", "codex", "cursor", "copilot", "agents-md"] }),
        )
        .hits(&["controlGaps"]),
        case(
            "cg-conditions-on",
            json!({
                "engines": ["claude", "codex", "cursor"],
                "harness": { "planTiers": true, "masterPlan": true, "scribeOwnsMarkdown": true },
                "project": { "localSkills": ["a"] },
            }),
        )
        .hits(&["controlGaps"]),
        case(
            "cg-conditions-off",
            json!({
                "harness": { "planTiers": false, "masterPlan": false },
                "project": { "localSkills": [] },
            }),
        )
        .hits(&["controlGaps"]),
        case("cg-pi", json!({ "engines": ["pi"] })).hits(&["controlGaps"]),
    ])
}

#[test]
fn progress_size() -> Result<(), String> {
    let at = |n: usize| "x".repeat(n);
    let cap = DEFAULT_PROGRESS_THRESHOLD_BYTES;
    run_all(vec![
        case("ps-absent", json!({})),
        case("ps-under", json!({})).file("progress/current.md", at(cap - 1)),
        case("ps-exact", json!({})).file("progress/current.md", at(cap)),
        case("ps-over", json!({}))
            .file("progress/current.md", at(cap + 1))
            .hits(&["progress"]),
        case("ps-multibyte-counts-bytes", json!({}))
            .file("progress/current.md", "\u{e9}".repeat(cap / 2 + 1))
            .hits(&["progress"]),
        case("ps-is-a-directory", json!({})).dir("progress/current.md"),
    ])
}

#[test]
fn nested_worktrees() -> Result<(), String> {
    run_all(vec![
        case("nw-absent", json!({})),
        case("nw-worktree-without-node-modules", json!({}))
            .dir(".claude/worktrees/a")
            .file(".eslintrc.json", "{}"),
        case("nw-installed-no-eslint", json!({})).dir(".claude/worktrees/a/node_modules"),
        case("nw-installed-with-eslint-config", json!({}))
            .dir(".claude/worktrees/b/node_modules")
            .dir(".claude/worktrees/a/node_modules")
            .file("eslint.config.mjs", "")
            .hits(&["nestedWorktrees"]),
        case("nw-eslint-name-variants", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file(".eslintrc.yaml", "")
            .file(".eslintrc", "")
            .file("eslint.config.ts", "")
            .file("eslint.config.txt", "")
            .hits(&["nestedWorktrees"]),
        case("nw-not-an-eslint-name", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file(".eslintrc.toml", "")
            .file("eslint.config.mjs.bak", ""),
        case("nw-package-json-key", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file("package.json", r#"{"eslintConfig":{}}"#)
            .hits(&["nestedWorktrees"]),
        case("nw-package-json-without-key", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file("package.json", r#"{"name":"x"}"#),
        case("nw-package-json-blank", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file("package.json", "")
            .delegates(&["prettier"]),
        case("nw-package-json-array", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file("package.json", "[1]"),
        case("nw-worktree-is-a-file", json!({}))
            .file(".claude/worktrees/a", "x")
            .file(".eslintrc.json", "{}"),
        case("nw-sorted-bytewise", json!({}))
            .dir(".claude/worktrees/b/node_modules")
            .dir(".claude/worktrees/B/node_modules")
            .dir(".claude/worktrees/a_/node_modules")
            .file(".eslintrc.json", "{}")
            .hits(&["nestedWorktrees"]),
        case("nw-non-utf8-delegates", json!({}))
            .raw(b".claude/worktrees/\xff/node_modules/x", b"")
            .file(".eslintrc.json", "{}")
            .delegates(&["nestedWorktrees"]),
        case("nw-package-json-invalid-delegates", json!({}))
            .dir(".claude/worktrees/a/node_modules")
            .file("package.json", "{ nope")
            .delegates(&["nestedWorktrees", "prettier"]),
    ])
}

#[test]
fn stale_harness_and_workspace_full() -> Result<(), String> {
    let stamped =
        |v: &str| format!("<!-- navori:managed id=\"x\" hash=\"h\" version=\"{v}\" -->\nbody\n");
    let workspaces = |harness: &str| {
        json!({ "monorepo": { "enabled": true, "workspaceHarness": harness,
                              "workspaces": [{ "name": "a", "path": "apps/a" }] } })
    };
    run_all(vec![
        case("st-none", json!({})),
        case("st-nested-claude", json!({}))
            .file("apps/a/.claude/agents/x.md", stamped("0.9.10"))
            .file("apps/a/.claude/agents/y.md", stamped("0.10.2"))
            .file("apps/a/.claude/notes.txt", "no stamp")
            .hits(&["stale"]),
        case("st-no-stamp", json!({}))
            .file("apps/a/.claude/notes.txt", "hello")
            .hits(&["stale"]),
        case("st-root-claude-is-not-nested", json!({}))
            .file(".claude/agents/x.md", stamped("0.9.0")),
        case("st-empty-dir-skipped", json!({})).dir("apps/a/.claude/agents"),
        case("st-skip-dirs", json!({}))
            .file("node_modules/p/.claude/a.md", "x")
            .file("vendor/.claude/a.md", "x")
            .file("dist/.claude/a.md", "x")
            .file(".git/.claude/a.md", "x"),
        case("st-depth-limits", json!({}))
            .file("a/b/c/.claude/x.md", "x")
            .file("a/b/c/d/.claude/x.md", "x")
            .hits(&["stale"]),
        case("st-ephemeral-inside-claude-ignored", json!({}))
            .file("apps/a/.claude/progress/x.md", stamped("0.1.0"))
            .file("apps/a/.claude/worktrees/w/x.md", "x")
            .file("apps/a/.claude/settings.local.json", "{}"),
        case("st-nested-depth", json!({}))
            .file("apps/a/.claude/d1/d2/d3/d4/d5/d6/x.md", stamped("1.0.0"))
            .file("apps/a/.claude/d1/x.md", stamped("1.0.1"))
            .hits(&["stale"]),
        case("st-stamp-ordering", json!({}))
            .file("apps/a/.claude/1.md", stamped("1.10.0"))
            .file("apps/a/.claude/2.md", stamped("1.9.0"))
            .file("apps/a/.claude/3.md", stamped("1.9.0"))
            .hits(&["stale"]),
        case("st-sorted", json!({}))
            .file("b/.claude/x.md", "x")
            .file("A/.claude/x.md", "x")
            .file("a-b/.claude/x.md", "x")
            .file("a_b/.claude/x.md", "x")
            .hits(&["stale"]),
        case(
            "st-monorepo-disabled",
            json!({ "monorepo": { "enabled": false } }),
        )
        .file("apps/a/.claude/x.md", "x"),
        case(
            "st-monorepo-enabled-no-workspaces",
            json!({ "monorepo": { "enabled": true } }),
        )
        .file("apps/a/.claude/x.md", "x")
        .hits(&["stale"]),
        case(
            "st-monorepo-with-workspaces-delegates",
            workspaces("minimal"),
        )
        .file("apps/a/.claude/x.md", "x")
        .delegates(&["stale"]),
        case("st-non-utf8-delegates", json!({}))
            .raw(b"\xff/.claude/x.md", b"x")
            .delegates(&["stale"]),
        case("st-non-ascii-path-delegates", json!({}))
            .file("\u{f1}/.claude/x.md", "x")
            .file("z/.claude/x.md", "x")
            .delegates(&["stale"]),
        case("wf-no-monorepo", json!({})),
        case(
            "wf-full-without-workspaces",
            json!({ "monorepo": { "enabled": true, "workspaceHarness": "full" } }),
        ),
        case("wf-minimal-with-workspaces", workspaces("minimal")).delegates(&["stale"]),
        case(
            "wf-disabled",
            json!({ "monorepo": { "enabled": false, "workspaceHarness": "full",
                                       "workspaces": [{ "name": "a", "path": "apps/a" }] } }),
        ),
        case("wf-full-with-workspaces-delegates", workspaces("full"))
            .delegates(&["stale", "workspaceFull"]),
    ])
}

#[test]
fn flat_skills() -> Result<(), String> {
    run_all(vec![
        case("fs-none", json!({})),
        case("fs-flat-files", json!({}))
            .file(".claude/skills/a.md", "x")
            .file(".claude/skills/README.md", "x")
            .file(".claude/skills/b/SKILL.md", "x")
            .file(".claude/skills/notes.txt", "x")
            .dir(".claude/skills/dir.md")
            .hits(&["flatSkills"]),
        case("fs-home-and-repo-sorted", json!({}))
            .file(".claude/skills/b.md", "x")
            .home(".claude/skills/a.md", "x")
            .home(".claude/skills/README.md", "x")
            .file(".claude/skills/A.md", "x")
            .hits(&["flatSkills"]),
        case("fs-home-only", json!({}))
            .home(".claude/skills/h.md", "x")
            .hits(&["flatSkills"]),
        case("fs-sort-punctuation", json!({}))
            .file(".claude/skills/a-b.md", "x")
            .file(".claude/skills/a_b.md", "x")
            .file(".claude/skills/a b.md", "x")
            .file(".claude/skills/a2.md", "x")
            .file(".claude/skills/a10.md", "x")
            .hits(&["flatSkills"]),
        case("fs-non-utf8-delegates", json!({}))
            .raw(b".claude/skills/\xff.md", b"x")
            .delegates(&["flatSkills", "emptySections", "artifacts"]),
        case("fs-non-ascii-name-delegates", json!({}))
            .file(".claude/skills/\u{f1}.md", "x")
            .file(".claude/skills/z.md", "x")
            .delegates(&["flatSkills"]),
    ])
}

#[test]
fn foreign_skill_indexes() -> Result<(), String> {
    let registry = ".atl/skill-registry.md";
    run_all(vec![
        case("fi-absent", json!({})),
        case("fi-all-paths-gone", json!({}))
            .file(
                registry,
                "Last updated: 2026-01-05\n| `/nowhere/a/SKILL.md` | `/nowhere/b/SKILL.md` |\n",
            )
            .hits(&["foreignIndexes"]),
        case("fi-date-on-next-line", json!({}))
            .file(
                registry,
                "Last updated:\n  2026-01-05\n`/nowhere/a/SKILL.md`\n",
            )
            .hits(&["foreignIndexes"]),
        case("fi-no-date", json!({}))
            .file(registry, "`/nowhere/a/SKILL.md` `/nowhere/a/SKILL.md`\n")
            .hits(&["foreignIndexes"]),
        case("fi-no-paths", json!({})).file(registry, "Last updated: 2026-01-05\nnothing\n"),
        case("fi-relative-and-multiline-ignored", json!({}))
            .file(registry, "`rel/SKILL.md` `/a\nb/SKILL.md`\n"),
        case("fi-one-path-alive", json!({}))
            .file(
                registry,
                "`/nowhere/SKILL.md` `/tmp/.nonexistent-navori-x/../SKILL.md`\n",
            )
            .hits(&["foreignIndexes"]),
        case("fi-non-utf8-delegates", json!({}))
            .raw(registry.as_bytes(), b"\xff `/nowhere/SKILL.md`")
            .delegates(&["foreignIndexes"]),
    ])
}

#[test]
fn doc_budget() -> Result<(), String> {
    let managed = |id: &str, extra: &str, body: &str| {
        format!(
            "<!-- navori:managed id=\"{id}\"{extra} -->\n{body}\n<!-- /navori:managed id=\"{id}\" -->\n"
        )
    };
    let ids = navori_core::render::doc_budget::CEILINGS;
    let computed = navori_core::render::doc_budget::COMPUTED;
    let static_id = ids.first().map_or("tipado-fuerte", |(id, _)| *id);
    let computed_id = computed.first().map_or("x", |(id, _, _)| *id);
    let rows = "- a\n- b\n  - nested\n-c\n- d\n";
    run_all(vec![
        case("db-nothing", json!({})),
        case("db-claude-md-only-own", json!({})).file("CLAUDE.md", "own words here\n").hits(&["docBudget"]),
        case("db-blocks-and-levers", json!({ "engines": ["claude", "codex"] }))
            .file(
                "CLAUDE.md",
                format!(
                    "own prose\n{}{}{}{}{}",
                    managed(static_id, "", "a b c"),
                    managed("engram-x", " source=\"@navori/plugin-engram\"", "c d"),
                    managed("contexto-proyecto", "", "ctx"),
                    managed("stack-nextjs", "", "preset"),
                    managed(computed_id, "", rows),
                ),
            )
            .hits(&["docBudget"]),
        case("db-over-ceiling", json!({}))
            .file("CLAUDE.md", managed(static_id, "", &"w ".repeat(5000)))
            .hits(&["docBudget"]),
        case("db-nested-and-repeated-blocks", json!({}))
            .file(
                "CLAUDE.md",
                format!(
                    "<!-- navori:managed id=\"outer\" -->\n{}<!-- /navori:managed id=\"outer\" -->\n{}{}",
                    managed("inner", "", "x y"),
                    managed("dup", " source=\"@navori/plugin-a\"", "a"),
                    managed("dup", " source=\"@navori/plugin-b\"", "a b"),
                ),
            )
            .hits(&["docBudget"]),
        case("db-whitespace-words", json!({}))
            .file("CLAUDE.md", "a\u{a0}b\u{2003}c\u{feff}d \t\n e\n")
            .hits(&["docBudget"]),
        case("db-prose-surfaces", json!({ "engines": ["codex", "cursor", "copilot"] }))
            .file("AGENTS.md", managed("navori-agents", "", "uno dos \u{e9}"))
            .file(".cursor/rules/navori.mdc", "cursor rules \u{e9}\n")
            .file(".github/copilot-instructions.md", "copilot words\n")
            .hits(&["docBudget"]),
        case("db-agents-only-without-claude-engine", json!({ "engines": ["codex"] }))
            .file("AGENTS.md", "plain\n")
            .hits(&["docBudget"]),
        case("db-context-inline-and-pointer", json!({}))
            .file(".claude/context/b.md", "y".repeat(7995))
            .file(".claude/context/a.md", "short")
            .file(".claude/context/c.md", "tail")
            .file(".claude/context/notes.txt", "ignored")
            .hits(&["docBudget"]),
        case("db-context-utf16-chars", json!({}))
            .file(".claude/context/a.md", "\u{1f600} \u{e9} x")
            .hits(&["docBudget"]),
        case("db-context-sorted-bytewise", json!({}))
            .file(".claude/context/B.md", "x")
            .file(".claude/context/a.md", "x")
            .file(".claude/context/10-x.md", "x")
            .file(".claude/context/2-x.md", "x")
            .hits(&["docBudget"]),
        case("db-context-dir-named-md", json!({}))
            .dir(".claude/context/dir.md")
            .file("CLAUDE.md", "x"),
        case("db-mcp-servers", json!({}))
            .file("CLAUDE.md", "x")
            .file(
                ".mcp.json",
                r#"{"mcpServers":{"engram":{},"cg":{"alwaysLoad":true},"off":{"alwaysLoad":"true"},"bad":1,"arr":[]}}"#,
            )
            .hits(&["docBudget"]),
        case("db-mcp-not-an-object", json!({}))
            .file("CLAUDE.md", "x")
            .file(".mcp.json", "[1]"),
        case("db-mcp-no-servers", json!({}))
            .file("CLAUDE.md", "x")
            .file(".mcp.json", r#"{"mcpServers":3}"#),
        case("db-mcp-blank", json!({})).file("CLAUDE.md", "x").file(".mcp.json", ""),
        case("db-mcp-invalid-delegates", json!({}))
            .file("CLAUDE.md", "x")
            .file(".mcp.json", "{ nope")
            .delegates(&["docBudget"]),
        case("db-prototype-key-id-delegates", json!({}))
            .file("CLAUDE.md", managed("constructor", "", "x"))
            .delegates(&["docBudget"]),
        case("db-non-utf8-delegates", json!({}))
            .raw(b"CLAUDE.md", b"\xff x")
            .delegates(&["docBudget", "artifacts"]),
    ])
}

#[test]
fn ignore_files() -> Result<(), String> {
    let cfg = |mode: &str| json!({ "gitignoreHarness": mode });
    let mut cases = vec![
        case("gi-off", json!({})).file(".gitignore", "node_modules\n"),
        case("gi-on-no-file", cfg("local")).hits(&["gitignore"]),
        case("gi-on-no-block", cfg("local")).file(".gitignore", "node_modules\n").hits(&["gitignore"]),
        case("gi-full-no-block", cfg("full")).hits(&["gitignore"]),
        case("gi-drifted", cfg("local"))
            .file(
                ".gitignore",
                "# navori:managed start id=\"gitignore-harness\"\nsomething\n# navori:managed end id=\"gitignore-harness\"\n",
            )
            .hits(&["gitignore"]),
        case("gi-codex-engine", json!({ "gitignoreHarness": "local", "engines": ["claude", "codex"] }))
            .file(".gitignore", "x\n"),
        case("gi-non-utf8-delegates", cfg("local"))
            .raw(b".gitignore", b"\xff")
            .delegates(&["gitignore"]),
        case("gi-is-a-directory-delegates", cfg("local"))
            .dir(".gitignore")
            .delegates(&["gitignore"]),
        // `scanPrettierIgnore`
        case("pi-no-prettier", json!({})),
        case("pi-rc-no-ignore-file", json!({})).file(".prettierrc", "{}").hits(&["prettier"]),
        case("pi-dev-dependency", json!({}))
            .file("package.json", r#"{"devDependencies":{"prettier":"3"}}"#)
            .hits(&["prettier"]),
        case("pi-script-mention", json!({}))
            .file("package.json", r#"{"scripts":{"fmt":"pnpm exec prettier --write ."}}"#)
            .hits(&["prettier"]),
        case("pi-script-plugin-only", json!({}))
            .file("package.json", r#"{"scripts":{"fmt":"prettier-plugin-foo --check"}}"#),
        case("pi-covered-by-user-rules", json!({}))
            .file(".prettierrc", "{}")
            .file(".prettierignore", ".claude/\nCLAUDE.md\n"),
        case("pi-drifted-block", json!({}))
            .file(".prettierrc", "{}")
            .file(
                ".prettierignore",
                "# navori:managed start id=\"prettierignore-harness\"\nold\n# navori:managed end id=\"prettierignore-harness\"\n",
            )
            .hits(&["prettier"]),
        case("pi-codex-engine", json!({ "engines": ["claude", "codex", "cursor"] }))
            .file(".prettierrc", "{}")
            .file(".prettierignore", "x\n")
            .hits(&["prettier"]),
        case("pi-prose-engine-only", json!({ "engines": ["agents-md"] }))
            .file(".prettierrc", "{}")
            .hits(&["prettier"]),
        case("pi-package-json-invalid-delegates", json!({}))
            .file("package.json", "{ nope")
            .delegates(&["prettier"]),
    ];
    // A healthy block, written from the Rust body; the TS must agree it is healthy.
    let body = {
        let probe = case("probe", cfg("local"));
        let layout = probe.write()?;
        let bytes =
            std::fs::read(layout.root.join("navori.config.json")).map_err(|e| e.to_string())?;
        let parsed = config::read(&bytes).map_err(|e| format!("{e:?}"))?;
        let _ = std::fs::remove_dir_all(&layout.base);
        gitignore_body(&parsed.data).ok_or("no gitignore body")?
    };
    cases.push(case("gi-healthy", cfg("local")).file(
        ".gitignore",
        format!(
            "# navori:managed start id=\"gitignore-harness\"\n{body}\n# navori:managed end id=\"gitignore-harness\"\n"
        ),
    ));
    run_all(cases)
}

#[test]
fn git_hygiene() -> Result<(), String> {
    let nested = |inner: &str| {
        format!(
            "# navori:managed start id=\"nested-gitignore-harness\"\n{inner}\n# navori:managed end id=\"nested-gitignore-harness\"\n"
        )
    };
    run_all(vec![
        case("gh-not-a-repo", json!({})).file(".claude/worktrees/x/a", "x"),
        case("gh-clean-repo", json!({})).git(&[]),
        case("gh-specs-ignored", json!({}))
            .file(".gitignore", "specs/\n")
            .git(&[])
            .hits(&["gitHygiene"]),
        case(
            "gh-specs-ignored-sdd-off",
            json!({ "sdd": { "enabled": false } }),
        )
        .file(".gitignore", "specs/\n")
        .git(&[]),
        case(
            "gh-specs-ignored-block-excluded",
            json!({ "blocks": { "exclude": ["sdd"] } }),
        )
        .file(".gitignore", "specs/\n")
        .git(&[]),
        case(
            "gh-custom-specs-dir",
            json!({ "sdd": { "specsDir": "docs/specs/" } }),
        )
        .file(".gitignore", "docs/specs/\n")
        .git(&[])
        .hits(&["gitHygiene"]),
        case("gh-ephemeral-not-ignored", json!({}))
            .file(".claude/settings.local.json", "{}")
            .file(".claude/worktrees/w/a", "x")
            .file(".navori/state/s.json", "{}")
            .file(".claude/.managed-drift-stamp", "1")
            .git(&[])
            .hits(&["gitHygiene"]),
        case("gh-ephemeral-ignored", json!({}))
            .file(
                ".gitignore",
                ".claude/settings.local.json\n.claude/worktrees/\n.navori/state/\n",
            )
            .file(".claude/settings.local.json", "{}")
            .file(".claude/worktrees/w/a", "x")
            .file(".navori/state/s.json", "{}")
            .git(&[]),
        case("gh-ephemeral-tracked", json!({}))
            .file(".gitignore", ".claude/progress/\n.codex/progress/\n")
            .file(".claude/progress/p.md", "x")
            .file(".claude/settings.local.json", "{}")
            .git(&[".claude/progress/p.md", ".claude/settings.local.json"])
            .hits(&["gitHygiene"]),
        case("gh-presets-ignored", json!({}))
            .file(".gitignore", ".navori/\n")
            .git(&[])
            .hits(&["gitHygiene"]),
        case("gh-presets-ignored-by-broad-rule", json!({}))
            .file(".gitignore", "presets/\n")
            .git(&[]),
        case("gh-nested-state-protected", json!({}))
            .file(".navori/.gitignore", nested("state/\nother/"))
            .git(&[]),
        case("gh-nested-state-unprotected", json!({}))
            .file(".navori/.gitignore", nested("other/"))
            .git(&[])
            .hits(&["gitHygiene"]),
        case("gh-nested-no-block", json!({}))
            .file(".navori/.gitignore", "# nothing\n")
            .git(&[]),
        case("gh-nested-state-partial-line", json!({}))
            .file(".navori/.gitignore", nested("state/x\n state/"))
            .git(&[])
            .hits(&["gitHygiene"]),
        case("gh-nested-gitignore-non-utf8-delegates", json!({}))
            .raw(b".navori/.gitignore", b"\xff")
            .git(&[])
            .delegates(&["gitHygiene"]),
    ])
}
