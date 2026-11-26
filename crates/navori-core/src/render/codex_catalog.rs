//! The part of `lib/codex/model-catalog.ts` the render uses (spec 0059 T19, D37): a `codexMap`
//! value resolved against the local Codex catalog (`models_cache.json` under `CODEX_HOME`), with
//! the last-known fallback and the never-downgrade rule against the model already rendered.
//!
//! `inspectCodexCatalog` (catalog freshness evidence) feeds no render output and is not ported.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use crate::js_json::{self, JsValue};

/// `CODEX_FAMILY_FALLBACK`: last-known model id per family (spec 0041 R32).
pub const CODEX_FAMILY_FALLBACK: [(&str, &str); 3] = [
    ("sol", "gpt-6-sol"),
    ("luna", "gpt-6-luna"),
    ("astra", "gpt-6-astra"),
];

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `CodexModelSource`: how a `codexMap` value became the rendered model id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexModelSource {
    /// Highest catalog model of the family.
    Family,
    /// A full id, kept verbatim.
    Pin,
    /// Last-known id (or the value itself) because the catalog had no model of the family.
    Fallback,
    /// The model already rendered, kept by the never-downgrade rule.
    Rendered,
}

impl CodexModelSource {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Family => "family",
            Self::Pin => "pin",
            Self::Fallback => "fallback",
            Self::Rendered => "rendered",
        }
    }
}

/// `CodexModelResolution`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexModelResolution {
    /// Rendered model id.
    pub model: String,
    /// How it was chosen.
    pub source: CodexModelSource,
    /// The family whose catalog lookup failed, when `source` is `Fallback`.
    pub family: Option<String>,
}

/// The resolution is left to the TS: the family is `constructor` (`CODEX_FAMILY_FALLBACK[value]`
/// reads a function from `Object.prototype`), or the catalog exists but [`js_json::parse`] does
/// not read it, which covers invalid JSON and the JSON it does not model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelDelegate;

/// `isCodexFamily`: `/^[a-z]+$/` — a bare lowercase word names a family, anything else is a pin.
#[must_use]
pub fn is_codex_family(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_lowercase())
}

/// `defaultCodexCatalogPath`: `<codexHome()>/models_cache.json`, or `None` when `CODEX_HOME` is
/// relative or the home directory is unusable (where `codexHome()` throws).
#[must_use]
pub fn default_codex_catalog_path() -> Option<PathBuf> {
    codex_home().map(|home| home.join("models_cache.json"))
}

/// `codexHome()`: `$CODEX_HOME` when set and non-empty (it must be absolute), else `~/.codex`.
#[must_use]
pub fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(value) if !value.is_empty() => {
            let path = PathBuf::from(value);
            path.is_absolute().then_some(path)
        }
        _ => std::env::home_dir()
            .filter(|home| home.is_absolute() && !home.as_os_str().is_empty())
            .map(|home| home.join(".codex")),
    }
}

/// `readCodexCatalogSlugs`: the string `slug` of each `models[]` entry. A missing file or an
/// unexpected shape yields no slugs.
///
/// # Errors
/// [`ModelDelegate`] when the file is read but not parsed.
pub fn read_codex_catalog_slugs(catalog: Option<&Path>) -> Result<Vec<String>, ModelDelegate> {
    let Some(bytes) = catalog.and_then(|path| std::fs::read(path).ok()) else {
        return Ok(Vec::new());
    };
    let root = js_json::parse(&String::from_utf8_lossy(&bytes)).ok_or(ModelDelegate)?;
    let JsValue::Object(root) = root else {
        return Ok(Vec::new());
    };
    let Some(JsValue::Array(models)) = root.get("models") else {
        return Ok(Vec::new());
    };
    Ok(models
        .iter()
        .filter_map(|entry| match entry {
            JsValue::Object(entry) => match entry.get("slug") {
                // A slug with a lone surrogate never parses as `gpt-<version>-<family>`, so
                // dropping it here changes no resolution.
                Some(JsValue::String(slug)) => slug.to_rust(),
                _ => None,
            },
            _ => None,
        })
        .collect())
}

/// A parsed `gpt-<version>-<family>` slug.
struct Slug<'a> {
    version: Vec<u64>,
    family: &'a str,
}

/// `Number(part)` when it is a safe integer: `/\d+/` digits only, so leading zeros drop.
fn safe_integer(digits: &str) -> Option<u64> {
    let significant = digits.trim_start_matches('0');
    if significant.len() > 16 {
        return None;
    }
    let value = if significant.is_empty() {
        0
    } else {
        significant.parse::<u64>().ok()?
    };
    (value <= MAX_SAFE_INTEGER).then_some(value)
}

/// `parseSlug`: `/^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/` with every version part a safe integer.
fn parse_slug(slug: &str) -> Option<Slug<'_>> {
    let rest = slug.strip_prefix("gpt-")?;
    let (version, family) = rest.rsplit_once('-')?;
    if !is_codex_family(family) {
        return None;
    }
    let parts = version
        .split('.')
        .map(|part| {
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| safe_integer(part))
                .flatten()
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Slug {
        version: parts,
        family,
    })
}

/// `compareVersions`: numeric, component-wise, missing parts read as 0.
fn compare_versions(a: &[u64], b: &[u64]) -> Ordering {
    (0..a.len().max(b.len()))
        .map(|i| {
            a.get(i)
                .copied()
                .unwrap_or(0)
                .cmp(&b.get(i).copied().unwrap_or(0))
        })
        .find(|order| order.is_ne())
        .unwrap_or(Ordering::Equal)
}

/// `highestOfFamily`: the highest-version slug of `family`; the first wins a tie.
#[must_use]
pub fn highest_of_family<'a>(family: &str, slugs: &'a [String]) -> Option<&'a str> {
    let mut best: Option<(&str, Vec<u64>)> = None;
    for slug in slugs {
        let Some(parsed) = parse_slug(slug).filter(|parsed| parsed.family == family) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(_, top)| compare_versions(&parsed.version, top).is_gt())
        {
            best = Some((slug, parsed.version));
        }
    }
    best.map(|(slug, _)| slug)
}

/// `resolveCodexModelValue`: a pin verbatim; a family to its highest catalog model, kept at the
/// rendered `previous` when that is newer (stale catalog) or, without a catalog match, when it is
/// at least the last-known fallback.
///
/// # Errors
/// [`ModelDelegate`] for `constructor` without a catalog match, or an unread catalog.
pub fn resolve_codex_model_value(
    value: &str,
    catalog: Option<&Path>,
    previous: Option<&str>,
) -> Result<CodexModelResolution, ModelDelegate> {
    let resolution = |model: &str, source| CodexModelResolution {
        model: model.to_owned(),
        source,
        family: None,
    };
    if !is_codex_family(value) {
        return Ok(resolution(value, CodexModelSource::Pin));
    }
    let slugs = read_codex_catalog_slugs(catalog)?;
    let prev = previous.and_then(|previous| {
        parse_slug(previous)
            .filter(|parsed| parsed.family == value)
            .map(|parsed| (previous, parsed.version))
    });
    if let Some(found) = highest_of_family(value, &slugs) {
        if let (Some((previous, version)), Some(top)) = (&prev, parse_slug(found))
            && compare_versions(version, &top.version).is_gt()
        {
            return Ok(resolution(previous, CodexModelSource::Rendered));
        }
        return Ok(resolution(found, CodexModelSource::Family));
    }
    if value == "constructor" {
        return Err(ModelDelegate);
    }
    let fallback = CODEX_FAMILY_FALLBACK
        .iter()
        .find_map(|(family, id)| (*family == value).then_some(*id));
    if let (Some((previous, version)), Some(floor)) = (&prev, fallback.and_then(parse_slug))
        && compare_versions(version, &floor.version).is_ge()
    {
        return Ok(resolution(previous, CodexModelSource::Rendered));
    }
    Ok(CodexModelResolution {
        model: fallback.unwrap_or(value).to_owned(),
        source: CodexModelSource::Fallback,
        family: Some(value.to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_and_leading_zeros_drop() {
        let slugs = ["gpt-6-sol", "gpt-6.1-sol", "gpt-5.10-sol", "gpt-06.1-sol"].map(String::from);
        assert_eq!(highest_of_family("sol", &slugs), Some("gpt-6.1-sol"));
        assert!(parse_slug("gpt-9007199254740992-sol").is_none());
        assert!(parse_slug("gpt-9007199254740991-sol").is_some());
        assert!(parse_slug("gpt-6..1-sol").is_none());
    }
}
