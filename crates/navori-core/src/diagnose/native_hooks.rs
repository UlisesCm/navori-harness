//! Port of `lib/diagnose/native-hooks.ts` (`detectNativeHooks`, `listWorktreePaths`) and of
//! `scanNativeHooks` (`commands/doctor.ts`, spec 0045 D3, spec 0060 T23, R73): the native git
//! hooks against the config's declarations. Read-only: it inspects files and asks git where the
//! hooks live (through a [`ProcessRunner`], D42), and never runs a hook.
//!
//! A git answer that is not UTF-8 is [`Unmodeled`]: the caller delegates.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::config::Config;
use crate::diagnose::health::Unmodeled;
use crate::js_json::JsValue;
use crate::posix::{self, js_trim};
use crate::process::{Env, ProcessRunner, Request};
use crate::render::plugins::PluginsLoadResult;

/// The git events whose native hook can stand in for navori's commit gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHookEvent {
    /// `pre-commit`.
    PreCommit,
    /// `pre-push`.
    PrePush,
}

impl NativeHookEvent {
    /// The TS spelling (also the hook file's name).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PreCommit => "pre-commit",
            Self::PrePush => "pre-push",
        }
    }
}

/// `NativeHookManager`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHookManager {
    /// `husky`.
    Husky,
    /// `lefthook`.
    Lefthook,
    /// `pre-commit`.
    PreCommit,
    /// `plain`.
    Plain,
}

impl NativeHookManager {
    /// The TS spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Husky => "husky",
            Self::Lefthook => "lefthook",
            Self::PreCommit => "pre-commit",
            Self::Plain => "plain",
        }
    }
}

/// `NativeHookAbsence`: why a hook counts as absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHookAbsence {
    /// `unknown-git`.
    UnknownGit,
    /// `missing`.
    Missing,
    /// `not-executable`.
    NotExecutable,
    /// `empty`.
    Empty,
    /// `husky-stub`.
    HuskyStub,
    /// `no-lefthook-config`.
    NoLefthookConfig,
    /// `no-pre-commit-config`.
    NoPreCommitConfig,
    /// `pre-commit-stage-missing`.
    PreCommitStageMissing,
    /// `no-user-content`.
    NoUserContent,
}

impl NativeHookAbsence {
    /// The TS spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnknownGit => "unknown-git",
            Self::Missing => "missing",
            Self::NotExecutable => "not-executable",
            Self::Empty => "empty",
            Self::HuskyStub => "husky-stub",
            Self::NoLefthookConfig => "no-lefthook-config",
            Self::NoPreCommitConfig => "no-pre-commit-config",
            Self::PreCommitStageMissing => "pre-commit-stage-missing",
            Self::NoUserContent => "no-user-content",
        }
    }
}

/// `NativeHookState`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHookState {
    /// The event.
    pub event: NativeHookEvent,
    /// Whether the hook counts as active here.
    pub active: bool,
    /// Manager that generated the hook, when the file exists and was recognised.
    pub manager: Option<NativeHookManager>,
    /// Absolute path of the hook file as git resolves it; `None` when git is unknown.
    pub path: Option<String>,
    /// Set exactly when `active` is false.
    pub absence: Option<NativeHookAbsence>,
}

/// `NativeHooksDetection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHooksDetection {
    /// `git rev-parse --show-toplevel` of `cwd`; `None` outside a work tree.
    pub top: Option<String>,
    /// The resolved hooks directory.
    pub hooks_dir: Option<String>,
    /// Output of `git --version`.
    pub git_version: Option<String>,
    /// `hooks["pre-commit"]`.
    pub pre_commit: NativeHookState,
    /// `hooks["pre-push"]`.
    pub pre_push: NativeHookState,
}

/// `git -C <dir> <args>` with the TS semantics: stdout trimmed, `None` when git failed or is
/// absent.
struct Git<'a> {
    base: &'a Path,
    runner: &'a dyn ProcessRunner,
    env: &'a Env,
}

impl Git<'_> {
    fn run(&self, dir: &str, args: &[&str]) -> Result<Option<String>, Unmodeled> {
        let mut argv = vec!["-C", dir];
        argv.extend_from_slice(args);
        let request = Request {
            program: "git",
            args: &argv,
            cwd: self.base,
            env: self.env,
            input: None,
            // `execFileSync` without a timeout; the bound only guards a hung child.
            timeout: Duration::from_secs(60 * 60),
        };
        let Ok(output) = self.runner.run(&request) else {
            return Ok(None);
        };
        if output.status.code() != Some(0) {
            return Ok(None);
        }
        let text = String::from_utf8(output.stdout).map_err(|_| Unmodeled)?;
        Ok(Some(js_trim(&text).to_owned()))
    }
}

/// `supportsHooksPath`: `core.hooksPath` exists since git 2.9. The first `<digits>.<digits>` of
/// the version line decides.
fn supports_hooks_path(version: Option<&str>) -> bool {
    static VERSION: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(\d+)\.(\d+)").ok());
    let Some(caps) = version.and_then(|v| VERSION.as_ref()?.captures(v)) else {
        return false;
    };
    let number = |index: usize| {
        caps.get(index)
            .and_then(|m| m.as_str().parse::<u64>().ok())
            .unwrap_or(u64::MAX)
    };
    let (major, minor) = (number(1), number(2));
    major > 2 || (major == 2 && minor >= 9)
}

fn absent(
    event: NativeHookEvent,
    path: Option<&str>,
    absence: NativeHookAbsence,
    manager: Option<NativeHookManager>,
) -> NativeHookState {
    NativeHookState {
        event,
        active: false,
        manager,
        path: path.map(str::to_owned),
        absence: Some(absence),
    }
}

/// A non-shebang, non-comment, non-blank line: something the user wrote.
fn has_user_content(text: &str) -> bool {
    text.split('\n').any(|raw| {
        let line = js_trim(raw);
        !line.is_empty() && !line.starts_with('#')
    })
}

fn is_non_empty_regular(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

/// `readSafe`: the file as UTF-8 (invalid bytes replaced), `""` on any error.
fn read_safe(path: &str) -> String {
    std::fs::read(path).map_or_else(
        |_| String::new(),
        |bytes| String::from_utf8_lossy(&bytes).into_owned(),
    )
}

/// `dirname` of an absolute, normalized path.
fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(index) => &path[..index],
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Whether a lefthook config in `top` declares `event`.
fn lefthook_declares(top: &str, event: NativeHookEvent) -> bool {
    static CONFIG: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r"^\.?lefthook(-local)?\.(ya?ml|json|toml)$").ok());
    let Some(config) = CONFIG.as_ref() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(top) else {
        return false;
    };
    let name = event.as_str();
    let (Ok(json), Ok(toml), Ok(yaml)) = (
        Regex::new(&format!(r#""{name}"\s*:"#)),
        Regex::new(&format!(r"(?m)^\[{name}[\].]")),
        Regex::new(&format!(r"(?m)^{name}\s*:")),
    ) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let file = entry.file_name();
        let Some(file) = file.to_str().filter(|n| config.is_match(n)) else {
            return false;
        };
        let text = read_safe(&posix::join(&[top, file]));
        if file.ends_with(".json") {
            json.is_match(&text)
        } else if file.ends_with(".toml") {
            toml.is_match(&text)
        } else {
            yaml.is_match(&text)
        }
    })
}

/// `classify`: one hook file against the managers' fingerprints.
fn classify(
    event: NativeHookEvent,
    top: &str,
    hooks_dir: &str,
    file: &str,
) -> Result<NativeHookState, Unmodeled> {
    static HUSKY_STUB: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r#"(?m)^\s*\.\s+"\$\(dirname "\$0"\)/h"\s*$"#).ok());
    let at = Some(file);
    if !Path::new(file).exists() {
        return Ok(absent(event, at, NativeHookAbsence::Missing, None));
    }
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(absent(event, at, NativeHookAbsence::Missing, None));
    };
    if !meta.is_file() {
        return Ok(absent(event, at, NativeHookAbsence::Missing, None));
    }
    if meta.len() == 0 {
        return Ok(absent(event, at, NativeHookAbsence::Empty, None));
    }
    let executable = {
        use std::os::unix::fs::MetadataExt as _;
        meta.mode() & 0o111 != 0
    };
    if !executable {
        return Ok(absent(event, at, NativeHookAbsence::NotExecutable, None));
    }

    let text = read_safe(file);
    let active = |manager: NativeHookManager| NativeHookState {
        event,
        active: true,
        manager: Some(manager),
        path: Some(file.to_owned()),
        absence: None,
    };

    // husky v9: the file git runs is a stub; the user's script lives one level up.
    let husky_dir =
        basename(hooks_dir) == "_" && Path::new(&posix::join(&[hooks_dir, "h"])).exists();
    let stub = HUSKY_STUB.as_ref().is_some_and(|re| re.is_match(&text));
    if husky_dir || stub {
        let user_script = posix::join(&[dirname(hooks_dir), event.as_str()]);
        return Ok(if is_non_empty_regular(&user_script) {
            active(NativeHookManager::Husky)
        } else {
            absent(
                event,
                at,
                NativeHookAbsence::HuskyStub,
                Some(NativeHookManager::Husky),
            )
        });
    }
    if text.contains("lefthook") {
        return Ok(if lefthook_declares(top, event) {
            active(NativeHookManager::Lefthook)
        } else {
            absent(
                event,
                at,
                NativeHookAbsence::NoLefthookConfig,
                Some(NativeHookManager::Lefthook),
            )
        });
    }
    if text.contains("File generated by pre-commit") {
        let config = posix::join(&[top, ".pre-commit-config.yaml"]);
        let pre_commit = Some(NativeHookManager::PreCommit);
        if !Path::new(&config).exists() {
            return Ok(absent(
                event,
                at,
                NativeHookAbsence::NoPreCommitConfig,
                pre_commit,
            ));
        }
        if event == NativeHookEvent::PrePush && !read_safe(&config).contains("pre-push") {
            return Ok(absent(
                event,
                at,
                NativeHookAbsence::PreCommitStageMissing,
                pre_commit,
            ));
        }
        return Ok(active(NativeHookManager::PreCommit));
    }
    Ok(if has_user_content(&text) {
        active(NativeHookManager::Plain)
    } else {
        absent(
            event,
            at,
            NativeHookAbsence::NoUserContent,
            Some(NativeHookManager::Plain),
        )
    })
}

/// `detectNativeHooks(cwd)`: `pre-commit` and `pre-push` in the clone or worktree holding `cwd`.
/// The hooks directory comes from `git rev-parse --git-path hooks` run in the toplevel, so a
/// relative `core.hooksPath` resolves per worktree.
///
/// # Errors
/// A git answer that is not UTF-8.
pub fn detect_native_hooks(
    cwd: &str,
    base: &Path,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<NativeHooksDetection, Unmodeled> {
    let git = Git { base, runner, env };
    let git_version = git.run(cwd, &["--version"])?;
    let top = git.run(cwd, &["rev-parse", "--show-toplevel"])?;
    let rel = match &top {
        Some(top) => git.run(top, &["rev-parse", "--git-path", "hooks"])?,
        None => None,
    };
    let (Some(top_dir), Some(rel)) = (&top, rel) else {
        return Ok(unknown(top, git_version));
    };
    if rel.is_empty() || !supports_hooks_path(git_version.as_deref()) {
        return Ok(unknown(top, git_version));
    }
    let hooks_dir = posix::resolve(top_dir, &rel);
    let file = |event: NativeHookEvent| posix::join(&[&hooks_dir, event.as_str()]);
    let pre_commit = classify(
        NativeHookEvent::PreCommit,
        top_dir,
        &hooks_dir,
        &file(NativeHookEvent::PreCommit),
    )?;
    let pre_push = classify(
        NativeHookEvent::PrePush,
        top_dir,
        &hooks_dir,
        &file(NativeHookEvent::PrePush),
    )?;
    Ok(NativeHooksDetection {
        top,
        hooks_dir: Some(hooks_dir),
        git_version,
        pre_commit,
        pre_push,
    })
}

fn unknown(top: Option<String>, git_version: Option<String>) -> NativeHooksDetection {
    NativeHooksDetection {
        top,
        hooks_dir: None,
        git_version,
        pre_commit: absent(
            NativeHookEvent::PreCommit,
            None,
            NativeHookAbsence::UnknownGit,
            None,
        ),
        pre_push: absent(
            NativeHookEvent::PrePush,
            None,
            NativeHookAbsence::UnknownGit,
            None,
        ),
    }
}

/// `listWorktreePaths(cwd)`: paths from `git worktree list --porcelain`; empty outside git.
///
/// # Errors
/// A git answer that is not UTF-8.
pub fn list_worktree_paths(
    cwd: &str,
    base: &Path,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<Vec<String>, Unmodeled> {
    let git = Git { base, runner, env };
    let Some(out) = git.run(cwd, &["worktree", "list", "--porcelain"])? else {
        return Ok(Vec::new());
    };
    Ok(out
        .split('\n')
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(str::to_owned)
        .collect())
}

/// `NativeHookFinding.level`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindingLevel {
    /// `info`.
    Info,
    /// `warning`.
    Warning,
    /// `error`.
    Error,
}

/// `NativeHookFinding.code`, with the payload each code carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FindingCode {
    /// `found`.
    Found(NativeHookState),
    /// `gate-declared-missing`.
    GateDeclaredMissing {
        /// The absent `pre-commit`.
        state: NativeHookState,
        /// `git --version`.
        git_version: Option<String>,
    },
    /// `plugin-declared-missing`.
    PluginDeclaredMissing {
        /// The plugin id.
        plugin: String,
        /// `git --version`.
        git_version: Option<String>,
    },
    /// `plugin-only-guarantee`.
    PluginOnlyGuarantee(String),
    /// `duplicate`.
    Duplicate(NativeHookState),
    /// `worktree-missing`.
    WorktreeMissing(String),
}

/// `NativeHookFinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHookFinding {
    /// Severity.
    pub level: FindingLevel,
    /// What was found.
    pub code: FindingCode,
}

/// `NativeHooksReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeHooksReport {
    /// The detection of `cwd`.
    pub detection: NativeHooksDetection,
    /// Findings, in the TS order.
    pub findings: Vec<NativeHookFinding>,
    /// Count of `error` findings; they flip the health verdict.
    pub errors: usize,
}

/// `scanNativeHooks(cwd, config)`: `None` outside git when nothing is declared.
///
/// - Always (inside git): one info finding per event with manager and path.
/// - `qualityGate.nativeHooks` declared and `pre-commit` not active in THIS clone/worktree:
///   error. Undeclared and active: duplicate warning.
/// - Plugins whose hooks `nativeHook` omitted: an info, and an error when both events are absent.
/// - With any declaration, a warning per `.claude/worktrees/` worktree whose `pre-commit` is
///   absent.
///
/// # Errors
/// A git answer that is not UTF-8, or a plugin manifest without a text `id`.
pub fn scan_native_hooks(
    cwd: &str,
    config: &Config,
    plugins: &PluginsLoadResult,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<Option<NativeHooksReport>, Unmodeled> {
    let base = Path::new(cwd);
    let gate_declared = match &config.data {
        JsValue::Object(root) => match root.get("qualityGate") {
            Some(JsValue::Object(gate)) => gate.get("nativeHooks") == Some(&JsValue::Bool(true)),
            _ => false,
        },
        _ => false,
    };
    let omitted: Vec<String> = plugins
        .loaded
        .iter()
        .filter(|p| p.native_hook_omitted)
        .map(|p| p.manifest_id())
        .collect();
    let declared = gate_declared || !omitted.is_empty();
    let detection = detect_native_hooks(cwd, base, runner, env)?;
    if detection.top.is_none() && !declared {
        return Ok(None);
    }

    let mut findings = Vec::new();
    for state in [&detection.pre_commit, &detection.pre_push] {
        findings.push(NativeHookFinding {
            level: FindingLevel::Info,
            code: FindingCode::Found(state.clone()),
        });
    }
    let commit = &detection.pre_commit;
    let push = &detection.pre_push;
    if gate_declared && !commit.active {
        findings.push(NativeHookFinding {
            level: FindingLevel::Error,
            code: FindingCode::GateDeclaredMissing {
                state: commit.clone(),
                git_version: detection.git_version.clone(),
            },
        });
    }
    if !gate_declared && commit.active {
        findings.push(NativeHookFinding {
            level: FindingLevel::Warning,
            code: FindingCode::Duplicate(commit.clone()),
        });
    }
    for plugin in omitted {
        findings.push(NativeHookFinding {
            level: FindingLevel::Info,
            code: FindingCode::PluginOnlyGuarantee(plugin.clone()),
        });
        if !commit.active && !push.active {
            findings.push(NativeHookFinding {
                level: FindingLevel::Error,
                code: FindingCode::PluginDeclaredMissing {
                    plugin,
                    git_version: detection.git_version.clone(),
                },
            });
        }
    }
    if declared && let Some(top) = &detection.top {
        for path in list_worktree_paths(top, base, runner, env)? {
            if !path.contains("/.claude/worktrees/") || path == *top {
                continue;
            }
            if !detect_native_hooks(&path, base, runner, env)?
                .pre_commit
                .active
            {
                findings.push(NativeHookFinding {
                    level: FindingLevel::Warning,
                    code: FindingCode::WorktreeMissing(path),
                });
            }
        }
    }
    let errors = findings
        .iter()
        .filter(|f| f.level == FindingLevel::Error)
        .count();
    Ok(Some(NativeHooksReport {
        detection,
        findings,
        errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn git_older_than_2_9_cannot_tell_where_the_hooks_live() {
        assert!(supports_hooks_path(Some("git version 2.43.0")));
        assert!(supports_hooks_path(Some("git version 2.9.0")));
        assert!(supports_hooks_path(Some("git version 10.0.1")));
        assert!(!supports_hooks_path(Some("git version 2.8.9")));
        assert!(!supports_hooks_path(Some("git version 1.9")));
        assert!(!supports_hooks_path(Some("git")));
        assert!(!supports_hooks_path(None));
    }

    // Covers: R73
    #[test]
    fn user_content_ignores_blank_lines_shebangs_and_comments() {
        assert!(!has_user_content("#!/bin/sh\n\n  # note\n"));
        assert!(has_user_content("#!/bin/sh\nbun run check\n"));
    }

    // Covers: R73
    #[test]
    fn path_helpers_follow_node() {
        assert_eq!(dirname("/a/b/_"), "/a/b");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(basename("/a/b/_"), "_");
    }
}
