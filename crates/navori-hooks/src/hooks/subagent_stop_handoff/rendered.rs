//! What the renderer writes into subagent-stop-handoff.sh, read back from the verified script:
//! the compaction threshold and the source lines Bash names when a redirection fails.

const BLOCK_END: &str = "# navori:managed end id=\"subagent-stop-handoff-base\"";
const INPUT: &str = "payload=$(cat 2>/dev/null) || payload=\"\"";
const THRESHOLD: &str = "navori_compact_threshold=";
const CKSUM: &str = "  navori_fingerprint=\"${navori_fingerprint}$(cksum <\"${f:-/dev/null}\" 2>/dev/null | tr ' ' '-');\"";
const TRUNCATE: &str = "  : >\"$navori_handoff_stamp\" 2>/dev/null || true";
const STAMP: &str =
    "  printf '%s\\n' \"$navori_handoff_sig\" >\"$navori_handoff_stamp\" 2>/dev/null || true";
const MARK_ADVICE: &str = "      printf '1\\n' >\"$navori_compact_mark\" 2>/dev/null || true";
const MARK_DIRTY: &str = "    printf '1\\n' >\"$navori_compact_mark\" 2>/dev/null || true";

/// Values of the script that change its output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `navori_compact_threshold` after the script's sanitizing.
    pub threshold: u64,
    /// 1-based lines: the script's own capture, `cksum`, the stamp truncation, the stamp
    /// write, and the compaction mark in the advice and in the warning paths.
    pub lines: Lines,
}

/// 1-based source lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lines {
    pub input: usize,
    pub cksum: usize,
    pub truncate: usize,
    pub stamp: usize,
    pub mark_advice: usize,
    pub mark_dirty: usize,
}

fn line_of(source: &str, exact: &str, what: &str) -> Result<usize, String> {
    let mut found = source.split('\n').enumerate().filter(|(_, l)| *l == exact);
    let line = found.next().ok_or(format!("{what} is missing"))?.0 + 1;
    if found.next().is_some() {
        return Err(format!("{what} is ambiguous"));
    }
    Ok(line)
}

/// A shell word of single-quoted runs and `\'`, or a bare word with nothing Bash expands.
/// (Kept apart from the other hooks' copy: each hook's sources hash on their own, D8.)
fn unquote(word: &str) -> Option<String> {
    if !word.contains(['\'', '\\']) {
        let bare = !word.is_empty()
            && !word.contains([
                '"', '$', '`', ' ', '\t', ';', '&', '|', '<', '>', '(', ')', '*', '?', '[', '~',
                '#',
            ]);
        return bare.then(|| word.to_owned());
    }
    let mut out = String::new();
    let mut rest = word;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("\\'") {
            out.push('\'');
            rest = after;
        } else {
            let after = rest.strip_prefix('\'')?;
            let end = after.find('\'')?;
            out.push_str(&after[..end]);
            rest = &after[end + 1..];
        }
    }
    Some(out)
}

impl Rendered {
    /// Read the rendered values; after the managed block only comments and blank lines may
    /// follow.
    ///
    /// # Errors
    /// The reason the script is not one the native hook reproduces.
    pub fn from_script(source: &str) -> Result<Self, String> {
        if let Some(end) = source.find(BLOCK_END) {
            if source[end + 1..].contains(BLOCK_END) {
                return Err("the managed block end is ambiguous".to_owned());
            }
            if source[end + BLOCK_END.len()..].lines().any(|line| {
                let line = line.trim_start_matches([' ', '\t']);
                !line.is_empty() && !line.starts_with('#')
            }) {
                return Err("the user section holds commands".to_owned());
            }
        }
        let mut words = source
            .split('\n')
            .filter_map(|line| line.strip_prefix(THRESHOLD));
        let word = words.next().ok_or("the compaction threshold is missing")?;
        if words.next().is_some() {
            return Err("the compaction threshold is ambiguous".to_owned());
        }
        let value = unquote(word).ok_or("the compaction threshold is not a plain word")?;
        // `case "" | *[!0-9]*) 175000`; a value Bash's `-gt` would overflow is not modeled.
        let threshold = if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            175_000
        } else if value.len() > 18 {
            return Err("the compaction threshold overflows".to_owned());
        } else {
            value
                .parse()
                .map_err(|_| "the compaction threshold overflows")?
        };
        Ok(Self {
            threshold,
            lines: Lines {
                input: line_of(source, INPUT, "the payload capture")?,
                cksum: line_of(source, CKSUM, "the cksum line")?,
                truncate: line_of(source, TRUNCATE, "the stamp truncation")?,
                stamp: line_of(source, STAMP, "the stamp write")?,
                mark_advice: line_of(source, MARK_ADVICE, "the advice mark")?,
                mark_dirty: line_of(source, MARK_DIRTY, "the warning mark")?,
            },
        })
    }
}
