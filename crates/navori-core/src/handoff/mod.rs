//! Port of `lib/handoff` for `navori handoff` (spec 0060 T10, R73/R74): the implementer's
//! handoff (`impl_<feature>.json`) and its template, the legacy `.md` check, the
//! `markdownRequests` path rule and the reviewer's findings sidecar.
//!
//! The schemas answer `Some` only for a document zod accepts and this port reproduces: a document
//! zod rejects (its issue text is zod's) or one with text Rust cannot carry (a lone surrogate) is
//! `None`, and the command hands the invocation to the TS before any output.

pub mod implementation;
pub mod review;

use crate::js_json::{JsObject, JsValue};

/// `z.string()` as Rust text; `None` for a non-string or a lone surrogate.
fn text(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

/// `z.string().min(1)`.
fn non_empty(value: &JsValue) -> Option<String> {
    text(value).filter(|t| !t.is_empty())
}

/// `z.array(z.string())`.
fn strings(value: &JsValue) -> Option<Vec<String>> {
    match value {
        JsValue::Array(items) => items.iter().map(text).collect(),
        _ => None,
    }
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(object) => Some(object),
        _ => None,
    }
}

/// An optional field: `Some(None)` when absent, `None` when present and invalid.
fn optional<T>(
    object: &JsObject,
    key: &str,
    parse: impl Fn(&JsValue) -> Option<T>,
) -> Option<Option<T>> {
    object
        .get(key)
        .map_or(Some(None), |value| parse(value).map(Some))
}

/// `z.number().int()`: a finite safe integer.
fn safe_integer(value: &JsValue) -> Option<f64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    match value {
        JsValue::Number(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE => Some(*n),
        _ => None,
    }
}
