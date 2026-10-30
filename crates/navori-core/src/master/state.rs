//! Legacy `<stage>/state.json` and `<stage>/parts.json` as `MasterStateSchema` and `PartsSchema`
//! (`lib/master/schema.ts`, zod 4) accept them.
//!
//! Only acceptance is modeled: anything the schema rejects is [`Invalid`], and the native
//! command hands the invocation to the TS, which throws with the exact issue text. Where zod
//! would strip a stray key that could look like a mistake (a second method block in a
//! criterion), this port rejects too: delegating is always safe.

use crate::js_json::{JsObject, JsValue};

/// The schema would reject the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid;

/// `MASTER_PHASES`, in order.
pub const MASTER_PHASES: [&str; 9] = [
    "context",
    "transcribed",
    "mapped",
    "planned",
    "questioned",
    "mastered",
    "ux",
    "executing",
    "closed",
];
const MASTER_MODES: [&str; 3] = ["template", "en-curso", "desde-cero"];
const UX_CHOICES: [&str; 3] = ["none", "md", "md-json"];
const OUTCOMES: [&str; 3] = ["entregada", "convertida", "abandonada"];
/// `PART_STATES`.
pub const PART_STATES: [&str; 5] = ["pendiente", "parcial", "hecho", "descartada", "diferida"];

/// `Number.MAX_SAFE_INTEGER`: zod 4 `.int()` is a safe integer.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A legacy `state.json` the schema accepts: the fields `readMasterStatus` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct MasterState {
    pub phase: &'static str,
    pub mode: Option<&'static str>,
    pub ux: Option<&'static str>,
    /// `outcome`: set once `master close` has started.
    pub outcome: Option<&'static str>,
    /// The phases of `history`, in order.
    pub history: Vec<&'static str>,
    /// `MasterStateSchema.parse(raw)` as zod returns it: schema key order, defaults filled in,
    /// unknown keys stripped. `advance` serializes this object after it moves the phase.
    pub normalized: JsValue,
}

/// `evidence` of a criterion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    None,
    Run,
    Approval,
}

/// An acceptance criterion: what status reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    pub id: String,
    pub description: String,
    pub method: &'static str,
    /// What `renderMasterParts` prints after the description: `file#case`, the command to run
    /// or the manual check.
    pub detail: String,
    pub evidence: Evidence,
}

/// A part the schema accepts: what status reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub scope: Vec<String>,
    pub out_of_scope: Vec<String>,
    pub depends_on: Vec<String>,
    pub seed_requirements: Vec<String>,
    pub acceptance: Vec<Criterion>,
    pub state: &'static str,
    pub reason: Option<String>,
    pub spec: Option<String>,
    pub issue: Option<f64>,
}

fn object(value: &JsValue) -> Result<&JsObject, Invalid> {
    match value {
        JsValue::Object(object) => Ok(object),
        _ => Err(Invalid),
    }
}

/// `undefined` (absent) for an optional or defaulted key.
fn absent(value: Option<&JsValue>) -> bool {
    matches!(value, None | Some(JsValue::Undefined))
}

fn text(value: Option<&JsValue>) -> Result<String, Invalid> {
    match value {
        Some(JsValue::String(s)) => s.to_rust().ok_or(Invalid),
        _ => Err(Invalid),
    }
}

/// `z.string().min(1)`.
fn non_empty(value: Option<&JsValue>) -> Result<String, Invalid> {
    text(value).and_then(|s| if s.is_empty() { Err(Invalid) } else { Ok(s) })
}

/// `z.enum(options)`.
fn one_of(value: Option<&JsValue>, options: &[&'static str]) -> Result<&'static str, Invalid> {
    let s = text(value)?;
    options.iter().copied().find(|o| *o == s).ok_or(Invalid)
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn date(value: Option<&JsValue>) -> Result<String, Invalid> {
    let s = text(value)?;
    let b = s.as_bytes();
    let ok = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    if ok { Ok(s) } else { Err(Invalid) }
}

/// `x.nullable()` (required key) or `x.nullable().default(null)` (`default_null`).
fn nullable<T>(
    value: Option<&JsValue>,
    default_null: bool,
    inner: impl FnOnce(Option<&JsValue>) -> Result<T, Invalid>,
) -> Result<Option<T>, Invalid> {
    match value {
        None | Some(JsValue::Undefined) if default_null => Ok(None),
        Some(JsValue::Null) => Ok(None),
        None | Some(JsValue::Undefined) => Err(Invalid),
        other => inner(other).map(Some),
    }
}

/// `z.number().int()` with `.nonnegative()` or `.positive()`.
fn integer(value: Option<&JsValue>, min: f64) -> Result<f64, Invalid> {
    match value {
        Some(JsValue::Number(n))
            if n.fract() == 0.0 && *n >= min && n.abs() <= MAX_SAFE_INTEGER =>
        {
            Ok(*n)
        }
        _ => Err(Invalid),
    }
}

/// `z.array(item).default([])`.
fn array_or_empty<T>(
    value: Option<&JsValue>,
    item: impl Fn(&JsValue) -> Result<T, Invalid>,
) -> Result<Vec<T>, Invalid> {
    match value {
        None | Some(JsValue::Undefined) => Ok(Vec::new()),
        Some(JsValue::Array(items)) => items.iter().map(item).collect(),
        _ => Err(Invalid),
    }
}

fn string_item(value: &JsValue) -> Result<String, Invalid> {
    text(Some(value))
}

/// `versionField`: exactly 1.
fn version_one(value: Option<&JsValue>) -> Result<(), Invalid> {
    match value {
        Some(JsValue::Number(n)) if *n == 1.0 => Ok(()),
        _ => Err(Invalid),
    }
}

/// `MasterStateSchema.parse(raw)` when it succeeds.
///
/// # Errors
/// [`Invalid`] wherever zod would throw.
pub fn master_state(raw: &JsValue) -> Result<MasterState, Invalid> {
    let o = object(raw)?;
    version_one(o.get("version"))?;
    let phase = one_of(o.get("phase"), &MASTER_PHASES)?;
    let mode = nullable(o.get("mode"), false, |v| one_of(v, &MASTER_MODES))?;
    // signal
    let signal = object(o.get("signal").ok_or(Invalid)?)?;
    nullable(signal.get("commits"), false, |v| integer(v, 0.0))?;
    nullable(signal.get("firstCommit"), false, date)?;
    nullable(signal.get("filesChangedSinceFirst"), false, |v| {
        integer(v, 0.0)
    })?;
    nullable(signal.get("framework"), false, text)?;
    let libraries = array_or_empty(signal.get("libraries"), |v| {
        string_item(v)?;
        Ok(v.clone())
    })?;
    one_of(signal.get("suggested"), &MASTER_MODES)?;
    let outcome = nullable(o.get("outcome"), true, |v| one_of(v, &OUTCOMES))?;
    let closed_at = if absent(o.get("closedAt")) {
        None
    } else {
        date(o.get("closedAt"))?;
        o.get("closedAt").cloned()
    };
    let abandonment = if absent(o.get("abandonment")) {
        None
    } else {
        let a = object(o.get("abandonment").ok_or(Invalid)?)?;
        non_empty(a.get("reason"))?;
        one_of(a.get("phase"), &MASTER_PHASES)?;
        Some(fields(a, &["reason", "phase"]))
    };
    let conversion = if absent(o.get("conversion")) {
        None
    } else {
        let c = object(o.get("conversion").ok_or(Invalid)?)?;
        non_empty(c.get("spec"))?;
        non_empty(c.get("reason"))?;
        Some(fields(c, &["spec", "reason"]))
    };
    let history_values = match o.get("history") {
        None | Some(JsValue::Undefined) => Vec::new(),
        Some(JsValue::Array(items)) => items.clone(),
        _ => return Err(Invalid),
    };
    let history = array_or_empty(o.get("history"), |entry| {
        let e = object(entry)?;
        let phase = one_of(e.get("phase"), &MASTER_PHASES)?;
        date(e.get("at"))?;
        Ok(phase)
    })?;
    let ux = if absent(o.get("ux")) {
        None
    } else {
        Some(one_of(o.get("ux"), &UX_CHOICES)?)
    };
    let converted = outcome == Some("convertida");
    let abandoned = outcome == Some("abandonada");
    if converted != conversion.is_some() || abandoned != abandonment.is_some() {
        return Err(Invalid);
    }
    // The schema's key order; `history` entries and the nested objects keep only their own keys.
    let mut normalized = JsObject::new();
    normalized.insert("version", JsValue::Number(1.0));
    normalized.insert("phase", JsValue::string(phase));
    normalized.insert("mode", mode.map_or(JsValue::Null, JsValue::string));
    normalized.insert(
        "signal",
        JsValue::Object(fields_with(
            signal,
            &[
                "commits",
                "firstCommit",
                "filesChangedSinceFirst",
                "framework",
            ],
            libraries,
        )),
    );
    normalized.insert("outcome", outcome.map_or(JsValue::Null, JsValue::string));
    if let Some(value) = closed_at {
        normalized.insert("closedAt", value);
    }
    if let Some(value) = abandonment {
        normalized.insert("abandonment", JsValue::Object(value));
    }
    if let Some(value) = conversion {
        normalized.insert("conversion", JsValue::Object(value));
    }
    normalized.insert(
        "history",
        JsValue::Array(
            history_values
                .iter()
                .map(|entry| match entry {
                    JsValue::Object(e) => JsValue::Object(fields(e, &["phase", "at"])),
                    other => other.clone(),
                })
                .collect(),
        ),
    );
    if let Some(ux) = ux {
        normalized.insert("ux", JsValue::string(ux));
    }
    Ok(MasterState {
        phase,
        mode,
        ux,
        outcome,
        history,
        normalized: JsValue::Object(normalized),
    })
}

/// A copy of `source` with only `keys`, in that order.
fn fields(source: &JsObject, keys: &[&str]) -> JsObject {
    let mut out = JsObject::new();
    for key in keys {
        if let Some(value) = source.get(key) {
            out.insert(*key, value.clone());
        }
    }
    out
}

/// `signal`: `keys`, then `libraries` (defaulted to `[]`), then `suggested`.
fn fields_with(source: &JsObject, keys: &[&str], libraries: Vec<JsValue>) -> JsObject {
    let mut out = fields(source, keys);
    out.insert("libraries", JsValue::Array(libraries));
    if let Some(value) = source.get("suggested") {
        out.insert("suggested", value.clone());
    }
    out
}

/// `/^<prefix>\d+$/`, with the number it carries (`Number(id.slice(1))`).
fn numbered_id(s: &str, prefix: char) -> Option<u64> {
    let digits = s.strip_prefix(prefix)?;
    if digits.is_empty() || digits.len() > 15 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// A text `renderMasterParts` writes into the STATUS region: no line break, no `<!--`.
fn region_safe(s: &str) -> bool {
    !s.contains(['\r', '\n']) && !s.contains("<!--")
}

/// `ids` are `1..=n` exactly once each.
fn consecutive(mut ids: Vec<u64>) -> bool {
    ids.sort_unstable();
    ids.iter().enumerate().all(|(i, n)| *n == i as u64 + 1)
}

fn criterion(value: &JsValue) -> Result<(Criterion, Vec<String>), Invalid> {
    let o = object(value)?;
    let id = text(o.get("id"))?;
    numbered_id(&id, 'A').ok_or(Invalid)?;
    let description = non_empty(o.get("description"))?;
    let evidence = match o.get("evidence") {
        None | Some(JsValue::Undefined | JsValue::Null) => Evidence::None,
        Some(e) => {
            let e = object(e)?;
            match text(e.get("kind"))?.as_str() {
                "run" => {
                    non_empty(e.get("command"))?;
                    non_empty(e.get("result"))?;
                    non_empty(e.get("commit"))?;
                    date(e.get("date"))?;
                    Evidence::Run
                }
                "approval" => {
                    if text(e.get("approvedBy"))? != "user" {
                        return Err(Invalid);
                    }
                    date(e.get("date"))?;
                    Evidence::Approval
                }
                _ => return Err(Invalid),
            }
        }
    };
    let method = one_of(o.get("method"), &["test", "comando", "manual"])?;
    let blocks = ["test", "command", "manual"];
    let own = match method {
        "test" => "test",
        "comando" => "command",
        _ => "manual",
    };
    if blocks.iter().any(|b| *b != own && !absent(o.get(b))) {
        return Err(Invalid);
    }
    let block = object(o.get(own).ok_or(Invalid)?)?;
    let mut texts = vec![description.clone()];
    let detail = match method {
        "test" => {
            let (file, case) = (non_empty(block.get("file"))?, non_empty(block.get("case"))?);
            texts.extend([file.clone(), case.clone()]);
            format!("{file}#{case}")
        }
        "comando" => {
            let run = non_empty(block.get("run"))?;
            non_empty(block.get("expected"))?;
            texts.push(run.clone());
            run
        }
        _ => {
            let check = non_empty(block.get("check"))?;
            non_empty(block.get("how"))?;
            texts.push(check.clone());
            check
        }
    };
    let valid_evidence = match evidence {
        Evidence::None => true,
        Evidence::Run => method != "manual",
        Evidence::Approval => method == "manual",
    };
    if !valid_evidence {
        return Err(Invalid);
    }
    Ok((
        Criterion {
            id,
            description,
            method,
            detail,
            evidence,
        },
        texts,
    ))
}

fn part(value: &JsValue) -> Result<Part, Invalid> {
    let o = object(value)?;
    let id = text(o.get("id"))?;
    numbered_id(&id, 'P').ok_or(Invalid)?;
    let title = non_empty(o.get("title"))?;
    let objective = non_empty(o.get("objective"))?;
    let scope = array_or_empty(o.get("scope"), string_item)?;
    let out_of_scope = array_or_empty(o.get("outOfScope"), string_item)?;
    let depends_on = array_or_empty(o.get("dependsOn"), |v| {
        let s = string_item(v)?;
        numbered_id(&s, 'P').ok_or(Invalid).map(|_| s)
    })?;
    let seed = array_or_empty(o.get("seedRequirements"), string_item)?;
    let (acceptance, criterion_texts): (Vec<_>, Vec<_>) = match o.get("acceptance") {
        Some(JsValue::Array(items)) if !items.is_empty() => items
            .iter()
            .map(criterion)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .unzip(),
        _ => return Err(Invalid),
    };
    nullable(o.get("inheritedFrom"), true, non_empty)?;
    let state = if absent(o.get("state")) {
        "pendiente"
    } else {
        one_of(o.get("state"), &PART_STATES)?
    };
    let reason = nullable(o.get("reason"), true, non_empty)?;
    let spec = nullable(o.get("spec"), true, non_empty)?;
    let issue = nullable(o.get("issue"), true, |v| integer(v, 1.0))?;
    let needs_reason = state == "descartada" || state == "diferida";
    let texts_ok = [&title, &objective]
        .into_iter()
        .chain(&scope)
        .chain(&out_of_scope)
        .chain(&seed)
        .chain(criterion_texts.iter().flatten())
        .all(|s| region_safe(s));
    let acceptance_ok = consecutive(
        acceptance
            .iter()
            .filter_map(|c| numbered_id(&c.id, 'A'))
            .collect(),
    );
    if needs_reason != reason.is_some() || !texts_ok || !acceptance_ok {
        return Err(Invalid);
    }
    Ok(Part {
        id,
        title,
        objective,
        scope,
        out_of_scope,
        depends_on,
        seed_requirements: seed,
        acceptance,
        state,
        reason,
        spec,
        issue,
    })
}

/// `findCycle` over `dependsOn` (known ids only): true when any cycle exists.
fn has_cycle(parts: &[Part]) -> bool {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Visiting,
        Done,
    }
    fn visit(i: usize, parts: &[Part], marks: &mut [Option<Mark>]) -> bool {
        marks[i] = Some(Mark::Visiting);
        for dep in &parts[i].depends_on {
            let Some(j) = parts.iter().position(|p| &p.id == dep) else {
                continue;
            };
            let mark = marks[j];
            if mark == Some(Mark::Visiting) || (mark.is_none() && visit(j, parts, marks)) {
                return true;
            }
        }
        marks[i] = Some(Mark::Done);
        false
    }
    let mut marks = vec![None; parts.len()];
    (0..parts.len()).any(|i| marks[i].is_none() && visit(i, parts, &mut marks))
}

/// `PartsSchema.parse(raw).parts` when it succeeds.
///
/// # Errors
/// [`Invalid`] wherever zod would throw.
pub fn parts(raw: &JsValue) -> Result<Vec<Part>, Invalid> {
    let o = object(raw)?;
    version_one(o.get("version"))?;
    let parts = array_or_empty(o.get("parts"), part)?;
    let ids_ok = consecutive(
        parts
            .iter()
            .filter_map(|p| numbered_id(&p.id, 'P'))
            .collect(),
    );
    let deps_known = parts.iter().all(|p| {
        p.depends_on
            .iter()
            .all(|d| parts.iter().any(|q| &q.id == d))
    });
    if !ids_ok || !deps_known || has_cycle(&parts) {
        return Err(Invalid);
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn state(text: &str) -> Result<MasterState, Invalid> {
        master_state(&js_json::parse(text).ok_or(Invalid)?)
    }

    fn doc(text: &str) -> Result<Vec<Part>, Invalid> {
        parts(&js_json::parse(text).ok_or(Invalid)?)
    }

    const SIGNAL: &str = r#""signal":{"commits":null,"firstCommit":null,"filesChangedSinceFirst":null,"framework":null,"suggested":"template"}"#;

    #[test]
    fn state_follows_the_schema_and_its_refinements() {
        let ok = state(&format!(
            r#"{{"version":1,"phase":"executing","mode":"en-curso",{SIGNAL},"ux":"md","history":[{{"phase":"context","at":"2026-01-01"}},{{"phase":"transcribed","at":"2026-01-02"}}]}}"#
        ));
        let ok = ok.map(|s| (s.phase, s.mode, s.ux, s.history));
        assert_eq!(
            ok,
            Ok((
                "executing",
                Some("en-curso"),
                Some("md"),
                vec!["context", "transcribed"]
            ))
        );
        for bad in [
            format!(r#"{{"version":2,"phase":"context","mode":null,{SIGNAL}}}"#),
            format!(r#"{{"version":1,"phase":"context",{SIGNAL}}}"#),
            format!(r#"{{"version":1,"phase":"context","mode":null,{SIGNAL},"ux":null}}"#),
            format!(r#"{{"version":1,"phase":"context","mode":null,{SIGNAL},"outcome":"convertida"}}"#),
            format!(r#"{{"version":1,"phase":"context","mode":null,{SIGNAL},"abandonment":{{"reason":"x","phase":"context"}}}}"#),
            r#"{"version":1,"phase":"context","mode":null,"signal":{"commits":-1,"firstCommit":null,"filesChangedSinceFirst":null,"framework":null,"suggested":"template"}}"#.to_owned(),
        ] {
            assert_eq!(state(&bad), Err(Invalid), "{bad}");
        }
    }

    #[test]
    fn state_normalizes_like_zod_parse() {
        // Schema key order, defaults filled in, unknown keys stripped at every level.
        let raw = r#"{"extra":1,"history":[{"at":"2026-01-01","phase":"context","zz":1}],"ux":"md","mode":"en-curso","phase":"executing","version":1,"signal":{"suggested":"template","framework":null,"commits":5,"firstCommit":"2026-01-01","filesChangedSinceFirst":null,"q":1}}"#;
        let normalized = state(raw).map(|s| s.normalized.stringify(None));
        assert_eq!(
            normalized,
            Ok(Some(
                r#"{"version":1,"phase":"executing","mode":"en-curso","signal":{"commits":5,"firstCommit":"2026-01-01","filesChangedSinceFirst":null,"framework":null,"libraries":[],"suggested":"template"},"outcome":null,"history":[{"phase":"context","at":"2026-01-01"}],"ux":"md"}"#
                    .to_owned()
            ))
        );
    }

    const A1: &str =
        r#"{"id":"A1","description":"d","method":"test","test":{"file":"f","case":"c"}}"#;

    #[test]
    fn parts_follow_the_schema_and_its_refinements() {
        let ok = doc(&format!(
            r#"{{"version":1,"parts":[{{"id":"P1","title":"t","objective":"o","acceptance":[{A1}]}},{{"id":"P2","title":"t","objective":"o","dependsOn":["P1"],"state":"diferida","reason":"r","acceptance":[{A1}]}}]}}"#
        ));
        assert_eq!(
            ok.map(|p| p.iter().map(|p| p.state).collect::<Vec<_>>()),
            Ok(vec!["pendiente", "diferida"])
        );
        let part = |extra: &str, acceptance: &str| {
            format!(
                r#"{{"version":1,"parts":[{{"id":"P1","title":"t","objective":"o"{extra},"acceptance":[{acceptance}]}}]}}"#
            )
        };
        for bad in [
            part("", ""),
            part(r#","state":"descartada""#, A1),
            part(r#","reason":"r""#, A1),
            part(r#","dependsOn":["P1"]"#, A1),
            part(r#","dependsOn":["P9"]"#, A1),
            part(r#","scope":["a\nb"]"#, A1),
            part(r#","issue":0"#, A1),
            part("", &A1.replace("A1", "A2")),
            part("", &A1.replace(r#""method":"test""#, r#""method":"manual""#)),
            part(
                "",
                &format!(
                    r#"{},"command":{{"run":"r","expected":"e"}}}}"#,
                    &A1[..A1.len() - 1]
                ),
            ),
            part("", &A1.replace(r#""description":"d""#, r#""description":"d","evidence":{"kind":"approval","approvedBy":"user","date":"2026-01-01"}"#)),
            r#"{"version":1,"parts":[{"id":"P2","title":"t","objective":"o","acceptance":[]}]}"#.to_owned(),
        ] {
            assert_eq!(doc(&bad), Err(Invalid), "{bad}");
        }
    }
}
