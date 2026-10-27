//! Spec 0057 T28 (R11): `copy_dest::safe` against the real `navori_copy_dest_safe` awk program.

use std::error::Error;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use navori_hooks::hooks::guard_destructive::copy_dest::{Inputs, safe};

type TestResult = Result<(), Box<dyn Error>>;

const OWNED: &str =
    ".claude/hooks/guard.sh\n.claude/settings.json\nAGENTS.md\n.agents/skills/x/SKILL.md";

/// One shell process: the real partial, one verdict line per NUL-terminated `live`.
fn shell_verdicts(
    root: &str,
    cwd: &str,
    pwd: &str,
    lives: &[String],
) -> Result<Vec<bool>, Box<dyn Error>> {
    let partial = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/core-assets/hooks/_partials/copy-dest.sh");
    let script = r#"
payload_field() { printf '%s' "$NV_TEST_CWD"; }
source "$1"
nv_project_dir=$2
nv_owned_paths=$3
while IFS= read -r -d '' live; do
  if navori_copy_dest_safe; then echo safe; else echo unsafe; fi
done
"#;
    let mut child = Command::new("bash")
        .args(["-c", script, "copy-dest"])
        .arg(&partial)
        .args([root, OWNED])
        .env("NV_TEST_CWD", cwd)
        .env("PWD", pwd)
        // bash resets an inherited PWD that does not name its working directory.
        .current_dir(pwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut input = Vec::new();
    for live in lives {
        input.extend_from_slice(live.as_bytes());
        input.push(0);
    }
    child.stdin.take().ok_or("stdin")?.write_all(&input)?;
    let output = child.wait_with_output()?;
    let text = String::from_utf8(output.stdout)?;
    Ok(text.lines().map(|line| line == "safe").collect())
}

fn handwritten() -> Vec<String> {
    [
        "cp a.sh .claude/hooks/guard.sh",
        "cp a.sh .claude/hooks/other.sh",
        "cp a.sh .claude/hooks/",
        "cp guard.sh .claude/hooks",
        "cp -t .claude/hooks guard.sh",
        "cp --target-directory=.claude/hooks guard.sh",
        "cp -rt .claude src",
        "cp -r src .claude",
        "mv .claude/settings.json /tmp/x",
        "mv AGENTS.md agents.bak",
        "install -m 644 a AGENTS.md",
        "install -m644 a AGENTS.md",
        "ln -s ../x AGENTS.md",
        "ln -sf x ./AGENTS.md",
        "cp x ./AGENTS.MD",
        "cp x sub/../AGENTS.md",
        "cp x /tmp/proj/AGENTS.md",
        "cp x /private/tmp/proj/AGENTS.md",
        "cp x \"${CLAUDE_PROJECT_DIR}/AGENTS.md\"",
        "cp x $CLAUDE_PROJECT_DIR/AGENTS.md",
        "cp x \"$(git rev-parse --show-toplevel)/AGENTS.md\"",
        "git mv a AGENTS.md",
        "git -C /tmp/proj mv a AGENTS.md",
        "git -C/tmp mv a proj/AGENTS.md",
        "git -c core.x=1 mv a b",
        "git --no-pager mv a AGENTS.md",
        "git status && cp a AGENTS.md",
        "env FOO=1 cp a AGENTS.md",
        "env -u X cp a AGENTS.md",
        "env -S 'cp a AGENTS.md'",
        "sudo -u me cp a AGENTS.md",
        "command -v cp",
        "command -p cp a AGENTS.md",
        "nohup cp a AGENTS.md",
        "X=1 Y=2 cp a AGENTS.md",
        "cp a b > AGENTS.md",
        "cp a 2>/dev/null AGENTS.md",
        "cp 'a b' AGENTS.md",
        "cp a 'AGENTS.md",
        "cp a \"AGENTS\\.md\"",
        "cp a AGENTS\\.md",
        "# cp a AGENTS.md",
        "echo hi # cp a AGENTS.md",
        "cp --help AGENTS.md",
        "cp -Q a AGENTS.md",
        "cp --weird a AGENTS.md",
        "cp a b c .agents/skills",
        "cp -r .agents/skills/x /tmp/out",
        "mv .agents /tmp/out",
        "cp a .agents/skills/x/",
        "(cp a AGENTS.md)",
        "{ cp a AGENTS.md; }",
        "a | cp b AGENTS.md",
        "x y mv; git --foo",
        "cp a \\\nAGENTS.md",
        "cp a \"multi\nline\" AGENTS.md",
        "cp",
        "cp a",
        "",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// Deterministic token soup: wrappers, verbs, flags, owned and foreign paths, separators.
fn generated(count: usize) -> Vec<String> {
    const VOCAB: &[&str] = &[
        "cp",
        "mv",
        "install",
        "ln",
        "git",
        "mv",
        "env",
        "sudo",
        "command",
        "nohup",
        "-r",
        "-t",
        "-f",
        "-s",
        "--",
        "-m",
        "644",
        "--target-directory=.claude",
        "AGENTS.md",
        "./AGENTS.md",
        ".claude/hooks",
        ".claude/hooks/guard.sh",
        ".claude",
        "src",
        "a",
        "b/",
        "/tmp/proj",
        "/tmp/proj/AGENTS.md",
        "../proj/AGENTS.md",
        "-C",
        "/tmp",
        ";",
        "&&",
        "|",
        ">",
        "2>",
        "'a b'",
        "\"$CLAUDE_PROJECT_DIR\"/AGENTS.md",
        "X=1",
        "#",
        "-u",
        "root",
        ".agents/skills",
    ];
    let mut seed: u64 = 0x5eed_0057;
    let mut next = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) as usize
    };
    (0..count)
        .map(|_| {
            let len = 1 + next() % 7;
            (0..len)
                .map(|_| VOCAB[next() % VOCAB.len()])
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

// Covers: R11
#[test]
fn copy_dest_matches_the_shell_partial_for_handwritten_and_generated_commands() -> TestResult {
    let mut lives = handwritten();
    lives.extend(generated(500));
    // An empty root falls back to PWD: run that shell in a real directory, named the way bash
    // names it (its physical path, which on macOS sits under /private/var).
    let scratch = std::env::temp_dir().join(format!("navori-copy-dest-{}", std::process::id()));
    std::fs::create_dir_all(&scratch)?;
    let scratch = std::fs::canonicalize(&scratch)?;
    let scratch = scratch.to_str().ok_or("utf-8 scratch")?.to_owned();
    let here = std::env::current_dir()?;
    let here = here.to_str().ok_or("utf-8 cwd")?.to_owned();
    let configurations = [
        ("/tmp/proj", "/tmp/proj", here.as_str()),
        ("/private/tmp/proj", "/tmp/proj/sub", here.as_str()),
        ("", "", scratch.as_str()),
    ];
    for (root, cwd, pwd) in configurations {
        let expected = shell_verdicts(root, cwd, pwd, &lives)?;
        assert_eq!(expected.len(), lives.len(), "one shell verdict per case");
        let inputs = Inputs {
            root,
            cwd,
            pwd,
            owned: OWNED,
        };
        let mismatches: Vec<String> = lives
            .iter()
            .zip(&expected)
            .filter(|(live, shell)| safe(live, &inputs) != **shell)
            .map(|(live, shell)| format!("{root}|{cwd}: shell safe={shell}: {live:?}"))
            .collect();
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
        assert!(
            expected.iter().any(|s| !s),
            "the battery must exercise blocks"
        );
    }
    std::fs::remove_dir_all(&scratch)?;
    Ok(())
}
