//! `_master/index.json` as `readMasterIndex` (`lib/master/stages.ts`) reads it: the zod schema of
//! `MasterIndexSchema` and the filesystem invariants, without their error texts.
//!
//! Every way the TS throws (bad JSON, a schema issue, a folder without entry or an entry without
//! folder) is [`Invalid`]: the native command hands that invocation to the TS, which prints the
//! exact message. Accepting an index zod rejects would be a parity bug; rejecting one it accepts
//! only costs a delegation.

use std::fs;
use std::path::Path;

use crate::js_json::{self, JsObject, JsValue};

/// `MASTER_DIR_NAME`.
pub const MASTER_DIR_NAME: &str = "_master";

/// `MASTER_STAGE_STATES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageState {
    Active,
    Closed,
    Converted,
    Abandoned,
}

impl StageState {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "activa" => Some(Self::Active),
            "cerrada" => Some(Self::Closed),
            "convertida" => Some(Self::Converted),
            "abandonada" => Some(Self::Abandoned),
            _ => None,
        }
    }

    /// The JSON spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "activa",
            Self::Closed => "cerrada",
            Self::Converted => "convertida",
            Self::Abandoned => "abandonada",
        }
    }
}

/// A `StageEntry` that passed the schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StageEntry {
    /// A positive integer, kept as the JS number it is.
    pub number: f64,
    pub slug: String,
    pub dir: String,
    pub state: StageState,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub spec: Option<String>,
    /// `workflow: "deliveries"`.
    pub deliveries: bool,
}

/// A `MasterIndex` that passed the schema and the filesystem invariants.
#[derive(Debug, Clone, PartialEq)]
pub struct MasterIndex {
    pub version: f64,
    pub stages: Vec<StageEntry>,
}

impl MasterIndex {
    /// `activeStage`.
    #[must_use]
    pub fn active(&self) -> Option<&StageEntry> {
        self.stages.iter().find(|s| s.state == StageState::Active)
    }

    /// `lastClosedStage`: the last `cerrada` entry.
    #[must_use]
    pub fn last_closed(&self) -> Option<&StageEntry> {
        self.stages
            .iter()
            .rev()
            .find(|s| s.state == StageState::Closed)
    }

    /// The object `MasterIndexSchema.parse` returns, in its key order: what `save` writes back.
    #[must_use]
    pub fn to_json(&self) -> JsValue {
        let optional =
            |value: &Option<String>| value.as_deref().map_or(JsValue::Null, JsValue::string);
        let stages = self
            .stages
            .iter()
            .map(|stage| {
                let mut entry = JsObject::new();
                entry.insert("number", JsValue::Number(stage.number));
                entry.insert("slug", JsValue::string(&stage.slug));
                entry.insert("dir", JsValue::string(&stage.dir));
                entry.insert("state", JsValue::string(stage.state.as_str()));
                entry.insert("openedAt", JsValue::string(&stage.opened_at));
                entry.insert("closedAt", optional(&stage.closed_at));
                entry.insert("spec", optional(&stage.spec));
                if stage.deliveries {
                    entry.insert("workflow", JsValue::string("deliveries"));
                }
                JsValue::Object(entry)
            })
            .collect();
        let mut index = JsObject::new();
        index.insert("version", JsValue::Number(self.version));
        index.insert("stages", JsValue::Array(stages));
        JsValue::Object(index)
    }
}

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `readMasterIndex` would throw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid;

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// `/^[a-z0-9]+(-[a-z0-9]+)*$/`, 1 to 40 characters.
fn is_slug(text: &str) -> bool {
    (1..=40).contains(&text.len())
        && text.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn string(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::String(text)) => text.to_rust(),
        _ => None,
    }
}

/// `string | null` with `.default(null)` when `default_null`, else required `string | null`.
fn nullable_string(
    object: &JsObject,
    key: &str,
    default_null: bool,
) -> Result<Option<String>, Invalid> {
    match object.get(key) {
        None | Some(JsValue::Undefined) if default_null => Ok(None),
        Some(JsValue::Null) => Ok(None),
        Some(JsValue::String(text)) => text.to_rust().map(Some).ok_or(Invalid),
        _ => Err(Invalid),
    }
}

fn stage_entry(value: &JsValue) -> Result<StageEntry, Invalid> {
    let JsValue::Object(object) = value else {
        return Err(Invalid);
    };
    let number = match object.get("number") {
        // zod 4 `.int()` is a safe integer.
        Some(JsValue::Number(n)) if n.fract() == 0.0 && *n > 0.0 && *n <= MAX_SAFE_INTEGER => *n,
        _ => return Err(Invalid),
    };
    let slug = string(object.get("slug"))
        .filter(|s| is_slug(s))
        .ok_or(Invalid)?;
    let dir = string(object.get("dir"))
        .filter(|s| !s.is_empty())
        .ok_or(Invalid)?;
    let state = string(object.get("state"))
        .as_deref()
        .and_then(StageState::parse)
        .ok_or(Invalid)?;
    let opened_at = string(object.get("openedAt"))
        .filter(|s| is_date(s))
        .ok_or(Invalid)?;
    let closed_at = nullable_string(object, "closedAt", false)?;
    if closed_at.as_deref().is_some_and(|d| !is_date(d)) {
        return Err(Invalid);
    }
    let spec = nullable_string(object, "spec", true)?;
    if spec.as_deref() == Some("") {
        return Err(Invalid);
    }
    let deliveries = match object.get("workflow") {
        None | Some(JsValue::Undefined) => false,
        Some(JsValue::String(text)) if text.is("deliveries") => true,
        _ => return Err(Invalid),
    };
    // superRefine: `dir` is `NN-slug`, `closedAt` matches the state, `spec` only when converted.
    let expected_dir = format!("{:0>2}-{slug}", crate::js_json::number_to_js(number));
    let refined = dir == expected_dir
        && ((state == StageState::Active) == closed_at.is_none())
        && (state == StageState::Converted || spec.is_none());
    if !refined {
        return Err(Invalid);
    }
    Ok(StageEntry {
        number,
        slug,
        dir,
        state,
        opened_at,
        closed_at,
        spec,
        deliveries,
    })
}

/// `MasterIndexSchema.safeParse(raw)` when it succeeds.
fn schema(raw: &JsValue) -> Result<MasterIndex, Invalid> {
    let JsValue::Object(object) = raw else {
        return Err(Invalid);
    };
    let version = match object.get("version") {
        Some(JsValue::Number(n)) if *n == 1.0 || *n == 2.0 => *n,
        _ => return Err(Invalid),
    };
    let stages = match object.get("stages") {
        None | Some(JsValue::Undefined) => Vec::new(),
        Some(JsValue::Array(items)) => items.iter().map(stage_entry).collect::<Result<_, _>>()?,
        _ => return Err(Invalid),
    };
    let one_active = stages
        .iter()
        .filter(|s| s.state == StageState::Active)
        .count()
        <= 1;
    let increasing = stages.windows(2).all(|w| w[1].number > w[0].number);
    let deliveries_need_v2 = version != 1.0 || stages.iter().all(|s| !s.deliveries);
    if !(one_active && increasing && deliveries_need_v2) {
        return Err(Invalid);
    }
    Ok(MasterIndex { version, stages })
}

/// `checkFilesystemInvariants`: every `NN-*` folder has an entry, every non-active entry a folder.
fn filesystem_ok(master_dir: &Path, index: &MasterIndex) -> bool {
    let on_disk: Vec<String> = match fs::read_dir(master_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| {
                let b = name.as_bytes();
                b.len() >= 3 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2] == b'-'
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    let every_folder_has_entry = on_disk
        .iter()
        .all(|name| index.stages.iter().any(|s| &s.dir == name));
    let every_entry_has_folder = index
        .stages
        .iter()
        .filter(|s| s.state != StageState::Active)
        .all(|s| master_dir.join(&s.dir).exists());
    every_folder_has_entry && every_entry_has_folder
}

/// `readMasterIndex(cwd, specsDir)` with `master_dir` = `resolve(cwd, specsDir, "_master")`:
/// `Ok(None)` when `index.json` does not exist.
///
/// # Errors
/// [`Invalid`] wherever the TS throws, or the file is not UTF-8.
pub fn read(master_dir: &Path) -> Result<Option<MasterIndex>, Invalid> {
    let path = master_dir.join("index.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|_| Invalid)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| Invalid)?;
    let raw = js_json::parse(text).ok_or(Invalid)?;
    let index = schema(&raw)?;
    if !filesystem_ok(master_dir, &index) {
        return Err(Invalid);
    }
    Ok(Some(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<MasterIndex, Invalid> {
        schema(&js_json::parse(text).ok_or(Invalid)?)
    }

    const CLOSED: &str = r#"{"number":1,"slug":"uno","dir":"01-uno","state":"cerrada","openedAt":"2026-01-01","closedAt":"2026-01-02"}"#;

    #[test]
    fn accepts_what_the_schema_accepts() {
        let index = parse(&format!(r#"{{"version":1,"stages":[{CLOSED}]}}"#));
        assert_eq!(
            index.map(|i| i.last_closed().map(|s| s.dir.clone())),
            Ok(Some("01-uno".to_owned()))
        );
        assert_eq!(parse(r#"{"version":2}"#).map(|i| i.stages.len()), Ok(0));
    }

    #[test]
    fn rejects_every_schema_issue() {
        for bad in [
            r#"{"version":3}"#,
            r#"{"version":1,"stages":null}"#,
            r#"{"version":1,"stages":[{"number":1,"slug":"uno","dir":"1-uno","state":"cerrada","openedAt":"2026-01-01","closedAt":"2026-01-02"}]}"#,
            r#"{"version":1,"stages":[{"number":1,"slug":"Uno","dir":"01-Uno","state":"cerrada","openedAt":"2026-01-01","closedAt":"2026-01-02"}]}"#,
            r#"{"version":1,"stages":[{"number":1,"slug":"uno","dir":"01-uno","state":"activa","openedAt":"2026-01-01","closedAt":"2026-01-02"}]}"#,
            r#"{"version":1,"stages":[{"number":1,"slug":"uno","dir":"01-uno","state":"cerrada","openedAt":"2026-01-01","closedAt":null}]}"#,
            r#"{"version":1,"stages":[{"number":1,"slug":"uno","dir":"01-uno","state":"cerrada","openedAt":"2026-01-01","closedAt":"2026-01-02","spec":"s"}]}"#,
            r#"{"version":1,"stages":[{"number":1,"slug":"uno","dir":"01-uno","state":"activa","openedAt":"2026-01-01","closedAt":null,"workflow":"deliveries"}]}"#,
            r#"{"version":2,"stages":[{"number":9007199254740992,"slug":"uno","dir":"9007199254740992-uno","state":"activa","openedAt":"2026-01-01","closedAt":null}]}"#,
            r#"{"version":2,"stages":[{"number":1.5,"slug":"uno","dir":"01-uno","state":"activa","openedAt":"2026-01-01","closedAt":null}]}"#,
        ] {
            assert_eq!(parse(bad), Err(Invalid), "{bad}");
        }
        let two_active = r#"{"version":1,"stages":[{"number":1,"slug":"a","dir":"01-a","state":"activa","openedAt":"2026-01-01","closedAt":null},{"number":2,"slug":"b","dir":"02-b","state":"activa","openedAt":"2026-01-01","closedAt":null}]}"#;
        assert_eq!(parse(two_active), Err(Invalid));
        let decreasing = format!(
            r#"{{"version":1,"stages":[{},{CLOSED}]}}"#,
            CLOSED
                .replace(r#""number":1"#, r#""number":2"#)
                .replace("01-uno", "02-uno")
        );
        assert_eq!(parse(&decreasing), Err(Invalid));
    }
}
