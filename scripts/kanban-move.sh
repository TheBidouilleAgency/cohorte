#!/bin/sh
# kanban-move.sh — move a feature card on an Obsidian Kanban board without
# loading the board into an agent's context (SCHEMA.md §Kanban "Move a card").
#
#   kanban-move.sh <board.md|auto> <feature-id> <column|stage> [options]
#   kanban-move.sh --check                 resolve only: print the board this
#                                          project maps to, or why it does not
#
#     --pr <num>        ensure the card line ends with ` — PR #<num>`
#     --title <title>   text to use when the card has to be created
#     --project <name>  profile name to look up in kanban.boards (default: read
#                       `name:` from ./PIPELINE.md)
#     --profile <path>  where to read that name from (default: ./PIPELINE.md)
#
# `auto` as the board resolves the board FROM THE CONFIG — vault path, this
# project's board file, and the stage→heading mapping — instead of making the
# caller do it. This exists because the callers are agents: told only "no-op
# silently if no board", a fresh session (every phase runs after a /clear)
# concluded "no board is configured" without ever opening the config, and the
# card silently stopped moving mid-pipeline. Resolution is not a judgment call,
# so it is not left to one. When nothing resolves the script says which link is
# missing on stdout and exits 0 — a no-op you can read, never one you infer.
#
# Behavior of the move itself (mirrors the documented manual op):
#   - finds the list item tagged #<feature-id> (plus its indented sub-notes),
#     removes it from its current column, appends it under `## <target-column>`
#   - no card yet ⇒ creates `- [ ] <title|id>  #<id>` in the target column
#   - duplicates ⇒ keeps the first, drops the rest
#   - never touches the front-matter or the trailing `%% kanban:settings %%` block
#
# Exit codes: 0 ok (incl. "kanban not configured") · 2 usage · 3 board/column
# not found. A configured board that cannot be moved is loud; an unconfigured
# one is quiet — the pipeline never blocks on the board.
set -eu

usage='usage: kanban-move.sh <board.md|auto> <feature-id> <column|stage> [--pr <num>] [--title <title>] [--project <name>] [--profile <path>]
       kanban-move.sh --check [--project <name>] [--profile <path>]'
check_only=false
if [ "${1-}" = --check ]; then
  check_only=true; board=auto; id=""; col=""; shift
else
  [ $# -ge 3 ] || { echo "$usage" >&2; exit 2; }
  board="$1"; id="$2"; col="$3"; shift 3
fi
pr=""; title=""; project=""; profile="PIPELINE.md"
while [ $# -gt 0 ]; do
  # A flag with no value must exit 2 (usage) like every other usage error — a bare
  # `shift 2` fails under set -e with exit 1, outside the 0/2/3 contract callers branch on.
  case "$1" in
    --pr|--title|--project|--profile)
      [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; echo "$usage" >&2; exit 2; } ;;
  esac
  case "$1" in
    --pr)      pr="$2";      shift 2 ;;
    --title)   title="$2";   shift 2 ;;
    --project) project="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    *) echo "error: unknown flag $1" >&2; echo "$usage" >&2; exit 2 ;;
  esac
done

TAB=$(printf '\t')
# One config per human, wherever the runtime that installed it put it: `~/.claude` for a
# Claude Code install (historical, still authoritative), `~/.cohorte` for every other coding
# agent. Probe both — a repo driven from two agents must resolve ONE board, not two.
CONFIG="${COHORTE_CONFIG:-}"
if [ -z "$CONFIG" ]; then
  for c in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte.config.yaml" \
           "$HOME/.cohorte/cohorte.config.yaml"; do
    [ -f "$c" ] && { CONFIG="$c"; break; }
  done
  CONFIG="${CONFIG:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte.config.yaml}"
fi

# The nine pipeline stages and their default headings. A stage key given as the
# target column is mapped through the config (per-board `columns` first, then the
# global `kanban.columns`) and falls back to these — so a stage key works even
# with an explicit board path and no config at all. Anything not in this list is
# taken as a literal heading, which keeps hand-written columns working.
default_heading() {
  case "$1" in
    ideas)      echo "Ideas" ;;
    brainstorm) echo "Brainstorm" ;;
    spec)       echo "Spec" ;;
    ready)      echo "Ready to build" ;;
    building)   echo "Building" ;;
    review)     echo "Review" ;;
    fix)        echo "Fix" ;;
    ship)       echo "Ship" ;;
    shipped)    echo "Shipped" ;;
    *)          echo "" ;;
  esac
}

# Read `name:` from the profile's `yaml pipeline-profile` block. Only the block —
# a `name:` under some other key (a surface, a persona) is not the project name.
read_project_name() {
  [ -f "$1" ] || return 0
  awk '
    /^```[ \t]*yaml[ \t]+pipeline-profile/ { inblock = 1; next }
    /^```/                                 { if (inblock) exit }
    inblock && /^name:[ \t]/ {
      v = $0; sub(/^name:[ \t]*/, "", v)
      sub(/[ \t]+#.*$/, "", v); sub(/[ \t]+$/, "", v)
      gsub(/^["\047]|["\047]$/, "", v)
      print v; exit
    }
  ' "$1"
}

# Minimal YAML reader for the fixed shape the installer writes. Not a general
# parser: it walks an indent stack and emits only the handful of paths the kanban
# mirror needs, resolved against the project name we were given (so a name with a
# dot in it still matches — the comparison is on whole strings, not a joined key).
read_config() {
  PROJ="$1" awk '
    function clean(v,   c, q, i, ch, out) {
      sub(/^[ \t]+/, "", v)
      if (v == "") return ""
      c = substr(v, 1, 1)
      if (c == "\"" || c == "\047") {
        q = c; out = ""
        for (i = 2; i <= length(v); i++) {
          ch = substr(v, i, 1)
          if (ch == q) break
          out = out ch
        }
        return out
      }
      sub(/[ \t]+#.*$/, "", v); sub(/[ \t]+$/, "", v)
      return v
    }
    # `columns: { ideas: "Idées", ready: "Prêt" }` — the flow form the config
    # template documents for a per-board override.
    function flow(path, v,   n, i, parts, p, k) {
      sub(/^\{[ \t]*/, "", v); sub(/[ \t]*\}[ \t]*$/, "", v)
      n = split(v, parts, ",")
      for (i = 1; i <= n; i++) {
        p = index(parts[i], ":")
        if (p == 0) continue
        k = substr(parts[i], 1, p - 1)
        gsub(/^[ \t]+|[ \t]+$/, "", k)
        emit(path "." k, clean(substr(parts[i], p + 1)))
      }
    }
    function emit(path, v,   stage) {
      if (v == "") return
      if (path == "enabled")             { print "ENABLED\t" v; return }
      if (path == "kanban.enabled")      { print "KENABLED\t" v; return }
      if (path == "obsidian.vault_path") { print "VAULT\t" v; return }
      if (path == "kanban.boards." proj ".board") { print "BOARD\t" v; return }
      if (index(path, "kanban.columns.") == 1) {
        print "COL." substr(path, length("kanban.columns.") + 1) "\t" v; return
      }
      if (index(path, "kanban.boards." proj ".columns.") == 1) {
        print "BCOL." substr(path, length("kanban.boards." proj ".columns.") + 1) "\t" v; return
      }
    }
    BEGIN { proj = ENVIRON["PROJ"]; top = 0 }
    {
      line = $0; sub(/\r$/, "", line)
      if (line ~ /^[ \t]*$/ || line ~ /^[ \t]*#/) next
      match(line, /^[ ]*/); ind = RLENGTH
      rest = substr(line, ind + 1)
      if (rest ~ /^- /) next
      p = index(rest, ":")
      if (p == 0) next
      key = substr(rest, 1, p - 1)
      if (key ~ /[ \t]/) next
      raw = substr(rest, p + 1)
      while (top > 0 && indent[top] >= ind) top--
      top++; indent[top] = ind; keyat[top] = key
      path = ""
      for (i = 1; i <= top; i++) path = path (i > 1 ? "." : "") keyat[i]
      sub(/^[ \t]+/, "", raw)
      if (substr(raw, 1, 1) == "{") { flow(path, raw); next }
      emit(path, clean(raw))
    }
  ' "$CONFIG"
}

off() { echo "kanban: $1"; exit 0; }

cfg=""
if [ "$board" = auto ] || [ -n "$(default_heading "$col")" ]; then
  [ -n "$project" ] || project=$(read_project_name "$profile")
  [ -f "$CONFIG" ] && cfg=$(read_config "$project") || cfg=""
fi

# ── resolve the board ───────────────────────────────────────────────────────
if [ "$board" = auto ]; then
  [ -f "$CONFIG" ] || off "no config at $CONFIG — board mirror off"
  vault=""; rel=""; enabled=""; kenabled=""
  OLDIFS=$IFS; IFS=$TAB
  while read -r k v; do
    case "$k" in
      ENABLED)  enabled=$v ;;
      KENABLED) kenabled=$v ;;
      VAULT)    vault=$v ;;
      BOARD)    rel=$v ;;
    esac
  done <<EOF
$cfg
EOF
  IFS=$OLDIFS
  [ "$enabled" != false ]  || off "cohorte capabilities disabled (enabled: false in $CONFIG)"
  [ "$kenabled" != false ] || off "disabled in $CONFIG (kanban.enabled: false)"
  [ -n "$project" ]        || off "no project name in $profile — cannot resolve a board"
  [ -n "$rel" ]            || off "no board configured for project \"$project\" in $CONFIG"
  [ -n "$vault" ]          || off "obsidian.vault_path not set in $CONFIG"
  board="$vault/$rel"
  [ -f "$board" ] || off "board file not found: $board"
  if $check_only; then echo "kanban: project \"$project\" -> $board"; exit 0; fi
fi

# ── resolve the column ──────────────────────────────────────────────────────
# A stage key becomes a heading; a literal heading passes through untouched.
if [ -n "$(default_heading "$col")" ]; then
  heading=""
  OLDIFS=$IFS; IFS=$TAB
  while read -r k v; do
    case "$k" in
      "BCOL.$col") heading=$v ;;
      "COL.$col")  [ -n "$heading" ] || heading=$v ;;
    esac
  done <<EOF
$cfg
EOF
  IFS=$OLDIFS
  [ -n "$heading" ] || heading=$(default_heading "$col")
  col="$heading"
fi

[ -f "$board" ] || { echo "error: board not found: $board" >&2; exit 3; }

tmp="${board}.kanban-move.$$"
ID="$id" COL="$col" PR="$pr" TITLE="${title:-$id}" awk '
  # Emit one line, collapsing runs of blank lines to a single one. Without this
  # every move netted +1 blank line in the target column (the card is inserted
  # with its own separator, right after the blank that already preceded the next
  # heading) — ten moves of one card padded a board with fifteen blank lines.
  function emit(s) {
    if (s == "") { if (lastblank) return; lastblank = 1 } else lastblank = 0
    print s
  }
  function put_card(   k) {
    emit(card)
    for (k = 1; k <= sn; k++) emit(snote[k])
  }
  BEGIN {
    id = ENVIRON["ID"]; col = tolower(ENVIRON["COL"])
    pr = ENVIRON["PR"]; title = ENVIRON["TITLE"]
    n = 0; card = ""; found = 0; colseen = 0; sn = 0; lastblank = 0
  }
  # Strip CR at capture: a CRLF board (Windows-synced vault) otherwise fails the
  # `h == col` heading compare and exits 3 on a column that exists — while the
  # config parser in this same script already strips \r. Emitting LF-only is fine
  # (Obsidian reads both).
  { sub(/\r$/, ""); lines[++n] = $0 }
  END {
    # pass 1: extract the FIRST card block tagged #id; mark every block for removal
    for (i = 1; i <= n; i++) {
      l = lines[i]
      if (l !~ /^- \[.\] /) continue
      p = index(l, "#" id)
      if (p == 0) continue
      # word-boundary check: char after the tag must not extend the id
      rest = substr(l, p + length(id) + 1, 1)
      if (rest != "" && rest ~ /[A-Za-z0-9_-]/) continue
      # Capture the sub-notes of the FIRST match only. Testing `card == lines[i]`
      # instead also captured a later duplicate whose text happened to match.
      isfirst = 0
      if (!found) { found = 1; card = l; isfirst = 1 }
      del[i] = 1
      for (j = i + 1; j <= n && lines[j] ~ /^[ \t]/; j++) {
        del[j] = 1
        if (isfirst) snote[++sn] = lines[j]
      }
      i = j - 1
    }
    if (!found) card = "- [ ] " title "  #" id
    if (pr != "" && index(card, "PR #") == 0) card = card " — PR #" pr

    # pass 2: emit, skipping removed blocks; append the card at the end of the
    # target column (before the next ## heading / settings block / EOF)
    intarget = 0; placed = 0
    for (i = 1; i <= n; i++) {
      if (del[i]) continue
      l = lines[i]
      atheading = (l ~ /^## /)
      atsettings = (l ~ /^%% kanban:settings/)
      if (intarget && (atheading || atsettings)) {
        # can not back up over already-printed lines; place the card just before
        # this boundary instead
        put_card()
        emit("")
        intarget = 0; placed = 1
      }
      if (atheading) {
        h = tolower(l); sub(/^## +/, "", h); gsub(/ +$/, "", h)
        if (h == col) { intarget = 1; colseen = 1 }
      }
      emit(l)
    }
    if (intarget && !placed) {
      put_card()
      placed = 1
    }
    if (!colseen) exit 3
  }
' "$board" > "$tmp" || { rc=$?; rm -f "$tmp"; [ "$rc" = 3 ] && echo "error: column \"$col\" not found in $board" >&2; exit "$rc"; }
mv "$tmp" "$board"
echo "moved #$id -> $col${pr:+ (PR #$pr)}"
