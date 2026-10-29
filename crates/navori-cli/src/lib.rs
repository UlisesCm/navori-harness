//! `navori-rust`: parser, native command table and delegation to the TS CLI.

pub mod adopt;
pub mod commands;
pub mod delegate;
pub mod facts_cache;
pub mod help;
pub mod hook;
pub mod hook_facts;
pub mod journal;
pub mod parser;
pub mod render;
pub mod shadow;

use std::ffi::OsString;
use std::process::ExitCode;

use navori_core::manifest::{Command, Manifest};

use parser::Invocation;

/// What a native command receives: the argv and the manifest entry that selected it.
pub struct NativeCall<'a> {
    /// The arguments, without the program name.
    pub args: &'a [OsString],
    /// The selecting entry, whose `flags` and `when` bound what runs natively (D3).
    pub entry: &'a Command,
}

/// How a native command ended.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// It ran; the process exits with this code.
    Exit(ExitCode),
    /// The invocation is outside the native subset: the TS runs it. Returned only before any
    /// output or effect (R39).
    Delegate,
}

/// A natively implemented command. Listing one here is not enough to run it: the manifest must
/// also select it (R7).
pub struct NativeCommand {
    /// Command path, equal to the manifest entry's `path`.
    pub path: &'static [&'static str],
    /// The implementation.
    pub run: fn(&NativeCall<'_>) -> Outcome,
}

fn print_version(_: &NativeCall<'_>) -> Outcome {
    println!("{}", navori_core::VERSION);
    Outcome::Exit(ExitCode::SUCCESS)
}

fn print_root_help(_: &NativeCall<'_>) -> Outcome {
    print!("{}", help::root_help(navori_core::VERSION));
    Outcome::Exit(ExitCode::SUCCESS)
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
    NativeCommand {
        path: &["render"],
        run: render::run,
    },
    NativeCommand {
        path: &["adopt"],
        run: adopt::run,
    },
];

/// The native command that runs `invocation` and the entry that selected it, or `None` to
/// delegate (R5, R7).
#[must_use]
pub fn dispatch<'m>(
    manifest: &'m Manifest,
    invocation: &Invocation,
) -> Option<(&'static NativeCommand, &'m Command)> {
    let entry = manifest.select(&invocation.path, &invocation.flags)?;
    let native = NATIVE.iter().find(|native| {
        native
            .path
            .iter()
            .copied()
            .eq(entry.path.iter().map(String::as_str))
    })?;
    Some((native, entry))
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
    if let Some((native, entry)) = dispatch(&manifest, &invocation)
        && let Outcome::Exit(code) = (native.run)(&NativeCall { args, entry })
    {
        return code;
    }
    let subcommand = args
        .first()
        .map_or_else(|| "(none)".to_owned(), |a| a.to_string_lossy().into_owned());
    delegate::run(args, &subcommand)
}
