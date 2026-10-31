//! What `plan gate` needs of `lib/plan/check.ts` (`checkWorkplan`): whether a workplan passes,
//! and its level. A failing workplan is never judged here: its message quotes zod issues and
//! evidence notes the gate hands to the TS, so every failure is [`Checked::NeedsTs`]. Rejecting
//! more than the TS is therefore safe; accepting what the TS rejects is a parity bug.

use std::collections::BTreeSet;

use crate::js_json::{JsObject, JsValue};
use crate::plan::classify::{ClassifyInput, classify, declared_flags_from_signals};
use crate::plan::expected::{Expected, parse_expected};
use crate::posix::js_trim;

/// The verdict of [`check_workplan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// `checkWorkplan(...).ok` with the workplan's `level` and `feature`.
    Ok { level: u8, feature: String },
    /// A failing workplan, or one Rust cannot judge exactly.
    NeedsTs,
}

/// Project context of `projectClassifyContext`: `project.criticalPaths` and `project.localSkills`.
#[derive(Debug, Clone, Default)]
pub struct ProjectContext {
    pub critical_paths: Option<Vec<String>>,
    pub local_skill_ids: Option<Vec<String>>,
}

type V<T> = Option<T>;

fn object(value: &JsValue) -> V<&JsObject> {
    match value {
        JsValue::Object(object) => Some(object),
        _ => None,
    }
}

fn text(value: &JsValue) -> V<String> {
    match value {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

fn non_empty(value: &JsValue) -> V<String> {
    text(value).filter(|s| !s.is_empty())
}

/// `z.number().int()` within `[min, max]`.
fn int_in(value: &JsValue, min: f64, max: f64) -> V<f64> {
    match value {
        JsValue::Number(n) if n.fract() == 0.0 && *n >= min && *n <= max => Some(*n),
        _ => None,
    }
}

fn level(value: &JsValue) -> V<u8> {
    let n = int_in(value, 0.0, 3.0)?;
    // `z.literal(0)` also matches `-0`; the cast keeps it 0.
    Some(n.abs() as u8)
}

fn array(value: &JsValue) -> V<&[JsValue]> {
    match value {
        JsValue::Array(items) => Some(items),
        _ => None,
    }
}

/// An optional field: absent is fine, present must satisfy `check`.
fn optional<T>(object: &JsObject, key: &str, check: impl Fn(&JsValue) -> V<T>) -> V<Option<T>> {
    match object.get(key) {
        None | Some(JsValue::Undefined) => Some(None),
        Some(value) => check(value).map(Some),
    }
}

/// `^A\d+$` on a record key or an id.
fn acceptance_id(id: &str) -> bool {
    id.strip_prefix('A')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn string_array(value: &JsValue) -> V<Vec<String>> {
    array(value)?.iter().map(text).collect()
}

fn record(value: &JsValue) -> V<Vec<(String, &JsValue)>> {
    let object = object(value)?;
    object
        .ordered()
        .into_iter()
        .map(|(key, value)| {
            let key = key.to_rust().filter(|k| acceptance_id(k))?;
            Some((key, value))
        })
        .collect()
}

pub(crate) struct Criterion {
    pub(crate) id: String,
    pub(crate) description: String,
    pub(crate) command: String,
    pub(crate) expected: String,
}

fn criterion(value: &JsValue) -> V<Criterion> {
    let o = object(value)?;
    let id = text(o.get("id")?).filter(|id| acceptance_id(id))?;
    let description = non_empty(o.get("description")?)?;
    Some(Criterion {
        id,
        description,
        command: non_empty(o.get("command")?)?,
        expected: non_empty(o.get("expected")?)?,
    })
}

fn progress_status(value: &JsValue) -> V<String> {
    let status = text(value)?;
    matches!(status.as_str(), "pendiente" | "cumplido" | "bloqueado").then_some(status)
}

/// One `evidence` entry (`AcceptanceEvidenceSchema`), with what `evidenceCase` reads.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Evidence {
    Recorded {
        command: String,
        head: String,
        ran_at: String,
        exit: Option<f64>,
        expected: Option<String>,
        outcome: Option<String>,
    },
    Unevidenced,
}

fn evidence(value: &JsValue) -> V<Evidence> {
    let o = object(value)?;
    match text(o.get("kind")?)?.as_str() {
        "recorded" => {
            for key in ["tree", "worktreeTree"] {
                non_empty(o.get(key)?)?;
            }
            let command = non_empty(o.get("command")?)?;
            let ran_at = non_empty(o.get("ranAt")?)?;
            let head = text(o.get("head")?)?;
            matches!(o.get("dirty")?, JsValue::Bool(_)).then_some(())?;
            let exit = optional(o, "exit", |v| int_in(v, 0.0, 255.0))?;
            let expected = optional(o, "expected", text)?;
            let outcome = optional(o, "outcome", |v| {
                let t = text(v)?;
                matches!(t.as_str(), "pass" | "fail" | "unevaluated").then_some(t)
            })?;
            Some(Evidence::Recorded {
                command,
                head,
                ran_at,
                exit,
                expected,
                outcome,
            })
        }
        "unevidenced" => {
            (text(o.get("reason")?)? == "engine-without-signal").then_some(Evidence::Unevidenced)
        }
        _ => None,
    }
}

fn pair(value: &JsValue, a: &str, b: &str) -> V<(String, String)> {
    let o = object(value)?;
    Some((non_empty(o.get(a)?)?, non_empty(o.get(b)?)?))
}

/// A workplan `WorkplanSchema` accepts, as zod returns it (defaults filled in).
pub(crate) struct Plan {
    pub(crate) feature: String,
    pub(crate) level: u8,
    pub(crate) score: f64,
    pub(crate) classification_level: u8,
    pub(crate) signals: Vec<String>,
    pub(crate) objective: String,
    pub(crate) request: Option<String>,
    pub(crate) acceptance: Vec<Criterion>,
    pub(crate) out_of_scope: Vec<String>,
    /// `(path, new)`.
    pub(crate) files: Vec<(String, bool)>,
    /// `(id, status)` in key order.
    pub(crate) progress: Vec<(String, String)>,
    pub(crate) evidence: Vec<(String, Evidence)>,
    /// `(text, date)`.
    pub(crate) decisions: Vec<(String, String)>,
    /// `(path, verdict)`.
    pub(crate) solution: Option<(String, String)>,
    pub(crate) phases: Option<Vec<(String, Vec<String>)>>,
    /// `(risk, rollback)`.
    pub(crate) risks: Option<Vec<(String, String)>>,
}

impl Plan {
    fn file_paths(&self) -> Vec<String> {
        self.files.iter().map(|(path, _)| path.clone()).collect()
    }

    pub(crate) fn status(&self, id: &str) -> Option<&str> {
        self.progress
            .iter()
            .rev()
            .find(|(key, _)| key == id)
            .map(|(_, status)| status.as_str())
    }

    pub(crate) fn evidence_of(&self, id: &str) -> Option<&Evidence> {
        self.evidence
            .iter()
            .rev()
            .find(|(key, _)| key == id)
            .map(|(_, evidence)| evidence)
    }
}

/// `WorkplanSchema.safeParse(raw).success`, with the fields the rules need. `source` (a master
/// delivery projection) is never judged here.
pub(crate) fn schema(raw: &JsValue) -> V<Plan> {
    let o = object(raw)?;
    let feature = non_empty(o.get("feature")?)?;
    let level = level(o.get("level")?)?;
    let classification = object(o.get("classification")?)?;
    let score = int_in(classification.get("score")?, 0.0, 10.0)?;
    let classification_level = self::level(classification.get("level")?)?;
    let signals = string_array(classification.get("signals")?)?;
    let objective = non_empty(o.get("objective")?)?;
    let request = optional(o, "request", |v| match v {
        JsValue::String(s) if !s.units().is_empty() && s.units().len() <= 20_000 => s.to_rust(),
        _ => None,
    })?;
    let acceptance: Vec<Criterion> = array(o.get("acceptance")?)?
        .iter()
        .map(criterion)
        .collect::<V<_>>()?;
    if acceptance.is_empty() {
        return None;
    }
    let out_of_scope = optional(o, "outOfScope", string_array)?.unwrap_or_default();
    let files = optional(o, "files", |v| {
        array(v)?
            .iter()
            .map(|f| {
                let f = object(f)?;
                let JsValue::Bool(new) = f.get("new")? else {
                    return None;
                };
                Some((non_empty(f.get("path")?)?, *new))
            })
            .collect::<V<Vec<_>>>()
    })?
    .unwrap_or_default();
    let progress = optional(o, "progress", |v| {
        record(v)?
            .into_iter()
            .map(|(k, v)| progress_status(v).map(|status| (k, status)))
            .collect::<V<Vec<_>>>()
    })?
    .unwrap_or_default();
    let evidence = optional(o, "evidence", |v| {
        record(v)?
            .into_iter()
            .map(|(k, v)| evidence(v).map(|e| (k, e)))
            .collect::<V<Vec<_>>>()
    })?
    .unwrap_or_default();
    let decisions = optional(o, "decisions", |v| {
        array(v)?
            .iter()
            .map(|d| pair(d, "text", "date"))
            .collect::<V<Vec<_>>>()
    })?
    .unwrap_or_default();
    let solution = optional(o, "solution", |v| {
        let s = object(v)?;
        let path = non_empty(s.get("path")?)?;
        let verdict = text(s.get("verdict")?)?;
        matches!(verdict.as_str(), "READY" | "CONCERNS" | "BLOCKED").then_some((path, verdict))
    })?;
    let phases = optional(o, "phases", |v| {
        array(v)?
            .iter()
            .map(|p| {
                let p = object(p)?;
                let name = non_empty(p.get("name")?)?;
                let ids = string_array(p.get("acceptance")?)?;
                ids.iter()
                    .all(|id| acceptance_id(id))
                    .then_some((name, ids))
            })
            .collect::<V<Vec<_>>>()
    })?;
    let risks = optional(o, "risks", |v| {
        array(v)?
            .iter()
            .map(|r| pair(r, "risk", "rollback"))
            .collect::<V<Vec<_>>>()
    })?;
    if o.get("source")
        .is_some_and(|s| !matches!(s, JsValue::Undefined))
    {
        return None;
    }
    Some(Plan {
        feature,
        level,
        classification_level,
        signals,
        score,
        objective,
        request,
        acceptance,
        out_of_scope,
        files,
        progress,
        evidence,
        decisions,
        solution,
        phases,
        risks,
    })
}

/// `checkStructural` has no finding.
fn structural(plan: &Plan, feature: &str) -> V<()> {
    let blocked = plan
        .solution
        .as_ref()
        .is_some_and(|(_, verdict)| verdict == "BLOCKED");
    if plan.feature != feature || blocked {
        return None;
    }
    let mut seen = BTreeSet::new();
    for c in &plan.acceptance {
        if !seen.insert(c.id.as_str())
            || js_trim(&c.command).is_empty()
            || js_trim(&c.expected).is_empty()
        {
            return None;
        }
        match parse_expected(&c.expected)? {
            Expected::Invalid(_) | Expected::NeedsJs => return None,
            Expected::Free | Expected::Exit(_) | Expected::Contains(_) => {}
        }
    }
    if plan
        .progress
        .iter()
        .any(|(id, _)| !seen.contains(id.as_str()))
    {
        return None;
    }
    let phases = plan.phases.as_deref().unwrap_or_default();
    if phases
        .iter()
        .flat_map(|(_, ids)| ids)
        .any(|id| !seen.contains(id.as_str()))
    {
        return None;
    }
    let risks = plan.risks.as_ref().map_or(0, Vec::len);
    if plan.level >= 2 && (plan.solution.is_none() || phases.is_empty() || risks == 0) {
        return None;
    }
    Some(())
}

/// `checkLevel` has no finding.
fn level_ok(plan: &Plan, project: &ProjectContext) -> V<()> {
    let input = ClassifyInput {
        files: plan.file_paths(),
        critical_paths: project.critical_paths.clone().unwrap_or_default(),
        local_skill_ids: project
            .local_skill_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect()),
        ..declared_flags_from_signals(&plan.signals)
    };
    let recomputed = classify(&input)?.level;
    (plan.classification_level.max(recomputed) <= plan.level).then_some(())
}

/// `checkWorkplan(raw, { cwd, feature }).ok` (evidence notes never fail it), with the level.
#[must_use]
pub fn check_workplan(raw: &JsValue, feature: &str, project: &ProjectContext) -> Checked {
    let verdict = schema(raw).and_then(|plan| {
        structural(&plan, feature)?;
        level_ok(&plan, project)?;
        Some(Checked::Ok {
            level: plan.level,
            feature: plan.feature,
        })
    });
    verdict.unwrap_or(Checked::NeedsTs)
}
