//! Block-based `tasks.md` parser, port of `lib/spec/tasks.ts` (spec 0044 D2; R4, R10).
//!
//! Same grammar and the same quirks: a block is its first line plus every following line up to
//! the next top-level list item or heading, fenced regions are dropped, and a file with no
//! `## E<n>` heading outside fences is `legacy`. Pure: text in, [`ParsedTasks`] out.

use super::text::{
    digits_len, find_ignore_case, is_line_terminator, is_space, squash, starts_with_ignore_case,
    trim, word_starts,
};

/// What a task may declare it changes (`TASK_EFFECTS`).
pub const TASK_EFFECTS: [&str; 4] = ["behavior", "docs", "tests", "schema"];

/// One `- **A<n>**` acceptance criterion.
#[derive(Debug, Clone, PartialEq)]
pub struct Criterion {
    pub id: String,
    pub observable: bool,
    pub description: String,
    pub command: String,
    pub expected: String,
    pub line: usize,
}

/// One `- [ ] **T<n>**` task (not retired).
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub id: String,
    pub done: bool,
    pub requirements: Vec<String>,
    pub effect: Option<&'static str>,
    pub effect_raw: Option<String>,
    pub test: Option<String>,
    pub line: usize,
}

/// One `- **Consumes:**` line.
#[derive(Debug, Clone, PartialEq)]
pub struct Consumer {
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Milestone {
    pub id: String,
    pub title: String,
    pub line: usize,
    pub criteria: Vec<Criterion>,
    pub consumers: Vec<Consumer>,
    pub tasks: Vec<Task>,
    pub retired: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub id: String,
    pub title: String,
    pub foundation: bool,
    /// `Number.parseInt` of the declared digits; `None` when the delivery declares none.
    pub estimated_loc: Option<f64>,
    pub line: usize,
    pub milestones: Vec<Milestone>,
}

/// A checkbox item of a delivery-format file that is not a well-formed task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Malformed {
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Deliveries,
    Legacy,
}

impl Format {
    /// The `TasksFormat` string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deliveries => "deliveries",
            Self::Legacy => "legacy",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTasks {
    pub format: Format,
    pub deliveries: Vec<Delivery>,
    pub orphan_tasks: Vec<Task>,
    pub orphan_criteria: Vec<Criterion>,
    pub malformed: Vec<Malformed>,
    pub legacy_task_count: usize,
}

impl ParsedTasks {
    /// `allTasks`: milestone tasks in order, then the orphans.
    pub fn all_tasks(&self) -> impl Iterator<Item = &Task> {
        self.deliveries
            .iter()
            .flat_map(|d| d.milestones.iter().flat_map(|m| m.tasks.iter()))
            .chain(self.orphan_tasks.iter())
    }
}

/// A line kept by [`visible_lines`]: 1-based number and text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceLine<'a> {
    pub n: usize,
    pub text: &'a str,
}

/// `FENCE_OPEN` (`/^\s*(`{3,}|~{3,})/`): the fence character and run length.
fn fence_open(line: &str) -> Option<(char, usize)> {
    let rest = line.trim_start_matches(is_space);
    let ch = rest.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let run = rest.chars().take_while(|c| *c == ch).count();
    (run >= 3).then_some((ch, run))
}

/// The closing fence `^\s*<ch>{length,}\s*$`.
fn closes_fence(line: &str, ch: char, length: usize) -> bool {
    let rest = line.trim_start_matches(is_space);
    let run = rest.chars().take_while(|c| *c == ch).count();
    run >= length && rest[run..].chars().all(is_space)
}

/// `visibleLines`: `text.split(/\r?\n/)` without the fenced regions and their delimiters.
#[must_use]
pub fn visible_lines(text: &str) -> Vec<SourceLine<'_>> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some((ch, length)) = fence {
            if closes_fence(line, ch, length) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(line) {
            fence = Some(open);
            continue;
        }
        out.push(SourceLine {
            n: index + 1,
            text: line,
        });
    }
    out
}

/// `HEADING` (`/^(#{1,6})\s+(.*?)\s*#*\s*$/`): level and title.
fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    let body = rest.trim_start_matches(is_space);
    if body.len() == rest.len() {
        return None;
    }
    let title = body
        .trim_end_matches(is_space)
        .trim_end_matches('#')
        .trim_end_matches(is_space);
    if title.chars().any(is_line_terminator) {
        return None;
    }
    Some((level, title))
}

/// `DELIVERY_HEADING` / `MILESTONE_HEADING`
/// (`/^<P>(\d+)(?!\d)(?:\s*[—–:-]\s*|\s+|$)(.*)$/` on a title): the number and the rest.
fn numbered(title: &str, prefix: char) -> Option<(&str, &str)> {
    let after_prefix = title.strip_prefix(prefix)?;
    let count = digits_len(after_prefix);
    if count == 0 {
        return None;
    }
    let (number, after) = after_prefix.split_at(count);
    let spaced = after.trim_start_matches(is_space);
    let rest = match spaced.chars().next() {
        Some(dash @ ('—' | '–' | ':' | '-')) => {
            spaced[dash.len_utf8()..].trim_start_matches(is_space)
        }
        _ if spaced.len() < after.len() || after.is_empty() => spaced,
        _ => return None,
    };
    Some((number, rest))
}

/// `LOC_LINE`
/// (`/^\s*(?:[-*]\s+)?(?:\*\*)?Estimated LOC:(?:\*\*)?\s*~?(\d[\d,_]*)/i`): the digits.
fn loc_digits(line: &str) -> Option<&str> {
    let mut rest = line.trim_start_matches(is_space);
    if let Some(after) = rest.strip_prefix(['-', '*']) {
        let spaced = after.trim_start_matches(is_space);
        if spaced.len() < after.len() {
            rest = spaced;
        }
    }
    rest = rest.strip_prefix("**").unwrap_or(rest);
    const KEY: &str = "Estimated LOC:";
    if !starts_with_ignore_case(rest, KEY) {
        return None;
    }
    rest = &rest[KEY.len()..];
    rest = rest.strip_prefix("**").unwrap_or(rest);
    rest = rest.trim_start_matches(is_space);
    rest = rest.strip_prefix('~').unwrap_or(rest);
    if !rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let end = rest
        .bytes()
        .take_while(|b| b.is_ascii_digit() || *b == b',' || *b == b'_')
        .count();
    Some(&rest[..end])
}

/// `TOP_LEVEL_ITEM` (`/^(?:[-*+]|\d+[.)])\s/`).
fn is_top_level_item(line: &str) -> bool {
    let rest = if let Some(after) = line.strip_prefix(['-', '*', '+']) {
        after
    } else {
        let count = digits_len(line);
        if count == 0 {
            return false;
        }
        match line[count..].strip_prefix(['.', ')']) {
            Some(after) => after,
            None => return false,
        }
    };
    rest.starts_with(is_space)
}

/// `isBlockStart`: a heading or a top-level list item.
fn is_block_start(line: &str) -> bool {
    heading(line).is_some() || is_top_level_item(line)
}

/// `CHECKBOX` (`/^- \[([ xX])\] (.*)$/`): whether it is checked, and the rest.
fn checkbox(line: &str) -> Option<(bool, &str)> {
    let rest = line.strip_prefix("- [")?;
    let mark = rest
        .chars()
        .next()
        .filter(|c| matches!(c, ' ' | 'x' | 'X'))?;
    let rest = rest[1..].strip_prefix("] ")?;
    if rest.chars().any(is_line_terminator) {
        return None;
    }
    Some((mark != ' ', rest))
}

/// `/^<open>(<P>\d+)<close>/`: the id, e.g. `**T12**` or `~~T3~~`.
fn delimited_id<'a>(text: &'a str, delimiter: &str, prefix: char) -> Option<&'a str> {
    let rest = text.strip_prefix(delimiter)?;
    let after = rest.strip_prefix(prefix)?;
    let count = digits_len(after);
    if count == 0 || !after[count..].starts_with(delimiter) {
        return None;
    }
    Some(&rest[..=count])
}

/// `CONSUMES_START` (`/^- \*\*Consumes:\*\*\s*(.*)$/`).
fn is_consumes(line: &str) -> bool {
    line.strip_prefix("- **Consumes:**").is_some_and(|rest| {
        !rest
            .trim_start_matches(is_space)
            .chars()
            .any(is_line_terminator)
    })
}

/// A code span found by [`find_command`]: its squashed text and byte range in the block.
struct Span {
    command: String,
    start: usize,
    end: usize,
}

/// `findCommand`: the first backtick span that begins a line, or the first span at all. A run of
/// N backticks closes at the next run of exactly N.
fn find_command(text: &str) -> Option<Span> {
    let bytes = text.as_bytes();
    let run_end = |from: usize| {
        let mut end = from;
        while bytes.get(end) == Some(&b'`') {
            end += 1;
        }
        end
    };
    let mut first: Option<Span> = None;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let open_end = run_end(index);
        let length = open_end - index;
        let mut search = open_end;
        let mut close = None;
        while let Some(found) = text[search..].find('`') {
            let at = search + found;
            let end = run_end(at);
            if end - at == length {
                close = Some(at);
                break;
            }
            search = end;
        }
        let Some(close) = close else {
            index = open_end;
            continue;
        };
        let span = Span {
            command: squash(&text[open_end..close]),
            start: index,
            end: close + length,
        };
        let line_start = text[..index].rfind('\n').map_or(0, |at| at + 1);
        if trim(&text[line_start..index]).is_empty() {
            return Some(span);
        }
        index = close + length;
        if first.is_none() {
            first = Some(span);
        }
    }
    first
}

/// Byte offset and length of the last `→` / `->` of `text` (`matchAll(/→|->/g).at(-1)`).
fn last_arrow(text: &str) -> Option<(usize, usize)> {
    let mut last = None;
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        if rest.starts_with('→') {
            last = Some((at, '→'.len_utf8()));
            at += '→'.len_utf8();
        } else if rest.starts_with("->") {
            last = Some((at, 2));
            at += 2;
        } else {
            at += rest.chars().next().map_or(1, char::len_utf8);
        }
    }
    last
}

/// The `description.replace(/^[\s—–:·-]+|[\s—–:·-]+$/g, "")` set.
fn is_description_edge(ch: char) -> bool {
    is_space(ch) || matches!(ch, '—' | '–' | ':' | '·' | '-')
}

fn parse_criterion(id: &str, block: &str, line: usize) -> Criterion {
    let first_line = block.split('\n').next().unwrap_or_default();
    let found = find_command(block);
    let marker = format!("**{id}**");
    let id_end = block.find(&marker).unwrap_or(0) + id.len() + 4;
    let stop = found.as_ref().map_or(block.len(), |span| span.start);
    let raw = if stop > id_end {
        &block[id_end..stop]
    } else {
        ""
    };
    let without_tag = match find_ignore_case(raw, "[observable]") {
        Some(at) => format!("{}{}", &raw[..at], &raw[at + "[observable]".len()..]),
        None => raw.to_owned(),
    };
    let description = super::text::collapse_spaces(&without_tag)
        .trim_matches(is_description_edge)
        .to_owned();
    let expected = found.as_ref().map_or_else(String::new, |span| {
        let tail = &block[span.end..];
        last_arrow(tail).map_or_else(String::new, |(at, width)| squash(&tail[at + width..]))
    });
    Criterion {
        id: id.to_owned(),
        observable: find_ignore_case(first_line, "[observable]").is_some(),
        description,
        command: found.map(|span| span.command).unwrap_or_default(),
        expected,
        line,
    }
}

/// `/\*\*T\d+\*\*\s*\(([^)]*)\)/.exec(block)?.[1]`.
fn requirements_text(block: &str) -> Option<&str> {
    for (at, _) in block.match_indices("**T") {
        let after = &block[at + 3..];
        let count = digits_len(after);
        if count == 0 {
            continue;
        }
        let Some(rest) = after[count..].strip_prefix("**") else {
            continue;
        };
        let Some(inner) = rest.trim_start_matches(is_space).strip_prefix('(') else {
            continue;
        };
        if let Some(close) = inner.find(')') {
            return Some(&inner[..close]);
        }
    }
    None
}

/// `[...text.matchAll(/R\d+/g)].map((m) => m[0])`.
fn requirement_refs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = text[at..].find('R') {
        let start = at + found;
        let count = digits_len(&text[start + 1..]);
        if count > 0 {
            out.push(text[start..=start + count].to_owned());
            at = start + 1 + count;
        } else {
            at = start + 1;
        }
    }
    out
}

/// `/\beffect:\s*([A-Za-z]+)/.exec(block)?.[1]`.
fn effect_raw(block: &str) -> Option<&str> {
    word_starts(block, "effect:").find_map(|at| {
        let rest = block[at + "effect:".len()..].trim_start_matches(is_space);
        let count = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
        (count > 0).then(|| &rest[..count])
    })
}

/// `/\btest:\s*([\s\S]*)$/` then `.split(/\s·\s/, 1)[0]`, squashed; `None` when empty.
fn test_value(block: &str) -> Option<String> {
    let at = word_starts(block, "test:").next()?;
    let raw = block[at + "test:".len()..].trim_start_matches(is_space);
    let chars: Vec<(usize, char)> = raw.char_indices().collect();
    let cut = chars
        .windows(3)
        .find(|w| is_space(w[0].1) && w[1].1 == '·' && is_space(w[2].1))
        .map_or(raw.len(), |w| w[0].0);
    let test = squash(&raw[..cut]);
    (!test.is_empty()).then_some(test)
}

fn parse_task(id: &str, done: bool, block: &str, line: usize) -> Task {
    let requirements = requirements_text(block)
        .map(requirement_refs)
        .unwrap_or_default();
    let effect_raw = effect_raw(block);
    let effect = effect_raw.and_then(|raw| {
        let lower = raw.to_ascii_lowercase();
        TASK_EFFECTS
            .iter()
            .copied()
            .find(|candidate| *candidate == lower)
    });
    Task {
        id: id.to_owned(),
        done,
        requirements,
        effect,
        effect_raw: effect_raw.map(str::to_owned),
        test: test_value(block),
        line,
    }
}

/// `parseTasks`: never fails.
#[must_use]
pub fn parse(text: &str) -> ParsedTasks {
    let lines = visible_lines(text);
    let has_delivery = lines.iter().any(|l| {
        heading(l.text).is_some_and(|(level, title)| level == 2 && numbered(title, 'E').is_some())
    });
    let legacy_task_count = lines
        .iter()
        .filter(|l| {
            checkbox(l.text).is_some_and(|(_, rest)| delimited_id(rest, "~~", 'T').is_none())
        })
        .count();
    let mut result = ParsedTasks {
        format: if has_delivery {
            Format::Deliveries
        } else {
            Format::Legacy
        },
        deliveries: Vec::new(),
        orphan_tasks: Vec::new(),
        orphan_criteria: Vec::new(),
        malformed: Vec::new(),
        legacy_task_count,
    };
    if !has_delivery {
        return result;
    }

    // Indices into `result.deliveries` and its last delivery's milestones.
    let mut delivery: Option<usize> = None;
    let mut milestone: Option<usize> = None;
    let mut i = 0;
    while i < lines.len() {
        let current = lines[i];
        i += 1;
        if let Some((level, title)) = heading(current.text) {
            let delivery_match = if level == 2 {
                numbered(title, 'E')
            } else {
                None
            };
            let milestone_match = if level == 3 && delivery.is_some() {
                numbered(title, 'M')
            } else {
                None
            };
            if let Some((number, rest)) = delivery_match {
                let raw_title = trim(rest);
                let foundation = raw_title.len() >= "(foundation)".len()
                    && raw_title.is_char_boundary(raw_title.len() - "(foundation)".len())
                    && raw_title[raw_title.len() - "(foundation)".len()..]
                        .eq_ignore_ascii_case("(foundation)");
                let title = if foundation {
                    trim(&raw_title[..raw_title.len() - "(foundation)".len()])
                } else {
                    raw_title
                };
                result.deliveries.push(Delivery {
                    id: format!("E{number}"),
                    title: title.to_owned(),
                    foundation,
                    estimated_loc: None,
                    line: current.n,
                    milestones: Vec::new(),
                });
                delivery = Some(result.deliveries.len() - 1);
                milestone = None;
            } else if let (Some((number, rest)), Some(d)) = (milestone_match, delivery) {
                let owner = &mut result.deliveries[d];
                owner.milestones.push(Milestone {
                    id: format!("M{number}"),
                    title: trim(rest).to_owned(),
                    line: current.n,
                    criteria: Vec::new(),
                    consumers: Vec::new(),
                    tasks: Vec::new(),
                    retired: Vec::new(),
                });
                milestone = Some(owner.milestones.len() - 1);
            } else if level <= 2 {
                delivery = None;
                milestone = None;
            } else if level == 3 {
                milestone = None;
            }
            continue;
        }

        if let Some(d) = delivery
            && milestone.is_none()
            && result.deliveries[d].estimated_loc.is_none()
            && let Some(digits) = loc_digits(current.text)
        {
            let clean: String = digits.chars().filter(|c| c.is_ascii_digit()).collect();
            result.deliveries[d].estimated_loc = clean.parse::<f64>().ok();
            continue;
        }

        if !is_top_level_item(current.text) {
            continue;
        }
        let mut block = current.text.to_owned();
        while i < lines.len() && !is_block_start(lines[i].text) {
            block.push('\n');
            block.push_str(lines[i].text);
            i += 1;
        }

        let target = delivery.zip(milestone);
        if is_consumes(current.text) {
            if let Some((d, m)) = target {
                let body = block.strip_prefix("- **Consumes:**").unwrap_or(&block);
                result.deliveries[d].milestones[m].consumers.push(Consumer {
                    text: squash(body),
                    line: current.n,
                });
            }
            continue;
        }
        if let Some(id) = current
            .text
            .strip_prefix("- ")
            .and_then(|rest| delimited_id(rest, "**", 'A'))
        {
            let parsed = parse_criterion(id, &block, current.n);
            match target {
                Some((d, m)) => result.deliveries[d].milestones[m].criteria.push(parsed),
                None => result.orphan_criteria.push(parsed),
            }
            continue;
        }
        let Some((done, rest)) = checkbox(current.text) else {
            continue;
        };
        if let Some(retired) = delimited_id(rest, "~~", 'T') {
            if let Some((d, m)) = target {
                result.deliveries[d].milestones[m]
                    .retired
                    .push(retired.to_owned());
            }
            continue;
        }
        let Some(task_id) = delimited_id(rest, "**", 'T') else {
            result.malformed.push(Malformed {
                line: current.n,
                text: rest.to_owned(),
            });
            continue;
        };
        let task = parse_task(task_id, done, &block, current.n);
        match target {
            Some((d, m)) => result.deliveries[d].milestones[m].tasks.push(task),
            None => result.orphan_tasks.push(task),
        }
    }
    result
}

/// A delivery as `plan gate` reads it: its id and its milestone ids, in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryOutline {
    pub id: String,
    pub milestones: Vec<String>,
}

/// The structure `plan gate` reads of a `tasks.md` (spec 0059 D33): format, deliveries with their
/// milestones, and how many orphan and malformed items it refuses.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TasksOutline {
    /// `true` for the delivery format, `false` for `legacy`.
    pub deliveries_format: bool,
    pub deliveries: Vec<DeliveryOutline>,
    pub orphan_tasks: usize,
    pub orphan_criteria: usize,
    pub malformed: usize,
    pub legacy_task_count: usize,
}

/// [`parse`] reduced to what `plan gate` reads. Always `Some`: the `Option` keeps the contract of
/// the regex-based parser 0059 E1 ships, whose `None` meant a pattern that failed to compile.
#[must_use]
pub fn parse_tasks(text: &str) -> Option<TasksOutline> {
    let parsed = parse(text);
    Some(TasksOutline {
        deliveries_format: parsed.format == Format::Deliveries,
        deliveries: parsed
            .deliveries
            .iter()
            .map(|d| DeliveryOutline {
                id: d.id.clone(),
                milestones: d.milestones.iter().map(|m| m.id.clone()).collect(),
            })
            .collect(),
        orphan_tasks: parsed.orphan_tasks.len(),
        orphan_criteria: parsed.orphan_criteria.len(),
        malformed: parsed.malformed.len(),
        legacy_task_count: parsed.legacy_task_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tasks_outlines_what_plan_gate_reads() {
        let text = "## E1 \u{2014} A\n### M1 \u{2014} a\n- **A1** `a` \u{2192} b\n- [ ] **T1** (R1) x\n\
                    ### M2\n## Notes\n- [ ] **T9** orphan\n- **A9** orphan `c` \u{2192} d\n- [ ] no id\n";
        assert_eq!(
            parse_tasks(text),
            Some(TasksOutline {
                deliveries_format: true,
                deliveries: vec![DeliveryOutline {
                    id: "E1".to_owned(),
                    milestones: vec!["M1".to_owned(), "M2".to_owned()],
                }],
                orphan_tasks: 1,
                orphan_criteria: 1,
                malformed: 1,
                legacy_task_count: 3,
            })
        );
        let legacy = parse_tasks("- [ ] one\n- [x] two\n").unwrap_or_default();
        assert!(!legacy.deliveries_format);
        assert_eq!(legacy.legacy_task_count, 2);
    }

    #[test]
    fn heading_keeps_the_js_lazy_title() {
        assert_eq!(heading("## E1 — Foo ##  "), Some((2, "E1 — Foo")));
        assert_eq!(heading("## C#"), Some((2, "C")));
        assert_eq!(heading("##"), None);
        assert_eq!(heading("####### x"), None);
        assert_eq!(heading("## a\rb"), None);
        assert_eq!(heading("## a\r"), Some((2, "a")));
    }

    #[test]
    fn numbered_headings_follow_the_separator_alternatives() {
        assert_eq!(numbered("E1 — Foo", 'E'), Some(("1", "Foo")));
        assert_eq!(numbered("E12:Bar", 'E'), Some(("12", "Bar")));
        assert_eq!(numbered("E3", 'E'), Some(("3", "")));
        assert_eq!(numbered("E3 x", 'E'), Some(("3", "x")));
        assert_eq!(numbered("E3x", 'E'), None);
        assert_eq!(numbered("E", 'E'), None);
    }

    #[test]
    fn loc_line_accepts_the_list_and_bold_forms() {
        assert_eq!(loc_digits("Estimated LOC: 1,500"), Some("1,500"));
        assert_eq!(loc_digits("- **estimated loc:** ~200"), Some("200"));
        assert_eq!(loc_digits("*Estimated LOC: 5"), None);
        assert_eq!(loc_digits("Estimated LOC: x"), None);
    }

    #[test]
    fn find_command_prefers_a_span_that_opens_a_line() {
        let block = "- **A1** — uses `inline` then\n  `cmd  run` → ok";
        let span = find_command(block);
        assert_eq!(span.map(|s| s.command), Some("cmd run".to_owned()));
    }

    #[test]
    fn parses_a_delivery_file() {
        let text = "# T\n\n## E1 — One (foundation)\nEstimated LOC: 10\n\n### M1 — First\n\
                    - **Consumes:** x → y\n- **A1** [observable] — d · `c` → out\n\
                    - [x] **T1** (R1, R2) — w · effect: Behavior · test: `t`::\"n\" · x\n\
                    - [ ] ~~T2~~ gone\n- [ ] no id\n```\n## E9\n```\n";
        let parsed = parse(text);
        assert_eq!(parsed.format, Format::Deliveries);
        let delivery = &parsed.deliveries[0];
        assert_eq!(delivery.title, "One");
        assert!(delivery.foundation);
        assert_eq!(delivery.estimated_loc, Some(10.0));
        let milestone = &delivery.milestones[0];
        assert_eq!(milestone.consumers[0].text, "x → y");
        let criterion = &milestone.criteria[0];
        assert!(criterion.observable);
        assert_eq!(criterion.description, "d");
        assert_eq!(criterion.command, "c");
        assert_eq!(criterion.expected, "out");
        let task = &milestone.tasks[0];
        assert!(task.done);
        assert_eq!(task.requirements, vec!["R1", "R2"]);
        assert_eq!(task.effect, Some("behavior"));
        assert_eq!(task.test.as_deref(), Some("`t`::\"n\""));
        assert_eq!(milestone.retired, vec!["T2"]);
        assert_eq!(parsed.malformed[0].text, "no id");
        assert_eq!(parsed.deliveries.len(), 1);
        assert_eq!(parsed.legacy_task_count, 2);
    }
}
