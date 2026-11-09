#!/bin/sh
#
# install.sh — install the portable multi-agent pipeline.
# POSIX sh (works with dash/bash/zsh).
#
#   Per-project install (default — bundles the core into <target>/.claude, committable):
#     sh install.sh [target_dir]
#     curl -fsSL <raw-url>/install.sh | sh
#
#   Global install (one core in ~/.claude, shared by every repo on this machine):
#     sh install.sh --global
#     curl -fsSL <raw-url>/install.sh | sh -s -- --global
#
#   Update the generic core in place (keeps any generated PIPELINE.md + rendered agents):
#     sh install.sh --update [target_dir]
#     sh install.sh --update --global
#
# Per-project install copies the core into <target>/.claude; global install copies it once
# into ~/.claude and registers the gate hook there. Either way you then run `/cohorte-init-pipeline`
# in each repo to generate PIPELINE.md + render the surface agents. Update refreshes ONLY the
# stack-agnostic files; generated profiles, rendered agents, gate-config.json and any project
# settings.json are left untouched.

set -eu

REPO_URL="${PIPELINE_REPO:-https://github.com/TheBidouilleAgency/cohorte}"

mode="install"
scope="project"
positional=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update) mode="update"; shift ;;
    --global) scope="global"; shift ;;
    -h|--help)
      cat <<'USAGE'
install.sh — install the cohorte pipeline core.

  sh install.sh [target_dir]        per-project: bundle the core into <target>/.claude
  sh install.sh --global            one shared core in ~/.claude (recommended)
  sh install.sh --update [target]   refresh the core in place, keep every generated file
  sh install.sh --update --global

Honours $CLAUDE_CONFIG_DIR for the global destination and $PIPELINE_REPO for the
source when piped through curl. The npm CLI (`npm i -g cohorte` then `cohorte install`)
does the same thing and is the documented route; this script exists for npm-less
setups (curl straight from the repo). Node itself is still required — the commands
are rendered per coding agent at install time and there is no shell renderer.
USAGE
      exit 0 ;;
    --)       shift; break ;;
    -*)       echo "error: unknown flag: $1 (try --help)" >&2; exit 2 ;;
    *)        positional="$1"; shift ;;
  esac
done
target="${positional:-$PWD}"

# --- locate the source (this checkout, or clone if piped via curl) ----------
src=""
self="${0:-}"
self_dir=""
case "$self" in
  # `sh install.sh` from inside a checkout hands $0 with no slash — the old */*-only
  # case missed it and silently CLONED the remote instead of installing the local
  # tree the human was standing in (dirname of a bare name is `.`, which is exactly
  # right here; the piped-stdin case stays `sh`, matches neither arm, and clones).
  */*)          self_dir=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd) ;;
  *install.sh*) self_dir=$(pwd) ;;
esac
if [ -n "$self_dir" ] && [ -d "$self_dir/core" ]; then
  src="$self_dir"
else
  echo "→ fetching pipeline from $REPO_URL"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  git clone --depth 1 "$REPO_URL" "$tmp/pipeline" >/dev/null 2>&1
  src="$tmp/pipeline"
fi
[ -d "$src/core" ] || { echo "error: pipeline source not found (no core/ in $src)" >&2; exit 1; }

# --- require Node >= 18, then delegate to the Node CLI -----------------------
# Since 2.2.0 the commands in core/ are runtime-NEUTRAL sources: they carry capability
# conditionals (`<!-- cohorte:if subagents -->`) and path tokens (`<core>`, `<state>`) that
# the adapter resolves per coding agent. Copying them verbatim, as this script used to,
# would install prompts full of unresolved markers — an install that looks successful and
# instructs the model with text meant for a different runtime. There is no shell renderer,
# so the whole job goes to bin/cli.js, which is the documented route anyway. (The legacy
# copy-verbatim shell path was removed in 2.7.0 — it had been unreachable dead code since
# 2.2.0, and its text was what validate-core's copy checks were vacuously matching.)
if command -v node >/dev/null 2>&1; then
  # An old Node fails DEEP into cli.js (fs.cpSync needs >= 16.7) after some files are
  # already on disk — a half-install that reports as a crash. Refuse up front instead.
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$node_major" in *[!0-9]*) node_major=0 ;; esac
  if [ "$node_major" -lt 18 ]; then
    echo "error: cohorte needs Node >= 18 — found $(node --version 2>/dev/null || echo '?')." >&2
    echo "  Upgrade Node, then re-run this script (or: npm i -g cohorte && cohorte install$([ "$scope" = global ] && echo ' --global'))." >&2
    exit 1
  fi
  set -- install
  [ "$mode" = "update" ] && set -- update
  [ "$scope" = "global" ] && set -- "$@" --global
  [ "$scope" = "project" ] && set -- "$@" "$target"
  # Not `exec`: exec replaces this shell, so the curl-path EXIT trap (rm -rf "$tmp")
  # never fires and every piped install leaks the shallow clone in $TMPDIR.
  node "$src/bin/cli.js" "$@"
  exit $?
fi
echo "error: cohorte needs Node >= 18 to install." >&2
echo "  The pipeline's commands are rendered per coding agent (Claude Code, Codex, Cursor," >&2
echo "  Gemini CLI, OpenCode) at install time; there is no shell equivalent of that step," >&2
echo "  and a raw copy would install prompts this runtime cannot follow." >&2
echo "  Install Node, then:  npm i -g cohorte && cohorte install$([ "$scope" = global ] && echo ' --global')" >&2
exit 1
