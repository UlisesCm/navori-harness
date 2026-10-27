//! `navori_copy_dest_safe` (`_partials/copy-dest.sh`): exact render-owned copy/move/install/link
//! destinations. A byte-wise (`LC_ALL=C`) transcription of the partial's awk program, including
//! its quirks: tokens of an earlier segment stay readable past the current count, and paths are
//! normalized lexically with no filesystem access.

use std::collections::HashSet;

const PROJECT_BRACED: &[u8] = b"${CLAUDE_PROJECT_DIR}";
const PROJECT_PLAIN: &[u8] = b"$CLAUDE_PROJECT_DIR";
const TOPLEVEL: &[u8] = b"$(git rev-parse --show-toplevel)";

/// Inputs the partial reads from its environment.
pub struct Inputs<'a> {
    /// `NV_COPY_ROOT` — `nv_project_dir`; empty falls back to `pwd`.
    pub root: &'a str,
    /// `NV_COPY_CWD` — the payload's `cwd` field.
    pub cwd: &'a str,
    /// `PWD` of the hook process.
    pub pwd: &'a str,
    /// `NV_COPY_OWNED` — `nv_owned_paths`, newline-separated.
    pub owned: &'a str,
}

fn starts_with(p: &[u8], prefix: &[u8]) -> bool {
    p.len() >= prefix.len() && &p[..prefix.len()] == prefix
}

fn digits(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().all(u8::is_ascii_digit)
}

/// `base(p)`: last `/` component after trailing slashes are dropped.
fn base(p: &[u8]) -> Vec<u8> {
    let mut end = p.len();
    while end > 0 && p[end - 1] == b'/' {
        end -= 1;
    }
    let p = &p[..end];
    if p.is_empty() {
        return Vec::new();
    }
    p.rsplit(|b| *b == b'/').next().unwrap_or_default().to_vec()
}

struct Program {
    root: Vec<u8>,
    cwd: Vec<u8>,
    windows: bool,
    files: HashSet<Vec<u8>>,
    dirs: HashSet<Vec<u8>>,
    // awk arrays keep their entries: a shorter segment can still read an older token.
    tok: Vec<Vec<u8>>,
    nt: usize,
    args: Vec<Vec<u8>>,
    buf: Vec<u8>,
    have: bool,
    bad: bool,
}

impl Program {
    fn slashes(&self, p: &[u8]) -> Vec<u8> {
        if self.windows {
            p.iter()
                .map(|b| if *b == b'\\' { b'/' } else { *b })
                .collect()
        } else {
            p.to_vec()
        }
    }

    fn norm(&self, p: &[u8], context: &[u8]) -> Vec<u8> {
        let mut p = self.slashes(p);
        for (prefix, skip) in [
            (PROJECT_BRACED, PROJECT_BRACED.len()),
            (PROJECT_PLAIN, PROJECT_PLAIN.len()),
            (TOPLEVEL, TOPLEVEL.len()),
        ] {
            if starts_with(&p, prefix) {
                p = [self.root.as_slice(), &p[skip..]].concat();
                break;
            }
        }
        let drive = p.len() >= 3 && p[0].is_ascii_alphabetic() && p[1] == b':' && p[2] == b'/';
        if !(p.first() == Some(&b'/') || drive) {
            let context = if context.is_empty() {
                &self.cwd
            } else {
                context
            };
            p = [context, b"/".as_slice(), &p].concat();
        }
        let under = |p: &[u8], dirs: &[&[u8]]| {
            dirs.iter()
                .any(|d| starts_with(p, d) && (p.len() == d.len() || p[d.len()] == b'/'))
        };
        if under(&self.root, &[b"/private/var", b"/private/tmp"]) && under(&p, &[b"/var", b"/tmp"])
        {
            p = [b"/private".as_slice(), &p].concat();
        }
        let mut parts: Vec<&[u8]> = Vec::new();
        for part in p.split(|b| *b == b'/') {
            match part {
                b"" | b"." => {}
                b".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        let mut out = Vec::new();
        for part in parts {
            out.push(b'/');
            out.extend_from_slice(part);
        }
        if out.is_empty() {
            out.push(b'/');
        }
        out.to_ascii_lowercase()
    }

    fn owned(&self, p: &[u8], tree: bool) -> bool {
        self.files.contains(p) || (tree && self.dirs.contains(p))
    }

    fn token(&self, i: usize) -> &[u8] {
        self.tok
            .get(i.wrapping_sub(1))
            .map_or(&[][..], Vec::as_slice)
    }

    fn word(&mut self) {
        if self.have {
            self.nt += 1;
            let buf = std::mem::take(&mut self.buf);
            if self.tok.len() < self.nt {
                self.tok.push(buf);
            } else {
                self.tok[self.nt - 1] = buf;
            }
        }
        self.buf.clear();
        self.have = false;
    }

    fn segment(&mut self) {
        self.word();
        self.check();
        self.nt = 0;
    }

    fn copy_word(token: &[u8]) -> bool {
        // /(^|[ \t\/])(cp|mv|install|ln)([ \t]|$)/
        for verb in [&b"cp"[..], b"mv", b"install", b"ln"] {
            for at in 0..token.len() {
                if token[at..].starts_with(verb)
                    && (at == 0 || matches!(token[at - 1], b' ' | b'\t' | b'/'))
                    && token
                        .get(at + verb.len())
                        .is_none_or(|b| matches!(b, b' ' | b'\t'))
                {
                    return true;
                }
            }
        }
        false
    }

    fn assignment(token: &[u8]) -> bool {
        let Some(eq) = token.iter().position(|b| *b == b'=') else {
            return false;
        };
        let name = &token[..eq];
        !name.is_empty()
            && (name[0].is_ascii_alphabetic() || name[0] == b'_')
            && name.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one transcription of the partial's check()"
    )]
    fn check(&mut self) {
        if self.nt == 0 {
            return;
        }
        let nt = self.nt;
        let mut i = 1;
        let mut context = self.cwd.clone();
        while i <= nt {
            if Self::assignment(self.token(i)) {
                i += 1;
                continue;
            }
            let wrapper = base(self.token(i));
            if !matches!(wrapper.as_slice(), b"command" | b"env" | b"nohup" | b"sudo") {
                break;
            }
            i += 1;
            while i <= nt && self.token(i).first() == Some(&b'-') {
                let x = self.token(i).to_vec();
                i += 1;
                if x == b"--" {
                    break;
                }
                let w = wrapper.as_slice();
                if w == b"command" && x == b"-p" {
                    continue;
                }
                if w == b"command" && matches!(x.as_slice(), b"-v" | b"-V" | b"--help") {
                    return;
                }
                if w == b"env" && matches!(x.as_slice(), b"-i" | b"--ignore-environment") {
                    continue;
                }
                if (w == b"env" && matches!(x.as_slice(), b"-u" | b"--unset"))
                    || (w == b"sudo" && matches!(x.as_slice(), b"-u" | b"-g"))
                {
                    if i > nt {
                        self.bad = true;
                        return;
                    }
                    i += 1;
                    continue;
                }
                if w == b"env" && x.starts_with(b"--unset=") && x.len() > 8 {
                    continue;
                }
                if (i..=nt).any(|j| Self::copy_word(self.token(j))) {
                    self.bad = true;
                }
                return;
            }
        }
        let mut v = base(self.token(i));
        i += 1;
        if v == b"git" {
            let mut uncertain = false;
            while i <= nt && self.token(i).first() == Some(&b'-') {
                let x = self.token(i).to_vec();
                i += 1;
                if x == b"--" {
                    break;
                }
                if matches!(
                    x.as_slice(),
                    b"--no-pager" | b"--paginate" | b"--literal-pathspecs"
                ) {
                    continue;
                }
                if x == b"-C" {
                    if i > nt {
                        self.bad = true;
                        return;
                    }
                    if !self.token(i).is_empty() {
                        context = self.norm(self.token(i), &context);
                    }
                    i += 1;
                    continue;
                }
                if x.len() > 2 && x.starts_with(b"-C") {
                    context = self.norm(&x[2..], &context);
                    continue;
                }
                if matches!(
                    x.as_slice(),
                    b"-c"
                        | b"--config-env"
                        | b"--git-dir"
                        | b"--work-tree"
                        | b"--namespace"
                        | b"--super-prefix"
                ) {
                    if i > nt {
                        self.bad = true;
                        return;
                    }
                    i += 1;
                    uncertain = true;
                    continue;
                }
                uncertain = true;
            }
            if uncertain {
                if self.token(i) == b"mv" {
                    self.bad = true;
                }
                return;
            }
            if self.token(i) != b"mv" {
                return;
            }
            v = b"mv".to_vec();
            i += 1;
        }
        if !matches!(v.as_slice(), b"cp" | b"mv" | b"install" | b"ln") {
            return;
        }
        let install = v == b"install";
        let moving = v == b"mv";
        let mut argc = 0;
        let mut target: Vec<u8> = Vec::new();
        let mut recursive = false;
        let mut noopts = false;
        while i <= nt {
            let x = self.token(i).to_vec();
            if !noopts && x == b"--" {
                noopts = true;
                i += 1;
                continue;
            }
            if !noopts && matches!(x.as_slice(), b"--help" | b"--version") {
                return;
            }
            if !noopts && matches!(x.as_slice(), b"-t" | b"--target-directory") {
                i += 1;
                if i > nt {
                    self.bad = true;
                    return;
                }
                target = self.token(i).to_vec();
                i += 1;
                continue;
            }
            if !noopts && x.starts_with(b"--target-directory=") {
                target = x[19..].to_vec();
                i += 1;
                continue;
            }
            if !noopts && x.len() > 2 && x.starts_with(b"-t") {
                target = x[2..].to_vec();
                i += 1;
                continue;
            }
            if !noopts
                && install
                && matches!(
                    x.as_slice(),
                    b"-m" | b"-o" | b"-g" | b"--mode" | b"--owner" | b"--group"
                )
            {
                i += 1;
                if i > nt {
                    self.bad = true;
                    return;
                }
                i += 1;
                continue;
            }
            if !noopts && x.first() == Some(&b'-') {
                // awk: `a ~ r1 || a ~ r2 && install` binds as `a ~ r1 || (a ~ r2 && install)`.
                if x.starts_with(b"--mode=")
                    || x.starts_with(b"--owner=")
                    || x.starts_with(b"--group=")
                    || (install && x.len() > 2 && matches!(x[1], b'm' | b'o' | b'g'))
                {
                    i += 1;
                    continue;
                }
                if x.len() > 1 && x[1].is_ascii_alphabetic() {
                    let mut k = 1;
                    while k < x.len() {
                        let c = x[k];
                        if c == b't' {
                            target = x[k + 1..].to_vec();
                            if target.is_empty() {
                                i += 1;
                                if i > nt {
                                    self.bad = true;
                                    return;
                                }
                                target = self.token(i).to_vec();
                            }
                            break;
                        }
                        if !b"fivnsrRaPTdHLPpuvx".contains(&c) {
                            self.bad = true;
                            return;
                        }
                        if matches!(c, b'r' | b'R' | b'a') {
                            recursive = true;
                        }
                        k += 1;
                    }
                    i += 1;
                    continue;
                }
                if matches!(
                    x.as_slice(),
                    b"--force"
                        | b"--recursive"
                        | b"--archive"
                        | b"--no-target-directory"
                        | b"--symbolic"
                        | b"--verbose"
                        | b"--remove-destination"
                        | b"--preserve"
                        | b"--no-clobber"
                ) {
                    if matches!(x.as_slice(), b"--recursive" | b"--archive") {
                        recursive = true;
                    }
                    i += 1;
                    continue;
                }
                self.bad = true;
                return;
            }
            argc += 1;
            if self.args.len() < argc {
                self.args.push(x);
            } else {
                self.args[argc - 1] = x;
            }
            i += 1;
        }
        let dir = if target.is_empty() {
            if argc < 2 {
                return;
            }
            target = self.args[argc - 1].clone();
            argc -= 1;
            target.last() == Some(&b'/') || argc > 1
        } else {
            true
        };
        let d = self.norm(&target, &context);
        if self.owned(&d, false) {
            self.bad = true;
            return;
        }
        let dir = dir || self.owned(&d, true);
        for j in 0..argc {
            let arg = self.args[j].clone();
            let s = self.norm(&arg, &context);
            if moving && self.owned(&s, true) {
                self.bad = true;
                return;
            }
            let inside = [target.as_slice(), b"/", &base(&arg)].concat();
            if dir && self.owned(&self.norm(&inside, &context), true) {
                self.bad = true;
                return;
            }
            if recursive && self.owned(&d, true) {
                self.bad = true;
                return;
            }
        }
    }

    fn line(&mut self, line: &[u8], state: &mut (Option<u8>, bool)) {
        let (quote, escape) = state;
        let len = line.len();
        let mut pos = 0;
        while pos < len {
            let c = line[pos];
            if *escape {
                self.buf.push(c);
                self.have = true;
                *escape = false;
                pos += 1;
                continue;
            }
            if c == b'\\' && *quote != Some(b'\'') {
                if *quote == Some(b'"') && pos + 1 < len && !b"$`\"\\".contains(&line[pos + 1]) {
                    self.buf.push(c);
                    self.have = true;
                    pos += 1;
                    continue;
                }
                *escape = true;
                pos += 1;
                continue;
            }
            if let Some(q) = *quote {
                if c == q {
                    *quote = None;
                } else {
                    self.buf.push(c);
                }
                self.have = true;
                pos += 1;
                continue;
            }
            if c == b'\'' || c == b'"' {
                *quote = Some(c);
                self.have = true;
                pos += 1;
                continue;
            }
            if line[pos..].starts_with(PROJECT_BRACED) {
                self.buf.extend_from_slice(PROJECT_BRACED);
                self.have = true;
                pos += PROJECT_BRACED.len();
                continue;
            }
            if line[pos..].starts_with(TOPLEVEL) {
                self.buf.extend_from_slice(TOPLEVEL);
                self.have = true;
                pos += TOPLEVEL.len();
                continue;
            }
            if c == b'#' && !self.have {
                break;
            }
            if c == b'>' || c == b'<' || (c == b'&' && line.get(pos + 1) == Some(&b'>')) {
                if self.have && digits(&self.buf) {
                    self.buf.clear();
                    self.have = false;
                } else {
                    self.word();
                }
                while pos < len && matches!(line[pos], b'<' | b'>' | b'&' | b'|') {
                    pos += 1;
                }
                while pos < len && matches!(line[pos], b' ' | b'\t') {
                    pos += 1;
                }
                let mut rq: Option<u8> = None;
                while pos < len {
                    let rc = line[pos];
                    if let Some(q) = rq {
                        if rc == q {
                            rq = None;
                        }
                        pos += 1;
                        continue;
                    }
                    if rc == b'\'' || rc == b'"' {
                        rq = Some(rc);
                        pos += 1;
                        continue;
                    }
                    if matches!(rc, b' ' | b'\t' | b';' | b'&' | b'|') {
                        break;
                    }
                    pos += 1;
                }
                if rq.is_some() {
                    self.bad = true;
                }
                continue;
            }
            if matches!(c, b';' | b'&' | b'|' | b'(' | b')' | b'{' | b'}') {
                self.segment();
                pos += 1;
                continue;
            }
            if c == b' ' || c == b'\t' {
                self.word();
                pos += 1;
                continue;
            }
            self.buf.push(c);
            self.have = true;
            pos += 1;
        }
        if *escape {
            *escape = false;
        } else if quote.is_some() {
            self.buf.push(b'\n');
            self.have = true;
        } else {
            self.segment();
        }
    }
}

/// True when no copy/move/install/link writes an exact render-owned path (awk exit 0).
#[must_use]
pub fn safe(live: &str, inputs: &Inputs<'_>) -> bool {
    let mut root = if inputs.root.is_empty() {
        inputs.pwd
    } else {
        inputs.root
    }
    .as_bytes()
    .to_vec();
    let windows = (root.len() >= 2 && root[0].is_ascii_alphabetic() && root[1] == b':')
        || root.starts_with(b"\\\\");
    let mut program = Program {
        root: Vec::new(),
        cwd: Vec::new(),
        windows,
        files: HashSet::new(),
        dirs: HashSet::new(),
        tok: Vec::new(),
        nt: 0,
        args: Vec::new(),
        buf: Vec::new(),
        have: false,
        bad: false,
    };
    root = program.slashes(&root);
    let cwd = program.slashes(inputs.cwd.as_bytes());
    let aliased = [&b"/var"[..], b"/tmp"]
        .iter()
        .any(|d| root.starts_with(d) && (root.len() == d.len() || root[d.len()] == b'/'));
    if aliased {
        root = [b"/private".as_slice(), &root].concat();
    }
    program.cwd = if cwd.is_empty() { root.clone() } else { cwd };
    program.root = root;
    if !inputs.owned.is_empty() {
        for path in inputs.owned.as_bytes().split(|b| *b == b'\n') {
            let joined = [program.root.as_slice(), b"/", path].concat();
            let mut p = program.norm(&joined, b"");
            program.files.insert(p.clone());
            while p != b"/" {
                let cut = p.iter().rposition(|b| *b == b'/').unwrap_or(0);
                p.truncate(cut);
                if p.is_empty() {
                    p.push(b'/');
                }
                program.dirs.insert(p.clone());
            }
        }
    }
    // The heredoc feeds `$live` plus a newline; awk reads one record per line.
    let input = format!("{}\n", live.trim_end_matches('\n'));
    let mut state = (None, false);
    let body = &input.as_bytes()[..input.len() - 1];
    for line in body.split(|b| *b == b'\n') {
        program.line(line, &mut state);
    }
    if state.0.is_some() || state.1 {
        program.bad = true;
    }
    program.segment();
    !program.bad
}
