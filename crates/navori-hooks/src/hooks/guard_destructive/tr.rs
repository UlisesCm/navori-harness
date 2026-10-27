//! Character classes of `tr` as rules 6c and 7 use them. BSD `tr` reads characters with the
//! C library's wide classes; GNU `tr` reads bytes, so only ASCII members count there.

use crate::shell::Locale;

/// `tr`'s `[:space:]`.
pub(super) fn space(locale: Locale, c: char) -> bool {
    match locale {
        Locale::Utf8 => locale.whitespace(c),
        Locale::GnuUtf8 | Locale::C => matches!(c, '\u{0009}'..='\u{000d}' | ' '),
    }
}

/// `tr`'s `[:blank:]`: space and tab in every supported locale (measured on BSD `tr`).
pub(super) fn blank(c: char) -> bool {
    matches!(c, ' ' | '\t')
}

/// `tr`'s `[:cntrl:]`. On macOS `iswcntrl` covers Cc and most of Cf (measured over every
/// scalar value).
pub(super) fn cntrl(locale: Locale, c: char) -> bool {
    match locale {
        Locale::Utf8 => matches!(c,
            '\u{0001}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{00ad}' |
            '\u{0600}'..='\u{0605}' | '\u{061c}' | '\u{06dd}' | '\u{070f}' |
            '\u{0890}'..='\u{0891}' | '\u{08e2}' | '\u{180e}' | '\u{200b}'..='\u{200f}' |
            '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' |
            '\u{fff9}'..='\u{fffb}' | '\u{110bd}' | '\u{110cd}' |
            '\u{13430}'..='\u{1343f}' | '\u{1bca0}'..='\u{1bca3}' |
            '\u{1d173}'..='\u{1d17a}' | '\u{e0001}' | '\u{e0020}'..='\u{e007f}'
        ),
        Locale::GnuUtf8 | Locale::C => matches!(c, '\u{0001}'..='\u{001f}' | '\u{007f}'),
    }
}
