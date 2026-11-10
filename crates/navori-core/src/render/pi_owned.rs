//! Pi's whole-file resources and their ownership validators (`engines/pi/owned-file.ts`, spec
//! 0059 T20, D38): the extension source, each role agent and the manifest, each carrying a digest
//! a hand edit breaks. `ownsPiSource` also parses the TypeScript with Node, as the TS does.

use std::io::Write as _;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest as _, Sha256};

use crate::content_identity::hex;
use crate::js_json::{self, JsObject, JsValue};

const OWNER_ID: &str = "pi-runtime";

/// `PI_MANIFEST_SCHEMA`.
pub const PI_MANIFEST_SCHEMA: f64 = 2.0;

/// `PiManifestHook`.
#[derive(Debug, Clone, PartialEq)]
pub struct PiManifestHook {
    /// Script id.
    pub script: String,
    /// Its `.pi/navori/**` path.
    pub path: String,
    /// Event.
    pub on: String,
    /// Tools it filters on.
    pub tools: Option<Vec<String>>,
    /// `parent`, `child` or `all`.
    pub scope: String,
    /// `enforced`, `advisory` or `lifecycle`.
    pub class: String,
    /// Asks the user.
    pub interactive: bool,
    /// Deadline.
    pub timeout_ms: f64,
    /// `skipOnError`.
    pub skip_on_error: bool,
}

/// `controls`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PiControls {
    /// `planTiers`.
    pub plan_tiers: bool,
    /// `masterPlan`.
    pub master_plan: bool,
    /// `scribeOwnsMarkdown`.
    pub scribe_owns_markdown: bool,
    /// `auditMode: "always"`.
    pub audit_always: bool,
    /// `sessionState: false` (#1579): emitted only when `harness.sessionState` is false.
    pub session_state_off: bool,
}

/// `PiManifestPayload` (v1 has no hooks, owned paths or rules).
#[derive(Debug, Clone, PartialEq)]
pub struct PiManifest {
    /// 1 or 2.
    pub schema_version: u8,
    /// Role ids.
    pub agents: Vec<String>,
    /// Controls.
    pub controls: Option<PiControls>,
    /// v2 hooks.
    pub hooks: Vec<PiManifestHook>,
    /// v2 owned paths.
    pub owned_paths: Vec<String>,
    /// v2 `permissionRules.ask`.
    pub ask: Vec<String>,
    /// v2 `permissionRules.deny`.
    pub deny: Vec<String>,
}

fn digest(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

fn json_string(value: &str) -> String {
    JsValue::string(value).stringify(None).unwrap_or_default()
}

fn strings(items: &[String]) -> JsValue {
    JsValue::Array(items.iter().map(|s| JsValue::string(s)).collect())
}

/// `Array.prototype.sort()` of strings: UTF-16 code units.
fn js_sorted(items: &[String]) -> Vec<String> {
    let mut sorted = items.to_vec();
    sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    sorted
}

/// `serializePiSource`.
#[must_use]
pub fn serialize_pi_source(source: &str) -> String {
    let body = format!("{}\n", crate::posix::js_trim(source));
    format!(
        "// navori:managed-file id=\"pi-extension\" hash=\"{}\"\n{body}",
        digest(&body)
    )
}

/// `stripTypeScriptTypes` in a Node child, with the TS limits (1 MiB, 5 s); false without Node.
fn node_parses_typescript(content: &str) -> bool {
    if content.len() > 1_048_576 {
        return false;
    }
    let Ok(mut child) = Command::new("node")
        .args([
            "--input-type=commonjs",
            "--eval",
            "require(\"node:module\").stripTypeScriptTypes(require(\"node:fs\").readFileSync(0, \"utf8\"));",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take()
        && stdin.write_all(content.as_bytes()).is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// `ownsPiSource`: the header's digest matches and the payload parses as TypeScript.
#[must_use]
pub fn owns_pi_source(content: &str) -> bool {
    let Some(rest) = content.strip_prefix("// navori:managed-file id=\"pi-extension\" hash=\"")
    else {
        return false;
    };
    let Some((hash, body)) = rest.split_once("\"\n") else {
        return false;
    };
    let hex_ok = hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    hex_ok && hash == digest(body) && node_parses_typescript(content)
}

/// `serializePiAgent`.
#[must_use]
pub fn serialize_pi_agent(
    name: &str,
    description: &str,
    model: Option<&str>,
    tools: &[String],
    instructions: &str,
) -> String {
    let mut fields = vec![
        format!("name: {}", json_string(name)),
        format!("description: {}", json_string(description)),
    ];
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        fields.push(format!("model: {}", json_string(model)));
    }
    fields.push(format!(
        "tools: {}",
        strings(tools).stringify(None).unwrap_or_default()
    ));
    let body = format!(
        "{}\n---\n{}\n",
        fields.join("\n"),
        crate::posix::js_trim(instructions)
    );
    format!(
        "---\n# navori:managed-file id=\"pi-agent-{name}\" hash=\"{}\"\n{body}",
        digest(&body)
    )
}

/// `ownsPiAgent`: a valid header for `name`, the four fields as strict JSON, and the exact
/// serialization of what they say.
#[must_use]
pub fn owns_pi_agent(content: &str, name: &str) -> bool {
    let Some(rest) = content.strip_prefix("---\n# navori:managed-file id=\"pi-agent-") else {
        return false;
    };
    let Some((id, rest)) = rest.split_once("\" hash=\"") else {
        return false;
    };
    let Some((hash, body)) = rest.split_once("\"\n") else {
        return false;
    };
    let id_ok = !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    let hex_ok = hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !id_ok || !hex_ok || id != name || hash != digest(body) {
        return false;
    }
    let Some(separator) = body.find("\n---\n") else {
        return false;
    };
    let mut fields: Vec<(&str, JsValue)> = Vec::new();
    for line in body[..separator].split('\n') {
        let Some((key, value)) = line.split_once(": ") else {
            return false;
        };
        // `/^(name|description|model|tools): (.+)$/`: JS `.` stops at every line terminator.
        if !matches!(key, "name" | "description" | "model" | "tools")
            || value.is_empty()
            || value.contains(['\r', '\u{2028}', '\u{2029}'])
            || fields.iter().any(|(k, _)| *k == key)
        {
            return false;
        }
        let Some(parsed) = js_json::parse(value) else {
            return false;
        };
        fields.push((key, parsed));
    }
    let field = |key: &str| fields.iter().find(|(k, _)| *k == key).map(|(_, v)| v);
    let as_text = |value: Option<&JsValue>| match value {
        Some(JsValue::String(s)) => s.to_rust(),
        _ => None,
    };
    if as_text(field("name")).as_deref() != Some(name) {
        return false;
    }
    let Some(description) = as_text(field("description")) else {
        return false;
    };
    let model = match field("model") {
        None => None,
        Some(JsValue::String(s)) => match s.to_rust() {
            Some(model) => Some(model),
            None => return false,
        },
        Some(_) => return false,
    };
    let Some(JsValue::Array(items)) = field("tools") else {
        return false;
    };
    let Some(tools) = items
        .iter()
        .map(|t| as_text(Some(t)))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let instructions = &body[separator + "\n---\n".len()..];
    content == serialize_pi_agent(name, &description, model.as_deref(), &tools, instructions)
}

fn hook_json(hook: &PiManifestHook) -> JsValue {
    let mut out = JsObject::new();
    out.insert("script", JsValue::string(&hook.script));
    out.insert("path", JsValue::string(&hook.path));
    out.insert("on", JsValue::string(&hook.on));
    if let Some(tools) = &hook.tools {
        out.insert("tools", strings(tools));
    }
    out.insert("scope", JsValue::string(&hook.scope));
    out.insert("class", JsValue::string(&hook.class));
    out.insert("interactive", JsValue::Bool(hook.interactive));
    out.insert("timeoutMs", JsValue::Number(hook.timeout_ms));
    if hook.skip_on_error {
        out.insert("skipOnError", JsValue::Bool(true));
    }
    JsValue::Object(out)
}

/// The keys of `canonicalPayload`, in order.
fn canonical_object(payload: &PiManifest) -> JsObject {
    let mut out = JsObject::new();
    out.insert(
        "schemaVersion",
        JsValue::Number(f64::from(payload.schema_version)),
    );
    out.insert("agents", strings(&js_sorted(&payload.agents)));
    if let Some(controls) = payload.controls {
        let mut c = JsObject::new();
        c.insert("planTiers", JsValue::Bool(controls.plan_tiers));
        c.insert("masterPlan", JsValue::Bool(controls.master_plan));
        c.insert(
            "scribeOwnsMarkdown",
            JsValue::Bool(controls.scribe_owns_markdown),
        );
        if controls.audit_always {
            c.insert("auditMode", JsValue::string("always"));
        }
        if controls.session_state_off {
            c.insert("sessionState", JsValue::Bool(false));
        }
        out.insert("controls", JsValue::Object(c));
    }
    if payload.schema_version == 2 {
        out.insert(
            "hooks",
            JsValue::Array(payload.hooks.iter().map(hook_json).collect()),
        );
        out.insert("ownedPaths", strings(&js_sorted(&payload.owned_paths)));
        let mut rules = JsObject::new();
        rules.insert("ask", strings(&payload.ask));
        rules.insert("deny", strings(&payload.deny));
        out.insert("permissionRules", JsValue::Object(rules));
    }
    out
}

/// `serializePiManifest`: strict JSON, `_navori` first, with the payload digest.
#[must_use]
pub fn serialize_pi_manifest(payload: &PiManifest) -> String {
    let canonical = JsValue::Object(canonical_object(payload));
    let text = canonical.stringify(None).unwrap_or_default();
    let mut meta = JsObject::new();
    meta.insert("id", JsValue::string(OWNER_ID));
    meta.insert("hash", JsValue::string(&digest(&text)));
    let mut out = JsObject::new();
    out.insert("_navori", JsValue::Object(meta));
    if let JsValue::Object(fields) = canonical {
        for (key, value) in fields.entries() {
            out.insert(key.clone(), value.clone());
        }
    }
    format!(
        "{}\n",
        JsValue::Object(out).stringify(Some(2)).unwrap_or_default()
    )
}

fn get<'a>(object: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    object.get(key)
}

fn sorted_keys(object: &JsObject, skip: &[&str]) -> Option<String> {
    let mut keys = object
        .entries()
        .iter()
        .map(|(k, _)| k.to_rust())
        .collect::<Option<Vec<_>>>()?;
    keys.retain(|k| !skip.contains(&k.as_str()));
    Some(js_sorted(&keys).join(","))
}

fn string_array(value: Option<&JsValue>) -> Option<Vec<String>> {
    match value? {
        JsValue::Array(items) => items
            .iter()
            .map(|i| match i {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

fn text(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

/// `isPiHookPath`.
fn is_pi_hook_path(script: &str, path: &str) -> bool {
    if path == format!(".pi/navori/hooks/{script}.sh") {
        return true;
    }
    path.strip_prefix(".pi/navori/scripts/")
        .is_some_and(|rest| {
            let mut bytes = rest.bytes();
            bytes
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
                && bytes
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-'))
        })
        && !path.contains("..")
}

/// `parseManifestHook`.
fn parse_manifest_hook(raw: &JsValue) -> Option<PiManifestHook> {
    let JsValue::Object(hook) = raw else {
        return None;
    };
    if sorted_keys(hook, &["tools", "skipOnError"])?
        != "class,interactive,on,path,scope,script,timeoutMs"
    {
        return None;
    }
    let skip_on_error = match get(hook, "skipOnError") {
        None => false,
        Some(JsValue::Bool(true)) => true,
        Some(_) => return None,
    };
    let script = text(get(hook, "script"))?;
    let script_ok = script
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && script
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let path = text(get(hook, "path"))?;
    let on = text(get(hook, "on"))?;
    let scope = text(get(hook, "scope"))?;
    let class = text(get(hook, "class"))?;
    let Some(JsValue::Bool(interactive)) = get(hook, "interactive") else {
        return None;
    };
    let Some(JsValue::Number(timeout_ms)) = get(hook, "timeoutMs") else {
        return None;
    };
    let safe = timeout_ms.fract() == 0.0 && timeout_ms.abs() <= 9_007_199_254_740_991.0;
    let tools = match get(hook, "tools") {
        None => None,
        value => Some(string_array(value)?),
    };
    let ok = script_ok
        && is_pi_hook_path(&script, &path)
        && matches!(
            on.as_str(),
            "tool_call" | "tool_result" | "agent_before_settle" | "session_shutdown"
        )
        && matches!(scope.as_str(), "parent" | "child" | "all")
        && matches!(class.as_str(), "enforced" | "advisory" | "lifecycle")
        && safe
        && *timeout_ms > 0.0;
    ok.then_some(PiManifestHook {
        script,
        path,
        on,
        tools,
        scope,
        class,
        interactive: *interactive,
        timeout_ms: *timeout_ms,
        skip_on_error,
    })
}

/// `piManifestSchemaVersion`: the schema of a manifest that carries Navori's owner id.
#[must_use]
pub fn pi_manifest_schema_version(content: &str) -> Option<f64> {
    let JsValue::Object(record) = js_json::parse(content)? else {
        return None;
    };
    let JsValue::Object(meta) = get(&record, "_navori")? else {
        return None;
    };
    if text(get(meta, "id")).as_deref() != Some(OWNER_ID) {
        return None;
    }
    match get(&record, "schemaVersion")? {
        JsValue::Number(n) => Some(*n),
        _ => None,
    }
}

/// `ownsPiManifest`: exact schema (v1 or v2), owner id and digest, and the exact serialization.
#[must_use]
pub fn owns_pi_manifest(content: &str) -> bool {
    parse_owned_manifest(content).is_some()
}

fn parse_owned_manifest(content: &str) -> Option<()> {
    let JsValue::Object(record) = js_json::parse(content)? else {
        return None;
    };
    let JsValue::Object(owner) = get(&record, "_navori")? else {
        return None;
    };
    if text(get(owner, "id")).as_deref() != Some(OWNER_ID) {
        return None;
    }
    let hash = text(get(owner, "hash"))?;
    let version = match get(&record, "schemaVersion")? {
        JsValue::Number(n) if *n == 1.0 => 1u8,
        JsValue::Number(n) if *n == 2.0 => 2u8,
        _ => return None,
    };
    let agents = string_array(get(&record, "agents"))?;
    let keys = sorted_keys(&record, &[])?;
    let base: &[&str] = if version == 1 {
        &["_navori", "agents"]
    } else {
        &[
            "_navori",
            "agents",
            "hooks",
            "ownedPaths",
            "permissionRules",
        ]
    };
    let allowed = |extra: &[&str]| {
        let list: Vec<String> = base.iter().chain(extra).map(|s| (*s).to_owned()).collect();
        js_sorted(&list).join(",")
    };
    if keys != allowed(&["schemaVersion"]) && keys != allowed(&["controls", "schemaVersion"]) {
        return None;
    }
    let controls = match get(&record, "controls") {
        None => None,
        Some(JsValue::Object(raw)) => {
            let keys = sorted_keys(raw, &[])?;
            if keys != "masterPlan,planTiers,scribeOwnsMarkdown"
                && keys != "auditMode,masterPlan,planTiers,scribeOwnsMarkdown"
                && keys != "masterPlan,planTiers,scribeOwnsMarkdown,sessionState"
                && keys != "auditMode,masterPlan,planTiers,scribeOwnsMarkdown,sessionState"
            {
                return None;
            }
            let audit_always = match get(raw, "auditMode") {
                None => false,
                Some(value) if text(Some(value)).as_deref() == Some("always") => true,
                Some(_) => return None,
            };
            let session_state_off = match get(raw, "sessionState") {
                None => false,
                Some(JsValue::Bool(false)) => true,
                Some(_) => return None,
            };
            let flag = |key: &str| match get(raw, key) {
                Some(JsValue::Bool(b)) => Some(*b),
                _ => None,
            };
            Some(PiControls {
                plan_tiers: flag("planTiers")?,
                master_plan: flag("masterPlan")?,
                scribe_owns_markdown: flag("scribeOwnsMarkdown")?,
                audit_always,
                session_state_off,
            })
        }
        Some(_) => return None,
    };
    let mut payload = PiManifest {
        schema_version: version,
        agents,
        controls,
        hooks: Vec::new(),
        owned_paths: Vec::new(),
        ask: Vec::new(),
        deny: Vec::new(),
    };
    if version == 2 {
        let JsValue::Array(hooks) = get(&record, "hooks")? else {
            return None;
        };
        payload.owned_paths = string_array(get(&record, "ownedPaths"))?;
        let JsValue::Object(rules) = get(&record, "permissionRules")? else {
            return None;
        };
        if sorted_keys(rules, &[])? != "ask,deny" {
            return None;
        }
        payload.ask = string_array(get(rules, "ask"))?;
        payload.deny = string_array(get(rules, "deny"))?;
        payload.hooks = hooks
            .iter()
            .map(parse_manifest_hook)
            .collect::<Option<Vec<_>>>()?;
    }
    let canonical = JsValue::Object(canonical_object(&payload))
        .stringify(None)
        .unwrap_or_default();
    (hash == digest(&canonical) && content == serialize_pi_manifest(&payload)).then_some(())
}
