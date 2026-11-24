#!/usr/bin/env python3
# GENERATED from core/hooks/gate/*.py by scripts/build-gate.mjs — edit the modules, then run
# `node scripts/build-gate.mjs`. validate-core fails when this file and the modules disagree.
# Build order: runtime, shell, git, config, ownership, patterns, approve, context, findings,
# rules, protect, indirect, analyze, preflight, evaluate, main.
"""Cohorte PreToolUse gate for Claude Code (3.0 — Claude Code only).

Installed per project as `.claude/hooks/cohorte-gate.py` and registered in the project's
`.claude/settings.json` as a PreToolUse hook:

    python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py"     matcher: Bash|Task|Agent
                                                                    and: Write|Edit|MultiEdit

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
   deleting `.claude/pipeline.json` or a directory that contains any of them, and to
   `git checkout`/`git restore` of them (`git reset --hard`, and `.`/directory/glob/`:/`
   pathspecs, count only when git reports one of them differs from what is restored). A
   Write/Edit/MultiEdit/NotebookEdit call aimed at one of them gets "ask".
   The machine-wide install is never an agent's to write — every project runs it unprompted:
   `<config>/cohorte/` (the core: lib/, the allowlisted pipeline/scripts/, …),
   `<config>/cohorte-ui/` (cohorte ui's runs, tickets, settings) and `<config>/commands/
   cohorte-*.md`, `agents/cohorte-*.md`, `workflows/cohorte-*.js`, for `<config>` =
   `$CLAUDE_CONFIG_DIR` and `~/.claude`, through a symlink too. An edit tool there is denied, and
   so is every Bash write form above plus touch/mkdir, archive extraction (`tar -C`, `unzip -d`,
   the current folder), a link to a file there (`ln`, `cp -l/-s`), a non-read-only git command
   in it (`git -C`, `--work-tree`, after `cd`) and `git clone/init/worktree add` into it; a
   path or inline code that may name it at run time gets "ask". So are verify-run.sh's
   `--out`/`<id>` outputs and kanban-move.sh's board there (the scripts refuse it too).
   `cohorte install`/`update`, run by the human, is how it changes.
   Inside a cohorte run (COHORTE_RUN_ID in the hook's environment, even empty): a state-changing
   `cohorte` verb, unsetting or overriding COHORTE_*, and pseudo-terminal helpers are denied
   (protect.py run_guard). Parsing cannot see into interpreters: nothing a person decides rests on it alone.
4. Project rules from `.claude/gate-config.json` (`deny` / `ask` / `ask_on_default_branch`).
   These are matched as tokens, not substrings (see "Matching").
5. Preflight phase gate: a Task/Agent dispatch of a listed subagent needs a fresh
   `.claude/preflight.ok` stamp whose content digest equals the dispatch checkout's.
6. Surface ownership: a subagent (payload `agent_id`) whose `agent_type` is a surface agent
   of `.claude/profile.json` is denied a Write/Edit/MultiEdit/NotebookEdit outside its
   `surfaces[].path` (+ its `owns_also`, + `ownership.shared_writable`) and any write to the
   contract (`contract.path`/`contract.index`). Its Bash writes get the same check, best
   effort, through the self-protection target analysis (redirections, cp/mv/rm, tee, sed -i,
   …). The lead, the fixed cohorte-* agents and unknown agent types are not restricted; no
   profile.json or `ownership.enforce: false` ⇒ inert. Only targets inside a project
   checkout are judged.

Matching. The command is lexed like a shell does it: quotes, escapes, `\\`-newline
continuations, comments, heredocs (bodies are data unless fed to a shell), `$(…)`,
backticks, `<(…)`, subshells, `case` clauses, `[[ … ]]`, redirections, and the separators
`; && || | |& &` and newline.
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

`$HOME`, `${HOME}`, `~` and `$CLAUDE_CONFIG_DIR` (also `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`)
are the user's own environment: they are expanded from the hook's environment before
anything is judged — never as a bare command name, and not at all in a command that names the
variable other than as an expansion (even as `HO\\ME=`) or uses a builtin that assigns a
computed name (`export`, `declare`, `read`, `printf -v`, `eval`, `source`, `let`, …). A
quoted run-time word is matched by its static parts: `"$m:fresh"` may be `migration:fresh`,
`"$S/x.mjs"` can't be `ace`. An unquoted expansion field-splits, so it may be any words. A
quoted command name whose directory alone is computed (`"$S/smoke.sh"`) is judged by its
basename.

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
chained with `&&` or `;` is followed (never through `|`). So is a branch creation with a
static name chained with `&&` (`git switch -c <name> && …`, `git checkout -b <name> && …`):
the rest of the chain is on `<name>`. For `git push`, the destination
also counts: `src:dst`, `HEAD`, the upstream/push target of a bare push, `--all`/`--mirror`.

Permission modes. In `bypassPermissions` and `dontAsk` nobody answers a prompt, so every
"ask" becomes a "deny" with the reason attached and what a human can do to allow it. `default`, `acceptEdits` and `plan` keep
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

It prints `gate: allow` / `gate: ask — …` / `gate: deny — …` / `gate: defer — …` and exits
0 / 1 / 2 / 3. `--check` answers allow only for a command the gate approves: no rule denies or
asks, and it is a command of `.claude/profile.json` or covered by a permissions.allow rule (see
"Pipeline scripts"), or the gate is inert there. Defer (3) means no gate rule matched, so only
Claude Code's permission would decide: a script about to run the command unprompted must treat
it as an ask. Options are only read before the command (or before `--`).

Pipeline scripts. `preflight.sh` and `verify-run.sh` execute the commands they are handed, and
Claude Code approves the outer call through the allowlisted `<core>/pipeline/scripts/`. Each
handed command is judged like any command (deny/ask rules, floor, self-protection) and, when
nothing denies or asks, it may run unprompted only if it is exactly a command the project's
profile declares (`commands.*`, a surface's `*_cmd`, `verify.surfaces.<key>.smoke`, each also
with the ` 2>&1 | tail -40` fallback; ports may differ, for a worktree slot) or every simple
command in it matches a `Bash(…)` rule of permissions.allow in the Claude Code settings
(`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, the project's `.claude/settings.json` and
`.claude/settings.local.json`); a matching permissions.deny / ask rule denies / asks. Anything
else gets "ask" for the outer call, naming the inner command. A handed command built at run time
always gets "ask". A legacy `--runtime claude` argument is
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


# ══ core/hooks/gate/runtime.py ═══════════════════════════════════════════════
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


# ── the home folder ──────────────────────────────────────────────────────────
# `~` and $HOME mean what they mean to the shell that runs the agent's command: bash (Git Bash on
# Windows) reads $HOME, while Python's expanduser reads USERPROFILE on Windows. So $HOME wins
# when it is set (an MSYS spelling `/c/Users/x` is read as `C:/Users/x`).
def home_dir():
    h = os.environ.get("HOME")
    if h:
        if os.name == "nt":
            m = re.match(r"^/([A-Za-z])(/.*)?$", h.replace("\\", "/"))
            if m:
                h = m.group(1).upper() + ":" + (m.group(2) or "/")
        if os.path.isabs(h):
            return os.path.normpath(h)
    return os.path.expanduser("~")


def expand_home(p):
    """`~` / `~/…` expanded like the shell does; `~user` left to expanduser."""
    if p == "~" or p.startswith("~/") or p.startswith("~\\"):
        return home_dir() + p[1:]
    return os.path.expanduser(p) if p.startswith("~") else p


# ══ core/hooks/gate/shell.py ═════════════════════════════════════════════════
# ── lexer ────────────────────────────────────────────────────────────────────
DYN = "\x00"   # stands for a run-time expansion inside a word's value


class ParseError(Exception):
    pass


class Word(object):
    __slots__ = ("value", "raw", "dynamic", "glob", "quoted", "substs", "split")

    def __init__(self, value="", raw=""):
        self.value = value
        self.raw = raw
        self.dynamic = False
        self.glob = False
        self.quoted = False
        self.substs = []      # inner command lists ($(…), `…`, <(…))
        self.split = False    # holds an unquoted run-time expansion (field splitting applies)

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
    w.split = True
    return w


# ── variables the gate resolves itself ────────────────────────────────────────
# $HOME and $CLAUDE_CONFIG_DIR are the user's own environment, inherited alike by this hook and
# by the agent's Bash tool: a command can't choose them without assigning them, so the lexer
# expands them statically (`"$HOME/.claude/…/kanban-move.sh"` is that literal path). A text that
# names one of them other than as `$NAME`/`${NAME}`/`${NAME-…}`/`${NAME:-…}` — even spelled
# with quotes or escapes (`HO\ME=…`, `HO""ME=…`) — or that uses any builtin able to assign a
# variable whose name the gate can't read (`export`, `declare`, `read`, `printf -v`, `eval`,
# `source`, `let`, …) keeps them all run-time expansions — see `rebound_vars`. A value with
# blanks, glob characters, quotes or `$` is never resolved (it would split or expand again).
STATIC_VARS = ("HOME", "CLAUDE_CONFIG_DIR")
# Also never trusted by self-protection's `known_text` once the command may rebind them.
KNOWN_VARS = STATIC_VARS + ("CLAUDE_PROJECT_DIR", "PWD")
REBINDERS_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])(export|declare|typeset|local|readonly|read|readarray|mapfile|eval|"
    r"source|let|getopts|unset)(?![A-Za-z0-9_./-])|(?<![A-Za-z0-9_./-])printf\b[^\n;&|]*\s-v"
    r"|(?:^|[;&|(\n{]|\b(?:then|do|else|command|builtin|exec)\s)\s*\.(?=\s)")
SAFE_VALUE_RE = re.compile(r"^[^\s*?\[\]$`'\"\\{}]*$")


def static_env():
    """{name: value} for the variables the lexer may expand; value None = known to be unset."""
    env = {}
    for name in STATIC_VARS:
        v = os.environ.get(name)
        if v is None and name == "HOME":
            v = home_dir()
            if v == "~":
                continue
        if v is not None:
            v = v.replace("\\", "/")        # a Windows value would read as shell escapes
            if not SAFE_VALUE_RE.match(v):
                continue
        env[name] = v
    return env


def rebound_vars(text, names):
    """The names in `names` that `text` may assign: all of them when it uses a builtin that
    assigns by a computed name (REBINDERS_RE), else those it names other than as a plain
    expansion — quotes and backslashes removed first, so `HO\\ME=` and `HO""ME=` count."""
    if REBINDERS_RE.search(text):
        return set(names)
    flat = re.sub(r"[\\'\"]", "", text)
    out = set()
    for name in names:
        for m in re.finditer(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % name, flat):
            before, after = flat[:m.start()], flat[m.end():]
            if before.endswith("$"):
                continue
            if before.endswith("${") and re.match(r"(\}|:?-)", after):
                continue
            out.add(name)
            break
    return out


BRACE_VAR_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)(.*))?$", re.S)


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

    def __init__(self, src, env=None):
        self.s = src
        self.n = len(src)
        self.i = 0
        self.pending = []      # heredocs waiting for the end of the line
        self.depth = 0         # $( … ) nesting, for `EOF)` heredoc ends
        self.env = env or {}   # variables expanded statically (static_env)

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
        cases = []      # one entry per open `case … in`: True while a pattern is expected
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
            if cases and cases[-1] and not seg.words and not seg.redirs:
                # a `case` clause: `pat | pat )` — or the `esac` that closes it
                if re.match(r"esac(?=[\s;&|)]|$)", self.s[self.i:]):
                    cases.pop()
                    seg.words.append(self.read_word())
                    continue
                else:
                    marker = self._case_pattern(seg)
                    if marker is not None:
                        segs.append(marker)
                    cases[-1] = False
                    seg = Seg(self.s, self.i, subshell)
                    continue
            if c == ";" and cases and not cases[-1] and self.peek(1) in (";", "&"):
                # `;;`, `;&`, `;;&` end a case clause: a pattern comes next
                self._push(segs, seg, ";")
                self.i += 2
                if self.peek() == "&":
                    self.i += 1
                cases[-1] = True
                seg = Seg(self.s, self.i, subshell)
                continue
            if c in "()|&<>" and self._in_test(seg):
                # inside `[[ … ]]` these are operators of the test, not shell syntax
                start = self.i
                while self.i < self.n and self.s[self.i] in "()|&<>":
                    self.i += 1
                seg.words.append(static_word(self.s[start:self.i]))
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
                if seg.words and not seg.redirs and self._only_reserved(seg.words):
                    # `do (…)`, `then (…)`, `! (…)`: a subshell after a reserved word
                    self._push(segs, seg, None)
                    seg = Seg(self.s, self.i, subshell)
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
                fwords = seg.words[1:] if (seg.words and not seg.words[0].quoted
                                           and seg.words[0].value == "function") else seg.words
                if self.peek(1) == ")" and len(fwords) == 1:
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
            head = self._command_words(seg.words)
            if cases and not cases[-1] and len(head) == 1 and not w.quoted and w.value == "esac":
                cases.pop()
            elif (len(head) == 3 and not head[0].quoted and head[0].value == "case"
                  and not head[2].quoted and head[2].value == "in"):
                # `case WORD in`: the header is its own (ignored) segment; clauses follow
                self._push(segs, seg, ";")
                cases.append(True)
                seg = Seg(self.s, self.i, subshell)

    @staticmethod
    def _command_words(words):
        k = 0
        while k < len(words) and not words[k].quoted and words[k].value in RESERVED_SKIP:
            k += 1
        return words[k:]

    @staticmethod
    def _only_reserved(words):
        return all(not w.quoted and w.value in RESERVED_SKIP for w in words)

    def _in_test(self, seg):
        """Inside `[[ … ]]` (its closing `]]` not read yet)."""
        head = self._command_words(seg.words)
        if not head or head[0].quoted or head[0].value != "[[":
            return False
        return not any(not w.quoted and w.value == "]]" for w in head[1:])

    def _case_pattern(self, seg):
        """Read one `case` clause pattern up to and including its `)`. Returns a segment
        holding the pattern words when they run command substitutions (it starts with the
        reserved word `in`, so it is walked for those and never judged as a command)."""
        words = []
        if self.peek() == "(":
            self.i += 1
        while True:
            while self.peek() in (" ", "\t", "\r", "\n") and self.i < self.n:
                self.i += 1
            if self.peek() == "\\" and self.peek(1) == "\n":
                self.i += 2
                continue
            c = self.peek()
            if not c:
                raise ParseError("unterminated `case` pattern")
            if c == ")":
                self.i += 1
                break
            if c == "|":
                self.i += 1
                continue
            if c in ";&<>(":
                raise ParseError("unexpected `%s` in a `case` pattern" % c)
            start = self.i
            w = self.read_word()
            if self.i == start:
                raise ParseError("unexpected `%s` in a `case` pattern" % c)
            words.append(w)
        if not any(w.substs for w in words):
            return None
        m = Seg(self.s, seg.start, seg.subshell)
        m.words = [static_word("in")] + words
        m.sep = ";"
        m.end = self.i
        return m

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
            substs = [] if quoted else expansions_in(body, self.env)
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
                self._read_backtick(w, buf, False)
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
                self._read_backtick(w, buf, bool(term))
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
            w.split = w.split or not in_dq
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
            known = self._static_brace(s[self.i + 2:j])
            self.i = j + 1
            if known or (known is not None and in_dq):
                buf.append(known)
                return
            buf.append(DYN)
            w.dynamic = True
            w.split = w.split or not in_dq
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
            name = s[self.i + 1:j]
            self.i = j
            if self.env.get(name) or (name in self.env and in_dq):
                # (unquoted and empty, the word may vanish: left a run-time expansion)
                buf.append(self.env[name] or "")
                return
            buf.append(DYN)
            w.dynamic = True
            w.split = w.split or not in_dq
            return
        if nx and nx in "@*#?$!-":
            self.i += 2
            buf.append(DYN)
            w.dynamic = True
            w.split = w.split or not in_dq
            return
        buf.append("$")
        self.i += 1

    def _static_brace(self, body):
        """The value of `${NAME}`, `${NAME-word}` or `${NAME:-word}` when NAME is a variable
        the gate resolves (static_env) and the default word is itself static; else None."""
        m = BRACE_VAR_RE.match(body)
        if not m or m.group(1) not in self.env:
            return None
        val = self.env[m.group(1)]
        op = m.group(2)
        if op is None:
            return val or ""
        if (val if op == ":-" else val is not None):
            return val
        word = m.group(3)
        for name in self.env:
            v = self.env[name] or ""
            word = word.replace("${%s}" % name, v)
            word = re.sub(r"\$%s(?![A-Za-z0-9_])" % name, lambda _m: v, word)
        if not re.match(r"^[A-Za-z0-9_./~@%+,:=-]*$", word):
            return None
        return word

    def _read_backtick(self, w, buf, in_dq):
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
        w.substs.append(Lexer("".join(inner), self.env).parse())
        buf.append(DYN)
        w.dynamic = True
        w.split = w.split or not in_dq


def expansions_in(text, env=None):
    """Command substitutions inside an unquoted heredoc body (they run when it expands)."""
    if "$(" not in text and "`" not in text:
        return []
    lx = Lexer(text, env)
    w = Word()
    try:
        lx._read_dq(w, [], None)
    except ParseError:
        return [[]]
    return w.substs


def parse_command(text, env=None):
    return Lexer(text.replace("\x00", ""), env).parse()


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


# ══ core/hooks/gate/git.py ═══════════════════════════════════════════════════
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
        self.places = []           # [(option, Word)] for each of them, in order
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
            if i + 1 < len(args):
                g.places.append(("-C", args[i + 1]))
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
            if i + 1 < len(args):
                g.places.append((v, args[i + 1]))
            i += 2
            continue
        if v.startswith("--git-dir=") or v.startswith("--work-tree="):
            g.relocated = True
            opt, _, val = v.partition("=")
            g.places.append((opt, static_word(val)))
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
            elif BRANCH_SUBST_RE.match(w.raw) or (w.raw.startswith('"') and not h.startswith("-")
                                                   and not h.startswith("+")):
                # "$(git branch --show-current)" (resolved later) or a quoted "$BRANCH": one
                # word, so not a flag — but its destination is unknown.
                pi.positionals.append(w)
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


# ══ core/hooks/gate/config.py ════════════════════════════════════════════════
# ── config ───────────────────────────────────────────────────────────────────
DEFAULT_AGENTS = ["cohorte-review", "review"]
RENAMED_AGENTS = {"review": "cohorte-review", "release": "cohorte-release",
                  "profile-reader": "cohorte-profile-reader"}


def _with_renamed_aliases(agents):
    """Every listed agent plus its 2.x/3.x counterpart, order kept, no duplicates."""
    out = []
    reverse = {v: k for k, v in RENAMED_AGENTS.items()}
    for a in agents:
        for name in (a, RENAMED_AGENTS.get(a), reverse.get(a)):
            if name and name not in out:
                out.append(name)
    return out


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
        # 3.0 renamed the fixed agents (review → cohorte-review …). A 2.x gate-config.json lists
        # the bare names explicitly, so gate both spellings or every migrated repo silently
        # loses its phase gate.
        agents = _with_renamed_aliases(agents)
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
            home = os.path.realpath(home_dir())
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


# ══ core/hooks/gate/ownership.py ═════════════════════════════════════════════
# ── surface ownership ────────────────────────────────────────────────────────
# A surface implementer (a subagent whose `agent_type` is a `surfaces[].agent` of the
# project's `.claude/profile.json`) may only write under its own `surfaces[].path`, plus
# its `owns_also` and the global `ownership.shared_writable` entries; the frozen contract
# (`contract.path`, `contract.index`) is read-only to it. The lead (no `agent_id` in the
# payload), the fixed cohorte-* agents and unknown agent types are never restricted.
# Inert when profile.json is absent or unreadable, or `ownership.enforce` is false. Only
# targets inside one of the project's checkouts are judged — /dev/null, $TMPDIR, a file
# under ~ are not another surface's tree. Nothing here may raise for a malformed profile:
# hook() turns an exception on a Bash payload into a deny for everyone, the lead included.
OWNERSHIP_OFF = {"false", "no", "off", "0"}
GLOB_CHARS = set("*?[")


def _profile_str(v):
    """A usable profile string: not empty, not a `<placeholder>` left by the template."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v if v and not v.startswith("<") else None


def _profile_paths(v):
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list):
        return []
    out = []
    for e in v:
        e = _profile_str(e)
        if e:
            out.append(e)
    return out


def _nearest_dir(p):
    d = os.path.dirname(p) if not os.path.isdir(p) else p
    while d and not os.path.isdir(d):
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    return d or None


class Ownership(object):
    def __init__(self, ctx, agent, mine, surfaces, shared, contract):
        self.ctx = ctx
        self.agent = agent
        self.mine = mine                # [(key, path, owns_also)]
        self.surfaces = surfaces        # [(key, agent, path)] — every surface, for the message
        self.shared = shared
        self.contract = contract
        self._tops = {}

    @classmethod
    def load(cls, ctx, payload):
        """The ownership rules for this payload's agent, or None (not a surface agent, no
        profile, enforcement off). Never raises."""
        try:
            aid, agent = payload.get("agent_id"), payload.get("agent_type")
            if not (isinstance(aid, str) and aid.strip() and isinstance(agent, str) and agent.strip()):
                return None
            prof = None
            for r in ctx.roots:
                p = os.path.join(r, ".claude", "profile.json")
                if os.path.isfile(p):
                    try:
                        with open(p, "r", encoding="utf-8") as fh:
                            prof = json.load(fh)
                    except Exception as e:
                        warn("%s is unreadable (%s) — surface ownership is not enforced until "
                             "`cohorte sync` rewrites it" % (p, e))
                        return None
                    break
            if not isinstance(prof, dict):
                return None
            own = prof.get("ownership")
            own = own if isinstance(own, dict) else {}
            enforce = own.get("enforce", True)
            if enforce is False or (isinstance(enforce, str) and enforce.strip().lower() in OWNERSHIP_OFF):
                return None
            surfaces, mine = [], []
            for s in prof.get("surfaces") if isinstance(prof.get("surfaces"), list) else []:
                if not isinstance(s, dict):
                    continue
                key = _profile_str(s.get("key")) or "?"
                sagent = _profile_str(s.get("agent")) or _profile_str(s.get("key"))
                path = _profile_str(s.get("path"))
                if path:
                    surfaces.append((key, sagent, path))
                if sagent == agent.strip():
                    if not path:
                        warn("surface `%s` has no usable `path` — its agent is not restricted" % key)
                        return None
                    mine.append((key, path, _profile_paths(s.get("owns_also"))))
            if not mine:
                return None
            contract = []
            c = prof.get("contract")
            if isinstance(c, dict) and c.get("enabled") is not False:
                contract = [x for x in (_profile_str(c.get("path")), _profile_str(c.get("index"))) if x]
            return cls(ctx, agent.strip(), mine, surfaces,
                       _profile_paths(own.get("shared_writable")), contract)
        except Exception as e:
            warn("surface ownership skipped: %s: %s" % (type(e).__name__, e))
            return None

    def _top_of(self, path):
        d = _nearest_dir(path)
        if not d:
            return None
        if d not in self._tops:
            top, main = git_top_and_common(d)
            roots = self.ctx.roots
            ok = top and (top in roots or (main and os.path.realpath(main) in roots))
            self._tops[d] = top if ok else None
        return self._tops[d]

    def base_of(self, real):
        """The project checkout `real` lives in (its own linked worktree wins over a main
        checkout that contains it), or None when it is outside every one of them."""
        cands = list(self.ctx.roots)
        top = self._top_of(real)
        if top and top not in cands:
            cands.append(top)
        best = None
        for c in cands:
            if real == c or real.startswith(c.rstrip(os.sep) + os.sep):
                if best is None or len(c) > len(best):
                    best = c
        return best

    @staticmethod
    def within(rel, real, base, entry):
        if os.path.isabs(entry):
            e = os.path.realpath(entry)
            return real == e or real.startswith(e.rstrip(os.sep) + os.sep)
        e = entry.replace("\\", "/").strip()
        while e.startswith("./"):
            e = e[2:]
        e = e.rstrip("/") or "."
        if e == ".":
            return True
        if GLOB_CHARS & set(e):
            parts = rel.split("/")
            return any(fnmatch.fnmatchcase("/".join(parts[:k]), e) for k in range(1, len(parts) + 1))
        e = "/".join(x for x in e.split("/") if x not in ("", "."))
        if rel == e or rel.startswith(e + "/"):
            return True
        target = os.path.realpath(os.path.join(base, e))     # the entry is itself a symlink
        return real == target or real.startswith(target.rstrip(os.sep) + os.sep)

    def judge(self, path):
        """None when the agent may write `path` (absolute), else the reason it may not."""
        real = os.path.realpath(os.path.normpath(path))
        base = self.base_of(real)
        if base is None:
            return None
        rel = os.path.relpath(real, base).replace(os.sep, "/")
        if rel == "." or rel.startswith("../"):
            return None
        for c in self.contract:
            if self.within(rel, real, base, c):
                return ("`%s` is the frozen contract (`contract.path` in PIPELINE.md), read-only for "
                        "surface agents — the lead authors it. If the contract is wrong, stop and say "
                        "so in your handoff instead of changing it" % rel)
        mine = []
        for key, spath, also in self.mine:
            mine.append(spath)
            if self.within(rel, real, base, spath) or any(self.within(rel, real, base, e) for e in also):
                return None
        if any(self.within(rel, real, base, e) for e in self.shared):
            return None
        owner = None
        for key, sagent, spath in self.surfaces:
            if self.within(rel, real, base, spath) and (owner is None or len(spath) > len(owner[2])):
                owner = (key, sagent, spath)
        whose = ("it belongs to surface `%s` (agent `%s`)" % (owner[0], owner[1])
                 if owner else "no surface owns it (it is the lead's)")
        return ("surface ownership — agent `%s` may only write under `%s` (plus its `owns_also` and "
                "`ownership.shared_writable`), and `%s` is outside: %s. Don't edit another surface's "
                "tree — report what you need from it in your handoff and the lead routes it"
                % (self.agent, "`, `".join(mine), rel, whose))


# ══ core/hooks/gate/patterns.py ══════════════════════════════════════════════
# ── patterns ─────────────────────────────────────────────────────────────────
class PatSeg(object):
    def __init__(self, name, args, sep):
        self.name = name
        self.args = args
        self.sep = sep
        self.git = parse_git(args) if name == "git" else None
        self.core = runner_core(name, args) if name != "git" else None
        self.prefix_only = False


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
                if not words or words[0].dynamic:
                    continue
                argv = words           # a wrapper-only pattern such as `sudo`
                ps = PatSeg(cmd_name(argv[0].value), argv[1:], s.sep)
                ps.prefix_only = True
                self.segs.append(ps)
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


WRAPPERS = {"docker", "podman", "nerdctl", "docker-compose", "kubectl", "oc", "lima", "colima"}


def wrapper_cores(name, args):
    """Container wrappers (`docker compose exec api node ace …`, `kubectl exec pod -- psql`)
    run a command given as later words: try a pattern at every later static word."""
    if name not in WRAPPERS:
        return []
    out = []
    for k, w in enumerate(args):
        if w.dynamic or w.value.startswith("-"):
            continue
        out.append((cmd_name(w.value), args[k + 1:]))
        core = runner_core(cmd_name(w.value), args[k + 1:])
        if core:
            out.append(core)
    return out[:40]


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


def could_be(w, p):
    """Could run-time word `w` expand to the pattern's literal word `p`? For a word whose
    expansions are all quoted, its static parts must appear in `p`, in order (`"$m:fresh"`
    can be `migration:fresh`, `"$S/x.mjs"` can't be `ace`). An unquoted expansion is field-
    split by the shell (`$X/y` with X="-rf /tmp" is three words), so it can be anything."""
    if p.dynamic or w.split:
        return True
    rx = ".*".join(re.escape(part).replace(r"\*", ".*").replace(r"\?", ".").replace(r"\[", ".*")
                   for part in w.value.split(DYN))
    return re.match(r"(?s)\A%s\Z" % rx, p.value) is not None


def wild_flag(tokens, idx):
    """A run-time word that could expand to flags: unquoted (field splitting) or visibly
    starting with `-`, and not after `--`."""
    if not is_wildcard(tokens, idx):
        return False
    if any(not t.dynamic and t.value == "--" for t in tokens[:idx]):
        return False
    w = tokens[idx]
    if w.head.startswith("-"):
        return True
    return w.split or not w.raw.startswith('"')


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
                if could_be(w, ppos[pi]):
                    return "possible"
                # it can only be a positional other than ppos[pi]
                if not prev_flag:
                    return best
                prev_flag = False
                j += 1
                continue
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
    wild = any(wild_flag(cargs, k) for k in range(len(cargs)))
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


# ══ core/hooks/gate/approve.py ═══════════════════════════════════════════════
# ── approvals ────────────────────────────────────────────────────────────────
# /cohorte-review's documented fallback when a surface has no bridled variant
# (profile/schema/output-discipline.md), and the no-op marker review.js puts before the scans.
QUIET_SUFFIX = " 2>&1 | tail -40"
SECURITY_MARKER = ": cohorte-security-scans"
# The slot's port replaces the profile's in a feature worktree (profile/schema/verify.md §Ports).
PORT_RE = re.compile(r"(?<=:)\d{2,5}(?![0-9])")
RULE_RE = re.compile(r"^\s*Bash\s*(?:\((.*)\))?\s*$", re.S)
DUP_TARGET_RE = re.compile(r"^(\d+|-)$")


def norm_cmd(s):
    """Whitespace collapsed, ports blanked: how a profile command and a handed one compare."""
    return PORT_RE.sub("<port>", " ".join(s.split()))


def profile_commands(prof):
    """Every command string `.claude/profile.json` declares: `commands.*` (a string, or a list
    like `commands.security`), each surface's `*_cmd`, and `verify.surfaces.<key>.smoke`."""
    out = []

    def add(v):
        if isinstance(v, list):
            for x in v:
                add(x)
        elif isinstance(v, str) and v.strip() and not v.strip().startswith("<"):
            out.append(v.strip())

    if not isinstance(prof, dict):
        return out
    cmds = prof.get("commands")
    if isinstance(cmds, dict):
        for v in cmds.values():
            add(v)
    for s in prof.get("surfaces") if isinstance(prof.get("surfaces"), list) else []:
        if isinstance(s, dict):
            for k, v in s.items():
                if isinstance(k, str) and k.endswith("_cmd"):
                    add(v)
    ver = prof.get("verify")
    vs = ver.get("surfaces") if isinstance(ver, dict) else None
    if isinstance(vs, dict):
        for v in vs.values():
            if isinstance(v, dict):
                add(v.get("smoke"))
    return out


def rule_matches(content, text):
    """Claude Code's `Bash(…)` rule semantics for one simple command: no content or `*` = any
    command; `prefix:*` = the prefix as whole words; a `*` elsewhere = any run of characters;
    otherwise the exact command."""
    if content is None or content.strip() in ("", "*"):
        return True
    c = content.strip()
    if c.endswith(":*"):
        p = c[:-2].rstrip()
        return text == p or text.startswith(p + " ")
    if "*" in c:
        rx = ".*".join(re.escape(part) for part in c.split("*"))
        return re.match("^" + rx + "$", text, re.S) is not None
    return text == c


class Approvals(object):
    def __init__(self, roots):
        self.profile = set()
        self.rules = {"allow": [], "ask": [], "deny": []}
        for r in roots:
            p = os.path.join(r, ".claude", "profile.json")
            prof = self._load(p)
            for c in profile_commands(prof):
                self.profile.add(norm_cmd(c))
                self.profile.add(norm_cmd(c + QUIET_SUFFIX))
        self.profile.add(norm_cmd(SECURITY_MARKER))
        cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home_dir(), ".claude")
        files = [os.path.join(cfg, "settings.json")]
        for r in roots:
            files += [os.path.join(r, ".claude", "settings.json"),
                      os.path.join(r, ".claude", "settings.local.json")]
        for f in files:
            data = self._load(f)
            perms = data.get("permissions") if isinstance(data, dict) else None
            if not isinstance(perms, dict):
                continue
            for kind in ("allow", "ask", "deny"):
                lst = perms.get(kind)
                for rule in lst if isinstance(lst, list) else []:
                    m = RULE_RE.match(rule) if isinstance(rule, str) else None
                    if m:
                        self.rules[kind].append((rule.strip(), m.group(1)))

    @staticmethod
    def _load(path):
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception as e:
            warn("%s is unreadable (%s) — its commands and rules approve nothing" % (path, e))
            return None

    @staticmethod
    def simple_commands(text):
        """[(text, plain)] for each simple command, where plain = no substitution, subshell,
        heredoc, function or file redirection (only those can be approved by an allow rule);
        None when the text can't be parsed."""
        try:
            segs = parse_command(text)
        except ParseError:
            return None
        out = []
        for seg in segs:
            if not seg.words:
                continue
            plain = not (seg.subshell or seg.funcdef or seg.heredocs
                         or any(w.substs for w in seg.words)
                         or any(r.target.substs for r in seg.redirs))
            for r in seg.redirs:
                if r.target.dynamic:
                    plain = False
                elif not (r.op == ">&" and DUP_TARGET_RE.match(r.target.value)) \
                        and not (r.op in (">", ">>", "&>") and r.target.value == "/dev/null"):
                    plain = False
            out.append((" ".join(w.raw for w in seg.words), plain))
        return out

    def judge(self, cmd):
        """("deny"|"ask", why) for a settings deny/ask rule, "allow" when approved, else None."""
        parts = self.simple_commands(cmd)
        for kind in ("deny", "ask"):
            for text, _ in parts or []:
                for rule, content in self.rules[kind]:
                    if content is not None and content.strip() not in ("", "*") \
                            and rule_matches(content, text):
                        return kind, ("`%s` matches `%s` in permissions.%s of the Claude Code "
                                      "settings" % (text, rule, kind))
        if norm_cmd(cmd) in self.profile:
            return "allow"
        if parts and all(plain and any(rule_matches(c, t) for _, c in self.rules["allow"])
                         for t, plain in parts):
            return "allow"
        return None


# ══ core/hooks/gate/context.py ═══════════════════════════════════════════════
# ── context ──────────────────────────────────────────────────────────────────
# Text that spells the machine-wide install (`~/.claude/cohorte/lib/project.js`, `…/.claude/
# commands/cohorte-ship.md`) — in inline code, or anywhere in a path computed at run time.
CORE_TEXT_RE = re.compile(r"\.claude[/\\](cohorte(-ui)?([/\\]|$)|(commands|agents|workflows)[/\\]cohorte-)")
# The static tail of a run-time path right after its variable part (`$CFG/cohorte/lib/x.js`,
# `$D/workflows/cohorte-loop.js`): the variable may be the config folder.
CORE_TAIL_RE = re.compile(r"^[/\\](cohorte(-ui)?([/\\]|$)|(commands|agents|workflows)[/\\]cohorte-)")


def config_dirs():
    """Claude Code's user configuration folders: `$CLAUDE_CONFIG_DIR` when set, and ~/.claude
    (the default, and where a 2.x install or a second account may still live)."""
    out = []
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    home = os.path.join(home_dir(), ".claude")
    for d in (env, home):
        if d and os.path.isabs(expand_home(d)):
            d = os.path.normpath(expand_home(d))
            if d not in out:
                out.append(d)
    return out


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
        self.owner = None             # Ownership, set by evaluate() for a surface agent
        self._approvals = None
        self._build_protected()

    def approvals(self):
        """What a pipeline script may run unprompted (approve.py), read once per evaluation."""
        if self._approvals is None:
            self._approvals = Approvals(self.roots)
        return self._approvals

    def _build_protected(self):
        write, delete = set(), set()

        def add(s, p):
            s.add(os.path.normpath(p))
            s.add(os.path.realpath(p))

        for r in self.roots:
            for rel in ((".claude", "gate-config.json"), (".claude", "preflight.ok"),
                        (".claude", "settings.json"), (".claude", "settings.local.json"),
                        (".claude", "hooks", "cohorte-gate.py"), (".cohorte", "gate-config.json"),
                        # profile.json drives ownership enforcement: as protected as the config.
                        (".claude", "profile.json")):
                add(write, os.path.join(r, *rel))
            add(delete, os.path.join(r, ".claude", "pipeline.json"))
        cfg_dirs = config_dirs()
        for cfg in cfg_dirs:
            for rel in ("settings.json", "settings.local.json"):
                add(write, os.path.join(cfg, rel))
        self.protected = write
        self.delete_protected = write | delete
        # The machine-wide install: the core every project runs (<core>/lib, the allowlisted
        # <core>/pipeline/scripts/, the hooks it copies), cohorte ui's own state (run history,
        # tickets, settings) and the global commands/agents/workflows `cohorte install` writes.
        # Nothing an agent may write: only `cohorte install`/`update`, run by the human, does.
        dirs, globs = set(), set()
        for cfg in cfg_dirs:
            for c in (cfg, os.path.realpath(cfg)):
                for sub in ("cohorte", "cohorte-ui"):
                    dirs.add(os.path.normcase(os.path.normpath(os.path.join(c, sub))))
                for sub, pat in (("commands", "cohorte-*.md"), ("agents", "cohorte-*.md"),
                                 ("workflows", "cohorte-*.js")):
                    globs.add(os.path.normcase(os.path.normpath(os.path.join(c, sub, pat))))
        self.core_dirs = sorted(dirs)
        self.core_globs = sorted(globs)

    def in_core(self, p):
        """Is `p` (absolute) inside the machine-wide install — through a symlink too?"""
        for cand in {os.path.normcase(os.path.normpath(p)), os.path.normcase(os.path.realpath(p))}:
            for d in self.core_dirs:
                if cand == d or cand.startswith(d + os.sep):
                    return True
            for g in self.core_globs:
                if fnmatch.fnmatchcase(cand, g):
                    return True
        return False

    def core_below(self, p):
        """Does the directory `p` (absolute) hold part of the machine-wide install?"""
        for cand in {os.path.normcase(os.path.normpath(p)), os.path.normcase(os.path.realpath(p))}:
            pre = cand.rstrip(os.sep) + os.sep
            if any(d.startswith(pre) for d in self.core_dirs) or \
                    any(os.path.dirname(g).startswith(pre) or os.path.dirname(g) == cand
                        for g in self.core_globs):
                return True
        return False

    def mentions_core(self, text):
        """Does a piece of inline code name the machine-wide install?"""
        if CORE_TEXT_RE.search(text):
            return True
        t = os.path.normcase(text)     # Windows: case-insensitive, either slash
        return any(d in t for d in self.core_dirs) or \
            any(os.path.dirname(g) + os.sep + "cohorte-" in t for g in self.core_globs)

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


# ══ core/hooks/gate/findings.py ══════════════════════════════════════════════
def norm_lower(s):
    return " ".join(s.lower().split())


def short(text, n=90):
    t = " ".join(text.split())
    return t if len(t) <= n else t[:n - 1] + "…"


class Findings(object):
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


# ══ core/hooks/gate/rules.py ═════════════════════════════════════════════════
class RuleChecks(object):
    def branch_at(self, state):
        """The branch checked out at state.cwd: the one an earlier `git switch -c` of this
        chain created there, else HEAD on disk (None when detached / not a repo)."""
        if state.branch is not None and state.branch[0] == state.cwd:
            return state.branch[1]
        return self.ctx.current_branch(state.cwd)

    def branch_gated(self, state, here_unknown):
        if here_unknown or state.sticky or not state.cwd_known:
            return True
        b = self.branch_at(state)
        return b is None or self.ctx.is_default(b)

    # -- git push --------------------------------------------------------------
    def push_targets(self, state, here_unknown):
        """Branch names a bare `git push` may update, and whether that is unknown."""
        if here_unknown:
            return set(), True
        cwd = state.cwd
        names = set()
        cur = self.branch_at(state)
        if cur is None:
            return set(), True
        names.add(cur)
        if state.branch is not None and state.branch[0] == cwd:
            # created earlier in this chain: git keeps any branch.<name>.merge already in the
            # config, and a start point / --track may set one — where a bare push lands is not
            # known until it exists
            return names, True
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

    def fresh_upstream(self, name, state):
        """Whether the config already holds an upstream for a branch this chain creates."""
        r = run_git(["config", "--get", "branch.%s.merge" % name], state.cwd)
        return r is None or (r[0] == 0 and bool(r[1].strip()))

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
                    cur = self.branch_at(state)
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
            fresh = (state.branch is not None and state.branch[0] == state.cwd
                     and state.branch[1] == src)
            if fresh and ":" not in v and (state.branch[2] or self.fresh_upstream(src, state)):
                unknown = True     # just created, but it may already track something
            elif ":" not in v and not here_unknown and n == src and not fresh:
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
        if pat_seg.prefix_only:
            return "match" if (pat_seg.name in inv.prefixes or pat_seg.name == inv.name) else None
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
        cands = [(inv.name, inv.args)] + ([inv.core] if inv.core else []) + inv.cores
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


# ══ core/hooks/gate/protect.py ═══════════════════════════════════════════════
PROTECTED_HINT_RE = re.compile(r"(^|/)\.claude(/|$)|gate-config\.json|preflight\.ok|"
                               r"settings(\.local)?\.json|cohorte-gate\.py|pipeline\.json|"
                               r"(^|/)\.cohorte(/|$)|cohorte-ui|CLAUDE_CONFIG_DIR")

# -- inside a cohorte run (COHORTE_RUN_ID in the hook's environment: the hook is a child of the run) --------------
# The `cohorte` verbs an agent of a run may call: reads only. Everything else moves the company flow.
READ_VERBS = {"doctor", "specs", "metrics", "version", "--version", "-v", "help", "--help", "-h",
              "sync"}  # sync re-wires the project's own files (the founding's set-up stage runs it), never the flow's state
PTY_TOOLS = {"script", "expect", "unbuffer", "socat", "empty", "ttyrec", "tmux", "screen", "faketty", "pty"}
ENV_TAMPER_RE = re.compile(r"(^|[\s;&|(])env\s+(?:\S+\s+)*?(-u\b|--unset\b|-i\b|--ignore-environment\b|-\s)|"
                           r"(^|[\s;&|(])(unset|export|declare|typeset|readonly)\b[^;&|]*\bCOHORTE_|\bCOHORTE_\w*\+?=")
PTY_CODE_RE = re.compile(r"\bpty\b|node-pty|openpty|forkpty|posix_openpt")
RUNNERS = {"npx", "bunx", "pnpx"}
DLX = {"pnpm", "yarn", "bun"}
PROTECTED_BASENAMES = {"gate-config.json", "preflight.ok", "settings.json", "settings.local.json", "profile.json",
                      "cohorte-gate.py", "pipeline.json", ".claude", ".cohorte", "hooks", "~", "",
                      ".", ".."}


def suspicious(tail, raw):
    """For a path the gate can't resolve: could it name a protected file? Its static tail
    decides — `…/.claude/pipeline-metrics.jsonl` can't, `$DIR/.claude/settings.json` can, and
    neither can `$DIR/cohorte/lib/project.js` be told from the machine-wide core."""
    if tail and (CORE_TAIL_RE.search(tail) or CORE_TEXT_RE.search(tail)):
        return True
    base = os.path.basename(tail.rstrip("/")) if tail else ""
    if tail and "/" in tail and base not in PROTECTED_BASENAMES and not tail.endswith("/"):
        return False
    return bool(PROTECTED_HINT_RE.search(raw))


class SelfProtection(object):
    def path_key(self, w, state):
        v = expand_home(w.value)
        if not os.path.isabs(v) and state.cwd_known:
            v = os.path.join(state.cwd, v)
        return os.path.normpath(v)

    def remember_written(self, w, state):
        if not w.dynamic:
            state.written.add(self.path_key(w, state))

    def known_text(self, w, state):
        """A run-time word with only the variables the gate can resolve itself
        ($CLAUDE_PROJECT_DIR, $HOME, $PWD) substituted, or None if anything else is left."""
        t = w.raw
        if len(t) >= 2 and t[0] == t[-1] == '"':
            t = t[1:-1]
        for var, val in (("CLAUDE_PROJECT_DIR", os.environ.get("CLAUDE_PROJECT_DIR")),
                         ("CLAUDE_CONFIG_DIR", os.environ.get("CLAUDE_CONFIG_DIR")),
                         ("HOME", home_dir()),
                         ("PWD", state.cwd if state.cwd_known else None)):
            if val and var not in state.rebound:
                # Forward slashes: a Windows value (C:\\Users\\…) would otherwise read as
                # shell escapes below and every expanded path would look suspect.
                val = val.replace("\\", "/")
                t = t.replace("${%s}" % var, val).replace("$" + var, val)
        if "$" in t or "`" in t or "'" in t or '"' in t or "\\" in t:
            return None
        return t

    def classify_path(self, w, state, mode, relocated=False):
        ctx = self.ctx
        if w.dynamic:
            t = self.known_text(w, state)
            if t is None:
                return "suspect" if suspicious(w.value.split(DYN)[-1], w.raw) else None
            w = static_word(t)
        v = expand_home(w.value)
        if not v:
            return None
        if not os.path.isabs(v):
            if relocated or not state.cwd_known:
                return "suspect" if suspicious(v, v) else None
            v = os.path.join(state.cwd, v)
        prot = ctx.delete_protected if mode in ("delete", "recursive", "chmod") else ctx.protected
        targets = [v]
        if w.glob:
            pat = os.path.normpath(v)
            static = re.split(r"[*?\[]", pat, 1)[0]
            if ctx.in_core(pat) or (static.endswith(os.sep) and ctx.in_core(static.rstrip(os.sep))):
                return "core"
            if mode in ("delete", "recursive", "chmod") and static and \
                    ctx.core_below(os.path.dirname(static) if not static.endswith(os.sep) else static):
                # `rm -rf ~/.claude/*`: the glob may reach the install
                npat = os.path.normcase(pat)
                if any(fnmatch.fnmatchcase(d, npat) for d in ctx.core_dirs) or \
                        any(fnmatch.fnmatchcase(os.path.dirname(g), npat) for g in ctx.core_globs):
                    return "core" if mode == "delete" else "suspect"
            if any(fnmatch.fnmatchcase(p, pat) for p in prot):
                return "protected"
            try:
                targets = glob.glob(v)[:500]
            except Exception:
                targets = []
        for t in targets:
            for cand in {os.path.normpath(os.path.abspath(t)), os.path.realpath(t)}:
                if ctx.in_core(cand):
                    return "core"
                if cand in prot:
                    return "protected"
                if mode in ("delete", "recursive", "chmod"):
                    if ctx.core_below(cand):
                        return "core" if mode == "delete" else "suspect"
                    pre = cand if cand.endswith(os.sep) else cand + os.sep
                    if any(p.startswith(pre) for p in prot):
                        return "protected" if mode == "delete" else "suspect"
        return None

    def check_owner(self, w, state, mode, via, relocated=False, existing=False):
        """Surface ownership for a Bash write — best effort: a target the gate can't resolve
        statically (a run-time word, a relative path after an unresolvable `cd`) is let
        through, never asked about (an ask is a deny in unattended runs)."""
        try:
            t = self.known_text(w, state) if w.dynamic else w.value
            if not t:
                return
            v = expand_home(t)
            if not os.path.isabs(v):
                if relocated or not state.cwd_known:
                    return
                v = os.path.join(state.cwd, v)
            if existing and not os.path.exists(v):
                return
            why = self.ctx.owner.judge(v)
        except Exception as e:
            warn("surface ownership could not judge `%s`: %s: %s" % (w.raw, type(e).__name__, e))
            return
        if why:
            verb = {"write": "write", "delete": "delete or move", "recursive": "write into",
                    "chmod": "change the permissions of"}.get(mode, "write")
            self.deny("%s would %s `%s`: %s" % (via, verb, w.raw, why))

    def check_path(self, w, state, mode, via, relocated=False, existing=False):
        if self.ctx.owner is not None:
            self.check_owner(w, state, mode, via, relocated, existing)
        kind = self.classify_path(w, state, mode, relocated)
        if kind is None:
            return
        verb = {"write": "overwrite", "delete": "delete or move", "recursive": "overwrite",
                "chmod": "change the permissions of"}[mode]
        if kind == "core":
            self.deny_core(via, verb, w.raw)
        elif kind == "protected" and mode in ("write", "delete"):
            self.deny("%s would %s `%s`, which the Cohorte gate depends on (self-protection). "
                      "Edit gate rules through PIPELINE.md and /cohorte-update-pipeline, or ask "
                      "the human" % (via, verb, w.raw))
        else:
            self.ask("%s may %s a file the Cohorte gate depends on (`%s`) — confirm"
                     % (via, verb, w.raw))

    def deny_core(self, via, verb, raw):
        self.deny("%s would %s `%s`, inside the machine-wide cohorte install (the core every "
                  "project runs, cohorte ui's state, the global cohorte-* commands, agents and "
                  "workflows) — agents never write there (self-protection). `cohorte update`, "
                  "run by the human, is how it changes" % (via, verb, raw))

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
            fl = flag_names(args)
            if name == "ln" or (name == "cp" and fl & {"-l", "-s", "--link", "--symbolic-link"}) \
                    or (name == "rsync" and any(not w.dynamic and w.value.startswith("--link-dest")
                                                for w in args)):
                # A link to a file of the install is a way to write it later (a hard link
                # even hides where it points): its source counts as a write.
                srcs = pos if target is not None or len(pos) < 2 else pos[:-1]
                for p in srcs:
                    self.check_core(p, state, "`%s`" % name, relocated, link=True)
        elif name == "touch":
            for p in positionals(args, ("-r", "--reference", "-t", "-d", "--date")):
                self.check_path(p, state, "write", "`touch`", relocated)
        elif name in ("mkdir", "mkfifo", "mknod"):
            for p in positionals(args, ("-m", "--mode", "-Z", "--context")):
                self.check_path(p, state, "write", "`%s`" % name, relocated)
        elif name in ("tar", "bsdtar", "gtar", "unzip", "7z", "cpio"):
            self.extract_targets(name, args, state, relocated)
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
                # Only existing files can be edited in place, so for ownership a positional
                # that names nothing on disk is the sed script (`sed -i 's/a/b/' f`) or a BSD
                # backup suffix (`sed -i .bak …`), not a target.
                for p in positionals(args, ("-e", "-f")):
                    self.check_path(p, state, "write", "`%s -i`" % name, relocated, existing=True)
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
        if name == "git" and inv.git:
            self.git_core(inv.git, state, relocated)
        if name == "git" and inv.git and inv.git.sub in ("checkout", "restore", "reset"):
            self.git_restore(inv.git, state, relocated or inv.git.relocated)
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

    def run_guard(self, inv, assigns, seg):
        """Inside a cohorte run, its agents may read the company flow, never move it: no state-changing `cohorte`
        verb (whatever path or runner calls it), no hiding the run from the CLI (COHORTE_* unset or overridden), no
        pseudo-terminal to pass for a person at a terminal. Parsing cannot see into scripts or interpreters — which is
        why nothing a person decides rests on it alone (see docs/reference/gate.md, "The company flow")."""
        if os.environ.get("COHORTE_RUN_ID") is None:
            return
        name, args = inv.name, inv.args
        text = seg.text
        if any(a.startswith("COHORTE_") for a in assigns) or ENV_TAMPER_RE.search(text):
            self.deny("an agent of a cohorte run may not unset or override COHORTE_* (`%s`) — that is how the "
                      "`cohorte` CLI knows it is called from a run" % text.strip()[:120])
            return
        if name in PTY_TOOLS or PTY_TOOLS.intersection(inv.prefixes or []) or (name in ("python", "python3", "node", "perl", "ruby", "bun", "deno")
                                 and PTY_CODE_RE.search(text)):
            self.deny("an agent of a cohorte run may not drive a pseudo-terminal (`%s`) — a person's decisions "
                      "are typed at a real one" % name)
            return
        vals = [w.value for w in args]
        rest = None
        if name == "cohorte":
            rest = vals
        elif name in ("node", "nodejs", "bun") and vals and (vals[0].endswith("bin/cli.js") or vals[0].endswith("bin/flow.js")
                                                              or os.path.basename(vals[0]) == "cohorte"):
            rest = vals[1:]
        elif name in RUNNERS or (name in DLX and vals[:1] in (["dlx"], ["exec"], ["x"])) or (name == "npm" and vals[:1] in (["exec"], ["x"])):
            for k, v in enumerate(vals):
                if re.match(r"^cohorte(@\S*)?$", v):
                    rest = vals[k + 1:]
                    break
        if rest is None:
            return
        pos = [v for v in rest if not v.startswith("-")]
        verb = pos[0] if pos else (rest[0] if rest else "help")
        ok = verb in READ_VERBS or (verb == "ticket" and (len(pos) < 2 or pos[1] in ("list", "show"))) \
            or (verb == "autopilot" and "--status" in rest and "--follow" not in rest and "--detach" not in rest)
        if not ok:
            self.deny("an agent of a cohorte run may read the company flow (`cohorte ticket list|show`, "
                      "`cohorte autopilot <id> --status`), never move it (`cohorte %s`) — say what you need in your "
                      "answer: the developer decides" % verb)

    def run_opaque_name(self, seg):
        """Inside a cohorte run, a command whose name is computed at run time (`$c take x`, `$(which cohorte) …`)
        could be the `cohorte` CLI: denied, not merely asked. Returns True when it denied."""
        if os.environ.get("COHORTE_RUN_ID") is None:
            return False
        self.deny("an agent of a cohorte run may not run a command whose name is computed at run time (`%s`) — "
                  "it could move the company flow" % seg.text.strip()[:120])
        return True

    # -- the machine-wide install: folders a command works in, sources of links -------------
    def core_place(self, w, state, relocated, base=None):
        """Where a path argument points: an absolute path, "suspect" (computed at run time, and
        it may name the install), or None (can't tell, and nothing suggests the install)."""
        if w.dynamic:
            t = self.known_text(w, state)
            if t is None:
                tail = w.value.split(DYN)[-1]
                return "suspect" if (CORE_TAIL_RE.search(tail) or CORE_TEXT_RE.search(w.raw)) \
                    else None
            v = t
        else:
            v = w.value
        v = expand_home(v)
        if not os.path.isabs(v):
            if base is None:
                if relocated or not state.cwd_known:
                    return "suspect" if CORE_TEXT_RE.search(v) else None
                base = state.cwd
            v = os.path.join(base, v)
        return os.path.normpath(v)

    def check_core(self, w, state, via, relocated, link=False, into=False):
        """Deny when `w` is inside the install; ask when it may be (`into`: a folder a command
        writes into that holds the install — `tar -x -C ~/.claude`)."""
        p = self.core_place(w, state, relocated)
        if p is None:
            return
        if p == "suspect":
            self.ask("%s may write inside the machine-wide cohorte install (`%s` is computed at "
                     "run time) — confirm" % (via, w.raw))
        elif self.ctx.in_core(p):
            self.deny_core(via, "link to" if link else "write into", w.raw)
        elif into and self.ctx.core_below(p):
            self.ask("%s writes into `%s`, which holds the machine-wide cohorte install — "
                     "confirm" % (via, w.raw))

    def extract_targets(self, name, args, state, relocated):
        """Archive tools write their members into a folder: -C/--directory, -d, -o<dir>, or the
        current one — judged against the install only (a project folder holding .claude/ is the
        ordinary case). `tar -cf <file>` writes <file>."""
        dirs = []
        extract = False
        short = re.compile(r"^-[A-Za-z]+$")
        if name in ("tar", "bsdtar", "gtar"):
            first = args[0].value if args and not args[0].dynamic else ""
            old = bool(re.match(r"^[A-Za-z]+$", first))   # `tar xzf a.tgz`
            st = [w.value for w in args if not w.dynamic]
            extract = any(v in ("-x", "--extract", "--get") or (short.match(v) and "x" in v)
                          for v in st) or (old and "x" in first)
            creating = any(v in ("-c", "--create", "-r", "--append", "-u", "--update")
                           or (short.match(v) and set("cru") & set(v)) for v in st) \
                or (old and set("cru") & set(first))
            for k, w in enumerate(args):
                v = w.value
                if w.dynamic:
                    continue
                if v in ("-C", "--directory", "--cd") and k + 1 < len(args):
                    dirs.append(args[k + 1])
                elif v.startswith("--directory="):
                    dirs.append(static_word(v.split("=", 1)[1]))
                elif creating and not extract and v in ("-f", "--file") and k + 1 < len(args):
                    self.check_path(args[k + 1], state, "write", "`%s -f`" % name, relocated)
                elif creating and not extract and v.startswith("--file="):
                    self.check_path(static_word(v.split("=", 1)[1]), state, "write",
                                    "`%s --file`" % name, relocated)
        elif name == "unzip":
            extract = True
            for k, w in enumerate(args):
                if not w.dynamic and w.value == "-d" and k + 1 < len(args):
                    dirs.append(args[k + 1])
        elif name == "7z":
            extract = bool(args) and not args[0].dynamic and args[0].value in ("x", "e")
            for w in args:
                if not w.dynamic and w.value.startswith("-o") and len(w.value) > 2:
                    dirs.append(static_word(w.value[2:]))
                elif w.dynamic and w.raw.startswith("-o"):
                    dirs.append(w)
        elif name == "cpio":
            extract = any(not w.dynamic and (w.value in ("-i", "--extract") or
                                             (short.match(w.value) and "i" in w.value))
                          for w in args)
            for k, w in enumerate(args):
                if not w.dynamic and w.value in ("-D", "--directory") and k + 1 < len(args):
                    dirs.append(args[k + 1])
        if not extract:
            return
        for d in dirs or [static_word(".")]:
            self.check_core(d, state, "`%s`" % name, relocated, into=True)

    GIT_READ_ONLY = set("""status log diff show ls-files ls-tree ls-remote rev-parse rev-list
        describe blame annotate grep cat-file shortlog name-rev for-each-ref show-ref help version
        whatchanged count-objects var check-ignore check-attr check-ref-format merge-base cherry
        diff-tree diff-files diff-index show-branch range-diff verify-commit verify-tag""".split())

    def git_core(self, g, state, relocated):
        """git working in the install (`git -C <core> apply`, `cd <core> && git checkout x`) with
        anything but a read-only subcommand, and git creating a repository or worktree there."""
        via = "`git %s`" % (g.sub or "")
        writes = bool(g.sub) and g.sub not in self.GIT_READ_ONLY
        here = state.cwd if (state.cwd_known and not relocated) else None
        places = []
        for opt, w in g.places:
            p = self.core_place(w, state, here is None, base=here)
            if p is None or p == "suspect":
                if p == "suspect" and writes:
                    self.ask("%s runs in `%s`, computed at run time, which may be inside the "
                             "machine-wide cohorte install — confirm" % (via, w.raw))
                if opt == "-C":
                    here = None
                continue
            places.append(p)
            if opt == "-C":
                here = p
        if here is not None:
            places.append(here)
        if writes and any(self.ctx.in_core(p) for p in places):
            self.deny_core(via, "change files or refs in",
                           [p for p in places if self.ctx.in_core(p)][0])
            return
        pos = [w for w in g.args if not is_flag_word(w)]
        dest = []
        if g.sub == "clone" and len(pos) >= 2:
            dest = [pos[-1]]
        elif g.sub == "init":
            dest = pos[:1]
        elif g.sub == "worktree" and pos and pos[0].value == "add" and len(pos) >= 2:
            dest = [pos[1]]
        for w in dest:
            p = self.core_place(w, state, here is None, base=here)
            if p == "suspect":
                self.ask("%s writes into `%s`, computed at run time, which may be inside the "
                         "machine-wide cohorte install — confirm" % (via, w.raw))
            elif p is not None and self.ctx.in_core(p):
                self.deny_core(via, "write into", w.raw)

    # -- git checkout / restore / reset --hard: they overwrite worktree files ------------
    def git_restore(self, g, state, relocated):
        """`git checkout [<rev>] -- <pathspec>…`, `git restore [--source=<rev>] <pathspec>…`
        and `git reset --hard|--merge|--keep [<rev>]` rewrite files in the worktree. A pathspec
        naming a protected file is a write to it. A broader one (`.`, `.claude/`, `:/`, a glob)
        counts only when a protected file it covers differs from the source — asked of git;
        when git can't say, the call gets "ask". Index-only forms (`git restore --staged`,
        `git reset [<rev>] -- <path>`) don't touch the worktree."""
        a = g.args
        sub = g.sub
        via = "`git %s`" % sub
        source = None
        specs = []
        if sub == "reset":
            fl = flag_names(a)
            if not fl & {"--hard", "--merge", "--keep"}:
                return
            pos = [w for w in a if not is_flag_word(w) and w.value != "--"]
            source = pos[0] if pos else static_word("HEAD")
            specs = [static_word(":/")]
        elif sub == "checkout":
            if flag_names(a) & {"-b", "-B", "--orphan"} or any(
                    not w.dynamic and len(w.value) > 2 and w.value[0] == "-" and w.value[1] != "-"
                    and w.value[-1] in "bB" for w in a):
                return                     # a branch operation (handled by update_state)
            if any(not w.dynamic and w.value.startswith("--pathspec-from-file") for w in a):
                specs = [static_word(":/")]
            if any(not w.dynamic and w.value == "--" for w in a):
                k = [i for i, w in enumerate(a) if not w.dynamic and w.value == "--"][0]
                before = [w for w in a[:k] if not is_flag_word(w)]
                source = before[0] if before else None
                specs += a[k + 1:]
            else:
                pos = [w for w in a if not is_flag_word(w)]
                if pos and not self.pathish(pos[0], state):
                    source, pos = pos[0], pos[1:]
                specs += pos
        else:                              # restore
            fl = flag_names(a)
            if ("-S" in fl or "--staged" in fl) and not ("-W" in fl or "--worktree" in fl):
                return
            k = 0
            end = False
            while k < len(a):
                w = a[k]
                v = w.value
                if not end and not w.dynamic and v == "--":
                    end = True
                elif not end and not w.dynamic and v in ("-s", "--source"):
                    source = a[k + 1] if k + 1 < len(a) else None
                    k += 1
                elif not end and not w.dynamic and v.startswith("--source="):
                    source = static_word(v.split("=", 1)[1])
                elif not end and not w.dynamic and v.startswith("-s") and len(v) > 2 \
                        and not v.startswith("--"):
                    source = static_word(v[2:])
                elif not end and not w.dynamic and v.startswith("--pathspec-from-file"):
                    specs.append(static_word(":/"))
                elif not end and is_flag_word(w):
                    pass
                else:
                    specs.append(w)
                k += 1
        broad = []
        for spec in specs:
            self.restore_spec(spec, state, relocated, via, broad)
        if broad:
            self.restore_broad(broad, source, state, via)

    def pathish(self, w, state):
        """Is `git checkout`'s first positional (no `--`) a path rather than a revision?"""
        if w.dynamic:
            return w.glob or "/" in w.value.split(DYN)[-1]
        v = w.value
        if v in (".", "..") or v.startswith(":") or w.glob:
            return True
        return state.cwd_known and os.path.exists(os.path.join(state.cwd, expand_home(v)))

    def restore_spec(self, spec, state, relocated, via, broad):
        if spec.dynamic:
            t = self.known_text(spec, state)
            if t is None:
                if suspicious(spec.value.split(DYN)[-1], spec.raw):
                    self.ask("%s may overwrite a file the Cohorte gate depends on (`%s`) — confirm"
                             % (via, spec.raw))
                return
            spec = static_word(t)
        v = spec.value
        glob_like = spec.glob or any(c in v for c in "*?[")
        if v.startswith(":") and not v.startswith(":/"):
            magic = True                   # :(glob)…, :!…, :^… — judged as the whole repo
            rel, base = "", None
        elif v.startswith(":/"):
            magic = False
            rel, base = v[2:], None
        else:
            magic = False
            rel, base = expand_home(v), "cwd"
        if base == "cwd" and not os.path.isabs(rel) and (relocated or not state.cwd_known):
            # relative to a directory the gate can't resolve
            if suspicious(rel, v) or rel in ("", ".", "./") or glob_like:
                self.ask("%s rewrites `%s` in a directory the gate can't resolve — it may "
                         "overwrite a file the Cohorte gate depends on; confirm" % (via, v))
            return
        top = None
        if base is None or magic:
            if not state.cwd_known or relocated:
                self.ask("%s rewrites `%s` in a checkout the gate can't resolve — confirm"
                         % (via, v))
                return
            top = git_top_and_common(state.cwd)[0]
            if top is None:
                return
            target = os.path.normpath(os.path.join(top, "" if magic else rel))
            glob_like = glob_like or magic
        else:
            target = os.path.normpath(os.path.join(state.cwd, rel))
        if not glob_like and not v.endswith("/"):
            if self.classify_path(static_word(target), state, "write") in ("protected", "core"):
                self.check_path(static_word(target), state, "write", via)
                return
            if self.ctx.owner is not None:
                self.check_owner(static_word(target), state, "write", via)
        pre = target.rstrip(os.sep) + os.sep
        for p in sorted(self.ctx.protected):
            if p.startswith(pre) or (glob_like and not magic and fnmatch.fnmatchcase(p, target)) \
                    or (magic and p.startswith((top or target).rstrip(os.sep) + os.sep)):
                if p not in broad:
                    broad.append(p)

    def restore_broad(self, files, source, state, via):
        """Protected files a broad pathspec covers: a write only if one differs from what
        the command restores (the index, or <rev>)."""
        if source is not None and source.dynamic:
            self.ask("%s restores from a revision computed at run time over files the Cohorte "
                     "gate depends on — confirm" % via)
            return
        args = ["diff", "--name-only", "--no-renames"]
        if source is not None:
            args.append(source.value)
        r = run_git(args + ["--"] + files, state.cwd)
        if r is None or r[0] != 0:
            self.ask("%s covers files the Cohorte gate depends on and git can't tell whether it "
                     "would change them — confirm" % via)
            return
        changed = [ln.strip() for ln in r[1].splitlines() if ln.strip()]
        if not changed:
            return
        top = git_top_and_common(state.cwd)[0] or state.cwd
        for c in changed:
            self.check_path(static_word(os.path.normpath(os.path.join(top, c))), state, "write",
                            via)


# ══ core/hooks/gate/indirect.py ══════════════════════════════════════════════
PROTECTED_NAME_RE = re.compile(r"gate-config\.json|preflight\.ok|\.claude/settings(\.local)?\.json|"
                               r"cohorte-gate\.py|\.claude/profile\.json")
SPAWN_RE = {
    "py": re.compile(r"\bos\.(system|popen|exec\w*|spawn\w*)|\bsubprocess\b|\bpty\.spawn|"
                     r"\bcommands\.getoutput|\bpexpect\b|\bsh\.\w+\("),
    "js": re.compile(r"child_process|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b|\bexecFile\(|"
                     r"\bexec\(|\bspawn\(|Bun\.spawn|Deno\.(Command|run)|\$`|zx"),
    "pl": re.compile(r"\bsystem\b|\bexec\b|`|\bqx\b|IO\.popen|Open3|\bspawn\b|%x|\bpopen\b|"
                     r"\bshell_exec\b|\bpassthru\b|\bproc_open\b"),
}
STRING_LIT_RE = re.compile(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"")


def lang_of(name):
    if name.startswith("py"):
        return "py"
    if name in ("node", "nodejs", "deno", "bun"):
        return "js"
    return "pl"


class Indirection(object):
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
        if name == "verify-run.sh":
            self.verify_args(args, state, depth)
            return
        if name == "kanban-move.sh":
            self.kanban_args(args, state)
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
        if name in ("ssh", "mosh"):
            k = 0
            with_arg = set("-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w -B".split())
            while k < len(args) and args[k].value.startswith("-") and not args[k].dynamic:
                k += 2 if args[k].value in with_arg else 1
            rest = args[k + 1:]
            if rest:
                remote = state.copy()
                remote.cwd_known = False
                remote.sticky = True
                if any(a.dynamic for a in rest):
                    self.opaque("`ssh` runs a remote command built at run time", seg.text)
                else:
                    self.analyze_text(" ".join(a.value for a in rest), remote, depth + 1)
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
        elif cmd_name(script.value) == "verify-run.sh":
            self.verify_args(sargs, state, depth)
        elif cmd_name(script.value) == "kanban-move.sh":
            self.kanban_args(sargs, state)

    def preflight_args(self, args, state, depth):
        """preflight.sh <report> "<cmd>"…: it truncates <report>, and runs each cmd via sh -c."""
        if not args:
            return
        self.check_path(args[0], state, "write", "preflight.sh's report argument")
        for a in args[1:]:
            self.handed_command("preflight.sh", a, a.raw if a.dynamic else a.value, state, depth)

    # verify-run.sh run <id> --dev "<cmd>" --check "<name>=<cmd>" --migrate "<cmd>" …: every
    # command it is handed runs through a shell, so judge each one here — the script also asks
    # the gate itself, but its `--confirmed` flag is the agent's to set, and a DENIED command must
    # stay denied, an unapproved one asked, whatever the flag says.
    VERIFY_CMD_FLAGS = {"--dev": False, "--ready": False, "--migrate": False,
                        "--migrate-down": False, "--check": True}

    def verify_args(self, args, state, depth):
        self.verify_outputs(args, state)
        k = 0
        while k < len(args):
            a = args[k]
            flag = a.value
            if a.dynamic and a.split:
                # an unquoted expansion may be any words — `--check "x=…"` included
                if not self.raw_deny(a.raw):
                    self.ask("verify-run.sh is handed arguments built at run time (`%s`), so the "
                             "commands it would run can't be checked — confirm" % a.raw)
                k += 1
                continue
            if flag in self.VERIFY_CMD_FLAGS and k + 1 < len(args):
                a = args[k + 1]
                cmd = a.raw if a.dynamic else a.value
                if self.VERIFY_CMD_FLAGS[flag] and "=" in cmd:
                    cmd = cmd.split("=", 1)[1]          # --check "<name>=<cmd>"
                if not (flag == "--ready" and not a.dynamic and re.match(r"^https?://", cmd.strip())):
                    self.handed_command("verify-run.sh", a, cmd, state, depth)
                k += 2
                continue
            k += 1

    def verify_outputs(self, args, state):
        """verify-run.sh writes <out>/<id>.<phase>.json, .md and <out>/<id>.<phase>/ (`stop`
        deletes <out>/<id>.<phase>/pgids) — unprompted, so each is a write the gate judges.
        Relative to the checkout's top, which is the cwd in practice."""
        if not args or args[0].dynamic or args[0].value not in ("run", "stop"):
            return
        out, phase = static_word("specs/reports"), "verify"
        k = 2
        while k < len(args):
            v = args[k].value
            if not args[k].dynamic and v in ("--out", "--phase") and k + 1 < len(args):
                if v == "--out":
                    out = args[k + 1]
                elif not args[k + 1].dynamic:
                    phase = args[k + 1].value
                k += 2
                continue
            k += 1
        via = "verify-run.sh's --out"
        if out.dynamic and self.known_text(out, state) is None:
            self.ask("verify-run.sh would write its reports into `%s`, a folder computed at run "
                     "time the gate can't check — confirm" % out.raw)
            return
        if out.dynamic:
            out = static_word(self.known_text(out, state))
        self.check_path(out, state, "write", via)
        if len(args) > 1 and not args[1].dynamic:
            base = os.path.join(out.value, "%s.%s" % (args[1].value, phase))
            for p in (base + ".json", base + ".md", base):
                self.check_path(static_word(p), state, "write", via)

    def kanban_args(self, args, state):
        """kanban-move.sh <board.md|auto> …: an explicit board is rewritten in place."""
        if args and (args[0].dynamic or args[0].value not in ("auto", "--check")):
            self.check_path(args[0], state, "write", "kanban-move.sh's board argument")

    def handed_command(self, script, word, cmd, state, depth):
        """A command a pipeline script will execute. Claude Code approved only the script call
        (`cohorte sync` allowlists <core>/pipeline/scripts/), so the inner command runs with no
        prompt of its own: the gate's rules judge it, and when nothing denies or asks, it runs
        unprompted only if the profile declares it or a permissions.allow rule covers it."""
        if word.dynamic:
            if not self.raw_deny(word.raw):
                self.ask("%s would run a command built at run time (`%s`), which the gate can't "
                         "check — confirm" % (script, short(word.raw)))
            return
        if not cmd.strip():
            return
        self.analyze_text(cmd, state.copy(), depth + 1)
        verdict = self.ctx.approvals().judge(cmd)
        if verdict == "allow":
            return
        if verdict is not None:
            (self.deny if verdict[0] == "deny" else self.ask)(
                "%s would run `%s`: %s" % (script, short(cmd), verdict[1]))
            return
        self.ask("%s would run `%s` without a permission prompt of its own, and it is neither a "
                 "command of the project's profile (.claude/profile.json) nor covered by a "
                 "permissions.allow rule — confirm it" % (script, short(cmd)))

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
        elif self.ctx.mentions_core(code) or (state.cwd_known and self.ctx.in_core(state.cwd)):
            self.ask("inline code references (or runs inside) the machine-wide cohorte install, "
                     "which agents never write — confirm it only reads it")
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


# ══ core/hooks/gate/analyze.py ═══════════════════════════════════════════════
MAX_DEPTH = 6
WRITE_OPS = {">", ">>", ">|", "&>", "&>>", "<>"}


class State(object):
    def __init__(self, cwd, env=None):
        self.cwd = cwd
        self.cwd_known = cwd is not None
        self.sticky = False           # branch unknown for the rest of the chain
        self.written = set()
        self.git_aliases = {}
        # (cwd, branch, may_track): the branch an earlier `git switch -c`/`checkout -b` of
        # this chain created and checked out at cwd — HEAD on disk doesn't show it yet.
        self.branch = None
        self.env = static_env() if env is None else env   # variables the lexer resolves
        self.rebound = set()          # KNOWN_VARS this command may assign (never substituted)

    def copy(self):
        s = State(self.cwd, dict(self.env))
        s.cwd_known = self.cwd_known
        s.sticky = self.sticky
        s.written = set(self.written)
        s.git_aliases = dict(self.git_aliases)
        s.branch = self.branch
        s.rebound = set(self.rebound)
        return s


STATIC_VAR_ALONE_RE = re.compile(r'^"?\$\{?(HOME|CLAUDE_CONFIG_DIR)\b[^/]*"?$')

SWITCH_CREATE = {"switch": ({"-c", "-C", "--create", "--force-create", "--orphan"}, "cC", "dfmqt"),
                 "checkout": ({"-b", "-B", "--orphan"}, "bB", "dfmqtl")}


def created_branch(g):
    """(name, may_track) for a `git switch -c|-C|--orphan <name>` / `git checkout -b|-B|--orphan
    <name>` whose name is static, else None. may_track: a start point or --track was given, so
    the new branch may have an upstream (and a bare push may go there)."""
    spec = SWITCH_CREATE.get(g.sub)
    if spec is None:
        return None
    longs, creators, plain = spec
    a = g.args
    for k, w in enumerate(a):
        if w.dynamic:
            return None
        v = w.value
        if v == "--":
            return None
        name = rest = None
        if v in longs or (len(v) > 2 and v[0] == "-" and v[1] != "-" and v[-1] in creators
                          and all(ch in plain for ch in v[1:-1])):
            if k + 1 >= len(a) or a[k + 1].dynamic or a[k + 1].value.startswith("-"):
                return None
            name, rest = a[k + 1].value, a[k + 2:]
        else:
            for o in longs:
                if o.startswith("--") and v.startswith(o + "="):
                    name, rest = v.split("=", 1)[1], a[k + 1:]
        if name is not None:
            if not name:
                return None
            track = any(not x.dynamic and (x.value in ("-t", "--track")
                                           or x.value.startswith("--track="))
                        for x in a[:k] + rest)
            starts = [x for x in rest if x.dynamic or not x.value.startswith("-")]
            return name, bool(track or starts)
    return None


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
        self.cores = []
        self.prefixes = []


class Analyzer(Indirection, SelfProtection, RuleChecks, Findings):
    def __init__(self, ctx):
        self.ctx = ctx
        self.findings = []

    def analyze_text(self, text, state, depth):
        if depth > MAX_DEPTH:
            self.opaque("commands are nested too deep", text)
            return
        blocked = rebound_vars(text, KNOWN_VARS)
        if blocked:
            # the text may assign one of them: its value is not the hook's
            state.rebound |= blocked
            state.env = {k: v for k, v in state.env.items() if k not in blocked}
        try:
            segs = parse_command(text, state.env)
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
        if (words and not words[0].quoted and words[0].value == "function" and not seg.funcdef
                and len(words) > 2 and not words[2].quoted and words[2].value in ("{", "(")):
            words = words[2:]            # `function f { …; }`: judge the body
            while words and not words[0].quoted and words[0].value in RESERVED_SKIP:
                words.pop(0)
        if words and not words[0].quoted and words[0].value in RESERVED_HEADER:
            return None
        if words and words[-1].value == "}" and not words[-1].quoted:
            words.pop()
        argv, assigns, env_s, relocated, lookup = strip_prefixes(words)
        prefixes = list(PREFIXES_SEEN)
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
        if STATIC_VAR_ALONE_RE.match(cmd.raw):
            # `$HOME` as the whole command name: whatever it holds is the command
            self.run_opaque_name(seg) or self.opaque("the command name is computed at run time", seg.text)
            return None
        if cmd.dynamic:
            base = static_basename(cmd)
            if base is None:
                self.run_opaque_name(seg) or self.opaque("the command name is computed at run time", seg.text)
                return None
            cmd = static_word(base)
        name = cmd_name(cmd.value)
        args = argv[1:]
        inv = Inv(name, args, seg)
        inv.prefixes = prefixes
        self.run_guard(inv, assigns, seg)

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
            inv.cores = wrapper_cores(name, args)

        here_unknown = seg_unknown or state.sticky or not state.cwd_known
        if inv.git and inv.git.sub == "push":
            self.eval_push(inv, state, here_unknown)
        self.match_config(inv, state, here_unknown)
        self.indirection(inv, seg, prev, prev_inv, state, depth)
        self.protect(inv, state, seg_unknown)
        self.update_state(inv, seg, state, assigns, prev, seg_unknown)
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

    # -- chain state -----------------------------------------------------------------
    def update_state(self, inv, seg, state, assigns, prev=None, seg_unknown=False):
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
                target = home_dir()
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
                    target = expand_home(w.value)
            if not os.path.isabs(target):
                if not state.cwd_known:
                    return
                target = os.path.join(state.cwd, target)
            if os.path.isdir(target):
                state.cwd = os.path.realpath(target)
                state.cwd_known = True
                state.branch = None
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
            made = created_branch(g) if sub in ("switch", "checkout") else None
            if (made and seg.sep == "&&" and not g.relocated and not seg_unknown
                    and state.cwd_known and (prev is None or prev.sep != "||")):
                # `git switch -c feat && …`: the rest of the chain only runs once HEAD is on
                # `feat`. Not after `;` (a failed switch leaves HEAD where it was) nor after
                # `a || git switch -c x` (the switch may not run at all).
                state.branch = (state.cwd, made[0], made[1])
            elif sub in ("switch", "bisect"):
                state.sticky = True
            elif sub == "checkout" and not any(w.value == "--" for w in g.args):
                state.sticky = True
            elif sub == "branch" and (flag_names(g.args) & {"-m", "-M", "--move"}):
                state.sticky = True

    def classify_dynamic_dir(self, w, state):
        t = w.raw
        if len(t) >= 2 and t[0] == t[-1] == '"':
            t = t[1:-1]
        # Only $HOME: CLAUDE_PROJECT_DIR is set for hooks but usually NOT in the agent's
        # Bash call, so resolving it here could judge the branch in the wrong directory.
        val = home_dir()
        t = t.replace("${HOME}", val).replace("$HOME", val)
        if "$" in t or "`" in t or "'" in t or '"' in t or "\\" in t:
            return None
        return t


def static_basename(w):
    """The program a run-time command name runs, when only its directory is computed:
    `"$S/smoke.sh"` runs `smoke.sh`. None when the basename itself is computed, a glob, or the
    word is unquoted (field splitting could make the command name any word)."""
    if w.split or w.glob:
        return None
    tail = w.value.split(DYN)[-1]
    if "/" not in tail:
        return None
    base = tail.rsplit("/", 1)[1]
    return base or None


# ══ core/hooks/gate/preflight.py ═════════════════════════════════════════════
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


# ══ core/hooks/gate/evaluate.py ══════════════════════════════════════════════
# ── evaluation ───────────────────────────────────────────────────────────────
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


def edit_targets(ti):
    """Every path a Write/Edit/MultiEdit/NotebookEdit call names. Only Write and Edit have a
    documented schema (`file_path`); `notebook_path` and per-edit `file_path`s are read
    defensively."""
    out = []
    for k in ("file_path", "notebook_path"):
        v = ti.get(k)
        if isinstance(v, str) and v and v not in out:
            out.append(v)
    edits = ti.get("edits")
    if isinstance(edits, list):
        for e in edits:
            v = e.get("file_path") if isinstance(e, dict) else None
            if isinstance(v, str) and v and v not in out:
                out.append(v)
    return out


def edit_ownership(ctx, tool, targets):
    """Surface ownership for an edit tool: a deny, or None. Fails closed — the caller is a
    known surface agent, so a target the gate can't find or judge is refused."""
    if not targets:
        return ("deny", "`%s` by surface agent `%s` names no file path the gate can check "
                "(surface ownership) — refused" % (tool, ctx.owner.agent))
    for fp in targets:
        try:
            p = expand_home(fp)
            if not os.path.isabs(p):
                p = os.path.join(ctx.cwd0 or os.getcwd(), p)
            why = ctx.owner.judge(p)
        except Exception as e:
            why = "surface ownership could not be checked (%s: %s) — refused" % (type(e).__name__, e)
        if why:
            return ("deny", "`%s` of `%s` refused: %s" % (tool, fp, why))
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
    if tool == "Bash" or tool in EDIT_TOOLS:
        ctx.owner = Ownership.load(ctx, payload)
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
        targets = edit_targets(ti)
        if ctx.owner is not None:
            decision = edit_ownership(ctx, tool, targets)
        for fp in targets if decision is None else ():
            p = fp if os.path.isabs(fp) else os.path.join(ctx.cwd0 or ".", fp)
            p = expand_home(p)
            if ctx.in_core(os.path.abspath(p)):
                decision = ("deny", "`%s` of `%s` refused: it is inside the machine-wide cohorte "
                            "install (the core every project runs, cohorte ui's state, the global "
                            "cohorte-* commands, agents and workflows) — agents never write there "
                            "(self-protection); `cohorte update`, run by the human, is how it "
                            "changes" % (tool, fp))
                break
            if os.path.normpath(p) in ctx.protected or os.path.realpath(p) in ctx.protected:
                decision = ("ask", "`%s` edits `%s`, a file the Cohorte gate depends on "
                            "(self-protection) — confirm this change is intended" % (tool, fp))
                break
    if decision is None:
        return None
    level, reason = decision
    if level == "ask" and mode in UNATTENDED_MODES:
        level = "deny"
        reason += unattended_hint(mode, reason)
    return level, "Cohorte gate: " + reason


def unattended_hint(mode, reason):
    """What a human can do about an "ask" that became a deny because nobody can answer it. The
    gate has no allow list: a hook "ask" can't be pre-approved from settings.json."""
    how = ["run it from a session in `default` or `acceptEdits` mode, where the gate asks "
           "instead of refusing"]
    if "gate-config.json" in reason or "is gated" in reason or "gated command" in reason:
        how.append("if this rule should not stop unattended runs, change or remove it in the "
                   "profile's gate block (PIPELINE.md) and run /cohorte-update-pipeline, which "
                   "regenerates .claude/gate-config.json (`deny`/`ask`/`ask_on_default_branch`; "
                   "there is no allow list)")
    if "default branch" in reason:
        how.append("or do it on a feature branch, where `ask_on_default_branch` rules don't fire")
    if "without a permission prompt of its own" in reason:
        how.append("or, for a command the pipeline should run unattended, declare it in the "
                   "profile (PIPELINE.md `commands`, a surface's `*_cmd`) and run `cohorte sync`, "
                   "or add a `Bash(…)` rule to permissions.allow in .claude/settings.json")
    if "run time" in reason or "can't parse" in reason or "can't check" in reason:
        how.append("or write the command with literal paths and arguments so the gate can check it")
    return (" (denied outright: permission mode `%s` has nobody to confirm. To allow it: %s. "
            "Agent: report this to the human; don't reword the command to get past the gate.)"
            % (mode, "; ".join(how)))


# ══ core/hooks/gate/main.py ══════════════════════════════════════════════════
# ── entry points ─────────────────────────────────────────────────────────────
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
        if not decision and mode == "--check":
            decision = approval(payload)
    except Exception as e:
        decision = ("deny", "Cohorte gate failed closed: %s: %s" % (type(e).__name__, e))
    if not decision:
        print("gate: allow")
        return 0
    if decision[0] == "defer":
        print("gate: defer — %s" % decision[1])
        return 3
    print("gate: %s — %s" % decision)
    return 2 if decision[0] == "deny" else 1


def approval(payload):
    """For `--check` once no gate rule denies or asks: None (allow) when the gate is inert here
    or the command is approved (approve.py), else ("defer", why) — Claude Code's own permission
    would decide, so a script running the command unprompted must treat it as an "ask"."""
    ctx = Ctx(payload["cwd"], payload["permission_mode"])
    if not ctx.active:
        return None
    verdict = ctx.approvals().judge(payload["tool_input"]["command"])
    if verdict == "allow":
        return None
    if verdict is not None:
        level, why = verdict
        if level == "ask" and payload["permission_mode"] in UNATTENDED_MODES:
            level = "deny"
        return level, "Cohorte gate: " + why
    return ("defer", "no gate rule matches; it is not a command of the project's profile "
            "(.claude/profile.json) nor covered by a permissions.allow rule, so Claude Code's "
            "own permission would decide — a script must ask before running it")


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


def _utf8_streams():
    """Claude Code reads hook output as UTF-8; Windows consoles default to a code page."""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main():
    _utf8_streams()
    argv = sys.argv[1:]
    if argv and argv[0] in ("--check", "--check-dispatch"):
        return check_cli(argv)
    argv = strip_runtime(argv)
    if argv and argv[0] in ("--check", "--check-dispatch"):
        return check_cli(argv)
    try:
        data = sys.stdin.buffer.read()
    except Exception as e:
        # Could not even read the call: refuse it in an active project (fail closed).
        if is_active_fallback():
            emit("deny", "Cohorte gate: the hook payload could not be read (%s) — refused for "
                 "safety (fail closed)." % type(e).__name__)
        return 0
    return hook(data.decode("utf-8", errors="replace"))


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
