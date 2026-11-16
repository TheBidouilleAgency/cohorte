"""Surface ownership: `.claude/profile.json` loading and path judgement.

A surface agent may only write under its own `surfaces[].path` (+ `owns_also`,
+ `ownership.shared_writable`), never to the contract. `Ownership.load` never raises for a
malformed profile; `Ownership.judge` returns the reason a path is refused, or None.
"""

import fnmatch
import json
import os

from .runtime import warn
from .config import git_top_and_common

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
