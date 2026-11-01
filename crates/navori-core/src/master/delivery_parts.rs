//! `DeliveryPartsSchema` (`lib/master/delivery-schema.ts`): the versioned `parts.json` of a stage
//! in deliveries mode, and `deliveryIdsForSpec` (`delivery-checks.ts`, R22 of 0044), the mapping
//! `spec check` reads (spec 0060 T8).
//!
//! The validator follows zod exactly, including `.trim()` before `min(1)` and strict objects, so
//! it can tell a rejected file apart from an accepted one: the TS treats a rejected `parts.json`
//! as "no mapping". Text Rust cannot carry (a lone surrogate) is [`Parsed::Unmodeled`].

use std::path::Path;

use crate::js_json::{JsObject, JsValue, parse};
use crate::posix::{js_trim, resolve};

/// What `DeliveryPartsSchema.safeParse` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// It succeeds, with the fields the mapping reads.
    Valid(Parts),
    /// It fails.
    Invalid,
    /// Rust cannot tell.
    Unmodeled,
}

/// The fields of a valid `parts.json` the mapping reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parts {
    /// `(id, prTarget, integrationTarget)` of each delivery, trimmed as zod returns them.
    pub deliveries: Vec<(String, String, String)>,
    /// `(deliveryId, spec)` of each part.
    pub parts: Vec<(String, Option<String>)>,
}

/// A check that failed (`Invalid`) or could not be decided (`Unmodeled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fail {
    Invalid,
    Unmodeled,
}

type R<T> = Result<T, Fail>;

fn object(value: &JsValue) -> R<&JsObject> {
    match value {
        JsValue::Object(o) => Ok(o),
        _ => Err(Fail::Invalid),
    }
}

/// `z.strictObject` key set: every required key present, nothing outside `required ∪ optional`.
fn strict<'a>(value: &'a JsValue, required: &[&str], optional: &[&str]) -> R<&'a JsObject> {
    let o = object(value)?;
    for (key, _) in o.entries() {
        let key = key.to_rust().ok_or(Fail::Unmodeled)?;
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(Fail::Invalid);
        }
    }
    if required.iter().any(|k| !o.has(k)) {
        return Err(Fail::Invalid);
    }
    Ok(o)
}

fn field<'a>(o: &'a JsObject, key: &str) -> R<&'a JsValue> {
    o.get(key).ok_or(Fail::Invalid)
}

fn text(value: &JsValue) -> R<String> {
    match value {
        JsValue::String(s) => s.to_rust().ok_or(Fail::Unmodeled),
        _ => Err(Fail::Invalid),
    }
}

/// `z.string().trim().min(1)`: the trimmed text.
fn nonempty(value: &JsValue) -> R<String> {
    let trimmed = js_trim(&text(value)?).to_owned();
    if trimmed.is_empty() {
        Err(Fail::Invalid)
    } else {
        Ok(trimmed)
    }
}

fn matching(value: &JsValue, test: fn(&str) -> bool) -> R<String> {
    let t = text(value)?;
    if test(&t) { Ok(t) } else { Err(Fail::Invalid) }
}

fn boolean(value: &JsValue) -> R<()> {
    match value {
        JsValue::Bool(_) => Ok(()),
        _ => Err(Fail::Invalid),
    }
}

fn array(value: &JsValue, min: usize) -> R<&[JsValue]> {
    match value {
        JsValue::Array(items) if items.len() >= min => Ok(items),
        _ => Err(Fail::Invalid),
    }
}

fn each<T>(value: &JsValue, min: usize, item: impl Fn(&JsValue) -> R<T>) -> R<Vec<T>> {
    array(value, min)?.iter().map(item).collect()
}

fn nullable<T>(value: &JsValue, item: impl Fn(&JsValue) -> R<T>) -> R<Option<T>> {
    match value {
        JsValue::Null => Ok(None),
        other => item(other).map(Some),
    }
}

/// `^<prefix>\d+$`.
fn numbered(prefix: &str) -> impl Fn(&str) -> bool + '_ {
    move |t: &str| {
        t.strip_prefix(prefix)
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
    }
}

fn is_id(t: &str) -> bool {
    let mut chars = t.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_requirement(t: &str) -> bool {
    ["RNF-", "RN-", "RF-"].iter().any(|p| {
        t.strip_prefix(p)
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
    })
}

fn is_digest(t: &str) -> bool {
    t.len() == 64
        && t.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_relative(t: &str) -> bool {
    !t.is_empty() && !t.starts_with('/') && !t.split(['/', '\\']).any(|s| s == ".." || s == ".")
}

fn id_with(value: &JsValue, prefix: &str) -> R<String> {
    let t = text(value)?;
    if numbered(prefix)(&t) {
        Ok(t)
    } else {
        Err(Fail::Invalid)
    }
}

fn source(value: &JsValue) -> R<()> {
    let o = strict(
        value,
        &[
            "id",
            "path",
            "digest",
            "locator",
            "requirements",
            "uiBearing",
        ],
        &[],
    )?;
    matching(field(o, "id")?, is_id)?;
    matching(field(o, "path")?, is_relative)?;
    matching(field(o, "digest")?, is_digest)?;
    nonempty(field(o, "locator")?)?;
    each(field(o, "requirements")?, 1, |v| {
        matching(v, is_requirement)
    })?;
    boolean(field(o, "uiBearing")?)
}

fn requirement(value: &JsValue) -> R<()> {
    let o = strict(value, &["id", "sourceId", "disposition", "reason"], &[])?;
    matching(field(o, "id")?, is_requirement)?;
    matching(field(o, "sourceId")?, is_id)?;
    matching(field(o, "disposition")?, |t| {
        matches!(t, "in-scope" | "excluded" | "deferred")
    })?;
    nullable(field(o, "reason")?, nonempty).map(drop)
}

fn design(value: &JsValue) -> R<()> {
    let ui = text(field(object(value)?, "ui")?)?;
    let (required, extra): (&[&str], &[&str]) = match ui.as_str() {
        "none" => (&["ui", "reason"], &[]),
        "reuse" => (
            &["ui", "architecture", "flow", "system", "reviewedRevision"],
            &[],
        ),
        "new" => (
            &[
                "ui",
                "architecture",
                "flow",
                "system",
                "reviewedRevision",
                "foundationPartId",
            ],
            &[],
        ),
        _ => return Err(Fail::Invalid),
    };
    let o = strict(value, required, extra)?;
    if ui == "none" {
        return nonempty(field(o, "reason")?).map(drop);
    }
    for key in ["architecture", "flow", "system"] {
        matching(field(o, key)?, is_relative)?;
    }
    nonempty(field(o, "reviewedRevision")?)?;
    if ui == "new" {
        id_with(field(o, "foundationPartId")?, "P")?;
    }
    Ok(())
}

fn delivery(value: &JsValue) -> R<(String, String, String)> {
    let o = strict(
        value,
        &["id", "title", "outcome", "partIds", "dependsOn", "git"],
        &["timing"],
    )?;
    let id = id_with(field(o, "id")?, "E")?;
    nonempty(field(o, "title")?)?;
    nonempty(field(o, "outcome")?)?;
    each(field(o, "partIds")?, 1, |v| id_with(v, "P"))?;
    each(field(o, "dependsOn")?, 0, |v| id_with(v, "E"))?;
    let git = strict(
        field(o, "git")?,
        &["branch", "base", "integrationTarget", "prTarget"],
        &[],
    )?;
    nonempty(field(git, "branch")?)?;
    nonempty(field(git, "base")?)?;
    let integration = nonempty(field(git, "integrationTarget")?)?;
    let pr = nonempty(field(git, "prTarget")?)?;
    if let Some(timing) = o.get("timing") {
        nonempty(timing)?;
    }
    Ok((id, pr, integration))
}

fn criterion(value: &JsValue) -> R<()> {
    let method = text(field(object(value)?, "method")?)?;
    let o = match method.as_str() {
        "test" | "command" => strict(
            value,
            &["id", "method", "description", "command", "expected"],
            &[],
        )?,
        "manual" => strict(
            value,
            &["id", "method", "description", "check", "artifact"],
            &[],
        )?,
        _ => return Err(Fail::Invalid),
    };
    id_with(field(o, "id")?, "A")?;
    nonempty(field(o, "description")?)?;
    if method == "manual" {
        nonempty(field(o, "check")?)?;
        matching(field(o, "artifact")?, is_relative)?;
    } else {
        nonempty(field(o, "command")?)?;
        nonempty(field(o, "expected")?)?;
    }
    Ok(())
}

fn question(value: &JsValue) -> R<()> {
    let o = strict(value, &["text", "blocking", "assignedPartId"], &[])?;
    nonempty(field(o, "text")?)?;
    boolean(field(o, "blocking")?)?;
    nullable(field(o, "assignedPartId")?, |v| id_with(v, "P")).map(drop)
}

fn part(value: &JsValue) -> R<(String, Option<String>)> {
    let o = strict(
        value,
        &[
            "id",
            "deliveryId",
            "title",
            "objective",
            "scope",
            "outOfScope",
            "dependsOn",
            "sourceIds",
            "requirementIds",
            "spec",
            "foundation",
            "acceptance",
            "questions",
        ],
        &[],
    )?;
    id_with(field(o, "id")?, "P")?;
    let delivery = id_with(field(o, "deliveryId")?, "E")?;
    nonempty(field(o, "title")?)?;
    nonempty(field(o, "objective")?)?;
    each(field(o, "scope")?, 1, nonempty)?;
    each(field(o, "outOfScope")?, 0, nonempty)?;
    each(field(o, "dependsOn")?, 0, |v| id_with(v, "P"))?;
    each(field(o, "sourceIds")?, 1, |v| matching(v, is_id))?;
    each(field(o, "requirementIds")?, 1, |v| {
        matching(v, is_requirement)
    })?;
    let spec = nullable(field(o, "spec")?, |v| matching(v, is_relative))?;
    boolean(field(o, "foundation")?)?;
    each(field(o, "acceptance")?, 1, criterion)?;
    each(field(o, "questions")?, 0, question)?;
    Ok((delivery, spec))
}

fn parts(value: &JsValue) -> R<Parts> {
    let o = strict(
        value,
        &[
            "version",
            "workflow",
            "revision",
            "digest",
            "sources",
            "requirements",
            "design",
            "deliveries",
            "parts",
        ],
        &[],
    )?;
    if !matches!(field(o, "version")?, JsValue::Number(n) if *n == 2.0) {
        return Err(Fail::Invalid);
    }
    matching(field(o, "workflow")?, |t| t == "deliveries")?;
    if !matches!(field(o, "revision")?,
        JsValue::Number(n) if n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
    {
        return Err(Fail::Invalid);
    }
    matching(field(o, "digest")?, is_digest)?;
    each(field(o, "sources")?, 1, source)?;
    each(field(o, "requirements")?, 1, requirement)?;
    design(field(o, "design")?)?;
    let deliveries = each(field(o, "deliveries")?, 1, delivery)?;
    let parts = each(field(o, "parts")?, 1, part)?;
    Ok(Parts { deliveries, parts })
}

/// `DeliveryPartsSchema.safeParse(raw)`.
#[must_use]
pub fn validate(raw: &JsValue) -> Parsed {
    match parts(raw) {
        Ok(parts) => Parsed::Valid(parts),
        Err(Fail::Invalid) => Parsed::Invalid,
        Err(Fail::Unmodeled) => Parsed::Unmodeled,
    }
}

/// A `SpecDeliveryRef`: `(id, prTarget, integrationTarget)`.
pub type DeliveryRef = (String, String, String);

/// `deliveryIdsForSpec(cwd, specPath)` once the active stage is known to use deliveries:
/// `Some(None)` is `null`, `None` where only the TS can answer (a `parts.json` Rust cannot read
/// or judge like it).
#[must_use]
pub fn delivery_ids_for_spec(
    parts_path: &Path,
    cwd: &str,
    spec_dir: &str,
) -> Option<Option<Vec<DeliveryRef>>> {
    if std::fs::metadata(parts_path).is_err() {
        return Some(None);
    }
    let text = String::from_utf8(std::fs::read(parts_path).ok()?).ok()?;
    // `JSON.parse` that throws is `null`; `parse`'s `None` may also be a text Rust does not model.
    let raw = parse(&text)?;
    let parts = match validate(&raw) {
        Parsed::Valid(parts) => parts,
        Parsed::Invalid => return Some(None),
        Parsed::Unmodeled => return None,
    };
    let spec = resolve(cwd, spec_dir);
    let mut ids: Vec<&str> = Vec::new();
    for (delivery, linked) in &parts.parts {
        let Some(linked) = linked else { continue };
        let linked = resolve(cwd, linked);
        if (linked == spec || linked.starts_with(&format!("{spec}/")))
            && !ids.contains(&delivery.as_str())
        {
            ids.push(delivery);
        }
    }
    if ids.is_empty() {
        return Some(None);
    }
    Some(Some(
        parts
            .deliveries
            .iter()
            .filter(|(id, _, _)| ids.contains(&id.as_str()))
            .cloned()
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn ids_and_paths_follow_the_schema_patterns() {
        assert!(is_requirement("RNF-1") && is_requirement("RN-2") && !is_requirement("RX-1"));
        assert!(is_id("Src-1") && !is_id("1src") && !is_id("a_b"));
        assert!(is_relative("docs/a.md") && !is_relative("/a") && !is_relative("a/../b"));
        assert!(!is_relative("./a") && !is_relative("a\\..\\b"));
        assert_eq!(validate(&JsValue::Null), Parsed::Invalid);
    }
}
