"""`Ctx`: everything one evaluation knows about the project.

Merged gate-config.json rules (compiled to patterns), errors and warnings, whether the
project is active (pointer or config), the self-protected paths, and cached git state
(branch, default branches, aliases).
"""

import fnmatch
import json
import os

from .runtime import run_git, warn
from .config import ConfigError, resolve_roots, validate_config
from .patterns import compile_pattern
from .approve import Approvals

# ── context ──────────────────────────────────────────────────────────────────
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
