//! `# navori:include <name>` expansion of hook scripts: port of
//! `packages/cli/src/lib/render/hook-includes.ts` (spec 0058 T14).
//!
//! The TS regex is `/^[^\S\n]*#\s*navori:include\s+([A-Za-z0-9._-]+)[^\S\n]*$/gm`. Its multiline
//! anchors also split on `\r`, U+2028 and U+2029; the bundled hook assets never place a directive
//! next to those, and `hook_includes_parity` checks every bundled script byte for byte, so this
//! port anchors on `\n` and spells the JS whitespace class out.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::render::assets;

/// JS `\s` minus `\n` (`[^\S\n]`).
const WS_NO_NL: &str =
    r"\t\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

static INCLUDE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?m)^[{WS_NO_NL}]*#[{WS_NO_NL}\n]*navori:include[{WS_NO_NL}\n]+([A-Za-z0-9._-]+)[{WS_NO_NL}]*$"
    ))
    .ok()
});

/// Why an include could not be expanded; the TS throws with these messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncludeError {
    /// `_partials/<name>.sh` is not bundled.
    Missing(String),
    /// The partial itself carries a directive.
    Nested(String),
}

/// `expandHookIncludes`: every directive line replaced by its partial, without the partial's
/// trailing newline.
///
/// # Errors
/// A missing or nested partial, as the TS reports it.
pub fn expand_hook_includes(content: &str) -> Result<String, IncludeError> {
    if !content.contains("navori:include") {
        return Ok(content.to_owned());
    }
    let Some(include) = INCLUDE.as_ref() else {
        return Ok(content.to_owned());
    };
    let mut failure = None;
    let expanded = include.replace_all(content, |captures: &Captures<'_>| {
        let name = captures.get(1).map_or("", |m| m.as_str());
        let partial = assets::core(&format!("core-assets/hooks/_partials/{name}.sh"))
            .and_then(|bytes| std::str::from_utf8(bytes).ok());
        match partial {
            None => {
                failure.get_or_insert(IncludeError::Missing(name.to_owned()));
                String::new()
            }
            Some(partial) if include.is_match(partial) => {
                failure.get_or_insert(IncludeError::Nested(name.to_owned()));
                String::new()
            }
            Some(partial) => partial.strip_suffix('\n').unwrap_or(partial).to_owned(),
        }
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(expanded.into_owned()),
    }
}
