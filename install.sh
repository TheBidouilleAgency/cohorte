#!/bin/sh
#
# install.sh — install cohorte (the multi-agent dev pipeline for Claude Code) on this machine.
# POSIX sh (works with dash/bash/zsh). A thin wrapper around bin/cli.js: Node >= 20 is required.
#
#   curl -fsSL https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.sh | sh
#   sh install.sh             # from a checkout: installs that working tree
#   sh install.sh --update    # same thing — install is idempotent
#
# The documented route is `npm i -g cohorte && cohorte install`. Piped through curl, this script
# installs the LATEST RELEASE tag (never the tip of main), so both routes ship the same code.
# Then, in each project, run /cohorte-init-pipeline once.

set -eu

REPO_URL="${PIPELINE_REPO:-https://github.com/TheBidouilleAgency/cohorte}"

verb="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --update) verb="update"; shift ;;
    --global) shift ;;  # 2.x flag — 3.x has a single mode
    -h|--help)
      sed -n '2,13p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown argument: $1 (3.x installs on the machine; wire a project with /cohorte-init-pipeline)" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || {
  echo "error: cohorte needs Node >= 20 (https://nodejs.org), then: npm i -g cohorte && cohorte install" >&2
  exit 1
}
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$node_major" in *[!0-9]*) node_major=0 ;; esac
if [ "$node_major" -lt 20 ]; then
  echo "error: cohorte needs Node >= 20 — found $(node --version 2>/dev/null || echo '?')." >&2
  exit 1
fi

# --- locate the source: this checkout, or the latest release ------------------
src=""
case "${0:-}" in
  */*)          self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
  *install.sh*) self_dir=$(pwd) ;;
  *)            self_dir="" ;;
esac
if [ -n "$self_dir" ] && [ -f "$self_dir/bin/cli.js" ] && [ -d "$self_dir/core" ]; then
  src="$self_dir"
else
  command -v git >/dev/null 2>&1 || { echo "error: git is required (or use: npm i -g cohorte && cohorte install)" >&2; exit 1; }
  # Highest vX.Y.Z tag without a pre-release suffix.
  tag=$(git ls-remote --tags --refs "$REPO_URL" 'v*' 2>/dev/null \
    | sed 's#.*refs/tags/v##' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  [ -n "$tag" ] && tag="v$tag"
  [ -n "$tag" ] || { echo "error: could not list the releases of $REPO_URL" >&2; exit 1; }
  echo "→ fetching cohorte $tag from $REPO_URL"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  if ! git clone --quiet --depth 1 --branch "$tag" "$REPO_URL" "$tmp/cohorte"; then
    echo "error: git clone of $REPO_URL ($tag) failed" >&2
    exit 1
  fi
  src="$tmp/cohorte"
fi

# Not `exec`: exec replaces this shell, so the curl-path EXIT trap would never fire.
node "$src/bin/cli.js" "$verb"
