//! `checkPart` and `validatePartSpec` (`lib/master/check-part.ts`): the linked spec of a legacy
//! part, judged from its `tasks.md`, `design.md` and `requirements.md` without writes.
//!
//! The JS regexes are spelled for the `regex` crate, whose leftmost-first semantics report the
//! same match and groups as the JS engine for these patterns: `\s` as the ECMAScript class, `\d`
//! as `[0-9]`, and `/i` as ASCII-only case folding (a JS regex without `u` never folds a non-ASCII
//! letter into an ASCII one). The two patterns with a lookahead or `\b` are written out by hand.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use super::state::Part;
use super::status::Delegate;
use crate::integrity::is_js_whitespace;

/// JS `\s` as a class body.
const WS: &str = r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// A JS `/i` literal (no `u` flag): each ASCII letter as `[xX]`, everything else escaped.
fn ci(literal: &str) -> String {
    literal
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex::escape(&c.to_string())
            }
        })
        .collect()
}

/// The patterns of `check-part.ts`, compiled once.
struct Patterns {
    /// `(?:casos?\s+(?:de\s+)?test|test\s+cases?)`.
    named_quoted: Regex,
    named_bare: Regex,
    /// `it(\s*[`"']([^`"']+)[`"']\s*\)`, anchored: `\bit\(` is checked by hand.
    it_call: Regex,
    placeholder: Regex,
    library: Regex,
    command_word: Regex,
    expected_word: Regex,
}

static PATTERNS: LazyLock<Option<Patterns>> = LazyLock::new(|| {
    let ws = format!("[{WS}]");
    let test_label = format!(
        "(?:{casos}{s}?{ws}+(?:{de}{ws}+)?{test}|{test}{ws}+{cases}{s}?)",
        casos = ci("caso"),
        s = ci("s"),
        de = ci("de"),
        test = ci("test"),
        cases = ci("case"),
    );
    Some(Patterns {
        named_quoted: Regex::new(&format!("{test_label}{ws}*:?{ws}*[`\"']([^`\"']+)[`\"']"))
            .ok()?,
        named_bare: Regex::new(&format!("{test_label}{ws}*:{ws}*([^,;\\n]+)")).ok()?,
        it_call: Regex::new(&format!(
            "^{it}\\({ws}*[`\"']([^`\"']+)[`\"']{ws}*\\)",
            it = ci("it")
        ))
        .ok()?,
        placeholder: Regex::new(&format!(
            "^(?:{}|{}|{}|{}[0-9]+\\.{}[0-9]+)$",
            ci("test"),
            ci("case"),
            ci("caso"),
            ci("p"),
            ci("a")
        ))
        .ok()?,
        library: Regex::new(r"^[A-Za-z0-9_@./-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9_.-]+)?$")
            .ok()?,
        command_word: Regex::new(&format!("{}|{}|`[^`]+`", ci("comando"), ci("command"))).ok()?,
        expected_word: Regex::new(&format!(
            "{}|{}|{}|{}",
            ci("esperado"),
            ci("expected"),
            ci("exit 0"),
            ci("green")
        ))
        .ok()?,
    })
});

/// The canonical task fields, in `FIELDS` order, with their `es` and `en` labels.
const FIELDS: [(&str, &str); 7] = [
    ("Archivos", "Files"),
    ("Interfaces", "Interfaces"),
    ("Patrón", "Pattern"),
    ("Lectura", "Reading"),
    ("Librerías", "Libraries"),
    ("Done", "Done"),
    ("Fuera de alcance", "Out of scope"),
];

const fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `/^- \[[ xX]\](?: .*)?$/gm` start offsets: a line (between any line terminators) that is
/// exactly `- [m]` or starts with `- [m] `.
fn task_starts(tasks: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut line_start = 0;
    for (at, c) in tasks
        .char_indices()
        .chain(std::iter::once((tasks.len(), '\n')))
    {
        if !is_line_terminator(c) {
            continue;
        }
        let line = &tasks[line_start..at];
        let b = line.as_bytes();
        let is_entry = b.len() >= 5
            && b.starts_with(b"- [")
            && matches!(b[3], b' ' | b'x' | b'X')
            && b[4] == b']'
            && (b.len() == 5 || b[5] == b' ');
        if is_entry {
            starts.push(line_start);
        }
        line_start = at + c.len_utf8();
    }
    starts
}

/// `/^- \[[ xX]\] \*\*(T\d+)\*\*/.exec(block)?.[1]`.
fn task_id(block: &str) -> Option<&str> {
    let b = block.as_bytes();
    if b.len() < 8
        || !b.starts_with(b"- [")
        || !matches!(b[3], b' ' | b'x' | b'X')
        || !block[4..].starts_with("] **T")
    {
        return None;
    }
    let digits = block[9..].bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && block[9 + digits..].starts_with("**")).then(|| &block[8..9 + digits])
}

/// Every `P\d+\.A\d+` match of `text`, left to right.
fn criteria(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut at = 0;
    while at < b.len() {
        if b[at] == b'P' {
            let p_digits = b[at + 1..]
                .iter()
                .take_while(|c| c.is_ascii_digit())
                .count();
            let dot = at + 1 + p_digits;
            if p_digits > 0 && b.get(dot) == Some(&b'.') && b.get(dot + 1) == Some(&b'A') {
                let a_digits = b[dot + 2..]
                    .iter()
                    .take_while(|c| c.is_ascii_digit())
                    .count();
                if a_digits > 0 {
                    let end = dot + 2 + a_digits;
                    out.push(&text[at..end]);
                    at = end;
                    continue;
                }
            }
        }
        at += 1;
    }
    out
}

/// `^\s*-?\s*\*\*R\d+\*\*` anchored at the start of `text`.
fn opens_requirement(text: &str) -> bool {
    let rest = text.trim_start_matches(is_js_whitespace);
    let rest = rest.strip_prefix('-').unwrap_or(rest);
    let rest = rest.trim_start_matches(is_js_whitespace);
    let Some(rest) = rest.strip_prefix("**R") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with("**")
}

/// `requirements.split(/(?=^\s*-?\s*\*\*R\d+\*\*)/m)` kept where the block opens a requirement.
fn requirement_blocks(text: &str) -> Vec<&str> {
    let mut cuts = Vec::new();
    for (at, c) in text.char_indices() {
        let line_start = at == 0
            || text[..at]
                .chars()
                .next_back()
                .is_some_and(is_line_terminator);
        let _ = c;
        if line_start && at > 0 && opens_requirement(&text[at..]) {
            cuts.push(at);
        }
    }
    let mut blocks = Vec::new();
    let mut from = 0;
    for cut in cuts {
        blocks.push(&text[from..cut]);
        from = cut;
    }
    blocks.push(&text[from..]);
    blocks
        .into_iter()
        .filter(|b| opens_requirement(b))
        .collect()
}

/// `hasNamedTestCase(done)`.
fn has_named_test_case(p: &Patterns, done: &str) -> bool {
    let group = |re: &Regex, text: &str| {
        re.captures(text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_owned())
    };
    let it_call = || {
        let b = done.as_bytes();
        (0..done.len())
            .filter(|&at| done.is_char_boundary(at))
            .find_map(|at| {
                let boundary = at == 0 || !(b[at - 1].is_ascii_alphanumeric() || b[at - 1] == b'_');
                if boundary {
                    group(&p.it_call, &done[at..])
                } else {
                    None
                }
            })
    };
    let named = group(&p.named_quoted, done)
        .or_else(it_call)
        .or_else(|| group(&p.named_bare, done));
    named.is_some_and(|n| {
        let n = js_trim(&n);
        !n.is_empty() && !p.placeholder.is_match(n)
    })
}

/// `resolve(cwd, rel)` over absolute UTF-8 POSIX paths.
fn resolve(cwd: &str, rel: &str) -> String {
    let base = if rel.starts_with('/') { "" } else { cwd };
    let mut parts: Vec<&str> = Vec::new();
    for part in base.split('/').chain(rel.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `validatePartSpec(cwd, part, allParts, tasks, design, requirements, language)`.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one function per TS function keeps the port comparable"
)]
pub fn validate_part_spec(
    cwd: &str,
    part: &Part,
    all_parts: &[Part],
    tasks: &str,
    design: &str,
    requirements: &str,
    english: bool,
) -> Option<Vec<String>> {
    let p = PATTERNS.as_ref()?;
    let mut failures = Vec::new();
    let starts = task_starts(tasks);
    if starts.is_empty() {
        failures.push(format!("{}: tasks.md has no tasks", part.id));
    }
    for (index, start) in starts.iter().enumerate() {
        let block = &tasks[*start..starts.get(index + 1).copied().unwrap_or(tasks.len())];
        let Some(task) = task_id(block) else {
            failures.push(format!(
                "{}: task {} needs a **T<n>** heading",
                part.id,
                index + 1
            ));
            continue;
        };
        let mut values: Vec<Option<String>> = Vec::new();
        for (es, en) in FIELDS {
            let markers = [format!("- **{es}:**"), format!("- **{en}:**")];
            let mut value = None;
            for line in block.split('\n') {
                let trimmed = line.trim_start_matches(is_js_whitespace);
                if let Some(marker) = markers.iter().find(|m| trimmed.starts_with(m.as_str())) {
                    value = Some(js_trim(&trimmed[marker.len()..]).to_owned());
                    break;
                }
            }
            match value.filter(|v| !v.is_empty()) {
                Some(v) => values.push(Some(v)),
                None => {
                    failures.push(format!("{task}: missing {}", if english { en } else { es }));
                    values.push(None);
                }
            }
        }
        let [_, interfaces, pattern, _, libraries, done, _] =
            <[Option<String>; 7]>::try_from(values).ok()?;
        for name in interfaces
            .as_deref()
            .unwrap_or_default()
            .split([',', ';'])
            .map(js_trim)
        {
            if !name.is_empty() && !design.contains(name) {
                failures.push(format!("{task}: interface {name} not in design.md"));
            }
        }
        if let Some(pattern) = pattern {
            let pattern = js_trim(&pattern.replace('`', "")).to_owned();
            if !pattern.is_empty() {
                let path = resolve(cwd, &pattern);
                if !path.starts_with(&format!("{}/", resolve(cwd, "")))
                    || !Path::new(&path).exists()
                {
                    failures.push(format!("{task}: pattern file does not exist: {pattern}"));
                }
            }
        }
        if let Some(libraries) = libraries
            .filter(|l| !l.eq_ignore_ascii_case("ninguna") && !l.eq_ignore_ascii_case("none"))
        {
            for library in libraries.split([',', ';']).map(js_trim) {
                if !p.library.is_match(library) {
                    failures.push(format!("{task}: library needs exact version: {library}"));
                }
            }
        }
        if let Some(done) = done {
            let own = format!("{}.", part.id);
            let complete = p.command_word.is_match(&done)
                && p.expected_word.is_match(&done)
                && has_named_test_case(p, &done)
                && criteria(&done).iter().any(|c| c.starts_with(&own));
            if !complete {
                failures.push(format!(
                    "{task}: Done needs command, expected result, named test cases and acceptance ID"
                ));
            }
        }
    }
    let known: Vec<String> = all_parts
        .iter()
        .flat_map(|q| {
            q.acceptance
                .iter()
                .map(move |a| format!("{}.{}", q.id, a.id))
        })
        .collect();
    let own_prefix = format!("{}.", part.id);
    let mut cited: Vec<String> = Vec::new();
    for block in requirement_blocks(requirements) {
        for id in criteria(block) {
            if !cited.iter().any(|c| c == id) {
                cited.push(id.to_owned());
            }
            if !known.iter().any(|k| k == id) {
                failures.push(format!("requirements.md cites nonexistent criterion {id}"));
            } else if !id.starts_with(&own_prefix) {
                failures.push(format!(
                    "warning: requirements.md cites criterion from another part {id}"
                ));
            }
        }
    }
    for a in &part.acceptance {
        let id = format!("{}.{}", part.id, a.id);
        if !cited.contains(&id) {
            failures.push(format!("criterion {id} is not cited by any R<n>"));
        }
    }
    Some(failures)
}

/// What `checkPart` reads of the config, read again by the caller (its warnings print again).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartConfig {
    pub english: bool,
    pub master_plan: bool,
}

/// `checkPart(cwd, part.id)` for a part of the active legacy stage whose `spec` is set.
/// `Ok((failures, read_config))`: whether the TS read the config (its warnings print once more).
///
/// # Errors
/// [`Delegate`] when a file is not UTF-8 or cannot be read.
pub fn check_part(
    cwd: &str,
    specs_dir: &str,
    config: PartConfig,
    part: &Part,
    all_parts: &[Part],
) -> Result<(Vec<String>, bool), Delegate> {
    let id = &part.id;
    let valid = id.strip_prefix('P').is_some_and(|d| {
        d.starts_with(|c: char| ('1'..='9').contains(&c)) && d.bytes().all(|b| b.is_ascii_digit())
    });
    if !valid {
        return Ok((vec![format!("invalid part id {id}")], false));
    }
    if !config.master_plan {
        return Ok((vec!["harness.masterPlan is disabled".to_owned()], true));
    }
    let Some(linked) = part.spec.as_deref() else {
        return Ok((vec![format!("part {id} has no linked spec")], true));
    };
    let root = resolve(cwd, specs_dir);
    let spec = resolve(cwd, linked);
    if spec != root && !spec.starts_with(&format!("{root}/")) {
        return Ok((vec![format!("part {id} spec is outside specsDir")], true));
    }
    let paths: Vec<String> = ["tasks.md", "design.md", "requirements.md"]
        .iter()
        .map(|name| format!("{spec}/{name}"))
        .collect();
    let missing: Vec<String> = paths
        .iter()
        .filter(|p| !Path::new(p).exists())
        .map(|p| format!("missing {p}"))
        .collect();
    if !missing.is_empty() {
        return Ok((missing, true));
    }
    let read = |p: &String| -> Result<String, Delegate> {
        String::from_utf8(fs::read(p).map_err(|_| Delegate)?).map_err(|_| Delegate)
    };
    let (tasks, design, requirements) = (read(&paths[0])?, read(&paths[1])?, read(&paths[2])?);
    let failures = validate_part_spec(
        cwd,
        part,
        all_parts,
        &tasks,
        &design,
        &requirements,
        config.english,
    )
    .ok_or(Delegate)?;
    Ok((failures, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_starts_split_on_every_line_terminator() {
        assert_eq!(
            task_starts("- [ ] **T1**\n- [x]\nx- [ ] no\r- [X] y"),
            vec![0, 13, 29]
        );
        assert_eq!(task_starts("- [ ]x\n"), Vec::<usize>::new());
    }

    #[test]
    fn named_test_cases_follow_the_three_patterns() {
        let Some(p) = PATTERNS.as_ref() else {
            panic!("patterns compile");
        };
        assert!(has_named_test_case(
            p,
            "comando `x`, casos de test: `parsea bien`"
        ));
        assert!(has_named_test_case(p, "it('lee el archivo') pasa"));
        assert!(has_named_test_case(p, "Test cases: lee y escribe, exit 0"));
        assert!(!has_named_test_case(p, "test cases: `test`"));
        assert!(!has_named_test_case(p, "split('x') sin nombre"));
        // `\bit\(`: `split(` does not open an `it(` call.
        assert!(!has_named_test_case(p, "xit('a')"));
    }

    #[test]
    fn requirement_blocks_cut_before_each_requirement() {
        let text = "intro P1.A9\n- **R1** cita P1.A1\n  sigue P1.A2\n**R2** P2.A1\n";
        let blocks = requirement_blocks(text);
        assert_eq!(
            blocks,
            vec!["- **R1** cita P1.A1\n  sigue P1.A2\n", "**R2** P2.A1\n"]
        );
    }

    #[test]
    fn libraries_need_an_exact_version() {
        let Some(p) = PATTERNS.as_ref() else {
            panic!("patterns compile");
        };
        for ok in ["zod@4.6.7", "@scope/pkg@1.2.3-beta.1", "a@1.2.3@4.5.6"] {
            assert!(p.library.is_match(ok), "{ok}");
        }
        for bad in ["zod", "zod@4", "zod@1.2.3.4", ""] {
            assert!(!p.library.is_match(bad), "{bad}");
        }
    }
}
