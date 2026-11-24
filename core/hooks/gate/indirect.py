"""`Indirection`: commands that run other commands, followed when the inner text is static.

`sh -c`, a script or heredoc fed to a shell, `eval`, `source`, inline interpreter code
(`python -c`, `node -e`, …), xargs, find -exec, watch, su -c, trap, alias, ssh, npx -c, and
the pipeline's own preflight.sh / verify-run.sh arguments. Static inner text is analyzed
again one level deeper; text built at run time goes to `opaque`.
"""

import re

from .shell import cmd_name, INTERP_RE, Seg, SHELLS, static_word, wildcard_word
from .findings import short


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


def lang_of(name):
    if name.startswith("py"):
        return "py"
    if name in ("node", "nodejs", "deno", "bun"):
        return "js"
    return "pl"


class Indirection(object):
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
            self.handed_command("preflight.sh", a, a.raw if a.dynamic else a.value, state, depth)

    # verify-run.sh run <id> --dev "<cmd>" --check "<name>=<cmd>" --migrate "<cmd>" …: every
    # command it is handed runs through a shell, so judge each one here — the script also asks
    # the gate itself, but its `--confirmed` flag is the agent's to set, and a DENIED command must
    # stay denied, an unapproved one asked, whatever the flag says.
    VERIFY_CMD_FLAGS = {"--dev": False, "--ready": False, "--migrate": False,
                        "--migrate-down": False, "--check": True}

    def verify_args(self, args, state, depth):
        k = 0
        while k < len(args):
            a = args[k]
            flag = a.value
            if a.dynamic and a.split:
                # an unquoted expansion may be any words — `--check "x=…"` included
                if not self.raw_deny(a.raw):
                    self.ask("verify-run.sh is handed arguments built at run time (`%s`), so the "
                             "commands it would run can't be checked — confirm" % a.raw)
                k += 1
                continue
            if flag in self.VERIFY_CMD_FLAGS and k + 1 < len(args):
                a = args[k + 1]
                cmd = a.raw if a.dynamic else a.value
                if self.VERIFY_CMD_FLAGS[flag] and "=" in cmd:
                    cmd = cmd.split("=", 1)[1]          # --check "<name>=<cmd>"
                if not (flag == "--ready" and not a.dynamic and re.match(r"^https?://", cmd.strip())):
                    self.handed_command("verify-run.sh", a, cmd, state, depth)
                k += 2
                continue
            k += 1

    def handed_command(self, script, word, cmd, state, depth):
        """A command a pipeline script will execute. Claude Code approved only the script call
        (`cohorte sync` allowlists <core>/pipeline/scripts/), so the inner command runs with no
        prompt of its own: the gate's rules judge it, and when nothing denies or asks, it runs
        unprompted only if the profile declares it or a permissions.allow rule covers it."""
        if word.dynamic:
            if not self.raw_deny(word.raw):
                self.ask("%s would run a command built at run time (`%s`), which the gate can't "
                         "check — confirm" % (script, short(word.raw)))
            return
        if not cmd.strip():
            return
        self.analyze_text(cmd, state.copy(), depth + 1)
        verdict = self.ctx.approvals().judge(cmd)
        if verdict == "allow":
            return
        if verdict is not None:
            (self.deny if verdict[0] == "deny" else self.ask)(
                "%s would run `%s`: %s" % (script, short(cmd), verdict[1]))
            return
        self.ask("%s would run `%s` without a permission prompt of its own, and it is neither a "
                 "command of the project's profile (.claude/profile.json) nor covered by a "
                 "permissions.allow rule — confirm it" % (script, short(cmd)))

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
