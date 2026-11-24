"""The decision for one PreToolUse payload.

`evaluate` routes Bash to `Analyzer`, Task/Agent to `Dispatch`, Write/Edit/MultiEdit/
NotebookEdit to surface ownership and self-protection, and turns "ask" into "deny" in
permission modes where nobody can answer.
"""

import os

from .ownership import Ownership
from .context import Ctx
from .analyze import Analyzer, State
from .preflight import Dispatch

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
            p = os.path.expanduser(fp)
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
            p = os.path.expanduser(p)
            if ctx.in_protected_dir(os.path.normpath(p)) or ctx.in_protected_dir(os.path.realpath(p)):
                decision = ("deny", "`%s` writes `%s`, the company flow's state (tickets, features, runs, answers) "
                            "— only cohorte ui and the `cohorte` commands write there (self-protection)" % (tool, fp))
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
    if "run time" in reason or "can't parse" in reason or "can't check" in reason:
        how.append("or write the command with literal paths and arguments so the gate can check it")
    return (" (denied outright: permission mode `%s` has nobody to confirm. To allow it: %s. "
            "Agent: report this to the human; don't reword the command to get past the gate.)"
            % (mode, "; ".join(how)))
