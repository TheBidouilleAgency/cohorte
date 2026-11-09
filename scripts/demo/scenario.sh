#!/usr/bin/env bash
# The sequence typed inside the recording. Runs against the fixture project.
#
# Every command here is really executed and its output is really the CLI's /
# the gate's. The only theatre is the typing speed and the pauses.
set -uo pipefail

COHORTE="${COHORTE_BIN:?}"
GATE="${COHORTE_GATE:?}"
PS_="\033[38;5;150m❯\033[0m "

type_out() { # simulate typing
  local s="$1"
  printf "%b" "$PS_"
  for ((i = 0; i < ${#s}; i++)); do
    printf "%s" "${s:i:1}"
    sleep 0.028
  done
  printf "\n"
}

step() { # type it, run it, breathe
  type_out "$1"
  eval "$2"
  sleep "${3:-2.2}"
  printf "\n"
}

note() { printf "\033[38;5;245m# %s\033[0m\n" "$1"; sleep 1.4; }

printf '\033[2J\033[H'
sleep 0.8

# One check's detail is a 300-character paragraph about workflow prerequisites.
# Elide it visibly (…) rather than let it wrap over four lines of the GIF.
trim="awk '{ if (length(\$0) > 88) print substr(\$0, 1, 85) \"…\"; else print }'"

note "the pipeline's health, without a coding agent in the loop"
step "cohorte doctor" "node '$COHORTE' doctor . | $trim" 3.6

note "the spec board, read from the specs' own front-matter"
step "cohorte specs" "node '$COHORTE' specs ." 3.0

# fold at word boundaries: a gate reason is one long sentence, and the terminal's
# own hard wrap splits it mid-word.
wrap="fold -s -w 88"

note "the gate is a real hook — every agent's Bash goes through it"
step "gate --check 'pnpm test'" "python3 '$GATE' --check 'pnpm test' | $wrap" 1.6
step "gate --check 'git push'" "python3 '$GATE' --check 'git push' | $wrap" 2.8

note "and a hard deny can't ride behind a benign command it's chained to"
step "gate --check 'git commit -m wip && node ace db:wipe'" \
  "python3 '$GATE' --check 'git commit -m wip && node ace db:wipe' | $wrap" 3.4

printf "\033[38;5;150m❯\033[0m "
sleep 2.5
