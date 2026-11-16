#!/usr/bin/env python3
"""Cohorte PreToolUse gate for Claude Code (3.0 — Claude Code only).

Installed per project as `.claude/hooks/cohorte-gate.py` and registered in the project's
`.claude/settings.json` as a PreToolUse hook:

    python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py"     matcher: Bash|Task|Agent

It reads the PreToolUse payload on stdin and either stays silent (allow, exit 0) or prints
one `hookSpecificOutput.permissionDecision` of "ask" or "deny" (exit 0). Stdlib only,
Python >= 3.8.

What it does, in order of authority:

1. Inert outside Cohorte projects. With no `.claude/pipeline.json` pointer and no
   `gate-config.json` in the project, every call is allowed silently: this file can be
   registered somewhere that is not a Cohorte repo without changing anything.
2. Built-in hard floor (any Cohorte project, even with no gate-config.json): a force push
   or a remote deletion whose destination is the default branch is denied. "Force" covers
   `-f`, `--force`, `--force-with-lease[=…]`, `--force-if-includes`, abbreviations
   (`--forc`), combined short flags (`-uf`), `--mirror`, `--delete`/`-d`, and `+`/`:`
   refspecs.
3. Self-protection: a Bash command that writes, moves, truncates or deletes the files
   the gate depends on is denied (`.claude/gate-config.json`, `.claude/preflight.ok`,
   `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/cohorte-gate.py`,
   the legacy `.cohorte/gate-config.json`, `~/.claude/settings*.json`). The same applies to
   deleting `.claude/pipeline.json` or a directory that contains any of them. A
   Write/Edit/MultiEdit/NotebookEdit call aimed at one of them gets "ask".
4. Project rules from `.claude/gate-config.json` (`deny` / `ask` / `ask_on_default_branch`).
   These are matched as tokens, not substrings (see "Matching").
5. Preflight phase gate: a Task/Agent dispatch of a listed subagent needs a fresh
   `.claude/preflight.ok` stamp whose content digest equals the dispatch checkout's.

Matching. The command is lexed like a shell does it: quotes, escapes, `\\`-newline
continuations, comments, heredocs (bodies are data unless fed to a shell), `$(…)`,
backticks, `<(…)`, subshells, redirections, and the separators `; && || | |& &` and newline.
Each simple command loses its prefixes (`VAR=val`, `env`, `command`, `builtin`, `exec`,
`nice`, `time`, `nohup`, `timeout`, `sudo`, …). Its basename is lowercased (`GIT`,
`/usr/bin/git`, `\\git` and `"git"` are all `git`). A pattern is lexed the same way. It
matches when its command name is equal and its positional words come, in order, at the
start of the command's positional words. Each of its flags must be present in the command,
compared by meaning: `-rf` = `-r -f` = `-fr` = `--recursive --force`. For git, global options
(`-c`, `-C`, `--git-dir`, `--no-pager`, …) are skipped, git aliases are expanded, and long
options can be abbreviated. For `git push`, every force form listed above satisfies a `-f`
or `--force` pattern. Package runners are looked through: `npx`/`pnpm exec`/`yarn`/
`bunx`/`uv run`/`python -m`… `prisma migrate reset` matches `prisma migrate reset`.

A pattern that itself contains a separator (`curl | sh`) matches a run of consecutive
commands that each match their part, joined by the same separator.

Indirection (`sh -c`, `bash <<EOF`, `eval`, `$(…)`, `| sh`, `source` of a just-written
file, inline `python -c`/`node -e` code that spawns processes, xargs, find -exec, git
aliases) is followed when the inner text is static. When it can't be judged statically,
the call gets "ask", but only if there are rules to protect (deny/ask patterns, or the
floor when the hidden text mentions git). A deny pattern found in the raw hidden text is a
deny.

Branch awareness. `ask_on_default_branch` patterns fire when the branch is the default
branch or unknown. The branch is unknown on a detached HEAD, outside a repo, after a
`cd` that can't be resolved, and for the rest of a chain after `git checkout`/`switch`,
`pushd`/`popd`, a subshell, `git -C`, or `GIT_DIR`/`GIT_WORK_TREE`. A plain `cd <dir>`
chained with `&&` or `;` is followed (never through `|`). For `git push`, the destination
also counts: `src:dst`, `HEAD`, the upstream/push target of a bare push, `--all`/`--mirror`.

Permission modes. In `bypassPermissions` and `dontAsk` nobody answers a prompt, so every
"ask" becomes a "deny" with the reason attached. `default`, `acceptEdits` and `plan` keep
"ask".

Fail closed. If the project is active and the payload is a Bash/Task/Agent call that
can't be evaluated (wrong types, internal error, unparseable JSON that still looks like a
tool call), the answer is "deny". A command the lexer can't parse (an unbalanced quote) is
not an internal error: it is denied if its raw text contains a deny pattern, and otherwise
gets "ask" when rules exist. When gate-config.json is invalid (unparseable or wrong types),
the floor and self-protection still deny, and every other Bash command and every dispatch
gets "ask" until the config is fixed.

Explicit mode, for scripts and humans:

    cohorte-gate.py --check [--cwd DIR] [--unattended] [--] <command…>
    cohorte-gate.py --check-dispatch [--cwd DIR] [--unattended] [--] <subagent_type>

It prints `gate: allow` / `gate: ask — …` / `gate: deny — …` and exits 0 / 1 / 2. Options
are only read before the command (or before `--`). A legacy `--runtime claude` argument is
accepted and ignored.

This is a strong guard against agent mistakes on the common forms, not a sandbox. A script
file that does a force push (`./release.sh`, `npm run x`, `make`) is not inspected. Branch
protection on the remote is the real boundary.
"""

import fnmatch
import glob
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

# ── time budget ──────────────────────────────────────────────────────────────
# The hook is registered with onFailure "block": a timeout blocks the tool call. Every git
# call draws on one global budget, and an exhausted budget answers "ask", never "allow".
DEFAULT_BUDGET_S = 6.0
_START = time.monotonic()


def _budget():
    try:
        b = float(os.environ.get("COHORTE_GATE_BUDGET_S", "") or DEFAULT_BUDGET_S)
    except ValueError:
        b = DEFAULT_BUDGET_S
    return max(0.0, min(b, DEFAULT_BUDGET_S))   # can only be lowered (stricter), never raised


BUDGET_S = _budget()


def remaining():
    return BUDGET_S - (time.monotonic() - _START)


_GIT_ENV = None


def git_env(extra=None):
    global _GIT_ENV
    if _GIT_ENV is None:
        _GIT_ENV = {k: v for k, v in os.environ.items()
                    if k not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                                 "GIT_OBJECT_DIRECTORY", "GIT_CEILING_DIRECTORIES")}
        _GIT_ENV["GIT_OPTIONAL_LOCKS"] = "0"
        _GIT_ENV["LC_ALL"] = "C"
        _GIT_ENV["GIT_TERMINAL_PROMPT"] = "0"
    if extra:
        e = dict(_GIT_ENV)
        e.update(extra)
        return e
    return _GIT_ENV


class TimedOut(Exception):
    pass


def run_git(args, cwd, timeout=3.0, env=None, raise_timeout=False):
    """(returncode, stdout) — or None when git can't run here or the budget is spent."""
    left = remaining()
    if left <= 0.05:
        if raise_timeout:
            raise TimedOut()
        return None
    try:
        p = subprocess.run(["git"] + list(args), cwd=cwd, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           universal_newlines=True, timeout=min(timeout, left),
                           env=env or git_env())
    except subprocess.TimeoutExpired:
        if raise_timeout:
            raise TimedOut()
        return None
    except Exception:
        return None
    return p.returncode, p.stdout


def warn(msg):
    try:
        sys.stderr.write("cohorte-gate: %s\n" % msg)
    except Exception:
        pass


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


def strip_prefixes(words):
    """Drop `VAR=val`, `env …`, `command`, `sudo`, … in front of the real command.
    Returns (argv, assigned names, env -S string or None, relocated, lookup_only)."""
    i = 0
    n = len(words)
    assigns = []
    env_s = None
    relocated = False

    def val(k):
        return words[k].value if k < n else ""

    while i < n:
        while i < n and is_assignment(words[i]):
            assigns.append(ASSIGN_RE.match(words[i].raw).group(1))
            i += 1
        if i >= n or words[i].dynamic:
            break
        name = cmd_name(words[i].value)
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


# ── git ──────────────────────────────────────────────────────────────────────
GIT_GLOBAL_WITH_ARG = {"-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
                       "--config-env", "--list-cmds", "--attr-source"}
GIT_BUILTINS = set("""add am annotate apply archive bisect blame branch bugreport bundle
cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry
cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects
credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export
fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo
format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init
instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance
merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv
name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff
read-tree rebase reflog remote repack replace replay request-pull rerere reset restore
rev-list rev-parse revert rm scalar send-email send-pack shortlog show show-branch show-index
show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag
unpack-file unpack-objects update-index update-ref update-server-info var verify-commit
verify-pack verify-tag version whatchanged worktree write-tree lfs""".split())

PUSH_LONG = ["all", "branches", "mirror", "delete", "tags", "dry-run", "porcelain", "force",
             "force-with-lease", "no-force-with-lease", "force-if-includes",
             "no-force-if-includes", "recurse-submodules", "no-recurse-submodules", "thin",
             "no-thin", "quiet", "verbose", "progress", "no-progress", "prune", "no-prune",
             "verify", "no-verify", "follow-tags", "no-follow-tags", "signed", "no-signed",
             "atomic", "no-atomic", "push-option", "repo", "set-upstream", "receive-pack",
             "exec", "ipv4", "ipv6"]
PUSH_LONG_WITH_ARG = {"push-option", "repo", "receive-pack", "exec"}
FORCE_LONG = {"force", "force-with-lease", "force-if-includes"}
BRANCH_SUBST_RE = re.compile(
    r'^"?\$\(\s*git\s+(branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|'
    r'symbolic-ref\s+(-q\s+)?--short\s+(-q\s+)?HEAD|branch\s+--show)\s*\)"?$')


class GitInv(object):
    def __init__(self):
        self.sub = None
        self.sub_index = None
        self.args = []
        self.relocated = False     # -C / --git-dir / --work-tree
        self.dynamic_global = False
        self.c_aliases = {}


def parse_git(args):
    g = GitInv()
    i = 0
    while i < len(args):
        w = args[i]
        if w.dynamic:
            g.dynamic_global = True
            return g
        v = w.value
        if v == "-C":
            g.relocated = True
            i += 2
            continue
        if v == "-c":
            if i + 1 < len(args) and not args[i + 1].dynamic:
                kv = args[i + 1].value
                k, _, val = kv.partition("=")
                if k.lower().startswith("alias."):
                    g.c_aliases[k[6:]] = val
            i += 2
            continue
        if v in ("--git-dir", "--work-tree"):
            g.relocated = True
            i += 2
            continue
        if v.startswith("--git-dir=") or v.startswith("--work-tree="):
            g.relocated = True
            i += 1
            continue
        if v in GIT_GLOBAL_WITH_ARG:
            i += 2
            continue
        if v.startswith("-"):
            i += 1
            continue
        g.sub = v
        g.sub_index = i
        g.args = args[i + 1:]
        break
    return g


def resolve_long(name, table):
    if name in table:
        return [name]
    return [o for o in table if o.startswith(name)] if name else []


class PushInfo(object):
    def __init__(self):
        self.force = False        # a force flag (-f, --force*, abbreviations)
        self.delete = False       # --delete / -d
        self.mirror = False
        self.all = False
        self.tags = False
        self.plus_ref = False     # +refspec
        self.colon_delete = False  # :dst refspec
        self.wild = False         # an argument computed at run time
        self.flags = set()
        self.positionals = []
        self.repo = None

    @property
    def force_like(self):
        return (self.force or self.delete or self.mirror or self.plus_ref or self.colon_delete)

    @property
    def delete_like(self):
        return self.delete or self.colon_delete or self.mirror


def analyze_push_args(args):
    pi = PushInfo()
    i = 0
    end_opts = False
    prev_takes_value = False
    while i < len(args):
        w = args[i]
        v = w.value
        if w.dynamic:
            h = w.head
            if not end_opts and h.startswith("--") and "=" in h:
                name = h[2:].split("=", 1)[0]
                c = resolve_long(name, PUSH_LONG)
                if FORCE_LONG.intersection(c):
                    pi.force = True
            elif BRANCH_SUBST_RE.match(w.raw):
                pi.positionals.append(w)      # "$(git branch --show-current)" — resolved later
            elif not prev_takes_value:
                pi.wild = True
                pi.positionals.append(w)
            prev_takes_value = False
            i += 1
            continue
        prev_takes_value = False
        if not end_opts and v == "--":
            end_opts = True
            i += 1
            continue
        if not end_opts and v.startswith("--") and len(v) > 2:
            name, eq, _ = v[2:].partition("=")
            cands = resolve_long(name, PUSH_LONG)
            if FORCE_LONG.intersection(cands):
                pi.force = True
            if "delete" in cands:
                pi.delete = True
            if "mirror" in cands:
                pi.mirror = True
            if "all" in cands or "branches" in cands:
                pi.all = True
            if "tags" in cands:
                pi.tags = True
            pi.flags.add("--" + (cands[0] if len(cands) == 1 else name))
            if len(cands) == 1 and cands[0] in PUSH_LONG_WITH_ARG and not eq:
                if cands[0] == "repo" and i + 1 < len(args):
                    pi.repo = args[i + 1]
                prev_takes_value = True
                i += 1
                if i < len(args) and not args[i].dynamic:
                    i += 1
                    prev_takes_value = False
                continue
            i += 1
            continue
        if not end_opts and v.startswith("-") and len(v) > 1:
            rest = v[1:]
            for k, ch in enumerate(rest):
                pi.flags.add("-" + ch)
                if ch == "f":
                    pi.force = True
                elif ch == "d":
                    pi.delete = True
                elif ch == "o":
                    if k == len(rest) - 1:
                        prev_takes_value = True
                        if i + 1 < len(args) and not args[i + 1].dynamic:
                            i += 1
                            prev_takes_value = False
                    break
            i += 1
            continue
        pi.positionals.append(w)
        i += 1
    refs = pi.positionals if pi.repo is not None else pi.positionals[1:]
    for r in refs:
        if not r.dynamic:
            rv = r.value
            if rv.startswith("+"):
                pi.plus_ref = True
                rv = rv[1:]
            if rv.startswith(":") and len(rv) > 1:
                pi.colon_delete = True
    return pi


def normalize_ref(name):
    if name.startswith("refs/heads/"):
        return name[len("refs/heads/"):]
    if name.startswith("refs/"):
        return None
    return name


# ── config ───────────────────────────────────────────────────────────────────
DEFAULT_AGENTS = ["cohorte-review", "review"]


class ConfigError(Exception):
    pass


def _pattern_list(obj, key, warnings, path):
    if key not in obj:
        return []
    v = obj[key]
    if isinstance(v, str):
        warnings.append("%s: `%s` is a string, read as a one-element list" % (path, key))
        v = [v]
    if not isinstance(v, list):
        raise ConfigError("`%s` must be a list of strings (got %s)" % (key, type(v).__name__))
    out = []
    for item in v:
        if not isinstance(item, str):
            raise ConfigError("`%s` must contain only strings (found %s)" % (key, json.dumps(item)))
        if not item.strip():
            warnings.append("%s: empty pattern in `%s` ignored" % (path, key))
            continue
        out.append(item.strip())
    return out


def validate_config(obj, path, warnings):
    if not isinstance(obj, dict):
        raise ConfigError("the top level must be a JSON object")
    cfg = {}
    for key in ("deny", "ask", "ask_on_default_branch"):
        cfg[key] = _pattern_list(obj, key, warnings, path)
    db = obj.get("default_branch")
    if db is not None and not isinstance(db, str):
        raise ConfigError("`default_branch` must be a string")
    cfg["default_branch"] = db.strip() if isinstance(db, str) and db.strip() else None
    pf = obj.get("preflight")
    if pf is None:
        cfg["preflight"] = None
    else:
        if not isinstance(pf, dict):
            raise ConfigError("`preflight` must be an object")
        enabled = pf.get("enabled", False)
        if not isinstance(enabled, bool):
            raise ConfigError("`preflight.enabled` must be true or false")
        agents = pf.get("agents")
        if agents is None:
            agents = list(DEFAULT_AGENTS)
        else:
            if isinstance(agents, str):
                agents = [agents]
            if not isinstance(agents, list) or not all(isinstance(a, str) for a in agents):
                raise ConfigError("`preflight.agents` must be a list of strings")
            agents = [a.strip() for a in agents if a.strip()] or list(DEFAULT_AGENTS)
        age = pf.get("max_age_minutes", 30)
        if age is None:
            age = 30
        if isinstance(age, bool) or not isinstance(age, (int, float)) or age < 0 or age != age:
            raise ConfigError("`preflight.max_age_minutes` must be a number >= 0")
        cfg["preflight"] = {"enabled": enabled, "agents": agents, "max_age_minutes": float(age)}
    return cfg


def git_top_and_common(cwd):
    r = run_git(["rev-parse", "--show-toplevel", "--git-common-dir"], cwd)
    if not r or r[0] != 0:
        return None, None
    lines = r[1].splitlines()
    top = os.path.realpath(lines[0]) if lines and lines[0] else None
    main = None
    if len(lines) > 1 and lines[1]:
        common = lines[1]
        if not os.path.isabs(common):
            common = os.path.join(cwd, common)
        common = os.path.realpath(common)
        if os.path.basename(common) == ".git":
            main = os.path.dirname(common)
    return top, main


def resolve_roots(cwd):
    """Project roots to read config from: the cwd's checkout, $CLAUDE_PROJECT_DIR, and the
    main checkout of a linked worktree — every one that exists, cwd's first."""
    roots = []

    def add(p):
        if p and os.path.isdir(p):
            rp = os.path.realpath(p)
            if rp not in roots:
                roots.append(rp)

    top = main = None
    if cwd and os.path.isdir(cwd):
        top, main = git_top_and_common(cwd)
        if top:
            add(top)
        else:
            d = os.path.realpath(cwd)
            home = os.path.realpath(os.path.expanduser("~"))
            while True:
                c = os.path.join(d, ".claude")
                if (os.path.isfile(os.path.join(c, "gate-config.json"))
                        or os.path.isfile(os.path.join(c, "pipeline.json"))):
                    add(d)
                    break
                parent = os.path.dirname(d)
                if parent == d or d == home:
                    break
                d = parent
    env = os.environ.get("CLAUDE_PROJECT_DIR") or ""
    if env:
        add(env)
    add(main)
    return roots, top


class Ctx(object):
    def __init__(self, cwd, mode):
        self.cwd0 = os.path.realpath(cwd) if cwd and os.path.isdir(cwd) else None
        self.mode = mode
        self.roots, self.top0 = resolve_roots(self.cwd0)
        self.warnings = []
        self.errors = []
        self.config_found = False
        merged = {"deny": [], "ask": [], "ask_on_default_branch": [], "default_branches": [],
                  "preflight": None}
        for r in self.roots:
            for sub in (".claude", ".cohorte"):
                p = os.path.join(r, sub, "gate-config.json")
                if not os.path.isfile(p):
                    continue
                if sub == ".cohorte" and os.path.isfile(os.path.join(r, ".claude", "gate-config.json")):
                    self.warnings.append("%s and .claude/gate-config.json both exist; their "
                                         "rules are combined" % p)
                self.config_found = True
                try:
                    with open(p, "r", encoding="utf-8") as fh:
                        obj = json.load(fh)
                    cfg = validate_config(obj, p, self.warnings)
                except ConfigError as e:
                    self.errors.append("%s: %s" % (p, e))
                    continue
                except Exception as e:
                    self.errors.append("%s: not valid JSON (%s)" % (p, e))
                    continue
                for k in ("deny", "ask", "ask_on_default_branch"):
                    for pat in cfg[k]:
                        if pat not in merged[k]:
                            merged[k].append(pat)
                if cfg["default_branch"] and cfg["default_branch"] not in merged["default_branches"]:
                    merged["default_branches"].append(cfg["default_branch"])
                if merged["preflight"] is None and cfg["preflight"] is not None:
                    merged["preflight"] = cfg["preflight"]
        self.cfg = merged
        self.has_pointer = any(os.path.isfile(os.path.join(r, ".claude", "pipeline.json"))
                               for r in self.roots)
        self.active = self.has_pointer or self.config_found
        for w in self.warnings:
            warn(w)
        self.deny_pats = [compile_pattern(p) for p in merged["deny"]]
        self.ask_pats = [compile_pattern(p) for p in merged["ask"]]
        self.branch_pats = [compile_pattern(p) for p in merged["ask_on_default_branch"]]
        self.has_rules = bool(merged["deny"] or merged["ask"] or merged["ask_on_default_branch"]
                              or self.errors)
        self._defaults = None
        self._branches = {}
        self._aliases = {}
        self._build_protected()

    def _build_protected(self):
        write, delete = set(), set()

        def add(s, p):
            s.add(os.path.normpath(p))
            s.add(os.path.realpath(p))

        for r in self.roots:
            for rel in ((".claude", "gate-config.json"), (".claude", "preflight.ok"),
                        (".claude", "settings.json"), (".claude", "settings.local.json"),
                        (".claude", "hooks", "cohorte-gate.py"), (".cohorte", "gate-config.json")):
                add(write, os.path.join(r, *rel))
            add(delete, os.path.join(r, ".claude", "pipeline.json"))
        home = os.path.expanduser("~")
        for rel in ("settings.json", "settings.local.json"):
            add(write, os.path.join(home, ".claude", rel))
        self.protected = write
        self.delete_protected = write | delete

    # git state, cached
    def current_branch(self, cwd):
        if cwd not in self._branches:
            r = run_git(["symbolic-ref", "-q", "--short", "HEAD"], cwd)
            self._branches[cwd] = r[1].strip() if r and r[0] == 0 and r[1].strip() else None
        return self._branches[cwd]

    def defaults(self):
        if self._defaults is None:
            if self.cfg["default_branches"]:
                self._defaults = list(self.cfg["default_branches"])
            else:
                d = ["main", "master"]
                if self.cwd0:
                    r = run_git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
                                self.cwd0)
                    if r and r[0] == 0 and "/" in r[1].strip():
                        name = r[1].strip().split("/", 1)[1]
                        if name not in d:
                            d.insert(0, name)
                self._defaults = d
        return self._defaults

    def is_default(self, branch):
        return any(fnmatch.fnmatchcase(d, branch) if any(c in branch for c in "*?[") else d == branch
                   for d in self.defaults())

    def git_alias(self, sub, cwd):
        key = (sub, cwd)
        if key not in self._aliases:
            r = run_git(["config", "--get", "alias." + sub], cwd)
            self._aliases[key] = r[1].strip() if r and r[0] == 0 and r[1].strip() else None
        return self._aliases[key]


# ── patterns ─────────────────────────────────────────────────────────────────
class PatSeg(object):
    def __init__(self, name, args, sep):
        self.name = name
        self.args = args
        self.sep = sep
        self.git = parse_git(args) if name == "git" else None
        self.core = runner_core(name, args) if name != "git" else None


class Pattern(object):
    def __init__(self, text):
        self.text = text
        self.norm = " ".join(text.lower().split())
        self.segs = []
        try:
            segs = parse_command(text)
        except ParseError:
            warn("pattern `%s` can't be tokenized; it is matched as raw text" % text)
            return
        for s in segs:
            words = [w for w in s.words]
            while words and not words[0].quoted and words[0].value in RESERVED_SKIP:
                words.pop(0)
            argv = strip_prefixes(words)[0]
            if not argv:
                continue
            self.segs.append(PatSeg(cmd_name(argv[0].value), argv[1:], s.sep))

    @property
    def multi(self):
        return len(self.segs) > 1


def compile_pattern(text):
    return Pattern(text)


def runner_core(name, args, depth=0):
    """(name, args) of the program a package runner / launcher runs, or None."""
    if depth > 3:
        return None
    a = list(args)

    def skip_opts(k, with_arg=()):
        while k < len(a):
            if a[k].dynamic:
                return None
            v = a[k].value
            if v == "--":
                return k + 1
            if v.startswith("-") and len(v) > 1:
                k += 2 if v in with_arg else 1
                continue
            return k
        return None

    k = None
    if name in ("npx", "bunx", "pnpx"):
        k = skip_opts(0, ("-p", "--package", "-c", "--call"))
    elif name in ("pnpm", "yarn", "npm", "bun"):
        k = skip_opts(0, ("--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd"))
        if k is not None and k < len(a) and a[k].value in ("exec", "dlx", "x", "run"):
            k = skip_opts(k + 1, ("--filter", "-F", "-C", "--dir", "--prefix"))
        elif name == "npm":
            return None
    elif name in ("uv", "poetry", "pipenv", "rye", "pdm", "hatch") and a and a[0].value == "run":
        k = skip_opts(1, ("--with", "--python", "-p", "--env", "-e"))
    elif name == "bundle" and a and a[0].value == "exec":
        k = skip_opts(1)
    elif name in ("cross-env", "env-cmd", "dotenv"):
        k = 0
        while k < len(a) and (is_assignment(a[k]) or a[k].value.startswith("-")):
            if a[k].value == "--":
                k += 1
                break
            k += 2 if a[k].value in ("-e", "-f", "-c") else 1
    elif INTERP_RE.match(name) and name.startswith("py"):
        for j, w in enumerate(a):
            if w.value == "-m" and j + 1 < len(a):
                k = j + 1
                break
            if not w.value.startswith("-"):
                break
    if k is None or k >= len(a) or a[k].dynamic:
        return None
    inner = cmd_name(a[k].value)
    rest = a[k + 1:]
    deeper = runner_core(inner, rest, depth + 1)
    return deeper or (inner, rest)


def short_flags(v):
    return ["-" + c for c in v[1:]]


def flag_names(tokens, aliases=None):
    out = set()
    for w in tokens:
        if w.dynamic:
            h = w.head
            if h.startswith("--") and "=" in h:
                out.add(h.split("=", 1)[0])
            continue
        v = w.value
        if v == "--":
            break
        if len(v) < 2 or not v.startswith("-"):
            continue
        if v.startswith("--"):
            out.add(v.split("=", 1)[0])
        else:
            out.update(short_flags(v))
    if aliases:
        out = {aliases.get(f, f) for f in out}
    return out


FLAG_ALIASES = {
    "rm": {"-R": "-r", "--recursive": "-r", "--force": "-f", "--dir": "-d"},
    "cp": {"-R": "-r", "--recursive": "-r", "--force": "-f"},
}


def is_wildcard(tokens, idx):
    """A run-time word that could be any word (or flag) — unless it is the value of the
    flag right before it (`-m "$(cat <<EOF …)"`)."""
    w = tokens[idx]
    if not w.dynamic:
        return False
    h = w.head
    if h.startswith("-") and "=" in h:
        return False
    if idx > 0:
        p = tokens[idx - 1]
        if is_flag_word(p) and "=" not in p.value:
            return False
    return True


def pos_match(ppos, tokens, eq):
    """Pattern positionals in order at the start of the command's positionals. A
    positional may be skipped only when it follows a flag (it may be that flag's value)."""
    def rec(pi, ci):
        if pi == len(ppos):
            return "match"
        best = None
        prev_flag = False
        end_opts = False
        j = ci
        while j < len(tokens):
            w = tokens[j]
            if is_wildcard(tokens, j):
                return "possible"
            if w.dynamic:
                prev_flag = False
                j += 1
                continue
            if not end_opts and w.value == "--":
                end_opts = True
                j += 1
                continue
            if not end_opts and is_flag_word(w):
                prev_flag = "=" not in w.value
                j += 1
                continue
            if eq(ppos[pi], w):
                r = rec(pi + 1, j + 1)
                if r == "match":
                    return r
                best = best or r
            if not prev_flag:
                return best
            prev_flag = False
            j += 1
        return best
    return rec(0, 0)


def match_args(pargs, cargs, git=False, aliases=None, eq=None):
    eq = eq or (lambda p, w: p.value == w.value)
    ppos = [w for w in pargs if not is_flag_word(w)]
    pflags = [w for w in pargs if is_flag_word(w)]
    res = pos_match(ppos, cargs, eq)
    if res is None:
        return None
    cflags = flag_names(cargs, aliases)
    wild = any(is_wildcard(cargs, k) for k in range(len(cargs)))
    for pf in pflags:
        need = flag_names([pf], aliases)
        for f in need:
            ok = f in cflags
            if not ok and git and f.startswith("--"):
                ok = any(c.startswith("--") and len(c) >= 4 and f.startswith(c) for c in cflags)
            if not ok:
                if wild:
                    res = "possible"
                else:
                    return None
    return res


def push_eq(p, w):
    v = w.value
    if p.value == v:
        return True
    v = v.lstrip("+")
    if p.value == v:
        return True
    if ":" in v and p.value == v.split(":", 1)[1]:
        return True
    return False


def match_push(pat_args, cargs, pi):
    pflags = [w for w in pat_args if is_flag_word(w)]
    ppos = [w for w in pat_args if not is_flag_word(w)]
    res = pos_match(ppos, pi.positionals, push_eq)
    if res is None:
        return None
    pp = analyze_push_args(pflags)
    needs = []
    if pp.force:
        needs.append(pi.force_like)
    if pp.delete:
        needs.append(pi.delete_like)
    if pp.mirror:
        needs.append(pi.mirror)
    if pp.all:
        needs.append(pi.all or pi.mirror)
    if pp.tags:
        needs.append(pi.tags)
    semantic = {"-f", "-d", "--force", "--force-with-lease", "--force-if-includes", "--delete",
                "--mirror", "--all", "--branches", "--tags"}
    for f in pp.flags:
        if f in semantic:
            continue
        ok = f in pi.flags or (f.startswith("--") and any(
            c.startswith("--") and len(c) >= 4 and f.startswith(c) for c in pi.flags))
        needs.append(ok)
    if not all(needs):
        return "possible" if pi.wild else None
    if pi.wild and res == "match":
        return "match"
    return res


# ── analysis ─────────────────────────────────────────────────────────────────
PROTECTED_HINT_RE = re.compile(r"(^|/)\.claude(/|$)|gate-config\.json|preflight\.ok|"
                               r"settings(\.local)?\.json|cohorte-gate\.py|pipeline\.json|"
                               r"(^|/)\.cohorte(/|$)")
PROTECTED_NAME_RE = re.compile(r"gate-config\.json|preflight\.ok|\.claude/settings(\.local)?\.json|"
                               r"cohorte-gate\.py")
SPAWN_RE = {
    "py": re.compile(r"\bos\.(system|popen|exec\w*|spawn\w*)|\bsubprocess\b|\bpty\.spawn|"
                     r"\bcommands\.getoutput|\bpexpect\b|\bsh\.\w+\("),
    "js": re.compile(r"child_process|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b|\bexecFile\(|"
                     r"\bexec\(|\bspawn\(|Bun\.spawn|Deno\.(Command|run)|\$`|zx"),
    "pl": re.compile(r"\bsystem\b|\bexec\b|`|\bqx\b|IO\.popen|Open3|\bspawn\b|%x|\bpopen\b|"
                     r"\bshell_exec\b|\bpassthru\b|\bproc_open\b"),
}
STRING_LIT_RE = re.compile(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"")
MAX_DEPTH = 6
WRITE_OPS = {">", ">>", ">|", "&>", "&>>", "<>"}


def norm_lower(s):
    return " ".join(s.lower().split())


def lang_of(name):
    if name.startswith("py"):
        return "py"
    if name in ("node", "nodejs", "deno", "bun"):
        return "js"
    return "pl"


class State(object):
    def __init__(self, cwd):
        self.cwd = cwd
        self.cwd_known = cwd is not None
        self.sticky = False           # branch unknown for the rest of the chain
        self.written = set()
        self.git_aliases = {}

    def copy(self):
        s = State(self.cwd)
        s.cwd_known = self.cwd_known
        s.sticky = self.sticky
        s.written = set(self.written)
        s.git_aliases = dict(self.git_aliases)
        return s


class Inv(object):
    def __init__(self, name, args, seg):
        self.name = name
        self.args = args
        self.seg = seg
        self.git = None
        self.push = None
        self.push_touches = False
        self.push_unknown = False
        self.core = None


def short(text, n=90):
    t = " ".join(text.split())
    return t if len(t) <= n else t[:n - 1] + "…"


class Analyzer(object):
    def __init__(self, ctx):
        self.ctx = ctx
        self.findings = []

    def deny(self, why):
        self.findings.append(("deny", why))

    def ask(self, why):
        self.findings.append(("ask", why))

    def verdict(self):
        for level in ("deny", "ask"):
            hits = [w for (lv, w) in self.findings if lv == level]
            if hits:
                uniq = []
                for h in hits:
                    if h not in uniq:
                        uniq.append(h)
                more = " (+%d more)" % (len(uniq) - 1) if len(uniq) > 1 else ""
                return level, uniq[0] + more
        return None

    # -- hidden text ----------------------------------------------------------
    def raw_deny(self, text):
        t = norm_lower(text)
        for p in self.ctx.deny_pats:
            if p.norm and p.norm in t:
                self.deny("`%s` is forbidden by the project's gate, and it appears in text "
                          "that will be executed" % p.text)
                return True
        return False

    def opaque(self, what, text):
        if self.raw_deny(text):
            return
        if self.ctx.has_rules or re.search(r"git|push", text, re.I):
            self.ask("%s, so the gate can't check it against the rules — confirm (`%s`)"
                     % (what, short(text)))

    def unparseable(self, text, err):
        if self.raw_deny(text):
            return
        if self.ctx.has_rules or re.search(r"git|push|\.claude", text, re.I):
            self.ask("the gate can't parse this command (%s), so it can't verify it — confirm"
                     % err)

    def analyze_text(self, text, state, depth):
        if depth > MAX_DEPTH:
            self.opaque("commands are nested too deep", text)
            return
        try:
            segs = parse_command(text)
        except ParseError as e:
            self.unparseable(text, e)
            return
        self.walk(segs, state, depth, text)

    def walk(self, segs, state, depth, text=""):
        invs = []
        for idx, seg in enumerate(segs):
            prev = segs[idx - 1] if idx else None
            prev_inv = invs[-1] if invs else None
            if seg.subshell:
                state.sticky = True
            self.walk_substs(seg, state, depth)
            invs.append(self.eval_segment(seg, prev, prev_inv, state, depth))
        self.multi_patterns(segs, invs, state)
        for p in self.ctx.deny_pats + self.ctx.ask_pats:
            if not p.segs and p.norm in norm_lower(text):
                (self.deny if p in self.ctx.deny_pats else self.ask)(
                    "`%s` (raw-text rule) matches this command" % p.text)

    def walk_substs(self, seg, state, depth):
        words = list(seg.words) + [r.target for r in seg.redirs]
        for w in words:
            for sub in w.substs:
                self.walk(sub, state.copy(), depth + 1)
        for h in seg.heredocs:
            for sub in h.substs:
                self.walk(sub, state.copy(), depth + 1)

    # -- one simple command ----------------------------------------------------
    def eval_segment(self, seg, prev, prev_inv, state, depth):
        words = list(seg.words)
        if seg.funcdef:
            while words and words[0].value != "{":
                words.pop(0)
        for r in seg.redirs:
            if r.op in WRITE_OPS or (r.op == ">&" and not (r.target.value.isdigit()
                                                          or r.target.value == "-")):
                self.check_path(r.target, state, "write", "a redirection")
                self.remember_written(r.target, state)
        while words and not words[0].quoted and words[0].value in RESERVED_SKIP:
            words.pop(0)
        if words and not words[0].quoted and words[0].value in RESERVED_HEADER:
            return None
        if words and words[-1].value == "}" and not words[-1].quoted:
            words.pop()
        argv, assigns, env_s, relocated, lookup = strip_prefixes(words)
        seg_unknown = relocated
        if GIT_ENV_VARS.intersection(assigns):
            state.sticky = True
            seg_unknown = True
        if env_s is not None:
            if env_s.dynamic:
                self.opaque("`env -S` runs a string built at run time", seg.text)
            else:
                self.analyze_text(env_s.value, state.copy(), depth + 1)
            return None
        if lookup or not argv:
            return None
        cmd = argv[0]
        if cmd.dynamic:
            self.opaque("the command name is computed at run time", seg.text)
            return None
        name = cmd_name(cmd.value)
        args = argv[1:]
        inv = Inv(name, args, seg)

        if name == "git":
            g = self.expand_git(args, state, depth)
            if g is None:
                return None
            inv.git = g
            inv.args = args = (argv[1:1 + (g.sub_index or 0)] + [static_word(g.sub)] + g.args
                               if g.sub else args)
            if g.relocated:
                seg_unknown = True
            if g.dynamic_global:
                self.opaque("git's arguments are computed at run time", seg.text)
        else:
            inv.core = runner_core(name, args)

        here_unknown = seg_unknown or state.sticky or not state.cwd_known
        if inv.git and inv.git.sub == "push":
            self.eval_push(inv, state, here_unknown)
        self.match_config(inv, state, here_unknown)
        self.indirection(inv, seg, prev, prev_inv, state, depth)
        self.protect(inv, state, seg_unknown)
        self.update_state(inv, seg, state, assigns)
        return inv

    def expand_git(self, args, state, depth):
        for _ in range(4):
            g = parse_git(args)
            if g.sub is None or g.sub in GIT_BUILTINS:
                if g.sub == "config":
                    self.git_config_alias(g, state, depth)
                return g
            alias = g.c_aliases.get(g.sub) or state.git_aliases.get(g.sub)
            if alias is None and state.cwd_known and not g.relocated:
                alias = self.ctx.git_alias(g.sub, state.cwd)
            if alias is None:
                return g
            if alias.startswith("!"):
                extra = " ".join(shlex.quote(a.value) for a in g.args if not a.dynamic)
                self.analyze_text(alias[1:] + " " + extra, state.copy(), depth + 1)
                return None
            try:
                segs = parse_command(alias)
            except ParseError:
                self.opaque("git alias `%s` can't be parsed" % g.sub, alias)
                return None
            aw = segs[0].words if segs else []
            args = args[:g.sub_index] + aw + g.args
        return parse_git(args)

    def git_config_alias(self, g, state, depth):
        a = g.args
        for k, w in enumerate(a):
            if not w.dynamic and w.value.lower().startswith("alias.") and k + 1 < len(a):
                val = a[k + 1]
                name = w.value[6:]
                if val.dynamic:
                    self.opaque("a git alias is defined from a run-time value", val.raw)
                    return
                state.git_aliases[name] = val.value
                inner = val.value[1:] if val.value.startswith("!") else "git " + val.value
                self.analyze_text(inner, state.copy(), depth + 1)
                return

    def branch_gated(self, state, here_unknown):
        if here_unknown or state.sticky or not state.cwd_known:
            return True
        b = self.ctx.current_branch(state.cwd)
        return b is None or self.ctx.is_default(b)

    # -- git push --------------------------------------------------------------
    def push_targets(self, state, here_unknown):
        """Branch names a bare `git push` may update, and whether that is unknown."""
        if here_unknown:
            return set(), True
        cwd = state.cwd
        names = set()
        cur = self.ctx.current_branch(cwd)
        if cur is None:
            return set(), True
        names.add(cur)
        for spec in ("@{push}", "@{upstream}"):
            r = run_git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", spec], cwd)
            if r and r[0] == 0 and "/" in r[1].strip():
                names.add(r[1].strip().split("/", 1)[1])
        all_ = False
        r = run_git(["config", "--get-regexp", r"^(push\.default|remote\..*\.push)$"], cwd)
        if r and r[0] == 0:
            for line in r[1].splitlines():
                key, _, val = line.partition(" ")
                if key == "push.default" and val.strip() == "matching":
                    all_ = True
                elif key.endswith(".push"):
                    return names, True
        return names, all_ and "ALL"

    def eval_push(self, inv, state, here_unknown):
        pi = analyze_push_args(inv.git.args)
        inv.push = pi
        dests = set()
        unknown = False
        touches = pi.all or pi.mirror
        refs = pi.positionals if pi.repo is not None else pi.positionals[1:]
        skip = False
        for r in refs:
            if skip:
                skip = False
                continue
            if r.dynamic:
                if BRANCH_SUBST_RE.match(r.raw) and not here_unknown:
                    cur = self.ctx.current_branch(state.cwd)
                    if cur:
                        dests.add(cur)
                        continue
                unknown = True
                continue
            v = r.value
            if v == "tag":
                skip = True
                continue
            v = v.lstrip("+")
            if ":" in v:
                src, dst = v.split(":", 1)
                if not dst:
                    dst = src
            else:
                src = dst = v
            if dst in ("HEAD", "@") or (":" not in v and src in ("HEAD", "@")):
                names, unk = self.push_targets(state, here_unknown)
                dests |= names
                unknown = unknown or unk is True
                touches = touches or unk == "ALL"
                continue
            n = normalize_ref(dst)
            if n is None:
                continue
            dests.add(n)
            if ":" not in v and not here_unknown and n == src:
                rr = run_git(["rev-parse", "--abbrev-ref", "--symbolic-full-name",
                              src + "@{upstream}"], state.cwd)
                if rr and rr[0] == 0 and "/" in rr[1].strip():
                    dests.add(rr[1].strip().split("/", 1)[1])
        if not refs and not pi.all and not pi.mirror:
            names, unk = self.push_targets(state, here_unknown)
            dests |= names
            unknown = unknown or unk is True
            touches = touches or unk == "ALL"
        touches = touches or any(self.ctx.is_default(d) for d in dests)
        inv.push_touches = touches
        inv.push_unknown = unknown or (pi.wild and not dests)
        defaults = "/".join("`%s`" % d for d in self.ctx.defaults()[:2])
        if pi.force_like and touches:
            self.deny("a force push or remote deletion that reaches the default branch %s is "
                      "never allowed in a Cohorte project (built-in hard floor: %s). Push to a "
                      "feature branch instead; the remote's branch protection is the real "
                      "boundary" % (defaults, short(inv.seg.text, 70)))
        elif pi.force_like and inv.push_unknown:
            self.ask("force push (or remote deletion) whose destination the gate can't resolve "
                     "— make sure it does not reach %s, then confirm" % defaults)
        elif pi.wild:
            self.ask("`git push` with arguments computed at run time — the gate can't tell if "
                     "it forces or where it lands; confirm")

    # -- config rules ------------------------------------------------------------
    def match_inv(self, pat_seg, inv):
        if inv is None:
            return None
        if pat_seg.name == "git":
            if inv.name != "git" or inv.git is None:
                return None
            g = inv.git
            if g.sub is None:
                return "possible" if g.dynamic_global else None
            if pat_seg.git.sub is None:
                return "match"
            if pat_seg.git.sub != g.sub:
                return None
            if g.sub == "push" and inv.push is not None:
                return match_push(pat_seg.git.args, g.args, inv.push)
            return match_args(pat_seg.git.args, g.args, git=True)
        best = None
        cands = [(inv.name, inv.args)] + ([inv.core] if inv.core else [])
        pcands = [(pat_seg.name, pat_seg.args)] + ([pat_seg.core] if pat_seg.core else [])
        for pn, pa in pcands:
            for cn, ca in cands:
                if pn != cn:
                    continue
                r = match_args(pa, ca, aliases=FLAG_ALIASES.get(cn))
                if r == "match":
                    return r
                best = best or r
        return best

    def match_config(self, inv, state, here_unknown):
        ctx = self.ctx
        for p in ctx.deny_pats:
            if p.multi or not p.segs:
                continue
            r = self.match_inv(p.segs[0], inv)
            if r == "match":
                self.deny("`%s` is forbidden by the project's gate (gate-config.json deny)" % p.text)
            elif r == "possible":
                self.ask("`%s` builds arguments at run time and might match the deny rule `%s` "
                         "— confirm" % (short(inv.seg.text, 60), p.text))
        for p in ctx.ask_pats:
            if p.multi or not p.segs:
                continue
            if self.match_inv(p.segs[0], inv):
                self.ask("`%s` is a gated command — confirm first (gate-config.json ask)" % p.text)
        for p in ctx.branch_pats:
            if p.multi or not p.segs:
                continue
            if not self.match_inv(p.segs[0], inv):
                continue
            gated = self.branch_gated(state, here_unknown)
            why = "the branch is the default branch or can't be determined"
            if inv.push is not None and (inv.push_touches or inv.push_unknown):
                gated = True
                why = "the push reaches the default branch (or its destination is unknown)"
            if gated:
                self.ask("`%s` is gated on the default branch %s and %s — confirm "
                         "(it runs freely on feature branches)"
                         % (p.text, "/".join("`%s`" % d for d in ctx.defaults()[:2]), why))

    def multi_patterns(self, segs, invs, state):
        def ns(s):
            return ";" if s in (";", "\n", None) else s
        tiers = [("deny", self.ctx.deny_pats), ("ask", self.ctx.ask_pats),
                 ("branch", self.ctx.branch_pats)]
        for tier, pats in tiers:
            for p in pats:
                if not p.multi:
                    continue
                k = len(p.segs)
                for start in range(0, len(segs) - k + 1):
                    ok = True
                    for j, ps in enumerate(p.segs):
                        if not self.match_inv(ps, invs[start + j]):
                            ok = False
                            break
                        if j < k - 1 and ns(segs[start + j].sep) != ns(ps.sep):
                            ok = False
                            break
                    if not ok:
                        continue
                    if tier == "deny":
                        self.deny("`%s` is forbidden by the project's gate" % p.text)
                    elif tier == "ask" or self.branch_gated(state, False):
                        self.ask("`%s` is a gated command sequence — confirm" % p.text)
                    break

    # -- indirection ---------------------------------------------------------------
    def indirection(self, inv, seg, prev, prev_inv, state, depth):
        name, args = inv.name, inv.args
        if name in SHELLS:
            code, script, sargs = self.shell_args(args)
            if code is not None:
                if code.dynamic:
                    self.opaque("`%s -c` runs a command string built at run time" % name, code.raw)
                else:
                    self.analyze_text(code.value, state.copy(), depth + 1)
            elif script is not None:
                self.run_script(name, script, sargs, state, depth)
            else:
                self.stdin_code(name, "sh", seg, prev, prev_inv, state, depth)
            return
        if name == "preflight.sh":
            self.preflight_args(args, state, depth)
            return
        if name == "eval":
            text = " ".join(a.value for a in args)
            if any(a.dynamic for a in args):
                self.opaque("`eval` of a string built at run time", " ".join(a.raw for a in args))
            else:
                self.analyze_text(text, state, depth + 1)
            return
        if name in ("source", "."):
            if args:
                self.run_script(name, args[0], args[1:], state, depth)
            return
        if INTERP_RE.match(name):
            lang = lang_of(name)
            code, has_script = self.interp_code(name, args)
            if code is not None:
                self.code_check(lang, code.raw if code.dynamic else code.value, state, depth)
            elif not has_script:
                self.stdin_code(name, lang, seg, prev, prev_inv, state, depth)
            return
        if name in ("xargs",):
            k = 0
            with_arg = {"-I", "-L", "-l", "-n", "-P", "-s", "-d", "-E", "-e", "-a",
                        "--max-args", "--delimiter", "--arg-file", "--max-procs", "--replace",
                        "--max-lines", "--max-chars", "--eof"}
            while k < len(args) and args[k].value.startswith("-") and not args[k].dynamic:
                k += 2 if args[k].value in with_arg else 1
            rest = args[k:] or [static_word("echo")]
            self.synthetic(rest + [wildcard_word()], seg, state, depth)
            return
        if name == "find":
            k = 0
            while k < len(args):
                v = args[k].value
                if v in ("-exec", "-execdir", "-ok", "-okdir"):
                    j = k + 1
                    while j < len(args) and args[j].value not in (";", "+"):
                        j += 1
                    if j > k + 1:
                        self.synthetic(args[k + 1:j], seg, state, depth)
                    k = j
                k += 1
            return
        if name == "watch":
            k = 0
            while k < len(args) and args[k].value.startswith("-"):
                k += 2 if args[k].value in ("-n", "--interval", "-d") else 1
            if k < len(args):
                if any(a.dynamic for a in args[k:]):
                    self.opaque("`watch` runs a command built at run time", seg.text)
                else:
                    self.analyze_text(" ".join(a.value for a in args[k:]), state.copy(), depth + 1)
            return
        if name in ("su", "runuser"):
            for k, a in enumerate(args):
                if a.value in ("-c", "--command") and k + 1 < len(args):
                    c = args[k + 1]
                    if c.dynamic:
                        self.opaque("`su -c` runs a command built at run time", c.raw)
                    else:
                        self.analyze_text(c.value, state.copy(), depth + 1)
            return
        if name == "trap" and args:
            a = args[0]
            if a.dynamic:
                self.opaque("`trap` installs a command built at run time", a.raw)
            elif a.value not in ("-", "") and not a.value.startswith("-"):
                self.analyze_text(a.value, state.copy(), depth + 1)
            return
        if name == "alias":
            for a in args:
                if "=" in a.value:
                    val = a.value.split("=", 1)[1]
                    if a.dynamic:
                        self.opaque("an alias is defined from a run-time value", a.raw)
                    elif val:
                        self.analyze_text(val, state.copy(), depth + 1)
            return
        if name in ("npx", "bunx", "pnpx"):
            for k, a in enumerate(args):
                if a.value in ("-c", "--call") and k + 1 < len(args):
                    c = args[k + 1]
                    if c.dynamic:
                        self.opaque("`npx -c` runs a command built at run time", c.raw)
                    else:
                        self.analyze_text(c.value, state.copy(), depth + 1)

    def synthetic(self, words, seg, state, depth):
        s = Seg(seg.src, seg.start, False)
        s.end = seg.end
        s.words = list(words)
        s.sep = seg.sep
        self.eval_segment(s, None, None, state.copy(), depth + 1)

    def shell_args(self, args):
        code_next = False
        k = 0
        while k < len(args):
            a = args[k]
            v = a.value
            if a.dynamic and not code_next:
                return None, a, args[k + 1:]
            if code_next:
                return a, None, args[k + 1:]
            if v == "--" or v == "-":
                k += 1
                break
            if v in ("-o", "+o", "-O", "+O", "--rcfile", "--init-file"):
                k += 2
                continue
            if v.startswith("--"):
                k += 1
                continue
            if len(v) > 1 and v[0] in "-+":
                if v[0] == "-" and "c" in v[1:]:
                    code_next = True
                k += 1
                continue
            break
        if code_next:
            return (args[k] if k < len(args) else static_word("")), None, args[k + 1:]
        if k < len(args):
            return None, args[k], args[k + 1:]
        return None, None, []

    def run_script(self, name, script, sargs, state, depth):
        if script.dynamic:
            self.opaque("`%s` runs a script whose path is computed at run time" % name, script.raw)
            return
        if self.path_key(script, state) in state.written:
            self.opaque("`%s` runs a file written earlier in this same command" % name,
                        script.value)
            return
        if cmd_name(script.value) == "preflight.sh":
            self.preflight_args(sargs, state, depth)

    def preflight_args(self, args, state, depth):
        """preflight.sh <report> "<cmd>"…: it truncates <report>, and runs each cmd via sh -c."""
        if not args:
            return
        self.check_path(args[0], state, "write", "preflight.sh's report argument")
        for a in args[1:]:
            if a.dynamic:
                self.opaque("preflight.sh runs a check command built at run time", a.raw)
            else:
                self.analyze_text(a.value, state.copy(), depth + 1)

    def interp_code(self, name, args):
        lang = lang_of(name)
        k = 0
        while k < len(args):
            a = args[k]
            v = a.value
            if a.dynamic:
                return None, True
            if lang == "py":
                if v.startswith("-") and not v.startswith("--") and "c" in v[1:]:
                    i = v.index("c", 1)
                    rest = v[i + 1:]
                    if rest:
                        return static_word(rest), False
                    return (args[k + 1] if k + 1 < len(args) else static_word("")), False
                if v in ("-m",) or (v.startswith("-m") and len(v) > 2):
                    return None, True
                if v in ("-W", "-X", "-Q"):
                    k += 2
                    continue
                if v == "-":
                    return None, False
            elif lang == "js":
                if v in ("-e", "--eval", "-p", "--print") or v.startswith("--eval=") \
                        or v.startswith("--print="):
                    if "=" in v:
                        return static_word(v.split("=", 1)[1]), False
                    return (args[k + 1] if k + 1 < len(args) else static_word("")), False
                if name == "deno" and v == "eval":
                    return (args[k + 1] if k + 1 < len(args) else static_word("")), False
                if v in ("-r", "--require", "--import", "--loader", "-C", "--conditions"):
                    k += 2
                    continue
                if name in ("deno", "bun") and not v.startswith("-"):
                    return None, True
            else:
                letters = {"php": "r", "ruby": "e"}.get(name, "eE")
                if v.startswith("-") and not v.startswith("--") and any(c in v[1:] for c in letters):
                    j = min(v.index(c, 1) for c in letters if c in v[1:])
                    rest = v[j + 1:]
                    if rest and not rest.startswith("."):
                        return static_word(rest), False
                    return (args[k + 1] if k + 1 < len(args) else static_word("")), False
            if v == "--":
                return None, k + 1 < len(args)
            if not v.startswith("-"):
                return None, True
            k += 1
        return None, False

    def code_check(self, lang, code, state, depth):
        if PROTECTED_NAME_RE.search(code):
            self.ask("inline code references a file the Cohorte gate depends on (gate config, "
                     "settings or preflight stamp) — confirm it only reads it")
        if not SPAWN_RE[lang].search(code):
            return
        joined = re.sub(r"(['\"])\s*\+\s*\1", "", code)
        for m in STRING_LIT_RE.finditer(joined):
            lit = m.group(1) if m.group(1) is not None else m.group(2)
            if lit and " " in lit:
                self.analyze_text(lit, state.copy(), depth + 1)
        self.opaque("inline code starts processes", joined)

    def stdin_code(self, name, lang, seg, prev, prev_inv, state, depth):
        def feed(text, static):
            if lang == "sh":
                if static:
                    self.analyze_text(text, state.copy(), depth + 1)
                else:
                    self.opaque("`%s` reads commands built at run time" % name, text)
            else:
                self.code_check(lang, text, state, depth)

        for h in seg.heredocs:
            feed(h.body, True)
            return
        for r in seg.redirs:
            if r.op == "<<<":
                feed(r.target.raw if r.target.dynamic else r.target.value, not r.target.dynamic)
                return
            if r.op == "<":
                if r.target.dynamic or self.path_key(r.target, state) in state.written:
                    self.opaque("`%s` reads commands from a file written or computed in this "
                                "same command" % name, seg.text)
                return
        if prev is not None and prev.sep in ("|", "|&"):
            if prev_inv is not None and prev_inv.name in ("echo", "printf") \
                    and not any(a.dynamic for a in prev_inv.args):
                vals = [a.value for a in prev_inv.args]
                if prev_inv.name == "echo":
                    while vals and re.match(r"^-[neE]+$", vals[0]):
                        vals.pop(0)
                    text = " ".join(vals)
                else:
                    text = vals[0] if vals else ""
                    for v in vals[1:]:
                        text = text.replace("%s", v, 1) if "%s" in text else text + " " + v
                    text = text.replace("\\n", "\n")
                feed(text, True)
            else:
                self.opaque("`%s` executes whatever the pipe feeds it" % name,
                            prev.text + " | " + seg.text)

    # -- self-protection --------------------------------------------------------------
    def path_key(self, w, state):
        v = os.path.expanduser(w.value)
        if not os.path.isabs(v) and state.cwd_known:
            v = os.path.join(state.cwd, v)
        return os.path.normpath(v)

    def remember_written(self, w, state):
        if not w.dynamic:
            state.written.add(self.path_key(w, state))

    def classify_path(self, w, state, mode, relocated=False):
        ctx = self.ctx
        if w.dynamic:
            t = w.raw
            if len(t) >= 2 and t[0] == t[-1] == '"':
                t = t[1:-1]
            for var, val in (("CLAUDE_PROJECT_DIR", os.environ.get("CLAUDE_PROJECT_DIR")),
                             ("HOME", os.path.expanduser("~")),
                             ("PWD", state.cwd if state.cwd_known else None)):
                if val:
                    t = t.replace("${%s}" % var, val).replace("$" + var, val)
            if "$" in t or "`" in t or "'" in t or '"' in t or "\\" in t:
                return "suspect" if PROTECTED_HINT_RE.search(w.raw) else None
            w = static_word(t)
        v = os.path.expanduser(w.value)
        if not v:
            return None
        if not os.path.isabs(v):
            if relocated or not state.cwd_known:
                return "suspect" if PROTECTED_HINT_RE.search(v) else None
            v = os.path.join(state.cwd, v)
        prot = ctx.delete_protected if mode in ("delete", "recursive", "chmod") else ctx.protected
        targets = [v]
        if w.glob:
            pat = os.path.normpath(v)
            if any(fnmatch.fnmatchcase(p, pat) for p in prot):
                return "protected"
            try:
                targets = glob.glob(v)[:500]
            except Exception:
                targets = []
        for t in targets:
            for cand in {os.path.normpath(os.path.abspath(t)), os.path.realpath(t)}:
                if cand in prot:
                    return "protected"
                if mode in ("delete", "recursive", "chmod"):
                    pre = cand if cand.endswith(os.sep) else cand + os.sep
                    if any(p.startswith(pre) for p in prot):
                        return "protected" if mode == "delete" else "suspect"
        return None

    def check_path(self, w, state, mode, via, relocated=False):
        kind = self.classify_path(w, state, mode, relocated)
        if kind is None:
            return
        verb = {"write": "overwrite", "delete": "delete or move", "recursive": "overwrite",
                "chmod": "change the permissions of"}[mode]
        if kind == "protected" and mode in ("write", "delete"):
            self.deny("%s would %s `%s`, which the Cohorte gate depends on (self-protection). "
                      "Edit gate rules through PIPELINE.md and /cohorte-update-pipeline, or ask "
                      "the human" % (via, verb, w.raw))
        else:
            self.ask("%s may %s a file the Cohorte gate depends on (`%s`) — confirm"
                     % (via, verb, w.raw))

    def protect(self, inv, state, relocated):
        name, args = inv.name, inv.args

        def positionals(tokens, with_arg=()):
            out = []
            end = False
            k = 0
            while k < len(tokens):
                w = tokens[k]
                v = w.value
                if not end and v == "--":
                    end = True
                elif not end and is_flag_word(w):
                    if v in with_arg:
                        k += 1
                else:
                    out.append(w)
                k += 1
            return out

        def recursive(tokens):
            fl = flag_names(tokens)
            return bool(fl & {"-r", "-R", "-a", "--recursive", "--archive"})

        def copy_like(srcs, dst, label, mv=False):
            for s in srcs:
                if mv:
                    self.check_path(s, state, "delete", "`%s`" % label, relocated)
            self.check_path(dst, state, "write", "`%s`" % label, relocated)
            dk = self.path_key(dst, state) if not dst.dynamic else None
            if dk and state.cwd_known and (os.path.isdir(dk) or dst.value.endswith("/")):
                for s in srcs:
                    if not s.dynamic:
                        self.check_path(static_word(os.path.join(dk, os.path.basename(
                            s.value.rstrip("/")))), state, "write", "`%s`" % label, relocated)
                if recursive(args) or mv:
                    self.check_path(dst, state, "recursive", "`%s`" % label, relocated)

        if name in ("rm", "unlink", "shred", "rmdir", "srm", "trash", "trash-put"):
            for p in positionals(args):
                self.check_path(p, state, "delete", "`%s`" % name, relocated)
        elif name in ("mv", "cp", "install", "ln", "rsync", "scp", "ditto"):
            pos = positionals(args, ("-t", "--target-directory", "-S", "--suffix", "-m",
                                     "--mode", "-o", "-g", "-e", "--exclude", "--include"))
            target = None
            for k, w in enumerate(args):
                if w.value in ("-t", "--target-directory") and k + 1 < len(args):
                    target = args[k + 1]
                elif w.value.startswith("--target-directory="):
                    target = static_word(w.value.split("=", 1)[1])
            if target is not None:
                copy_like(pos, static_word(target.value.rstrip("/") + "/")
                          if not target.dynamic else target, name, mv=(name == "mv"))
            elif len(pos) >= 2:
                copy_like(pos[:-1], pos[-1], name, mv=(name == "mv"))
        elif name == "tee":
            for p in positionals(args):
                self.check_path(p, state, "write", "`tee`", relocated)
                self.remember_written(p, state)
        elif name == "truncate":
            for p in positionals(args, ("-s", "-r", "--size", "--reference")):
                self.check_path(p, state, "write", "`truncate`", relocated)
        elif name in ("sed", "gsed", "perl", "ruby"):
            inplace = any(
                not w.dynamic and (w.value.startswith("--in-place") or (
                    w.value.startswith("-") and not w.value.startswith("--")
                    and "i" in w.value[1:].split(".")[0]))
                for w in args)
            if inplace:
                for p in positionals(args, ("-e", "-f")):
                    self.check_path(p, state, "write", "`%s -i`" % name, relocated)
        elif name == "dd":
            for w in args:
                if w.value.startswith("of="):
                    self.check_path(static_word(w.value[3:]) if not w.dynamic else w,
                                    state, "write", "`dd of=`", relocated)
        elif name in ("curl", "wget"):
            opts = ("-o", "--output") if name == "curl" else ("-O", "--output-document")
            for k, w in enumerate(args):
                v = w.value
                if v in opts and k + 1 < len(args):
                    self.check_path(args[k + 1], state, "write", "`%s %s`" % (name, v), relocated)
                elif any(v.startswith(o + "=") for o in opts if o.startswith("--")):
                    self.check_path(static_word(v.split("=", 1)[1]), state, "write",
                                    "`%s`" % name, relocated)
        elif name in ("chmod", "chown", "chgrp", "chflags", "chattr", "setfacl"):
            for p in positionals(args)[1:]:
                self.check_path(p, state, "chmod", "`%s`" % name, relocated)
        elif name == "find" and any(w.value == "-delete" for w in args):
            for w in args:
                if w.value.startswith("-") or w.value in ("(", "!", ")"):
                    break
                self.check_path(w, state, "delete", "`find -delete`", relocated)
        elif name == "git" and inv.git and inv.git.sub in ("rm", "mv"):
            g = inv.git
            pos = positionals(g.args)
            reloc = relocated or g.relocated
            if g.sub == "rm" and not any(w.value == "--cached" for w in g.args):
                for p in pos:
                    self.check_path(p, state, "delete", "`git rm`", reloc)
            elif g.sub == "mv" and len(pos) >= 2:
                for p in pos[:-1]:
                    self.check_path(p, state, "delete", "`git mv`", reloc)
                self.check_path(pos[-1], state, "write", "`git mv`", reloc)

    # -- chain state -----------------------------------------------------------------
    def update_state(self, inv, seg, state, assigns):
        name, args = inv.name, inv.args
        if name == "cd":
            sep = seg.sep
            if sep in ("|", "|&", "&"):
                return
            if sep == "||":
                state.cwd_known = False
                return
            pos = [w for w in args if not (is_flag_word(w) and w.value in ("-L", "-P", "-e", "-@"))]
            if pos and pos[0].value == "--" and not pos[0].dynamic:
                pos = pos[1:]
            if not pos:
                target = os.path.expanduser("~")
            else:
                w = pos[0]
                if w.value == "-" and not w.dynamic:
                    state.cwd_known = False
                    return
                if w.dynamic:
                    k = self.classify_dynamic_dir(w, state)
                    if k is None:
                        state.cwd_known = False
                        return
                    target = k
                else:
                    target = os.path.expanduser(w.value)
            if not os.path.isabs(target):
                if not state.cwd_known:
                    return
                target = os.path.join(state.cwd, target)
            if os.path.isdir(target):
                state.cwd = os.path.realpath(target)
                state.cwd_known = True
            else:
                state.cwd_known = False
            return
        if name in ("pushd", "popd"):
            state.cwd_known = False
            state.sticky = True
            return
        if name in ("export", "declare", "typeset", "readonly", "local"):
            for a in args:
                m = ASSIGN_RE.match(a.raw) or re.match(r"^([A-Za-z_][A-Za-z0-9_]*)$", a.raw)
                if m and m.group(1) in GIT_ENV_VARS:
                    state.sticky = True
            return
        if name == "git" and inv.git:
            g = inv.git
            if g.relocated:
                state.sticky = True
            sub = g.sub
            if sub in ("switch", "bisect"):
                state.sticky = True
            elif sub == "checkout" and not any(w.value == "--" for w in g.args):
                state.sticky = True
            elif sub == "branch" and (flag_names(g.args) & {"-m", "-M", "--move"}):
                state.sticky = True

    def classify_dynamic_dir(self, w, state):
        t = w.raw
        if len(t) >= 2 and t[0] == t[-1] == '"':
            t = t[1:-1]
        for var, val in (("CLAUDE_PROJECT_DIR", os.environ.get("CLAUDE_PROJECT_DIR")),
                         ("HOME", os.path.expanduser("~"))):
            if val:
                t = t.replace("${%s}" % var, val).replace("$" + var, val)
        if "$" in t or "`" in t or "'" in t or '"' in t or "\\" in t:
            return None
        return t


# ── preflight phase gate ─────────────────────────────────────────────────────
HEX_RE = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
DIGEST_EXCLUDES = (".claude", "specs")
LEGACY_EXCLUDES = (".claude", ".cohorte", "specs")


def tree_digest(cwd, excludes):
    """The digest preflight.sh stamps: the git tree id of the working tree at `cwd`, built in
    a throwaway index seeded from the real one (backdated so same-second edits are
    re-hashed), with `excludes` dropped. Must stay identical to preflight.sh.
    Returns the tree id, None on failure; raises TimedOut when the budget is spent."""
    tmp = None
    try:
        r = run_git(["rev-parse", "--absolute-git-dir"], cwd, raise_timeout=True)
        if not r or r[0] != 0:
            return None
        real_index = os.path.join(r[1].strip(), "index")
        fd, tmp = tempfile.mkstemp(prefix="cohorte-idx-")
        os.close(fd)
        if os.path.exists(real_index):
            shutil.copyfile(real_index, tmp)
            old = time.time() - 5
            os.utime(tmp, (old, old))
        else:
            os.unlink(tmp)
        env = git_env({"GIT_INDEX_FILE": tmp})
        run_git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"] + list(excludes),
                cwd, timeout=10, env=env, raise_timeout=True)
        add = run_git(["add", "-A", "--", "."] + [":(exclude)%s" % e for e in excludes],
                      cwd, timeout=30, env=env, raise_timeout=True)
        if not add or add[0] != 0:
            return None
        out = run_git(["write-tree"], cwd, timeout=10, env=env, raise_timeout=True)
        if not out or out[0] != 0:
            return None
        return out[1].strip() or None
    finally:
        for p in ((tmp, tmp + ".lock") if tmp else ()):
            try:
                os.unlink(p)
            except Exception:
                pass


class Dispatch(object):
    def __init__(self, ctx):
        self.ctx = ctx
        self._digests = None

    def current_digests(self, cwd, top):
        """Digests of the dispatch checkout: at its toplevel and at cwd (preflight.sh digests
        relative to its pwd), with today's and the legacy (.cohorte-excluding) excludes."""
        if self._digests is None:
            out = set()
            dirs = [top] + ([cwd] if cwd and cwd != top else [])
            variants = [DIGEST_EXCLUDES]
            if any(os.path.exists(os.path.join(d, ".cohorte")) for d in dirs):
                variants.append(LEGACY_EXCLUDES)
            try:
                for d in dirs:
                    for ex in variants:
                        dg = tree_digest(d, ex)
                        if dg:
                            out.add(dg)
            except TimedOut:
                self._digests = "timeout"
                return self._digests
            self._digests = out
        return self._digests

    def check_stamp(self, path, cwd, top, max_age):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                raw = fh.read(4096)
        except Exception:
            return "the preflight stamp can't be read"
        fields = raw.split()
        if not fields:
            return "the preflight stamp is empty"
        try:
            epoch = float(fields[0])
            if epoch != epoch or epoch in (float("inf"), float("-inf")):
                raise ValueError()
        except ValueError:
            return "the preflight stamp is unreadable (expected `<epoch> <sha> <digest>`)"
        now = time.time()
        if epoch > now + 60:
            return "the preflight stamp is dated in the future (forged, or a clock problem)"
        if max_age <= 0:
            return "preflight.max_age_minutes is 0, so every stamp counts as stale"
        age_min = (now - epoch) / 60
        if age_min > max_age:
            return "the preflight stamp is %.0f min old (max %g)" % (age_min, max_age)
        if top is None:
            return None        # not a git checkout: freshness is all that can be checked
        if len(fields) < 3:
            return ("the preflight stamp has no content digest (a legacy or hand-written stamp "
                    "— expected `<epoch> <sha> <digest>`)")
        digest = fields[2].lower()
        if digest == "none" or not HEX_RE.match(digest):
            return "the preflight stamp has no valid content digest"
        current = self.current_digests(cwd, top)
        if current == "timeout":
            return "the code digest could not be computed within the gate's time budget"
        if not current:
            return "the current code digest could not be computed"
        if digest not in current:
            return ("the code changed since the preflight ran (or the stamp was made for "
                    "another checkout)")
        return None

    def evaluate(self, tool_input, cwd):
        ctx = self.ctx
        sub = tool_input.get("subagent_type")
        if sub is None:
            sub = tool_input.get("agent_type", "")
        if sub is None:
            sub = ""
        if not isinstance(sub, str):
            raise TypeError("tool_input.subagent_type is not a string")
        if ctx.errors:
            return ("ask", "gate-config.json is invalid (%s), so the preflight phase gate can't be "
                    "evaluated — fix it, then confirm this dispatch" % "; ".join(ctx.errors))
        pf = ctx.cfg["preflight"]
        if not pf or not pf["enabled"] or not sub:
            return None
        if not any(sub == a or sub.endswith(":" + a) for a in pf["agents"]):
            return None
        top = None
        if cwd:
            top = git_top_and_common(cwd)[0]
        if top is None and remaining() <= 0.05:
            why = "the checkout could not be inspected within the gate's time budget"
            return ("ask", "Phase gate: dispatching `%s`, but %s — confirm to dispatch anyway."
                    % (sub, why))
        cands = []
        for d in ([top] if top else []) + ctx.roots:
            p = os.path.join(d, ".claude", "preflight.ok")
            if os.path.isfile(p) and p not in cands:
                cands.append(p)
        if not cands:
            why = "no preflight stamp was found (.claude/preflight.ok)"
        else:
            why = None
            for p in cands:
                r = self.check_stamp(p, cwd, top, pf["max_age_minutes"])
                if r is None:
                    return None
                why = why or r
        return ("ask", "Phase gate: dispatching `%s`, but %s. Run the deterministic pre-flight "
                "first (<core>/pipeline/scripts/preflight.sh — typecheck + lint + tests, from this "
                "checkout) so agents never review red code, or confirm to dispatch anyway "
                "(PIPELINE.md gate.preflight)." % (sub, why))


# ── entry points ─────────────────────────────────────────────────────────────
DISPATCH_TOOLS = {"Task", "Agent"}
EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
GATED_TOOLS = {"Bash"} | DISPATCH_TOOLS | EDIT_TOOLS
UNATTENDED_MODES = {"bypassPermissions", "dontAsk"}


class PayloadError(Exception):
    pass


def default_cwd():
    env = os.environ.get("CLAUDE_PROJECT_DIR") or ""
    if env and os.path.isdir(env):
        return env
    try:
        return os.getcwd()
    except Exception:
        return None


def evaluate(payload):
    """The decision for one PreToolUse payload: None (allow) or (decision, reason)."""
    tool = payload.get("tool_name")
    if not isinstance(tool, str):
        raise PayloadError("tool_name is missing or not a string")
    if tool not in GATED_TOOLS:
        return None
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        cwd = default_cwd()
    mode = payload.get("permission_mode")
    if not isinstance(mode, str):
        mode = None
    ctx = Ctx(cwd, mode)
    if not ctx.active:
        return None
    ti = payload.get("tool_input")
    if not isinstance(ti, dict):
        raise PayloadError("tool_input is not an object")
    decision = None
    if tool == "Bash":
        cmd = ti.get("command")
        if not isinstance(cmd, str):
            raise PayloadError("tool_input.command is not a string")
        an = Analyzer(ctx)
        an.analyze_text(cmd, State(ctx.cwd0), 0)
        decision = an.verdict()
        if ctx.errors and (decision is None or decision[0] != "deny"):
            decision = ("ask", "gate-config.json is invalid (%s), so every command needs "
                        "confirmation until it is fixed (the hard floor and self-protection "
                        "still apply)" % "; ".join(ctx.errors))
    elif tool in DISPATCH_TOOLS:
        decision = Dispatch(ctx).evaluate(ti, ctx.cwd0)
    else:
        fp = ti.get("file_path")
        if fp is None:
            fp = ti.get("notebook_path")
        if isinstance(fp, str) and fp:
            p = fp if os.path.isabs(fp) else os.path.join(ctx.cwd0 or ".", fp)
            p = os.path.expanduser(p)
            if os.path.normpath(p) in ctx.protected or os.path.realpath(p) in ctx.protected:
                decision = ("ask", "`%s` edits `%s`, a file the Cohorte gate depends on "
                            "(self-protection) — confirm this change is intended" % (tool, fp))
    if decision is None:
        return None
    level, reason = decision
    if level == "ask" and mode in UNATTENDED_MODES:
        level = "deny"
        reason += (" (denied outright: permission mode `%s` has nobody to confirm — re-run it "
                   "interactively if it is intended)" % mode)
    return level, "Cohorte gate: " + reason


def emit(decision, reason):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}) + "\n")


def is_active_fallback(payload=None):
    try:
        cwd = None
        if isinstance(payload, dict) and isinstance(payload.get("cwd"), str) \
                and os.path.isdir(payload["cwd"]):
            cwd = payload["cwd"]
        return Ctx(cwd or default_cwd(), None).active
    except Exception:
        return True


def hook(raw):
    try:
        payload = json.loads(raw) if raw and raw.strip() else None
    except Exception:
        payload = None
    if not isinstance(payload, dict):
        # Not a payload at all ⇒ nothing to gate. Something that looks like a tool call we
        # can't read ⇒ refuse it in an active project (fail closed).
        if re.search(r'"tool_(name|input)"', raw or "") and is_active_fallback():
            emit("deny", "Cohorte gate: the hook payload is not valid JSON, so this tool call "
                 "can't be checked — refused for safety (fail closed).")
        return 0
    tool = payload.get("tool_name")
    try:
        decision = evaluate(payload)
    except Exception as e:
        if (not isinstance(tool, str) or tool in ("Bash",) or tool in DISPATCH_TOOLS) \
                and is_active_fallback(payload):
            emit("deny", "Cohorte gate failed closed: this call could not be evaluated "
                 "(%s: %s). Refused for safety." % (type(e).__name__, e))
        return 0
    if decision:
        emit(*decision)
    return 0


def check_cli(argv):
    mode = argv[0]
    rest = argv[1:]
    cwd = os.getcwd()
    unattended = False
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--":
            i += 1
            break
        if a == "--unattended":
            unattended = True
        elif a == "--cwd" and i + 1 < len(rest):
            cwd = rest[i + 1]
            i += 1
        elif a.startswith("--cwd="):
            cwd = a[6:]
        else:
            break
        i += 1
    words = rest[i:]
    if not words:
        sys.stderr.write("usage: cohorte-gate.py %s [--cwd DIR] [--unattended] [--] <%s>\n"
                         % (mode, "command" if mode == "--check" else "subagent_type"))
        return 2
    subject = words[0] if len(words) == 1 else " ".join(shlex.quote(w) for w in words)
    payload = {"cwd": os.path.abspath(cwd),
               "permission_mode": "bypassPermissions" if unattended else "default"}
    if mode == "--check":
        payload["tool_name"] = "Bash"
        payload["tool_input"] = {"command": subject}
    else:
        payload["tool_name"] = "Agent"
        payload["tool_input"] = {"subagent_type": subject}
    try:
        decision = evaluate(payload)
    except Exception as e:
        decision = ("deny", "Cohorte gate failed closed: %s: %s" % (type(e).__name__, e))
    if not decision:
        print("gate: allow")
        return 0
    print("gate: %s — %s" % decision)
    return 2 if decision[0] == "deny" else 1


def strip_runtime(argv):
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--runtime" and i + 1 < len(argv):
            rt = argv[i + 1]
            i += 2
        elif a.startswith("--runtime="):
            rt = a[10:]
            i += 1
        else:
            out.append(a)
            i += 1
            continue
        if rt != "claude":
            warn("--runtime %s is no longer supported (Cohorte 3 is Claude Code only); "
                 "answering in Claude Code's format" % rt)
    return out


def main():
    argv = sys.argv[1:]
    if argv and argv[0] in ("--check", "--check-dispatch"):
        return check_cli(argv)
    argv = strip_runtime(argv)
    if argv and argv[0] in ("--check", "--check-dispatch"):
        return check_cli(argv)
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    return hook(raw)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as e:   # last resort: a crash must not read as "allow"
        try:
            emit("deny", "Cohorte gate crashed (%s: %s) — refused for safety." % (type(e).__name__, e))
        except Exception:
            pass
        sys.exit(0)
