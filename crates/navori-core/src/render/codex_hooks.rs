//! Codex hook registrations (`engines/codex/hook-registrations.ts`) and the trust hash Codex keys
//! them by (`codexHookHash` and `canonicalJson` of `lib/codex/trust.ts`), spec 0059 T19, R66.
//!
//! No `OVERLAP_ROWS` unit is native on Codex today, so `isNativeOn` never drops a row here. No
//! bundled plugin declares `hooks`; a plugin that does delegates (the translation of
//! `resolvePluginCodexHooks` is not modelled).

use sha2::{Digest as _, Sha256};

use crate::content_identity::hex;
use crate::js_json::{JsObject, JsValue};
use crate::render::block_plan::truthy;
use crate::render::plugins::LoadedPlugin;

/// When a registration applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum When {
    Always,
    QualityGateFast,
    ScribeOwnsMarkdown,
    VerifyOnStop,
    MasterPlan,
    PlanTiers,
    CodexIntegration,
}

/// One row of `CODEX_HOOK_REGISTRATIONS` that registers.
struct Registration {
    script: &'static str,
    event: &'static str,
    matcher: Option<&'static str>,
    timeout: u32,
    status_message: &'static str,
    args: Option<&'static str>,
    when: When,
    late: bool,
}

const fn row(
    script: &'static str,
    event: &'static str,
    matcher: Option<&'static str>,
    timeout: u32,
    status_message: &'static str,
) -> Registration {
    Registration {
        script,
        event,
        matcher,
        timeout,
        status_message,
        args: None,
        when: When::Always,
        late: false,
    }
}

impl Registration {
    const fn args(mut self, args: &'static str) -> Self {
        self.args = Some(args);
        self
    }
    const fn when(mut self, when: When) -> Self {
        self.when = when;
        self
    }
    const fn late(mut self) -> Self {
        self.late = true;
        self
    }
}

const BASH: Option<&str> = Some("^Bash$");
const SESSION: Option<&str> = Some("startup|resume|clear|compact|fork");

/// `CODEX_HOOK_REGISTRATIONS` without the rows that ship no registration
/// (`bash-outcome-watch`, `subagent-no-background`), in table order.
static REGISTRATIONS: &[Registration] = &[
    row(
        "guard-destructive",
        "PreToolUse",
        BASH,
        30,
        "Checking destructive command policy",
    ),
    row(
        "comment-draft-confirm",
        "PreToolUse",
        BASH,
        10,
        "Checking for an unconfirmed comment/review draft",
    ),
    row(
        "quality-gate-pre-commit",
        "PreToolUse",
        BASH,
        600,
        "Running pre-commit quality gate",
    )
    .when(When::QualityGateFast),
    row(
        "model-advisor",
        "SessionStart",
        None,
        10,
        "navori: model advisor",
    )
    .args("codex-session-start"),
    row(
        "session-start-context",
        "SessionStart",
        SESSION,
        15,
        "navori: session context",
    ),
    row(
        "implementer-no-markdown",
        "PreToolUse",
        Some("^(Bash|apply_patch)$"),
        10,
        "navori: implementer-no-markdown",
    )
    .when(When::ScribeOwnsMarkdown),
    row(
        "managed-drift-watch",
        "PostToolUse",
        Some("^(Bash|apply_patch)$"),
        10,
        "navori: managed-block drift",
    ),
    row(
        "routing-watch",
        "PostToolUse",
        Some("^(Bash|apply_patch|spawn_agent)$"),
        10,
        "navori: routing check",
    ),
    row(
        "subagent-stop-handoff",
        "SubagentStop",
        None,
        15,
        "navori: handoff check",
    )
    .args("codex"),
    row(
        "audit-mode-trigger",
        "UserPromptSubmit",
        None,
        10,
        "navori: audit-mode",
    ),
    row(
        "audit-mode-close",
        "SessionEnd",
        None,
        3,
        "navori: audit-mode close",
    ),
    row(
        "worktree-reclaim",
        "SessionStart",
        Some("startup"),
        30,
        "navori: reclaim worktrees",
    ),
    row(
        "stop-verify-reminder",
        "Stop",
        None,
        15,
        "navori: verify-before-done",
    )
    .args("codex")
    .when(When::VerifyOnStop),
    row(
        "master-accept-confirm",
        "PreToolUse",
        BASH,
        10,
        "navori: master acceptance confirmation",
    )
    .when(When::MasterPlan)
    .late(),
    row(
        "master-plan-context",
        "SessionStart",
        SESSION,
        10,
        "navori: master-plan context",
    )
    .when(When::MasterPlan)
    .late(),
    row(
        "role-guard",
        "PreToolUse",
        Some("^apply_patch$|spawn_agent$"),
        10,
        "navori: role-guard",
    )
    .late(),
    row(
        "pr-publisher-confirm",
        "PreToolUse",
        BASH,
        10,
        "navori: pr-publisher-confirm",
    )
    .late(),
    row(
        "general-purpose-confirm",
        "PreToolUse",
        Some("spawn_agent$"),
        10,
        "navori: general-purpose-confirm",
    )
    .late(),
    row(
        "plan-gate",
        "PreToolUse",
        Some("spawn_agent$"),
        15,
        "navori: plan-gate",
    )
    .when(When::PlanTiers)
    .late(),
    row(
        "engram-write-guard",
        "PreToolUse",
        Some("mcp__engram__|mcp__plugin_engram_engram__"),
        10,
        "navori: engram-write-guard",
    )
    .late(),
    row(
        "subagent-stop-handoff",
        "SubagentStart",
        None,
        15,
        "navori: child capture",
    )
    .args("codex capture-start")
    .late(),
    row(
        "model-advisor",
        "PreToolUse",
        Some("^(Agent|spawn_agent|collaborationspawn_agent)$"),
        15,
        "navori: future child profile",
    )
    .args("codex-pretool-profile")
    .when(When::CodexIntegration)
    .late(),
];

/// `ResolvedCodexHook` for a core hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCodexHook {
    /// Script id (`.codex/hooks/<script>.sh`).
    pub script: String,
    /// Codex event (`PreToolUse`, ...).
    pub event: String,
    /// Matcher, when the registration has one.
    pub matcher: Option<String>,
    /// Timeout in seconds.
    pub timeout: u32,
    /// Status message.
    pub status_message: Option<String>,
    /// Arguments after the script.
    pub args: Option<String>,
}

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn applies(when: When, config: &JsValue) -> bool {
    let at = |section: &str, key: &str| get(config, section).and_then(|s| get(s, key));
    match when {
        When::Always => true,
        When::QualityGateFast => at("qualityGate", "fast").is_some_and(truthy),
        When::ScribeOwnsMarkdown => at("harness", "scribeOwnsMarkdown").is_some_and(truthy),
        When::VerifyOnStop => at("hooks", "verifyOnStop").is_some_and(truthy),
        When::MasterPlan => at("harness", "masterPlan").is_some_and(truthy),
        When::PlanTiers => at("harness", "planTiers").is_some_and(truthy),
        When::CodexIntegration => at("harness", "codexIntegration") == Some(&JsValue::Bool(true)),
    }
}

/// `resolveCodexHooks(config, plugins)`: the early rows, the plugin rows and the late rows, in
/// that order (each block's `trusted_hash` index depends on it). `None` when a plugin declares
/// `hooks`.
#[must_use]
pub fn resolve_codex_hooks(
    config: &JsValue,
    plugins: &[LoadedPlugin],
) -> Option<Vec<ResolvedCodexHook>> {
    let declares_hooks = plugins
        .iter()
        .any(|plugin| match get(&plugin.manifest, "hooks") {
            None | Some(JsValue::Undefined) => false,
            Some(JsValue::Array(items)) => !items.is_empty(),
            Some(_) => true,
        });
    if declares_hooks {
        return None;
    }
    let (mut early, mut late) = (Vec::new(), Vec::new());
    for registration in REGISTRATIONS {
        if !applies(registration.when, config) {
            continue;
        }
        let hook = ResolvedCodexHook {
            script: registration.script.to_owned(),
            event: registration.event.to_owned(),
            matcher: registration.matcher.map(str::to_owned),
            timeout: registration.timeout,
            status_message: Some(registration.status_message.to_owned()),
            args: registration.args.map(str::to_owned),
        };
        if registration.late {
            late.push(hook);
        } else {
            early.push(hook);
        }
    }
    early.extend(late);
    Some(early)
}

/// `hookExtensionTarget(target, "codex")`: the `.codex/hooks/` mirror of a Claude hook path.
#[must_use]
pub fn codex_hook_extension_target(target: &str) -> Option<String> {
    target
        .strip_prefix(".claude/hooks/")
        .map(|hook| format!(".codex/hooks/{hook}"))
}

/// `codexInstalledScripts(config, plugins)`: every registered hook script, plus the scripts of a
/// plugin whose hook extension rides inside an installed hook (spec 0041 D15). `None` when a
/// plugin declares `hooks`.
#[must_use]
pub fn codex_installed_scripts(config: &JsValue, plugins: &[LoadedPlugin]) -> Option<Vec<String>> {
    let mut installed: Vec<String> = Vec::new();
    for hook in resolve_codex_hooks(config, plugins)? {
        let path = format!(".codex/hooks/{}.sh", hook.script);
        if !installed.contains(&path) {
            installed.push(path);
        }
    }
    for plugin in plugins {
        let hosted = plugin.hook_extension_assets.iter().any(|extension| {
            codex_hook_extension_target(&extension.target)
                .is_some_and(|target| installed.contains(&target))
        });
        if !hosted {
            continue;
        }
        for script in &plugin.script_assets {
            let path = format!(".codex/scripts/{}", script.dest);
            if !installed.contains(&path) {
                installed.push(path);
            }
        }
    }
    Some(installed)
}

/// `codexHookCommand(hook, wsSubpath)`: the script resolved from the repo root, so it works from
/// any working directory.
#[must_use]
pub fn codex_hook_command(hook: &ResolvedCodexHook, ws_subpath: &str) -> String {
    let prefix = if ws_subpath.is_empty() {
        String::new()
    } else {
        format!("/{ws_subpath}")
    };
    let suffix = format!("{prefix}/.codex/hooks/{}.sh", hook.script);
    let mut quoted = String::with_capacity(suffix.len());
    for ch in suffix.chars() {
        if matches!(ch, '\\' | '"' | '$' | '`') {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    let args = hook
        .args
        .as_deref()
        .map_or(String::new(), |a| format!(" {a}"));
    format!("bash \"$(git rev-parse --show-toplevel){quoted}\"{args}")
}

/// `canonicalJson`: object keys sorted by UTF-16 code units, no whitespace.
#[must_use]
pub fn canonical_json(value: &JsValue) -> Option<String> {
    match value {
        JsValue::Array(items) => {
            let parts: Option<Vec<String>> = items.iter().map(canonical_json).collect();
            Some(format!("[{}]", parts?.join(",")))
        }
        JsValue::Object(object) => {
            let mut entries: Vec<_> = object.entries().iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));
            let mut parts = Vec::with_capacity(entries.len());
            for (key, value) in entries {
                let key = JsValue::String(key.clone()).stringify(None)?;
                parts.push(format!("{key}:{}", canonical_json(value)?));
            }
            Some(format!("{{{}}}", parts.join(",")))
        }
        other => other.stringify(None),
    }
}

/// `EVENT_SNAKE_CASE`.
fn event_snake_case(event: &str) -> Option<&'static str> {
    Some(match event {
        "PreToolUse" => "pre_tool_use",
        "PostToolUse" => "post_tool_use",
        "SessionStart" => "session_start",
        "SessionEnd" => "session_end",
        "UserPromptSubmit" => "user_prompt_submit",
        "Stop" => "stop",
        "SubagentStart" => "subagent_start",
        "SubagentStop" => "subagent_stop",
        "PreCompact" => "pre_compact",
        "PostCompact" => "post_compact",
        "Interrupt" => "interrupt",
        "PermissionRequest" => "permission_request",
        _ => return None,
    })
}

/// `codexHookHash(hook, command)`: `sha256:` of the canonical JSON of the registration Codex
/// hashes. `None` for an event Codex does not know (the TS throws).
#[must_use]
pub fn codex_hook_hash(hook: &ResolvedCodexHook, command: &str) -> Option<String> {
    let mut entry = JsObject::new();
    entry.insert("type", JsValue::string("command"));
    entry.insert("command", JsValue::string(command));
    entry.insert("timeout", JsValue::Number(f64::from(hook.timeout)));
    entry.insert("async", JsValue::Bool(false));
    if let Some(message) = &hook.status_message {
        entry.insert("statusMessage", JsValue::string(message));
    }
    let mut registration = JsObject::new();
    registration.insert(
        "event_name",
        JsValue::string(event_snake_case(&hook.event)?),
    );
    registration.insert("hooks", JsValue::Array(vec![JsValue::Object(entry)]));
    if let Some(matcher) = &hook.matcher {
        registration.insert("matcher", JsValue::string(matcher));
    }
    let digest = Sha256::digest(canonical_json(&JsValue::Object(registration))?.as_bytes());
    Some(format!("sha256:{}", hex(&digest)))
}
