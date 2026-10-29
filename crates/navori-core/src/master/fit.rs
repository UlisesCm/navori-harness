//! `evaluateFit` (`lib/master/fit.ts`): D9's mechanical fit criteria over a stage's `DIGEST.md` and
//! `CODEBASE.md`. J1–J3 stay human judgment.

use regex::Regex;

use super::templates::split_template_sections;
use crate::integrity::is_js_whitespace;
use crate::spec::text::ci;

/// A criterion's value or threshold: a count or a flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FitValue {
    Count(usize),
    Flag(bool),
}

impl FitValue {
    /// `String(value)`.
    #[must_use]
    pub fn text(self) -> String {
        match self {
            Self::Count(n) => n.to_string(),
            Self::Flag(b) => b.to_string(),
        }
    }
}

/// A `FitCriterion`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FitCriterion {
    pub id: &'static str,
    pub value: FitValue,
    pub threshold: FitValue,
    pub pass: bool,
}

/// A `FitResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FitResult {
    pub verifiable: Vec<FitCriterion>,
    pub all_verifiable_pass: bool,
}

const COUNT_CRITERIA: [(&str, [&str; 2], usize); 5] = [
    ("V1", ["Capacidades", "Capabilities"], 8),
    ("V2", ["Actores", "Actors"], 3),
    ("V3", ["Integraciones externas", "External integrations"], 1),
    ("V4", ["Entidades de datos", "Data entities"], 5),
    ("V5", ["Superficies", "Surfaces"], 1),
];

/// `/^\s*[-*] \S/` over one line.
fn is_bullet(line: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    rest.strip_prefix(['-', '*'])
        .and_then(|r| r.strip_prefix(' '))
        .and_then(|r| r.chars().next())
        .is_some_and(|c| !is_js_whitespace(c))
}

/// `/\[DECISI[OÓ]N\]/i`, with JS's non-`u` folding (`ó` and `Ó` match each other, never an `o`
/// from the other side of ASCII).
fn decision_tag() -> Option<Regex> {
    Regex::new(&format!(r"\[{}[oOóÓ]{}\]", ci("decisi"), ci("n"))).ok()
}

/// The text after which a stack is still undefined, as one alternation.
fn undefined_stack() -> Option<Regex> {
    Regex::new(&format!(
        r"\[{d}[oOóÓ]{n}\]|{d2}[oOóÓ]{n2} {a}|{od}|{pd}|{tbd}|{t}",
        d = ci("decisi"),
        n = ci("n"),
        d2 = ci("decisi"),
        n2 = ci("n"),
        a = ci("abierta"),
        od = ci("open decision"),
        pd = ci("por definir"),
        tbd = ci("to be decided"),
        t = ci("TBD"),
    ))
    .ok()
}

/// `evaluateFit(digest, codebase)`; `None` only if a pattern failed to compile.
#[must_use]
pub fn evaluate_fit(digest: &str, codebase: &str) -> Option<FitResult> {
    let sections = split_template_sections(digest);
    // `new Map(entries)`: the last section with a heading wins.
    let body_of = |heading: &str| {
        sections
            .iter()
            .rev()
            .find(|s| s.heading == heading)
            .map(|s| s.body.as_str())
    };
    let mut verifiable: Vec<FitCriterion> = COUNT_CRITERIA
        .iter()
        .map(|(id, headings, threshold)| {
            let found = headings.iter().find_map(|h| body_of(h));
            let value = found.map_or(0, |body| body.split('\n').filter(|l| is_bullet(l)).count());
            let pass = found.is_some()
                && if *id == "V5" {
                    value == *threshold
                } else {
                    value <= *threshold
                };
            FitCriterion {
                id,
                value: FitValue::Count(value),
                threshold: FitValue::Count(*threshold),
                pass,
            }
        })
        .collect();
    let stack = split_template_sections(codebase)
        .into_iter()
        .find(|s| s.heading.eq_ignore_ascii_case("Stack"))
        .map(|s| s.body)
        .unwrap_or_default();
    let defined =
        !stack.trim_matches(is_js_whitespace).is_empty() && !undefined_stack()?.is_match(&stack);
    verifiable.push(FitCriterion {
        id: "V6",
        value: FitValue::Flag(defined),
        threshold: FitValue::Flag(true),
        pass: defined,
    });
    let findings = body_of("Hallazgos")
        .or_else(|| body_of("Findings"))
        .unwrap_or_default();
    let tag = decision_tag()?;
    let decisions = findings
        .split('\n')
        .filter(|line| {
            let rest = line.trim_start_matches(is_js_whitespace);
            rest.strip_prefix(['-', '*'])
                .and_then(|r| r.strip_prefix(' '))
                .is_some_and(|r| {
                    // `.*` stops at a line terminator, and the tag has none: it must start before it.
                    let upto = r
                        .find(['\r', '\u{2028}', '\u{2029}'])
                        .map_or(r, |at| &r[..at]);
                    tag.is_match(upto)
                })
        })
        .count();
    verifiable.push(FitCriterion {
        id: "V7",
        value: FitValue::Count(decisions),
        threshold: FitValue::Count(2),
        pass: decisions <= 2,
    });
    let all_verifiable_pass = verifiable.iter().all(|c| c.pass);
    Some(FitResult {
        verifiable,
        all_verifiable_pass,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_bullets_and_reads_the_stack() {
        let digest = "## Capacidades\n- a\n* b\n-c\n  - d\n## Actors\n- x\n- y\n- z\n- w\n## Surfaces\n- s\n## Hallazgos\n- [DECISIÓN] uno\n- [decisión] dos\n* tres [DECISION]\n- cuatro\n";
        let fit = evaluate_fit(digest, "## stack\nRust y Node\n").unwrap_or_else(|| FitResult {
            verifiable: vec![],
            all_verifiable_pass: false,
        });
        let by_id = |id: &str| fit.verifiable.iter().find(|c| c.id == id).copied();
        assert_eq!(
            by_id("V1").map(|c| (c.value, c.pass)),
            Some((FitValue::Count(3), true))
        );
        assert_eq!(
            by_id("V2").map(|c| (c.value, c.pass)),
            Some((FitValue::Count(4), false))
        );
        assert_eq!(
            by_id("V3").map(|c| (c.value, c.pass)),
            Some((FitValue::Count(0), false))
        );
        assert_eq!(
            by_id("V5").map(|c| (c.value, c.pass)),
            Some((FitValue::Count(1), true))
        );
        assert_eq!(
            by_id("V6").map(|c| (c.value, c.pass)),
            Some((FitValue::Flag(true), true))
        );
        assert_eq!(
            by_id("V7").map(|c| (c.value, c.pass)),
            Some((FitValue::Count(3), false))
        );
        assert!(!fit.all_verifiable_pass);
        let open =
            evaluate_fit("", "## Stack\nlenguaje por definir\n").map(|f| f.verifiable[5].pass);
        assert_eq!(open, Some(false));
    }
}
