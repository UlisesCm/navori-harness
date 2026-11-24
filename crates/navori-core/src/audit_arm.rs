//! `navori audit --arm` pieces that are not filesystem primitives: the `.armed` payload and the
//! language of the messages (`audit.ts:934-981`, `reportLang`).

use std::path::Path;

use crate::js_json::{self, JsObject, JsValue};
use crate::render::context::Lang;

/// The `.armed` file body: `JSON.stringify({ ts, cwd, ...(host ? { host } : {}) })` plus `\n`.
///
/// Same key order and escaping as the TS. An empty `host` is omitted, as the truthiness check
/// does. `None` only if the text cannot be stringified (not reachable for UTF-8 input).
#[must_use]
pub fn armed_payload(ts: &str, cwd: &str, host: Option<&str>) -> Option<String> {
    let mut record = JsObject::new();
    record.insert("ts", JsValue::string(ts));
    record.insert("cwd", JsValue::string(cwd));
    if let Some(host) = host.filter(|host| !host.is_empty()) {
        record.insert("host", JsValue::string(host));
    }
    let mut text = JsValue::Object(record).stringify(None)?;
    text.push('\n');
    Some(text)
}

/// `new Date().toISOString()`: 24 characters, milliseconds and `Z`.
#[must_use]
pub fn iso_now() -> String {
    iso(jiff::Timestamp::now())
}

fn iso(at: jiff::Timestamp) -> String {
    at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `reportLang(cwd)`: the `language` of `<cwd>/navori.config.json` when it is the string `"en"`,
/// Spanish otherwise. A missing, unreadable, malformed or non-object config falls back silently,
/// as the TS does.
///
/// Known limit: [`js_json::parse`] declines documents JS accepts but it does not model (lone
/// surrogate escapes, numbers that overflow, nesting past 128, a `__proto__` key); those read as
/// malformed here and give Spanish.
#[must_use]
pub fn report_lang(cwd: &Path) -> Lang {
    let Ok(bytes) = std::fs::read(cwd.join("navori.config.json")) else {
        return Lang::Es;
    };
    let text = String::from_utf8_lossy(&bytes);
    let Some(JsValue::Object(config)) = js_json::parse(&text) else {
        return Lang::Es;
    };
    match config.get("language") {
        Some(JsValue::String(language)) if language.is("en") => Lang::En,
        _ => Lang::Es,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]

    use super::*;

    #[test]
    fn payload_without_host_is_ts_and_cwd() {
        assert_eq!(
            armed_payload("2026-01-02T03:04:05.678Z", "/r/x", None).as_deref(),
            Some("{\"ts\":\"2026-01-02T03:04:05.678Z\",\"cwd\":\"/r/x\"}\n")
        );
    }

    #[test]
    fn payload_with_host_appends_it_last() {
        assert_eq!(
            armed_payload("t", "/r", Some("pi")).as_deref(),
            Some("{\"ts\":\"t\",\"cwd\":\"/r\",\"host\":\"pi\"}\n")
        );
    }

    #[test]
    fn payload_omits_an_empty_host() {
        assert_eq!(
            armed_payload("t", "/r", Some("")).as_deref(),
            Some("{\"ts\":\"t\",\"cwd\":\"/r\"}\n")
        );
    }

    #[test]
    fn payload_escapes_like_json_stringify() {
        assert_eq!(
            armed_payload("t", "/r/\"q\"\\\n\u{1}é😀", None).as_deref(),
            Some("{\"ts\":\"t\",\"cwd\":\"/r/\\\"q\\\"\\\\\\n\\u0001é😀\"}\n")
        );
    }

    #[test]
    fn ts_has_the_to_iso_string_shape() {
        let now = iso_now();
        let b = now.as_bytes();
        assert_eq!(b.len(), 24);
        assert!(b.ends_with(b"Z"));
        assert_eq!(
            (b[4], b[7], b[10], b[13], b[16], b[19]),
            (b'-', b'-', b'T', b':', b':', b'.')
        );
        assert!(b[20..23].iter().all(u8::is_ascii_digit));
    }

    #[test]
    fn ts_keeps_trailing_zero_milliseconds() {
        let at: jiff::Timestamp = "2026-01-02T03:04:05Z".parse().unwrap();
        assert_eq!(iso(at), "2026-01-02T03:04:05.000Z");
        let at: jiff::Timestamp = "2026-01-02T03:04:05.07Z".parse().unwrap();
        assert_eq!(iso(at), "2026-01-02T03:04:05.070Z");
    }

    struct Dir(std::path::PathBuf);

    impl Dir {
        fn with(config: Option<&[u8]>) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "navori-audit-arm-{}-{:p}",
                std::process::id(),
                &config
            ));
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(config) = config {
                std::fs::write(dir.join("navori.config.json"), config).unwrap();
            }
            Self(dir)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn lang(config: Option<&str>) -> Lang {
        let dir = Dir::with(config.map(str::as_bytes));
        report_lang(&dir.0)
    }

    #[test]
    fn report_lang_reads_en_and_es() {
        assert_eq!(lang(Some(r#"{"language":"en"}"#)), Lang::En);
        assert_eq!(lang(Some(r#"{"language":"es"}"#)), Lang::Es);
    }

    #[test]
    fn report_lang_falls_back_silently() {
        assert_eq!(lang(None), Lang::Es);
        assert_eq!(lang(Some("{ not json")), Lang::Es);
        assert_eq!(lang(Some("null")), Lang::Es);
        assert_eq!(lang(Some("[\"en\"]")), Lang::Es);
        assert_eq!(lang(Some(r#"{"language":1}"#)), Lang::Es);
        assert_eq!(lang(Some(r#"{"language":"fr"}"#)), Lang::Es);
        assert_eq!(lang(Some("\u{feff}{\"language\":\"en\"}")), Lang::Es);
    }

    #[test]
    fn report_lang_with_a_directory_instead_of_a_config_is_spanish() {
        let dir = Dir::with(None);
        std::fs::create_dir(dir.0.join("navori.config.json")).unwrap();
        assert_eq!(report_lang(&dir.0), Lang::Es);
    }
}
