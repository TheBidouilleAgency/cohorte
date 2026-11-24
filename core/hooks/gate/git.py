"""git command-line semantics: global options, builtin subcommands, and `git push`.

`parse_git` skips git's global options (`-c`, `-C`, `--git-dir`, …) to find the subcommand;
`analyze_push_args` works out what a push does — force forms (`-f`, `--force-with-lease`,
`+refspec`, combined short flags, abbreviations), deletions, `--all`/`--mirror` — and which
remote branches it updates.
"""

import re

from .shell import static_word

# ── git ──────────────────────────────────────────────────────────────────────
GIT_GLOBAL_WITH_ARG = {"-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
                       "--config-env", "--list-cmds", "--attr-source"}
GIT_BUILTINS = set("""add am annotate apply archive bisect blame branch bugreport bundle
cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry
cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects
credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export
fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo
format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init
instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance
merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv
name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff
read-tree rebase reflog remote repack replace replay request-pull rerere reset restore
rev-list rev-parse revert rm scalar send-email send-pack shortlog show show-branch show-index
show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag
unpack-file unpack-objects update-index update-ref update-server-info var verify-commit
verify-pack verify-tag version whatchanged worktree write-tree lfs""".split())

PUSH_LONG = ["all", "branches", "mirror", "delete", "tags", "dry-run", "porcelain", "force",
             "force-with-lease", "no-force-with-lease", "force-if-includes",
             "no-force-if-includes", "recurse-submodules", "no-recurse-submodules", "thin",
             "no-thin", "quiet", "verbose", "progress", "no-progress", "prune", "no-prune",
             "verify", "no-verify", "follow-tags", "no-follow-tags", "signed", "no-signed",
             "atomic", "no-atomic", "push-option", "repo", "set-upstream", "receive-pack",
             "exec", "ipv4", "ipv6"]
PUSH_LONG_WITH_ARG = {"push-option", "repo", "receive-pack", "exec"}
FORCE_LONG = {"force", "force-with-lease", "force-if-includes"}
BRANCH_SUBST_RE = re.compile(
    r'^"?\$\(\s*git\s+(branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|'
    r'symbolic-ref\s+(-q\s+)?--short\s+(-q\s+)?HEAD|branch\s+--show)\s*\)"?$')


class GitInv(object):
    def __init__(self):
        self.sub = None
        self.sub_index = None
        self.args = []
        self.relocated = False     # -C / --git-dir / --work-tree
        self.places = []           # [(option, Word)] for each of them, in order
        self.dynamic_global = False
        self.c_aliases = {}


def parse_git(args):
    g = GitInv()
    i = 0
    while i < len(args):
        w = args[i]
        if w.dynamic:
            g.dynamic_global = True
            return g
        v = w.value
        if v == "-C":
            g.relocated = True
            if i + 1 < len(args):
                g.places.append(("-C", args[i + 1]))
            i += 2
            continue
        if v == "-c":
            if i + 1 < len(args) and not args[i + 1].dynamic:
                kv = args[i + 1].value
                k, _, val = kv.partition("=")
                if k.lower().startswith("alias."):
                    g.c_aliases[k[6:]] = val
            i += 2
            continue
        if v in ("--git-dir", "--work-tree"):
            g.relocated = True
            if i + 1 < len(args):
                g.places.append((v, args[i + 1]))
            i += 2
            continue
        if v.startswith("--git-dir=") or v.startswith("--work-tree="):
            g.relocated = True
            opt, _, val = v.partition("=")
            g.places.append((opt, static_word(val)))
            i += 1
            continue
        if v in GIT_GLOBAL_WITH_ARG:
            i += 2
            continue
        if v.startswith("-"):
            i += 1
            continue
        g.sub = v
        g.sub_index = i
        g.args = args[i + 1:]
        break
    return g


def resolve_long(name, table):
    if name in table:
        return [name]
    return [o for o in table if o.startswith(name)] if name else []


class PushInfo(object):
    def __init__(self):
        self.force = False        # a force flag (-f, --force*, abbreviations)
        self.delete = False       # --delete / -d
        self.mirror = False
        self.all = False
        self.tags = False
        self.plus_ref = False     # +refspec
        self.colon_delete = False  # :dst refspec
        self.wild = False         # an argument computed at run time
        self.flags = set()
        self.positionals = []
        self.repo = None

    @property
    def force_like(self):
        return (self.force or self.delete or self.mirror or self.plus_ref or self.colon_delete)

    @property
    def delete_like(self):
        return self.delete or self.colon_delete or self.mirror


def analyze_push_args(args):
    pi = PushInfo()
    i = 0
    end_opts = False
    prev_takes_value = False
    while i < len(args):
        w = args[i]
        v = w.value
        if w.dynamic:
            h = w.head
            if not end_opts and h.startswith("--") and "=" in h:
                name = h[2:].split("=", 1)[0]
                c = resolve_long(name, PUSH_LONG)
                if FORCE_LONG.intersection(c):
                    pi.force = True
            elif BRANCH_SUBST_RE.match(w.raw) or (w.raw.startswith('"') and not h.startswith("-")
                                                   and not h.startswith("+")):
                # "$(git branch --show-current)" (resolved later) or a quoted "$BRANCH": one
                # word, so not a flag — but its destination is unknown.
                pi.positionals.append(w)
            elif not prev_takes_value:
                pi.wild = True
                pi.positionals.append(w)
            prev_takes_value = False
            i += 1
            continue
        prev_takes_value = False
        if not end_opts and v == "--":
            end_opts = True
            i += 1
            continue
        if not end_opts and v.startswith("--") and len(v) > 2:
            name, eq, _ = v[2:].partition("=")
            cands = resolve_long(name, PUSH_LONG)
            if FORCE_LONG.intersection(cands):
                pi.force = True
            if "delete" in cands:
                pi.delete = True
            if "mirror" in cands:
                pi.mirror = True
            if "all" in cands or "branches" in cands:
                pi.all = True
            if "tags" in cands:
                pi.tags = True
            pi.flags.add("--" + (cands[0] if len(cands) == 1 else name))
            if len(cands) == 1 and cands[0] in PUSH_LONG_WITH_ARG and not eq:
                if cands[0] == "repo" and i + 1 < len(args):
                    pi.repo = args[i + 1]
                prev_takes_value = True
                i += 1
                if i < len(args) and not args[i].dynamic:
                    i += 1
                    prev_takes_value = False
                continue
            i += 1
            continue
        if not end_opts and v.startswith("-") and len(v) > 1:
            rest = v[1:]
            for k, ch in enumerate(rest):
                pi.flags.add("-" + ch)
                if ch == "f":
                    pi.force = True
                elif ch == "d":
                    pi.delete = True
                elif ch == "o":
                    if k == len(rest) - 1:
                        prev_takes_value = True
                        if i + 1 < len(args) and not args[i + 1].dynamic:
                            i += 1
                            prev_takes_value = False
                    break
            i += 1
            continue
        pi.positionals.append(w)
        i += 1
    refs = pi.positionals if pi.repo is not None else pi.positionals[1:]
    for r in refs:
        if not r.dynamic:
            rv = r.value
            if rv.startswith("+"):
                pi.plus_ref = True
                rv = rv[1:]
            if rv.startswith(":") and len(rv) > 1:
                pi.colon_delete = True
    return pi


def normalize_ref(name):
    if name.startswith("refs/heads/"):
        return name[len("refs/heads/"):]
    if name.startswith("refs/"):
        return None
    return name
