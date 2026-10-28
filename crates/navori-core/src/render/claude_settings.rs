//! `buildClaudeSettings` (`engines/claude/build-settings.ts`, spec 0058 T15), with `deepMerge`,
//! `collectShellPermissionRules` (`engines/shared/permission-rules.ts`) and the plain
//! `claudeHookCommand`: the `.claude/settings.json` object a render wants, before ownership,
//! coexistence and the native wiring decide what is written.

use crate::STAMP_VERSION;
use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsObject, JsValue};
use crate::manifest::Hook;
use crate::render::assets;
use crate::render::block_plan::truthy;
use crate::render::harness_plan::{HarnessPlan, is_agent_enabled};
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::native_hook::{NativeEngine, NativeShell, native_runner_shell, quote};
use crate::render::plugins::LoadedPlugin;

/// The bundled base is missing or not JSON, or a plugin fragment has a shape Rust does not model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingsDelegate;

const SETTINGS_BASE: &str = "core-assets/settings/settings-base.json";

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn text(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.insert(key, value);
    }
    JsValue::Object(out)
}

/// `JSON.stringify(value)`, the dedupe key of `deepMerge` and of the hook coalescing.
fn key(value: &JsValue) -> String {
    value.stringify(None).unwrap_or_default()
}

fn dedupe(items: Vec<JsValue>) -> Vec<JsValue> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(key(item)))
        .collect()
}

/// `deepMerge(base, override)`: objects recurse, arrays concatenate and dedupe by JSON, anything
/// else in `override` wins.
#[must_use]
pub fn deep_merge(base: &JsObject, over: &JsObject) -> JsObject {
    let mut result = JsObject::new();
    for (key, value) in base.ordered() {
        result.insert(key.clone(), value.clone());
    }
    for (key, over_value) in over.ordered() {
        let merged = match (base.entries().iter().find(|(k, _)| k == key), over_value) {
            (Some((_, JsValue::Array(a))), JsValue::Array(b)) => {
                JsValue::Array(dedupe(a.iter().chain(b).cloned().collect()))
            }
            (Some((_, JsValue::Object(a))), JsValue::Object(b)) => {
                JsValue::Object(deep_merge(a, b))
            }
            _ => over_value.clone(),
        };
        result.insert(key.clone(), merged);
    }
    result
}

fn merge_into(settings: &mut JsObject, over: JsValue) {
    if let JsValue::Object(over) = over {
        *settings = deep_merge(settings, &over);
    }
}

/// Arguments the native arm may forward: plain words, so deferring never expands them twice.
fn plain_args(args: &str) -> bool {
    !args.is_empty()
        && args.split(' ').all(|word| {
            !word.is_empty()
                && word
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        })
}

/// `claudeHookCommand(event, scriptRel, args, native)`: the command `settings.json` registers
/// for a hook script, with the native runtime arm first when `native` is a ported hook.
#[must_use]
pub fn claude_hook_command(
    event: &str,
    script_rel: &str,
    args: Option<&str>,
    native: Option<&Hook>,
) -> String {
    let args = args.filter(|a| !a.is_empty());
    let native = if args.is_some_and(|a| !plain_args(a)) {
        None
    } else {
        native
    };
    let native_arm = native.map_or_else(String::new, |descriptor| {
        let file = script_rel.rsplit('/').next().unwrap_or(script_rel);
        let hook = file.strip_suffix(".sh").unwrap_or(file);
        let invocation = format!("--via-command {} \"$f\"", quote(event));
        format!(
            "{}\n",
            native_runner_shell(&NativeShell {
                engine: NativeEngine::Claude,
                hook,
                mode: descriptor.mode,
                gating: descriptor.gating && event == "PreToolUse",
                invocation: &invocation,
                args,
            })
        )
    });
    let run = format!(
        "f=\"$CLAUDE_PROJECT_DIR/{script_rel}\"; {native_arm}bash -n \"$f\" 2>/dev/null && exec bash \"$f\"{}; ",
        args.map(|a| format!(" {a}")).unwrap_or_default()
    );
    let reason = format!(
        "navori: {script_rel} cannot be parsed (merge/rebase conflict?): abort or resolve it, then navori render --apply"
    );
    if event == "PreToolUse" {
        let decision = object(vec![(
            "hookSpecificOutput",
            object(vec![
                ("hookEventName", JsValue::string("PreToolUse")),
                ("permissionDecision", JsValue::string("ask")),
                ("permissionDecisionReason", JsValue::string(&reason)),
            ]),
        )]);
        return format!("{run}printf '%s\\n' '{}'", key(&decision));
    }
    format!("{run}echo '{reason}' >&2; exit 1")
}

/// One `{ type: "command", command, timeout, statusMessage }`.
fn hook(event: &str, id: &str, args: Option<&str>, timeout: f64, status: &str) -> JsValue {
    object(vec![
        ("type", JsValue::string("command")),
        (
            "command",
            JsValue::string(&claude_hook_command(
                event,
                &format!(".claude/hooks/{id}.sh"),
                args,
                None,
            )),
        ),
        ("timeout", JsValue::Number(timeout)),
        ("statusMessage", JsValue::string(status)),
    ])
}

/// `{ hooks: { <event>: [ { matcher?, hooks: [...] } ] } }`.
fn registration(event: &str, matcher: Option<&str>, hooks: Vec<JsValue>) -> JsValue {
    let mut bucket = Vec::new();
    if let Some(matcher) = matcher {
        bucket.push(("matcher", JsValue::string(matcher)));
    }
    bucket.push(("hooks", JsValue::Array(hooks)));
    object(vec![(
        "hooks",
        object(vec![(event, JsValue::Array(vec![object(bucket)]))]),
    )])
}

fn flag(config: &JsValue, section: &str, key: &str) -> bool {
    get(config, section)
        .and_then(|s| get(s, key))
        .is_some_and(truthy)
}

/// The JS-whitespace tokens of `text` (`text.split(/\s+/)`, without the empty edges).
fn words(text: &str) -> Vec<&str> {
    text.split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .collect()
}

/// `gate.split(/\s*(?:&&|\|\||;)\s*/).map(trim)`.
fn gate_steps(gate: &str) -> Vec<&str> {
    let mut steps = Vec::new();
    let mut rest = gate;
    loop {
        let next = ["&&", "||", ";"]
            .iter()
            .filter_map(|sep| rest.find(sep).map(|at| (at, sep.len())))
            .min_by_key(|(at, _)| *at);
        match next {
            Some((at, len)) => {
                steps.push(js_trim(&rest[..at]));
                rest = &rest[at + len..];
            }
            None => {
                steps.push(js_trim(rest));
                return steps;
            }
        }
    }
}

const PACKAGE_MANAGERS: [&str; 4] = ["pnpm", "npm", "yarn", "bun"];
const DEV_LOOP_SCRIPTS: [&str; 5] = ["build", "test", "lint", "typecheck", "format"];

fn bare_script_forms(pm: &str) -> &'static [&'static str] {
    match pm {
        "pnpm" | "yarn" => &DEV_LOOP_SCRIPTS,
        "npm" => &["test"],
        "bun" => &["lint", "typecheck", "format"],
        _ => &[],
    }
}

/// `SAFE_GATE_STEP`: `^[\w @.:/=-]+$` with JS's ASCII `\w`.
fn safe_step(step: &str) -> bool {
    !step.is_empty()
        && step
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " _@.:/=-".contains(c))
}

/// `gateStepRule`.
fn gate_step_rule(step: &str) -> Option<String> {
    if !safe_step(step) {
        return None;
    }
    let first = step.split(is_js_whitespace).next().unwrap_or_default();
    if PACKAGE_MANAGERS.contains(&first) {
        return Some(format!("Bash({step}:*)"));
    }
    // `CD_STEP`: `^cd\s+\S+$`.
    let cd = step
        .strip_prefix("cd")
        .filter(|rest| rest.starts_with(is_js_whitespace))
        .map(|rest| rest.trim_start_matches(is_js_whitespace))
        .is_some_and(|target| !target.is_empty() && !target.contains(is_js_whitespace));
    cd.then(|| format!("Bash({step})"))
}

/// `isSafeGateChain`.
fn safe_gate_chain(gate: &str) -> bool {
    gate_steps(gate)
        .iter()
        .all(|step| !step.is_empty() && gate_step_rule(step).is_some())
}

fn package_manager(config: &JsValue) -> Option<String> {
    if let Some(pm) = text(get(config, "packageManager")).filter(|p| !p.is_empty()) {
        return Some(pm);
    }
    let fast = text(get(config, "qualityGate").and_then(|q| get(q, "fast")))?;
    gate_steps(&fast).into_iter().find_map(|step| {
        let runner = words(step).first().copied().unwrap_or_default();
        PACKAGE_MANAGERS
            .contains(&runner)
            .then(|| runner.to_owned())
    })
}

/// `deriveQualityGateAllow`.
fn derive_quality_gate_allow(config: &JsValue) -> Vec<String> {
    let mut rules: Vec<String> = Vec::new();
    let mut add = |rule: String| {
        if !rules.contains(&rule) {
            rules.push(rule);
        }
    };
    let gate = |kind: &str| text(get(config, "qualityGate").and_then(|q| get(q, kind)));
    for kind in ["fast", "scoped", "full"] {
        let Some(gate) = gate(kind).filter(|g| !js_trim(g).is_empty()) else {
            continue;
        };
        let steps = gate_steps(&gate);
        for step in &steps {
            if let Some(rule) = (!step.is_empty()).then(|| gate_step_rule(step)).flatten() {
                add(rule);
            }
        }
        if steps.len() > 1 && safe_gate_chain(&gate) {
            add(format!("Bash({})", js_trim(&gate)));
        }
    }
    for kind in ["fast", "full"] {
        if gate(kind).is_some_and(|g| !js_trim(&g).is_empty() && safe_gate_chain(&g)) {
            add(format!("Bash(navori gate {kind})"));
        }
    }
    if let Some(pm) = package_manager(config) {
        for script in DEV_LOOP_SCRIPTS {
            add(format!("Bash({pm} run {script}:*)"));
            if bare_script_forms(&pm).contains(&script) {
                add(format!("Bash({pm} {script}:*)"));
            }
        }
    }
    rules
}

/// `ShellPermissionRules`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ShellPermissionRules {
    /// `permissions.allow`.
    pub allow: Vec<JsValue>,
    /// `permissions.ask`.
    pub ask: Vec<JsValue>,
    /// `permissions.deny`.
    pub deny: Vec<JsValue>,
}

fn settings_base(config: &JsValue) -> Result<JsObject, SettingsDelegate> {
    let raw = assets::core(SETTINGS_BASE)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .ok_or(SettingsDelegate)?;
    let options = InterpolateOptions {
        extra_vars: [("cliVersion".to_owned(), STAMP_VERSION.to_owned())].into(),
        ..InterpolateOptions::default()
    };
    match js_json::parse(&interpolate(raw, config, &options)) {
        Some(JsValue::Object(base)) => Ok(base),
        _ => Err(SettingsDelegate),
    }
}

fn fragment(plugin: &LoadedPlugin) -> Option<&JsObject> {
    match get(&plugin.manifest, "settingsFragment") {
        Some(JsValue::Object(fragment)) => Some(fragment),
        _ => None,
    }
}

/// `collectShellPermissionRules`.
///
/// # Errors
/// [`SettingsDelegate`] when the base is unreadable or a merged list is not an array.
pub fn collect_shell_permission_rules(
    config: &JsValue,
    plugins: &[LoadedPlugin],
) -> Result<ShellPermissionRules, SettingsDelegate> {
    let base = settings_base(config)?;
    let mut merged = JsObject::new();
    merged.insert(
        "permissions",
        base.get("permissions")
            .cloned()
            .unwrap_or(JsValue::Object(JsObject::new())),
    );
    for plugin in plugins {
        if let Some(permissions) = fragment(plugin).and_then(|f| f.get("permissions"))
            && truthy(permissions)
        {
            merge_into(
                &mut merged,
                object(vec![("permissions", permissions.clone())]),
            );
        }
    }
    let derived = derive_quality_gate_allow(config);
    if !derived.is_empty() {
        let allow = derived.iter().map(|r| JsValue::string(r)).collect();
        merge_into(
            &mut merged,
            object(vec![(
                "permissions",
                object(vec![("allow", JsValue::Array(allow))]),
            )]),
        );
    }
    let list = |name: &str| -> Result<Vec<JsValue>, SettingsDelegate> {
        match merged.get("permissions").and_then(|p| get(p, name)) {
            None | Some(JsValue::Undefined | JsValue::Null) => Ok(Vec::new()),
            Some(JsValue::Array(items)) => Ok(items.clone()),
            Some(_) => Err(SettingsDelegate),
        }
    };
    Ok(ShellPermissionRules {
        allow: list("allow")?,
        ask: list("ask")?,
        deny: list("deny")?,
    })
}

/// `CORE_HOOK_COMMAND`: the id of the first `.claude/hooks/<id>.sh` a command names.
fn core_hook_id(command: &str) -> Option<&str> {
    let mut rest = command;
    while let Some(at) = rest.find(".claude/hooks/") {
        let tail = &rest[at + ".claude/hooks/".len()..];
        let len = tail
            .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
            .unwrap_or(tail.len());
        if len > 0 && tail[len..].starts_with(".sh") {
            return Some(&tail[..len]);
        }
        rest = &rest[at + 1..];
    }
    None
}

/// `dropUnregisteredCoreHooks`.
fn drop_unregistered_core_hooks(settings: &mut JsObject, registered: &[&str]) {
    let Some(JsValue::Object(hooks)) = settings.get("hooks").cloned() else {
        return;
    };
    let mut kept = JsObject::new();
    for (event, entries) in hooks.ordered() {
        let JsValue::Array(entries) = entries else {
            kept.insert(event.clone(), entries.clone());
            continue;
        };
        let mut groups = Vec::new();
        for entry in entries {
            let JsValue::Object(bucket) = entry else {
                groups.push(entry.clone());
                continue;
            };
            let Some(JsValue::Array(inner)) = bucket.get("hooks") else {
                groups.push(entry.clone());
                continue;
            };
            let live: Vec<JsValue> = inner
                .iter()
                .filter(|h| {
                    let command = match get(h, "command") {
                        Some(JsValue::String(c)) => c.to_rust(),
                        _ => None,
                    };
                    command
                        .as_deref()
                        .and_then(core_hook_id)
                        .is_none_or(|id| registered.contains(&id))
                })
                .cloned()
                .collect();
            if !live.is_empty() {
                let mut copy = bucket.clone();
                copy.insert("hooks", JsValue::Array(live));
                groups.push(JsValue::Object(copy));
            }
        }
        if !groups.is_empty() {
            kept.insert(event.clone(), JsValue::Array(groups));
        }
    }
    settings.insert("hooks", JsValue::Object(kept));
}

/// `coalesceHookMatchers`: one bucket per event and matcher, hooks deduped, passthrough last.
fn coalesce_hook_matchers(settings: &mut JsObject) {
    let Some(JsValue::Object(hooks)) = settings.get("hooks").cloned() else {
        return;
    };
    let mut out = JsObject::new();
    for (event, entries) in hooks.ordered() {
        let JsValue::Array(entries) = entries else {
            out.insert(event.clone(), entries.clone());
            continue;
        };
        // (matcher, hooks); `None` is an absent matcher.
        let mut buckets: Vec<(Option<JsValue>, Vec<JsValue>)> = Vec::new();
        let mut passthrough = Vec::new();
        for entry in entries {
            let inner = match entry {
                JsValue::Object(bucket) => match bucket.get("hooks") {
                    Some(JsValue::Array(inner)) => Some((bucket.get("matcher"), inner)),
                    _ => None,
                },
                _ => None,
            };
            let Some((matcher, inner)) = inner else {
                passthrough.push(entry.clone());
                continue;
            };
            let matcher = matcher
                .filter(|m| !matches!(m, JsValue::Undefined))
                .cloned();
            if let Some((_, existing)) = buckets.iter_mut().find(|(m, _)| *m == matcher) {
                // `seen` is taken once, before this entry's hooks: duplicates inside it survive.
                let seen: Vec<String> = existing.iter().map(key).collect();
                for h in inner {
                    if !seen.contains(&key(h)) {
                        existing.push(h.clone());
                    }
                }
            } else {
                buckets.push((matcher, inner.clone()));
            }
        }
        let mut list: Vec<JsValue> = buckets
            .into_iter()
            .map(|(matcher, hooks)| {
                let mut bucket = JsObject::new();
                if let Some(matcher) = matcher {
                    bucket.insert("matcher", matcher);
                }
                bucket.insert("hooks", JsValue::Array(hooks));
                JsValue::Object(bucket)
            })
            .collect();
        list.extend(passthrough);
        out.insert(event.clone(), JsValue::Array(list));
    }
    settings.insert("hooks", JsValue::Object(out));
}

/// `PLAIN_HOOK_COMMAND_RE`: `bash "$CLAUDE_PROJECT_DIR/<path>"` with optional ` <args>`.
fn plain_hook_command(command: &str) -> Option<(&str, Option<&str>)> {
    let rest = command.strip_prefix("bash \"$CLAUDE_PROJECT_DIR/")?;
    let end = rest.find('"')?;
    let path = &rest[..end];
    if path.is_empty() || path.contains('\n') {
        return None;
    }
    match &rest[end + 1..] {
        "" => Some((path, None)),
        tail => {
            let args = tail.strip_prefix(' ')?;
            (!args.is_empty() && !args.contains('\n')).then_some((path, Some(args)))
        }
    }
}

/// A hook bucket: its matcher (absent or a string) and its hooks.
type Bucket = (Option<String>, Vec<JsValue>);

/// `pluginHooksToClaudeShape`.
fn plugin_hooks_to_claude_shape(entries: &[JsValue]) -> Result<JsValue, SettingsDelegate> {
    let mut grouped: Vec<(String, Vec<Bucket>)> = Vec::new();
    for entry in entries {
        let event = text(get(entry, "event")).ok_or(SettingsDelegate)?;
        let command = text(get(entry, "command")).ok_or(SettingsDelegate)?;
        let matcher = text(get(entry, "matcher"));
        let command = match plain_hook_command(&command) {
            Some((path, args)) => claude_hook_command(&event, path, args, None),
            None => command,
        };
        let mut inner = vec![
            ("type", JsValue::string("command")),
            ("command", JsValue::string(&command)),
        ];
        if let Some(timeout) = get(entry, "timeout").filter(|v| !matches!(v, JsValue::Undefined)) {
            inner.push(("timeout", timeout.clone()));
        }
        if let Some(status) =
            get(entry, "statusMessage").filter(|v| !matches!(v, JsValue::Undefined))
        {
            inner.push(("statusMessage", status.clone()));
        }
        let slot = match grouped.iter().position(|(e, _)| *e == event) {
            Some(at) => at,
            None => {
                grouped.push((event, Vec::new()));
                grouped.len() - 1
            }
        };
        let buckets = &mut grouped[slot].1;
        match buckets.iter_mut().find(|(m, _)| *m == matcher) {
            Some((_, hooks)) => hooks.push(object(inner)),
            None => buckets.push((matcher, vec![object(inner)])),
        }
    }
    let mut out = JsObject::new();
    for (event, buckets) in grouped {
        let list = buckets
            .into_iter()
            .map(|(matcher, hooks)| {
                let mut bucket = JsObject::new();
                if let Some(matcher) = matcher {
                    bucket.insert("matcher", JsValue::string(&matcher));
                }
                bucket.insert("hooks", JsValue::Array(hooks));
                JsValue::Object(bucket)
            })
            .collect();
        out.insert(event, JsValue::Array(list));
    }
    Ok(JsValue::Object(out))
}

const SESSION_SOURCES: &str = "startup|resume|clear|compact|fork";

/// `buildClaudeSettings(config, { plan, plugins })`.
///
/// # Errors
/// [`SettingsDelegate`] where the TS throws or the shape is not modeled.
pub fn build_claude_settings(
    config: &JsValue,
    plan: &HarnessPlan,
    plugins: &[LoadedPlugin],
) -> Result<JsValue, SettingsDelegate> {
    let mut s = settings_base(config)?;
    if let Some(effort) = text(get(config, "effort").and_then(|e| get(e, "orchestrator")))
        .filter(|e| !e.is_empty() && e != "max")
    {
        merge_into(
            &mut s,
            object(vec![("effortLevel", JsValue::string(&effort))]),
        );
    }
    let pre = "PreToolUse";
    merge_into(
        &mut s,
        registration(
            pre,
            Some("Bash"),
            vec![hook(
                pre,
                "guard-destructive",
                None,
                10.0,
                "navori: guard-destructive",
            )],
        ),
    );
    merge_into(
        &mut s,
        registration(
            pre,
            Some("Bash|Monitor"),
            vec![hook(
                pre,
                "subagent-no-background",
                None,
                10.0,
                "navori: subagent-no-background",
            )],
        ),
    );
    if flag(config, "harness", "scribeOwnsMarkdown") {
        merge_into(
            &mut s,
            registration(
                pre,
                Some("Bash|Edit|Write|NotebookEdit"),
                vec![hook(
                    pre,
                    "implementer-no-markdown",
                    None,
                    10.0,
                    "navori: implementer-no-markdown",
                )],
            ),
        );
    }
    if flag(config, "harness", "planTiers") {
        merge_into(
            &mut s,
            registration(
                pre,
                Some("Agent"),
                vec![hook(pre, "plan-gate", None, 10.0, "navori: plan-gate")],
            ),
        );
    }
    let advisor = |event: &str, args: &str| {
        JsValue::Array(vec![object(vec![(
            "hooks",
            JsValue::Array(vec![hook(
                event,
                "model-advisor",
                Some(args),
                10.0,
                "navori: model advisor",
            )]),
        )])])
    };
    merge_into(
        &mut s,
        object(vec![(
            "hooks",
            object(vec![
                (
                    "SessionStart",
                    advisor("SessionStart", "claude-session-start"),
                ),
                (
                    "PostModelSwitch",
                    advisor("PostModelSwitch", "claude-post-model-switch"),
                ),
                ("Stop", advisor("Stop", "claude-stop")),
            ]),
        )]),
    );
    if flag(config, "harness", "masterPlan") {
        let session = registration(
            "SessionStart",
            Some(SESSION_SOURCES),
            vec![hook(
                "SessionStart",
                "master-plan-context",
                None,
                10.0,
                "navori: master-plan context",
            )],
        );
        let accept = registration(
            pre,
            Some("Bash"),
            vec![hook(
                pre,
                "master-accept-confirm",
                None,
                10.0,
                "navori: master acceptance confirmation",
            )],
        );
        let (Some(JsValue::Object(a)), Some(JsValue::Object(b))) =
            (get(&session, "hooks"), get(&accept, "hooks"))
        else {
            return Err(SettingsDelegate);
        };
        let mut both = a.clone();
        for (key, value) in b.entries() {
            both.insert(key.clone(), value.clone());
        }
        merge_into(&mut s, object(vec![("hooks", JsValue::Object(both))]));
    }
    merge_into(
        &mut s,
        registration(
            pre,
            Some("Bash"),
            vec![hook(
                pre,
                "comment-draft-confirm",
                None,
                10.0,
                "navori: comment-draft-confirm",
            )],
        ),
    );
    if get(config, "harness").and_then(|h| get(h, "publisher")) != Some(&JsValue::Bool(false)) {
        merge_into(
            &mut s,
            registration(
                pre,
                Some("Bash"),
                vec![hook(
                    pre,
                    "pr-publisher-confirm",
                    None,
                    10.0,
                    "navori: pr-publisher-confirm",
                )],
            ),
        );
    }
    if is_agent_enabled(config, "scout") {
        merge_into(
            &mut s,
            registration(
                pre,
                Some("Agent"),
                vec![hook(
                    pre,
                    "general-purpose-confirm",
                    None,
                    10.0,
                    "navori: general-purpose-confirm",
                )],
            ),
        );
    }
    if text(get(config, "audit").and_then(|a| get(a, "mode"))).as_deref() == Some("always") {
        let env = [
            ("CLAUDE_CODE_ENABLE_TELEMETRY", "1"),
            ("OTEL_LOGS_EXPORTER", "otlp"),
            ("OTEL_METRICS_EXPORTER", "none"),
            ("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "http/json"),
            (
                "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
                "http://127.0.0.1:4318/v1/logs",
            ),
            ("OTEL_LOGS_EXPORT_INTERVAL", "1000"),
        ];
        merge_into(
            &mut s,
            object(vec![(
                "env",
                object(env.iter().map(|(k, v)| (*k, JsValue::string(v))).collect()),
            )]),
        );
    }
    let post = "PostToolUse";
    merge_into(
        &mut s,
        registration(
            post,
            Some("Bash|Edit|Write|NotebookEdit"),
            vec![hook(
                post,
                "managed-drift-watch",
                None,
                10.0,
                "navori: managed-block drift",
            )],
        ),
    );
    merge_into(
        &mut s,
        registration(
            "PostToolUseFailure",
            Some("Bash"),
            vec![hook(
                "PostToolUseFailure",
                "bash-outcome-watch",
                None,
                10.0,
                "navori: repeat failure advice",
            )],
        ),
    );
    merge_into(
        &mut s,
        registration(
            post,
            Some("Bash|Edit|Write|NotebookEdit|Agent|Task"),
            vec![hook(
                post,
                "routing-watch",
                Some("claude-post-tool-use"),
                30.0,
                "navori: routing check",
            )],
        ),
    );
    if flag(config, "qualityGate", "fast") {
        merge_into(
            &mut s,
            registration(
                pre,
                Some("Bash"),
                vec![object(vec![
                    ("type", JsValue::string("command")),
                    (
                        "command",
                        JsValue::string(&claude_hook_command(
                            pre,
                            ".claude/hooks/quality-gate-pre-commit.sh",
                            None,
                            None,
                        )),
                    ),
                    ("timeout", JsValue::Number(600.0)),
                    (
                        "statusMessage",
                        JsValue::string("navori: quality-gate fast"),
                    ),
                ])],
            ),
        );
    }
    merge_into(
        &mut s,
        registration(
            "SessionStart",
            Some(SESSION_SOURCES),
            vec![hook(
                "SessionStart",
                "session-start-context",
                None,
                15.0,
                "navori: session context",
            )],
        ),
    );
    merge_into(
        &mut s,
        object(vec![(
            "hooks",
            object(vec![
                (
                    "UserPromptSubmit",
                    JsValue::Array(vec![object(vec![(
                        "hooks",
                        JsValue::Array(vec![hook(
                            "UserPromptSubmit",
                            "audit-mode-trigger",
                            None,
                            10.0,
                            "navori: audit-mode",
                        )]),
                    )])]),
                ),
                (
                    "SessionEnd",
                    JsValue::Array(vec![object(vec![(
                        "hooks",
                        JsValue::Array(vec![
                            hook(
                                "SessionEnd",
                                "audit-mode-close",
                                None,
                                10.0,
                                "navori: audit-mode close",
                            ),
                            hook(
                                "SessionEnd",
                                "worktree-reclaim",
                                None,
                                30.0,
                                "navori: reclaim worktrees",
                            ),
                        ]),
                    )])]),
                ),
            ]),
        )]),
    );
    merge_into(
        &mut s,
        registration(
            post,
            Some("Agent|Task"),
            vec![hook(
                post,
                "subagent-stop-handoff",
                None,
                15.0,
                "navori: handoff check",
            )],
        ),
    );
    if flag(config, "hooks", "verifyOnStop") {
        merge_into(
            &mut s,
            registration(
                "Stop",
                None,
                vec![hook(
                    "Stop",
                    "stop-verify-reminder",
                    None,
                    15.0,
                    "navori: verify-before-done",
                )],
            ),
        );
    }
    let registered: Vec<&str> = plan.hooks.iter().map(|h| h.id.as_str()).collect();
    drop_unregistered_core_hooks(&mut s, &registered);

    for plugin in plugins {
        if let Some(fragment) = fragment(plugin) {
            s = deep_merge(&s, fragment);
        }
        if let Some(JsValue::Array(hooks)) = get(&plugin.manifest, "hooks")
            && !hooks.is_empty()
        {
            merge_into(
                &mut s,
                object(vec![("hooks", plugin_hooks_to_claude_shape(hooks)?)]),
            );
        }
    }
    let rules = collect_shell_permission_rules(config, plugins)?;
    merge_into(
        &mut s,
        object(vec![(
            "permissions",
            object(vec![
                ("allow", JsValue::Array(rules.allow)),
                ("ask", JsValue::Array(rules.ask)),
                ("deny", JsValue::Array(rules.deny)),
            ]),
        )]),
    );
    coalesce_hook_matchers(&mut s);
    Ok(JsValue::Object(s))
}
