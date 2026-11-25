//! Quality-gate log verdict, port of `lib/gate/summary.ts`: the pure heuristics that turn a log
//! into a compact stdout. The exit code is the verdict; the summary only helps a reader skip the
//! log, so a miss never hides a failure.
//!
//! The TS works on JS strings, so lengths, slices and cuts are UTF-16 code units and budgets are
//! UTF-8 bytes (`Buffer.byteLength`, a lone surrogate counting 3). Text is therefore kept as
//! `Vec<u16>` from end to end; a cut that leaves a lone surrogate comes out as U+FFFD, exactly as
//! Node writes it. Regexes use JS (non-`u`) semantics through [`crate::js_re`].

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::integrity::is_js_whitespace;
use crate::js_re::{DOT, non_ws, ws};

const MAX_LINE: usize = 300;
const GREEN_CAP: i64 = 2048;
const RED_CAP: i64 = 4096;
const TAIL_GREEN: usize = 3;
const TAIL_RED: usize = 15;
const EXCERPT_BUDGET: i64 = 2400;
const CONTEXT: usize = 2;
const ELLIPSIS: u16 = 0x2026;
const MARKER: &str = "\n… [truncated] …\n";

/// JS `\b` (ASCII word boundary), which the `regex` crate spells `(?-u:\b)`.
const WB: &str = r"(?-u:\b)";

/// Runner totals: vitest/jest, pytest, cargo, go, coverage tables.
static TOTALS: LazyLock<Option<Regex>> = LazyLock::new(|| {
    let (s, ns) = (ws(), non_ws());
    Regex::new(&format!(
        "^{s}*(?:Test Files{s}|Test Suites:|Tests?:|Coverage:|Tests{s}+[0-9]|Snapshots:\
         |=+ {DOT}*{WB}(?:passed|failed|error|skipped){WB}{DOT}* in [0-9.]+s\
         |[0-9]+ (?:passed|failed){WB}{DOT}* in [0-9.]+s|test result:|ok{s}+{ns}+|All files{WB}\
         |TOTAL{WB}|Statements{s}*:|Branches{s}*:|Functions{s}*:|Lines{s}*:)"
    ))
    .ok()
});
static CARGO_RESULT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!("^{}*test result:", ws())).ok());
static GO_OK: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!("^ok{}+{}+", ws(), non_ws())).ok());
/// Failure markers. `N failed` only counts when N > 0 so "0 failed" stays green.
static FAILURE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(&format!(
        "{WB}FAIL(?:ED)?{WB}|--- FAIL|✗|×|{WB}Error{WB}|{WB}error(?:\\[|:)|{WB}panicked{WB}\
         |AssertionError|{WB}[1-9][0-9]* failed{WB}"
    ))
    .ok()
});
/// `util.stripVTControlCharacters` of Node v26: an OSC run up to BEL / ST / U+009C, or a
/// CSI-style sequence introduced by ESC or U+009B.
static ANSI: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        "(?:\u{1b}\\](?s:.)*?(?:\u{7}|\u{1b}\\\\|\u{9c}))\
         |[\u{1b}\u{9b}][\\[\\]()#;?]*(?:[0-9]{1,4}(?:[;:][0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]",
    )
    .ok()
});

/// A JS string: UTF-16 code units.
type Units = Vec<u16>;

fn is_match(re: &LazyLock<Option<Regex>>, line: &[u16]) -> bool {
    re.as_ref()
        .is_some_and(|re| re.is_match(&String::from_utf16_lossy(line)))
}

fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

/// `util.stripVTControlCharacters`, including its no-ESC/no-U+009B short circuit.
fn strip_vt(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains(['\u{1b}', '\u{9b}']) {
        return std::borrow::Cow::Borrowed(text);
    }
    match ANSI.as_ref() {
        Some(re) => re.replace_all(text, ""),
        None => std::borrow::Cow::Borrowed(text),
    }
}

fn is_ws_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

/// `String.prototype.trim() === ""`.
fn is_blank(line: &[u16]) -> bool {
    line.iter().all(|&unit| is_ws_unit(unit))
}

/// `Buffer.byteLength`: a surrogate pair is 4 bytes, a lone surrogate 3 (as U+FFFD).
fn byte_len(text: &[u16]) -> i64 {
    let mut total: i64 = 0;
    let mut i = 0;
    while i < text.len() {
        let unit = text[i];
        let paired = (0xd800..0xdc00).contains(&unit)
            && text
                .get(i + 1)
                .is_some_and(|n| (0xdc00..0xe000).contains(n));
        total += match unit {
            0..0x80 => 1,
            0x80..0x800 => 2,
            _ if paired => 4,
            _ => 3,
        };
        i += if paired { 2 } else { 1 };
    }
    total
}

/// Strips ANSI escapes and clips overlong lines (`cleanLines`).
fn clean_lines(log: &str) -> Vec<Units> {
    let stripped = strip_vt(log);
    let pieces: Vec<&str> = stripped.split('\n').collect();
    let last = pieces.len().saturating_sub(1);
    pieces
        .iter()
        .enumerate()
        .map(|(i, piece)| {
            // `/\r?\n/`: the `\r` only goes when a `\n` follows it.
            let piece = if i < last {
                piece.strip_suffix('\r').unwrap_or(piece)
            } else {
                piece
            };
            let mut line = units(piece);
            if line.len() > MAX_LINE {
                line.truncate(MAX_LINE);
                line.push(ELLIPSIS);
            } else {
                while line.last().is_some_and(|&unit| is_ws_unit(unit)) {
                    line.pop();
                }
            }
            line
        })
        .collect()
}

fn join(lines: &[Units]) -> Units {
    let mut out = Units::new();
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push(u16::from(b'\n'));
        }
        out.extend_from_slice(line);
    }
    out
}

/// Keeps head and tail of `text` within `max_bytes` (UTF-8), cutting the middle (`truncateMiddle`).
fn truncate_middle(text: &[u16], max_bytes: i64) -> Units {
    if byte_len(text) <= max_bytes {
        return text.to_vec();
    }
    let marker = units(MARKER);
    let mut keep = (max_bytes - byte_len(&marker)).max(0) as usize;
    loop {
        let head = keep.div_ceil(2);
        let tail = keep / 2;
        let mut out: Units = text[..head.min(text.len())].to_vec();
        out.extend_from_slice(&marker);
        if tail > 0 {
            out.extend_from_slice(&text[text.len().saturating_sub(tail)..]);
        }
        if byte_len(&out) <= max_bytes || keep == 0 {
            return out;
        }
        keep = (keep as f64 * 0.9).floor() as usize;
    }
}

fn last_non_empty(lines: &[Units], count: usize) -> Vec<Units> {
    let kept: Vec<&Units> = lines.iter().filter(|l| !is_blank(l)).collect();
    kept[kept.len().saturating_sub(count)..]
        .iter()
        .map(|l| (*l).clone())
        .collect()
}

/// Totals lines from a log, with per-package/per-crate repetition collapsed.
fn totals_lines(lines: &[Units]) -> Vec<Units> {
    let mut out: Vec<Units> = Vec::new();
    let cargo: Vec<&Units> = lines
        .iter()
        .filter(|l| is_match(&CARGO_RESULT, l))
        .collect();
    let go_ok = lines.iter().filter(|l| is_match(&GO_OK, l)).count();
    for line in lines {
        if !is_match(&TOTALS, line) || is_match(&CARGO_RESULT, line) || is_match(&GO_OK, line) {
            continue;
        }
        if !out.contains(line) {
            out.push(line.clone());
        }
    }
    if let Some(last) = cargo.last() {
        out.push((*last).clone());
        if cargo.len() > 1 {
            out.push(units(&format!(
                "({} \"test result\" lines; last shown)",
                cargo.len()
            )));
        }
    }
    if go_ok > 0 {
        out.push(units(&format!("go: {go_ok} package(s) ok")));
    }
    out.split_off(out.len().saturating_sub(10))
}

/// Green body: one totals line per recognized runner; a log with none falls back to its last 3
/// non-empty lines.
fn summarize_green(log: &str, budget: i64) -> Units {
    let lines = clean_lines(log);
    let mut body = totals_lines(&lines);
    if body.is_empty() {
        body = last_non_empty(&lines, TAIL_GREEN);
    }
    truncate_middle(&join(&body), budget)
}

/// Failure excerpt (matches + context) from `lines`, merged into ranges.
fn failure_excerpt(lines: &[Units]) -> Units {
    let mut keep: BTreeSet<usize> = BTreeSet::new();
    for (i, line) in lines.iter().enumerate() {
        if !is_match(&FAILURE, line) {
            continue;
        }
        for j in i.saturating_sub(CONTEXT)..=(i + CONTEXT).min(lines.len() - 1) {
            keep.insert(j);
        }
    }
    let mut out: Vec<Units> = Vec::new();
    let mut prev: i64 = -2;
    for &i in &keep {
        if i as i64 != prev + 1 && !out.is_empty() {
            out.push(vec![ELLIPSIS]);
        }
        if !is_blank(&lines[i]) {
            out.push(lines[i].clone());
        }
        prev = i as i64;
    }
    join(&out)
}

/// Red body: failure excerpt from before the tail + short tail, middle-truncated.
fn summarize_red(log: &str, budget: i64) -> Units {
    let mut lines = clean_lines(log);
    while lines.last().is_some_and(|l| is_blank(l)) {
        lines.pop();
    }
    let tail_start = lines.len().saturating_sub(TAIL_RED);
    let excerpt = truncate_middle(&failure_excerpt(&lines[..tail_start]), EXCERPT_BUDGET);
    let tail = join(&lines[tail_start..]);
    let body = if excerpt.is_empty() {
        tail
    } else {
        let mut body = excerpt;
        body.extend(units("\n--- tail ---\n"));
        body.extend(tail);
        body
    };
    truncate_middle(&body, budget)
}

/// First stdout line of `navori gate`, always exactly this shape.
#[must_use]
pub fn sentinel_line(kind: &str, exit_code: i32, log_path: &str) -> String {
    format!("navori gate {kind}: exit {exit_code} — log {log_path}")
}

/// Full stdout: sentinel + green/red body, total capped at 2 KB / 4 KB.
#[must_use]
pub fn render_verdict(kind: &str, exit_code: i32, log_path: &str, log: &str) -> String {
    let sentinel = sentinel_line(kind, exit_code, log_path);
    let cap = if exit_code == 0 { GREEN_CAP } else { RED_CAP };
    let budget = cap - byte_len(&units(&sentinel)) - 1;
    let body = if exit_code == 0 {
        summarize_green(log, budget)
    } else {
        summarize_red(log, budget)
    };
    if body.is_empty() {
        sentinel
    } else {
        format!("{sentinel}\n{}", String::from_utf16_lossy(&body))
    }
}

#[cfg(test)]
mod tests;
