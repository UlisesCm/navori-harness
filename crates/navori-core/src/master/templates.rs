//! Master-plan templates (`lib/master/templates.ts`): the embedded `core-assets/master-plan/*.md`
//! split into `##` sections, `navori master template <name>` and the `issue` template filled from
//! a part.
//!
//! A missing or non-UTF-8 asset is `None`: the native command hands the invocation to the TS.

use super::state::Part;
use crate::integrity::{is_js_whitespace, js_trim_end};
use crate::render::assets;

/// `TEMPLATE_NAMES`.
pub const TEMPLATE_NAMES: [&str; 11] = [
    "plan",
    "master",
    "decisions",
    "intake",
    "digest",
    "tasks",
    "issue",
    "ux",
    "delivery-master",
    "slice",
    "parts",
];

/// A `## <heading>` section of a template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateSection {
    pub heading: String,
    /// The section's `<!-- only-mode: … -->` restriction.
    pub only_mode: Option<&'static str>,
    /// The `<!-- ux-kind: … -->` marker value.
    pub kind: Option<String>,
    pub body: String,
}

fn skip_ws(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `ONLY_MODE_MARKER`: the mode and how many bytes the marker (and the whitespace after it) takes.
fn only_mode_marker(body: &str) -> Option<(&'static str, usize)> {
    let rest = skip_ws(body.strip_prefix("<!--")?);
    let rest = skip_ws(rest.strip_prefix("only-mode:")?);
    for mode in ["template", "en-curso", "desde-cero"] {
        if let Some(after) = rest.strip_prefix(mode)
            && let Some(after) = skip_ws(after).strip_prefix("-->")
        {
            return Some((mode, body.len() - skip_ws(after).len()));
        }
    }
    None
}

/// `UX_KIND_MARKER`: `[a-z-]+` backtracks until what follows is `\s*-->`.
fn ux_kind_marker(body: &str) -> Option<(String, usize)> {
    let rest = skip_ws(body.strip_prefix("<!--")?);
    let rest = skip_ws(rest.strip_prefix("ux-kind:")?);
    let run = rest
        .bytes()
        .take_while(|b| b.is_ascii_lowercase() || *b == b'-')
        .count();
    (1..=run).rev().find_map(|end| {
        let after = skip_ws(&rest[end..]).strip_prefix("-->")?;
        Some((rest[..end].to_owned(), body.len() - skip_ws(after).len()))
    })
}

/// `/^##\s+(.+)$/` on one line (no `m` flag, `.` stops at line terminators): the heading text.
fn section_heading(line: &str) -> Option<&str> {
    let after = line.strip_prefix("##")?;
    let ws_len = after.len() - skip_ws(after).len();
    if ws_len == 0 {
        return None;
    }
    // `\s+` is greedy and backtracks until `.+` can take the rest of the line.
    let ws_ends: Vec<usize> = after[..ws_len]
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .collect();
    ws_ends.iter().rev().find_map(|&end| {
        let rest = &after[end..];
        let ok = !rest.is_empty() && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
        ok.then_some(rest)
    })
}

/// `splitTemplateSections`.
#[must_use]
pub fn split_template_sections(content: &str) -> Vec<TemplateSection> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut sections = Vec::new();
    let mut heading: Option<String> = None;
    let mut body_lines: Vec<&str> = Vec::new();
    let mut flush = |heading: &Option<String>, body_lines: &[&str]| {
        let Some(heading) = heading else {
            return;
        };
        let mut body = body_lines.join("\n");
        let mut only_mode = None;
        if let Some((mode, used)) = only_mode_marker(&body) {
            only_mode = Some(mode);
            body = body[used..].to_owned();
        }
        let mut kind = None;
        if let Some((value, used)) = ux_kind_marker(&body) {
            kind = Some(value);
            body = body[used..].to_owned();
        }
        sections.push(TemplateSection {
            heading: heading.clone(),
            only_mode,
            kind,
            body: body.trim_matches(is_js_whitespace).to_owned(),
        });
    };
    for line in normalized.split('\n') {
        if let Some(text) = section_heading(line) {
            flush(&heading, &body_lines);
            heading = Some(text.trim_matches(is_js_whitespace).to_owned());
            body_lines.clear();
        } else if heading.is_some() {
            body_lines.push(line);
        }
    }
    flush(&heading, &body_lines);
    sections
}

/// `readTemplateFile(name, language)` with the language fallback of `resolveTemplatePath`.
#[must_use]
pub fn read_template_file(name: &str, english: bool) -> Option<String> {
    let base = || assets::core(&format!("core-assets/master-plan/{name}.md"));
    let bytes = if english {
        assets::core(&format!("core-assets/master-plan/en/{name}.md")).or_else(base)
    } else {
        base()
    }?;
    String::from_utf8(bytes.to_vec()).ok()
}

/// `templateHeaders(name, language, mode)`: the headings `check` validates a document against.
#[must_use]
pub fn template_headers(name: &str, english: bool, mode: Option<&str>) -> Option<Vec<String>> {
    let sections = split_template_sections(&read_template_file(name, english)?);
    Some(
        sections
            .into_iter()
            .filter(|s| s.only_mode.is_none() || s.only_mode == mode)
            .map(|s| s.heading)
            .collect(),
    )
}

/// `printTemplate(name, language, mode)`.
#[must_use]
pub fn print_template(name: &str, english: bool, mode: Option<&str>) -> Option<String> {
    let content = read_template_file(name, english)?;
    let all = split_template_sections(&content);
    if all.is_empty() {
        let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        return Some(format!("{}\n", js_trim_end(&normalized)));
    }
    let shown: Vec<String> = all
        .iter()
        .filter(|s| s.only_mode.is_none() || s.only_mode == mode)
        .map(|s| format!("## {}\n\n{}", s.heading, s.body))
        .collect();
    Some(format!("{}\n", shown.join("\n\n")))
}

fn bullet_list(items: &[String], empty: &str) -> String {
    if items.is_empty() {
        empty.to_owned()
    } else {
        items
            .iter()
            .map(|i| format!("- {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// `fillTokens`: `{{word}}` replaced by its value when it is one of `vars`.
fn fill_tokens(content: &str, vars: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(content.len());
    let mut at = 0;
    while at < content.len() {
        let rest = &content[at..];
        if let Some(inner) = rest.strip_prefix("{{") {
            let word = inner
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                .count();
            if word > 0 && inner[word..].starts_with("}}") {
                let key = &inner[..word];
                match vars.iter().find(|(k, _)| *k == key) {
                    Some((_, value)) => out.push_str(value),
                    None => out.push_str(&rest[..word + 4]),
                }
                at += word + 4;
                continue;
            }
        }
        let c = rest.chars().next().map_or(1, char::len_utf8);
        out.push_str(&rest[..c]);
        at += c;
    }
    out
}

/// `printIssueTemplate(part, stageDir, specsDir, language)` without its trailing newline.
#[must_use]
pub fn print_issue_template(
    part: &Part,
    stage_dir: &str,
    specs_dir: &str,
    english: bool,
) -> Option<String> {
    let content = read_template_file("issue", english)?;
    let (none_masc, none_fem) = if english {
        ("None", "None")
    } else {
        ("Ninguno", "Ninguna")
    };
    let acceptance: Vec<String> = part
        .acceptance
        .iter()
        .map(|a| format!("{}.{} ({}): {}", part.id, a.id, a.method, a.description))
        .collect();
    let depends_on = if part.depends_on.is_empty() {
        none_fem.to_owned()
    } else {
        part.depends_on.join(", ")
    };
    Some(fill_tokens(
        &content,
        &[
            ("stage", stage_dir.to_owned()),
            ("partId", part.id.clone()),
            ("title", part.title.clone()),
            ("objective", part.objective.clone()),
            ("scope", bullet_list(&part.scope, none_masc)),
            ("outOfScope", bullet_list(&part.out_of_scope, none_masc)),
            ("dependsOn", depends_on),
            ("acceptance", bullet_list(&acceptance, none_masc)),
            (
                "masterPath",
                format!("{specs_dir}/_master/{stage_dir}/MASTER.md"),
            ),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_keep_their_markers_and_trim_the_body() {
        let text = "intro\r\n## Uno\r\n<!--  only-mode: en-curso -->\r\n\r\ncuerpo\r\n\r\n## Dos\n<!-- ux-kind: screens-->\nx\n### no\n##sin\n## \u{2028}\n";
        let sections = split_template_sections(text);
        let shown: Vec<(&str, Option<&str>, Option<&str>, &str)> = sections
            .iter()
            .map(|s| {
                (
                    s.heading.as_str(),
                    s.only_mode,
                    s.kind.as_deref(),
                    s.body.as_str(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                ("Uno", Some("en-curso"), None, "cuerpo"),
                (
                    "Dos",
                    None,
                    Some("screens"),
                    // `trim()` also strips the trailing U+2028 and the space before it.
                    "x\n### no\n##sin\n##"
                ),
            ]
        );
    }

    #[test]
    fn tokens_fill_only_known_words() {
        let vars = [("a", "1".to_owned())];
        assert_eq!(
            fill_tokens("{{a}} {{b}} {{{a}}} {{ a }} {{a}", &vars),
            "1 {{b}} {1} {{ a }} {{a}"
        );
    }

    #[test]
    fn every_template_is_embedded_in_both_languages() {
        for name in TEMPLATE_NAMES {
            for english in [false, true] {
                assert!(
                    print_template(name, english, None).is_some(),
                    "{name} {english}"
                );
            }
        }
    }
}
