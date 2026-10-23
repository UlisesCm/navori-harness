//! Shared core of the navori Rust migration.

/// Internal prerelease of `navori-rust`, declared once in the workspace `Cargo.toml` (R25).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Embedded managed assets as `(repo-relative path, bytes)`, sorted by path.
pub mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
