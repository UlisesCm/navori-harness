//! `lib/plan/acceptance-index.ts`: the `acceptance-index` the `routing-watch` success lane reads
//! and its `acceptance-expected.jsonl` companion, built from every workplan of the state
//! directories (spec 0060 T11, R73).
//!
//! The TS skips a workplan it cannot read or parse. Rust cannot tell such a file apart from one
//! it does not model (a JSON or zod failure, a lone surrogate, a `source` projection that needs
//! the master delivery, a `matches:` only JS compiles), so any of them makes the whole build
//! `None` and the command hands the invocation to the TS before writing.

use std::fs;

use crate::js_json::{JsObject, JsValue, parse};
use crate::plan::check::schema;
use crate::plan::expected::{Expected, parse_expected};

/// The two files, as `writeAcceptanceIndex` writes them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AcceptanceIndex {
    /// `acceptance-index`.
    pub index: String,
    /// `acceptance-expected.jsonl`.
    pub expected: String,
}

fn string(text: &str) -> JsValue {
    JsValue::string(text)
}

/// `JSON.stringify(spec)` of a `parseExpected` result other than `free`.
fn spec_json(spec: &Expected) -> Option<JsValue> {
    let mut o = JsObject::new();
    match spec {
        Expected::Exit(code) => {
            o.insert("kind", string("exit"));
            o.insert("code", JsValue::Number(f64::from(*code)));
        }
        Expected::Contains(text) => {
            o.insert("kind", string("contains"));
            o.insert("text", string(text));
        }
        Expected::Invalid(reason) => {
            o.insert("kind", string("invalid"));
            o.insert("reason", string(reason));
        }
        Expected::Free | Expected::NeedsJs => return None,
    }
    Some(JsValue::Object(o))
}

/// `jsonEscape(command)`: the command exactly as `JSON.stringify` writes it inside a payload
/// string, without the quotes. `None` where the TS's escaping is not certain.
#[must_use]
pub fn json_escape(command: &str) -> Option<String> {
    let quoted = string(command).stringify(None)?;
    Some(quoted[1..quoted.len() - 1].to_owned())
}

/// `/^workplan_.+\.json$/` (`.` is any non-line-terminator).
fn is_workplan_name(name: &str) -> bool {
    name.strip_prefix("workplan_")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|middle| {
            !middle.is_empty() && !middle.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        })
}

/// `linesForDir(dir)` appended to `out`, reading `pending`'s text for its path; `None` where the
/// TS's answer is not certain.
fn lines_for_dir(
    dir: &str,
    out: &mut AcceptanceIndex,
    pending: Option<(&str, &str)>,
) -> Option<()> {
    let Ok(meta) = fs::metadata(dir) else {
        return Some(());
    };
    if !meta.is_dir() {
        return None;
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).ok()? {
        let name = entry.ok()?.file_name().into_string().ok()?;
        // `.sort()` compares UTF-16 units; ASCII names sort the same as bytes.
        if !name.is_ascii() {
            return None;
        }
        names.push(name);
    }
    names.sort();
    for name in names.iter().filter(|n| is_workplan_name(n)) {
        let path = format!("{dir}/{name}");
        let text = match pending {
            Some((written, text)) if written == path => text.to_owned(),
            _ => String::from_utf8(fs::read(&path).ok()?).ok()?,
        };
        let raw = parse(&text)?;
        let plan = schema(&raw)?;
        // Cumplido criteria stay indexed (#1629): a rerun after a change must record fresh
        // evidence, and a stale green never validates against a moved tree.
        for c in &plan.acceptance {
            let escaped = json_escape(&c.command)?;
            out.index
                .push_str(&format!("{escaped}\t{}\t{}\t{dir}\n", plan.feature, c.id));
            let spec = parse_expected(&c.expected)?;
            if spec == Expected::NeedsJs {
                return None;
            }
            if let Some(spec) = spec_json(&spec) {
                let mut o = JsObject::new();
                o.insert("command", string(&c.command));
                o.insert("feature", string(&plan.feature));
                o.insert("id", string(&c.id));
                o.insert("dir", string(dir));
                o.insert("binding", JsValue::Null);
                o.insert("stage", string(""));
                o.insert("expected", string(&c.expected));
                o.insert("spec", spec);
                out.expected.push_str(&JsValue::Object(o).stringify(None)?);
                out.expected.push('\n');
            }
        }
    }
    Some(())
}

/// `writeAcceptanceIndex`'s contents over the absolute `dirs` (deduplicated in order). `pending`
/// is a workplan the caller writes first: `(path, text)`, read in place of the file.
#[must_use]
pub fn build(dirs: &[String], pending: Option<(&str, &str)>) -> Option<AcceptanceIndex> {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = AcceptanceIndex::default();
    for dir in dirs {
        if seen.contains(&dir.as_str()) {
            continue;
        }
        seen.push(dir);
        lines_for_dir(dir, &mut out, pending)?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn workplan_names_and_specs_follow_the_ts() {
        assert!(is_workplan_name("workplan_a.json"));
        assert!(!is_workplan_name("workplan_.json"));
        assert!(!is_workplan_name("workplan_a.md"));
        assert_eq!(
            spec_json(&Expected::Exit(2)).and_then(|v| v.stringify(None)),
            Some(r#"{"kind":"exit","code":2}"#.to_owned())
        );
        assert_eq!(spec_json(&Expected::Free), None);
    }
}
