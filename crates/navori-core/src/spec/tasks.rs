//! Port of the structural part of `lib/spec/tasks.ts` (`parseTasks`): format, deliveries with
//! their milestones, and the orphan and malformed items `plan gate` refuses. Criterion and task
//! details (commands, effects, tests) are not read by the gate and are not ported.

use std::sync::LazyLock;

use regex::Regex;

use crate::js_re::{DOT, ascii_case_insensitive, ws};

/// A `## E<n>` delivery and its `### M<n>` milestone ids, in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub id: String,
    pub milestones: Vec<String>,
}

/// What `plan gate` reads of a parsed `tasks.md`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedTasks {
    /// `true` for the delivery format, `false` for `legacy`.
    pub deliveries_format: bool,
    pub deliveries: Vec<Delivery>,
    pub orphan_tasks: usize,
    pub orphan_criteria: usize,
    pub malformed: usize,
    pub legacy_task_count: usize,
}

struct Patterns {
    fence_open: Regex,
    heading: Regex,
    delivery: Regex,
    milestone: Regex,
    loc: Regex,
    top_level: Regex,
    checkbox: Regex,
    criterion: Regex,
    consumes: Regex,
    retired: Regex,
    task_id: Regex,
}

static PATTERNS: LazyLock<Option<Patterns>> = LazyLock::new(|| {
    let s = ws();
    let numbered = |letter: char| format!(r"^{letter}([0-9]+)(?:{s}*[—–:-]{s}*|{s}+|$)({DOT}*)$");
    Some(Patterns {
        fence_open: Regex::new(&format!("^{s}*(`{{3,}}|~{{3,}})")).ok()?,
        heading: Regex::new(&format!(r"^(#{{1,6}}){s}+({DOT}*?){s}*#*{s}*$")).ok()?,
        delivery: Regex::new(&numbered('E')).ok()?,
        milestone: Regex::new(&numbered('M')).ok()?,
        loc: Regex::new(&format!(
            r"^{s}*(?:[-*]{s}+)?(?:\*\*)?{}(?:\*\*)?{s}*~?([0-9][0-9,_]*)",
            ascii_case_insensitive("Estimated LOC:")
        ))
        .ok()?,
        top_level: Regex::new(&format!(r"^(?:[-*+]|[0-9]+[.)]){s}")).ok()?,
        checkbox: Regex::new(&format!(r"^- \[([ xX])\] ({DOT}*)$")).ok()?,
        criterion: Regex::new(r"^- \*\*(A[0-9]+)\*\*").ok()?,
        consumes: Regex::new(r"^- \*\*Consumes:\*\*").ok()?,
        retired: Regex::new(r"^~~(T[0-9]+)~~").ok()?,
        task_id: Regex::new(r"^\*\*(T[0-9]+)\*\*").ok()?,
    })
});

/// `visibleLines`: the lines outside fenced regions (delimiters dropped), split on `\r?\n`.
fn visible_lines(text: &str, p: &Patterns) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut fence: Option<Regex> = None;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(close) = &fence {
            if close.is_match(line) {
                fence = None;
            }
            continue;
        }
        if let Some(run) = p.fence_open.captures(line).and_then(|c| c.get(1)) {
            let run = run.as_str();
            let ch = regex::escape(&run[..1]);
            let s = ws();
            fence = Some(Regex::new(&format!("^{s}*{ch}{{{},}}{s}*$", run.len())).ok()?);
            continue;
        }
        out.push(line.to_owned());
    }
    Some(out)
}

/// `parseTasks`, structural part. `None` only if a pattern failed to compile.
#[must_use]
pub fn parse_tasks(text: &str) -> Option<ParsedTasks> {
    let p = PATTERNS.as_ref()?;
    let lines = visible_lines(text, p)?;
    let heading = |line: &str| -> Option<(usize, String)> {
        let c = p.heading.captures(line)?;
        Some((c.get(1)?.as_str().len(), c.get(2)?.as_str().to_owned()))
    };
    let deliveries_format = lines.iter().any(|l| {
        heading(l).is_some_and(|(level, title)| level == 2 && p.delivery.is_match(&title))
    });
    let legacy_task_count = lines
        .iter()
        .filter(|l| {
            p.checkbox
                .captures(l)
                .and_then(|c| c.get(2))
                .is_some_and(|rest| !p.retired.is_match(rest.as_str()))
        })
        .count();
    let mut result = ParsedTasks {
        deliveries_format,
        legacy_task_count,
        ..ParsedTasks::default()
    };
    if !deliveries_format {
        return Some(result);
    }

    // `delivery` indexes `result.deliveries`; `loc_done` mirrors `estimatedLoc !== undefined`.
    let mut delivery: Option<usize> = None;
    let mut loc_done = false;
    let mut in_milestone = false;
    let is_block_start = |l: &str| p.heading.is_match(l) || p.top_level.is_match(l);
    let mut i = 0;
    while i < lines.len() {
        let current = &lines[i];
        if let Some((level, title)) = heading(current) {
            let delivery_match = (level == 2).then(|| p.delivery.captures(&title)).flatten();
            let milestone_match = (level == 3 && delivery.is_some())
                .then(|| p.milestone.captures(&title))
                .flatten();
            if let Some(c) = delivery_match {
                let id = format!("E{}", c.get(1).map_or("", |m| m.as_str()));
                result.deliveries.push(Delivery {
                    id,
                    milestones: Vec::new(),
                });
                delivery = Some(result.deliveries.len() - 1);
                loc_done = false;
                in_milestone = false;
            } else if let (Some(c), Some(d)) = (milestone_match, delivery) {
                let id = format!("M{}", c.get(1).map_or("", |m| m.as_str()));
                result.deliveries[d].milestones.push(id);
                in_milestone = true;
            } else if level <= 2 {
                delivery = None;
                in_milestone = false;
            } else if level == 3 {
                in_milestone = false;
            }
            i += 1;
            continue;
        }

        if delivery.is_some() && !in_milestone && !loc_done && p.loc.is_match(current) {
            loc_done = true;
            i += 1;
            continue;
        }

        if !p.top_level.is_match(current) {
            i += 1;
            continue;
        }
        while i + 1 < lines.len() && !is_block_start(&lines[i + 1]) {
            i += 1;
        }
        i += 1;

        if p.consumes.is_match(current) {
            continue;
        }
        if p.criterion.is_match(current) {
            if !in_milestone {
                result.orphan_criteria += 1;
            }
            continue;
        }
        let Some(rest) = p.checkbox.captures(current).and_then(|c| c.get(2)) else {
            continue;
        };
        let rest = rest.as_str();
        if p.retired.is_match(rest) {
            continue;
        }
        if !p.task_id.is_match(rest) {
            result.malformed += 1;
            continue;
        }
        if !in_milestone {
            result.orphan_tasks += 1;
        }
    }
    Some(result)
}
