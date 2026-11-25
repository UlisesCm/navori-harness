//! D8 implementation hashes generated outside the source tree, without activating handlers.

include!(concat!(env!("OUT_DIR"), "/implementation_hashes.rs"));

/// Compiled hash for a hook's normalized source directory, or None when no sources exist.
/// Manifest selection and handler registration remain separate requirements.
#[must_use]
pub fn implementation_hash(id: &str) -> Option<&'static str> {
    if id.is_empty()
        || !id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return None;
    }
    let normalized = id.replace('-', "_");
    IMPLEMENTATION_HASHES
        .iter()
        .find_map(|(name, hash)| (*name == normalized).then_some(*hash))
}
