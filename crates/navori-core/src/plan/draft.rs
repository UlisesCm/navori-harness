//! Port of the draft half of `lib/plan/schema.ts`: `parseDraftShape`, `isWorkplanDraft` and
//! `workplanDraftSignals`, the one definition `plan classify` and the plan gate share (#1571).
//!
//! Every function returns `None` when a string holds a lone surrogate, which JS reads and Rust
//! cannot represent: the caller delegates to the TS.

use crate::js_json::{JsObject, JsValue};

/// `DraftShape`: the declared file paths and `classification.signals` of a draft.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DraftShape {
    pub files: Vec<String>,
    pub signals: Vec<String>,
}

/// The field `parseDraftShape` throws on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftError {
    Files,
    FileEntry,
    Signals,
}

impl DraftError {
    /// The message of the TS `Error`; callers add the context.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Files => "\"files\" must be an array",
            Self::FileEntry => "every \"files\" entry needs a string \"path\"",
            Self::Signals => "\"classification.signals\" must be a string array",
        }
    }
}

/// `parseDraftShape(record)`, without `WorkplanSchema`: a draft written before `classify` ran has
/// no `level` or `classification`.
#[must_use]
pub fn parse_draft_shape(record: &JsObject) -> Option<Result<DraftShape, DraftError>> {
    let mut shape = DraftShape::default();
    if let Some(value) = record.get("files") {
        let JsValue::Array(entries) = value else {
            return Some(Err(DraftError::Files));
        };
        for entry in entries {
            let JsValue::Object(entry) = entry else {
                return Some(Err(DraftError::FileEntry));
            };
            let Some(JsValue::String(path)) = entry.get("path") else {
                return Some(Err(DraftError::FileEntry));
            };
            shape.files.push(path.to_rust()?);
        }
    }
    // `record.classification?.signals`: only an object can carry it.
    if let Some(JsValue::Object(classification)) = record.get("classification")
        && let Some(value) = classification.get("signals")
    {
        let JsValue::Array(items) = value else {
            return Some(Err(DraftError::Signals));
        };
        for item in items {
            let JsValue::String(text) = item else {
                return Some(Err(DraftError::Signals));
            };
            shape.signals.push(text.to_rust()?);
        }
    }
    Some(Ok(shape))
}

/// `workplanDraftSignals(raw)`: the declared signals of a `plan classify` draft, or `Some(None)`
/// when `raw` is not one. A draft (`isWorkplanDraft`) is an object with neither `level` nor
/// `acceptance` and a non-empty, well-formed `files` list.
#[must_use]
pub fn workplan_draft_signals(raw: &JsValue) -> Option<Option<Vec<String>>> {
    let JsValue::Object(record) = raw else {
        return Some(None);
    };
    if record.has("level") || record.has("acceptance") {
        return Some(None);
    }
    Some(match parse_draft_shape(record)? {
        Ok(shape) if !shape.files.is_empty() => Some(shape.signals),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn signals(text: &str) -> Option<Option<Vec<String>>> {
        let Some(raw) = js_json::parse(text) else {
            panic!("invalid JSON: {text}");
        };
        workplan_draft_signals(&raw)
    }

    #[test]
    fn a_draft_yields_its_declared_signals() {
        let draft = r#"{"feature":"demo","files":[{"path":"README.md"}],"classification":{"signals":["floor:multi-repo"]}}"#;
        assert_eq!(
            signals(draft),
            Some(Some(vec!["floor:multi-repo".to_owned()]))
        );
        let bare = r#"{"files":[{"path":"a.ts"}]}"#;
        assert_eq!(signals(bare), Some(Some(Vec::new())));
        let odd_classification = r#"{"files":[{"path":"a.ts"}],"classification":"x"}"#;
        assert_eq!(signals(odd_classification), Some(Some(Vec::new())));
    }

    #[test]
    fn anything_else_is_not_a_draft() {
        for text in [
            r#"{"level":1,"files":[{"path":"a.ts"}]}"#,
            r#"{"acceptance":[],"files":[{"path":"a.ts"}]}"#,
            r#"{"files":[]}"#,
            r#"{"feature":"demo"}"#,
            r#"{"files":{"path":"a.ts"}}"#,
            r#"{"files":[{"path":1}]}"#,
            r#"{"files":[["a.ts"]]}"#,
            r#"{"files":[{"path":"a.ts"}],"classification":{"signals":"x"}}"#,
            r#"{"files":[{"path":"a.ts"}],"classification":{"signals":[1]}}"#,
            r#"{"files":[{"path":"a.ts"}],"classification":{"signals":null}}"#,
            r#"[{"path":"a.ts"}]"#,
            "null",
            "\"draft\"",
        ] {
            assert_eq!(signals(text), Some(None), "{text}");
        }
    }

    #[test]
    fn shape_errors_name_the_field_like_the_ts() {
        let shape = |text: &str| match js_json::parse(text) {
            Some(JsValue::Object(record)) => parse_draft_shape(&record),
            _ => panic!("not an object"),
        };
        assert_eq!(shape(r#"{"files":1}"#), Some(Err(DraftError::Files)));
        assert_eq!(
            shape(r#"{"files":[null]}"#),
            Some(Err(DraftError::FileEntry))
        );
        assert_eq!(
            shape(r#"{"classification":{"signals":[true]}}"#),
            Some(Err(DraftError::Signals))
        );
        assert_eq!(
            DraftError::Signals.message(),
            "\"classification.signals\" must be a string array"
        );
    }
}
