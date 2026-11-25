//! What `plan update` and `plan escalation-reset` decide before they write (spec 0060 T11, R73):
//! the strict `--progress`/`--date` forms, the raw mutations (`applyMutationsToRaw`) and the
//! rejection history of `lib/plan/escalation.ts` (`readRejectionHistory`).
//!
//! Every function answers `None` where only the TS can: a history line zod would parse in a shape
//! this port does not accept (it accepts the exact shapes the CLI writes), or a value that is not
//! text Rust can carry.

use std::sync::LazyLock;

use regex::Regex;

use crate::js_json::{JsObject, JsValue, parse};
use crate::js_re::ws;
use crate::posix::js_trim;

/// `z.iso.date()`: `YYYY-MM-DD` naming a real day of the proleptic Gregorian calendar.
#[must_use]
pub fn is_iso_date(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        text.get(range.clone())
            .filter(|s| s.bytes().all(|c| c.is_ascii_digit()))?
            .parse()
            .ok()
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// One `--progress` entry (`/^(A\d+)=(pendiente|cumplido|bloqueado)$/`): `(id, status)`.
#[must_use]
pub fn progress_entry(text: &str) -> Option<(String, String)> {
    let (id, status) = text.split_once('=')?;
    let digits = id.strip_prefix('A')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    matches!(status, "pendiente" | "cumplido" | "bloqueado")
        .then(|| (id.to_owned(), status.to_owned()))
}

/// A `RawMutation`.
#[derive(Debug, Clone, PartialEq)]
pub enum Mutation {
    Progress {
        id: String,
        status: String,
    },
    /// `None` deletes the entry.
    Evidence {
        id: String,
        value: Option<JsValue>,
    },
    Decision {
        text: String,
        date: String,
    },
}

fn record_copy(value: Option<&JsValue>) -> JsObject {
    match value {
        Some(JsValue::Object(object)) => object.clone(),
        _ => JsObject::new(),
    }
}

/// `applyMutationsToRaw(raw, mutations)`; `None` when `raw` is not an object.
#[must_use]
pub fn apply_mutations(raw: &JsValue, mutations: &[Mutation]) -> Option<JsValue> {
    let JsValue::Object(source) = raw else {
        return None;
    };
    let mut next = source.clone();
    for mutation in mutations {
        match mutation {
            Mutation::Progress { id, status } => {
                let mut map = record_copy(next.get("progress"));
                map.insert(id.as_str(), JsValue::string(status));
                next.insert("progress", JsValue::Object(map));
            }
            Mutation::Evidence { id, value: None } => {
                if matches!(next.get("evidence"), Some(JsValue::Object(_))) {
                    let mut map = record_copy(next.get("evidence"));
                    map.remove(id);
                    next.insert("evidence", JsValue::Object(map));
                }
            }
            Mutation::Evidence {
                id,
                value: Some(value),
            } => {
                let mut map = record_copy(next.get("evidence"));
                map.insert(id.as_str(), value.clone());
                next.insert("evidence", JsValue::Object(map));
            }
            Mutation::Decision { text, date } => {
                let mut decisions = match next.get("decisions") {
                    Some(JsValue::Array(items)) => items.clone(),
                    _ => Vec::new(),
                };
                let mut entry = JsObject::new();
                entry.insert("text", JsValue::string(text));
                entry.insert("date", JsValue::string(date));
                decisions.push(JsValue::Object(entry));
                next.insert("decisions", JsValue::Array(decisions));
            }
        }
    }
    Some(JsValue::Object(next))
}

/// `{ kind: "unevidenced", reason: "engine-without-signal" }`.
#[must_use]
pub fn unevidenced() -> JsValue {
    let mut o = JsObject::new();
    o.insert("kind", JsValue::string("unevidenced"));
    o.insert("reason", JsValue::string("engine-without-signal"));
    JsValue::Object(o)
}

// ---------------------------------------------------------------------------------------------
// The rejection history (`workplan_<feature>.gate.jsonl`)

/// `readRejectionHistory`'s counts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct History {
    /// Distinct rejection hashes on record.
    pub hashes: Vec<String>,
    /// `ts` of each rejection after the last reset.
    pub active: Vec<String>,
}

fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `new Date().toISOString()`'s exact shape with a valid date and time; the subset of
/// `z.string().datetime({ offset: true })` this port accepts.
fn is_iso_timestamp(text: &str) -> bool {
    let b = text.as_bytes();
    let shaped = b.len() == 24
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && [11, 12, 14, 15, 17, 18, 20, 21, 22]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    let field = |a: usize, z: usize| text.get(a..z).and_then(|s| s.parse::<u32>().ok());
    shaped
        && is_iso_date(&text[..10])
        && field(11, 13).is_some_and(|h| h < 24)
        && field(14, 16).is_some_and(|m| m < 60)
        && field(17, 19).is_some_and(|s| s < 60)
}

fn text(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

/// One history line in a shape this port accepts: `Some(Some(hash))` for a rejection,
/// `Some(None)` for a reset.
fn history_line(line: &str) -> Option<Option<(String, String)>> {
    let JsValue::Object(o) = parse(line)? else {
        return None;
    };
    let keys: Vec<String> = o
        .entries()
        .iter()
        .map(|(k, _)| k.to_rust())
        .collect::<Option<_>>()?;
    let has = |wanted: &[&str]| {
        keys.len() == wanted.len() && wanted.iter().all(|k| keys.iter().any(|x| x == k))
    };
    let ts = text(o.get("ts")).filter(|t| is_iso_timestamp(t))?;
    if has(&["ts", "reviewHash", "verdict"]) {
        let hash = text(o.get("reviewHash")).filter(|h| is_hash(h))?;
        (text(o.get("verdict"))? == "CHANGES_REQUESTED").then_some(Some((hash, ts)))
    } else if has(&["ts", "kind", "approvedBy", "reason", "rejectionsBefore"]) {
        let reason = text(o.get("reason"))?;
        let units = js_trim(&reason).encode_utf16().count();
        let before = matches!(
            o.get("rejectionsBefore")?,
            JsValue::Number(n) if n.fract() == 0.0 && *n >= 2.0 && *n <= 9_007_199_254_740_991.0
        );
        (text(o.get("kind"))? == "reset"
            && text(o.get("approvedBy"))? == "user"
            && (1..=4096).contains(&units)
            && before)
            .then_some(None)
    } else {
        None
    }
}

/// `readRejectionHistory` over the log's text; `None` where the TS throws or zod's answer is not
/// certain.
#[must_use]
pub fn read_history(log: &str) -> Option<History> {
    if !log.is_empty() && !log.ends_with('\n') {
        return None;
    }
    let mut history = History::default();
    for line in log.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        if line.len() > 8192 {
            return None;
        }
        match history_line(line)? {
            None => history.active.clear(),
            Some((hash, ts)) => {
                if !history.hashes.contains(&hash) {
                    history.hashes.push(hash);
                    history.active.push(ts);
                }
            }
        }
    }
    (history.hashes.len() <= 4096).then_some(history)
}

static FINAL_VERDICT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!(r"\*\*Final verdict:\*\*{}*([A-Z_]+)", ws())).ok());

/// The last `**Final verdict:**` of a review is `CHANGES_REQUESTED`.
#[must_use]
pub fn rejects(review: &str) -> Option<bool> {
    let re = FINAL_VERDICT.as_ref()?;
    Some(
        re.captures_iter(review)
            .last()
            .and_then(|c| c.get(1))
            .is_some_and(|m| m.as_str() == "CHANGES_REQUESTED"),
    )
}

/// A history line as `JSON.stringify` writes it.
#[must_use]
pub fn rejection_line(ts: &str, hash: &str) -> String {
    format!(r#"{{"ts":"{ts}","reviewHash":"{hash}","verdict":"CHANGES_REQUESTED"}}"#)
}

/// The reset entry as `JSON.stringify` writes it.
#[must_use]
pub fn reset_line(ts: &str, reason: &str, before: usize) -> Option<String> {
    let mut o = JsObject::new();
    o.insert("ts", JsValue::string(ts));
    o.insert("kind", JsValue::string("reset"));
    o.insert("approvedBy", JsValue::string("user"));
    o.insert("reason", JsValue::string(reason));
    #[expect(
        clippy::cast_precision_loss,
        reason = "a rejection count is far below 2^53"
    )]
    o.insert("rejectionsBefore", JsValue::Number(before as f64));
    JsValue::Object(o).stringify(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn strict_forms_follow_zod_and_the_ts_patterns() {
        assert!(
            is_iso_date("2024-02-29") && !is_iso_date("2023-02-29") && !is_iso_date("2024-13-01")
        );
        assert!(!is_iso_date("2024-1-01") && !is_iso_date("+024-01-01"));
        assert_eq!(
            progress_entry("A12=cumplido"),
            Some(("A12".to_owned(), "cumplido".to_owned()))
        );
        for bad in [
            "A=cumplido",
            "a1=cumplido",
            "A1=done",
            "A1=cumplido=x",
            "A1",
        ] {
            assert_eq!(progress_entry(bad), None, "{bad}");
        }
        assert!(is_iso_timestamp("2026-10-31T10:00:00.000Z"));
        assert!(!is_iso_timestamp("2026-10-31T24:00:00.000Z"));
    }

    // Covers: R73
    #[test]
    fn the_history_counts_distinct_rejections_after_the_last_reset() {
        let h = |c: char| c.to_string().repeat(64);
        let log = format!(
            "{}\n{}\n{}\n{}\n",
            rejection_line("2026-01-01T00:00:00.000Z", &h('a')),
            rejection_line("2026-01-02T00:00:00.000Z", &h('a')),
            reset_line("2026-01-03T00:00:00.000Z", " r ", 2).unwrap_or_default(),
            rejection_line("2026-01-04T00:00:00.000Z", &h('b')),
        );
        let history = read_history(&log);
        assert_eq!(history.as_ref().map(|x| x.hashes.len()), Some(2));
        assert_eq!(
            history.map(|x| x.active),
            Some(vec!["2026-01-04T00:00:00.000Z".to_owned()])
        );
        assert_eq!(read_history("{}"), None);
        assert_eq!(read_history("{\"ts\":1}\n"), None);
        assert_eq!(
            rejects("**Final verdict:** APPROVED\n**Final verdict:**  CHANGES_REQUESTED"),
            Some(true)
        );
        assert_eq!(
            rejects("**Final verdict:** CHANGES_REQUESTED\n**Final verdict:** APPROVED"),
            Some(false)
        );
    }

    // Covers: R73
    #[test]
    fn mutations_keep_undeclared_fields_and_key_order() {
        let raw =
            parse(r#"{"x":1,"progress":{"A2":"pendiente"},"evidence":{"A1":{"k":1}},"y":[2]}"#)
                .unwrap_or(JsValue::Null);
        let next = apply_mutations(
            &raw,
            &[
                Mutation::Progress {
                    id: "A1".into(),
                    status: "bloqueado".into(),
                },
                Mutation::Evidence {
                    id: "A1".into(),
                    value: None,
                },
                Mutation::Decision {
                    text: "t".into(),
                    date: "2026-01-01".into(),
                },
            ],
        );
        assert_eq!(
            next.and_then(|v| v.stringify(None)).as_deref(),
            Some(
                r#"{"x":1,"progress":{"A2":"pendiente","A1":"bloqueado"},"evidence":{},"y":[2],"decisions":[{"text":"t","date":"2026-01-01"}]}"#
            )
        );
    }
}
