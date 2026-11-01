//! `plan check`'s full report (`checkWorkplan` with `evidence: "finding"`) and the workplan's
//! Markdown (`renderWorkplan`), over a workplan [`schema`] accepts (spec 0060 T11, R73).
//!
//! A workplan zod rejects quotes zod's issues, a well-shaped `matches:` needs a JS `RegExp` and a
//! `source` needs the master delivery: each is `None`, and the command hands it to the TS.

use std::collections::BTreeSet;

use crate::js_json::{JsValue, number_to_js};
use crate::plan::check::{Criterion, Evidence, Plan, ProjectContext, schema};
use crate::plan::classify::{ClassifyInput, classify, declared_flags_from_signals};
use crate::plan::expected::{Expected, parse_expected};
use crate::posix::js_trim;

/// One `CheckFinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub rule: &'static str,
    pub message: String,
}

/// `CheckResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub ok: bool,
    pub findings: Vec<Finding>,
    pub warnings: Vec<Finding>,
}

fn finding(rule: &'static str, message: String) -> Finding {
    Finding { rule, message }
}

/// `expectedEvidenceProblem(expected, evidence) === undefined`; `None` for a `matches:` only JS
/// can judge.
fn evidence_ok(
    expected: &str,
    exit: Option<f64>,
    recorded: Option<&str>,
    outcome: Option<&str>,
) -> Option<bool> {
    let spec = parse_expected(expected)?;
    let code = match &spec {
        Expected::Invalid(_) => return Some(false),
        Expected::NeedsJs => return None,
        Expected::Exit(code) => f64::from(*code),
        Expected::Free | Expected::Contains(_) => 0.0,
    };
    if exit.is_none() && recorded.is_none() && outcome.is_none() {
        return Some(matches!(spec, Expected::Free | Expected::Exit(0)));
    }
    if matches!(outcome, Some("unevaluated" | "fail")) {
        return Some(false);
    }
    if recorded.is_some_and(|r| r != expected) {
        return Some(false);
    }
    if spec == Expected::Free {
        return Some(exit == Some(0.0));
    }
    if recorded != Some(expected) || outcome != Some("pass") {
        return Some(false);
    }
    Some(exit == Some(code))
}

/// `EvidenceCase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Case {
    Recorded,
    UnevidencedAccepted,
    None,
    Stale,
    Uncompared,
}

/// `evidenceCase(plan, criterion)`.
fn evidence_case(plan: &Plan, criterion: &Criterion) -> Option<Case> {
    Some(match plan.evidence_of(&criterion.id) {
        None => Case::None,
        Some(Evidence::Unevidenced) => {
            if parse_expected(&criterion.expected)? == Expected::Free {
                Case::UnevidencedAccepted
            } else {
                Case::Uncompared
            }
        }
        Some(Evidence::Recorded {
            command,
            exit,
            expected,
            outcome,
            ..
        }) => {
            if *command != criterion.command {
                Case::Stale
            } else if evidence_ok(
                &criterion.expected,
                *exit,
                expected.as_deref(),
                outcome.as_deref(),
            )? {
                Case::Recorded
            } else {
                Case::Uncompared
            }
        }
    })
}

fn structural(plan: &Plan, feature: &str) -> Option<Vec<Finding>> {
    let mut findings = Vec::new();
    if plan.feature != feature {
        findings.push(finding(
            "feature-mismatch",
            format!("workplan feature \"{}\" is not \"{feature}\"", plan.feature),
        ));
    }
    if let Some((path, verdict)) = &plan.solution
        && verdict == "BLOCKED"
    {
        findings.push(finding(
            "solution-blocked",
            format!("solution {path} has verdict BLOCKED"),
        ));
    }
    let mut seen = BTreeSet::new();
    for c in &plan.acceptance {
        if !seen.insert(c.id.as_str()) {
            findings.push(finding(
                "acceptance-duplicate-id",
                format!("acceptance id {} is declared more than once", c.id),
            ));
        }
    }
    for c in &plan.acceptance {
        if js_trim(&c.command).is_empty() {
            findings.push(finding(
                "acceptance-command",
                format!("{} is missing a command", c.id),
            ));
        }
        if js_trim(&c.expected).is_empty() {
            findings.push(finding(
                "acceptance-expected",
                format!("{} is missing expected output", c.id),
            ));
        }
        match parse_expected(&c.expected)? {
            Expected::Invalid(reason) => findings.push(finding(
                "acceptance-expected-invalid",
                format!("{}: {reason}", c.id),
            )),
            Expected::NeedsJs => return None,
            Expected::Free | Expected::Exit(_) | Expected::Contains(_) => {}
        }
    }
    for (id, _) in &plan.progress {
        if !seen.contains(id.as_str()) {
            findings.push(finding(
                "progress-unknown-id",
                format!("progress references unknown id {id}"),
            ));
        }
    }
    for (name, ids) in plan.phases.as_deref().unwrap_or_default() {
        for id in ids {
            if !seen.contains(id.as_str()) {
                findings.push(finding(
                    "phase-unknown-id",
                    format!("phase \"{name}\" references unknown id {id}"),
                ));
            }
        }
    }
    if plan.level >= 2 {
        if plan.solution.is_none() {
            findings.push(finding(
                "level2-solution",
                "level 2 requires a solution section".to_owned(),
            ));
        }
        if plan.phases.as_ref().is_none_or(Vec::is_empty) {
            findings.push(finding(
                "level2-phases",
                "level 2 requires at least one phase".to_owned(),
            ));
        }
        if plan.risks.as_ref().is_none_or(Vec::is_empty) {
            findings.push(finding(
                "level2-risks",
                "level 2 requires at least one risk with rollback".to_owned(),
            ));
        }
    }
    Some(findings)
}

/// `checkLevel(plan, cwd)`.
fn level_finding(plan: &Plan, project: &ProjectContext) -> Option<Option<Finding>> {
    let input = ClassifyInput {
        files: plan.files.iter().map(|(path, _)| path.clone()).collect(),
        critical_paths: project.critical_paths.clone().unwrap_or_default(),
        local_skill_ids: project
            .local_skill_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect()),
        ..declared_flags_from_signals(&plan.signals)
    };
    let recomputed = classify(&input)?.level;
    let embedded = plan.classification_level;
    let expected = embedded.max(recomputed);
    if expected <= plan.level {
        return Some(None);
    }
    let winner = if recomputed > embedded {
        format!("recomputed level {recomputed}")
    } else {
        format!("embedded level {embedded}")
    };
    Some(Some(finding(
        "level-below-classification",
        format!(
            "declared level {} is below classify's level {expected} ({winner})",
            plan.level
        ),
    )))
}

/// `checkWorkplan(raw, { cwd, feature, evidence: "finding" })` for a workplan zod accepts.
/// `None` where only the TS can answer.
#[must_use]
pub fn check_report(raw: &JsValue, feature: &str, project: &ProjectContext) -> Option<Report> {
    let plan = schema(raw)?;
    let mut findings = structural(&plan, feature)?;
    findings.extend(level_finding(&plan, project)?);
    let mut warnings = Vec::new();
    for c in &plan.acceptance {
        if plan.status(&c.id) != Some("cumplido") {
            continue;
        }
        let note = match evidence_case(&plan, c)? {
            Case::Recorded => continue,
            Case::Uncompared => finding(
                "progress-expected-unverified",
                format!(
                    "{} is cumplido but its expected value has no valid comparison",
                    c.id
                ),
            ),
            Case::UnevidencedAccepted => {
                warnings.push(finding(
                    "progress-unevidenced-accepted",
                    format!(
                        "{} is cumplido without evidence (engine without a Bash success signal)",
                        c.id
                    ),
                ));
                continue;
            }
            Case::None => finding(
                "progress-unevidenced",
                format!("{} is cumplido with no recorded evidence", c.id),
            ),
            Case::Stale => finding(
                "progress-evidence-stale",
                format!(
                    "{} is cumplido but its evidence is for a different command",
                    c.id
                ),
            ),
        };
        findings.push(note);
    }
    Some(Report {
        ok: findings.is_empty(),
        findings,
        warnings,
    })
}

/// `formatCheckResult`.
#[must_use]
pub fn format_report(report: &Report) -> String {
    let body: Vec<String> = if report.ok {
        vec!["OK".to_owned()]
    } else {
        report
            .findings
            .iter()
            .map(|f| format!("{}: {}", f.rule, f.message))
            .collect()
    };
    body.into_iter()
        .chain(
            report
                .warnings
                .iter()
                .map(|w| format!("warning {}: {}", w.rule, w.message)),
        )
        .collect::<Vec<_>>()
        .join("\n")
}

/// `statusLabel(plan, criterion)`.
fn status_label(plan: &Plan, c: &Criterion) -> Option<String> {
    let status = plan.status(&c.id).unwrap_or("pendiente");
    if status != "cumplido" {
        return Some(status.to_owned());
    }
    Some(match evidence_case(plan, c)? {
        Case::Recorded => match plan.evidence_of(&c.id) {
            Some(Evidence::Recorded { head, ran_at, .. }) => {
                // `head.slice(0, 7)`: UTF-16 units; a non-ASCII head is the TS's.
                if !head.is_ascii() {
                    return None;
                }
                format!("cumplido · {} · {ran_at}", &head[..head.len().min(7)])
            }
            _ => "cumplido".to_owned(),
        },
        Case::UnevidencedAccepted => "cumplido, sin evidencia: engine sin señal".to_owned(),
        Case::Stale => "cumplido, evidencia de otro comando".to_owned(),
        Case::Uncompared => "cumplido, expected sin verificación válida".to_owned(),
        Case::None => "cumplido, sin evidencia".to_owned(),
    })
}

fn bullets(items: impl Iterator<Item = String>) -> String {
    let lines: Vec<String> = items.collect();
    if lines.is_empty() {
        "- (none)".to_owned()
    } else {
        lines.join("\n")
    }
}

/// `renderWorkplan(plan)`.
fn render(plan: &Plan) -> Option<String> {
    let mut acceptance = Vec::new();
    for a in &plan.acceptance {
        acceptance.push(format!(
            "- **{}** ({}) — {}\n  - command: `{}`\n  - expected: {}",
            a.id,
            status_label(plan, a)?,
            a.description,
            a.command,
            a.expected
        ));
    }
    let breakdown = if plan.signals.is_empty() {
        "(no signals)".to_owned()
    } else {
        plan.signals.join(", ")
    };
    let mut sections = vec![
        format!("# Workplan — {}", plan.feature),
        String::new(),
        "## Clasificación".to_owned(),
        format!(
            "Complexity: {}/10 · Level: {}\nSignals: {breakdown}",
            number_to_js(plan.score),
            plan.classification_level
        ),
        String::new(),
        "## Objetivo".to_owned(),
        plan.objective.clone(),
        String::new(),
    ];
    if let Some(request) = &plan.request {
        sections.extend([
            "## Solicitud original".to_owned(),
            request
                .split('\n')
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n"),
            String::new(),
        ]);
    }
    sections.extend([
        "## Criterios".to_owned(),
        acceptance.join("\n"),
        String::new(),
        "## Fuera de alcance".to_owned(),
        bullets(plan.out_of_scope.iter().map(|item| format!("- {item}"))),
        String::new(),
        "## Archivos".to_owned(),
        bullets(
            plan.files
                .iter()
                .map(|(path, new)| format!("- {path}{}", if *new { " (new)" } else { "" })),
        ),
        String::new(),
        "## Decisiones".to_owned(),
        bullets(
            plan.decisions
                .iter()
                .map(|(text, date)| format!("- {date} — {text}")),
        ),
    ]);
    if plan.level >= 2 {
        sections.extend([String::new(), "## Solución".to_owned()]);
        sections.push(plan.solution.as_ref().map_or_else(
            || "- (none)".to_owned(),
            |(path, verdict)| format!("{path} — verdict: {verdict}"),
        ));
        sections.extend([String::new(), "## Fases".to_owned()]);
        sections.push(bullets(
            plan.phases
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|(name, ids)| {
                    let ids = if ids.is_empty() {
                        "(no acceptance)".to_owned()
                    } else {
                        ids.join(", ")
                    };
                    format!("- **{name}** — {ids}")
                }),
        ));
        sections.extend([String::new(), "## Riesgos y rollback".to_owned()]);
        sections.push(bullets(
            plan.risks
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|(risk, rollback)| format!("- {risk} — rollback: {rollback}")),
        ));
    }
    Some(format!("{}\n", sections.join("\n")))
}

/// `renderWorkplan(WorkplanSchema.parse(raw))`; `None` for a workplan zod rejects (its message
/// is zod's), a `source`, or a label only JS can compute.
#[must_use]
pub fn render_workplan(raw: &JsValue) -> Option<String> {
    render(&schema(raw)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(extra: &str) -> JsValue {
        let text = format!(
            r#"{{"feature":"f","level":1,"classification":{{"score":3,"level":1,"signals":["root-dirs:2(+1)"]}},"objective":"o","acceptance":[{{"id":"A1","description":"d","command":"c","expected":"exit 0"}}]{extra}}}"#
        );
        crate::js_json::parse(&text).unwrap_or(JsValue::Null)
    }

    // Covers: R73
    #[test]
    fn the_report_lists_findings_and_evidence_notes_like_the_ts() {
        let project = ProjectContext::default();
        let ok = check_report(&plan(""), "f", &project);
        assert_eq!(ok.map(|r| format_report(&r)).as_deref(), Some("OK"));
        let report = check_report(
            &plan(r#","progress":{"A1":"cumplido","A9":"pendiente"},"level":2"#),
            "g",
            &project,
        );
        let rules: Vec<&str> = report
            .iter()
            .flat_map(|r| r.findings.iter().map(|f| f.rule))
            .collect();
        assert_eq!(
            rules,
            [
                "feature-mismatch",
                "progress-unknown-id",
                "level2-solution",
                "level2-phases",
                "level2-risks",
                "progress-unevidenced"
            ]
        );
        let needs_js = plan(
            r#","acceptance":[{"id":"A1","description":"d","command":"c","expected":"matches: /a/"}]"#,
        );
        assert_eq!(check_report(&needs_js, "f", &project), None);
        assert_eq!(check_report(&plan(r#","level":7"#), "f", &project), None);
    }

    // Covers: R73
    #[test]
    fn structured_evidence_compares_like_expected_evidence_problem() {
        assert_eq!(evidence_ok("exit 0", None, None, None), Some(true));
        assert_eq!(evidence_ok("exit 2", None, None, None), Some(false));
        assert_eq!(evidence_ok("prose", Some(0.0), None, None), Some(true));
        assert_eq!(evidence_ok("prose", Some(1.0), None, None), Some(false));
        assert_eq!(
            evidence_ok("exit 2", Some(2.0), Some("exit 2"), Some("pass")),
            Some(true)
        );
        assert_eq!(
            evidence_ok("contains: x", Some(0.0), Some("contains: x"), Some("fail")),
            Some(false)
        );
        assert_eq!(evidence_ok("matches: /x/", Some(0.0), None, None), None);
    }

    // Covers: R73
    #[test]
    fn the_markdown_renders_each_section() {
        let text = render_workplan(&plan(
            r#","request":"a\nb","files":[{"path":"x.ts","new":true}],"decisions":[{"text":"t","date":"2026-01-01"}]"#,
        ))
        .unwrap_or_default();
        assert!(text.starts_with("# Workplan — f\n\n## Clasificación\nComplexity: 3/10 · Level: 1\nSignals: root-dirs:2(+1)\n"), "{text}");
        assert!(text.contains("## Solicitud original\n> a\n> b\n"), "{text}");
        assert!(
            text.contains("- **A1** (pendiente) — d\n  - command: `c`\n  - expected: exit 0\n"),
            "{text}"
        );
        assert!(
            text.ends_with("## Decisiones\n- 2026-01-01 — t\n"),
            "{text}"
        );
    }
}
