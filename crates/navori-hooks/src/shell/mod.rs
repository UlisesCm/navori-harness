//! Shell text conventions shared by every ported hook (spec 0057 D8: hashed with each hook).

pub mod inert;

/// Shell text/character-count convention, supplied instead of inspecting LC_ALL.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Locale {
    /// BSD UTF-8 shell locale: POSIX space classes and scalar-value command lengths.
    #[default]
    Utf8,
    /// glibc i18n UTF-8 locale: POSIX space classes and scalar-value command lengths.
    GnuUtf8,
    /// LC_ALL=C: ASCII whitespace classes and encoded-byte command lengths.
    C,
}

impl Locale {
    /// Character-class contents shared by sed extraction and inert-policy expressions.
    pub(crate) fn space_class(self) -> &'static str {
        match self {
            // BSD en_US.UTF-8 has 24 space characters; U+0085 is not a member.
            Self::Utf8 => {
                r"\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}-\x{2029}\x{202F}\x{205F}\x{3000}"
            }
            // glibc-2.41/localedata/locales/i18n_ctype, space (lines 520–522).
            // en_US copies i18n -> i18n_ctype; C.UTF-8 also copies i18n_ctype.
            Self::GnuUtf8 => {
                r"\x{0009}-\x{000D}\x{0020}\x{1680}\x{2000}-\x{2006}\x{2008}-\x{200A}\x{2028}-\x{2029}\x{205F}\x{3000}"
            }
            Self::C => "[:space:]",
        }
    }

    /// Match the same POSIX class when the policy trims a segment or heredoc delimiter.
    pub(crate) fn whitespace(self, c: char) -> bool {
        match self {
            Self::Utf8 => matches!(c,
                '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}'..='\u{2029}' |
                '\u{202f}' | '\u{205f}' | '\u{3000}'
            ),
            Self::GnuUtf8 => matches!(c,
                '\u{0009}'..='\u{000d}' | ' ' | '\u{1680}' |
                '\u{2000}'..='\u{2006}' | '\u{2008}'..='\u{200a}' |
                '\u{2028}'..='\u{2029}' | '\u{205f}' | '\u{3000}'
            ),
            Self::C => matches!(c, '\u{0009}'..='\u{000d}' | ' '),
        }
    }

    /// Compile an ERE written with `[[:space:]]`, using this locale's space class.
    ///
    /// # Errors
    /// Returns the regex compilation error.
    pub(crate) fn ere(self, pattern: &str) -> Result<regex::Regex, regex::Error> {
        regex::Regex::new(&pattern.replace("[:space:]", self.space_class()))
    }
}
