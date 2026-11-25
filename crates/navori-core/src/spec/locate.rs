//! Port of `lib/spec/locate.ts` (`locateSpecDir`): `<specsDir>/<spec>/` with containment.

use std::sync::LazyLock;

use regex::Regex;

use crate::posix::{relative, resolve};

static SPEC_NAME: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").ok());

/// `locateSpecDir` for an absolute `cwd`: the spec directory, or the TS rejection text.
/// `None` only if the name pattern failed to compile.
#[must_use]
pub fn locate_spec_dir(cwd: &str, specs_dir: &str, spec: &str) -> Option<Result<String, String>> {
    if !SPEC_NAME.as_ref()?.is_match(spec) || spec.contains("..") {
        return Some(Err(format!(
            "\"{spec}\" is not a spec directory name (one path segment of letters, digits, \".\", \"_\" or \"-\")"
        )));
    }
    let root = resolve(cwd, specs_dir);
    let dir = resolve(&root, spec);
    let rel = relative(&root, &dir);
    if rel.is_empty() || rel.starts_with("..") || rel.split('/').count() != 1 {
        return Some(Err(format!("\"{spec}\" resolves outside {specs_dir}")));
    }
    Some(Ok(dir))
}
