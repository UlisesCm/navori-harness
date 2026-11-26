//! `NON_IMPLEMENTER_ROLES` of `engines/shared/roster.ts`: roles the plan gate never gates.
//! `scripts/js/rust-oracle/plan-tables.mjs` records the TS list and a test compares both.

/// Roles that never write code (spec 0052, R3), plus Codex's built-in read-only roles.
pub const NON_IMPLEMENTER_ROLES: &[&str] = &[
    "scout",
    "architect",
    "auditor",
    "reviewer",
    "scribe",
    "publisher",
    "explorer",
];
