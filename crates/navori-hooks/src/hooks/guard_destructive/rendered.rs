//! Values the renderer writes into guard-destructive.sh, read back from the verified script.

/// Top-level assignments of the rendered script that change verdicts. Each holds the exact
/// value the shell assigns; an unrendered copy holds its placeholder text, as the shell does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `base` — the branch rule 2 protects from force-pushes.
    pub base: String,
    /// `nv_pi_rules` — the Pi copy's shared `deny|ask <prefix>` lines; `-` elsewhere.
    pub pi_rules: String,
    /// `nv_owned_paths` — exact render-owned paths for rule 6d; `-` without an inventory.
    pub owned_paths: String,
    /// `navori_pg_lane` — `1` enables the commit-time progress ratchet lane (rule 1b).
    pub progress_lane: String,
    /// `navori_progress_hard_cap` inside the inlined `progress-ratchet` partial; `None` when the
    /// partial is not inlined (an asset read before include expansion).
    pub progress_cap: Option<String>,
    /// The `tgrep-search-lane` block of `@navori/plugin-tgrep` follows the base block.
    pub search_lane: bool,
}

/// Opening marker of the search lane block.
const SEARCH_LANE: &str = "# navori:managed start id=\"tgrep-search-lane\" ";

impl Rendered {
    /// Read the four assignments and whether the search lane is present from the script source. `None` when any is missing or is not
    /// a plain shell word (quoted spans, `'\''` escapes and bare characters only).
    #[must_use]
    pub fn from_script(source: &str) -> Option<Self> {
        Some(Self {
            base: assignment(source, "base")?,
            pi_rules: assignment(source, "nv_pi_rules")?,
            owned_paths: assignment(source, "nv_owned_paths")?,
            progress_lane: assignment(source, "navori_pg_lane")?,
            progress_cap: indented(source, "navori_progress_hard_cap"),
            search_lane: source.lines().any(|line| line.starts_with(SEARCH_LANE)),
        })
    }
}

/// The first `name=<word>` after leading spaces: the partial assigns inside a function body.
fn indented(source: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let body = line.trim_start_matches(' ');
        if body.starts_with(&prefix) {
            let start = offset + (line.len() - body.len()) + prefix.len();
            return word(&source[start..]);
        }
        offset += line.len();
    }
    None
}

/// The first `name=<word>` that starts a line. Words that need expansion are rejected.
fn assignment(source: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if line.starts_with(&prefix) {
            return word(&source[offset + prefix.len()..]);
        }
        offset += line.len();
    }
    None
}

/// One shell word: single-quoted spans (newlines included), `\x` escapes and bare characters,
/// ending at unquoted whitespace or a comment. `$`, backquotes and double quotes are rejected.
fn word(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => loop {
                match chars.next()? {
                    '\'' => break,
                    inner => out.push(inner),
                }
            },
            '\\' => out.push(chars.next()?),
            ' ' | '\t' | '\n' | ';' => break,
            '$' | '`' | '"' => return None,
            other => out.push(other),
        }
    }
    Some(out)
}
