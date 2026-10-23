//! Shared core of the navori Rust migration.

/// Internal prerelease of `navori-rust`, declared once in the workspace `Cargo.toml` (R25).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod audit;
pub mod integrity;
pub mod js_json;
pub mod manifest;

/// Embedded managed assets as `(repo-relative path, bytes)`, sorted by path.
pub mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
