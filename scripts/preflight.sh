#!/bin/sh
#
# preflight.sh — deterministic phase gate for /cohorte-review.
#
# Runs the profile's mechanical checks (typecheck, lint, tests — whatever the caller
# passes) BEFORE any agent is spawned. A red gate means the caller aborts and relays
# the raw failure — dispatching reviewers onto code that doesn't even compile burns
# their whole run on noise a compiler already printed for free.
#
#   preflight.sh <report-file> "<cmd>" ["<cmd>"...]
#
# - Each command runs through `sh -c`, all output appended to <report-file> — the bulk
#   never enters the calling agent's context.
# - First failure: prints the last 40 lines of the report raw to stderr and exits 1.
#   The caller must stop there — no agents.
# - All green: writes `<project>/.claude/preflight.ok` ("<epoch> <HEAD sha> <tree digest>")
#   — the stamp `hooks/gate.py` checks (gate-config.json `preflight` block) before letting
#   review agents dispatch.
#
# The stamp is a LOCAL, GITIGNORED artifact. Versioning it breaks the gate outright: the
# stamp records the pre-commit sha, committing it moves HEAD, so the checked-out stamp can
# never match its own commit — every dispatch then reports "HEAD moved" on a clean tree.
# A tracked stamp also rides into every new worktree, handing it a green it never earned.

set -u

report="${1:?usage: preflight.sh <report-file> \"<cmd>\" [\"<cmd>\"...]}"
shift
[ "$#" -gt 0 ] || { echo "preflight: no commands given" >&2; exit 2; }

mkdir -p "$(dirname "$report")" 2>/dev/null || true
: > "$report"

n=0
for cmd in "$@"; do
  [ -n "$cmd" ] || continue
  n=$((n + 1))
  printf '\n$ %s\n' "$cmd" >> "$report"
  if ! sh -c "$cmd" >> "$report" 2>&1; then
    echo "PREFLIGHT FAIL — $cmd" >&2
    echo "--- last 40 lines of $report ---" >&2
    tail -40 "$report" >&2
    exit 1
  fi
done
# All-empty arguments verified nothing — stamping green here would gate reviews on a
# check that never ran. Same failure as zero arguments, and the same exit.
[ "$n" -gt 0 ] || { echo "preflight: every command argument was empty — nothing was verified" >&2; exit 2; }

# Stamp for the gate.py phase gate: epoch + HEAD sha of the checkout we verified.
# The stamp MUST land where gate.py reads it: <main checkout>/.claude. CLAUDE_PROJECT_DIR
# is only exported to hooks — in an agent's Bash call it is unset, and a bare `.` would
# drop the stamp in the feature worktree where the gate never looks. git-common-dir
# resolves to the MAIN checkout's .git from any worktree.
proj="${CLAUDE_PROJECT_DIR:-$(dirname "$(git rev-parse --git-common-dir 2>/dev/null || echo ./.git)")}"
sha=$(git rev-parse HEAD 2>/dev/null || echo none)

# Content digest of the state we actually verified: the git TREE id of the working tree,
# built in a throwaway index so nothing touches the real one. The sha alone is the wrong
# key — the reviewed tree is normally DIRTY (uncommitted feature work), so committing it
# invalidates the stamp without changing a line of code, while an implementer's edit
# changes every line without moving HEAD. A tree id is content-addressed: it survives a
# commit of the same content and dies on any real edit (including new untracked files).
# `.claude`/`.cohorte` (stamps, metrics) and `specs` (DoD ticks, report buffer) are excluded — the
# pipeline writes those itself between the preflight and the dispatch it must not invalidate.
# gate.py recomputes this identically; any change here must land there too.
digest=none
tmpidx=$(mktemp 2>/dev/null || echo "")
if [ -n "$tmpidx" ]; then
  # Seed from the real index (not `read-tree HEAD`) so its stat cache is preserved and
  # `add` only re-hashes files that actually changed.
  idx=$(git rev-parse --git-path index 2>/dev/null || echo "")
  if [ -n "$idx" ] && [ -f "$idx" ]; then
    cp "$idx" "$tmpidx" 2>/dev/null || true
    # Backdate the copy, for the reason spelled out in gate.py's tree_digest(): git trusts an
    # entry's cached stat data only when its mtime predates the index file's, so a copy stamped
    # `now` makes a file edited in this same second look clean. Both sides must age it by the
    # same window or they compute different trees for the same content. `date -d` is GNU and
    # `date -v` is BSD — try both, and if neither exists just skip the touch (the digest is
    # still correct for anything not edited in the last few seconds).
    # LOCAL time on purpose: `touch -t` interprets its stamp as local time, so a
    # UTC-formatted stamp future-dates the index anywhere west of UTC — which makes
    # git trust the stat cache of files edited THIS second, the exact race the
    # backdate exists to prevent. (gate.py's side uses os.utime with an epoch, which
    # has no timezone to get wrong.)
    stamp=$(date -d '5 seconds ago' +%Y%m%d%H%M.%S 2>/dev/null \
         || date -v-5S +%Y%m%d%H%M.%S 2>/dev/null || echo "")
    [ -n "$stamp" ] && touch -t "$stamp" "$tmpidx" 2>/dev/null || true
  else
    rm -f "$tmpidx"                       # a 0-byte index is a corrupt index
  fi
  # Drop the excluded paths from the throwaway index entirely: an `add` exclude only stops
  # them being *updated*, so anything already tracked there (a committed stamp, a spec)
  # would still land in the tree and shift the digest.
  GIT_INDEX_FILE="$tmpidx" git rm --cached -r -q --ignore-unmatch -- .claude .cohorte specs > /dev/null 2>&1 || true
  if GIT_INDEX_FILE="$tmpidx" git add -A -- . ':(exclude).claude' ':(exclude).cohorte' ':(exclude)specs' > /dev/null 2>&1; then
    digest=$(GIT_INDEX_FILE="$tmpidx" git write-tree 2>/dev/null || echo none)
  fi
  rm -f "$tmpidx" "$tmpidx.lock" 2>/dev/null || true
fi
[ -n "$digest" ] || digest=none
# Stamp BOTH the main checkout and the cwd: gate.py reads COHORTE_PROJECT_DIR /
# CLAUDE_PROJECT_DIR, which is the worktree when the session was opened there and the
# main checkout when it wasn't — the two disagree, and either layout is supported.
# Stamp every state dir that EXISTS (`.cohorte` on a non-Claude runtime, `.claude` on a
# Claude one, both where a repo is driven from both), falling back to `.claude` when the
# repo has neither yet — gate.py's state_path() probes in that same order.
now=$(date +%s)
last=""
for d in "$proj" "$(pwd)"; do
  [ "$d" = "$last" ] && continue          # same dir twice in the main checkout
  last="$d"
  wrote=0
  for s in .cohorte .claude; do
    [ -d "$d/$s" ] || continue
    printf '%s %s %s\n' "$now" "$sha" "$digest" > "$d/$s/preflight.ok" 2>/dev/null && wrote=1
  done
  if [ "$wrote" -eq 0 ]; then
    mkdir -p "$d/.claude" 2>/dev/null || true
    printf '%s %s %s\n' "$now" "$sha" "$digest" > "$d/.claude/preflight.ok" 2>/dev/null || true
  fi
done

echo "PREFLIGHT PASS ($n checks green) — full log: $report"
