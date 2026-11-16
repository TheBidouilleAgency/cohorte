"""The preflight phase gate for Task/Agent dispatches.

A dispatch of a listed subagent needs a fresh `.claude/preflight.ok` stamp whose content
digest (`tree_digest`, the same git tree id scripts/preflight.sh computes) equals the
dispatch checkout's.
"""

import os
import re
import shutil
import tempfile
import time

from .runtime import git_env, remaining, run_git, TimedOut
from .config import git_top_and_common

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
