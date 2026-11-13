//! `navori_copy_dest_safe` (`_partials/copy-dest.sh`): exact render-owned copy/move/install/link
//! destinations. A byte-wise (`LC_ALL=C`) transcription of the partial's awk program (as of dev
//! commit `f7ae33c0`, which reads `"$(...)"` substitutions and exits 3 on unreadable quoting),
//! including its quirks: tokens of an earlier segment stay readable past the current count, the
//! substitution stack and quote state persist across input lines, and paths are normalized
//! lexically with no filesystem access.

use std::collections::HashSet;
use std::rc::Rc;

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

/// The partial's exit status: `exit (bad ? 2 : qbad ? 3 : 0)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyDest {
    /// Exit 0: no copy writes an exact render-owned path.
    Safe,
    /// Exit 2: a confirmed (or unsupported-form) write onto a render-owned path.
    ManagedRewrite,
    /// Exit 3: unreadable quoting, so a write cannot be ruled out.
    Unparsed,
}

/// One parked `"$(` context (awk `subp[sd]`, `sbuf[sd]`, `snt[sd]`, `stok[sd,*]`).
struct Frame {
    subp: usize,
    sbuf: Vec<u8>,
    snt: usize,
    /// Start of this frame's section of `Program::undo`.
    log_start: usize,
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
    tok: Vec<Rc<[u8]>>,
    nt: usize,
    args: Vec<Vec<u8>>,
    buf: Vec<u8>,
    have: bool,
    bad: bool,
    qbad: bool,
    quote: Option<u8>,
    escape: bool,
    // Lives across records, like the awk's `sd`/`subp`/`sbuf`/`snt`/`stok` globals.
    stack: Vec<Frame>,
    // Copy-on-write undo log: `(slot, previous value)` for every slot overwritten while a frame is
    // open, so `enter` is O(1) and `leave` restores only what the interior clobbered.
    undo: Vec<(usize, Rc<[u8]>)>,
    // Scratch for deduping `undo` on `leave` (slot -> epoch last seen).
    stamp: Vec<u64>,
    epoch: u64,
    // Test-only reference: the original full-copy enter/leave, compared against `tok`.
    #[cfg(test)]
    ref_tok: Vec<Rc<[u8]>>,
    #[cfg(test)]
    ref_stack: Vec<Vec<Rc<[u8]>>>,
    #[cfg(test)]
    leaves: usize,
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
        self.tok.get(i.wrapping_sub(1)).map_or(&[][..], |t| &**t)
    }

    fn word(&mut self) {
        if self.have {
            self.nt += 1;
            let buf: Rc<[u8]> = Rc::from(std::mem::take(&mut self.buf));
            #[cfg(test)]
            {
                if self.ref_tok.len() < self.nt {
                    self.ref_tok.push(buf.clone());
                } else {
                    self.ref_tok[self.nt - 1] = buf.clone();
                }
            }
            if self.tok.len() < self.nt {
                self.tok.push(buf);
            } else {
                // A slot past `tok.len()` is past every parked `snt`, so only existing slots need
                // an undo entry.
                if !self.stack.is_empty() {
                    self.undo.push((self.nt, Rc::clone(&self.tok[self.nt - 1])));
                }
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

    /// awk `enter(text)`: park the outer word and its tokens for a `"$(` substitution.
    fn enter(&mut self, text: Vec<u8>) {
        #[cfg(test)]
        self.ref_stack.push(self.ref_tok[..self.nt].to_vec());
        self.stack.push(Frame {
            subp: 0,
            sbuf: text,
            snt: self.nt,
            log_start: self.undo.len(),
        });
        self.buf.clear();
        self.have = false;
        self.nt = 0;
    }

    /// awk `leave()`: restore the parked tokens (only `tok[..snt]`; later entries persist).
    fn leave(&mut self) {
        let Some(frame) = self.stack.pop() else {
            return;
        };
        self.nt = frame.snt;
        // Oldest entry per slot wins; the same pass dedupes what an enclosing frame will need.
        let range = self.undo.split_off(frame.log_start);
        self.epoch += 1;
        let mut kept = Vec::new();
        for (slot, old) in range {
            if self.stamp.len() < slot {
                self.stamp.resize(slot, 0);
            }
            if self.stamp[slot - 1] == self.epoch {
                continue;
            }
            self.stamp[slot - 1] = self.epoch;
            if slot <= frame.snt {
                self.tok[slot - 1] = Rc::clone(&old);
            }
            kept.push((slot, old));
        }
        if !self.stack.is_empty() {
            self.undo.extend(kept);
        }
        self.buf = frame.sbuf;
        self.have = true;
        #[cfg(test)]
        {
            let saved = self.ref_stack.pop().unwrap_or_default();
            for (slot, value) in self.ref_tok.iter_mut().zip(saved) {
                *slot = value;
            }
            self.leaves += 1;
            assert_eq!(self.tok, self.ref_tok, "tok diverged after leave");
        }
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
        #[cfg(test)]
        assert_eq!(self.tok, self.ref_tok, "tok diverged before check");
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

    #[allow(
        clippy::too_many_lines,
        reason = "one transcription of the partial's per-record loop"
    )]
    fn line(&mut self, line: &[u8]) {
        let len = line.len();
        let mut pos = 0;
        while pos < len {
            let c = line[pos];
            if self.escape {
                self.buf.push(c);
                self.have = true;
                self.escape = false;
                pos += 1;
                continue;
            }
            if c == b'\\' && self.quote != Some(b'\'') {
                if self.quote == Some(b'"') && pos + 1 < len && !b"$`\"\\".contains(&line[pos + 1])
                {
                    self.buf.push(c);
                    self.have = true;
                    pos += 1;
                    continue;
                }
                self.escape = true;
                pos += 1;
                continue;
            }
            if self.quote == Some(b'"') && line[pos..].starts_with(TOPLEVEL) {
                self.buf.extend_from_slice(TOPLEVEL);
                self.have = true;
                pos += TOPLEVEL.len();
                continue;
            }
            if self.quote == Some(b'"') && c == b'$' && line.get(pos + 1) == Some(&b'(') {
                let text = [self.buf.as_slice(), b"$("].concat();
                self.enter(text);
                self.quote = None;
                pos += 2;
                continue;
            }
            if let Some(q) = self.quote {
                if c == q {
                    self.quote = None;
                } else {
                    self.buf.push(c);
                }
                self.have = true;
                pos += 1;
                continue;
            }
            if !self.stack.is_empty() {
                // A heredoc body is free text: back to the outer double quote. Only one `<` is
                // consumed; the second is read inside the quote.
                if c == b'<' && line.get(pos + 1) == Some(&b'<') {
                    self.segment();
                    while !self.stack.is_empty() {
                        self.leave();
                    }
                    self.quote = Some(b'"');
                    self.buf.push(c);
                    self.have = true;
                    pos += 1;
                    continue;
                }
                if c == b'(' {
                    // Falls through: `(` still ends a segment below.
                    if let Some(frame) = self.stack.last_mut() {
                        frame.subp += 1;
                    }
                } else if c == b')' {
                    match self.stack.last_mut() {
                        // Falls through: `)` still ends a segment below.
                        Some(frame) if frame.subp > 0 => frame.subp -= 1,
                        _ => {
                            self.segment();
                            self.leave();
                            self.quote = Some(b'"');
                            self.buf.push(c);
                            self.have = true;
                            pos += 1;
                            continue;
                        }
                    }
                }
            }
            if c == b'\'' || c == b'"' {
                self.quote = Some(c);
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
                    if matches!(rc, b' ' | b'\t' | b';' | b'&' | b'|')
                        || (!self.stack.is_empty() && rc == b')')
                    {
                        break;
                    }
                    pos += 1;
                }
                if rq.is_some() {
                    self.qbad = true;
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
        // awk: the escape is dropped at the end of a record, so a dangling `\` is exit 0.
        if self.escape {
            self.escape = false;
        } else if self.quote.is_some() {
            self.buf.push(b'\n');
            self.have = true;
        } else {
            self.segment();
        }
    }
}

/// `navori_copy_dest_safe`'s exit status for `live`: `ManagedRewrite` (2) wins over `Unparsed` (3).
#[must_use]
pub fn verdict(live: &str, inputs: &Inputs<'_>) -> CopyDest {
    let program = execute(live, inputs);
    if program.bad {
        CopyDest::ManagedRewrite
    } else if program.qbad {
        CopyDest::Unparsed
    } else {
        CopyDest::Safe
    }
}

fn execute(live: &str, inputs: &Inputs<'_>) -> Program {
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
        qbad: false,
        quote: None,
        escape: false,
        stack: Vec::new(),
        undo: Vec::new(),
        stamp: Vec::new(),
        epoch: 0,
        #[cfg(test)]
        ref_tok: Vec::new(),
        #[cfg(test)]
        ref_stack: Vec::new(),
        #[cfg(test)]
        leaves: 0,
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
    let body = &input.as_bytes()[..input.len() - 1];
    for line in body.split(|b| *b == b'\n') {
        program.line(line);
    }
    if program.quote.is_some() || program.escape || !program.stack.is_empty() {
        program.qbad = true;
    }
    program.segment();
    program
}

#[cfg(test)]
mod tests {
    use super::{CopyDest, Inputs, verdict};

    fn run(live: &str) -> CopyDest {
        verdict(
            live,
            &Inputs {
                root: "/tmp/proj",
                cwd: "/tmp/proj",
                pwd: "/tmp",
                owned: "owned.txt",
            },
        )
    }

    #[test]
    fn a_confirmed_rewrite_wins_over_unreadable_quoting() {
        assert_eq!(run("cp -Q a b \"x"), CopyDest::ManagedRewrite);
        assert_eq!(run("cp a \"x"), CopyDest::Unparsed);
    }

    #[test]
    fn the_substitution_stack_lives_across_lines() {
        assert_eq!(run("echo \"$(cp -Q a b\n)\""), CopyDest::ManagedRewrite);
        assert_eq!(run("echo \"$(echo hi\n"), CopyDest::Unparsed);
    }

    #[test]
    fn a_dangling_escape_is_safe() {
        assert_eq!(run("cp a \\"), CopyDest::Safe);
    }

    /// Deterministic LCG, so the generated commands never depend on the clock.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from((self.0 >> 33) % bound as u64).unwrap_or(0)
        }
    }

    /// The program asserts, after every `leave` and before every `check`, that its copy-on-write
    /// `tok` equals the original full-copy implementation fed the same trace.
    #[test]
    fn copy_on_write_tokens_match_the_full_copy_reference() {
        const FRAGMENTS: &[&str] = &[
            "a",
            "b",
            "cp",
            "mv",
            "-f",
            "x=1",
            "env",
            "-u",
            " ",
            " ",
            " ",
            " ",
            "\t",
            "; ",
            " && ",
            " | ",
            "\n",
            "\"",
            "\"$(",
            "\"$(",
            "\"$(",
            ")",
            ")",
            "\"",
            "'",
            "(",
            "{",
            "}",
            "owned.txt",
            "$CLAUDE_PROJECT_DIR/owned.txt",
            "<<",
            ">",
            "\\",
            "$(git rev-parse --show-toplevel)",
        ];
        let inputs = Inputs {
            root: "/tmp/proj",
            cwd: "/tmp/proj",
            pwd: "/tmp",
            owned: "owned.txt",
        };
        let mut rng = Lcg(0x5EED);
        let mut leaves = 0;
        for case in 0..600 {
            let mut cmd = String::new();
            // Structured cases: words, then nested `"$(` up to four levels with inner segments.
            if case % 2 == 0 {
                let depth = 1 + rng.next(4);
                for _ in 0..rng.next(6) {
                    cmd.push_str("w ");
                }
                for _ in 0..depth {
                    cmd.push_str("\"$(");
                    for _ in 0..rng.next(5) {
                        cmd.push_str(FRAGMENTS[rng.next(FRAGMENTS.len())]);
                        cmd.push('w');
                    }
                }
                for _ in 0..depth {
                    cmd.push_str(")\"");
                    for _ in 0..rng.next(4) {
                        cmd.push_str(" v");
                    }
                }
            } else {
                for _ in 0..(5 + rng.next(40)) {
                    cmd.push_str(FRAGMENTS[rng.next(FRAGMENTS.len())]);
                }
            }
            let program = super::execute(&cmd, &inputs);
            assert_eq!(program.tok, program.ref_tok, "final tok for {cmd:?}");
            leaves += program.leaves;
        }
        assert!(leaves > 500, "generator must exercise leave(): {leaves}");
    }
}
