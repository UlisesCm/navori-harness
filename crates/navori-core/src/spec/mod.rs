//! `lib/spec` in Rust (spec 0060 T5): the `tasks.md` parser, classification and structural
//! check that `navori spec` runs. Pure functions; the command lives in `navori-cli`.

pub mod check;
pub mod classify;
pub mod locate;
pub mod tasks;
pub mod text;

use text::{digits_len, is_space};

/// `parseRequirementIds` (`lib/spec/requirements.ts`): ids of list items that open with
/// `**R<n>**` (`/^\s*[-*]\s+\*\*(R\d+)\*\*/`), outside fences, in order and without duplicates.
#[must_use]
pub fn requirement_ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for line in tasks::visible_lines(text) {
        let rest = line.text.trim_start_matches(is_space);
        let Some(after) = rest.strip_prefix(['-', '*']) else {
            continue;
        };
        let spaced = after.trim_start_matches(is_space);
        if spaced.len() == after.len() {
            continue;
        }
        let Some(body) = spaced.strip_prefix("**R") else {
            continue;
        };
        let count = digits_len(body);
        if count == 0 || !body[count..].starts_with("**") {
            continue;
        }
        let id = format!("R{}", &body[..count]);
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// `SPEC_NAME` plus the `..` guard of `locateSpecDir` (`lib/spec/locate.ts`).
#[must_use]
pub fn is_spec_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requirement_ids_dedupe_and_skip_fences() {
        let text = "- **R1** — a\n  * **R2** b\n```\n- **R3**\n```\n- **R1** again\n-**R4**\n";
        assert_eq!(requirement_ids(text), vec!["R1", "R2"]);
    }

    #[test]
    fn spec_names_are_one_segment() {
        assert!(is_spec_name("0060-rust.x_y"));
        assert!(!is_spec_name("../x"));
        assert!(!is_spec_name("a..b"));
        assert!(!is_spec_name(".hidden"));
        assert!(!is_spec_name(""));
        assert!(!is_spec_name("a/b"));
    }
}
