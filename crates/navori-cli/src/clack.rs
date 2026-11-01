//! `@clack/prompts` output without color, at its default 80 columns, for the native commands that
//! print through it (spec 0060). Interactive prompts are never reproduced: a command that would
//! prompt delegates.

use std::io::IsTerminal as _;

use crate::native_io::Output;

/// Whether picocolors and Node's `styleText` both print without color, and clack draws its
/// Unicode symbols at its default 80 columns: stdout is not a TTY, no `FORCE_COLOR`, no `CI`
/// without `NO_COLOR`, and `TERM` is not `linux`.
#[must_use]
pub(crate) fn plain_output() -> bool {
    let set = |name: &str| std::env::var_os(name).is_some();
    !std::io::stdout().is_terminal()
        && !set("FORCE_COLOR")
        && (set("NO_COLOR") || !set("CI"))
        && std::env::var_os("TERM").is_none_or(|t| t != "linux")
}

/// `fast-string-width` for the characters Rust measures as one column; `None` for any other
/// (wide, combining, control or unassigned).
#[must_use]
pub(crate) fn width(text: &str) -> Option<usize> {
    text.chars()
        .map(|c| {
            let narrow = matches!(c,
                ' '..='~'
                | '\u{a1}'..='\u{2ff}'
                | '\u{370}'..='\u{3ff}'
                | '\u{400}'..='\u{482}'
                | '\u{2010}'..='\u{2027}'
                | '\u{2190}'..='\u{21ff}'
                | '\u{2713}'
            );
            narrow.then_some(1)
        })
        .sum()
}

/// `S_INFO`, `S_SUCCESS`, `S_STEP_SUBMIT`, `S_WARN` and `S_ERROR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Symbol {
    Bar,
    Info,
    Success,
    Step,
    Warn,
    Error,
}

impl Symbol {
    const fn glyph(self) -> &'static str {
        match self {
            Self::Bar => "│",
            Self::Info => "●",
            Self::Success => "◆",
            Self::Step => "◇",
            Self::Warn => "▲",
            Self::Error => "■",
        }
    }
}

/// What clack would print, accumulated.
#[derive(Default)]
pub(crate) struct Clack {
    pub(crate) out: Output,
}

impl Clack {
    pub(crate) fn intro(&mut self, title: &str) {
        self.out.stdout.push_str(&format!("┌  {title}\n"));
    }

    pub(crate) fn outro(&mut self, message: &str) {
        self.out.stdout.push_str(&format!("│\n└  {message}\n\n"));
    }

    /// `p.cancel(message)` followed by `process.exit(1)`.
    pub(crate) fn cancel(&mut self, message: &str) {
        self.out.stdout.push_str(&format!("└  {message}\n\n"));
        self.out.code = 1;
    }

    /// `p.log.message(text, { symbol })` (and `info`, `warn`, ...): a bar line, then the first
    /// line after the symbol and the rest after a bar; empty lines keep only their symbol.
    pub(crate) fn log(&mut self, symbol: Symbol, text: &str) {
        let mut lines = vec!["│".to_owned()];
        for (index, line) in text.split('\n').enumerate() {
            let lead = if index == 0 { symbol.glyph() } else { "│" };
            lines.push(if line.is_empty() {
                lead.to_owned()
            } else {
                format!("{lead}  {line}")
            });
        }
        self.out.stdout.push_str(&lines.join("\n"));
        self.out.stdout.push('\n');
    }

    /// `note(message, title)`; `None` when a line could wrap at 74 columns or Rust cannot
    /// measure it.
    pub(crate) fn note(&mut self, message: &str, title: &str) -> Option<()> {
        let mut lines = vec![""];
        lines.extend(message.split('\n'));
        lines.push("");
        let widths: Vec<usize> = lines.iter().map(|l| width(l)).collect::<Option<_>>()?;
        if widths.iter().any(|w| *w > 74) {
            return None;
        }
        let n = width(title)?;
        let t = widths.iter().copied().max().unwrap_or(0).max(n) + 2;
        let mut text = format!(
            "│\n◇  {title} {}╮\n",
            "─".repeat(t.saturating_sub(n + 1).max(1))
        );
        for (line, w) in lines.iter().zip(widths) {
            text.push_str(&format!("│  {line}{}│\n", " ".repeat(t - w)));
        }
        text.push_str(&format!("├{}╯\n", "─".repeat(t + 2)));
        self.out.stdout.push_str(&text);
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn notes_and_logs_draw_like_clack() {
        let mut clack = Clack::default();
        assert_eq!(clack.note("  · a", "T"), Some(()));
        assert_eq!(
            clack.out.stdout,
            "│\n◇  T ─────╮\n│         │\n│    · a  │\n│         │\n├─────────╯\n"
        );
        assert_eq!(Clack::default().note(&"x".repeat(75), "T"), None);
        assert_eq!(Clack::default().note("界", "T"), None);
        assert_eq!(width("⇡ ✓"), Some(3));
        assert_eq!(width("✔"), None);
        let mut clack = Clack::default();
        clack.log(Symbol::Info, "a\n\nb");
        assert_eq!(clack.out.stdout, "│\n●  a\n│\n│  b\n");
    }
}
