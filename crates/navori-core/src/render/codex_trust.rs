//! `readCodexTrustState` of `lib/codex/trust.ts` (spec 0059 T19, D37): the trust of a project's
//! `.codex/config.toml` hooks against Codex's machine-global `config.toml`, read-only. Unparseable
//! is treated like absent: every hook `Untrusted` and the project untrusted.

use std::path::{Path, PathBuf};

use crate::render::codex_catalog::codex_home;
use crate::render::codex_hooks::{ResolvedCodexHook, codex_hook_command, codex_hook_hash};

/// `EVENT_SNAKE_CASE`.
const EVENT_SNAKE_CASE: [(&str, &str); 12] = [
    ("PreToolUse", "pre_tool_use"),
    ("PostToolUse", "post_tool_use"),
    ("SessionStart", "session_start"),
    ("SessionEnd", "session_end"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("Stop", "stop"),
    ("SubagentStart", "subagent_start"),
    ("SubagentStop", "subagent_stop"),
    ("PreCompact", "pre_compact"),
    ("PostCompact", "post_compact"),
    ("Interrupt", "interrupt"),
    ("PermissionRequest", "permission_request"),
];

/// `CodexHookTrustStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustStatus {
    /// The stored hash matches.
    Trusted,
    /// A hash is stored but differs.
    Modified,
    /// Nothing is stored.
    Untrusted,
}

impl TrustStatus {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Trusted => "Trusted",
            Self::Modified => "Modified",
            Self::Untrusted => "Untrusted",
        }
    }
}

/// `CodexHookTrustEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookTrust {
    /// Script id.
    pub script: String,
    /// Codex event.
    pub event: String,
    /// Matcher.
    pub matcher: Option<String>,
    /// `<configTomlPath>:<event_snake>:<group>:<handler>`.
    pub key: String,
    /// The hash Codex would store when trusting the hook.
    pub expected_hash: String,
    /// Status.
    pub status: TrustStatus,
}

/// `CodexTrustState`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTrustState {
    /// `[projects."<root>"] trust_level = "trusted"`.
    pub project_trusted: bool,
    /// One entry per registered hook, in registration order.
    pub hooks: Vec<HookTrust>,
}

impl CodexTrustState {
    /// What `appendCodexTrustHint` checks: the project or a hook still needs trust.
    #[must_use]
    pub fn something_missing(&self) -> bool {
        !self.project_trusted || self.hooks.iter().any(|h| h.status != TrustStatus::Trusted)
    }
}

/// `defaultCodexHomeConfigPath()`; `None` where `codexHome()` throws.
#[must_use]
pub fn default_codex_home_config_path() -> Option<PathBuf> {
    codex_home().map(|home| home.join("config.toml"))
}

/// `readCodexHomeConfig`: the parsed file, `None` when absent or not valid TOML.
fn read_home_config(path: &Path) -> Option<toml::Table> {
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8_lossy(&bytes).parse::<toml::Table>().ok()
}

fn table(value: Option<&toml::Value>) -> Option<&toml::Table> {
    match value? {
        toml::Value::Table(table) => Some(table),
        _ => None,
    }
}

/// `readCodexTrustState(projectRoot, configTomlPath, hooks, { codexHomeConfigPath, wsSubpath })`.
/// `None` where the TS throws (an event without a snake-case name, a hash it cannot compute).
#[must_use]
pub fn read_codex_trust_state(
    project_root: &str,
    config_toml_path: &str,
    hooks: &[ResolvedCodexHook],
    home_config: &Path,
    ws_subpath: &str,
) -> Option<CodexTrustState> {
    let parsed = read_home_config(home_config);
    let project_trusted = parsed.as_ref().is_some_and(|root| {
        table(table(root.get("projects")).and_then(|projects| projects.get(project_root)))
            .and_then(|project| project.get("trust_level"))
            .and_then(toml::Value::as_str)
            == Some("trusted")
    });
    let state = parsed
        .as_ref()
        .and_then(|root| table(root.get("hooks")))
        .and_then(|hooks| table(hooks.get("state")));
    let mut groups: Vec<(String, usize)> = Vec::new();
    let mut entries = Vec::with_capacity(hooks.len());
    for hook in hooks {
        let group = match groups.iter_mut().find(|(event, _)| *event == hook.event) {
            Some((_, count)) => {
                *count += 1;
                *count - 1
            }
            None => {
                groups.push((hook.event.clone(), 1));
                0
            }
        };
        let snake = EVENT_SNAKE_CASE
            .iter()
            .find_map(|(event, snake)| (*event == hook.event).then_some(*snake))?;
        let key = format!("{config_toml_path}:{snake}:{group}:0");
        let expected_hash = codex_hook_hash(hook, &codex_hook_command(hook, ws_subpath))?;
        let status = match table(state.and_then(|state| state.get(&key)))
            .and_then(|entry| entry.get("trusted_hash"))
        {
            None => TrustStatus::Untrusted,
            Some(toml::Value::String(stored)) if *stored == expected_hash => TrustStatus::Trusted,
            Some(_) => TrustStatus::Modified,
        };
        entries.push(HookTrust {
            script: hook.script.clone(),
            event: hook.event.clone(),
            matcher: hook.matcher.clone(),
            key,
            expected_hash,
            status,
        });
    }
    Some(CodexTrustState {
        project_trusted,
        hooks: entries,
    })
}
