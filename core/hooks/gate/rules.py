"""`RuleChecks`: the hard floor on `git push` and the project's config rules.

`eval_push` resolves where a push lands (refspecs, `HEAD`, the upstream/push target of a bare
push, `--all`/`--mirror`, `push.default matching`) and denies a force push or remote deletion
that reaches the default branch. `match_config` and `multi_patterns` match the deny / ask /
ask_on_default_branch patterns against one command or a run of commands; `branch_gated` says
whether the branch is the default one or can't be known.
"""

from .runtime import run_git
from .git import analyze_push_args, BRANCH_SUBST_RE, normalize_ref
from .patterns import FLAG_ALIASES, match_args, match_push
from .findings import short


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
