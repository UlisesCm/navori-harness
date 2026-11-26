//! model-advisor.sh (spec 0059 T16): the four lifecycle modes end to end.
//!
//! The decision is the script's shell guards plus its `node` block, ported over [`Host`]. The
//! scratchpad writes (the state file and the sentinels) come after every read and print nothing,
//! so a shadow host skips them and the whole decision is compared. `codex-pretool-profile` and
//! any unknown mode defer before stdin (D31).

use std::ffi::OsString;
use std::sync::LazyLock;

use navori_core::js_json::{self, JsObject, JsValue};
use navori_core::posix::normalize;

use crate::runner::{AuditLabel, Evaluation, Failure, Verdict};
use crate::shell::capture::{self, CaptureContext};

/// `navori_audit_phase` for the mode in `$1`, or `None` when the call must defer to the shell
/// before stdin: `codex-pretool-profile` runs `navori codex profile hook`, which this phase does
/// not port (D31), and an unknown mode is never guessed.
#[must_use]
pub fn phase(args: &[OsString]) -> Option<&'static str> {
    let [mode] = args else {
        return None;
    };
    match mode.to_str()? {
        "claude-session-start" | "codex-session-start" => Some("SessionStart"),
        "claude-post-model-switch" => Some("PostModelSwitch"),
        "claude-stop" => Some("Stop"),
        _ => None,
    }
}

const STATE: &str = "navori-model-advisor.json";
const SKIP: &str = "navori-model-advisor.skip";
const GATED: &str = "navori-model-advisor.effort-gated";
/// Payloads past this size may not fit an environment variable; Bash's `E2BIG` is not modeled.
const ENV_LIMIT: usize = 256 * 1024;

/// Host facts and the scratchpad writes.
pub trait Host {
    /// `[ -f path ]`.
    fn is_file(&self, path: &str) -> bool;
    /// `fs.readFileSync(path, "utf8")`, `None` when it throws.
    fn read(&self, path: &str) -> Option<Vec<u8>>;
    /// `mkdirSync(dir, { recursive: true })` then `writeFileSync(path, content)`.
    ///
    /// # Errors
    /// A write Node would throw on (its stack trace is not modeled).
    fn write_state(&self, dir: &str, path: &str, content: &str) -> Result<(), Failure>;
    /// `writeSentinel(name)`: remove the other sentinels, then create `name` empty.
    ///
    /// # Errors
    /// As [`Host::write_state`].
    fn sentinel(&self, dir: &str, name: Option<&str>) -> Result<(), Failure>;
}

/// Everything fixed before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// Bash 5 NUL warning of the script's own capture.
    pub capture: CaptureContext<'a>,
    /// `$1`.
    pub mode: String,
    /// `CLAUDE_EFFORT`, `None` when unset or empty.
    pub effort: Option<String>,
}

/// `JSON.parse`: `Ok(None)` for text it rejects.
fn json(text: &str) -> Result<Option<JsValue>, Failure> {
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        let lower = text.to_ascii_lowercase();
        if [
            "\\ud8", "\\ud9", "\\uda", "\\udb", "\\udc", "\\udd", "\\ude", "\\udf",
        ]
        .iter()
        .any(|escape| lower.contains(escape))
        {
            return Err(Failure("JSON with a surrogate escape".to_owned()));
        }
        return Ok(None);
    }
    js_json::parse(text)
        .map(Some)
        .ok_or_else(|| Failure("JSON outside the modeled shape".to_owned()))
}

fn member<'v>(value: &'v JsValue, key: &str) -> Option<&'v JsValue> {
    match value {
        JsValue::Object(o) => o.get(key),
        _ => None,
    }
}

fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null | JsValue::Bool(false)) => false,
        Some(JsValue::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(JsValue::String(s)) => !s.units().is_empty(),
        Some(_) => true,
    }
}

fn string(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(s) => Some(String::from_utf16_lossy(s.units())),
        _ => None,
    }
}

/// `/opus/i` (no `u` flag: ASCII case folding).
fn opus(model: &str) -> bool {
    model.to_ascii_lowercase().contains("opus")
}

/// `path.join(dir, name)`.
fn join(dir: &str, name: &str) -> String {
    normalize(&format!("{dir}/{name}"))
}

fn notice(message: &str) -> Vec<u8> {
    let mut object = JsObject::new();
    object.insert("systemMessage", JsValue::string(message));
    let mut out = JsValue::Object(object).stringify(None).unwrap_or_default();
    out.push('\n');
    out.into_bytes()
}

fn claude_message(model: &str) -> String {
    format!(
        "### Modelo recomendado disponible\nEstás usando `{model}`. Para la mayoría de features, bugs y tickets, `opus/medium` es suficiente para desarrollar una solución sólida.\n\nNavori no depende sólo del modelo principal: enruta el trabajo al agente adecuado, separa implementación y revisión, y valida la calidad antes de cerrar. Usar `medium` en el trabajo cotidiano mejora la eficiencia de tokens y reserva mayor effort para problemas excepcionalmente complejos o críticos.\n\nPara cambiarlo, abre el selector nativo con `/model` y elige `opus/medium`. "
    )
}

const CODEX_MESSAGE: &str = "### Modelo recomendado disponible\nEstás usando `gpt-6-astra`. Para la mayoría de features, bugs y tickets, `gpt-5.6-sol/medium` ofrece capacidad suficiente para una solución sólida.\n\nNavori coordina agentes especializados, separa implementación y revisión, y valida la calidad antes de cerrar. Elegir `medium` para el trabajo cotidiano mejora la eficiencia de tokens y deja effort alto disponible para los problemas que realmente lo necesitan.\n\nPara cambiarlo, abre el selector nativo con `/model` y elige `gpt-5.6-sol/medium`.";

/// `readState()`: the state object when `model` is a string and `notified` a boolean.
fn read_state(host: &dyn Host, path: &str) -> Result<Option<JsObject>, Failure> {
    let Some(bytes) = host.read(path) else {
        return Ok(None);
    };
    // `state.model` on `null` throws inside the `try`: also `null`.
    let Some(JsValue::Object(state)) = json(&String::from_utf8_lossy(&bytes))? else {
        return Ok(None);
    };
    let valid = matches!(state.get("model"), Some(JsValue::String(_)))
        && matches!(state.get("notified"), Some(JsValue::Bool(_)));
    Ok(valid.then_some(state))
}

/// `sentinelFor(model, notified)`.
fn sentinel_for(model: &str, notified: bool) -> Option<&'static str> {
    if notified {
        return Some(SKIP);
    }
    if model == "claude-fable-5" {
        return None;
    }
    Some(if opus(model) { GATED } else { SKIP })
}

/// The `node` block, from `PAYLOAD` and `MODE`.
fn node(context: &Context<'_>, payload: &str, host: &dyn Host) -> Result<Vec<u8>, Failure> {
    let text = if payload.is_empty() { "{}" } else { payload };
    let Some(payload) = json(text)? else {
        return Ok(Vec::new());
    };
    if matches!(payload, JsValue::Null) {
        return Err(Failure("node throws on a null payload".to_owned()));
    }
    if truthy(member(&payload, "agent_id")) || truthy(member(&payload, "agent_type")) {
        return Ok(Vec::new());
    }
    let mode = context.mode.as_str();
    if mode == "codex-session-start" {
        let astra =
            matches!(member(&payload, "model"), Some(JsValue::String(s)) if s.is("gpt-6-astra"));
        return Ok(if astra {
            notice(CODEX_MESSAGE)
        } else {
            Vec::new()
        });
    }
    let Some(dir) = string(member(&payload, "scratchpad_dir")).filter(|d| !d.is_empty()) else {
        return Ok(Vec::new());
    };
    let state_path = join(&dir, STATE);
    if mode == "claude-session-start" || mode == "claude-post-model-switch" {
        let key = if mode == "claude-session-start" {
            "model"
        } else {
            "to_model"
        };
        let Some(model) = string(member(&payload, key)).filter(|m| !m.is_empty()) else {
            return Ok(Vec::new());
        };
        let notified = mode == "claude-post-model-switch"
            && read_state(host, &state_path)?
                .is_some_and(|s| matches!(s.get("notified"), Some(JsValue::Bool(true))));
        let mut state = JsObject::new();
        state.insert("model", JsValue::string(&model));
        state.insert("notified", JsValue::Bool(notified));
        let body = JsValue::Object(state).stringify(None).unwrap_or_default();
        host.write_state(&dir, &state_path, &body)?;
        host.sentinel(&dir, sentinel_for(&model, notified))?;
        return Ok(Vec::new());
    }
    if mode != "claude-stop" {
        return Ok(Vec::new());
    }
    let Some(mut state) = read_state(host, &state_path)? else {
        return Ok(Vec::new());
    };
    if matches!(state.get("notified"), Some(JsValue::Bool(true))) {
        return Ok(Vec::new());
    }
    let effort_field = member(&payload, "effort");
    let effort = if truthy(effort_field) {
        string(effort_field.and_then(|e| member(e, "level")))
    } else {
        None
    }
    .or_else(|| context.effort.clone());
    let model = string(state.get("model")).unwrap_or_default();
    let fable = model == "claude-fable-5";
    let high_opus = opus(&model)
        && effort
            .as_deref()
            .is_some_and(|e| matches!(e, "high" | "xhigh" | "max"));
    if !fable && !high_opus {
        return Ok(Vec::new());
    }
    state.insert("notified", JsValue::Bool(true));
    let body = JsValue::Object(state).stringify(None).unwrap_or_default();
    host.write_state(&dir, &state_path, &body)?;
    host.sentinel(&dir, Some(SKIP))?;
    let shown = if fable {
        model
    } else {
        format!("{model}/{}", effort.unwrap_or_default())
    };
    Ok(notice(&claude_message(&shown)))
}

/// The `claude-stop` shell guard: `true` when it exits before `node`.
fn stop_guard(context: &Context<'_>, payload: &[u8], host: &dyn Host) -> bool {
    static KEY: LazyLock<&[u8]> = LazyLock::new(|| b"\"scratchpad_dir\":\"");
    let Some(at) = payload.windows(KEY.len()).position(|w| w == *KEY) else {
        return false;
    };
    let rest = &payload[at + KEY.len()..];
    let end = rest.iter().position(|b| *b == b'"').unwrap_or(rest.len());
    let dir = String::from_utf8_lossy(&rest[..end]).into_owned();
    if dir.is_empty() {
        return false;
    }
    if host.is_file(&format!("{dir}/{SKIP}")) {
        return true;
    }
    host.is_file(&format!("{dir}/{GATED}"))
        && !matches!(
            context.effort.as_deref(),
            None | Some("high" | "xhigh" | "max")
        )
}

/// Evaluate one payload of a ported mode.
///
/// # Errors
/// A branch whose Node failure (a stack trace) the port does not reproduce.
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    host: &dyn Host,
) -> Result<Evaluation, Failure> {
    let captured = crate::shell::payload::capture(payload);
    let stderr = capture::prepend(context.capture, payload.contains(&0), 0, Vec::new());
    let done = |stdout: Vec<u8>| Evaluation {
        verdict: Verdict::Permit,
        stdout,
        stderr: stderr.clone(),
        audit: Some(AuditLabel {
            verdict: "skip",
            reason: String::new(),
        }),
    };
    let has = |needle: &[u8]| captured.windows(needle.len()).any(|w| w == needle);
    if has(b"\"agent_id\"") || has(b"\"agent_type\"") {
        return Ok(done(Vec::new()));
    }
    if context.mode == "claude-stop" && stop_guard(context, &captured, host) {
        return Ok(done(Vec::new()));
    }
    if captured.len() > ENV_LIMIT {
        return Err(Failure(
            "payload too large for an environment variable".to_owned(),
        ));
    }
    let text = String::from_utf8_lossy(&captured);
    Ok(done(node(context, &text, host)?))
}
