//! `navori_core::diagnose::native_hooks` against the TS `detectNativeHooks`, `listWorktreePaths`
//! (`lib/diagnose/native-hooks.ts`) and `scanNativeHooks` (`commands/doctor.ts`), spec 0060 T23
//! slice 5e5b.
//!
//! Every case is a small repo written to a temp dir. Both sides read the same directory with git's
//! system and global config switched off; replies are compared as the TS JSON shape. No bundled
//! plugin registers a hook, so the `plugins.<p>.nativeHook` findings are out of reach here (the
//! TS unit tests cover them with a fake plugin).

mod support;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config;
use navori_core::diagnose::native_hooks::{
    FindingCode, FindingLevel, NativeHookState, NativeHooksDetection, NativeHooksReport,
    detect_native_hooks, list_worktree_paths, scan_native_hooks,
};
use navori_core::process::RealRunner;
use navori_core::render::plugins::load_enabled_plugins;
use serde_json::{Map, Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const path = await import('node:path');\nconst c = await import({:?});\n\
         const d = await import({:?});\nconst nh = await import({:?});\n\
         delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE;\n\
         process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = '/dev/null';",
        cli_module("lib/config/config.ts"),
        cli_module("commands/doctor.ts"),
        cli_module("lib/diagnose/native-hooks.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const cfg = c.readConfig(path.join(request.dir, 'navori.config.json'));\n\
     return {\n\
       detection: nh.detectNativeHooks(request.dir),\n\
       worktrees: nh.listWorktreePaths(request.dir),\n\
       report: d.scanNativeHooks(request.dir, cfg),\n\
     };",
);

static NEXT: AtomicUsize = AtomicUsize::new(0);

const CONFIG_UNDECLARED: &str = r#"{"name":"nh","engines":["claude"],"preset":"custom"}"#;
const CONFIG_DECLARED: &str = r#"{"name":"nh","engines":["claude"],"preset":"custom","qualityGate":{"fast":"echo ok","full":"echo ok","nativeHooks":true}}"#;

const PLAIN: &str = "#!/bin/sh\nbun run check\n";

/// One step that shapes the repo before both sides read it.
enum Step {
    /// `git <args>` in the repo root.
    Git(&'static [&'static str]),
    /// A file under the repo root with its mode.
    Write(&'static str, &'static str, u32),
}

struct Case {
    name: &'static str,
    config: &'static str,
    /// `git init` the root first.
    git: bool,
    steps: Vec<Step>,
    /// `level:code` findings the TS report must carry (guards against a vacuous comparison).
    hits: &'static [&'static str],
}

impl Case {
    fn new(name: &'static str, config: &'static str, steps: Vec<Step>) -> Self {
        Self {
            name,
            config,
            git: true,
            steps,
            hits: &[],
        }
    }

    const fn hits(mut self, hits: &'static [&'static str]) -> Self {
        self.hits = hits;
        self
    }
}

fn env() -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(k, _)| k != "GIT_DIR" && k != "GIT_WORK_TREE")
        .collect();
    env.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
    env.push(("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()));
    env
}

fn git(root: &Path, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "a")
        .env("GIT_AUTHOR_EMAIL", "a@b")
        .env("GIT_COMMITTER_NAME", "a")
        .env("GIT_COMMITTER_EMAIL", "a@b")
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

/// Write `body` at `rel` through `/bin/cp` from a staged file, so this process never holds the
/// destination open for writing. Tests run on parallel threads that fork: a write descriptor open
/// here at that moment lives on in the forked child until its exec, and running an executable in
/// that window fails with ETXTBSY ("Text file busy"). `/bin/cp` writes it in its own process.
fn write(root: &Path, rel: &str, body: &str, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut staged = path.as_os_str().to_owned();
    staged.push(".staged");
    let staged = PathBuf::from(staged);
    std::fs::write(&staged, body).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("/bin/cp")
        .arg(&staged)
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    std::fs::remove_file(&staged).map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("cp exited with {status}"));
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn layout(case: &Case) -> Result<PathBuf, String> {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "navori-native-hooks-{}-{n}-{}",
        std::process::id(),
        case.name
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    // Canonical, as `git rev-parse --show-toplevel` answers.
    let root = base.canonicalize().map_err(|e| e.to_string())?;
    write(&root, "navori.config.json", case.config, 0o644)?;
    if case.git {
        git(&root, &["init", "-q", "-b", "main"])?;
    }
    for step in &case.steps {
        match step {
            Step::Git(args) => git(&root, args)?,
            Step::Write(rel, body, mode) => write(&root, rel, body, *mode)?,
        }
    }
    Ok(root)
}

fn state_json(s: &NativeHookState) -> Value {
    json!({
        "event": s.event.as_str(),
        "active": s.active,
        "manager": s.manager.map(|m| m.as_str()),
        "path": s.path,
        "absence": s.absence.map(|a| a.as_str()),
    })
}

fn detection_json(d: &NativeHooksDetection) -> Value {
    json!({
        "top": d.top,
        "hooksDir": d.hooks_dir,
        "gitVersion": d.git_version,
        "hooks": {
            "pre-commit": state_json(&d.pre_commit),
            "pre-push": state_json(&d.pre_push),
        },
    })
}

fn report_json(r: &NativeHooksReport) -> Value {
    let findings: Vec<Value> = r
        .findings
        .iter()
        .map(|f| {
            let level = match f.level {
                FindingLevel::Info => "info",
                FindingLevel::Warning => "warning",
                FindingLevel::Error => "error",
            };
            let mut out = Map::new();
            out.insert("level".into(), json!(level));
            let (code, fields) = match &f.code {
                FindingCode::Found(state) => (
                    "found",
                    json!({ "event": state.event.as_str(), "state": state_json(state) }),
                ),
                FindingCode::GateDeclaredMissing { state, git_version } => (
                    "gate-declared-missing",
                    json!({ "event": "pre-commit", "state": state_json(state), "gitVersion": git_version }),
                ),
                FindingCode::PluginDeclaredMissing {
                    plugin,
                    git_version,
                } => (
                    "plugin-declared-missing",
                    json!({ "plugin": plugin, "gitVersion": git_version }),
                ),
                FindingCode::PluginOnlyGuarantee(plugin) => {
                    ("plugin-only-guarantee", json!({ "plugin": plugin }))
                }
                FindingCode::Duplicate(state) => (
                    "duplicate",
                    json!({ "event": "pre-commit", "state": state_json(state) }),
                ),
                FindingCode::WorktreeMissing(path) => (
                    "worktree-missing",
                    json!({ "event": "pre-commit", "path": path }),
                ),
            };
            out.insert("code".into(), json!(code));
            if let Value::Object(fields) = fields {
                out.extend(fields);
            }
            Value::Object(out)
        })
        .collect();
    json!({
        "detection": detection_json(&r.detection),
        "findings": findings,
        "errors": r.errors,
    })
}

fn check(case: &Case) -> Result<(), String> {
    let root = layout(case)?;
    let dir = root.to_str().ok_or("non-UTF-8 temp dir")?;
    let ts = NODE.ask(&json!({ "dir": dir }))?;
    let ts_codes: Vec<String> = ts["report"]["findings"]
        .as_array()
        .map(|findings| {
            findings
                .iter()
                .map(|f| {
                    format!(
                        "{}:{}",
                        f["level"].as_str().unwrap_or(""),
                        f["code"].as_str().unwrap_or("")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(missing) = case
        .hits
        .iter()
        .find(|hit| !ts_codes.iter().any(|c| c == *hit))
    {
        return Err(format!(
            "[{}] expected {missing}, ts found {ts_codes:?}",
            case.name
        ));
    }
    let env = env();
    let bytes = std::fs::read(root.join("navori.config.json")).map_err(|e| e.to_string())?;
    let cfg = config::read(&bytes).map_err(|e| format!("rust rejects the config: {e:?}"))?;
    let plugins = load_enabled_plugins(None).map_err(|e| format!("{e:?}"))?;
    let unmodeled = |what: &str| format!("[{}] rust delegates {what}", case.name);
    let detection = detect_native_hooks(dir, &root, &RealRunner, &env)
        .map_err(|_| unmodeled("detectNativeHooks"))?;
    let worktrees = list_worktree_paths(dir, &root, &RealRunner, &env)
        .map_err(|_| unmodeled("listWorktreePaths"))?;
    let report = scan_native_hooks(dir, &cfg, &plugins, &RealRunner, &env)
        .map_err(|_| unmodeled("scanNativeHooks"))?;
    let rust = json!({
        "detection": detection_json(&detection),
        "worktrees": worktrees,
        "report": report.as_ref().map(report_json),
    });
    let result = if ts == rust {
        Ok(())
    } else {
        Err(format!("[{}] {}", case.name, first_difference(&ts, &rust)))
    };
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(&root);
    }
    result
}

fn run_all(cases: &[Case]) -> Result<(), String> {
    let errors: Vec<String> = cases.iter().filter_map(|c| check(c).err()).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n\n"))
    }
}

// Covers: R73
#[test]
fn outside_git() -> Result<(), String> {
    run_all(&[
        Case {
            name: "outside-undeclared",
            config: CONFIG_UNDECLARED,
            git: false,
            steps: vec![],
            hits: &[],
        },
        Case {
            name: "outside-declared",
            config: CONFIG_DECLARED,
            git: false,
            steps: vec![],
            hits: &["error:gate-declared-missing"],
        },
    ])
}

// Covers: R73
#[test]
fn plain_hooks_and_their_absences() -> Result<(), String> {
    run_all(&[
        Case::new("missing-undeclared", CONFIG_UNDECLARED, vec![]),
        Case::new("missing-declared", CONFIG_DECLARED, vec![])
            .hits(&["error:gate-declared-missing"]),
        Case::new(
            "plain-active-undeclared",
            CONFIG_UNDECLARED,
            vec![Step::Write(".git/hooks/pre-commit", PLAIN, 0o755)],
        )
        .hits(&["warning:duplicate"]),
        Case::new(
            "plain-active-declared",
            CONFIG_DECLARED,
            vec![
                Step::Write(".git/hooks/pre-commit", PLAIN, 0o755),
                Step::Write(".git/hooks/pre-push", PLAIN, 0o755),
            ],
        ),
        Case::new(
            "not-executable",
            CONFIG_DECLARED,
            vec![Step::Write(".git/hooks/pre-commit", PLAIN, 0o644)],
        ),
        Case::new(
            "empty",
            CONFIG_DECLARED,
            vec![Step::Write(".git/hooks/pre-commit", "", 0o755)],
        ),
        Case::new(
            "no-user-content",
            CONFIG_DECLARED,
            vec![Step::Write(
                ".git/hooks/pre-commit",
                "#!/bin/sh\n\n  # nothing\n",
                0o755,
            )],
        ),
    ])
}

// Covers: R73
#[test]
fn managers() -> Result<(), String> {
    let husky_stub = "#!/usr/bin/env sh\n. \"$(dirname \"$0\")/h\"\n";
    let pre_commit_fw = "#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nexec pre-commit\n";
    let lefthook = "#!/bin/sh\nlefthook run \"pre-commit\" \"$@\"\n";
    run_all(&[
        Case::new(
            "husky-stub-without-user-script",
            CONFIG_DECLARED,
            vec![
                Step::Git(&["config", "core.hooksPath", ".husky/_"]),
                Step::Write(".husky/_/h", "#!/usr/bin/env sh\nexit 0\n", 0o755),
                Step::Write(".husky/_/pre-commit", husky_stub, 0o755),
            ],
        ),
        Case::new(
            "husky-active",
            CONFIG_DECLARED,
            vec![
                Step::Git(&["config", "core.hooksPath", ".husky/_"]),
                Step::Write(".husky/_/h", "#!/usr/bin/env sh\nexit 0\n", 0o755),
                Step::Write(".husky/_/pre-commit", husky_stub, 0o755),
                Step::Write(".husky/pre-commit", "bun run check\n", 0o644),
            ],
        ),
        Case::new(
            "lefthook-without-config",
            CONFIG_DECLARED,
            vec![Step::Write(".git/hooks/pre-commit", lefthook, 0o755)],
        ),
        Case::new(
            "lefthook-yaml",
            CONFIG_DECLARED,
            vec![
                Step::Write(".git/hooks/pre-commit", lefthook, 0o755),
                Step::Write(".git/hooks/pre-push", lefthook, 0o755),
                Step::Write(
                    "lefthook.yml",
                    "pre-commit:\n  commands:\n    x:\n      run: true\n",
                    0o644,
                ),
            ],
        ),
        Case::new(
            "lefthook-json-and-toml",
            CONFIG_UNDECLARED,
            vec![
                Step::Write(".git/hooks/pre-commit", lefthook, 0o755),
                Step::Write(".git/hooks/pre-push", lefthook, 0o755),
                Step::Write(".lefthook.json", "{\"pre-push\": {}}\n", 0o644),
                Step::Write(
                    "lefthook-local.toml",
                    "[pre-commit.commands.x]\nrun = \"true\"\n",
                    0o644,
                ),
            ],
        ),
        Case::new(
            "pre-commit-framework-without-config",
            CONFIG_DECLARED,
            vec![Step::Write(".git/hooks/pre-commit", pre_commit_fw, 0o755)],
        ),
        Case::new(
            "pre-commit-framework-push-stage-missing",
            CONFIG_DECLARED,
            vec![
                Step::Write(".git/hooks/pre-commit", pre_commit_fw, 0o755),
                Step::Write(".git/hooks/pre-push", pre_commit_fw, 0o755),
                Step::Write(".pre-commit-config.yaml", "repos: []\n", 0o644),
            ],
        ),
        Case::new(
            "pre-commit-framework-active",
            CONFIG_DECLARED,
            vec![
                Step::Write(".git/hooks/pre-commit", pre_commit_fw, 0o755),
                Step::Write(".git/hooks/pre-push", pre_commit_fw, 0o755),
                Step::Write(
                    ".pre-commit-config.yaml",
                    "default_install_hook_types: [pre-commit, pre-push]\nrepos: []\n",
                    0o644,
                ),
            ],
        ),
    ])
}

// Covers: R73
#[test]
fn worktrees() -> Result<(), String> {
    let commit: &'static [&'static str] = &["commit", "-q", "--no-gpg-sign", "-m", "init"];
    run_all(&[
        Case::new(
            "worktree-missing-declared",
            CONFIG_DECLARED,
            vec![
                Step::Git(&["add", "-A"]),
                Step::Git(commit),
                Step::Git(&["config", "core.hooksPath", ".githooks"]),
                Step::Write(".githooks/pre-commit", PLAIN, 0o755),
                Step::Git(&["worktree", "add", "-q", "-b", "w1", ".claude/worktrees/w1"]),
                Step::Git(&["worktree", "add", "-q", "-b", "w2", "elsewhere/w2"]),
            ],
        )
        .hits(&["warning:worktree-missing"]),
        Case::new(
            "worktree-with-hook",
            CONFIG_DECLARED,
            vec![
                Step::Write(".githooks/pre-commit", PLAIN, 0o755),
                Step::Git(&["add", "-A"]),
                Step::Git(commit),
                Step::Git(&["config", "core.hooksPath", ".githooks"]),
                Step::Git(&["worktree", "add", "-q", "-b", "w1", ".claude/worktrees/w1"]),
            ],
        ),
        Case::new(
            "worktree-undeclared",
            CONFIG_UNDECLARED,
            vec![
                Step::Git(&["add", "-A"]),
                Step::Git(commit),
                Step::Git(&["worktree", "add", "-q", "-b", "w1", ".claude/worktrees/w1"]),
            ],
        ),
    ])
}
