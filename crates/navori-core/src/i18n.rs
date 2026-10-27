//! Strings of `packages/cli/src/lib/i18n.ts` emitted by native code, per locale. Only the entries
//! the ported commands print live here; each one is checked against the TS by the parity tests.

use crate::render::context::Lang;

/// `common.unknownConfigValues`.
#[must_use]
pub fn unknown_config_values(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: valores de config desconocidos ignorados (¿config de un navori más nuevo? actualiza el CLI): {list}"
        ),
        Lang::En => format!(
            "navori: unknown config values ignored (config from a newer navori? update the CLI): {list}"
        ),
    }
}

/// `common.unknownConfigKeys`.
#[must_use]
pub fn unknown_config_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: claves de config desconocidas (no se rechazan para mantener compatibilidad futura): {list}"
        ),
        Lang::En => format!(
            "navori: unknown config keys (not rejected to preserve forward compatibility): {list}"
        ),
    }
}

/// `common.deadProgressKeys`.
#[must_use]
pub fn dead_progress_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: claves obsoletas ignoradas en \"progress\" (puedes borrarlas del navori.config.json): {list}"
        ),
        Lang::En => format!(
            "navori: obsolete keys ignored in \"progress\" (you can delete them from navori.config.json): {list}"
        ),
    }
}

/// `common.deprecatedConfigKeys`.
#[must_use]
pub fn deprecated_config_keys(lang: Lang, list: &str) -> String {
    match lang {
        Lang::Es => format!(
            "navori: perillas obsoletas sin efecto completo en runtime (puedes borrarlas del navori.config.json): {list}"
        ),
        Lang::En => format!(
            "navori: deprecated knobs without a complete runtime effect (you can delete them from navori.config.json): {list}"
        ),
    }
}
