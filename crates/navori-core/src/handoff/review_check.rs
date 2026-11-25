//! `checkReviewHandoff` (`lib/handoff/review-check.ts`, spec 0048 D7/R7; spec 0060 T10): what a
//! reviewer child left behind, for `navori handoff check <feature> --produced-by reviewer`.

use super::Unmodeled;
use super::review::parse_sidecar;
use super::review_evidence::{
    EvidenceOptions, SealedCheck, check_sealed_evidence, correlate_review, iso_utc_ms,
};
use crate::js_json;
use crate::process::Env;
use crate::state_files::{Refusal, StateRoot, artifact_path};

/// The checks of a finished `checkReviewHandoff`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewCheck {
    /// `(check, detail)` failures, empty when the handoff is valid.
    Failures(Vec<(&'static str, String)>),
    /// The message its `catch` reports as `status: "error"`.
    Error(String),
}

/// `/\b(?:APPROVED|CHANGES_REQUESTED)\b/` (ASCII word boundaries).
#[must_use]
pub fn has_verdict(text: &str) -> bool {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let bytes = text.as_bytes();
    ["APPROVED", "CHANGES_REQUESTED"].iter().any(|token| {
        text.match_indices(token).any(|(at, _)| {
            let end = at + token.len();
            (at == 0 || !word(bytes[at - 1])) && bytes.get(end).is_none_or(|b| !word(*b))
        })
    })
}

/// `existsSync(path)` then `readFileSync(path, "utf8")`: `Ok(None)` when absent.
fn read(path: &str) -> Result<Option<String>, Unmodeled> {
    if std::fs::metadata(path).is_err() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| Unmodeled)?;
    String::from_utf8(bytes).map(Some).map_err(|_| Unmodeled)
}

/// `checkReviewHandoff({ cwd, dir, feature, since, evidenceOptions, targetFromStamp })` over a
/// resolved root. `target_from_stamp` correlates against the target the review's begin stamp
/// recorded, keeping the configured gate.
///
/// # Errors
/// [`Unmodeled`] where the TS's answer depends on something this port does not reproduce: a
/// `since` or `startedAt` that is not ISO UTC, a sidecar `JSON.parse` or zod rejects (their
/// messages), or review evidence the correlation does not model.
pub fn check_review_handoff(
    root: &StateRoot,
    feature: &str,
    since: Option<&str>,
    evidence: &EvidenceOptions<'_>,
    target_from_stamp: bool,
    env: &Env,
) -> Result<ReviewCheck, Unmodeled> {
    let since_ms = since.map(|s| iso_utc_ms(s).ok_or(Unmodeled)).transpose()?;
    let path = |name: String| match artifact_path(root, &name) {
        Ok(path) => Ok(Ok(path)),
        Err(Refusal::Message(message)) => Ok(Err(ReviewCheck::Error(message))),
        Err(Refusal::Unmodeled) => Err(Unmodeled),
    };
    let mut failures: Vec<(&'static str, String)> = Vec::new();
    let md = match path(format!("review_{feature}.md"))? {
        Ok(md) => md,
        Err(error) => return Ok(error),
    };
    match read(&md)? {
        None => failures.push(("exists", format!("{md} not found"))),
        Some(text) if !has_verdict(&text) => failures.push((
            "verdict",
            format!("{md} is empty or has no APPROVED|CHANGES_REQUESTED verdict"),
        )),
        Some(_) => {}
    }
    let json_path = match path(format!("review_{feature}.json"))? {
        Ok(json_path) => json_path,
        Err(error) => return Ok(error),
    };
    let Some(raw) = read(&json_path)? else {
        failures.push(("exists", format!("{json_path} not found")));
        return Ok(ReviewCheck::Failures(failures));
    };
    let value = js_json::parse(&raw).ok_or(Unmodeled)?;
    if super::ownership::has_lone_surrogate(&value) {
        return Err(Unmodeled);
    }
    let sidecar = parse_sidecar(&value).ok_or(Unmodeled)?;
    if sidecar.feature != feature {
        failures.push((
            "feature",
            format!(
                "{json_path} belongs to feature \"{}\", not \"{feature}\"",
                sidecar.feature
            ),
        ));
    }
    let sealed = check_sealed_evidence(root, &sidecar)?;
    let stamp_target = match (&sealed, target_from_stamp) {
        (SealedCheck::Verified(_, _, Some(target)), true) => Some(target.as_str()),
        _ => None,
    };
    let stamped = EvidenceOptions {
        target: stamp_target.unwrap_or(evidence.target),
        ..*evidence
    };
    let correlated = correlate_review(root, &sidecar, Some(&stamped), env)?;
    if correlated.correlation != "correlated" {
        let why = if correlated.differs.is_empty() {
            String::new()
        } else {
            format!(": {} differs", correlated.differs.join(", "))
        };
        failures.push((
            "evidence",
            format!(
                "review does not match the current independent delivery ({}{why})",
                correlated.correlation
            ),
        ));
    }
    match &sealed {
        SealedCheck::Verified("sealed", found, _) => {
            if let (Some(since_ms), Some(text)) = (since_ms, since) {
                let started = found.started_at();
                if iso_utc_ms(started).ok_or(Unmodeled)? < since_ms {
                    failures.push((
                        "fresh",
                        format!(
                            "the review began at {started}, before this dispatch ({text}); it is a stale round"
                        ),
                    ));
                }
            }
        }
        other => failures.push((
            "evidence",
            format!(
                "{json_path} has no sealed producer evidence ({})",
                other.status()
            ),
        )),
    }
    Ok(ReviewCheck::Failures(failures))
}

#[cfg(test)]
mod tests {
    use super::has_verdict;

    #[test]
    fn the_verdict_needs_word_boundaries() {
        assert!(has_verdict("**Final verdict:** APPROVED\n"));
        assert!(has_verdict("x-CHANGES_REQUESTED."));
        assert!(has_verdict("ñAPPROVED"));
        assert!(!has_verdict("NOT_APPROVED"));
        assert!(!has_verdict("APPROVEDLY"));
        assert!(!has_verdict(""));
    }
}
