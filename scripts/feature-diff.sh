#!/bin/sh
#
# feature-diff.sh — the ONE way the pipeline computes "what this feature changed".
#
#   feature-diff.sh --default <branch> <mode> [-- <pathspec>...]
#   feature-diff.sh --base <sha>       <mode> [-- <pathspec>...]
#
#   modes:  --base-only   print the resolved base sha and nothing else
#           --numstat     `<added>\t<deleted>\t<path>` per changed file (full paths, no
#                         abbreviation — group by surface prefix on this, never on --stat)
#           --name-only   one changed path per line
#           --patch       the full patch (redirect it to a file; never into a context)
#           --digest      16 hex chars of sha256 over the patch — the freshness stamp
#
# Two facts make a plain `git diff <default_branch>` wrong for a pipeline review, and this
# script exists to get both right in one place instead of in six prompts:
#
# 1. Feature work stays UNCOMMITTED until /cohorte-ship, and `git diff <ref>` ignores
#    untracked files. Every new module a feature adds escaped review; a feature that only
#    added files produced an EMPTY diff, which scored SHIP with nothing reviewed. So the
#    diff is taken from a THROWAWAY index: seeded from the real one, `git add -A` run on
#    the copy, `git diff --cached <base>` read from it. The human's real index — and
#    whatever they staged in it — is never touched.
# 2. The base is the MERGE-BASE with the default branch, not its tip: the moment the
#    default branch advances, a tip diff shows every file it gained as "deleted by the
#    feature". Both the local `<branch>` and `origin/<branch>` are considered (worktrees
#    from new-feature.sh branch off the remote ref, and the local one can lag it); the
#    newer of the two merge-bases wins.
#
# `.claude` (pipeline state, rendered agents) and `specs` (the spec, its DoD ticks, the
# report buffer) are ALWAYS excluded — the pipeline writes those itself between a review
# and a ship, and they are not feature code. Gitignored files never enter (`git add -A`
# honours .gitignore). Pathspecs are repo-root relative; the script cds to the top level.
#
# Exit codes: 0 ok (an empty diff is a legitimate, empty answer) · 2 usage · 3 the base
# cannot be resolved (no such branch, no common history). A non-zero exit means NO diff
# was computed — a caller must stop, never fall back to a plain `git diff`, which is the
# exact bug this script replaces.

set -u

usage() {
  echo "usage: feature-diff.sh (--default <branch> | --base <sha>) (--base-only|--numstat|--name-only|--patch|--digest) [-- <pathspec>...]" >&2
  exit 2
}

default=""
base=""
mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --default) [ $# -ge 2 ] || usage; default=$2; shift 2 ;;
    --base)    [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    --base-only|--numstat|--name-only|--patch|--digest)
      [ -z "$mode" ] || usage; mode=$1; shift ;;
    --) shift; break ;;
    *) echo "feature-diff: unknown argument $1" >&2; usage ;;
  esac
done
[ -n "$mode" ] || usage
{ [ -n "$default" ] && [ -z "$base" ]; } || { [ -z "$default" ] && [ -n "$base" ]; } || usage

top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "feature-diff: not inside a git work tree" >&2; exit 3; }
cd "$top" || exit 3

if [ -n "$default" ]; then
  mb_local=""; mb_remote=""
  git rev-parse --verify -q "$default^{commit}" >/dev/null 2>&1 \
    && mb_local=$(git merge-base "$default" HEAD 2>/dev/null || echo "")
  git rev-parse --verify -q "origin/$default^{commit}" >/dev/null 2>&1 \
    && mb_remote=$(git merge-base "origin/$default" HEAD 2>/dev/null || echo "")
  if [ -n "$mb_local" ] && [ -n "$mb_remote" ]; then
    # The newer merge-base is the one the other is an ancestor of.
    if git merge-base --is-ancestor "$mb_local" "$mb_remote" 2>/dev/null; then base=$mb_remote; else base=$mb_local; fi
  else
    base="${mb_local:-$mb_remote}"
  fi
  [ -n "$base" ] || { echo "feature-diff: no merge-base between HEAD and $default (nor origin/$default)" >&2; exit 3; }
else
  base=$(git rev-parse --verify -q "$base^{commit}" 2>/dev/null) \
    || { echo "feature-diff: base $base is not a commit in this repo" >&2; exit 3; }
fi

if [ "$mode" = --base-only ]; then echo "$base"; exit 0; fi

[ $# -gt 0 ] || set -- .
set -- "$@" ':(exclude).claude' ':(exclude)specs'

# A path INSIDE a fresh temp dir, not `mktemp` itself: a 0-byte file is a corrupt index to git.
tmpd=$(mktemp -d 2>/dev/null) || { echo "feature-diff: mktemp -d failed" >&2; exit 3; }
trap 'rm -rf "$tmpd"' EXIT INT TERM
idx="$tmpd/index"
real=$(git rev-parse --git-path index 2>/dev/null || echo "")
if [ -n "$real" ] && [ -f "$real" ]; then
  # `cp -p` keeps the stat cache (only changed files get re-hashed) AND the index file's
  # mtime, which is what git's racy-entry check compares against — so the copy trusts
  # exactly the entries the real index would, no more.
  cp -p "$real" "$idx" || { echo "feature-diff: cannot copy the index" >&2; exit 3; }
elif git rev-parse --verify -q HEAD >/dev/null 2>&1; then
  GIT_INDEX_FILE="$idx" git read-tree HEAD || exit 3
else
  GIT_INDEX_FILE="$idx" git read-tree --empty || exit 3
fi
# The WHOLE tree goes into the copy; the caller's pathspec only narrows the diff below. (Adding
# just the pathspec fails outright on a surface path that does not exist yet.)
GIT_INDEX_FILE="$idx" git add -A -- . ':(exclude).claude' ':(exclude)specs' >/dev/null 2>&1 \
  || { echo "feature-diff: git add into the temporary index failed" >&2; exit 3; }

d() { GIT_INDEX_FILE="$idx" git -c core.quotepath=off diff --cached --no-color --no-ext-diff "$@"; }
case "$mode" in
  --numstat)   d --no-renames --numstat "$base" -- "$@" ;;
  --name-only) d --no-renames --name-only "$base" -- "$@" ;;
  --patch)     d --binary "$base" -- "$@" ;;
  --digest)
    out=$(d --binary --no-renames "$base" -- "$@" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)
    [ -n "$out" ] || exit 3
    echo "$out" ;;
esac
