//! Structural check of a one-page `spec.md`, port of `checkOnePageSpec` (`lib/spec/onepage.ts`,
//! #1483): required sections, step and task caps and the word limit. Pure: text in, result out.
//!
//! Headings are matched after the TS `normalize` (NFD, combining marks removed, lower case,
//! trimmed). Without a Unicode normalization crate, [`fold_heading`] reproduces it with
//! [`ASCII_FOLD`], the 495 non-ASCII code points whose NFD, without marks and lower-cased, is a
//! single ASCII character (generated with Node 26; no code point folds to more than one ASCII
//! character or to a mix). Every other non-ASCII character stays non-ASCII after the TS
//! `normalize`, so it can never match an alias and is kept as is.

use std::sync::LazyLock;

use regex::Regex;

use super::check::{Finding, Severity};
use super::text::{digits_len, is_line_terminator, is_space, trim};

/// Hard cap on the whole file, counted like `wc -w` (`MAX_WORDS`).
pub const MAX_WORDS: usize = 1200;
/// Cap on numbered steps in the acceptance script (`MAX_STEPS`).
pub const MAX_STEPS: usize = 10;
/// Cap on items in the Tasks section (`MAX_TASKS`).
pub const MAX_TASKS: usize = 8;

/// A `OnePageCheck`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnePageCheck {
    pub ok: bool,
    pub words: usize,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Outcome,
    Acceptance,
    Rules,
    States,
    Environment,
    OutOfScope,
    Tasks,
}

/// `SECTIONS`: required sections in template order, with their normalized es/en prefixes.
const SECTIONS: [(Key, &str, &[&str]); 7] = [
    (Key::Outcome, "Outcome", &["outcome", "resultado"]),
    (
        Key::Acceptance,
        "Acceptance script",
        &["acceptance script", "guion de aceptacion"],
    ),
    (
        Key::Rules,
        "Applicable rules",
        &["applicable rules", "reglas aplicables"],
    ),
    (Key::States, "States", &["states", "estados"]),
    (
        Key::Environment,
        "Environment and data",
        &["environment and data", "entorno y datos"],
    ),
    (
        Key::OutOfScope,
        "Out of scope",
        &["out of scope", "fuera de alcance"],
    ),
    (Key::Tasks, "Tasks", &["tasks", "tareas"]),
];

/// `STATES`: the name and the literal alternatives of each `/…/i` pattern, over text folded by
/// [`fold_state_text`].
const STATES: [(&str, &[&str]); 4] = [
    ("empty", &["empty", "vacio", "vacío"]),
    ("error", &["error"]),
    ("offline", &["offline", "sin conexion", "sin conexión"]),
    ("no permission", &["permission", "permiso"]),
];

/// JS `\p{M}` (`/\p{M}/gu`).
static MARK: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\p{M}").ok());

struct Line<'a> {
    text: &'a str,
    line: usize,
}

struct Section<'a> {
    key: Key,
    line: usize,
    body: Vec<Line<'a>>,
}

/// Non-ASCII code points whose `c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()` is one
/// ASCII character, sorted by code point.
#[rustfmt::skip]
const ASCII_FOLD: &[(u32, u8)] = &[
    (0x00C0, b'a'), (0x00C1, b'a'), (0x00C2, b'a'), (0x00C3, b'a'), (0x00C4, b'a'), (0x00C5, b'a'),
    (0x00C7, b'c'), (0x00C8, b'e'), (0x00C9, b'e'), (0x00CA, b'e'), (0x00CB, b'e'), (0x00CC, b'i'),
    (0x00CD, b'i'), (0x00CE, b'i'), (0x00CF, b'i'), (0x00D1, b'n'), (0x00D2, b'o'), (0x00D3, b'o'),
    (0x00D4, b'o'), (0x00D5, b'o'), (0x00D6, b'o'), (0x00D9, b'u'), (0x00DA, b'u'), (0x00DB, b'u'),
    (0x00DC, b'u'), (0x00DD, b'y'), (0x00E0, b'a'), (0x00E1, b'a'), (0x00E2, b'a'), (0x00E3, b'a'),
    (0x00E4, b'a'), (0x00E5, b'a'), (0x00E7, b'c'), (0x00E8, b'e'), (0x00E9, b'e'), (0x00EA, b'e'),
    (0x00EB, b'e'), (0x00EC, b'i'), (0x00ED, b'i'), (0x00EE, b'i'), (0x00EF, b'i'), (0x00F1, b'n'),
    (0x00F2, b'o'), (0x00F3, b'o'), (0x00F4, b'o'), (0x00F5, b'o'), (0x00F6, b'o'), (0x00F9, b'u'),
    (0x00FA, b'u'), (0x00FB, b'u'), (0x00FC, b'u'), (0x00FD, b'y'), (0x00FF, b'y'), (0x0100, b'a'),
    (0x0101, b'a'), (0x0102, b'a'), (0x0103, b'a'), (0x0104, b'a'), (0x0105, b'a'), (0x0106, b'c'),
    (0x0107, b'c'), (0x0108, b'c'), (0x0109, b'c'), (0x010A, b'c'), (0x010B, b'c'), (0x010C, b'c'),
    (0x010D, b'c'), (0x010E, b'd'), (0x010F, b'd'), (0x0112, b'e'), (0x0113, b'e'), (0x0114, b'e'),
    (0x0115, b'e'), (0x0116, b'e'), (0x0117, b'e'), (0x0118, b'e'), (0x0119, b'e'), (0x011A, b'e'),
    (0x011B, b'e'), (0x011C, b'g'), (0x011D, b'g'), (0x011E, b'g'), (0x011F, b'g'), (0x0120, b'g'),
    (0x0121, b'g'), (0x0122, b'g'), (0x0123, b'g'), (0x0124, b'h'), (0x0125, b'h'), (0x0128, b'i'),
    (0x0129, b'i'), (0x012A, b'i'), (0x012B, b'i'), (0x012C, b'i'), (0x012D, b'i'), (0x012E, b'i'),
    (0x012F, b'i'), (0x0130, b'i'), (0x0134, b'j'), (0x0135, b'j'), (0x0136, b'k'), (0x0137, b'k'),
    (0x0139, b'l'), (0x013A, b'l'), (0x013B, b'l'), (0x013C, b'l'), (0x013D, b'l'), (0x013E, b'l'),
    (0x0143, b'n'), (0x0144, b'n'), (0x0145, b'n'), (0x0146, b'n'), (0x0147, b'n'), (0x0148, b'n'),
    (0x014C, b'o'), (0x014D, b'o'), (0x014E, b'o'), (0x014F, b'o'), (0x0150, b'o'), (0x0151, b'o'),
    (0x0154, b'r'), (0x0155, b'r'), (0x0156, b'r'), (0x0157, b'r'), (0x0158, b'r'), (0x0159, b'r'),
    (0x015A, b's'), (0x015B, b's'), (0x015C, b's'), (0x015D, b's'), (0x015E, b's'), (0x015F, b's'),
    (0x0160, b's'), (0x0161, b's'), (0x0162, b't'), (0x0163, b't'), (0x0164, b't'), (0x0165, b't'),
    (0x0168, b'u'), (0x0169, b'u'), (0x016A, b'u'), (0x016B, b'u'), (0x016C, b'u'), (0x016D, b'u'),
    (0x016E, b'u'), (0x016F, b'u'), (0x0170, b'u'), (0x0171, b'u'), (0x0172, b'u'), (0x0173, b'u'),
    (0x0174, b'w'), (0x0175, b'w'), (0x0176, b'y'), (0x0177, b'y'), (0x0178, b'y'), (0x0179, b'z'),
    (0x017A, b'z'), (0x017B, b'z'), (0x017C, b'z'), (0x017D, b'z'), (0x017E, b'z'), (0x01A0, b'o'),
    (0x01A1, b'o'), (0x01AF, b'u'), (0x01B0, b'u'), (0x01CD, b'a'), (0x01CE, b'a'), (0x01CF, b'i'),
    (0x01D0, b'i'), (0x01D1, b'o'), (0x01D2, b'o'), (0x01D3, b'u'), (0x01D4, b'u'), (0x01D5, b'u'),
    (0x01D6, b'u'), (0x01D7, b'u'), (0x01D8, b'u'), (0x01D9, b'u'), (0x01DA, b'u'), (0x01DB, b'u'),
    (0x01DC, b'u'), (0x01DE, b'a'), (0x01DF, b'a'), (0x01E0, b'a'), (0x01E1, b'a'), (0x01E6, b'g'),
    (0x01E7, b'g'), (0x01E8, b'k'), (0x01E9, b'k'), (0x01EA, b'o'), (0x01EB, b'o'), (0x01EC, b'o'),
    (0x01ED, b'o'), (0x01F0, b'j'), (0x01F4, b'g'), (0x01F5, b'g'), (0x01F8, b'n'), (0x01F9, b'n'),
    (0x01FA, b'a'), (0x01FB, b'a'), (0x0200, b'a'), (0x0201, b'a'), (0x0202, b'a'), (0x0203, b'a'),
    (0x0204, b'e'), (0x0205, b'e'), (0x0206, b'e'), (0x0207, b'e'), (0x0208, b'i'), (0x0209, b'i'),
    (0x020A, b'i'), (0x020B, b'i'), (0x020C, b'o'), (0x020D, b'o'), (0x020E, b'o'), (0x020F, b'o'),
    (0x0210, b'r'), (0x0211, b'r'), (0x0212, b'r'), (0x0213, b'r'), (0x0214, b'u'), (0x0215, b'u'),
    (0x0216, b'u'), (0x0217, b'u'), (0x0218, b's'), (0x0219, b's'), (0x021A, b't'), (0x021B, b't'),
    (0x021E, b'h'), (0x021F, b'h'), (0x0226, b'a'), (0x0227, b'a'), (0x0228, b'e'), (0x0229, b'e'),
    (0x022A, b'o'), (0x022B, b'o'), (0x022C, b'o'), (0x022D, b'o'), (0x022E, b'o'), (0x022F, b'o'),
    (0x0230, b'o'), (0x0231, b'o'), (0x0232, b'y'), (0x0233, b'y'), (0x037E, b';'), (0x1E00, b'a'),
    (0x1E01, b'a'), (0x1E02, b'b'), (0x1E03, b'b'), (0x1E04, b'b'), (0x1E05, b'b'), (0x1E06, b'b'),
    (0x1E07, b'b'), (0x1E08, b'c'), (0x1E09, b'c'), (0x1E0A, b'd'), (0x1E0B, b'd'), (0x1E0C, b'd'),
    (0x1E0D, b'd'), (0x1E0E, b'd'), (0x1E0F, b'd'), (0x1E10, b'd'), (0x1E11, b'd'), (0x1E12, b'd'),
    (0x1E13, b'd'), (0x1E14, b'e'), (0x1E15, b'e'), (0x1E16, b'e'), (0x1E17, b'e'), (0x1E18, b'e'),
    (0x1E19, b'e'), (0x1E1A, b'e'), (0x1E1B, b'e'), (0x1E1C, b'e'), (0x1E1D, b'e'), (0x1E1E, b'f'),
    (0x1E1F, b'f'), (0x1E20, b'g'), (0x1E21, b'g'), (0x1E22, b'h'), (0x1E23, b'h'), (0x1E24, b'h'),
    (0x1E25, b'h'), (0x1E26, b'h'), (0x1E27, b'h'), (0x1E28, b'h'), (0x1E29, b'h'), (0x1E2A, b'h'),
    (0x1E2B, b'h'), (0x1E2C, b'i'), (0x1E2D, b'i'), (0x1E2E, b'i'), (0x1E2F, b'i'), (0x1E30, b'k'),
    (0x1E31, b'k'), (0x1E32, b'k'), (0x1E33, b'k'), (0x1E34, b'k'), (0x1E35, b'k'), (0x1E36, b'l'),
    (0x1E37, b'l'), (0x1E38, b'l'), (0x1E39, b'l'), (0x1E3A, b'l'), (0x1E3B, b'l'), (0x1E3C, b'l'),
    (0x1E3D, b'l'), (0x1E3E, b'm'), (0x1E3F, b'm'), (0x1E40, b'm'), (0x1E41, b'm'), (0x1E42, b'm'),
    (0x1E43, b'm'), (0x1E44, b'n'), (0x1E45, b'n'), (0x1E46, b'n'), (0x1E47, b'n'), (0x1E48, b'n'),
    (0x1E49, b'n'), (0x1E4A, b'n'), (0x1E4B, b'n'), (0x1E4C, b'o'), (0x1E4D, b'o'), (0x1E4E, b'o'),
    (0x1E4F, b'o'), (0x1E50, b'o'), (0x1E51, b'o'), (0x1E52, b'o'), (0x1E53, b'o'), (0x1E54, b'p'),
    (0x1E55, b'p'), (0x1E56, b'p'), (0x1E57, b'p'), (0x1E58, b'r'), (0x1E59, b'r'), (0x1E5A, b'r'),
    (0x1E5B, b'r'), (0x1E5C, b'r'), (0x1E5D, b'r'), (0x1E5E, b'r'), (0x1E5F, b'r'), (0x1E60, b's'),
    (0x1E61, b's'), (0x1E62, b's'), (0x1E63, b's'), (0x1E64, b's'), (0x1E65, b's'), (0x1E66, b's'),
    (0x1E67, b's'), (0x1E68, b's'), (0x1E69, b's'), (0x1E6A, b't'), (0x1E6B, b't'), (0x1E6C, b't'),
    (0x1E6D, b't'), (0x1E6E, b't'), (0x1E6F, b't'), (0x1E70, b't'), (0x1E71, b't'), (0x1E72, b'u'),
    (0x1E73, b'u'), (0x1E74, b'u'), (0x1E75, b'u'), (0x1E76, b'u'), (0x1E77, b'u'), (0x1E78, b'u'),
    (0x1E79, b'u'), (0x1E7A, b'u'), (0x1E7B, b'u'), (0x1E7C, b'v'), (0x1E7D, b'v'), (0x1E7E, b'v'),
    (0x1E7F, b'v'), (0x1E80, b'w'), (0x1E81, b'w'), (0x1E82, b'w'), (0x1E83, b'w'), (0x1E84, b'w'),
    (0x1E85, b'w'), (0x1E86, b'w'), (0x1E87, b'w'), (0x1E88, b'w'), (0x1E89, b'w'), (0x1E8A, b'x'),
    (0x1E8B, b'x'), (0x1E8C, b'x'), (0x1E8D, b'x'), (0x1E8E, b'y'), (0x1E8F, b'y'), (0x1E90, b'z'),
    (0x1E91, b'z'), (0x1E92, b'z'), (0x1E93, b'z'), (0x1E94, b'z'), (0x1E95, b'z'), (0x1E96, b'h'),
    (0x1E97, b't'), (0x1E98, b'w'), (0x1E99, b'y'), (0x1EA0, b'a'), (0x1EA1, b'a'), (0x1EA2, b'a'),
    (0x1EA3, b'a'), (0x1EA4, b'a'), (0x1EA5, b'a'), (0x1EA6, b'a'), (0x1EA7, b'a'), (0x1EA8, b'a'),
    (0x1EA9, b'a'), (0x1EAA, b'a'), (0x1EAB, b'a'), (0x1EAC, b'a'), (0x1EAD, b'a'), (0x1EAE, b'a'),
    (0x1EAF, b'a'), (0x1EB0, b'a'), (0x1EB1, b'a'), (0x1EB2, b'a'), (0x1EB3, b'a'), (0x1EB4, b'a'),
    (0x1EB5, b'a'), (0x1EB6, b'a'), (0x1EB7, b'a'), (0x1EB8, b'e'), (0x1EB9, b'e'), (0x1EBA, b'e'),
    (0x1EBB, b'e'), (0x1EBC, b'e'), (0x1EBD, b'e'), (0x1EBE, b'e'), (0x1EBF, b'e'), (0x1EC0, b'e'),
    (0x1EC1, b'e'), (0x1EC2, b'e'), (0x1EC3, b'e'), (0x1EC4, b'e'), (0x1EC5, b'e'), (0x1EC6, b'e'),
    (0x1EC7, b'e'), (0x1EC8, b'i'), (0x1EC9, b'i'), (0x1ECA, b'i'), (0x1ECB, b'i'), (0x1ECC, b'o'),
    (0x1ECD, b'o'), (0x1ECE, b'o'), (0x1ECF, b'o'), (0x1ED0, b'o'), (0x1ED1, b'o'), (0x1ED2, b'o'),
    (0x1ED3, b'o'), (0x1ED4, b'o'), (0x1ED5, b'o'), (0x1ED6, b'o'), (0x1ED7, b'o'), (0x1ED8, b'o'),
    (0x1ED9, b'o'), (0x1EDA, b'o'), (0x1EDB, b'o'), (0x1EDC, b'o'), (0x1EDD, b'o'), (0x1EDE, b'o'),
    (0x1EDF, b'o'), (0x1EE0, b'o'), (0x1EE1, b'o'), (0x1EE2, b'o'), (0x1EE3, b'o'), (0x1EE4, b'u'),
    (0x1EE5, b'u'), (0x1EE6, b'u'), (0x1EE7, b'u'), (0x1EE8, b'u'), (0x1EE9, b'u'), (0x1EEA, b'u'),
    (0x1EEB, b'u'), (0x1EEC, b'u'), (0x1EED, b'u'), (0x1EEE, b'u'), (0x1EEF, b'u'), (0x1EF0, b'u'),
    (0x1EF1, b'u'), (0x1EF2, b'y'), (0x1EF3, b'y'), (0x1EF4, b'y'), (0x1EF5, b'y'), (0x1EF6, b'y'),
    (0x1EF7, b'y'), (0x1EF8, b'y'), (0x1EF9, b'y'), (0x1FEF, b'`'), (0x212A, b'k'), (0x212B, b'a'),
    (0x2260, b'='), (0x226E, b'<'), (0x226F, b'>'),
];

/// `normalize(heading)`: NFD, marks removed, lower case, trimmed, as far as matching an ASCII
/// alias can tell: a character that stays non-ASCII is kept as is. `None` when the mark pattern
/// did not compile.
#[must_use]
pub fn fold_heading(heading: &str) -> Option<String> {
    let mut folded = String::with_capacity(heading.len());
    for ch in heading.chars() {
        if ch.is_ascii() {
            folded.push(ch.to_ascii_lowercase());
        } else if let Ok(at) = ASCII_FOLD.binary_search_by_key(&u32::from(ch), |&(cp, _)| cp) {
            folded.push(char::from(ASCII_FOLD[at].1));
        } else {
            folded.push(ch);
        }
    }
    let stripped = MARK.as_ref()?.replace_all(&folded, "");
    Some(trim(&stripped).to_owned())
}

/// `matchSection(heading)`; the outer `None` when the mark pattern did not compile.
fn match_section(heading: &str) -> Option<Option<Key>> {
    let norm = fold_heading(heading)?;
    Some(
        SECTIONS
            .iter()
            .find(|(_, _, aliases)| {
                aliases.iter().any(|alias| {
                    norm.strip_prefix(alias)
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '(']))
                })
            })
            .map(|(key, _, _)| *key),
    )
}

/// The capture of `/^## +(.+?)\s*$/` on one line (no `m` flag: `$` is the end of the line).
///
/// `.` stops at line terminators and the group is lazy, so it is the text after the spaces with
/// its trailing `\s` removed, provided that text holds no line terminator. When nothing but
/// `\s` follows the spaces, the regex backtracks and the group is one whitespace character,
/// which normalizes to "" like any blank heading.
fn heading(raw: &str) -> Option<&str> {
    let after = raw.strip_prefix("## ")?;
    let body = after.trim_start_matches(' ');
    let text = body.trim_end_matches(is_space);
    if text.is_empty() {
        let first_ok = body.chars().next().is_some_and(|c| !is_line_terminator(c));
        let spare_space = after.len() > body.len();
        return (first_ok || spare_space).then_some("");
    }
    (!text.contains(is_line_terminator)).then_some(text)
}

/// `/^\s*(```|~~~)/`.
fn is_fence(raw: &str) -> bool {
    let rest = raw.trim_start_matches(is_space);
    rest.starts_with("```") || rest.starts_with("~~~")
}

/// `parseSections(text)`: recognized `## ` sections, headings inside fenced code ignored.
fn parse_sections(text: &str) -> Option<Vec<Section<'_>>> {
    let mut sections: Vec<Section<'_>> = Vec::new();
    let mut current = false;
    let mut fence = false;
    for (index, raw) in text.split('\n').enumerate() {
        let line = index + 1;
        if is_fence(raw) {
            fence = !fence;
        }
        if let Some(title) = heading(raw).filter(|_| !fence) {
            current = match match_section(title)? {
                Some(key) => {
                    sections.push(Section {
                        key,
                        line,
                        body: Vec::new(),
                    });
                    true
                }
                None => false,
            };
            continue;
        }
        if current && let Some(section) = sections.last_mut() {
            section.body.push(Line { text: raw, line });
        }
    }
    Some(sections)
}

/// Length of the match of `STEP` (`/^\d+\. /`) at the start of `text`.
fn step_len(text: &str) -> Option<usize> {
    let digits = digits_len(text);
    (digits > 0 && text[digits..].starts_with(". ")).then_some(digits + 2)
}

/// Length of the match of `TASK` (`/^(?:\d+\. |- (?:\[[ xX]\] )?)/`) at the start of `text`.
fn task_len(text: &str) -> Option<usize> {
    if let Some(len) = step_len(text) {
        return Some(len);
    }
    let rest = text.strip_prefix("- ")?;
    let checkbox = ["[ ] ", "[x] ", "[X] "]
        .iter()
        .any(|mark| rest.starts_with(mark));
    Some(if checkbox { 6 } else { 2 })
}

/// JS `\w` without the `u` flag.
const fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `/\b\d+\.\d+\.\d+\b|@\d/`. Each `\d+` is followed by `.` or `\b`, so only maximal digit
/// runs can match, starting after a non-word character.
fn has_version(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes
        .windows(2)
        .any(|w| w[0] == b'@' && w[1].is_ascii_digit())
    {
        return true;
    }
    (0..bytes.len()).any(|start| {
        if !bytes[start].is_ascii_digit() || (start > 0 && is_word(bytes[start - 1])) {
            return false;
        }
        let mut at = start;
        for part in 0..3 {
            if part > 0 {
                if bytes.get(at) != Some(&b'.') {
                    return false;
                }
                at += 1;
            }
            let digits = digits_len(&text[at..]);
            if digits == 0 {
                return false;
            }
            at += digits;
        }
        bytes.get(at).is_none_or(|&b| !is_word(b))
    })
}

/// `t.includes("/") && /\.[A-Za-z0-9]+/.test(t)` for some token of `text.split(/\s+/)`.
fn has_path(text: &str) -> bool {
    text.split(is_space).any(|token| {
        token.contains('/')
            && token
                .as_bytes()
                .windows(2)
                .any(|w| w[0] == b'.' && w[1].is_ascii_alphanumeric())
    })
}

/// `/\w+\([^)]*\)/`: a `(` right after a word character, closed later on.
fn has_signature(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.iter().enumerate().any(|(at, &b)| {
        b == b'(' && at > 0 && is_word(bytes[at - 1]) && bytes[at + 1..].contains(&b')')
    })
}

/// `implementationSmell(text)`.
fn implementation_smell(text: &str) -> Option<&'static str> {
    if has_version(text) {
        Some("a version")
    } else if has_path(text) {
        Some("a file path")
    } else if has_signature(text) {
        Some("a function signature")
    } else {
        None
    }
}

/// What the case-insensitive `STATES` patterns compare. JS `/i` without `u` canonicalizes with
/// `toUpperCase` but never maps a non-ASCII character to an ASCII one, so only ASCII letters and
/// the patterns' own `í`/`ó` fold.
fn fold_state_text(text: &str) -> String {
    text.chars()
        .map(|ch| match ch {
            'Í' => 'í',
            'Ó' => 'ó',
            _ => ch.to_ascii_lowercase(),
        })
        .collect()
}

/// `checkOnePageSpec(text)`. `None` when the mark pattern did not compile.
#[must_use]
pub fn check_one_page(text: &str) -> Option<OnePageCheck> {
    let mut findings = Vec::new();
    let mut add = |rule: &'static str, severity, where_: &str, message: String, line| {
        findings.push(Finding {
            rule,
            severity,
            where_: where_.to_owned(),
            message,
            line,
        });
    };
    let words = trim(text).split(is_space).filter(|w| !w.is_empty()).count();
    let sections = parse_sections(text)?;
    let section = |key: Key| sections.iter().find(|s| s.key == key);

    for (key, label, _) in SECTIONS {
        if section(key).is_none() {
            add(
                "missing-section",
                Severity::Error,
                label,
                format!("missing section \"## {label}\" (or its Spanish heading)"),
                None,
            );
        }
    }
    if words > MAX_WORDS {
        add(
            "too-long",
            Severity::Error,
            "spec.md",
            format!("{words} words exceeds the {MAX_WORDS}-word limit"),
            None,
        );
    }

    if let Some(outcome) = section(Key::Outcome)
        && !outcome.body.iter().any(|b| !trim(b.text).is_empty())
    {
        add(
            "empty-outcome",
            Severity::Error,
            "Outcome",
            "the outcome section has no text".to_owned(),
            Some(outcome.line),
        );
    }

    if let Some(acceptance) = section(Key::Acceptance) {
        let steps = acceptance
            .body
            .iter()
            .filter(|b| step_len(b.text).is_some())
            .count();
        if steps == 0 || steps > MAX_STEPS {
            add(
                "steps-count",
                Severity::Error,
                "Acceptance script",
                format!("{steps} numbered steps; expected 1 to {MAX_STEPS}"),
                Some(acceptance.line),
            );
        }
    }

    if let Some(states) = section(Key::States) {
        let joined: Vec<&str> = states.body.iter().map(|b| b.text).collect();
        let state_text = fold_state_text(&joined.join("\n"));
        for (name, alternatives) in STATES {
            if !alternatives.iter().any(|alt| state_text.contains(alt)) {
                add(
                    "missing-state",
                    Severity::Warning,
                    "States",
                    format!(
                        "the States section does not mention \"{name}\" (use \"n/a — <why>\" if it cannot happen)"
                    ),
                    Some(states.line),
                );
            }
        }
    }

    if let Some(tasks) = section(Key::Tasks) {
        let items: Vec<(&Line<'_>, usize)> = tasks
            .body
            .iter()
            .filter_map(|b| task_len(b.text).map(|len| (b, len)))
            .collect();
        if items.is_empty() || items.len() > MAX_TASKS {
            add(
                "tasks-count",
                Severity::Error,
                "Tasks",
                format!("{} tasks; expected 1 to {MAX_TASKS}", items.len()),
                Some(tasks.line),
            );
        }
        for (item, len) in items {
            if let Some(smell) = implementation_smell(&item.text[len..]) {
                add(
                    "task-implementation",
                    Severity::Warning,
                    "Tasks",
                    format!("task mentions {smell}; describe the outcome, not the implementation"),
                    Some(item.line),
                );
            }
        }
    }

    let ok = !findings.iter().any(|f| f.severity == Severity::Error);
    Some(OnePageCheck {
        ok,
        words,
        findings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_follow_the_lazy_js_capture() {
        assert_eq!(heading("## Tareas  \r"), Some("Tareas"));
        assert_eq!(heading("##   Outcome"), Some("Outcome"));
        assert_eq!(heading("## a\u{2028}b"), None);
        assert_eq!(heading("## \r"), None);
        assert_eq!(heading("##  \r"), Some(""));
        assert_eq!(heading("## \t"), Some(""));
        assert_eq!(heading("### Tasks"), None);
        assert_eq!(heading("##Tasks"), None);
    }

    #[test]
    fn spanish_headings_fold_accents_and_case() {
        let acceptance = Some(Some(Key::Acceptance));
        assert_eq!(match_section("Guion de Aceptación"), acceptance);
        assert_eq!(
            match_section("Guio\u{301}n de aceptacion (manual)"),
            acceptance
        );
        assert_eq!(match_section("Tareasx"), Some(None));
        assert_eq!(
            match_section("Fuera de alcance\u{a0}"),
            Some(Some(Key::OutOfScope))
        );
    }

    #[test]
    fn smells_follow_the_ascii_js_patterns() {
        assert_eq!(implementation_smell("bump to 1.2.3"), Some("a version"));
        assert_eq!(implementation_smell("v1.2.3"), None);
        assert_eq!(implementation_smell("1.2.3a"), None);
        assert_eq!(implementation_smell("1.2.3.4"), Some("a version"));
        assert_eq!(implementation_smell("x@2"), Some("a version"));
        assert_eq!(
            implementation_smell("edit src/a.ts now"),
            Some("a file path")
        );
        assert_eq!(
            implementation_smell("call run(x) once"),
            Some("a function signature")
        );
        assert_eq!(implementation_smell("a (b) c"), None);
        assert_eq!(implementation_smell("The user signs in"), None);
    }

    #[test]
    fn the_fold_table_is_sorted() {
        assert!(ASCII_FOLD.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(ASCII_FOLD.len(), 495);
    }
}
