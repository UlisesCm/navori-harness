//! `measureDocBudget` (`lib/diagnose/health.ts`) over a rendered `CLAUDE.md` (spec 0058 M8): the
//! words of its top-level managed blocks against the ceilings of `lib/assets/doc-budgets.ts`.
//! `render --apply` warns when a render takes the file from within its budget to over it.
//!
//! [`CEILINGS`] is `managedBlockCeilings()` and [`COMPUTED`] is `COMPUTED_BLOCK_FORMULAS`; the
//! oracle test `doc_budget_parity.rs` fails when either drifts from the TS tables.

use crate::integrity::is_js_whitespace;
use crate::markers::{CommentStyle, locate_managed_blocks};

/// `managedBlockCeilings()`: rendered block id → word ceiling, markers included.
pub const CEILINGS: [(&str, usize); 30] = [
    ("navori-agents", 3142),
    ("arranque-sesion", 200),
    ("claude-apendice", 153),
    ("code-discovery-routing", 159),
    ("codex-cross-review", 146),
    ("formato-respuesta", 150),
    ("idioma-rol", 134),
    ("intake-tickets", 272),
    ("operaciones-seguras", 304),
    ("orquestacion", 554),
    ("plan-maestro", 87),
    ("planificacion", 424),
    ("sdd", 208),
    ("tipado-fuerte", 42),
    ("acli-protocol", 74),
    ("codegraph-search-v2", 89),
    ("tgrep-search-v2", 110),
    ("stack-astro", 56),
    ("stack-background-worker", 269),
    ("stack-bun-keystone", 241),
    ("stack-express", 153),
    ("stack-express-mongoose", 163),
    ("stack-fastapi-python", 155),
    ("stack-medusa", 67),
    ("stack-monorepo-turbopnpm", 210),
    ("stack-nestjs", 68),
    ("stack-nextjs", 73),
    ("stack-react-native-expo", 82),
    ("stack-vite-react-ts", 221),
    ("stack-vite-react-ts-mantine", 120),
];

/// `COMPUTED_BLOCK_FORMULAS`: block id → (`base`, `perRow`).
pub const COMPUTED: [(&str, usize, usize); 2] = [
    ("contexto-proyecto", 30, 45),
    ("agentes-disponibles", 60, 40),
];

/// The fields of `DocBudgetMeasure` the render warning reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DocBudget {
    /// `managedWords`: words inside top-level managed blocks.
    pub managed_words: usize,
    /// `unbudgetedWords`: the part of them in blocks without a ceiling.
    pub unbudgeted_words: usize,
    /// `ceiling`: the sum of the budgeted blocks' ceilings.
    pub ceiling: usize,
    /// `overBy`.
    pub over_by: usize,
}

/// `countWords(body)`: the navori markers become a space (`NAVORI_MARKER`, #1520), then
/// `trim().split(/\s+/).length`, zero for blank text.
#[must_use]
pub fn count_words(body: &str) -> usize {
    strip_navori_markers(body)
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .count()
}

/// `body.replace(/<!--\s*\/?navori:[\s\S]*?-->/g, " ")`: each match, leftmost first, becomes a
/// space; a `<!--` that does not open a match is kept and the search resumes right after it.
fn strip_navori_markers(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut kept = 0;
    let mut from = 0;
    while let Some(offset) = body[from..].find("<!--") {
        let start = from + offset;
        let after_open = start + "<!--".len();
        let rest = body[after_open..].trim_start_matches(is_js_whitespace);
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        let matched = rest.strip_prefix("navori:").and_then(|tail| {
            let tail_start = body.len() - tail.len();
            tail.find("-->")
                .map(|close| tail_start + close + "-->".len())
        });
        match matched {
            Some(end) => {
                out.push_str(&body[kept..start]);
                out.push(' ');
                kept = end;
                from = end;
            }
            None => from = start + 1,
        }
    }
    out.push_str(&body[kept..]);
    out
}

fn ceiling(id: &str, rows: usize) -> Option<usize> {
    CEILINGS
        .iter()
        .find(|(block, _)| *block == id)
        .map(|(_, c)| *c)
        .or_else(|| {
            COMPUTED
                .iter()
                .find(|(block, _, _)| *block == id)
                .map(|(_, base, per_row)| base + per_row * rows)
        })
}

/// `measureDocBudget(content)`.
#[must_use]
pub fn measure_doc_budget(content: &str) -> DocBudget {
    let mut out = DocBudget::default();
    let mut top_level_end = 0;
    for located in locate_managed_blocks(content, CommentStyle::Html) {
        if located.open_start < top_level_end {
            continue;
        }
        top_level_end = located.close_end;
        let Some(body) = content.get(located.open_start..located.close_end) else {
            continue;
        };
        let words = count_words(body);
        let rows = body
            .split('\n')
            .filter(|line| line.starts_with("- "))
            .count();
        out.managed_words += words;
        match ceiling(&located.id, rows) {
            None => out.unbudgeted_words += words,
            Some(c) => out.ceiling += c,
        }
    }
    out.over_by = out
        .managed_words
        .saturating_sub(out.unbudgeted_words)
        .saturating_sub(out.ceiling);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_split_on_js_whitespace() {
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words(" \n\t "), 0);
        assert_eq!(count_words("a b\u{a0}c\u{feff}d\n e"), 5);
    }

    #[test]
    fn navori_markers_are_not_words() {
        assert_eq!(
            count_words(
                "<!-- navori:managed id=\"x\" -->\nuno dos\n<!-- /navori:managed id=\"x\" -->"
            ),
            2
        );
        assert_eq!(count_words("a<!--navori:if sdd-->b"), 2);
        assert_eq!(count_words("<!--\u{a0}/navori:if-->"), 0);
        assert_eq!(count_words("<!-- otro --> x"), 4);
        assert_eq!(count_words("<!-- <!-- navori:x --> y"), 2);
        assert_eq!(count_words("<!-- navori: sin cierre"), 4);
    }
}
