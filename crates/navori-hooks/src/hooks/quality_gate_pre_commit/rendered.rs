//! What the renderer writes into quality-gate-pre-commit.sh, read back from the verified script,
//! and the shape the native hook requires of it (spec 0059 D40).

use crate::hooks::guard_destructive::rendered::indented as indented_word;

/// The managed block's closing marker; only the user section may follow it.
const BLOCK_END: &str = "# navori:managed end id=\"qg-pre-commit-base\"";
/// Where the user section starts in an unrendered asset (the corpus replays those bytes).
const USER_SECTION: &str = "\n# navori:user-section\n";
/// The `cd` that pins the gate to the tree being committed; Bash names its line on failure.
const CD_LINE: &str = "  cd \"${gate_root:-${nv_project_dir:-}}\" || {";

/// Values of the script that change verdicts. An unrendered copy holds its placeholder text,
/// exactly as the shell assigns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `gate` — `qualityGate.fast`, shell-quoted at render time.
    pub gate: String,
    /// `navori_native_fast` — `1` when the project's native git hook runs `fast`.
    pub native_fast: String,
    /// `navori_progress_hard_cap` inside the inlined `progress-ratchet` partial.
    pub progress_cap: Option<String>,
    /// 1-based line of [`CD_LINE`].
    pub cd_line: usize,
    /// Every function the script defines: `command -v` finds them before `PATH`.
    pub functions: Vec<String>,
}

impl Rendered {
    /// Read the rendered values. The script must close its managed block exactly once and carry
    /// only comments and blank lines after it: the native hook does not run a user section.
    ///
    /// # Errors
    /// The reason the script is not one the native hook reproduces.
    pub fn from_script(source: &str) -> Result<Self, String> {
        let boundary = if source.contains(BLOCK_END) {
            BLOCK_END
        } else {
            USER_SECTION
        };
        let mut ends = source.match_indices(boundary);
        let (end, _) = ends.next().ok_or("the user section boundary is missing")?;
        if ends.next().is_some() {
            return Err("the user section boundary is ambiguous".to_owned());
        }
        let tail = &source[end + boundary.len()..];
        if tail.lines().any(|line| {
            let line = line.trim_start_matches([' ', '\t']);
            !line.is_empty() && !line.starts_with('#')
        }) {
            return Err("the user section holds commands".to_owned());
        }
        let mut cd_lines = source
            .split('\n')
            .enumerate()
            .filter(|(_, line)| *line == CD_LINE);
        let cd_line = cd_lines.next().ok_or("the gate cd is missing")?.0 + 1;
        if cd_lines.next().is_some() {
            return Err("the gate cd is ambiguous".to_owned());
        }
        Ok(Self {
            gate: indented_word(source, "gate").ok_or("gate is not a plain word")?,
            native_fast: indented_word(source, "navori_native_fast")
                .ok_or("navori_native_fast is not a plain word")?,
            progress_cap: indented_word(source, "navori_progress_hard_cap"),
            cd_line,
            functions: functions(source),
        })
    }
}

/// `name() {` definitions, at any indentation.
fn functions(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|line| {
            let line = line.trim_start_matches([' ', '\t']);
            let (name, _) = line.split_once("()")?;
            let valid = name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            valid.then(|| name.to_owned())
        })
        .collect()
}
