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
    ("navori-agents", 4055),
    ("arranque-sesion", 220),
    ("cierre-sesion", 505),
    ("code-discovery-routing", 171),
    ("codex-cross-review", 191),
    ("formato-respuesta", 161),
    ("idioma-rol", 151),
    ("intake-tickets", 306),
    ("operaciones-seguras", 321),
    ("orquestacion", 1261),
    ("plan-maestro", 101),
    ("planificacion", 435),
    ("sdd", 279),
    ("tipado-fuerte", 61),
    ("acli-protocol", 91),
    ("codegraph-search-v2", 116),
    ("tgrep-search-v2", 126),
    ("stack-astro", 71),
    ("stack-background-worker", 296),
    ("stack-bun-keystone", 266),
    ("stack-express", 171),
    ("stack-express-mongoose", 186),
    ("stack-fastapi-python", 176),
    ("stack-medusa", 81),
    ("stack-monorepo-turbopnpm", 231),
    ("stack-nestjs", 83),
    ("stack-nextjs", 89),
    ("stack-react-native-expo", 99),
    ("stack-vite-react-ts", 243),
    ("stack-vite-react-ts-mantine", 137),
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

/// `countWords(body)`: `body.trim().split(/\s+/).length`, zero for blank text.
#[must_use]
pub fn count_words(body: &str) -> usize {
    body.split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .count()
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
}
