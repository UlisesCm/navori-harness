//! Pure Bash capture diagnostics; runtime detection and script/source discovery belong to callers.

use std::path::Path;

/// Explicit command-substitution behavior of the original shell, not the current Rust host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellDialect {
    /// Bash 3.2 silently drops NUL bytes in command substitutions.
    Bash3,
    /// Modern Bash emits one warning per command substitution containing one or more NULs.
    Bash5,
}

/// Original script identity and line locations, supplied without filesystem access or probes.
#[derive(Debug, Clone, Copy)]
pub struct CaptureContext<'a> {
    /// Original shell's diagnostic dialect.
    pub shell: ShellDialect,
    /// Script path as OS bytes, including non-UTF-8 Unix paths.
    pub script: &'a Path,
    /// Expanded-source line of the initial payload command substitution.
    pub input_line: usize,
    /// Expanded-source line of the individual payload_field fallback command substitution.
    pub fallback_line: usize,
}

/// Prefix diagnostics in execution order; cached variables cannot contain or drop another NUL.
pub(crate) fn prepend(
    context: CaptureContext<'_>,
    raw_nul: bool,
    field_substitutions: usize,
    stderr: Vec<u8>,
) -> Vec<u8> {
    if context.shell == ShellDialect::Bash3 || (!raw_nul && field_substitutions == 0) {
        return stderr;
    }
    let mut output = Vec::new();
    if raw_nul {
        warning(&mut output, context, context.input_line);
    }
    for _ in 0..field_substitutions {
        warning(&mut output, context, context.fallback_line);
    }
    output.extend_from_slice(&stderr);
    output
}

fn warning(output: &mut Vec<u8>, context: CaptureContext<'_>, line: usize) {
    output.extend_from_slice(context.script.as_os_str().as_encoded_bytes());
    output.extend_from_slice(b": line ");
    output.extend_from_slice(line.to_string().as_bytes());
    output.extend_from_slice(b": warning: command substitution: ignored null byte in input\n");
}
