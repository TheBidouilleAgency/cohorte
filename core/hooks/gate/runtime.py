"""The time budget, the git runner and stderr warnings.

The hook is registered with onFailure "block", so every git call draws on one global budget
(`COHORTE_GATE_BUDGET_S` can only lower it) and an exhausted budget answers "ask". `_START`
and `BUDGET_S` are computed when the gate starts, which is why this module comes first.
"""

import os
import re
import subprocess
import sys
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
