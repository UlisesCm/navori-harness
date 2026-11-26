//! `String.prototype.localeCompare` under Node's default ICU collator, for the one shape the port
//! reproduces exactly: printable ASCII text under a default locale whose collation of ASCII is
//! CLDR root's (`und`, `en`, `es`, `C`, `POSIX`). Anything else is `None` and the caller hands the
//! work to the TS.
//!
//! In CLDR root, printable ASCII has non-ignorable primary weights in the order of [`PRIMARY`]
//! (each letter shares one weight across cases), uniform secondary weights, and a tertiary weight
//! that puts lowercase before uppercase. A comparison is therefore the primary sequences first and,
//! when those tie, the case sequence.

use std::cmp::Ordering;

use crate::process::Env;

/// Printable ASCII in CLDR root order; a letter's lowercase and uppercase forms are adjacent and
/// share a primary weight. Generated from Node 24's ICU and checked by
/// `scripts/js/rust-oracle/tools-tables.mjs`.
const PRIMARY: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";

/// Whether Node's default collator orders ASCII like CLDR root. ICU takes the default locale from
/// the first of `LC_ALL`, `LC_MESSAGES` and `LANG` that is set (an empty one counts), and `es`
/// tailors only `ñ`.
#[must_use]
pub fn default_locale_modeled(env: &Env) -> bool {
    let value = ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|name| {
        env.iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_str())
    });
    let Some(value) = value else {
        return true;
    };
    let Some(value) = value else {
        return false;
    };
    if matches!(value, "" | "C" | "POSIX" | "C.UTF-8" | "C.utf8") {
        return true;
    }
    ["en", "es"].iter().any(|language| {
        value
            .strip_prefix(language)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['_', '.', '@', '-']))
    })
}

/// `(primary, uppercase)` of a printable ASCII character.
fn weight(c: char) -> Option<(usize, bool)> {
    let index = PRIMARY.find(c)?;
    // Letters occupy pairs: `a` at an even offset from `a`'s index, `A` right after it.
    let letters = PRIMARY.find('a')?;
    if index >= letters {
        let offset = index - letters;
        return Some((letters + offset / 2, offset % 2 == 1));
    }
    Some((index, false))
}

/// `a.localeCompare(b)` for printable ASCII; `None` for any other character.
#[must_use]
pub fn compare_ascii(a: &str, b: &str) -> Option<Ordering> {
    let weights = |text: &str| text.chars().map(weight).collect::<Option<Vec<_>>>();
    let (left, right) = (weights(a)?, weights(b)?);
    let primary = left.iter().map(|w| w.0).cmp(right.iter().map(|w| w.0));
    Some(primary.then_with(|| left.iter().map(|w| w.1).cmp(right.iter().map(|w| w.1))))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::default_locale_modeled;

    // Covers: R56
    #[test]
    fn the_default_locale_follows_lc_all_lc_messages_and_lang() {
        let env = |pairs: &[(&str, &str)]| -> Vec<(OsString, OsString)> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect()
        };
        for (pairs, modeled) in [
            (&[][..], true),
            (&[("LANG", "es_MX.UTF-8")][..], true),
            (&[("LANG", "en")][..], true),
            (&[("LANG", "da_DK.UTF-8")][..], false),
            (&[("LC_ALL", "C"), ("LANG", "da_DK.UTF-8")][..], true),
            (&[("LC_ALL", ""), ("LANG", "da_DK.UTF-8")][..], true),
            (&[("LC_MESSAGES", "sv_SE"), ("LANG", "en_US")][..], false),
            (&[("LC_COLLATE", "da_DK"), ("LANG", "en_US")][..], true),
            (&[("LANG", "eng")][..], false),
        ] {
            assert_eq!(default_locale_modeled(&env(pairs)), modeled, "{pairs:?}");
        }
    }
}
