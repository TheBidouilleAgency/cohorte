"""Output envelopes and the entry points.

`emit` prints Claude Code's `hookSpecificOutput` envelope; `hook` reads a payload and fails
closed in an active project; `check_cli` is the `--check` / `--check-dispatch` mode for
scripts and humans; `main` dispatches between them. The `__main__` guard is last: a crash
must never read as "allow".
"""

import json
import os
import re
import shlex
import sys

from .runtime import warn
from .context import Ctx
from .evaluate import default_cwd, DISPATCH_TOOLS, evaluate

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
