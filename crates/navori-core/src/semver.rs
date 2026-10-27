//! Port of `packages/cli/src/lib/primitives/semver.ts`: the conservative version ordering behind
//! the anti-rollback guard (spec 0058 D20/D21, R37/R38).
//!
//! The TS contract is kept exactly: a `-prerelease`/`+build` suffix is ignored, anything that is
//! not three non-negative integers is "unknown", and an unknown ordering is never a downgrade.

use std::cmp::Ordering;

use crate::integrity::is_js_whitespace;

/// Parsed `MAJOR.MINOR.PATCH`. Components are `f64` because the TS converts them with `Number()`:
/// arbitrarily long digit runs round (or overflow to infinity) exactly as JS does.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Semver {
    /// Major component.
    pub major: f64,
    /// Minor component.
    pub minor: f64,
    /// Patch component.
    pub patch: f64,
}

/// JS `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// One `\d+` group (ASCII digits only, like JS `\d`) converted like `Number()`.
fn component(digits: &str) -> Option<f64> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<f64>().ok()
}

/// `parseSemver`: `X.Y.Z` after trimming, ignoring everything from the first `-` or `+`.
#[must_use]
pub fn parse(version: &str) -> Option<Semver> {
    let trimmed = js_trim(version);
    let core = trimmed.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.');
    let major = component(parts.next()?)?;
    let minor = component(parts.next()?)?;
    let patch = component(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some(Semver {
        major,
        minor,
        patch,
    })
}

/// `compareSemver`: `None` when either side is absent or does not parse.
#[must_use]
pub fn compare(a: Option<&str>, b: Option<&str>) -> Option<Ordering> {
    let a = parse(a?)?;
    let b = parse(b?)?;
    for (x, y) in [(a.major, b.major), (a.minor, b.minor), (a.patch, b.patch)] {
        // `partial_cmp` only fails on NaN, which `component` can never produce.
        match x.partial_cmp(&y)? {
            Ordering::Equal => {}
            other => return Some(other),
        }
    }
    Some(Ordering::Equal)
}

/// `isDowngrade`: `existing` is strictly newer than `incoming`. Unknown ordering is never one.
#[must_use]
pub fn is_downgrade(existing: Option<&str>, incoming: Option<&str>) -> bool {
    compare(existing, incoming) == Some(Ordering::Greater)
}
