//! Shared core of the navori Rust migration.

/// Internal prerelease of `navori-rust`, declared once in the workspace `Cargo.toml` (R25).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Version stamped into markers, `$navori.version` and `harnessVersion` while the migration is
/// open: the TS CLI of the checkout this binary was built from, never [`VERSION`] (spec 0058 D20,
/// R38). `parseSemver` drops the prerelease, so stamping `0.13.0-rust.<n>` would make every block
/// written by Rust look newer than the TS CLI and freeze it behind the anti-rollback guard.
pub const STAMP_VERSION: &str = env!("NAVORI_TS_CLI_VERSION");

pub mod adopt;
pub mod audit;
pub mod backup;
pub mod commit;
pub mod config;
pub mod fs;
pub mod i18n;
pub mod integrity;
pub mod js_json;
pub mod manifest;
pub mod markers;
pub mod render;
pub mod semver;
pub mod sync;
mod zod;

/// Embedded managed assets as `(repo-relative path, bytes)`, sorted by path.
pub mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
