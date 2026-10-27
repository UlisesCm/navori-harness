# Exact render-owned copy/move destinations (spec 0053 R8). No filesystem discovery.
# Parse the live text separately: the legacy segment splitter also splits >& and
# removes parentheses from the trusted, literal git-toplevel prefix.
# One awk pass, bounded by the caller's CMD_MAX; no eval or shell word expansion.
# The awk runs byte-wise (LC_ALL=C): macOS awk aborts on a split multibyte char
# in `~` matching, and shell metacharacters and owned paths are ASCII anyway.
# A newline inside an open quote stays in the word (multi-line -m "$(cat <<EOF)");
# outside quotes it ends the segment; an unclosed quote at the end still fails.
# Heredoc bodies are NOT skipped here: the caller elides the inert ones (and their
# terminator) from the live text, and skipping on that text would hide commands.
# Paths are lexical against the tool cwd. Command-local directory changes,
# dynamic operands and arbitrary filesystem aliases are outside this seatbelt.
navori_copy_dest_safe() {
  LC_ALL=C NV_COPY_ROOT=${nv_project_dir:-} NV_COPY_CWD="$(payload_field cwd)" \
    NV_COPY_OWNED="$nv_owned_paths" awk '
  function slashes(p) { if (windows) gsub(/\\/, "/", p); return p }
  function norm(p, context,    n,a,i,k,out) {
    p = slashes(p)
    if (index(p, "${CLAUDE_PROJECT_DIR}") == 1)
      p = root substr(p, 22)
    else if (index(p, "$CLAUDE_PROJECT_DIR") == 1)
      p = root substr(p, 20)
    else if (index(p, "$(git rev-parse --show-toplevel)") == 1)
      p = root substr(p, 33)
    # Git Bash accepts drive-qualified paths; do not prepend cwd to them.
    if (p !~ /^([A-Za-z]:)?\//) p = (context == "" ? cwd : context) "/" p
    # Pi supplies the physical Git root on macOS, but tool cwd and operands
    # can retain /var or /tmp. Fold only these fixed aliases when the trusted
    # root is under /private; never inspect or expand arbitrary symlinks.
    if (root ~ /^\/private\/(var|tmp)(\/|$)/ && p ~ /^\/(var|tmp)(\/|$)/)
      p = "/private" p
    n = split(p, a, "/"); k = 0
    for (i = 1; i <= n; i++) {
      if (a[i] == "" || a[i] == ".") continue
      if (a[i] == "..") { if (k > 0) k--; continue }
      parts[++k] = a[i]
    }
    out = ""
    for (i = 1; i <= k; i++) out = out "/" parts[i]
    return tolower(out == "" ? "/" : out)
  }
  function owned(p, tree) {
    return (p in files) || (tree && (p in dirs))
  }
  function base(p,    a,n) {
    sub(/\/+$/, "", p); n = split(p, a, "/"); return a[n]
  }
  # Literal wrapper/global options only; unsupported copy contexts fail closed.
  function check(    i,v,argc,target,dir,recursive,noopts,x,s,d,j,move,wrapper,context,uncertain,k,c) {
    if (!nt) return
    i = 1; context = cwd
    while (i <= nt) {
      if (tok[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { i++; continue }
      wrapper = base(tok[i])
      if (wrapper != "command" && wrapper != "env" && wrapper != "nohup" && wrapper != "sudo") break
      i++
      while (i <= nt && tok[i] ~ /^-/) {
        x = tok[i++]
        if (x == "--") break
        if (wrapper == "command" && x == "-p") continue
        if (wrapper == "command" && (x == "-v" || x == "-V" || x == "--help")) return
        if (wrapper == "env" && (x == "-i" || x == "--ignore-environment")) continue
        if ((wrapper == "env" && (x == "-u" || x == "--unset")) || (wrapper == "sudo" && (x == "-u" || x == "-g"))) {
          if (i > nt) { bad = 1; return }
          i++; continue
        }
        if (wrapper == "env" && x ~ /^--unset=./) continue
        # Unknown wrapper options must not turn unrelated read-only commands
        # into managed-file rewrites. A recognizable copy still fails closed,
        # including a literal split-string argument such as env -S.
        for (j = i; j <= nt; j++)
          if (tok[j] ~ /(^|[ \t\/])(cp|mv|install|ln)([ \t]|$)/) { bad = 1; return }
        return
      }
    }
    v = base(tok[i]); i++
    if (v == "git") {
      uncertain = 0
      while (i <= nt && tok[i] ~ /^-/) {
        x = tok[i++]
        if (x == "--") break
        if (x == "--no-pager" || x == "--paginate" || x == "--literal-pathspecs") continue
        if (x == "-C") {
          if (i > nt) { bad = 1; return }
          if (tok[i] != "") context = norm(tok[i],context)
          i++; continue
        }
        if (x ~ /^-C./) { context = norm(substr(x,3),context); continue }
        if (x == "-c" || x == "--config-env" || x == "--git-dir" || x == "--work-tree" || x == "--namespace" || x == "--super-prefix") {
          if (i > nt) { bad = 1; return }
          i++; uncertain = 1; continue
        }
        # Config/work-tree/pathspec options may change operand interpretation.
        # Never discover their effects from the filesystem or execute Git.
        uncertain = 1
      }
      if (uncertain) {
        if (tok[i] == "mv") bad = 1
        return
      }
      if (tok[i] != "mv") return
      v = "mv"; i++
    }
    if (v != "cp" && v != "mv" && v != "install" && v != "ln") return
    move = (v == "mv"); argc = 0; target = ""; recursive = 0; noopts = 0
    for (; i <= nt; i++) {
      x = tok[i]
      if (!noopts && x == "--") { noopts = 1; continue }
      if (!noopts && (x == "--help" || x == "--version")) return
      if (!noopts && (x == "-t" || x == "--target-directory")) {
        if (++i > nt) { bad = 1; return }
        target = tok[i]; continue
      }
      if (!noopts && x ~ /^--target-directory=/) { target = substr(x,20); continue }
      if (!noopts && x ~ /^-t./) { target = substr(x,3); continue }
      if (!noopts && v == "install" && (x == "-m" || x == "-o" || x == "-g" || x == "--mode" || x == "--owner" || x == "--group")) {
        if (++i > nt) { bad = 1; return }; continue
      }
      if (!noopts && x ~ /^-/) {
        if (x ~ /^--(mode|owner|group)=/ || x ~ /^-[mog].+/ && v == "install") continue
        if (x ~ /^-[A-Za-z]/ && x !~ /^--/) {
          # Walk flags in order: t consumes the cluster remainder or next word.
          # Unknown/operand-taking flags cannot silently eat a source or target.
          for (k = 2; k <= length(x); k++) {
            c = substr(x,k,1)
            if (c == "t") {
              target = substr(x,k+1)
              if (target == "") {
                if (++i > nt) { bad = 1; return }
                target = tok[i]
              }
              break
            }
            if (c !~ /^[fivnsrRaPTdHLPpuvx]$/) { bad = 1; return }
            if (c ~ /^[rRa]$/) recursive = 1
          }
          continue
        }
        if (x ~ /^--(force|recursive|archive|no-target-directory|symbolic|verbose|remove-destination|preserve|no-clobber)$/) {
          if (x == "--recursive" || x == "--archive") recursive = 1
          continue
        }
        bad = 1; return
      }
      args[++argc] = x
    }
    if (target == "") {
      if (argc < 2) return
      target = args[argc--]
      dir = (target ~ /\/$/ || argc > 1)
    } else dir = 1
    d = norm(target,context)
    if (owned(d,0)) { bad = 1; return }
    # A directory is inferred only from exact owned descendants, not a glob.
    if (owned(d,1)) dir = 1
    for (j = 1; j <= argc; j++) {
      s = norm(args[j],context)
      if (move && owned(s,1)) { bad = 1; return }
      if (dir && owned(norm(target "/" base(args[j]),context),1)) { bad = 1; return }
      # Contents of a recursive external tree are unknown without FS discovery.
      if (recursive && owned(d,1)) { bad = 1; return }
    }
  }
  function word() { if (have) tok[++nt] = buf; buf = ""; have = 0 }
  function segment() { word(); check(); nt = 0 }
  BEGIN {
    root = ENVIRON["NV_COPY_ROOT"]
    if (root == "") root = ENVIRON["PWD"]
    # Backslashes are separators only for Windows roots; on Unix they may
    # be literal filename characters inside shell quotes.
    windows = (root ~ /^[A-Za-z]:/ || substr(root,1,2) == "\\\\")
    root = slashes(root); cwd = slashes(ENVIRON["NV_COPY_CWD"])
    # Use the same conservative spelling when Claude supplies the lexical root.
    if (root ~ /^\/(var|tmp)(\/|$)/) root = "/private" root
    if (cwd == "") cwd = root
    count = split(ENVIRON["NV_COPY_OWNED"], paths, "\n")
    for (z = 1; z <= count; z++) {
      p = norm(root "/" paths[z]); files[p] = 1
      # Ancestors come only from the trusted exact inventory, never a glob.
      while (p != "/") {
        sub(/\/[^\/]*$/, "", p)
        if (p == "") p = "/"
        dirs[p] = 1
      }
    }
  }
  {
    line = $0
    for (pos = 1; pos <= length(line); pos++) {
      c = substr(line,pos,1)
      if (escape) { buf = buf c; have = 1; escape = 0; continue }
      if (c == "\\" && quote != "\047") {
        # Within double quotes, Bash retains backslashes before ordinary
        # characters (including drive-path components such as C:\repo).
        if (quote == "\042" && pos < length(line) && substr(line,pos+1,1) !~ /[$`"\\]/) {
          buf = buf c; have = 1; continue
        }
        escape = 1; continue
      }
      if (quote != "") {
        if (c == quote) quote = ""
        else buf = buf c
        have = 1; continue
      }
      if (c == "\047" || c == "\042") { quote = c; have = 1; continue }
      if (substr(line,pos,21) == "${CLAUDE_PROJECT_DIR}") {
        buf = buf substr(line,pos,21); have = 1; pos += 20; continue
      }
      # Preserve the one supported literal substitution, without executing it.
      if (substr(line,pos,32) == "$(git rev-parse --show-toplevel)") {
        buf = buf substr(line,pos,32); have = 1; pos += 31; continue
      }
      if (c == "#" && !have) break
      if (c == ">" || c == "<" || (c == "&" && substr(line,pos+1,1) == ">")) {
        if (have && buf ~ /^[0-9]+$/) { buf = ""; have = 0 } else word()
        # Redirection operators and their single quoted/unquoted operand.
        while (substr(line,pos,1) ~ /[<>&|]/ && pos <= length(line)) pos++
        while (substr(line,pos,1) ~ /[ \t]/ && pos <= length(line)) pos++
        rq = ""
        for (; pos <= length(line); pos++) {
          rc = substr(line,pos,1)
          if (rq != "") { if (rc == rq) rq = ""; continue }
          if (rc == "\047" || rc == "\042") { rq = rc; continue }
          if (rc ~ /[ \t;&|]/) break
        }
        if (rq != "") bad = 1
        pos--; continue
      }
      if (c ~ /[;&|(){}]/) { segment(); continue }
      if (c ~ /[ \t]/) { word(); continue }
      buf = buf c; have = 1
    }
    if (escape) escape = 0
    else if (quote != "") { buf = buf "\n"; have = 1 }
    else segment()
  }
  END { if (quote != "" || escape) bad = 1; segment(); exit (bad ? 2 : 0) }
  ' <<EOF
$live
EOF
}
