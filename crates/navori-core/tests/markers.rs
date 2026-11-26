//! Marker primitives that do not depend on the parser (spec 0058 T10). The inject/remove parity
//! lives in `navori-oracle-tests` (T11, T12).

use navori_core::render::context::{Lang, Mode, RenderContext, max_semver};

fn context(floor: Option<&str>) -> RenderContext {
    RenderContext {
        cli_version: "0.12.2".to_owned(),
        floor: floor.map(str::to_owned),
        lang: Lang::Es,
        mode: Mode::Preview,
        now_ms: 0.0,
        pid: 1,
    }
}

// Covers: R34
#[test]
fn the_floor_only_comes_from_the_context_or_the_block_meta() {
    // Two runs side by side: no state leaks from one context to the other (the TS module
    // variable would have made the second run inherit the first floor).
    let guarded = context(Some("0.13.0"));
    let open = context(None);
    assert_eq!(guarded.floor_for(None), Some("0.13.0"));
    assert_eq!(open.floor_for(None), None);
    // `meta.floorVersion` wins over the run-wide floor, as `??` does in `marker.ts:463`.
    assert_eq!(guarded.floor_for(Some("0.1.0")), Some("0.1.0"));
    assert_eq!(open.floor_for(Some("0.1.0")), Some("0.1.0"));
}

// Covers: R34, R37
#[test]
fn max_semver_matches_marker_ts() {
    assert_eq!(max_semver(Some("0.12.0"), Some("0.13.0")), Some("0.13.0"));
    assert_eq!(max_semver(Some("0.13.0"), Some("0.12.0")), Some("0.13.0"));
    // Equal cores keep `a`, prerelease included.
    assert_eq!(
        max_semver(Some("0.13.0-rust.1"), Some("0.13.0")),
        Some("0.13.0-rust.1")
    );
    // Absent or unparseable `b` returns `a` as is, even when `a` does not parse either.
    assert_eq!(max_semver(Some("garbage"), None), Some("garbage"));
    assert_eq!(max_semver(Some("garbage"), Some("x")), Some("garbage"));
    // Absent or unparseable `a` loses to a parseable `b`.
    assert_eq!(max_semver(None, Some("1.0.0")), Some("1.0.0"));
    assert_eq!(max_semver(Some("garbage"), Some("1.0.0")), Some("1.0.0"));
}

// Covers: R40
#[test]
fn dry_run_wins_over_apply_and_unknown_languages_fall_back_to_spanish() {
    assert_eq!(Mode::from_flags(true, false), Mode::Apply);
    assert_eq!(Mode::from_flags(true, true), Mode::Preview);
    assert_eq!(Mode::from_flags(false, false), Mode::Preview);
    assert_eq!(Lang::resolve(Some("en")), Lang::En);
    assert_eq!(Lang::resolve(Some("fr")), Lang::Es);
    assert_eq!(Lang::resolve(None), Lang::Es);
}
