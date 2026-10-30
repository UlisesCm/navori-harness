//! Structural validation of a `tasks.md`, port of `checkSpec` (`lib/spec/check.ts`, spec 0044
//! R11-R14). The master-plan mapping (R22) is not ported: the caller hands a spec that belongs to
//! a master plan to the TS.

use std::collections::{HashMap, HashSet};

use super::classify::{Classification, Shape, Thresholds, classify};
use super::tasks::{Format, ParsedTasks, Task};
use super::text::utf16_prefix;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// A `SpecFinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub rule: &'static str,
    pub severity: Severity,
    pub where_: String,
    pub message: String,
    pub line: Option<usize>,
}

/// A `SpecCheck`.
#[derive(Debug, Clone, PartialEq)]
pub struct SpecCheck {
    pub format: Format,
    pub ok: bool,
    pub findings: Vec<Finding>,
    pub classification: Classification,
}

/// A message the TS would build with a lone surrogate, which this port does not model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoneSurrogate;

/// Effects that alone never change observable behavior (R12).
const NON_BEHAVIOR: [&str; 3] = ["docs", "tests", "schema"];

struct Findings(Vec<Finding>);

impl Findings {
    fn add(
        &mut self,
        rule: &'static str,
        severity: Severity,
        where_: &str,
        message: String,
        line: Option<usize>,
    ) {
        self.0.push(Finding {
            rule,
            severity,
            where_: where_.to_owned(),
            message,
            line,
        });
    }
}

/// `checkSpec(parsed, thresholds, requirementIds, null)`.
///
/// # Errors
/// [`LoneSurrogate`] when a malformed item's 60-unit excerpt would split a surrogate pair.
#[expect(
    clippy::too_many_lines,
    reason = "one function per TS function keeps the port line-for-line comparable"
)]
pub fn check(
    parsed: &ParsedTasks,
    thresholds: Thresholds,
    requirement_ids: Option<&[String]>,
) -> Result<SpecCheck, LoneSurrogate> {
    use Severity::{Error, Warning};
    let classification = classify(parsed, thresholds);
    let mut findings = Findings(Vec::new());

    if parsed.format == Format::Legacy {
        for warning in &classification.warnings {
            findings.add(
                "legacy-format",
                Warning,
                &warning.where_,
                warning.message.clone(),
                None,
            );
        }
        return Ok(SpecCheck {
            format: parsed.format,
            ok: true,
            findings: findings.0,
            classification,
        });
    }

    if let Some(error) = &classification.error {
        findings.add(
            "too-many-deliveries",
            Error,
            "tasks.md",
            error.what.clone(),
            None,
        );
    }
    for warning in &classification.warnings {
        if warning.rule == "completed-over-budget" {
            findings.add(
                warning.rule,
                Warning,
                &warning.where_,
                warning.message.clone(),
                None,
            );
        }
    }
    let vertical_severity = if classification.shape == Shape::Split {
        Error
    } else {
        Warning
    };

    let mut seen: HashMap<String, String> = HashMap::new();
    let mut claim = |findings: &mut Findings, id: &str, where_: &str, line: usize| {
        if let Some(first) = seen.get(id) {
            findings.add(
                "duplicate-id",
                Error,
                where_,
                format!("{id} is already declared in {first}"),
                Some(line),
            );
        } else {
            seen.insert(id.to_owned(), where_.to_owned());
        }
    };

    let mut task_owner: HashMap<String, String> = HashMap::new();
    let mut covered: HashSet<String> = HashSet::new();
    let mut count_task = |findings: &mut Findings, task: &Task, where_: &str| {
        covered.extend(task.requirements.iter().cloned());
        if let Some(first) = task_owner.get(&task.id) {
            findings.add(
                "task-duplicated",
                Error,
                &task.id,
                format!("{} is declared in {first} and in {where_}", task.id),
                Some(task.line),
            );
        } else {
            task_owner.insert(task.id.clone(), where_.to_owned());
        }
        if task.effect.is_none() {
            let message = task.effect_raw.as_ref().map_or_else(
                || {
                    format!(
                        "{} declares no \"effect:\" (behavior, docs, tests or schema)",
                        task.id
                    )
                },
                |raw| {
                    format!(
                        "{} declares effect \"{raw}\", not one of behavior, docs, tests, schema",
                        task.id
                    )
                },
            );
            findings.add(
                "task-without-effect",
                Warning,
                &task.id,
                message,
                Some(task.line),
            );
        }
    };

    for (index, delivery) in parsed.deliveries.iter().enumerate() {
        claim(&mut findings, &delivery.id, &delivery.id, delivery.line);
        if delivery.milestones.is_empty() {
            findings.add(
                "delivery-without-milestone",
                Error,
                &delivery.id,
                format!("{} declares no milestone (### M<n>)", delivery.id),
                Some(delivery.line),
            );
        }
        if delivery.foundation {
            if index != 0 {
                findings.add(
                    "foundation-not-first",
                    Error,
                    &delivery.id,
                    format!(
                        "{} is marked (foundation) but is not the first delivery",
                        delivery.id
                    ),
                    Some(delivery.line),
                );
            }
            if !delivery.milestones.iter().any(|m| !m.consumers.is_empty()) {
                findings.add(
                    "foundation-without-consumer",
                    Error,
                    &delivery.id,
                    format!(
                        "{} is a foundation but none of its milestones has a \"- **Consumes:**\" line naming a consumer inside the delivery",
                        delivery.id
                    ),
                    Some(delivery.line),
                );
            }
        }
        for milestone in &delivery.milestones {
            claim(
                &mut findings,
                &milestone.id,
                &format!("{}/{}", delivery.id, milestone.id),
                milestone.line,
            );
            if milestone.criteria.is_empty() {
                findings.add(
                    "milestone-without-acceptance",
                    Error,
                    &milestone.id,
                    format!(
                        "{} declares no acceptance criterion (- **A<n>**)",
                        milestone.id
                    ),
                    Some(milestone.line),
                );
            }
            for criterion in &milestone.criteria {
                claim(&mut findings, &criterion.id, &milestone.id, criterion.line);
                let missing: Vec<&str> = [
                    (criterion.command.is_empty(), "a command in backticks"),
                    (
                        criterion.expected.is_empty(),
                        "an expected output after \"→\"",
                    ),
                ]
                .into_iter()
                .filter_map(|(absent, part)| absent.then_some(part))
                .collect();
                if !missing.is_empty() {
                    findings.add(
                        "acceptance-malformed",
                        Error,
                        &criterion.id,
                        format!("{} lacks {}", criterion.id, missing.join(" and ")),
                        Some(criterion.line),
                    );
                }
            }
            for task in &milestone.tasks {
                count_task(&mut findings, task, &milestone.id);
            }
        }

        let mut tasks = delivery.milestones.iter().flat_map(|m| m.tasks.iter());
        let has_tasks = delivery.milestones.iter().any(|m| !m.tasks.is_empty());
        let observable = delivery
            .milestones
            .iter()
            .any(|m| m.criteria.iter().any(|c| c.observable));
        if has_tasks
            && !observable
            && tasks.all(|t| t.effect.is_some_and(|e| NON_BEHAVIOR.contains(&e)))
        {
            findings.add(
                "delivery-not-vertical",
                vertical_severity,
                &delivery.id,
                format!(
                    "{} only changes docs, tests or schema and has no [observable] acceptance criterion; it is not a functional delivery",
                    delivery.id
                ),
                Some(delivery.line),
            );
        }
    }

    for task in &parsed.orphan_tasks {
        findings.add(
            "task-outside-milestone",
            Error,
            &task.id,
            format!("{} is not inside any milestone (### M<n>)", task.id),
            Some(task.line),
        );
        count_task(&mut findings, task, "no milestone");
    }
    for criterion in &parsed.orphan_criteria {
        findings.add(
            "task-outside-milestone",
            Error,
            &criterion.id,
            format!("{} is not inside any milestone (### M<n>)", criterion.id),
            Some(criterion.line),
        );
    }
    for item in &parsed.malformed {
        let excerpt = utf16_prefix(&item.text, 60).ok_or(LoneSurrogate)?;
        findings.add(
            "task-malformed",
            Error,
            &format!("line {}", item.line),
            format!("checkbox item without a \"**T<n>**\" id: {excerpt}"),
            Some(item.line),
        );
    }

    match requirement_ids {
        None => findings.add(
            "requirements-unreadable",
            Error,
            "requirements.md",
            "requirements.md could not be read; requirement coverage was not checked".to_owned(),
            None,
        ),
        Some(ids) => {
            let known: HashSet<&str> = ids.iter().map(String::as_str).collect();
            for id in ids {
                if !covered.contains(id) {
                    findings.add(
                        "requirement-uncovered",
                        Error,
                        id,
                        format!("{id} of requirements.md is not covered by any task"),
                        None,
                    );
                }
            }
            for task in parsed.all_tasks() {
                for r in &task.requirements {
                    if !known.contains(r.as_str()) {
                        findings.add(
                            "unknown-requirement",
                            Error,
                            &task.id,
                            format!(
                                "{} cites {r}, which requirements.md does not declare",
                                task.id
                            ),
                            Some(task.line),
                        );
                    }
                }
            }
        }
    }

    let ok = !findings.0.iter().any(|f| f.severity == Error);
    Ok(SpecCheck {
        format: parsed.format,
        ok,
        findings: findings.0,
        classification,
    })
}
