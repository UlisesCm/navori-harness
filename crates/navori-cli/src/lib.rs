//! `navori-rust`: parser, native command table and delegation to the TS CLI.

pub mod commands;
pub mod delegate;
pub mod facts_cache;
pub mod help;
pub mod hook;
pub mod hook_facts;
pub mod journal;
pub mod parser;
pub mod shadow;

use std::ffi::OsString;
use std::process::ExitCode;

use navori_core::manifest::Manifest;

use parser::Invocation;

/// A natively implemented command. Listing one here is not enough to run it: the manifest must
/// also select it (R7).
pub struct NativeCommand {
    /// Command path, equal to the manifest entry's `path`.
    pub path: &'static [&'static str],
    /// The implementation.
    pub run: fn() -> ExitCode,
}

fn print_version() -> ExitCode {
    println!("{}", navori_core::VERSION);
    ExitCode::SUCCESS
}

fn print_root_help() -> ExitCode {
    print!("{}", help::root_help(navori_core::VERSION));
    ExitCode::SUCCESS
}

/// Every native implementation in this build.
pub const NATIVE: &[NativeCommand] = &[
    NativeCommand {
        path: &["--version"],
        run: print_version,
    },
    NativeCommand {
        path: &["--help"],
        run: print_root_help,
    },
];

/// The native command that runs `invocation`, or `None` to delegate (R5, R7).
#[must_use]
pub fn dispatch(manifest: &Manifest, invocation: &Invocation) -> Option<&'static NativeCommand> {
    let entry = manifest.select(&invocation.path, &invocation.flags)?;
    NATIVE.iter().find(|native| {
        native
            .path
            .iter()
            .copied()
            .eq(entry.path.iter().map(String::as_str))
    })
}

/// Entry point shared by the binary and the tests.
#[must_use]
pub fn run(args: &[OsString]) -> ExitCode {
    let looped = delegate::is_loop(
        std::env::var_os(delegate::DELEGATED_VAR).as_deref(),
        std::process::id(),
    );
    if looped {
        eprintln!(
            "navori-rust: delegation loop: {} points back to navori-rust (pid {})",
            delegate::TS_CLI_VAR,
            std::process::id()
        );
        return ExitCode::from(delegate::EXIT_LOOP);
    }
    // Internal hooks never delegate, but still obey the global same-process loop guard.
    if args.first().is_some_and(|arg| arg == "hook") {
        return hook::run(&args[1..]);
    }
    let manifest = match Manifest::embedded() {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!("navori-rust: invalid embedded manifest: {error}");
            return ExitCode::FAILURE;
        }
    };
    let invocation = parser::parse(args);
    if let Some(native) = dispatch(&manifest, &invocation) {
        return (native.run)();
    }
    let subcommand = args
        .first()
        .map_or_else(|| "(none)".to_owned(), |a| a.to_string_lossy().into_owned());
    delegate::run(args, &subcommand)
}
