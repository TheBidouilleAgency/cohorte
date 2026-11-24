#!/bin/sh
#
# phase-clock.sh — a phase's wall-clock start and its metrics line, as ONE plain command each.
#
#   phase-clock.sh start   <feature-id> <phase>
#   phase-clock.sh metrics <feature-id> <phase> '<surfaces-json>'
#
# `start` writes the current epoch to specs/reports/<feature-id>.<phase>.start (creating
# specs/reports/) and prints it. `metrics` appends ONE line to the MAIN checkout's
# .claude/pipeline-metrics.jsonl —
#   {"ts":"<ISO>","feature":"<id>","phase":"<phase>","seconds":<now - start>,"surfaces":<json>}
# — and prints it. No start file ⇒ `seconds` is null (an unknown duration, never a made-up 0).
#
# Why a script: the commands used to tell the lead to "note the epoch in the same Bash call"
# and to build the metrics line with `$(dirname "$(git rev-parse …)")` and `$(($(date +%s)-…))`
# inline. Compound calls like those trigger a permission prompt every time, and the epoch lived
# in shared paths (/tmp/cohorte-start) that two worktrees overwrote for each other. The start
# file lives under the feature's own specs/reports/, which is per checkout and gitignored.
#
# Exit codes: 0 ok · 2 usage (unknown mode, feature id not a slug, phase not a word,
# surfaces not a JSON object).

set -u

usage='usage: phase-clock.sh start <feature-id> <phase>
       phase-clock.sh metrics <feature-id> <phase> '"'"'<surfaces-json>'"'"''

mode="${1:-}"; feature="${2:-}"; phase="${3:-}"
case "$mode" in start|metrics) ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$feature" in ''|*[!A-Za-z0-9._-]*) echo "phase-clock: feature id must be a slug: '$feature'" >&2; exit 2 ;; esac
case "$phase" in ''|*[!a-z0-9-]*) echo "phase-clock: phase must be a lowercase word: '$phase'" >&2; exit 2 ;; esac

start_file="specs/reports/$feature.$phase.start"

if [ "$mode" = start ]; then
  mkdir -p specs/reports
  now=$(date +%s)
  printf '%s\n' "$now" > "$start_file"
  printf '%s\n' "$now"
  exit 0
fi

surfaces="${4:-}"
case "$surfaces" in
  \{*\}) ;;
  *) echo "phase-clock: surfaces must be a JSON object, e.g. '{\"backend\":\"ok\"}'" >&2; exit 2 ;;
esac

now=$(date +%s)
seconds=null
if [ -f "$start_file" ]; then
  begin=$(tr -dc '0-9' < "$start_file")
  [ -n "$begin" ] && seconds=$((now - begin))
fi
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# The MAIN checkout's state dir: metrics must accumulate across features, and a feature
# worktree's .claude dies at teardown. git-common-dir resolves to the main .git from anywhere.
common=$(git rev-parse --git-common-dir 2>/dev/null || echo .git)
main=$(cd "$(dirname "$common")" && pwd)
mkdir -p "$main/.claude"
line=$(printf '{"ts":"%s","feature":"%s","phase":"%s","seconds":%s,"surfaces":%s}' \
  "$ts" "$feature" "$phase" "$seconds" "$surfaces")
printf '%s\n' "$line" >> "$main/.claude/pipeline-metrics.jsonl"
printf '%s\n' "$line"
