//! Anti-rollback matrix (spec 0058 T13, D15 of 0057): registry floor × marker `version=` × CLI ×
//! {inject, remove}. The expectation is computed here from plain version tuples, independently of
//! `semver`/`markers`, and the cross-check against the TS lives in `marker_parity.rs`.

use navori_core::integrity::marker_hash;
use navori_core::markers::{
    CommentStyle, InjectOptions, InjectStatus, Kept, MarkerMeta, inject_managed_section,
    remove_managed_section_guarded,
};

const OLDER: &str = "0.11.0";
const SAME: &str = "0.12.2";
const NEWER: &str = "0.13.0";
const CLIS: [&str; 2] = ["0.12.2", "0.13.0-rust.1"];

fn tuple(version: &str) -> (u32, u32, u32) {
    let core = version.split('-').next().unwrap_or_default();
    let mut parts = core
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or_default());
    (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    )
}

fn document(version: Option<&str>) -> String {
    let body = "old body";
    let version = version.map_or_else(String::new, |v| format!(" version=\"{v}\""));
    format!(
        "# Repo\n\n<!-- navori:managed id=\"core\" hash=\"{}\"{version} -->\n{body}\n<!-- /navori:managed id=\"core\" -->\n",
        marker_hash(body)
    )
}

// Covers: R37, R34
#[test]
fn inject_preserves_blocks_guarded_by_the_marker_or_the_floor() {
    let options = [None, Some(OLDER), Some(SAME), Some(NEWER)];
    for cli in CLIS {
        for floor in options {
            for marker in options {
                let existing = document(marker);
                let meta = MarkerMeta {
                    version: Some(cli.to_owned()),
                    ..MarkerMeta::default()
                };
                let result = inject_managed_section(
                    &existing,
                    "core",
                    "new body",
                    &meta,
                    InjectOptions {
                        ambient_floor: floor,
                        ..InjectOptions::default()
                    },
                );
                let guard = [marker, floor].into_iter().flatten().map(tuple).max();
                let expected_downgrade = guard.is_some_and(|guard| guard > tuple(cli));
                let cell = format!("cli={cli} floor={floor:?} marker={marker:?}");
                assert_eq!(result.details.downgrade, Some(expected_downgrade), "{cell}");
                if expected_downgrade {
                    assert_eq!(result.status, InjectStatus::DowngradeSkipped, "{cell}");
                    assert_eq!(result.output, existing, "{cell}");
                } else {
                    assert_eq!(result.status, InjectStatus::Updated, "{cell}");
                    assert!(result.output.contains("new body"), "{cell}");
                }
            }
        }
    }
}

// Covers: R37
#[test]
fn guarded_remove_ignores_the_floor_and_compares_only_against_the_cli() {
    // The TS `removeManagedSectionGuarded` reads `readCliVersion()` and never the floor (F25): a
    // block the floor protects from inject can still be removed. Pinned so the port keeps it.
    for cli in CLIS {
        for marker in [None, Some(OLDER), Some(SAME), Some(NEWER)] {
            let existing = document(marker);
            let result = remove_managed_section_guarded(&existing, "core", CommentStyle::Html, cli);
            let cell = format!("cli={cli} marker={marker:?}");
            match marker {
                None => assert_eq!(result, Err(Kept::Modified), "{cell}"),
                Some(version) if tuple(version) > tuple(cli) => {
                    assert_eq!(result, Err(Kept::Newer), "{cell}");
                }
                Some(_) => assert_eq!(result, Ok("# Repo\n\n".to_owned()), "{cell}"),
            }
        }
    }
}

// Covers: R37
#[test]
fn a_matching_body_never_restamps_a_newer_marker_down() {
    let existing = document(Some(NEWER));
    let meta = MarkerMeta {
        version: Some(SAME.to_owned()),
        source: Some("@navori/core".to_owned()),
        ..MarkerMeta::default()
    };
    let result = inject_managed_section(
        &existing,
        "core",
        "old body",
        &meta,
        InjectOptions::default(),
    );
    assert_eq!(result.status, InjectStatus::Unchanged);
    assert_eq!(result.output, existing);
}
