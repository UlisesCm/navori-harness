//! `lib/master` in Rust (spec 0060 T8), read-only parts first: the stage registry, the legacy
//! state and parts, `readMasterStatus`, the templates, `check` and the renders it compares.

pub mod check_part;
pub mod checks;
pub mod fit;
pub mod index;
pub mod markers;
pub mod part;
pub mod render;
pub mod state;
pub mod status;
pub mod templates;
pub mod write;
