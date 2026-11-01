//! The reviewer's findings sidecar (`ReviewSidecarSchema`) and the lines `logReview` appends to
//! `findings.jsonl` (spec 0039 R21).

use super::{non_empty, object, optional, safe_integer, text};
use crate::js_json::{JsObject, JsValue};

/// Findings below this score are not logged (`FINDING_SCORE_THRESHOLD`).
pub const FINDING_SCORE_THRESHOLD: f64 = 50.0;

/// `FINDINGS_LOG_NAME`.
pub const FINDINGS_LOG_NAME: &str = "findings.jsonl";

const SEVERITIES: [&str; 4] = ["critical", "high", "medium", "low"];

/// One finding as zod returns it: the shape's keys in shape order, unknown keys stripped.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub score: f64,
    /// `category`, `severity`, `score`, `file` and the present optional keys.
    pub fields: Vec<(&'static str, JsValue)>,
}

/// A sidecar zod accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct Sidecar {
    pub feature: String,
    pub verdict: JsValue,
    pub findings: Vec<Finding>,
}

fn checked(value: &JsValue, valid: bool) -> Option<JsValue> {
    valid.then(|| value.clone())
}

fn finding(value: &JsValue) -> Option<Finding> {
    let o: &JsObject = object(value)?;
    let category = o.get("category")?;
    non_empty(category)?;
    let severity = o.get("severity")?;
    let severity_ok = text(severity).is_some_and(|s| SEVERITIES.contains(&s.as_str()));
    let score_value = o.get("score")?;
    let score = safe_integer(score_value).filter(|s| (0.0..=100.0).contains(s))?;
    let file = o.get("file")?;
    non_empty(file)?;
    let line = optional(o, "line", |v| {
        safe_integer(v).filter(|n| *n > 0.0).map(|_| v.clone())
    })?;
    let summary = optional(o, "summary", |v| non_empty(v).map(|_| v.clone()))?;
    let mut fields = vec![
        ("category", category.clone()),
        ("severity", checked(severity, severity_ok)?),
        ("score", score_value.clone()),
        ("file", file.clone()),
    ];
    fields.extend(line.map(|v| ("line", v)));
    fields.extend(summary.map(|v| ("summary", v)));
    Some(Finding { score, fields })
}

/// `ReviewSidecarSchema.safeParse(raw)`: `Some` when zod accepts it and its feature is text.
#[must_use]
pub fn parse_sidecar(raw: &JsValue) -> Option<Sidecar> {
    let o = object(raw)?;
    let verdict = o.get("verdict")?;
    non_empty(verdict)?;
    let findings = match o.get("findings")? {
        JsValue::Array(items) => items.iter().map(finding).collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    Some(Sidecar {
        feature: non_empty(o.get("feature")?)?,
        verdict: verdict.clone(),
        findings,
    })
}

/// `new Date().toISOString()`.
#[must_use]
pub fn iso_now() -> String {
    jiff::Timestamp::now()
        .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// The `findings.jsonl` lines of the findings with score `>= 50`, as `JSON.stringify` writes them.
#[must_use]
pub fn findings_lines(sidecar: &Sidecar, hash: &str, at: &str) -> Option<Vec<String>> {
    sidecar
        .findings
        .iter()
        .filter(|f| f.score >= FINDING_SCORE_THRESHOLD)
        .map(|f| {
            let mut record = JsObject::new();
            record.insert("sidecarHash", JsValue::string(hash));
            record.insert("feature", JsValue::string(&sidecar.feature));
            record.insert("verdict", sidecar.verdict.clone());
            record.insert("at", JsValue::string(at));
            for (key, value) in &f.fields {
                record.insert(*key, value.clone());
            }
            JsValue::Object(record).stringify(None)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn findings_keep_the_shape_order_and_the_threshold() {
        let raw = crate::js_json::parse(
            r#"{"feature":"f","verdict":"V","findings":[{"summary":"s","file":"a","score":50,"severity":"low","category":"c","x":1},{"category":"c","severity":"low","score":49,"file":"b"}]}"#,
        );
        let sidecar = raw.as_ref().and_then(parse_sidecar);
        let lines = sidecar
            .as_ref()
            .and_then(|s| findings_lines(s, "h", "t"))
            .unwrap_or_default();
        assert_eq!(
            lines,
            [
                r#"{"sidecarHash":"h","feature":"f","verdict":"V","at":"t","category":"c","severity":"low","score":50,"file":"a","summary":"s"}"#
            ]
        );
        for invalid in [
            r#"{"feature":"f","verdict":"V","findings":[{"category":"c","severity":"none","score":50,"file":"a"}]}"#,
            r#"{"feature":"f","verdict":"V","findings":[{"category":"c","severity":"low","score":101,"file":"a"}]}"#,
            r#"{"feature":"f","verdict":"V","findings":[{"category":"c","severity":"low","score":5,"file":"a","line":0}]}"#,
            r#"{"feature":"f","verdict":"","findings":[]}"#,
        ] {
            let raw = crate::js_json::parse(invalid);
            assert!(raw.as_ref().and_then(parse_sidecar).is_none(), "{invalid}");
        }
        assert_eq!(iso_now().len(), 24);
    }
}
