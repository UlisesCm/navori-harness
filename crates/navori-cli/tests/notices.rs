//! The native version notices are on from 0.13.0 (spec 0062 T9, R85): the CLI prints the update
//! notice before a command and answers the two private workers itself. The behavior is compared
//! with the TS in `navori-oracle-tests/tests/notices_parity.rs`.

use std::ffi::OsString;

use navori_cli::notices::{ENABLED, worker};
use navori_core::tools::{notice, update_notice};

// Covers: R85
#[test]
fn los_avisos_nativos_estan_encendidos_desde_0_13_0() {
    const {
        assert!(ENABLED, "the notices are on from 0.13.0");
    }
    // Only an argv that is not a worker is run here: a real worker would reach the network.
    for args in [
        vec![],
        vec![OsString::from("render")],
        vec![OsString::from("--other-flag")],
    ] {
        assert!(worker(args.as_slice()).is_none(), "{args:?}");
    }
    // The private flags are the TS's, so a worker either CLI reserves is one the other can run.
    assert_eq!(update_notice::WORKER_ARG, "--navori-private-update-worker");
    assert_eq!(notice::WORKER_ARG, "--navori-private-tool-version-worker");
}
