//! The human report of a Claude render (spec 0058 T16): clack's non-TTY output and the Claude
//! sections of `commands/render.ts` (`reportClaudeMd`, `reportEngineFiles`, the language
//! fallback and the downgrade warning).
//!
//! Without a TTY, or with `NO_COLOR`, picocolors and `util.styleText` emit no escapes, so every
//! line here is plain text; colored output is out of the native subset. The pipeline pieces the
//! command owns (core provenance, `.gitignore`, `.prettierignore`, the outro) come with M6.

use crate::i18n;
use crate::render::claude::ClaudeEnginePlan;
use crate::render::context::Lang;

/// clack's guide symbols, Unicode or their ASCII fallback (`isUnicodeSupported()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clack {
    /// `isUnicodeSupported()`: off only on the Linux kernel console (`TERM=linux`).
    pub unicode: bool,
}

impl Clack {
    /// `isUnicodeSupported()` on a non-Windows host.
    #[must_use]
    pub fn from_env() -> Self {
        Self {
            unicode: std::env::var_os("TERM").is_none_or(|term| term != "linux"),
        }
    }

    const fn pick(self, unicode: &'static str, ascii: &'static str) -> &'static str {
        if self.unicode { unicode } else { ascii }
    }

    fn bar(self) -> &'static str {
        self.pick("\u{2502}", "|")
    }

    /// `p.intro(message)`.
    #[must_use]
    pub fn intro(self, message: &str) -> String {
        format!("{}  {message}\n", self.pick("\u{250c}", "T"))
    }

    /// `p.outro(message)`.
    #[must_use]
    pub fn outro(self, message: &str) -> String {
        format!(
            "{}\n{}  {message}\n\n",
            self.bar(),
            self.pick("\u{2514}", "\u{2014}")
        )
    }

    /// `p.cancel(message)`.
    #[must_use]
    pub fn cancel(self, message: &str) -> String {
        format!("{}  {message}\n\n", self.pick("\u{2514}", "\u{2014}"))
    }

    /// `p.log.message(message, { symbol })` with the default spacing and guide.
    fn log(self, message: &str, symbol: &str) -> String {
        let bar = self.bar();
        let mut lines = vec![bar.to_owned()];
        for (index, line) in message.split('\n').enumerate() {
            let lead = if index == 0 { symbol } else { bar };
            lines.push(if line.is_empty() {
                lead.to_owned()
            } else {
                format!("{lead}  {line}")
            });
        }
        format!("{}\n", lines.join("\n"))
    }

    /// `p.log.message(message)`.
    #[must_use]
    pub fn message(self, message: &str) -> String {
        self.log(message, self.bar())
    }

    /// `p.log.info(message)`.
    #[must_use]
    pub fn info(self, message: &str) -> String {
        self.log(message, self.pick("\u{25cf}", "\u{2022}"))
    }

    /// `p.log.warn(message)`.
    #[must_use]
    pub fn warn(self, message: &str) -> String {
        self.log(message, self.pick("\u{25b2}", "!"))
    }

    /// `p.log.success(message)`.
    #[must_use]
    pub fn success(self, message: &str) -> String {
        self.log(message, self.pick("\u{25c6}", "*"))
    }

    /// `p.log.error(message)`.
    #[must_use]
    pub fn error(self, message: &str) -> String {
        self.log(message, self.pick("\u{25a0}", "x"))
    }

    /// `p.log.step(message)`.
    #[must_use]
    pub fn step(self, message: &str) -> String {
        self.log(message, self.pick("\u{25c7}", "o"))
    }
}

/// `renderStatusSymbol(status)`, uncolored.
#[must_use]
pub fn status_symbol(status: &str) -> &'static str {
    match status {
        "created" => "+",
        "updated" => "~",
        "unchanged" => "\u{b7}",
        "user-modified-skipped" => "!",
        "downgrade-skipped" | "retired-kept" => "\u{21e1}",
        "removed-condition-false" | "removed-trimmed" => "-",
        _ => "?",
    }
}

/// `engine.written`: `(path, status)` of each pending write, then each removal.
#[must_use]
pub fn written(plan: &ClaudeEnginePlan) -> Vec<(&str, &'static str)> {
    plan.pending
        .iter()
        .map(|w| (w.rel_path.as_str(), w.status.as_str()))
        .chain(
            plan.removals
                .iter()
                .map(|r| (r.rel_path.as_str(), "removed-condition-false")),
        )
        .collect()
}

/// `countUnchangedEngineFiles(engine)`: `CLAUDE.md` is discounted, its blocks are listed apart.
#[must_use]
pub fn unchanged_engine_files(plan: &ClaudeEnginePlan) -> usize {
    let written = written(plan);
    let claude_md_written = written.iter().any(|(path, _)| *path == "CLAUDE.md");
    plan.inspected
        .saturating_sub(written.len() + plan.skipped.len())
        .saturating_sub(usize::from(!claude_md_written))
}

/// `reportClaudeMd(file, entries, changed, preview, lang)`.
#[must_use]
pub fn claude_md_section(
    clack: Clack,
    file: &str,
    plan: &ClaudeEnginePlan,
    preview: bool,
    lang: Lang,
) -> String {
    let changed = !written(plan).is_empty();
    let mut lines = vec![file.to_owned()];
    for (id, status) in &plan.claude_md_entries {
        let status = status.as_str();
        lines.push(format!("  {} {id}  ({status})", status_symbol(status)));
    }
    let tail = match (preview, changed) {
        (true, true) => i18n::render_would_write(lang),
        (true, false) => i18n::render_no_change_preview(lang),
        (false, true) => i18n::RENDER_WRITTEN,
        (false, false) => i18n::RENDER_NO_CHANGES,
    };
    lines.push(format!("  {tail}"));
    clack.message(&lines.join("\n"))
}

/// `reportEngineFiles(engine, lang)`: `None` when there is nothing to say.
#[must_use]
pub fn engine_files_section(clack: Clack, plan: &ClaudeEnginePlan) -> Option<String> {
    let written: Vec<_> = written(plan)
        .into_iter()
        .filter(|(path, status)| *path != "CLAUDE.md" && *status != "removed-trimmed")
        .collect();
    let unchanged = unchanged_engine_files(plan);
    if written.is_empty() && plan.skipped.is_empty() && plan.warnings.is_empty() && unchanged == 0 {
        return None;
    }
    let mut lines = vec![i18n::RENDER_ENGINE_FILES_TITLE.to_owned()];
    for (path, status) in &written {
        lines.push(format!("  {} {path}  ({status})", status_symbol(status)));
    }
    for skip in &plan.skipped {
        lines.push(format!("  ! {}  (skipped)", skip.rel_path));
        lines.push(format!("      {}", skip.reason));
    }
    if unchanged > 0 && written.is_empty() && plan.skipped.is_empty() {
        lines.push(format!("  \u{b7} {unchanged} unchanged"));
    } else if unchanged > 0 {
        lines.push(format!("  \u{b7} (+{unchanged} unchanged)"));
    }
    for warning in &plan.warnings {
        lines.push(format!("  \u{b7} {warning}"));
    }
    Some(clack.message(&lines.join("\n")))
}

/// The `langFallback` warning, when some block fell back to Spanish.
#[must_use]
pub fn lang_fallback_section(clack: Clack, plan: &ClaudeEnginePlan, lang: Lang) -> Option<String> {
    (!plan.language_fallbacks.is_empty()).then(|| {
        clack.warn(&i18n::render_lang_fallback(
            lang,
            &plan.language_fallbacks.join(", "),
        ))
    })
}

/// `formatDowngradeWarning(downgrades, lang)` as a warning.
#[must_use]
pub fn downgrade_section(clack: Clack, plan: &ClaudeEnginePlan, lang: Lang) -> Option<String> {
    if plan.downgrades.is_empty() {
        return None;
    }
    // `.sort().at(-1)`: the default sort compares UTF-16 code units.
    let newest = plan
        .downgrades
        .iter()
        .map(|d| d.from_version.as_str())
        .max_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()))
        .unwrap_or_default();
    let mut ids: Vec<&str> = Vec::new();
    for d in &plan.downgrades {
        if !ids.contains(&d.id.as_str()) {
            ids.push(&d.id);
        }
    }
    let shown = ids.iter().take(6).copied().collect::<Vec<_>>().join(", ");
    let more = if ids.len() > 6 {
        format!(" (+{})", ids.len() - 6)
    } else {
        String::new()
    };
    Some(clack.warn(&i18n::render_downgrade_warning(
        lang,
        plan.downgrades.len(),
        newest,
        &format!("{shown}{more}"),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::block_plan::UpdateAvailable;

    #[test]
    fn downgrade_warning_lists_six_ids_and_the_lexically_newest_version() {
        // Expected values come from `formatDowngradeWarning`'s formula run in Node.
        let ids = ["a", "b", "c", "d", "e", "f", "g", "a", "h"];
        let plan = ClaudeEnginePlan {
            downgrades: ids
                .iter()
                .enumerate()
                .map(|(i, id)| UpdateAvailable {
                    id: (*id).to_owned(),
                    source: "@navori/core".to_owned(),
                    from_version: if i % 2 == 1 { "0.10.0" } else { "0.9.0" }.to_owned(),
                    to_version: "0.1.0".to_owned(),
                })
                .collect(),
            ..ClaudeEnginePlan::default()
        };
        let clack = Clack { unicode: true };
        assert_eq!(
            downgrade_section(clack, &plan, Lang::En),
            Some(clack.warn(&i18n::render_downgrade_warning(
                Lang::En,
                9,
                "0.9.0",
                "a, b, c, d, e, f (+2)"
            )))
        );
        assert_eq!(
            downgrade_section(clack, &ClaudeEnginePlan::default(), Lang::En),
            None
        );
    }
}
