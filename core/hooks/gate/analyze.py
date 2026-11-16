"""`Analyzer`: the verdict for one Bash command.

It walks every simple command of the parsed text, follows indirection (`sh -c`, `eval`,
heredocs fed to a shell, `$(…)`, inline interpreter code, xargs, find -exec, git aliases),
applies the hard floor (force push / remote delete to the default branch), self-protection,
the config rules (branch-aware) and Bash-side surface ownership, and tracks chain state
(`cd`, branch unknown after checkout, …). The strictest finding wins.
"""

import fnmatch
import glob
import os
import re
import shlex

from .runtime import run_git, warn
from .shell import (
    ASSIGN_RE, cmd_name, DYN, GIT_ENV_VARS, INTERP_RE, is_flag_word, parse_command, ParseError,
    PREFIXES_SEEN, RESERVED_HEADER, RESERVED_SKIP, Seg, SHELLS, static_word, strip_prefixes,
    wildcard_word,
)
from .git import analyze_push_args, BRANCH_SUBST_RE, GIT_BUILTINS, normalize_ref, parse_git
from .patterns import FLAG_ALIASES, flag_names, match_args, match_push, runner_core, wrapper_cores

# ── analysis ─────────────────────────────────────────────────────────────────
PROTECTED_HINT_RE = re.compile(r"(^|/)\.claude(/|$)|gate-config\.json|preflight\.ok|"
                               r"settings(\.local)?\.json|cohorte-gate\.py|pipeline\.json|"
                               r"(^|/)\.cohorte(/|$)")
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
PROTECTED_BASENAMES = {"gate-config.json", "preflight.ok", "settings.json", "settings.local.json", "profile.json",
                      "cohorte-gate.py", "pipeline.json", ".claude", ".cohorte", "hooks", "~", "",
                      ".", ".."}


def suspicious(tail, raw):
    """For a path the gate can't resolve: could it name a protected file? Its static tail
    decides — `…/.claude/pipeline-metrics.jsonl` can't, `$DIR/.claude/settings.json` can."""
    base = os.path.basename(tail.rstrip("/")) if tail else ""
    if tail and "/" in tail and base not in PROTECTED_BASENAMES and not tail.endswith("/"):
        return False
    return bool(PROTECTED_HINT_RE.search(raw))


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
        self.cores = []
        self.prefixes = []


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
        if cmd.dynamic:
            self.opaque("the command name is computed at run time", seg.text)
            return None
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
        if name == "verify-run.sh":
            self.verify_args(args, state, depth)
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

    # verify-run.sh run <id> --dev "<cmd>" --check "<name>=<cmd>" --migrate "<cmd>" …: every
    # command it is handed runs through a shell, so judge each one here — the script also asks
    # the gate itself, but its `--confirmed` flag is the lead's word, and a DENIED command must
    # stay denied whatever the flag says.
    VERIFY_CMD_FLAGS = {"--dev": False, "--ready": False, "--migrate": False,
                        "--migrate-down": False, "--check": True}

    def verify_args(self, args, state, depth):
        k = 0
        while k < len(args):
            flag = args[k].value
            if flag in self.VERIFY_CMD_FLAGS and k + 1 < len(args):
                a = args[k + 1]
                if a.dynamic:
                    self.opaque("verify-run.sh runs a command built at run time", a.raw)
                else:
                    cmd = a.value
                    if self.VERIFY_CMD_FLAGS[flag] and "=" in cmd:
                        cmd = cmd.split("=", 1)[1]          # --check "<name>=<cmd>"
                    if not (flag == "--ready" and re.match(r"^https?://", cmd.strip())):
                        self.analyze_text(cmd, state.copy(), depth + 1)
                k += 2
                continue
            k += 1

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

    def known_text(self, w, state):
        """A run-time word with only the variables the gate can resolve itself
        ($CLAUDE_PROJECT_DIR, $HOME, $PWD) substituted, or None if anything else is left."""
        t = w.raw
        if len(t) >= 2 and t[0] == t[-1] == '"':
            t = t[1:-1]
        for var, val in (("CLAUDE_PROJECT_DIR", os.environ.get("CLAUDE_PROJECT_DIR")),
                         ("HOME", os.path.expanduser("~")),
                         ("PWD", state.cwd if state.cwd_known else None)):
            if val:
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
        v = os.path.expanduser(w.value)
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

    def check_owner(self, w, state, mode, via, relocated=False, existing=False):
        """Surface ownership for a Bash write — best effort: a target the gate can't resolve
        statically (a run-time word, a relative path after an unresolvable `cd`) is let
        through, never asked about (an ask is a deny in unattended runs)."""
        try:
            t = self.known_text(w, state) if w.dynamic else w.value
            if not t:
                return
            v = os.path.expanduser(t)
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
        # Only $HOME: CLAUDE_PROJECT_DIR is set for hooks but usually NOT in the agent's
        # Bash call, so resolving it here could judge the branch in the wrong directory.
        val = os.path.expanduser("~")
        t = t.replace("${HOME}", val).replace("$HOME", val)
        if "$" in t or "`" in t or "'" in t or '"' in t or "\\" in t:
            return None
        return t
