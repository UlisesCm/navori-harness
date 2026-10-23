//! Spec 0057 D8: integrity is over exact bytes, independent of marker normalization.

use navori_core::integrity::{marker_hash, script_hash, verify};

const IMPLEMENTATION: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn unsigned() -> String {
    format!(
        "#!/bin/sh\n# navori:native-hook v=1 file=sha256:{} impl={IMPLEMENTATION}\nprintf ok\n",
        "0".repeat(64)
    )
}

// Covers: R11, R13
#[test]
fn crlf_trailing_space_and_a_changed_sibling_defer_to_shell() -> Result<(), String> {
    let script = unsigned();
    let deps = [b"sibling\n".as_slice()];
    let hash = script_hash(script.as_bytes(), &deps).ok_or("missing metadata")?;
    let signed = script.replacen(&"0".repeat(64), &hash[7..], 1);
    assert!(verify(signed.as_bytes(), &deps, IMPLEMENTATION));
    assert!(!verify(
        signed.replace('\n', "\r\n").as_bytes(),
        &deps,
        IMPLEMENTATION
    ));
    assert!(!verify(
        format!("{signed} ").as_bytes(),
        &deps,
        IMPLEMENTATION
    ));
    assert!(!verify(signed.as_bytes(), &[b"sibling \n"], IMPLEMENTATION));
    assert!(!verify(
        signed.as_bytes(),
        &deps,
        &format!("sha256:{}", "b".repeat(64))
    ));
    assert!(!verify(
        signed.replace("v=1", "v=2").as_bytes(),
        &deps,
        IMPLEMENTATION
    ));
    assert!(!verify(
        format!("{signed}{signed}").as_bytes(),
        &deps,
        IMPLEMENTATION
    ));
    assert!(!verify(b"no signature", &deps, IMPLEMENTATION));
    Ok(())
}

// Covers: R11, R13
#[test]
fn dependency_order_and_binary_bytes_are_part_of_integrity() -> Result<(), String> {
    let script = unsigned();
    let hash = script_hash(script.as_bytes(), &[b"a\xff", b"b\x00"]).ok_or("metadata")?;
    let signed = script.replacen(&"0".repeat(64), &hash[7..], 1);
    assert!(verify(
        signed.as_bytes(),
        &[b"a\xff", b"b\x00"],
        IMPLEMENTATION
    ));
    assert!(!verify(
        signed.as_bytes(),
        &[b"b\x00", b"a\xff"],
        IMPLEMENTATION
    ));
    Ok(())
}

// Covers: R11, R13
#[test]
fn marker_normalization_does_not_apply_to_integrity() {
    assert_eq!(marker_hash("body\r\n\u{feff}"), marker_hash("body"));
    assert_ne!(marker_hash("body\u{85}"), marker_hash("body"));
    assert_ne!(marker_hash("body\u{180e}"), marker_hash("body"));
}
