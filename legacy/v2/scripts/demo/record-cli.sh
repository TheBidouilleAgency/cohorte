#!/usr/bin/env bash
# Records the README demo: assets/demo-cli.cast (source) + assets/demo-cli.gif.
#
#   bash scripts/demo/record-cli.sh
#
# Needs asciinema (>=3) and agg:  brew install asciinema agg
#
# The recording runs against an ephemeral fixture project in a temp dir
# (scripts/demo/fixture.sh), which is deleted afterwards — there is no demo
# repo to maintain, and no real project's spec titles end up in a public GIF.
# Re-run it after any change to the CLI's output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# A short, boring path: the doctor prints the project root it resolved, and a
# mktemp path would put 40 characters of /private/var/folders/… in the GIF.
WORK="/tmp/cohorte-demo"
CAST="$ROOT/assets/demo-cli.cast"
GIF="$ROOT/assets/demo-cli.gif"

command -v asciinema >/dev/null || { echo "asciinema not found — brew install asciinema"; exit 1; }
command -v agg >/dev/null || { echo "agg not found — brew install agg"; exit 1; }

echo "→ building the fixture in $WORK"
rm -rf "$WORK"
bash "$ROOT/scripts/demo/fixture.sh" "$WORK"

echo "→ recording"
rm -f "$CAST"
COHORTE_BIN="$ROOT/bin/cli.js" \
COHORTE_GATE="$ROOT/core/hooks/gate.py" \
TERM=xterm-256color \
  asciinema rec "$CAST" \
    --window-size 92x26 \
    --title "cohorte — doctor, spec board, gate" \
    --command "cd '$WORK' && bash '$ROOT/scripts/demo/scenario.sh'" \
    --capture-env "TERM" \
    --overwrite --quiet

echo "→ rendering $GIF"
agg --theme asciinema --font-size 15 --line-height 1.5 \
    --speed 1.0 --last-frame-duration 3 \
    "$CAST" "$GIF"

# VitePress only serves what's under docs/public, and the README points at the
# raw GitHub URL of assets/ — so the GIF has to exist in both. Copy rather than
# symlink, and do it here, so the two can never drift.
cp "$GIF" "$ROOT/docs/public/demo-cli.gif"

rm -rf "$WORK"
echo "✓ $CAST"
echo "✓ $GIF  ($(du -h "$GIF" | cut -f1))"
echo "✓ $ROOT/docs/public/demo-cli.gif"
