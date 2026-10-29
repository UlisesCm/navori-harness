//! Shared core of the navori Rust migration.

/// Internal prerelease of `navori-rust`, declared once in the workspace `Cargo.toml` (R25).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Version stamped into markers, `$navori.version` and `harnessVersion` while the migration is
/// open: the TS CLI of the checkout this binary was built from, never [`VERSION`] (spec 0058 D20,
/// R38). `parseSemver` drops the prerelease, so stamping `0.13.0-rust.<n>` would make every block
/// written by Rust look newer than the TS CLI and freeze it behind the anti-rollback guard.
pub const STAMP_VERSION: &str = env!("NAVORI_TS_CLI_VERSION");

pub mod audit;
pub mod collate;
pub mod config;
pub mod content_identity;
pub mod diagnose;
pub mod gate;
pub mod i18n;
pub mod integrity;
pub mod js_json;
pub mod js_re;
pub mod manifest;
pub mod markers;
pub mod plan;
pub mod posix;
pub mod process;
pub mod render;
pub mod semver;
pub mod spec;
pub mod state_root;
pub mod workspace;
mod zod;

/// Embedded managed assets as `(repo-relative path, bytes)`, sorted by path.
pub mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
