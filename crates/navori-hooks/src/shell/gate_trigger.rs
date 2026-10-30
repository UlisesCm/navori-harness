//! The `gate-trigger` partial's entry points: `has_trigger_token` and `is_scan_trigger`. The
//! segment scan itself (`navori_count_triggers`, heredoc stripping) lives in [`super::landing`],
//! which `navori_commit_landing` shares with it.

use std::sync::LazyLock;

use regex::Regex;

use super::Locale;
use super::landing::count_triggers;

/// `git` global options between `git` and the subcommand, as `$TRIGGER_RE` spells them.
const GIT_OPTS: &str =
    r"([[:space:]]+-[a-zA-Z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*";

/// Which git operations a hook gates (`$TRIGGER_RE` with its `$TRIGGER_TOKENS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// `git commit` (Claude and Codex, and Pi's foreign-repo re-check).
    Commit,
    /// `git commit` or `git push` (the Pi copy, spec 0048 D5).
    CommitOrPush,
}

impl Trigger {
    /// `$TRIGGER_TOKENS`: literal substrings every match needs.
    const fn tokens(self) -> &'static [&'static str] {
        match self {
            Self::Commit => &["commit"],
            Self::CommitOrPush => &["commit", "push"],
        }
    }

    fn pattern(self) -> String {
        let ops = match self {
            Self::Commit => "commit",
            Self::CommitOrPush => "(commit|push)",
        };
        format!(r"^git{GIT_OPTS}[[:space:]]+{ops}([[:space:]]|$)")
    }

    /// `$TRIGGER_RE` compiled for `locale`.
    ///
    /// # Errors
    /// The regex compilation error, as text.
    pub fn regex(self, locale: Locale) -> Result<&'static Regex, String> {
        const LOCALES: [Locale; 3] = [Locale::Utf8, Locale::GnuUtf8, Locale::C];
        static COMPILED: LazyLock<Vec<Result<Regex, regex::Error>>> = LazyLock::new(|| {
            [Trigger::Commit, Trigger::CommitOrPush]
                .into_iter()
                .flat_map(|trigger| LOCALES.map(|locale| locale.ere(&trigger.pattern())))
                .collect()
        });
        let row = match self {
            Self::Commit => 0,
            Self::CommitOrPush => 1,
        };
        let column = LOCALES.iter().position(|l| *l == locale).unwrap_or(0);
        COMPILED
            .get(row * LOCALES.len() + column)
            .ok_or_else(|| "trigger pattern missing".to_owned())?
            .as_ref()
            .map_err(|error| format!("trigger pattern: {error}"))
    }
}

/// `has_trigger_token`: false only when no token appears, which proves no segment can match.
#[must_use]
pub fn has_trigger_token(input: &str, trigger: Trigger) -> bool {
    trigger.tokens().iter().any(|token| input.contains(token))
}

/// `is_scan_trigger` with `TRIGGER_STRIP_HEREDOC_BODIES=1`: some segment of `input` starts with a
/// gated `git` operation.
///
/// # Errors
/// A trigger pattern that does not compile.
pub fn is_scan_trigger(input: &str, trigger: Trigger, locale: Locale) -> Result<bool, String> {
    scan(
        input,
        trigger.tokens(),
        trigger.regex(locale)?,
        true,
        locale,
    )
}

/// `is_scan_trigger` for a hook that declares its own `$TRIGGER_TOKENS` and `$TRIGGER_RE`:
/// false when no token appears, else whether some segment matches `regex`.
/// `strip_heredoc_bodies` is `TRIGGER_STRIP_HEREDOC_BODIES=1`.
///
/// # Errors
/// Never for a compiled `regex`; kept for the shared segment scan's signature.
pub fn scan(
    input: &str,
    tokens: &[&str],
    regex: &Regex,
    strip_heredoc_bodies: bool,
    locale: Locale,
) -> Result<bool, String> {
    if !tokens.iter().any(|token| input.contains(token)) {
        return Ok(false);
    }
    Ok(count_triggers(input, regex, strip_heredoc_bodies, locale)? > 0)
}

#[cfg(test)]
mod tests {
    use super::{Trigger, is_scan_trigger};
    use crate::shell::Locale;

    // Covers: R50
    #[test]
    fn segments_wrappers_and_heredoc_bodies_follow_the_partial() -> Result<(), String> {
        let commit = |cmd: &str| is_scan_trigger(cmd, Trigger::Commit, Locale::Utf8);
        assert!(commit("git commit -m x")?);
        assert!(commit("cd x && FOO=1 command git -C /r commit")?);
        assert!(commit("(git -c a=b commit")?);
        assert!(!commit("git commitgraph")?);
        assert!(!commit("echo \"git commit\"")?);
        assert!(!commit(
            "gh issue create --body \"$(cat <<'EOF'\ngit commit -m x\nEOF\n)\""
        )?);
        assert!(!commit("git push origin main")?);
        assert!(is_scan_trigger(
            "git push origin main",
            Trigger::CommitOrPush,
            Locale::C
        )?);
        Ok(())
    }
}
