"""gate-config.json validation and project-root resolution.

`validate_config` checks the shape of one `gate-config.json` (deny / ask /
ask_on_default_branch / default_branch / preflight) and raises `ConfigError` on wrong types;
`resolve_roots` lists the checkouts whose config applies (the cwd's, $CLAUDE_PROJECT_DIR, the
main checkout of a linked worktree).
"""

import json
import os

from .runtime import home_dir, run_git

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
