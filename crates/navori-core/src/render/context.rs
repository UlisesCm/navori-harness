//! Explicit render context (spec 0058 D19, R34).
//!
//! Replaces the TS module state `ambientFloorVersion`/`setMarkerFloorVersion` (`marker.ts:113`):
//! the command that reads the config builds one context and passes it down. Nothing in the marker
//! code reads the floor from anywhere else.

use crate::semver;

/// Output locale, `lib/i18n.ts` `Lang`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    /// Spanish, the TS `DEFAULT_LANG`.
    Es,
    /// English.
    En,
}

impl Lang {
    /// `resolveLang`: only `"es"` and `"en"` are shipped; anything else falls back to Spanish.
    #[must_use]
    pub fn resolve(value: Option<&str>) -> Self {
        match value {
            Some("en") => Self::En,
            _ => Self::Es,
        }
    }
}

/// Whether the command may touch disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Default: plan and report, no real operation (R40).
    Preview,
    /// `--apply` without `--dry-run`.
    Apply,
}

impl Mode {
    /// The TS rule: preview unless `--apply`, and `--dry-run` wins over `--apply`.
    #[must_use]
    pub const fn from_flags(apply: bool, dry_run: bool) -> Self {
        if apply && !dry_run {
            Self::Apply
        } else {
            Self::Preview
        }
    }
}

/// Everything a render run needs that the TS takes from globals, the clock or the process.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderContext {
    /// Version stamped into markers ([`crate::STAMP_VERSION`] in production).
    pub cli_version: String,
    /// Anti-rollback floor: the config's `harnessVersion`, if any.
    pub floor: Option<String>,
    /// Output locale.
    pub lang: Lang,
    /// Preview or apply.
    pub mode: Mode,
    /// Wall clock in epoch milliseconds, for backup names and pruning.
    pub now_ms: f64,
    /// Process id, for backup names.
    pub pid: u32,
}

impl RenderContext {
    /// Floor that guards one block: an explicit per-block floor wins over the run-wide one
    /// (`meta.floorVersion ?? ambientFloorVersion`, `marker.ts:463`).
    #[must_use]
    pub fn floor_for<'a>(&'a self, meta_floor: Option<&'a str>) -> Option<&'a str> {
        meta_floor.or(self.floor.as_deref())
    }
}

/// `maxSemver` (`marker.ts:121`): the newer of two versions; an unparseable side loses to a
/// parseable one, and an absent or unparseable `b` returns `a` untouched.
#[must_use]
pub fn max_semver<'a>(a: Option<&'a str>, b: Option<&'a str>) -> Option<&'a str> {
    let Some(b) = b.filter(|b| semver::parse(b).is_some()) else {
        return a;
    };
    let Some(a) = a.filter(|a| semver::parse(a).is_some()) else {
        return Some(b);
    };
    if semver::compare(Some(a), Some(b)) == Some(std::cmp::Ordering::Less) {
        Some(b)
    } else {
        Some(a)
    }
}
