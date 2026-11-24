"""`Analyzer`: the verdict for one Bash command.

It walks every simple command of the parsed text and, for each, applies the hard floor and
the config rules (`RuleChecks`, rules.py), follows indirection (`Indirection`, indirect.py),
applies self-protection and Bash-side surface ownership (`SelfProtection`, protect.py), and
tracks chain state (`cd`, branch unknown after checkout, …). Findings accumulate in
`Findings` (findings.py); the strictest one wins.
"""

import os
import re
import shlex

from .runtime import expand_home, home_dir
from .shell import (
    ASSIGN_RE, cmd_name, DYN, GIT_ENV_VARS, is_flag_word, parse_command, ParseError,
    KNOWN_VARS, PREFIXES_SEEN, rebound_vars, RESERVED_HEADER, RESERVED_SKIP, static_env, static_word,
    strip_prefixes,
)
from .git import GIT_BUILTINS, parse_git
from .patterns import flag_names, runner_core, wrapper_cores
from .findings import Findings, norm_lower
from .rules import RuleChecks
from .protect import SelfProtection
from .indirect import Indirection


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
            self.opaque("the command name is computed at run time", seg.text)
            return None
        if cmd.dynamic:
            base = static_basename(cmd)
            if base is None:
                self.opaque("the command name is computed at run time", seg.text)
                return None
            cmd = static_word(base)
        name = cmd_name(cmd.value)
        args = argv[1:]
        inv = Inv(name, args, seg)
        inv.prefixes = prefixes

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
