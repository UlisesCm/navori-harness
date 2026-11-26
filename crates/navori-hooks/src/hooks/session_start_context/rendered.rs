//! What the renderer writes into session-start-context.sh, read back from the verified script.

/// The managed block's closing marker; only the user section may follow it.
const BLOCK_END: &str = "# navori:managed end id=\"session-start-context-base\"";
/// The script's own stdin capture; Bash 5 names its line when it drops a NUL.
const INPUT: &str = "payload=$(cat 2>/dev/null) || payload=\"\"";
const BASE: &str = "  base=";
const SOFT_CAP: &str = "    progress_soft_cap=";

/// Values of the script that change its output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `base`: `branchBase` after the shell unquotes it.
    pub base: String,
    /// `progress_soft_cap`, as the shell assigns it (a placeholder when unrendered).
    pub soft_cap: String,
    /// 1-based line of the script's `payload=$(cat …)`.
    pub input_line: usize,
}

/// The one line that starts with `prefix`, without it.
fn single<'s>(source: &'s str, prefix: &str, what: &str) -> Result<&'s str, String> {
    let mut found = source
        .split('\n')
        .filter_map(|line| line.strip_prefix(prefix));
    let value = found.next().ok_or(format!("{what} is missing"))?;
    if found.next().is_some() {
        return Err(format!("{what} is ambiguous"));
    }
    Ok(value)
}

/// A shell word made of single-quoted runs and `\'`, or a bare word without quoting or
/// expansion characters (an unrendered `{{shq:…}}` placeholder).
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
    /// follow, since the native hook does not run a user section.
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
        let base = unquote(single(source, BASE, "base")?).ok_or("base is not a plain word")?;
        let soft_cap = single(source, SOFT_CAP, "progress_soft_cap")?;
        if !soft_cap
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"{}._".contains(&b))
        {
            return Err("progress_soft_cap is not a plain word".to_owned());
        }
        let mut inputs = source
            .split('\n')
            .enumerate()
            .filter(|(_, line)| *line == INPUT);
        let input_line = inputs.next().ok_or("the payload capture is missing")?.0 + 1;
        if inputs.next().is_some() {
            return Err("the payload capture is ambiguous".to_owned());
        }
        Ok(Self {
            base,
            soft_cap: soft_cap.to_owned(),
            input_line,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::unquote;

    // Covers: R50
    #[test]
    fn shell_words_unquote_like_bash() {
        for (word, expected) in [
            ("'dev'", Some("dev")),
            ("'it'\\''s'", Some("it's")),
            ("{{shq:branchBase}}", Some("{{shq:branchBase}}")),
            ("'open", None),
            ("$x", None),
            ("\"dev\"", None),
        ] {
            assert_eq!(unquote(word).as_deref(), expected, "{word}");
        }
    }
}
