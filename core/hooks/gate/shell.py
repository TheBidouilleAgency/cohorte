"""The shell lexer and simple-command normalisation.

`Lexer` turns a command line into `Seg`s (simple commands with their words, redirections,
heredocs and separators) the way a POSIX shell / bash would: quotes, escapes, `$(…)`,
backticks, `<(…)`, subshells, comments, heredocs. `strip_prefixes` then drops what runs in
front of the real command (`VAR=val`, `env`, `sudo`, `nice`, `timeout`, …).
"""

import re

# ── lexer ────────────────────────────────────────────────────────────────────
DYN = "\x00"   # stands for a run-time expansion inside a word's value


class ParseError(Exception):
    pass


class Word(object):
    __slots__ = ("value", "raw", "dynamic", "glob", "quoted", "substs")

    def __init__(self, value="", raw=""):
        self.value = value
        self.raw = raw
        self.dynamic = False
        self.glob = False
        self.quoted = False
        self.substs = []      # inner command lists ($(…), `…`, <(…))

    @property
    def head(self):
        return self.value.split(DYN, 1)[0]

    def __repr__(self):
        return "Word(%r)" % self.raw


def static_word(v):
    return Word(v, v)


def wildcard_word():
    w = Word(DYN, "$…")
    w.dynamic = True
    return w


class Redir(object):
    __slots__ = ("op", "fd", "target")

    def __init__(self, op, fd, target):
        self.op, self.fd, self.target = op, fd, target


class Heredoc(object):
    __slots__ = ("body", "quoted", "substs")

    def __init__(self, body, quoted, substs):
        self.body, self.quoted, self.substs = body, quoted, substs


class Seg(object):
    __slots__ = ("words", "redirs", "sep", "heredocs", "subshell", "funcdef", "start", "end",
                 "src")

    def __init__(self, src, start, subshell):
        self.words = []
        self.redirs = []
        self.sep = None
        self.heredocs = []
        self.subshell = subshell
        self.funcdef = False
        self.start = start
        self.end = start
        self.src = src

    @property
    def text(self):
        return self.src[self.start:self.end].strip()


SIMPLE_ESC = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b",
              "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?"}


def ansi_c(s):
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c != "\\" or i + 1 >= n:
            out.append(c)
            i += 1
            continue
        d = s[i + 1]
        i += 2
        if d in SIMPLE_ESC:
            out.append(SIMPLE_ESC[d])
        elif d == "x":
            m = re.match(r"[0-9a-fA-F]{1,2}", s[i:])
            if m:
                out.append(chr(int(m.group(), 16)))
                i += len(m.group())
            else:
                out.append("\\x")
        elif d in "uU":
            m = re.match(r"[0-9a-fA-F]{1,%d}" % (8 if d == "U" else 4), s[i:])
            if m:
                try:
                    out.append(chr(int(m.group(), 16)))
                except ValueError:
                    pass
                i += len(m.group())
            else:
                out.append("\\" + d)
        elif d in "01234567":
            m = re.match(r"[0-7]{1,3}", s[i - 1:])
            out.append(chr(int(m.group(), 8) & 0xFF))
            i += len(m.group()) - 1
        elif d == "c" and i < n:
            out.append(chr(ord(s[i]) & 0x1F))
            i += 1
        else:
            out.append("\\" + d)
    return "".join(out).replace("\x00", "")


class Lexer(object):
    """Just enough of the POSIX/bash grammar to find every simple command and its words."""

    def __init__(self, src):
        self.s = src
        self.n = len(src)
        self.i = 0
        self.pending = []      # heredocs waiting for the end of the line
        self.depth = 0         # $( … ) nesting, for `EOF)` heredoc ends

    def peek(self, k=0):
        j = self.i + k
        return self.s[j] if j < self.n else ""

    def parse(self):
        segs = self.parse_list(None, False)
        return segs

    def _push(self, segs, seg, sep):
        seg.sep = sep
        seg.end = self.i
        if seg.words or seg.redirs:
            segs.append(seg)

    def parse_list(self, closer, subshell):
        segs = []
        seg = Seg(self.s, self.i, subshell)
        while True:
            if self.i >= self.n:
                if closer:
                    raise ParseError("unterminated `(` or `$(`")
                self._push(segs, seg, None)
                return segs
            c = self.s[self.i]
            if c == "\\" and self.peek(1) == "\n":
                self.i += 2
                continue
            if c in " \t\r":
                self.i += 1
                continue
            if c == "#":
                j = self.s.find("\n", self.i)
                self.i = self.n if j < 0 else j
                continue
            if c == "\n":
                self.i += 1
                self._push(segs, seg, "\n")
                self._read_heredocs()
                seg = Seg(self.s, self.i, subshell)
                continue
            if c == ";":
                self.i += 1
                while self.peek() in (";", "&"):
                    self.i += 1
                self._push(segs, seg, ";")
                seg = Seg(self.s, self.i, subshell)
                continue
            if c == "&":
                if self.peek(1) == "&":
                    self.i += 2
                    self._push(segs, seg, "&&")
                elif self.peek(1) == ">":
                    self._redir(seg, None)
                    continue
                else:
                    self.i += 1
                    self._push(segs, seg, "&")
                seg = Seg(self.s, self.i, subshell)
                continue
            if c == "|":
                if self.peek(1) == "|":
                    self.i += 2
                    self._push(segs, seg, "||")
                elif self.peek(1) == "&":
                    self.i += 2
                    self._push(segs, seg, "|&")
                else:
                    self.i += 1
                    self._push(segs, seg, "|")
                seg = Seg(self.s, self.i, subshell)
                continue
            if c in "<>":
                if self.peek(1) == "(":
                    start = self.i
                    self.i += 2
                    self.depth += 1
                    inner = self.parse_list(")", False)
                    self.depth -= 1
                    w = Word(DYN, self.s[start:self.i])
                    w.dynamic = True
                    w.substs.append(inner)
                    seg.words.append(w)
                    continue
                self._redir(seg, None)
                continue
            if c == "(":
                if not seg.words and not seg.redirs:
                    self.i += 1
                    if self.peek() == "(":          # (( arithmetic ))
                        self.i += 1
                        self._skip_arith()
                        continue
                    inner = self.parse_list(")", True)
                    segs.extend(inner)
                    seg = Seg(self.s, self.i, subshell)
                    continue
                if self.peek(1) == ")" and len(seg.words) == 1:
                    self.i += 2
                    seg.funcdef = True
                    continue
                raise ParseError("unexpected `(`")
            if c == ")":
                if closer == ")":
                    self.i += 1
                    self._push(segs, seg, None)
                    return segs
                raise ParseError("unexpected `)`")
            w = self.read_word()
            if self.peek() in ("<", ">") and w.raw.isdigit():
                self._redir(seg, w.raw)
                continue
            seg.words.append(w)

    def _redir(self, seg, fd):
        s, i = self.s, self.i
        for op in ("&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", "<", ">>", ">&", ">|", ">"):
            if s.startswith(op, i):
                break
        self.i = i + len(op)
        while self.peek() in (" ", "\t"):
            self.i += 1
        if self.i >= self.n or self.peek() in ";&|<>()\n":
            raise ParseError("missing redirection target after `%s`" % op)
        target = self.read_word()
        if op in ("<<", "<<-"):
            quoted = target.quoted or any(ch in target.raw for ch in "'\"\\")
            self.pending.append((target.value.replace(DYN, ""), op == "<<-", quoted, seg))
        seg.redirs.append(Redir(op, fd, target))

    def _read_heredocs(self):
        while self.pending:
            delim, strip, quoted, seg = self.pending.pop(0)
            lines = []
            while self.i < self.n:
                j = self.s.find("\n", self.i)
                line = self.s[self.i:] if j < 0 else self.s[self.i:j]
                nxt = self.n if j < 0 else j + 1
                cmp = line.lstrip("\t") if strip else line
                if cmp == delim:
                    self.i = nxt
                    break
                if self.depth and cmp.startswith(delim) and cmp[len(delim):].lstrip().startswith(")"):
                    # `EOF)` closing a $( … ) on the delimiter line — bash accepts it
                    self.i += len(line) - len(cmp) + len(delim)
                    break
                lines.append(line)
                self.i = nxt
            body = "\n".join(lines)
            substs = [] if quoted else expansions_in(body)
            seg.heredocs.append(Heredoc(body, quoted, substs))

    def _skip_arith(self):
        d = 2
        while self.i < self.n:
            c = self.s[self.i]
            self.i += 1
            if c == "(":
                d += 1
            elif c == ")":
                d -= 1
                if d == 0:
                    return
        raise ParseError("unterminated arithmetic expression")

    def _skip_balanced(self):
        """Skip `( … )` (array assignments), honouring quotes."""
        d = 0
        while self.i < self.n:
            c = self.s[self.i]
            if c == "\\":
                self.i += 2
                continue
            if c in "'\"":
                j = self.s.find(c, self.i + 1)
                if j < 0:
                    raise ParseError("unterminated quote")
                self.i = j + 1
                continue
            self.i += 1
            if c == "(":
                d += 1
            elif c == ")":
                d -= 1
                if d == 0:
                    return
        raise ParseError("unterminated `(`")

    def read_word(self):
        w = Word()
        start = self.i
        buf = []
        s = self.s
        while self.i < self.n:
            c = s[self.i]
            if c in " \t\r\n":
                break
            if c in ";&|<>()":
                if c == "(" and buf and "".join(buf).endswith("=") and not w.quoted:
                    self._skip_balanced()
                    buf.append(DYN)
                    w.dynamic = True
                    continue
                if c in "<>" and self.peek(1) == "(" and buf:
                    break
                break
            if c == "\\":
                nx = self.peek(1)
                if nx == "\n":
                    self.i += 2
                    continue
                if nx:
                    buf.append(nx)
                w.quoted = True
                self.i += 2
                continue
            if c == "'":
                j = s.find("'", self.i + 1)
                if j < 0:
                    raise ParseError("unterminated single quote")
                buf.append(s[self.i + 1:j])
                w.quoted = True
                self.i = j + 1
                continue
            if c == '"':
                self.i += 1
                self._read_dq(w, buf, '"')
                w.quoted = True
                continue
            if c == "$":
                self._read_dollar(w, buf, False)
                continue
            if c == "`":
                self._read_backtick(w, buf)
                continue
            if c in "*?[":
                w.glob = True
            buf.append(c)
            self.i += 1
        w.value = "".join(buf)
        w.raw = s[start:self.i]
        if not w.quoted and "{" in w.raw and "," in w.raw and "}" in w.raw:
            w.dynamic = True            # brace expansion: {a,b}
        return w

    def _read_dq(self, w, buf, term):
        s = self.s
        while True:
            if self.i >= self.n:
                if term:
                    raise ParseError("unterminated double quote")
                return
            c = s[self.i]
            if term and c == term:
                self.i += 1
                return
            if c == "\\":
                nx = self.peek(1)
                if nx == "\n":
                    self.i += 2
                    continue
                if nx and nx in '$`"\\':
                    buf.append(nx)
                    self.i += 2
                    continue
                buf.append("\\")
                self.i += 1
                continue
            if c == "$":
                self._read_dollar(w, buf, True)
                continue
            if c == "`":
                self._read_backtick(w, buf)
                continue
            buf.append(c)
            self.i += 1

    def _read_dollar(self, w, buf, in_dq):
        s = self.s
        nx = self.peek(1)
        if nx == "(":
            if self.peek(2) == "(":
                self.i += 3
                self._skip_arith()
            else:
                self.i += 2
                self.depth += 1
                inner = self.parse_list(")", False)
                self.depth -= 1
                w.substs.append(inner)
            buf.append(DYN)
            w.dynamic = True
            return
        if nx == "{":
            j = self.i + 2
            d = 1
            while j < self.n:
                ch = s[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch in "'\"" and not in_dq:
                    k = s.find(ch, j + 1)
                    if k < 0:
                        raise ParseError("unterminated quote in ${…}")
                    j = k + 1
                    continue
                if ch == "{":
                    d += 1
                elif ch == "}":
                    d -= 1
                    if d == 0:
                        break
                j += 1
            if j >= self.n:
                raise ParseError("unterminated ${…}")
            self.i = j + 1
            buf.append(DYN)
            w.dynamic = True
            return
        if nx == "'" and not in_dq:
            j = self.i + 2
            while j < self.n and s[j] != "'":
                j += 2 if s[j] == "\\" else 1
            if j >= self.n:
                raise ParseError("unterminated $'…'")
            buf.append(ansi_c(s[self.i + 2:j]))
            w.quoted = True
            self.i = j + 1
            return
        if nx == '"' and not in_dq:
            self.i += 2
            self._read_dq(w, buf, '"')
            w.quoted = True
            return
        if nx and (nx.isalnum() or nx == "_"):
            j = self.i + 1
            if nx.isdigit():
                j += 1
            else:
                while j < self.n and (s[j].isalnum() or s[j] == "_"):
                    j += 1
            self.i = j
            buf.append(DYN)
            w.dynamic = True
            return
        if nx and nx in "@*#?$!-":
            self.i += 2
            buf.append(DYN)
            w.dynamic = True
            return
        buf.append("$")
        self.i += 1

    def _read_backtick(self, w, buf):
        s = self.s
        j = self.i + 1
        inner = []
        while j < self.n:
            ch = s[j]
            if ch == "\\" and j + 1 < self.n and s[j + 1] in "`$\\":
                inner.append(s[j + 1])
                j += 2
                continue
            if ch == "`":
                break
            inner.append(ch)
            j += 1
        if j >= self.n:
            raise ParseError("unterminated backtick")
        self.i = j + 1
        w.substs.append(Lexer("".join(inner)).parse())
        buf.append(DYN)
        w.dynamic = True


def expansions_in(text):
    """Command substitutions inside an unquoted heredoc body (they run when it expands)."""
    if "$(" not in text and "`" not in text:
        return []
    lx = Lexer(text)
    w = Word()
    try:
        lx._read_dq(w, [], None)
    except ParseError:
        return [[]]
    return w.substs


def parse_command(text):
    return Lexer(text.replace("\x00", "")).parse()


# ── command normalisation ────────────────────────────────────────────────────
ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\+?=")
RESERVED_SKIP = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time"}
RESERVED_HEADER = {"for", "case", "select", "function", "done", "fi", "esac", "in", "coproc", "}"}
GIT_ENV_VARS = {"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish", "yash", "posh"}
INTERP_RE = re.compile(r"^(python[0-9.]*|pypy[0-9.]*|node|nodejs|perl[0-9.]*|ruby|php|deno|bun)$")


def cmd_name(v):
    b = v.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if b.endswith(".exe"):
        b = b[:-4]
    return b


def is_assignment(w):
    return bool(ASSIGN_RE.match(w.raw))


def is_flag_word(w):
    v = w.value
    return (not w.dynamic) and len(v) > 1 and v.startswith("-") and v != "--"


PREFIX_NAMES = {"env", "command", "builtin", "exec", "nice", "time", "sudo", "doas", "nohup",
                "setsid", "chronic", "unbuffer", "caffeinate", "ionice", "stdbuf", "timeout"}
PREFIXES_SEEN = []    # filled by the last strip_prefixes() call


def strip_prefixes(words):
    """Drop `VAR=val`, `env …`, `command`, `sudo`, … in front of the real command.
    Returns (argv, assigned names, env -S string or None, relocated, lookup_only)."""
    i = 0
    n = len(words)
    assigns = []
    env_s = None
    relocated = False
    del PREFIXES_SEEN[:]

    def val(k):
        return words[k].value if k < n else ""

    while i < n:
        while i < n and is_assignment(words[i]):
            assigns.append(ASSIGN_RE.match(words[i].raw).group(1))
            i += 1
        if i >= n or words[i].dynamic:
            break
        name = cmd_name(words[i].value)
        if name in PREFIX_NAMES:
            PREFIXES_SEEN.append(name)
        if name == "env":
            i += 1
            while i < n:
                v = val(i)
                if words[i].dynamic:
                    break
                if v in ("-u", "--unset"):
                    i += 2
                elif v in ("-C", "--chdir"):
                    relocated = True
                    i += 2
                elif v.startswith("--chdir="):
                    relocated = True
                    i += 1
                elif v in ("-S", "--split-string"):
                    env_s = words[i + 1] if i + 1 < n else None
                    return [], assigns, env_s, relocated, False
                elif v.startswith("-S") or v.startswith("--split-string="):
                    env_s = static_word(v[2:] if v.startswith("-S") else v.split("=", 1)[1])
                    return [], assigns, env_s, relocated, False
                elif v == "--":
                    i += 1
                    break
                elif is_assignment(words[i]):
                    assigns.append(ASSIGN_RE.match(words[i].raw).group(1))
                    i += 1
                elif v.startswith("-") and len(v) > 1:
                    i += 1
                else:
                    break
            continue
        if name in ("command", "builtin"):
            i += 1
            while i < n and val(i).startswith("-") and val(i) != "--":
                if "v" in val(i) or "V" in val(i):
                    return [], assigns, None, relocated, True
                i += 1
            if val(i) == "--":
                i += 1
            continue
        if name == "exec":
            i += 1
            while i < n and val(i).startswith("-"):
                i += 2 if val(i) == "-a" else 1
            continue
        if name == "nice":
            i += 1
            while i < n and val(i).startswith("-"):
                i += 2 if val(i) in ("-n", "--adjustment") else 1
            continue
        if name == "time":
            i += 1
            while i < n and val(i).startswith("-"):
                i += 2 if val(i) in ("-o", "-f", "--output", "--format") else 1
            continue
        if name in ("sudo", "doas"):
            i += 1
            while i < n and val(i).startswith("-"):
                v = val(i)
                if v == "--":
                    i += 1
                    break
                if v in ("-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user",
                         "--group", "--chdir", "--host", "--prompt", "--role", "--type",
                         "--other-user", "--command-timeout"):
                    i += 2
                else:
                    i += 1
            continue
        if name in ("nohup", "setsid", "chronic", "unbuffer", "caffeinate", "ionice", "stdbuf"):
            i += 1
            while i < n and val(i).startswith("-"):
                v = val(i)
                i += 2 if (v in ("-c", "-n", "-t", "-i", "-o", "-e", "-w", "-s", "-p")
                           and name in ("ionice", "stdbuf", "caffeinate")) else 1
            continue
        if name == "timeout":
            i += 1
            while i < n and val(i).startswith("-"):
                i += 2 if val(i) in ("-s", "-k", "--signal", "--kill-after") else 1
            i += 1   # the duration
            continue
        break
    return words[i:], assigns, env_s, relocated, False
