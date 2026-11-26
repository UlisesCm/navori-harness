//! Exact-byte native hook integrity and the separate JS-compatible marker hash (D8).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha1::Sha1;
use sha2::{Digest, Sha256};

const PREFIX: &[u8] = b"# navori:native-hook v=1 file=sha256:";
const IMPL: &[u8] = b" impl=sha256:";
const ZERO_HASH: &[u8; 64] = b"0000000000000000000000000000000000000000000000000000000000000000";

struct Header<'a> {
    file: &'a [u8],
    implementation: &'a [u8],
    offset: usize,
}

fn hex(value: &[u8]) -> bool {
    value.len() == 64
        && value
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn header(script: &[u8]) -> Option<Header<'_>> {
    let mut found = None;
    let mut offset = 0;
    for line in script.split_inclusive(|byte| *byte == b'\n') {
        let body = line.strip_suffix(b"\n").unwrap_or(line);
        let body = body.strip_suffix(b"\r").unwrap_or(body);
        if body.starts_with(b"# navori:native-hook") {
            if found.is_some() {
                return None;
            }
            let hashes = body.strip_prefix(PREFIX)?;
            let file = hashes.get(..64)?;
            let implementation = hashes.get(64..)?.strip_prefix(IMPL)?;
            if !hex(file) || !hex(implementation) {
                return None;
            }
            found = Some(Header {
                file,
                implementation,
                offset: offset + PREFIX.len(),
            });
        }
        offset += line.len();
    }
    found
}

fn digest(script: &[u8], deps: &[&[u8]], metadata: &Header<'_>) -> String {
    let mut hash = Sha256::new();
    hash.update(&script[..metadata.offset]);
    hash.update(ZERO_HASH);
    hash.update(&script[metadata.offset + 64..]);
    for dep in deps {
        hash.update(dep);
    }
    format!("sha256:{}", encode_hex(&hash.finalize()))
}

/// Compute `file=` after replacing only its own 64 hex digits with zeros.
///
/// `deps` must follow the manifest's sorted relative-path order. No bytes are normalized.
/// Missing, unsupported, duplicate or malformed metadata yields `None`.
#[must_use]
pub fn script_hash(script: &[u8], deps: &[&[u8]]) -> Option<String> {
    header(script).map(|metadata| digest(script, deps, &metadata))
}

/// Check exact script/dependency bytes and the implementation compiled into this binary.
#[must_use]
pub fn verify(script: &[u8], deps: &[&[u8]], compiled_impl: &str) -> bool {
    let Some(metadata) = header(script) else {
        return false;
    };
    let Some(implementation) = compiled_impl.strip_prefix("sha256:") else {
        return false;
    };
    if !hex(implementation.as_bytes()) || metadata.implementation != implementation.as_bytes() {
        return false;
    }
    digest(script, deps, &metadata).as_bytes().get(7..) == Some(metadata.file)
}

/// Read integrity inputs before reading hook stdin. The caller decides whether an I/O failure
/// means deferral or a controlled failure; an absent/malformed signature always returns false.
///
/// # Errors
/// Returns the first script or dependency read error, without consuming stdin.
pub fn verify_file(script: &Path, deps: &[PathBuf], compiled_impl: &str) -> io::Result<bool> {
    let bytes = fs::read(script)?;
    let dependencies: Vec<Vec<u8>> = deps.iter().map(fs::read).collect::<io::Result<_>>()?;
    let slices: Vec<&[u8]> = dependencies.iter().map(Vec::as_slice).collect();
    Ok(verify(&bytes, &slices, compiled_impl))
}

/// ECMAScript `\s`: unlike Rust whitespace it includes FEFF and excludes NEL (0085).
#[must_use]
pub const fn is_js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// JS `replace(/\s+$/, "")`, without touching leading whitespace.
#[must_use]
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// `marker.ts` normalize: CRLF/CR become LF, then trailing JS whitespace is removed.
#[must_use]
pub fn normalize_marker(text: &str) -> String {
    let unix = text.replace("\r\n", "\n").replace('\r', "\n");
    js_trim_end(&unix).to_owned()
}

/// Marker compatibility only: SHA-1/8 is never accepted as native hook integrity.
#[must_use]
pub fn marker_hash(text: &str) -> String {
    encode_hex(&Sha1::digest(normalize_marker(text).as_bytes()))[..8].to_owned()
}
