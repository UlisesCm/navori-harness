//! What the renderer writes into master-plan-context.sh, read back from the verified script.

/// The managed block's closing marker; only the user section may follow it.
const BLOCK_END: &str = "# navori:managed end id=\"master-plan-context-base\"";
/// The script's own stdin capture; Bash 5 names its line when it drops a NUL.
const INPUT: &str = "payload=$(cat 2>/dev/null) || payload=\"\"";
const SPECS_DIR: &str = "specs_dir=";
const BUDGET: &str = "NAVORI_MASTER_LINE_BUDGET=";

/// Values of the script that change its output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `specs_dir`: `sdd.specsDir` after the shell unquotes it (a placeholder when unrendered).
    pub specs_dir: String,
    /// `NAVORI_MASTER_LINE_BUDGET`: the longest status line the hook prints.
    pub budget: usize,
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
                '#', '=',
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
        let specs_dir = unquote(single(source, SPECS_DIR, "specs_dir")?)
            .ok_or("specs_dir is not a plain word")?;
        let budget = single(source, BUDGET, "the line budget")?;
        if budget.is_empty() || budget.len() > 6 || !budget.bytes().all(|b| b.is_ascii_digit()) {
            return Err("the line budget is not a plain integer".to_owned());
        }
        let budget = budget
            .parse()
            .map_err(|_| "the line budget is not a plain integer")?;
        let mut inputs = source
            .split('\n')
            .enumerate()
            .filter(|(_, line)| *line == INPUT);
        let input_line = inputs.next().ok_or("the payload capture is missing")?.0 + 1;
        if inputs.next().is_some() {
            return Err("the payload capture is ambiguous".to_owned());
        }
        Ok(Self {
            specs_dir,
            budget,
            input_line,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Rendered, unquote};

    // Covers: R70
    #[test]
    fn shell_words_unquote_like_bash() {
        for (word, expected) in [
            ("'specs'", Some("specs")),
            ("'it'\\''s'", Some("it's")),
            ("{{shq:sdd.specsDir}}", Some("{{shq:sdd.specsDir}}")),
            ("'open", None),
            ("$x", None),
            ("a=b", None),
        ] {
            assert_eq!(unquote(word).as_deref(), expected, "{word}");
        }
    }

    // Covers: R70
    #[test]
    fn reads_the_rendered_values_and_refuses_a_user_section_with_commands() {
        let script = "payload=$(cat 2>/dev/null) || payload=\"\"\nspecs_dir='docs/specs'\nNAVORI_MASTER_LINE_BUDGET=600\n";
        assert_eq!(
            Rendered::from_script(script),
            Ok(Rendered {
                specs_dir: "docs/specs".to_owned(),
                budget: 600,
                input_line: 1,
            })
        );
        let user =
            format!("{script}# navori:managed end id=\"master-plan-context-base\"\necho hi\n");
        assert!(Rendered::from_script(&user).is_err());
    }
}
