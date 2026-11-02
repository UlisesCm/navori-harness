//! The native version notices stay off while the migration is open (spec 0062 T9, R85; Q6 of
//! 0058): no notice before a command and no native worker, so the TS answers both. The behavior
//! the cutover turns on is compared with the TS in `navori-oracle-tests/tests/notices_parity.rs`.

use std::ffi::OsString;

use navori_cli::notices::{ENABLED, worker};
use navori_core::tools::{notice, update_notice};

// Covers: R85
#[test]
fn los_avisos_nativos_siguen_apagados_durante_la_convivencia() {
    assert!(!ENABLED, "the notices turn on with the cutover (T11), not before");
    let token = OsString::from("11111111-1111-4111-8111-111111111111");
    for flag in [update_notice::WORKER_ARG, notice::WORKER_ARG] {
        assert!(worker(&[OsString::from(flag), token.clone()]).is_none(), "{flag}");
    }
    // The private flags are the TS's, so a worker either CLI reserves is one the other can run.
    assert_eq!(update_notice::WORKER_ARG, "--navori-private-update-worker");
    assert_eq!(notice::WORKER_ARG, "--navori-private-tool-version-worker");
}
