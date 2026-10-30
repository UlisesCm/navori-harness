//! Rule bodies, transcribed from guard-destructive.sh. grep reads one segment per line, so each
//! check runs per line and `$` means the end of that segment.

use std::sync::LazyLock;

use regex::Regex;

use super::copy_dest::{self, Inputs};
use super::discard;
use super::pi;
use super::{Host, Outcome, Rendered, length};
use crate::runner::Engine;
use crate::shell::Locale;
use crate::shell::inert::{self, CMD_MAX, Rules};
use crate::shell::landing::Facts;
use crate::shell::ratchet;
use crate::shell::repo::Repo;

const FAST_MAX: usize = 4096;
const SPLIT_ROUTE: &str = "split it into smaller commands the guard can inspect.";
const GIT_OPTS: &str =
    r"([[:space:]]+-[a-zA-Z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*";
const RM_ARG: &str = r"[^<>&[:space:]]+[[:space:]]+";
const RM_QUOTE: &str = r#"["']?"#;
const MANAGED_DIR: &str =
    r"\.claude/(agents|skills|hooks)|\.agents/skills|\.codex/(agents|hooks)|\.cursor/rules";
const MANAGED_PI: &str = r"|\.pi/extensions/navori\.ts|\.pi/navori\.json|\.pi/navori/[^[:space:];&|]+|\.pi/agents/(scout|implementer|reviewer|scribe|auditor|architect|publisher)\.md";
const MANAGED_REWRITE: &str = "shell rewrite of a navori-managed file \u{2014} edit the source asset and run 'navori render --apply' (or 'navori sync'); a direct write invalidates the block hash and freezes it. If the target is outside this project (e.g. a scratchpad), write it with '>' or 'tee' and an absolute path instead";

/// `managed_path` for one engine: Pi adds the exact names Navori writes under `.pi/`.
fn managed_path(pi: bool) -> String {
    let extra = if pi { MANAGED_PI } else { "" };
    format!(
        r"(CLAUDE\.md|AGENTS\.md|\.claude/settings\.json|\.codex/config\.toml|({MANAGED_DIR})/[^[:space:];&|]+{extra})"
    )
}

/// Rule 6: `>`/`>|` redirects over `scan`, `sed -i` and `tee` over segments, case-insensitive.
struct Managed {
    redirect: Regex,
    sed: Regex,
    tee: Regex,
}

impl Managed {
    fn new(locale: Locale, pi: bool) -> Result<Self, regex::Error> {
        let path = managed_path(pi);
        Ok(Self {
            redirect: locale.ere(&format!(
                r"(?i)(^|[^>])>\|?[[:space:]]*(\./)?{path}([[:space:]]|$)"
            ))?,
            sed: locale.ere(&format!(
                r"(?i)(^|[[:space:]])sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[^[:space:]]*|--in-place)([[:space:]]|=).*{path}"
            ))?,
            tee: locale.ere(&format!(
                r"(?i)(^|[[:space:]])tee[[:space:]]+([^-][^[:space:]]*[[:space:]]+)*(\./)?{path}([[:space:]]|$)"
            ))?,
        })
    }
}

struct Patterns {
    no_verify: Regex,
    no_verify_short: Regex,
    commit: Regex,
    push_segment: Regex,
    push_force: Regex,
    recursive: Regex,
    force: Regex,
    dir: Regex,
    git_rm_cached: Regex,
    rm_root: Regex,
    rm_var: Regex,
    rm_var_post: Regex,
    no_preserve_root: Regex,
    fork_bomb: Regex,
    block_device: Regex,
    managed: Managed,
    managed_pi: Managed,
    pi: pi::Patterns,
    discard: Regex,
    trigger: Regex,
}

impl Patterns {
    fn new(locale: Locale) -> Result<Self, regex::Error> {
        let re = |pattern: &str| locale.ere(pattern);
        let git_cp = format!(r"(^|[[:space:]]|[;&|])git{GIT_OPTS}[[:space:]]+");
        let git_opt = r"-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?";
        let rm_kill = r"-[a-zA-Z]*[rRf][a-zA-Z]*[[:space:]]+";
        let rm_rec = r"-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+";
        let rm_run = format!(r"(^|[[:space:]])rm[[:space:]]+({RM_ARG})*{rm_kill}({RM_ARG})*");
        let rm_run_rec = format!(r"(^|[[:space:]])rm[[:space:]]+({RM_ARG})*{rm_rec}({RM_ARG})*");
        let rm_home = r"~(/[^[:space:]/]*)?|/(Users|home)(/[^[:space:]/]+(/[^[:space:]/]*)?)?";
        let rm_root = r"/\*?|/(Applications|Library|System|Volumes|bin|boot|dev|etc|lib|lib64|mnt|opt|root|sbin|srv|sys|usr|var)(/[^[:space:]/]*)?";
        let rm_tmp = r"/private(/tmp)?|/tmp";
        let rm_end = format!(r"/?{RM_QUOTE}([[:space:]]|$)");
        Ok(Self {
            no_verify: re(&format!(r"{git_cp}(commit|push).*--no-verify"))?,
            no_verify_short: re(&format!(
                r"{git_cp}(commit|push).*[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)"
            ))?,
            commit: re(&format!(r"{git_cp}commit([[:space:]]|$)"))?,
            push_segment: re(&format!(r"^git{GIT_OPTS}[[:space:]]+push([[:space:]]|$)"))?,
            push_force: re(
                r"(--force([[:space:]]|$)|[[:space:]]-f([[:space:]]|$)|[[:space:]]\+[^[:space:]])",
            )?,
            recursive: re(r"(^|[[:space:]])--recursive([[:space:]]|$)")?,
            force: re(r"(^|[[:space:]])--force([[:space:]]|$)")?,
            dir: re(r"(^|[[:space:]])--dir([[:space:]]|$)")?,
            git_rm_cached: re(&format!(
                r"(^|[[:space:]])git([[:space:]]+({git_opt})*)rm([[:space:]])"
            ))?,
            rm_root: re(&format!(
                r"{rm_run}{RM_QUOTE}(({rm_home}|{rm_root}|{rm_tmp}){rm_end})"
            ))?,
            rm_var: re(&format!(r"{rm_run_rec}{RM_QUOTE}\$"))?,
            rm_var_post: re(&format!(
                r"(^|[[:space:]])rm[[:space:]]+({RM_ARG})*{RM_QUOTE}\$[^<>&[:space:]]*[[:space:]]+({RM_ARG})*-[a-zA-Z]*[rR][a-zA-Z]*([[:space:]]|$)"
            ))?,
            no_preserve_root: re(&format!(
                r"(^|[[:space:]])rm[[:space:]](.*[[:space:]])?{RM_QUOTE}--no-preserve-root{RM_QUOTE}([[:space:]]|$)"
            ))?,
            fork_bomb: re(r":\(\)[[:space:]]*\{[[:space:]]*:\|:")?,
            block_device: re(r"(of=/dev/(sd|nvme|disk|hd)|>[[:space:]]*/dev/(sd|nvme|disk|hd))")?,
            managed: Managed::new(locale, false)?,
            managed_pi: Managed::new(locale, true)?,
            pi: pi::Patterns::new(locale)?,
            discard: re(
                r"^git[[:space:]]+(.*[[:space:]])?(reset|checkout|restore|clean)([[:space:]]|$)",
            )?,
            trigger: re(&format!(r"^git{GIT_OPTS}[[:space:]]+commit([[:space:]]|$)"))?,
        })
    }

    fn get(locale: Locale) -> Result<&'static Self, String> {
        static UTF8: LazyLock<Result<Patterns, regex::Error>> =
            LazyLock::new(|| Patterns::new(Locale::Utf8));
        static GNU_UTF8: LazyLock<Result<Patterns, regex::Error>> =
            LazyLock::new(|| Patterns::new(Locale::GnuUtf8));
        static C: LazyLock<Result<Patterns, regex::Error>> =
            LazyLock::new(|| Patterns::new(Locale::C));
        match locale {
            Locale::Utf8 => &UTF8,
            Locale::GnuUtf8 => &GNU_UTF8,
            Locale::C => &C,
        }
        .as_ref()
        .map_err(|e| format!("guard-destructive pattern: {e}"))
    }
}

fn any(lines: &[String], re: &Regex) -> bool {
    lines.iter().any(|line| re.is_match(line))
}

fn block(message: impl Into<String>, reason: &'static str, route: Option<&'static str>) -> Outcome {
    Outcome::Block {
        message: message.into(),
        reason,
        route,
    }
}

/// Lowercase as `tr '[:upper:]' '[:lower:]'` does in the shell's locale.
fn lowercase(text: &str, locale: Locale) -> String {
    match locale {
        Locale::C => text.to_ascii_lowercase(),
        Locale::Utf8 | Locale::GnuUtf8 => text.chars().flat_map(char::to_lowercase).collect(),
    }
}

/// `nv_pi_candidate`: a Pi copy keeps the full analysis for control-plane paths, the `pi` word
/// and the first token of every shared permission rule.
fn pi_candidate(fast: &str, rendered: &Rendered, engine: Engine, locale: Locale) -> bool {
    if engine != Engine::Pi {
        return false;
    }
    let lc = lowercase(fast, locale);
    if lc.contains(".pi") || lc.contains("extensions") || lc.contains("pi ") || lc.ends_with("pi") {
        return true;
    }
    if rendered.pi_rules == "-" {
        return false;
    }
    // `read -r` over a here-string: every line, the last one without its newline.
    rendered.pi_rules.split('\n').any(|rule| {
        let token = rule.strip_prefix("deny ").unwrap_or(rule);
        let token = token.strip_prefix("ask ").unwrap_or(token);
        let token = token.split(' ').next().unwrap_or("");
        !token.is_empty() && lc.contains(token)
    })
}

/// `*cp[[:space:]]*` and friends: the verb followed by a space-class character.
fn verb_then_space(text: &str, verb: &str, locale: Locale) -> bool {
    text.match_indices(verb).any(|(at, _)| {
        text[at + verb.len()..]
            .chars()
            .next()
            .is_some_and(|c| locale.whitespace(c))
    })
}

pub(super) fn evaluate(
    cmd: &str,
    rendered: &Rendered,
    engine: Engine,
    host: &Host,
    repo: &dyn Repo,
    locale: Locale,
) -> Result<Outcome, String> {
    if cmd.is_empty() {
        return Ok(Outcome::Skip {
            reason: "sin comando que inspeccionar",
        });
    }
    let rules = Rules::get(locale)?;
    let patterns = Patterns::get(locale)?;
    let size = length(cmd, locale);
    if size > CMD_MAX {
        return Ok(block(
            format!(
                "command too large to inspect ({size} chars > {CMD_MAX}) — nothing in it was evaluated"
            ),
            "oversize",
            Some(SPLIT_ROUTE),
        ));
    }
    let skeleton = match inert::skeleton(cmd, rules) {
        Ok(skeleton) => skeleton,
        Err(message) => return Ok(block(message, "oversize", Some(SPLIT_ROUTE))),
    };
    let mut copy_only = false;
    if size <= FAST_MAX {
        let fast: String = cmd
            .chars()
            .filter(|c| !matches!(c, '\'' | '"' | '\\' | '\n'))
            .collect();
        let tokens = [
            "commit", "push", "rm", "sed", "tee", "/dev/", ">", ":(", "reset", "clean", "restore",
            "checkout",
        ];
        let searched = fast.contains("grep") || fast.contains("rg ") || fast.ends_with("rg");
        if !tokens.iter().any(|token| fast.contains(token)) && !searched {
            let copies = ["cp", "mv", "install", "ln"]
                .iter()
                .any(|verb| verb_then_space(&fast, verb, locale));
            if !pi_candidate(&fast, rendered, engine, locale) {
                if copies {
                    copy_only = true;
                } else {
                    return Ok(Outcome::Skip {
                        reason: "no rule token in the command",
                    });
                }
            }
        }
    }
    let live = inert::live(cmd, &skeleton, rules);
    let scan = inert::scan(&live, rules);
    let segments = inert::segments(&scan, rules);
    let unquoted: Vec<String> = segments.iter().map(|s| rules.remove_quotes(s)).collect();

    // 1. Skipping hooks/gates.
    if any(&segments, &patterns.no_verify) || any(&unquoted, &patterns.no_verify_short) {
        return Ok(block(
            "git commit/push with --no-verify (skipping hooks/gates)",
            "no-verify",
            Some("commit without --no-verify and fix what the hook reports."),
        ));
    }
    // 1b. The progress ratchet on a commit that does not provably land in another repository,
    // measured from the tree being committed.
    if rendered.progress_lane == "1" && any(&segments, &patterns.commit) {
        let facts = Facts::new(host, repo, locale, &patterns.trigger);
        if !facts.foreign(cmd)? {
            let root = facts.worktree(cmd);
            let dir = match (root.as_str(), host.project_dir.as_str()) {
                ("", "") => ".",
                ("", project) => project,
                (root, _) => root,
            };
            if !repo.is_dir(dir) {
                return Err(format!("progress lane cannot enter {dir}"));
            }
            let cap = rendered
                .progress_cap
                .as_deref()
                .ok_or("progress lane enabled without the progress-ratchet partial")?;
            if let Some(stderr) = ratchet::lane(dir, cap, repo)? {
                return Ok(Outcome::Ratchet { stderr });
            }
        }
    }
    // 2. Force-push to the base branch; the three checks read the push segments as one text.
    let pushes: Vec<String> = segments
        .iter()
        .filter(|s| patterns.push_segment.is_match(s))
        .cloned()
        .collect();
    if !pushes.is_empty()
        && any(&pushes, &patterns.push_force)
        && !pushes.iter().any(|s| s.contains("force-with-lease"))
    {
        // `${base}` is spliced into the ERE. A base that is not a valid ERE makes grep fail,
        // which the `&&` chain reads as no match (BSD grep; the corpus was captured there).
        if let Ok(base) = locale.ere(&format!(
            r"(^|[[:space:]+/]){}([[:space:]]|$)",
            rendered.base
        )) && any(&pushes, &base)
        {
            return Ok(block(
                format!("force-push to the base branch '{}'", rendered.base),
                "force-push-base",
                Some("push a feature branch, or use --force-with-lease on it."),
            ));
        }
    }
    // 3. Recursive rm, flags normalized and `git rm --cached` exempted.
    let rm_segments: Vec<String> = segments
        .iter()
        .map(|segment| {
            let s = patterns.recursive.replace_all(segment, "${1}-r${2}");
            let s = patterns.force.replace_all(&s, "${1}-f${2}");
            let s = patterns.dir.replace_all(&s, "${1}-d${2}");
            if s.contains("--cached") {
                patterns
                    .git_rm_cached
                    .replace_all(&s, "${1}git${2}git-rm${4}")
                    .into_owned()
            } else {
                s.into_owned()
            }
        })
        .collect();
    if any(&rm_segments, &patterns.rm_root) {
        return Ok(block(
            "recursive rm over root / home / system / scratch root",
            "rm-root",
            None,
        ));
    }
    if any(&rm_segments, &patterns.rm_var) || any(&rm_segments, &patterns.rm_var_post) {
        return Ok(block(
            "recursive rm over a variable",
            "rm-var",
            Some(
                "the variable cannot be inspected; resolve it first and re-issue the delete as 'rm -rf <absolute path>' with the literal absolute path — the host then asks the user to confirm that exact command.",
            ),
        ));
    }
    // 3b. `--no-preserve-root` in an rm segment.
    if any(&segments, &patterns.no_preserve_root) {
        return Ok(block(
            "rm --no-preserve-root (disarms rm's own root protection)",
            "no-preserve-root",
            None,
        ));
    }
    // 4-5. Fork bomb and raw block-device writes read `live`.
    let live_lines: Vec<String> = live.split('\n').map(str::to_owned).collect();
    if any(&live_lines, &patterns.fork_bomb) {
        return Ok(block("fork bomb", "fork-bomb", None));
    }
    if any(&live_lines, &patterns.block_device) {
        return Ok(block(
            "direct write to a block device",
            "block-device",
            None,
        ));
    }
    // 6. Shell rewrites of a bare or `./`-relative managed path. `scan` keeps `>|` whole.
    let scan_lines: Vec<String> = scan.split('\n').map(str::to_owned).collect();
    let managed = if engine == Engine::Pi {
        &patterns.managed_pi
    } else {
        &patterns.managed
    };
    if any(&scan_lines, &managed.redirect)
        || any(&segments, &managed.sed)
        || any(&segments, &managed.tee)
    {
        return Ok(block(MANAGED_REWRITE, "managed-rewrite", None));
    }
    // 6b. The same targets spelled with this project's absolute prefix, literal or unresolved.
    if !host.project_dir.is_empty() {
        let project = host
            .project_dir
            .strip_suffix('/')
            .unwrap_or(&host.project_dir);
        let unresolved = if engine == Engine::Codex {
            r"\$\(git rev-parse --show-toplevel\)"
        } else {
            r"\$\{?CLAUDE_PROJECT_DIR\}?"
        };
        let absolute = format!(
            r#"["']?({}|{unresolved})["']?/{}["']?"#,
            regex::escape(project),
            managed_path(engine == Engine::Pi)
        );
        let compile = |pattern: String| {
            locale
                .ere(&pattern)
                .map_err(|e| format!("guard-destructive pattern: {e}"))
        };
        let redirect = compile(format!(
            r"(?i)(^|[^>])>\|?[[:space:]]*{absolute}([[:space:]]|$)"
        ))?;
        let tee = compile(format!(
            r"(?i)(^|[[:space:]])tee[[:space:]]+([^-][^[:space:]]*[[:space:]]+)*{absolute}([[:space:]]|$)"
        ))?;
        if any(&scan_lines, &redirect) || any(&segments, &tee) {
            return Ok(block(MANAGED_REWRITE, "managed-rewrite", None));
        }
    }
    // 6d. Copy/move/install/link onto exact render-owned paths.
    let inputs = Inputs {
        root: &host.project_dir,
        cwd: &host.cwd,
        pwd: &host.pwd,
        owned: &rendered.owned_paths,
    };
    if rendered.owned_paths != "-" && !copy_dest::safe(&live, &inputs) {
        return Ok(block(
            MANAGED_REWRITE,
            "managed-rewrite",
            Some("navori render --apply"),
        ));
    }
    // 6c. The Pi arm.
    let mut ask = None;
    if engine == Engine::Pi {
        match pi::evaluate(&segments, &scan_lines, &rendered.pi_rules, &patterns.pi) {
            pi::Verdict::Block {
                message,
                reason,
                route,
            } => return Ok(block(message, reason, route)),
            pi::Verdict::Pass(found) => ask = found,
        }
    }
    // 7. Whole-tree discards, decided by the target repository's state.
    if let Some(found) = discard::evaluate(&segments, &patterns.discard, host, repo, locale) {
        return Ok(block(found.message, found.reason, Some(found.route)));
    }
    Ok(Outcome::Allow { copy_only, ask })
}
