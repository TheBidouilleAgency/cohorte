"""`Approvals`: which commands a pipeline script may run without anyone being asked.

preflight.sh and verify-run.sh execute the commands they are handed. Claude Code approves the
OUTER call (`cohorte sync` allowlists `<core>/pipeline/scripts/`), so an inner command that no
gate rule matches would otherwise run with no permission prompt at all. An inner command is
approved only when it is exactly one the project's committed `.claude/profile.json` declares
(human-reviewed, self-protected), or when every simple command in it matches a `Bash(…)` rule
of `permissions.allow` in the settings Claude Code itself reads. Anything else is "ask".
"""

import json
import os
import re

from .runtime import home_dir, warn
from .shell import parse_command, ParseError

# ── approvals ────────────────────────────────────────────────────────────────
# /cohorte-review's documented fallback when a surface has no bridled variant
# (profile/schema/output-discipline.md), and the no-op marker review.js puts before the scans.
QUIET_SUFFIX = " 2>&1 | tail -40"
SECURITY_MARKER = ": cohorte-security-scans"
# The slot's port replaces the profile's in a feature worktree (profile/schema/verify.md §Ports).
PORT_RE = re.compile(r"(?<=:)\d{2,5}(?![0-9])")
RULE_RE = re.compile(r"^\s*Bash\s*(?:\((.*)\))?\s*$", re.S)
DUP_TARGET_RE = re.compile(r"^(\d+|-)$")


def norm_cmd(s):
    """Whitespace collapsed, ports blanked: how a profile command and a handed one compare."""
    return PORT_RE.sub("<port>", " ".join(s.split()))


def profile_commands(prof):
    """Every command string `.claude/profile.json` declares: `commands.*` (a string, or a list
    like `commands.security`), each surface's `*_cmd`, and `verify.surfaces.<key>.smoke`."""
    out = []

    def add(v):
        if isinstance(v, list):
            for x in v:
                add(x)
        elif isinstance(v, str) and v.strip() and not v.strip().startswith("<"):
            out.append(v.strip())

    if not isinstance(prof, dict):
        return out
    cmds = prof.get("commands")
    if isinstance(cmds, dict):
        for v in cmds.values():
            add(v)
    for s in prof.get("surfaces") if isinstance(prof.get("surfaces"), list) else []:
        if isinstance(s, dict):
            for k, v in s.items():
                if isinstance(k, str) and k.endswith("_cmd"):
                    add(v)
    ver = prof.get("verify")
    vs = ver.get("surfaces") if isinstance(ver, dict) else None
    if isinstance(vs, dict):
        for v in vs.values():
            if isinstance(v, dict):
                add(v.get("smoke"))
    return out


def rule_matches(content, text):
    """Claude Code's `Bash(…)` rule semantics for one simple command: no content or `*` = any
    command; `prefix:*` = the prefix as whole words; a `*` elsewhere = any run of characters;
    otherwise the exact command."""
    if content is None or content.strip() in ("", "*"):
        return True
    c = content.strip()
    if c.endswith(":*"):
        p = c[:-2].rstrip()
        return text == p or text.startswith(p + " ")
    if "*" in c:
        rx = ".*".join(re.escape(part) for part in c.split("*"))
        return re.match("^" + rx + "$", text, re.S) is not None
    return text == c


class Approvals(object):
    def __init__(self, roots):
        self.profile = set()
        self.rules = {"allow": [], "ask": [], "deny": []}
        for r in roots:
            p = os.path.join(r, ".claude", "profile.json")
            prof = self._load(p)
            for c in profile_commands(prof):
                self.profile.add(norm_cmd(c))
                self.profile.add(norm_cmd(c + QUIET_SUFFIX))
        self.profile.add(norm_cmd(SECURITY_MARKER))
        cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home_dir(), ".claude")
        files = [os.path.join(cfg, "settings.json")]
        for r in roots:
            files += [os.path.join(r, ".claude", "settings.json"),
                      os.path.join(r, ".claude", "settings.local.json")]
        for f in files:
            data = self._load(f)
            perms = data.get("permissions") if isinstance(data, dict) else None
            if not isinstance(perms, dict):
                continue
            for kind in ("allow", "ask", "deny"):
                lst = perms.get(kind)
                for rule in lst if isinstance(lst, list) else []:
                    m = RULE_RE.match(rule) if isinstance(rule, str) else None
                    if m:
                        self.rules[kind].append((rule.strip(), m.group(1)))

    @staticmethod
    def _load(path):
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception as e:
            warn("%s is unreadable (%s) — its commands and rules approve nothing" % (path, e))
            return None

    @staticmethod
    def simple_commands(text):
        """[(text, plain)] for each simple command, where plain = no substitution, subshell,
        heredoc, function or file redirection (only those can be approved by an allow rule);
        None when the text can't be parsed."""
        try:
            segs = parse_command(text)
        except ParseError:
            return None
        out = []
        for seg in segs:
            if not seg.words:
                continue
            plain = not (seg.subshell or seg.funcdef or seg.heredocs
                         or any(w.substs for w in seg.words)
                         or any(r.target.substs for r in seg.redirs))
            for r in seg.redirs:
                if r.target.dynamic:
                    plain = False
                elif not (r.op == ">&" and DUP_TARGET_RE.match(r.target.value)) \
                        and not (r.op in (">", ">>", "&>") and r.target.value == "/dev/null"):
                    plain = False
            out.append((" ".join(w.raw for w in seg.words), plain))
        return out

    def judge(self, cmd):
        """("deny"|"ask", why) for a settings deny/ask rule, "allow" when approved, else None."""
        parts = self.simple_commands(cmd)
        for kind in ("deny", "ask"):
            for text, _ in parts or []:
                for rule, content in self.rules[kind]:
                    if content is not None and content.strip() not in ("", "*") \
                            and rule_matches(content, text):
                        return kind, ("`%s` matches `%s` in permissions.%s of the Claude Code "
                                      "settings" % (text, rule, kind))
        if norm_cmd(cmd) in self.profile:
            return "allow"
        if parts and all(plain and any(rule_matches(c, t) for _, c in self.rules["allow"])
                         for t, plain in parts):
            return "allow"
        return None
