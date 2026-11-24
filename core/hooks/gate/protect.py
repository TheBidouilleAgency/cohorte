"""`SelfProtection`: Bash writes to the files the gate depends on, and Bash-side ownership.

`protect` finds what a command writes, moves, deletes or chmods (cp/mv/rm, tee, truncate,
sed -i, dd of=, curl -o, find -delete, git rm/mv, git checkout/restore of paths, git reset
--hard, …); `check_path` denies a write or delete
of a protected file, asks when the target can't be resolved but may name one (`suspicious`),
and, when profile.json ownership applies, denies a write outside the agent's surfaces.
"""

import fnmatch
import glob
import os
import re

from .runtime import run_git, warn
from .shell import DYN, is_flag_word, static_word
from .config import git_top_and_common
from .patterns import flag_names


PROTECTED_HINT_RE = re.compile(r"(^|/)\.claude(/|$)|gate-config\.json|preflight\.ok|"
                               r"settings(\.local)?\.json|cohorte-gate\.py|pipeline\.json|"
                               r"(^|/)\.cohorte(/|$)")
PROTECTED_BASENAMES = {"gate-config.json", "preflight.ok", "settings.json", "settings.local.json", "profile.json",
                      "cohorte-gate.py", "pipeline.json", ".claude", ".cohorte", "hooks", "~", "",
                      ".", ".."}


def suspicious(tail, raw):
    """For a path the gate can't resolve: could it name a protected file? Its static tail
    decides — `…/.claude/pipeline-metrics.jsonl` can't, `$DIR/.claude/settings.json` can."""
    base = os.path.basename(tail.rstrip("/")) if tail else ""
    if tail and "/" in tail and base not in PROTECTED_BASENAMES and not tail.endswith("/"):
        return False
    return bool(PROTECTED_HINT_RE.search(raw))


class SelfProtection(object):
    def path_key(self, w, state):
        v = os.path.expanduser(w.value)
        if not os.path.isabs(v) and state.cwd_known:
            v = os.path.join(state.cwd, v)
        return os.path.normpath(v)

    def remember_written(self, w, state):
        if not w.dynamic:
            state.written.add(self.path_key(w, state))

    def known_text(self, w, state):
        """A run-time word with only the variables the gate can resolve itself
        ($CLAUDE_PROJECT_DIR, $HOME, $PWD) substituted, or None if anything else is left."""
        t = w.raw
        if len(t) >= 2 and t[0] == t[-1] == '"':
            t = t[1:-1]
        for var, val in (("CLAUDE_PROJECT_DIR", os.environ.get("CLAUDE_PROJECT_DIR")),
                         ("HOME", os.path.expanduser("~")),
                         ("PWD", state.cwd if state.cwd_known else None)):
            if val and var not in state.rebound:
                # Forward slashes: a Windows value (C:\\Users\\…) would otherwise read as
                # shell escapes below and every expanded path would look suspect.
                val = val.replace("\\", "/")
                t = t.replace("${%s}" % var, val).replace("$" + var, val)
        if "$" in t or "`" in t or "'" in t or '"' in t or "\\" in t:
            return None
        return t

    def classify_path(self, w, state, mode, relocated=False):
        ctx = self.ctx
        if w.dynamic:
            t = self.known_text(w, state)
            if t is None:
                return "suspect" if suspicious(w.value.split(DYN)[-1], w.raw) else None
            w = static_word(t)
        v = os.path.expanduser(w.value)
        if not v:
            return None
        if not os.path.isabs(v):
            if relocated or not state.cwd_known:
                return "suspect" if suspicious(v, v) else None
            v = os.path.join(state.cwd, v)
        prot = ctx.delete_protected if mode in ("delete", "recursive", "chmod") else ctx.protected
        targets = [v]
        if w.glob:
            pat = os.path.normpath(v)
            if any(fnmatch.fnmatchcase(p, pat) for p in prot):
                return "protected"
            try:
                targets = glob.glob(v)[:500]
            except Exception:
                targets = []
        if w.glob and any(fnmatch.fnmatchcase(d, os.path.normpath(v)) or ctx.in_protected_dir(os.path.dirname(os.path.normpath(v)))
                          for d in ctx.protected_dirs):
            return "protected"
        for t in targets:
            for cand in {os.path.normpath(os.path.abspath(t)), os.path.realpath(t)}:
                if cand in prot or ctx.in_protected_dir(cand):
                    return "protected"
                if mode in ("delete", "recursive", "chmod") and any(d.startswith(cand.rstrip(os.sep) + os.sep) for d in ctx.protected_dirs):
                    return "protected" if mode == "delete" else "suspect"
                if mode in ("delete", "recursive", "chmod"):
                    pre = cand if cand.endswith(os.sep) else cand + os.sep
                    if any(p.startswith(pre) for p in prot):
                        return "protected" if mode == "delete" else "suspect"
        return None

    def check_owner(self, w, state, mode, via, relocated=False, existing=False):
        """Surface ownership for a Bash write — best effort: a target the gate can't resolve
        statically (a run-time word, a relative path after an unresolvable `cd`) is let
        through, never asked about (an ask is a deny in unattended runs)."""
        try:
            t = self.known_text(w, state) if w.dynamic else w.value
            if not t:
                return
            v = os.path.expanduser(t)
            if not os.path.isabs(v):
                if relocated or not state.cwd_known:
                    return
                v = os.path.join(state.cwd, v)
            if existing and not os.path.exists(v):
                return
            why = self.ctx.owner.judge(v)
        except Exception as e:
            warn("surface ownership could not judge `%s`: %s: %s" % (w.raw, type(e).__name__, e))
            return
        if why:
            verb = {"write": "write", "delete": "delete or move", "recursive": "write into",
                    "chmod": "change the permissions of"}.get(mode, "write")
            self.deny("%s would %s `%s`: %s" % (via, verb, w.raw, why))

    def check_path(self, w, state, mode, via, relocated=False, existing=False):
        if self.ctx.owner is not None:
            self.check_owner(w, state, mode, via, relocated, existing)
        kind = self.classify_path(w, state, mode, relocated)
        if kind is None:
            return
        verb = {"write": "overwrite", "delete": "delete or move", "recursive": "overwrite",
                "chmod": "change the permissions of"}[mode]
        if kind == "protected" and mode in ("write", "delete"):
            self.deny("%s would %s `%s`, which the Cohorte gate depends on (self-protection). "
                      "Edit gate rules through PIPELINE.md and /cohorte-update-pipeline, or ask "
                      "the human" % (via, verb, w.raw))
        else:
            self.ask("%s may %s a file the Cohorte gate depends on (`%s`) — confirm"
                     % (via, verb, w.raw))

    def protect(self, inv, state, relocated):
        name, args = inv.name, inv.args

        def positionals(tokens, with_arg=()):
            out = []
            end = False
            k = 0
            while k < len(tokens):
                w = tokens[k]
                v = w.value
                if not end and v == "--":
                    end = True
                elif not end and is_flag_word(w):
                    if v in with_arg:
                        k += 1
                else:
                    out.append(w)
                k += 1
            return out

        def recursive(tokens):
            fl = flag_names(tokens)
            return bool(fl & {"-r", "-R", "-a", "--recursive", "--archive"})

        def copy_like(srcs, dst, label, mv=False):
            for s in srcs:
                if mv:
                    self.check_path(s, state, "delete", "`%s`" % label, relocated)
            self.check_path(dst, state, "write", "`%s`" % label, relocated)
            dk = self.path_key(dst, state) if not dst.dynamic else None
            if dk and state.cwd_known and (os.path.isdir(dk) or dst.value.endswith("/")):
                for s in srcs:
                    if not s.dynamic:
                        self.check_path(static_word(os.path.join(dk, os.path.basename(
                            s.value.rstrip("/")))), state, "write", "`%s`" % label, relocated)
                if recursive(args) or mv:
                    self.check_path(dst, state, "recursive", "`%s`" % label, relocated)

        if name in ("rm", "unlink", "shred", "rmdir", "srm", "trash", "trash-put"):
            for p in positionals(args):
                self.check_path(p, state, "delete", "`%s`" % name, relocated)
        elif name in ("mv", "cp", "install", "ln", "rsync", "scp", "ditto"):
            pos = positionals(args, ("-t", "--target-directory", "-S", "--suffix", "-m",
                                     "--mode", "-o", "-g", "-e", "--exclude", "--include"))
            target = None
            for k, w in enumerate(args):
                if w.value in ("-t", "--target-directory") and k + 1 < len(args):
                    target = args[k + 1]
                elif w.value.startswith("--target-directory="):
                    target = static_word(w.value.split("=", 1)[1])
            if target is not None:
                copy_like(pos, static_word(target.value.rstrip("/") + "/")
                          if not target.dynamic else target, name, mv=(name == "mv"))
            elif len(pos) >= 2:
                copy_like(pos[:-1], pos[-1], name, mv=(name == "mv"))
        elif name == "tee":
            for p in positionals(args):
                self.check_path(p, state, "write", "`tee`", relocated)
                self.remember_written(p, state)
        elif name == "truncate":
            for p in positionals(args, ("-s", "-r", "--size", "--reference")):
                self.check_path(p, state, "write", "`truncate`", relocated)
        elif name in ("sed", "gsed", "perl", "ruby"):
            inplace = any(
                not w.dynamic and (w.value.startswith("--in-place") or (
                    w.value.startswith("-") and not w.value.startswith("--")
                    and "i" in w.value[1:].split(".")[0]))
                for w in args)
            if inplace:
                # Only existing files can be edited in place, so for ownership a positional
                # that names nothing on disk is the sed script (`sed -i 's/a/b/' f`) or a BSD
                # backup suffix (`sed -i .bak …`), not a target.
                for p in positionals(args, ("-e", "-f")):
                    self.check_path(p, state, "write", "`%s -i`" % name, relocated, existing=True)
        elif name == "dd":
            for w in args:
                if w.value.startswith("of="):
                    self.check_path(static_word(w.value[3:]) if not w.dynamic else w,
                                    state, "write", "`dd of=`", relocated)
        elif name in ("curl", "wget"):
            opts = ("-o", "--output") if name == "curl" else ("-O", "--output-document")
            for k, w in enumerate(args):
                v = w.value
                if v in opts and k + 1 < len(args):
                    self.check_path(args[k + 1], state, "write", "`%s %s`" % (name, v), relocated)
                elif any(v.startswith(o + "=") for o in opts if o.startswith("--")):
                    self.check_path(static_word(v.split("=", 1)[1]), state, "write",
                                    "`%s`" % name, relocated)
        elif name in ("chmod", "chown", "chgrp", "chflags", "chattr", "setfacl"):
            for p in positionals(args)[1:]:
                self.check_path(p, state, "chmod", "`%s`" % name, relocated)
        elif name == "find" and any(w.value == "-delete" for w in args):
            for w in args:
                if w.value.startswith("-") or w.value in ("(", "!", ")"):
                    break
                self.check_path(w, state, "delete", "`find -delete`", relocated)
        elif name == "git" and inv.git and inv.git.sub in ("checkout", "restore", "reset"):
            self.git_restore(inv.git, state, relocated or inv.git.relocated)
        elif name == "git" and inv.git and inv.git.sub in ("rm", "mv"):
            g = inv.git
            pos = positionals(g.args)
            reloc = relocated or g.relocated
            if g.sub == "rm" and not any(w.value == "--cached" for w in g.args):
                for p in pos:
                    self.check_path(p, state, "delete", "`git rm`", reloc)
            elif g.sub == "mv" and len(pos) >= 2:
                for p in pos[:-1]:
                    self.check_path(p, state, "delete", "`git mv`", reloc)
                self.check_path(pos[-1], state, "write", "`git mv`", reloc)

    # -- git checkout / restore / reset --hard: they overwrite worktree files ------------
    def git_restore(self, g, state, relocated):
        """`git checkout [<rev>] -- <pathspec>…`, `git restore [--source=<rev>] <pathspec>…`
        and `git reset --hard|--merge|--keep [<rev>]` rewrite files in the worktree. A pathspec
        naming a protected file is a write to it. A broader one (`.`, `.claude/`, `:/`, a glob)
        counts only when a protected file it covers differs from the source — asked of git;
        when git can't say, the call gets "ask". Index-only forms (`git restore --staged`,
        `git reset [<rev>] -- <path>`) don't touch the worktree."""
        a = g.args
        sub = g.sub
        via = "`git %s`" % sub
        source = None
        specs = []
        if sub == "reset":
            fl = flag_names(a)
            if not fl & {"--hard", "--merge", "--keep"}:
                return
            pos = [w for w in a if not is_flag_word(w) and w.value != "--"]
            source = pos[0] if pos else static_word("HEAD")
            specs = [static_word(":/")]
        elif sub == "checkout":
            if flag_names(a) & {"-b", "-B", "--orphan"} or any(
                    not w.dynamic and len(w.value) > 2 and w.value[0] == "-" and w.value[1] != "-"
                    and w.value[-1] in "bB" for w in a):
                return                     # a branch operation (handled by update_state)
            if any(not w.dynamic and w.value.startswith("--pathspec-from-file") for w in a):
                specs = [static_word(":/")]
            if any(not w.dynamic and w.value == "--" for w in a):
                k = [i for i, w in enumerate(a) if not w.dynamic and w.value == "--"][0]
                before = [w for w in a[:k] if not is_flag_word(w)]
                source = before[0] if before else None
                specs += a[k + 1:]
            else:
                pos = [w for w in a if not is_flag_word(w)]
                if pos and not self.pathish(pos[0], state):
                    source, pos = pos[0], pos[1:]
                specs += pos
        else:                              # restore
            fl = flag_names(a)
            if ("-S" in fl or "--staged" in fl) and not ("-W" in fl or "--worktree" in fl):
                return
            k = 0
            end = False
            while k < len(a):
                w = a[k]
                v = w.value
                if not end and not w.dynamic and v == "--":
                    end = True
                elif not end and not w.dynamic and v in ("-s", "--source"):
                    source = a[k + 1] if k + 1 < len(a) else None
                    k += 1
                elif not end and not w.dynamic and v.startswith("--source="):
                    source = static_word(v.split("=", 1)[1])
                elif not end and not w.dynamic and v.startswith("-s") and len(v) > 2 \
                        and not v.startswith("--"):
                    source = static_word(v[2:])
                elif not end and not w.dynamic and v.startswith("--pathspec-from-file"):
                    specs.append(static_word(":/"))
                elif not end and is_flag_word(w):
                    pass
                else:
                    specs.append(w)
                k += 1
        broad = []
        for spec in specs:
            self.restore_spec(spec, state, relocated, via, broad)
        if broad:
            self.restore_broad(broad, source, state, via)

    def pathish(self, w, state):
        """Is `git checkout`'s first positional (no `--`) a path rather than a revision?"""
        if w.dynamic:
            return w.glob or "/" in w.value.split(DYN)[-1]
        v = w.value
        if v in (".", "..") or v.startswith(":") or w.glob:
            return True
        return state.cwd_known and os.path.exists(os.path.join(state.cwd, os.path.expanduser(v)))

    def restore_spec(self, spec, state, relocated, via, broad):
        if spec.dynamic:
            t = self.known_text(spec, state)
            if t is None:
                if suspicious(spec.value.split(DYN)[-1], spec.raw):
                    self.ask("%s may overwrite a file the Cohorte gate depends on (`%s`) — confirm"
                             % (via, spec.raw))
                return
            spec = static_word(t)
        v = spec.value
        glob_like = spec.glob or any(c in v for c in "*?[")
        if v.startswith(":") and not v.startswith(":/"):
            magic = True                   # :(glob)…, :!…, :^… — judged as the whole repo
            rel, base = "", None
        elif v.startswith(":/"):
            magic = False
            rel, base = v[2:], None
        else:
            magic = False
            rel, base = os.path.expanduser(v), "cwd"
        if base == "cwd" and not os.path.isabs(rel) and (relocated or not state.cwd_known):
            # relative to a directory the gate can't resolve
            if suspicious(rel, v) or rel in ("", ".", "./") or glob_like:
                self.ask("%s rewrites `%s` in a directory the gate can't resolve — it may "
                         "overwrite a file the Cohorte gate depends on; confirm" % (via, v))
            return
        top = None
        if base is None or magic:
            if not state.cwd_known or relocated:
                self.ask("%s rewrites `%s` in a checkout the gate can't resolve — confirm"
                         % (via, v))
                return
            top = git_top_and_common(state.cwd)[0]
            if top is None:
                return
            target = os.path.normpath(os.path.join(top, "" if magic else rel))
            glob_like = glob_like or magic
        else:
            target = os.path.normpath(os.path.join(state.cwd, rel))
        if not glob_like and not v.endswith("/"):
            if self.classify_path(static_word(target), state, "write") == "protected":
                self.check_path(static_word(target), state, "write", via)
                return
            if self.ctx.owner is not None:
                self.check_owner(static_word(target), state, "write", via)
        pre = target.rstrip(os.sep) + os.sep
        for p in sorted(self.ctx.protected):
            if p.startswith(pre) or (glob_like and not magic and fnmatch.fnmatchcase(p, target)) \
                    or (magic and p.startswith((top or target).rstrip(os.sep) + os.sep)):
                if p not in broad:
                    broad.append(p)

    def restore_broad(self, files, source, state, via):
        """Protected files a broad pathspec covers: a write only if one differs from what
        the command restores (the index, or <rev>)."""
        if source is not None and source.dynamic:
            self.ask("%s restores from a revision computed at run time over files the Cohorte "
                     "gate depends on — confirm" % via)
            return
        args = ["diff", "--name-only", "--no-renames"]
        if source is not None:
            args.append(source.value)
        r = run_git(args + ["--"] + files, state.cwd)
        if r is None or r[0] != 0:
            self.ask("%s covers files the Cohorte gate depends on and git can't tell whether it "
                     "would change them — confirm" % via)
            return
        changed = [ln.strip() for ln in r[1].splitlines() if ln.strip()]
        if not changed:
            return
        top = git_top_and_common(state.cwd)[0] or state.cwd
        for c in changed:
            self.check_path(static_word(os.path.normpath(os.path.join(top, c))), state, "write",
                            via)
