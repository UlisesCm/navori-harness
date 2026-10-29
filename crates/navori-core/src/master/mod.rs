//! `lib/master` in Rust (spec 0060 T8), read-only parts first: the stage registry, the legacy
//! state and parts, and `readMasterStatus`.

pub mod check_part;
pub mod index;
pub mod state;
pub mod status;
