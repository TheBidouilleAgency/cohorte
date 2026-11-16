"""Config patterns and how they match a command.

A pattern is lexed like a command; it matches when its command name is equal, its positional
words come first in order, and each of its flags is present by meaning (`-rf` = `-r -f` =
`--recursive --force`). Package runners and container wrappers are looked through, and
`git push` force forms satisfy `-f`/`--force` patterns.
"""

from .runtime import warn
from .shell import (
    cmd_name, INTERP_RE, is_assignment, is_flag_word, parse_command, ParseError, RESERVED_SKIP,
    strip_prefixes,
)
from .git import analyze_push_args, parse_git

# ── patterns ─────────────────────────────────────────────────────────────────
class PatSeg(object):
    def __init__(self, name, args, sep):
        self.name = name
        self.args = args
        self.sep = sep
        self.git = parse_git(args) if name == "git" else None
        self.core = runner_core(name, args) if name != "git" else None
        self.prefix_only = False


class Pattern(object):
    def __init__(self, text):
        self.text = text
        self.norm = " ".join(text.lower().split())
        self.segs = []
        try:
            segs = parse_command(text)
        except ParseError:
            warn("pattern `%s` can't be tokenized; it is matched as raw text" % text)
            return
        for s in segs:
            words = [w for w in s.words]
            while words and not words[0].quoted and words[0].value in RESERVED_SKIP:
                words.pop(0)
            argv = strip_prefixes(words)[0]
            if not argv:
                if not words or words[0].dynamic:
                    continue
                argv = words           # a wrapper-only pattern such as `sudo`
                ps = PatSeg(cmd_name(argv[0].value), argv[1:], s.sep)
                ps.prefix_only = True
                self.segs.append(ps)
                continue
            self.segs.append(PatSeg(cmd_name(argv[0].value), argv[1:], s.sep))

    @property
    def multi(self):
        return len(self.segs) > 1


def compile_pattern(text):
    return Pattern(text)


def runner_core(name, args, depth=0):
    """(name, args) of the program a package runner / launcher runs, or None."""
    if depth > 3:
        return None
    a = list(args)

    def skip_opts(k, with_arg=()):
        while k < len(a):
            if a[k].dynamic:
                return None
            v = a[k].value
            if v == "--":
                return k + 1
            if v.startswith("-") and len(v) > 1:
                k += 2 if v in with_arg else 1
                continue
            return k
        return None

    k = None
    if name in ("npx", "bunx", "pnpx"):
        k = skip_opts(0, ("-p", "--package", "-c", "--call"))
    elif name in ("pnpm", "yarn", "npm", "bun"):
        k = skip_opts(0, ("--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd"))
        if k is not None and k < len(a) and a[k].value in ("exec", "dlx", "x", "run"):
            k = skip_opts(k + 1, ("--filter", "-F", "-C", "--dir", "--prefix"))
        elif name == "npm":
            return None
    elif name in ("uv", "poetry", "pipenv", "rye", "pdm", "hatch") and a and a[0].value == "run":
        k = skip_opts(1, ("--with", "--python", "-p", "--env", "-e"))
    elif name == "bundle" and a and a[0].value == "exec":
        k = skip_opts(1)
    elif name in ("cross-env", "env-cmd", "dotenv"):
        k = 0
        while k < len(a) and (is_assignment(a[k]) or a[k].value.startswith("-")):
            if a[k].value == "--":
                k += 1
                break
            k += 2 if a[k].value in ("-e", "-f", "-c") else 1
    elif INTERP_RE.match(name) and name.startswith("py"):
        for j, w in enumerate(a):
            if w.value == "-m" and j + 1 < len(a):
                k = j + 1
                break
            if not w.value.startswith("-"):
                break
    if k is None or k >= len(a) or a[k].dynamic:
        return None
    inner = cmd_name(a[k].value)
    rest = a[k + 1:]
    deeper = runner_core(inner, rest, depth + 1)
    return deeper or (inner, rest)


WRAPPERS = {"docker", "podman", "nerdctl", "docker-compose", "kubectl", "oc", "lima", "colima"}


def wrapper_cores(name, args):
    """Container wrappers (`docker compose exec api node ace …`, `kubectl exec pod -- psql`)
    run a command given as later words: try a pattern at every later static word."""
    if name not in WRAPPERS:
        return []
    out = []
    for k, w in enumerate(args):
        if w.dynamic or w.value.startswith("-"):
            continue
        out.append((cmd_name(w.value), args[k + 1:]))
        core = runner_core(cmd_name(w.value), args[k + 1:])
        if core:
            out.append(core)
    return out[:40]


def short_flags(v):
    return ["-" + c for c in v[1:]]


def flag_names(tokens, aliases=None):
    out = set()
    for w in tokens:
        if w.dynamic:
            h = w.head
            if h.startswith("--") and "=" in h:
                out.add(h.split("=", 1)[0])
            continue
        v = w.value
        if v == "--":
            break
        if len(v) < 2 or not v.startswith("-"):
            continue
        if v.startswith("--"):
            out.add(v.split("=", 1)[0])
        else:
            out.update(short_flags(v))
    if aliases:
        out = {aliases.get(f, f) for f in out}
    return out


FLAG_ALIASES = {
    "rm": {"-R": "-r", "--recursive": "-r", "--force": "-f", "--dir": "-d"},
    "cp": {"-R": "-r", "--recursive": "-r", "--force": "-f"},
}


def is_wildcard(tokens, idx):
    """A run-time word that could be any word (or flag) — unless it is the value of the
    flag right before it (`-m "$(cat <<EOF …)"`)."""
    w = tokens[idx]
    if not w.dynamic:
        return False
    h = w.head
    if h.startswith("-") and "=" in h:
        return False
    if idx > 0:
        p = tokens[idx - 1]
        if is_flag_word(p) and "=" not in p.value:
            return False
    return True


def wild_flag(tokens, idx):
    """A run-time word that could expand to flags: unquoted (field splitting) or visibly
    starting with `-`, and not after `--`."""
    if not is_wildcard(tokens, idx):
        return False
    if any(not t.dynamic and t.value == "--" for t in tokens[:idx]):
        return False
    w = tokens[idx]
    return not w.raw.startswith('"') or w.head.startswith("-")


def pos_match(ppos, tokens, eq):
    """Pattern positionals in order at the start of the command's positionals. A
    positional may be skipped only when it follows a flag (it may be that flag's value)."""
    def rec(pi, ci):
        if pi == len(ppos):
            return "match"
        best = None
        prev_flag = False
        end_opts = False
        j = ci
        while j < len(tokens):
            w = tokens[j]
            if is_wildcard(tokens, j):
                return "possible"
            if w.dynamic:
                prev_flag = False
                j += 1
                continue
            if not end_opts and w.value == "--":
                end_opts = True
                j += 1
                continue
            if not end_opts and is_flag_word(w):
                prev_flag = "=" not in w.value
                j += 1
                continue
            if eq(ppos[pi], w):
                r = rec(pi + 1, j + 1)
                if r == "match":
                    return r
                best = best or r
            if not prev_flag:
                return best
            prev_flag = False
            j += 1
        return best
    return rec(0, 0)


def match_args(pargs, cargs, git=False, aliases=None, eq=None):
    eq = eq or (lambda p, w: p.value == w.value)
    ppos = [w for w in pargs if not is_flag_word(w)]
    pflags = [w for w in pargs if is_flag_word(w)]
    res = pos_match(ppos, cargs, eq)
    if res is None:
        return None
    cflags = flag_names(cargs, aliases)
    wild = any(wild_flag(cargs, k) for k in range(len(cargs)))
    for pf in pflags:
        need = flag_names([pf], aliases)
        for f in need:
            ok = f in cflags
            if not ok and git and f.startswith("--"):
                ok = any(c.startswith("--") and len(c) >= 4 and f.startswith(c) for c in cflags)
            if not ok:
                if wild:
                    res = "possible"
                else:
                    return None
    return res


def push_eq(p, w):
    v = w.value
    if p.value == v:
        return True
    v = v.lstrip("+")
    if p.value == v:
        return True
    if ":" in v and p.value == v.split(":", 1)[1]:
        return True
    return False


def match_push(pat_args, cargs, pi):
    pflags = [w for w in pat_args if is_flag_word(w)]
    ppos = [w for w in pat_args if not is_flag_word(w)]
    res = pos_match(ppos, pi.positionals, push_eq)
    if res is None:
        return None
    pp = analyze_push_args(pflags)
    needs = []
    if pp.force:
        needs.append(pi.force_like)
    if pp.delete:
        needs.append(pi.delete_like)
    if pp.mirror:
        needs.append(pi.mirror)
    if pp.all:
        needs.append(pi.all or pi.mirror)
    if pp.tags:
        needs.append(pi.tags)
    semantic = {"-f", "-d", "--force", "--force-with-lease", "--force-if-includes", "--delete",
                "--mirror", "--all", "--branches", "--tags"}
    for f in pp.flags:
        if f in semantic:
            continue
        ok = f in pi.flags or (f.startswith("--") and any(
            c.startswith("--") and len(c) >= 4 and f.startswith(c) for c in pi.flags))
        needs.append(ok)
    if not all(needs):
        return "possible" if pi.wild else None
    if pi.wild and res == "match":
        return "match"
    return res
