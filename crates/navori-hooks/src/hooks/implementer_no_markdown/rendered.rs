//! What implementer-no-markdown.sh carries besides its rules: the three fixed analyzer programs
//! it pipes a command through, read back from the verified script.

/// The managed block's closing marker; only the user section may follow it.
const BLOCK_END: &str = "# navori:managed end id=\"implementer-no-markdown-base\"";

/// The fixed programs of the interpreter rule, as `IFS= read -r -d ''` leaves them: the heredoc
/// body with its final newline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `navori_json_analyzer`, run with `node -e`.
    pub json: String,
    /// `navori_node_write_analyzer`, run with `node -e`.
    pub node_write: String,
    /// `navori_python_dest_analyzer`, run with `python3 -I -S -c`.
    pub python: String,
}

/// The body of the one heredoc that `variable` reads, terminated by `tag`.
fn heredoc(source: &str, variable: &str, tag: &str) -> Result<String, String> {
    let opener = format!("  IFS= read -r -d '' {variable} <<'{tag}' || :");
    let mut lines = source.split('\n');
    let mut found = 0;
    let mut body = None;
    while let Some(line) = lines.next() {
        if line != opener {
            continue;
        }
        found += 1;
        let mut text = String::new();
        let mut closed = false;
        for line in lines.by_ref() {
            if line == tag {
                closed = true;
                break;
            }
            text.push_str(line);
            text.push('\n');
        }
        if !closed {
            return Err(format!("{tag} is not terminated"));
        }
        body = Some(text);
    }
    match (found, body) {
        (1, Some(text)) => Ok(text),
        (0, _) => Err(format!("{variable} is missing")),
        _ => Err(format!("{variable} is ambiguous")),
    }
}

impl Rendered {
    /// Read the analyzer programs; after the managed block only comments and blank lines may
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
        Ok(Self {
            json: heredoc(source, "navori_json_analyzer", "NAVORI_JSON_ANALYZER")?,
            node_write: heredoc(
                source,
                "navori_node_write_analyzer",
                "NAVORI_NODE_WRITE_ANALYZER",
            )?,
            python: heredoc(
                source,
                "navori_python_dest_analyzer",
                "NAVORI_PYTHON_DEST_ANALYZER",
            )?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::heredoc;

    // Covers: R70
    #[test]
    fn heredoc_bodies_keep_their_final_newline() {
        let source = "x\n  IFS= read -r -d '' v <<'T' || :\na\n  b\nT\ny\n";
        assert_eq!(heredoc(source, "v", "T"), Ok("a\n  b\n".to_owned()));
        assert!(heredoc("  IFS= read -r -d '' v <<'T' || :\na\n", "v", "T").is_err());
        assert!(heredoc(source, "w", "T").is_err());
    }
}
