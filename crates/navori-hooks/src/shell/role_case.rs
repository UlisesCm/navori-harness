//! The per-role policy functions the renderer compiles into a hook (spec 0060 T13):
//! `nv_role_prefixes` of role-guard (`{{rolePolicy}}`) and `nv_engram_allowed` of
//! engram-write-guard (`{{engramPolicy}}`). Both are one `case "$1" in` whose arms print
//! single-quoted words one per line (`printf '%s\n' 'a' 'b'`) or nothing (`:`), with a `*` arm.
//! Only that exact shape is read; anything else is not a script the native hook reproduces.

/// A compiled role policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleCase {
    arms: Vec<(String, Vec<String>)>,
    default: Vec<String>,
}

/// A shell word made of single-quoted runs and `\'`.
fn unquote(word: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = word;
    if rest.is_empty() {
        return None;
    }
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

/// The words of `printf '%s\n' 'a' 'b'`, or none for `:`.
fn body(text: &str) -> Option<Vec<String>> {
    if text == ":" {
        return Some(Vec::new());
    }
    let words = text.strip_prefix("printf '%s\\n' ")?;
    words.split(' ').map(unquote).collect()
}

impl RoleCase {
    /// Read the body of `function() {` … `}` from the script.
    ///
    /// # Errors
    /// A missing, ambiguous or differently shaped function.
    pub fn from_script(source: &str, function: &str) -> Result<Self, String> {
        let opener = format!("{function}() {{");
        let mut lines = source.split('\n');
        let mut found = None;
        while let Some(line) = lines.next() {
            if line != opener {
                continue;
            }
            if found.is_some() {
                return Err(format!("{function} is ambiguous"));
            }
            let body: Vec<&str> = lines.by_ref().take_while(|line| *line != "}").collect();
            found = Some(Self::parse(&body).ok_or(format!("{function} has an unexpected shape"))?);
        }
        found.ok_or(format!("{function} is missing"))
    }

    fn parse(lines: &[&str]) -> Option<Self> {
        let (first, rest) = lines.split_first()?;
        let (last, arms) = rest.split_last()?;
        if *first != "  case \"$1\" in" || *last != "  esac" {
            return None;
        }
        let mut policy = Self {
            arms: Vec::new(),
            default: Vec::new(),
        };
        let mut has_default = false;
        for line in arms {
            let arm = line.strip_prefix("    ")?.strip_suffix(" ;;")?;
            let (pattern, text) = arm.split_once(") ")?;
            let words = body(text)?;
            if pattern == "*" {
                policy.default = words;
                has_default = true;
            } else if !pattern.is_empty()
                && pattern
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                policy.arms.push((pattern.to_owned(), words));
            } else {
                return None;
            }
        }
        has_default.then_some(policy)
    }

    /// What `function "$role"` prints, one word per line, for the first arm that matches.
    #[must_use]
    pub fn lines(&self, role: &str) -> &[String] {
        self.arms
            .iter()
            .find(|(pattern, _)| pattern == role)
            .map_or(&self.default, |(_, words)| words)
    }
}

#[cfg(test)]
mod tests {
    use super::RoleCase;

    // Covers: R70
    #[test]
    fn reads_the_rendered_case_and_falls_back_to_the_default_arm() -> Result<(), String> {
        let script = "x\nf() {\n  case \"$1\" in\n    scout) printf '%s\\n' 'a/' 'it'\\''s' ;;\n    scribe) : ;;\n    *) printf '%s\\n' 'd/' ;;\n  esac\n}\ny\n";
        let policy = RoleCase::from_script(script, "f")?;
        assert_eq!(policy.lines("scout"), ["a/", "it's"]);
        assert!(policy.lines("scribe").is_empty());
        assert_eq!(policy.lines("mystery"), ["d/"]);
        assert!(RoleCase::from_script("f() {\n{{rolePolicy}}\n}\n", "f").is_err());
        Ok(())
    }
}
