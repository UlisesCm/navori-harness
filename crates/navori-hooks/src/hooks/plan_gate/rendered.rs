//! What the renderer writes into plan-gate.sh, read back from the verified script, and the shape
//! the native hook requires of it.

/// The managed block's closing marker; only the user section may follow it.
const BLOCK_END: &str = "# navori:managed end id=\"plan-gate-base\"";
/// Where a user section would start in an unrendered asset.
const USER_SECTION: &str = "\n# navori:user-section\n";
/// The roles assignment of the fast path, at column 0.
const ROLES: &str = "navori_plan_gate_roles=\"";
/// The script's own stdin capture; Bash 5 names its line when it drops a NUL.
const INPUT: &str = "payload=$(cat 2>/dev/null) || payload=\"\"";

/// Values of the script that change verdicts. An unrendered copy holds its placeholder text,
/// exactly as the shell assigns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `navori_plan_gate_roles`: the non-implementer roles, space-padded on both sides.
    pub roles: String,
    /// 1-based line of the script's `payload=$(cat …)`.
    pub input_line: usize,
}

impl Rendered {
    /// Read the rendered values. After the managed block (or the asset's user-section marker)
    /// only comments and blank lines may follow: the native hook does not run a user section.
    ///
    /// # Errors
    /// The reason the script is not one the native hook reproduces.
    pub fn from_script(source: &str) -> Result<Self, String> {
        let boundary = [BLOCK_END, USER_SECTION]
            .into_iter()
            .find(|boundary| source.contains(boundary));
        if let Some(boundary) = boundary {
            let mut ends = source.match_indices(boundary);
            let (end, _) = ends.next().ok_or("the user section boundary is missing")?;
            if ends.next().is_some() {
                return Err("the user section boundary is ambiguous".to_owned());
            }
            if source[end + boundary.len()..].lines().any(|line| {
                let line = line.trim_start_matches([' ', '\t']);
                !line.is_empty() && !line.starts_with('#')
            }) {
                return Err("the user section holds commands".to_owned());
            }
        }
        let mut roles = source
            .split('\n')
            .filter_map(|line| line.strip_prefix(ROLES));
        let value = roles
            .next()
            .ok_or("the roles assignment is missing")?
            .strip_suffix('"')
            .ok_or("the roles assignment is not one quoted word")?;
        if roles.next().is_some() {
            return Err("the roles assignment is ambiguous".to_owned());
        }
        // A plain double-quoted literal: nothing Bash would expand or unescape.
        if value.contains(['"', '$', '`', '\\']) {
            return Err("the roles assignment is not a literal".to_owned());
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
            roles: value.to_owned(),
            input_line,
        })
    }
}
