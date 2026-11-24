#!/usr/bin/env bash
#
# verify-run.sh — the deterministic half of /cohorte-verify (and of /cohorte-revert's down
# migration). It owns everything a prompt must not improvise: starting the dev server in its
# own process group, probing it, running the checks under timeouts, stopping the server on
# EVERY exit path, refusing to migrate a shared database, and writing the machine verdict.
# Doctrine: profile/schema/verify.md.
#
#   verify-run.sh run <id> [options]        run the checks, write <out>/<id>.<phase>.json + .md
#   verify-run.sh rollback-check <spec.md>  exit 1 when `migrations: true` and ## Rollback is empty
#   verify-run.sh stop <id> [--out <dir>] [--phase <p>]   reap a server a killed run left behind
#
# run options (every command is passed literally, as the profile spells it):
#   --dev "<cmd>"              start the app in the background (its output: <evidence>/dev.log)
#   --ready "<url|cmd>"        ready probe: an http(s) URL must answer 2xx/3xx, a command exit 0
#   --check "<name>=<cmd>"     repeatable: smoke, e2e, smoke:<surface> … run in order, app up
#   --screenshot "<name>=<url>"  repeatable: evidence only (a local Playwright CLI, never npx install)
#   --migrate "<cmd>"          apply migrations before the app starts
#   --migrate-down "<cmd>"     verify phase: down, then --migrate again (check `rollback`);
#                              revert phase: [--migrate first, then] down (check `migrate-down`)
#   --db local|shared          required with any migration flag (profile verify.db)
#   --db-per-worktree true|false   (profile isolation.db_per_worktree)
#   --slots <path>             the isolation slot registry (profile isolation.registry, .worktrees/slots.tsv)
#   --skip "<name>=<reason>"   record a check as SKIPPED without running anything
#   --digest-base <sha>        record feature-diff.sh --digest of the verified tree (ship compares it)
#   --phase verify|revert      names the outputs (default verify)
#   --out <dir>                default specs/reports
#   --ready-timeout <s>  (90)  --check-timeout <s> (600)  --deadline <s> (540, whole run)
#   --confirmed                the human approved, in this session, the commands the gate would ask for
#
# The project gate (.claude/hooks/cohorte-gate.py) is asked, in `--check` mode, about every
# command this script was handed BEFORE running any of them. Exit 0 (allow) means the gate
# approved it: no rule denies or asks, and it is a command of the project's .claude/profile.json
# or covered by a permissions.allow rule. Exit 2 (deny) ⇒ that check is SKIPPED, never run.
# Exit 1 (ask), 3 (defer: no gate rule matched, so only Claude Code's permission would have
# decided) or anything else ⇒ exit 4 with the list, nothing started, unless --confirmed. Claude
# Code approves `verify-run.sh …` itself through the allowlisted <core>/pipeline/scripts/, so a
# deferred command run from here would have had NO prompt at all: defer counts as ask.
#
# `--confirmed` is an ordinary argument: the agent can set it. It relays the human's approval,
# given in chat in an attended session, and that is all it does. It never overrides a deny (a
# denied command is SKIPPED whatever the flag says), and it approves nothing for the PreToolUse
# hook, which judges the commands of this call on its own and asks the human (denies, when
# unattended) for any it would not approve. The gate stays the authority; this script never
# widens what it allows.
#
# Exit: 0 PASS · 1 FAIL · 3 SKIPPED (nothing verified) · 4 needs the human's confirmation · 2 usage.
# Never touches git state: no checkout, commit, push or merge — it reads HEAD and diffs, that's all.

set -u

die() { echo "verify-run: $*" >&2; exit 2; }

json_str() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' -e 's/\r//g' \
    | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

# ── rollback-check ─────────────────────────────────────────────────────────────
rollback_check() {
  spec="${1:?usage: verify-run.sh rollback-check <spec.md>}"
  [ -f "$spec" ] || die "no such spec: $spec"
  # A missing `migrations:` key means false — legacy specs predate the field.
  if ! awk '{ sub(/\r$/, "") } NR == 1 && $0 != "---" { exit 1 } NR > 1 && $0 == "---" { exit 1 }
            NR > 1 && /^migrations:[ \t]*true([ \t]|#|$)/ { found = 1; exit 0 }
            END { exit found ? 0 : 1 }' "$spec"; then
    echo "rollback: spec declares no migrations — nothing to check"
    exit 0
  fi
  # Filled = at least one line in ## Rollback that is not blank, not a `>` note, not a comment,
  # and not a template stub (`- **Label:** …` with nothing but an ellipsis / <placeholder>).
  filled=$(awk '
    { sub(/\r$/, "") }
    /^## / { inside = ($0 ~ /^## Rollback[ \t]*$/); next }
    !inside { next }
    /^[ \t]*$/ || /^[ \t]*>/ || /^[ \t]*<!--/ { next }
    {
      l = $0
      gsub(/<!--.*-->/, "", l)
      sub(/^[ \t]*[-*][ \t]*/, "", l)
      sub(/^\*\*[^*]*\*\*[ \t]*:?[ \t]*/, "", l)
      gsub(/[ \t]/, "", l)
      if (l == "" || l == "…" || l == "..." || l ~ /^<[^>]*>$/ || l == "`none`" || l == "none") next
      n++
    }
    END { print n + 0 }' "$spec")
  if [ "$filled" -gt 0 ]; then
    echo "rollback: filled ($filled line(s))"
    exit 0
  fi
  echo "rollback: EMPTY — the spec says \`migrations: true\` but ## Rollback has nothing to follow" >&2
  exit 1
}

# ── process groups ────────────────────────────────────────────────────────────
# `pnpm dev` is a tree (pnpm → sh → node → watchers). Killing $! kills the wrapper and orphans the
# server on its port, so everything is started in its own process GROUP (job control, `set -m`)
# and stopped as a group, plus any descendant that left it: TERM, a grace period, then KILL.
# bash, not sh: dash refuses `set -m` without a tty, and stock macOS has no setsid/timeout.
# Every live group is listed in <evidence>/pgids: the EXIT trap stops them all, and a run that
# was SIGKILLed (no trap runs) is reaped by `stop` or by the next run from that list.
spawn() { # spawn <logfile> <cmd> — sets $spawned to the group leader's pid
  set -m
  # pipefail: a check written `<runner> 2>&1 | tail -20` must fail when the runner fails.
  bash -o pipefail -c "$2" > "$1" 2>&1 < /dev/null &
  spawned=$!
  set +m
  remember "$spawned"
}

remember() { [ -n "${registry:-}" ] && echo "$1" >> "$registry"; return 0; }
forget() {
  [ -n "${registry:-}" ] && [ -f "$registry" ] || return 0
  grep -vxF "$1" "$registry" > "$registry.tmp" 2>/dev/null; mv -f "$registry.tmp" "$registry"
  [ -s "$registry" ] || rm -f "$registry"
}
reap_all() { # reap_all <registry> — stop every group a run recorded
  [ -f "$1" ] || return 0
  for g in $(cat "$1"); do stop_group "$g" 5; done
  rm -f "$1"
}

group_alive() { kill -0 "-$1" 2>/dev/null || kill -0 "$1" 2>/dev/null; }

descendants() { # every live descendant pid of $1 (a child that left the group is still ours)
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$1" '
    { kids[$2] = kids[$2] " " $1 }
    END { n = split(root, q, " "); while (n > 0) { p = q[n--]; m = split(kids[p], c, " ");
          for (i = 1; i <= m; i++) { print c[i]; q[++n] = c[i] } } }'
}

stop_group() { # stop_group <pgid> [grace seconds]
  g="$1"; grace="${2:-10}"
  tree=$(descendants "$g")
  group_alive "$g" || [ -n "$tree" ] || return 0
  kill -TERM "-$g" 2>/dev/null || kill -TERM "$g" 2>/dev/null
  for p in $tree; do kill -TERM "$p" 2>/dev/null; done
  i=0
  while [ "$i" -lt "$((grace * 5))" ]; do
    alive=0; group_alive "$g" && alive=1
    for p in $tree; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" -eq 1 ] || break
    sleep 0.2 2>/dev/null || sleep 1; i=$((i + 1))
  done
  kill -KILL "-$g" 2>/dev/null
  for p in $tree; do kill -KILL "$p" 2>/dev/null; done
  wait "$g" 2>/dev/null || true
}

now() { date +%s; }

# timed <seconds> <logfile> <cmd> — run in its own group; $timed_status = exit code (124 = timeout)
timed() {
  t="$1"; [ "$t" -gt 0 ] || t=1
  marker="$evdir/.timeout.$$"
  rm -f "$marker"
  spawn "$2" "$3"; job=$spawned
  set -m
  ( sleep "$t"; : > "$marker"; kill -TERM "-$job" 2>/dev/null; sleep 5; kill -KILL "-$job" 2>/dev/null ) > /dev/null 2>&1 &
  dog=$!
  set +m
  remember "$dog"
  wait "$job" 2>/dev/null; timed_status=$?
  stop_group "$dog" 1; forget "$dog"
  # A timed-out check's own children may survive the wrapper: reap the group either way.
  stop_group "$job" 2; forget "$job"
  if [ -f "$marker" ]; then timed_status=124; rm -f "$marker"; fi
}

# ── results ───────────────────────────────────────────────────────────────────
checks_json=""
evidence_json=""
md_rows=""
any_pass=0
any_fail=0

add_check() { # add_check <name> <PASS|FAIL|SKIPPED> <exit|""> <seconds> <cmd> <log> <note>
  [ "$2" = PASS ] && any_pass=1
  [ "$2" = FAIL ] && any_fail=1
  e="${3:-null}"
  entry="{\"name\":\"$(json_str "$1")\",\"status\":\"$2\",\"exit\":$e,\"seconds\":${4:-0},\"cmd\":\"$(json_str "$5")\",\"log\":\"$(json_str "$6")\",\"note\":\"$(json_str "$7")\"}"
  checks_json="${checks_json:+$checks_json,}$entry"
  md_rows="$md_rows| \`$1\` | $2 | ${6:+\`$6\`} | $7 |
"
  [ -n "$6" ] && add_evidence "$6"
  echo "  $2  $1${7:+ — $7}"
}

add_evidence() {
  case ",$evidence_json," in *"\"$(json_str "$1")\""*) return ;; esac
  evidence_json="${evidence_json:+$evidence_json,}\"$(json_str "$1")\""
}

write_report() { # write_report <verdict> <reason>
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  head_sha=$(git rev-parse HEAD 2>/dev/null || echo none)
  d1=null; [ -n "$digest" ] && d1="\"$digest\""
  d2=null; [ -n "$digest_after" ] && d2="\"$digest_after\""
  printf '{"id":"%s","phase":"%s","ts":"%s","verdict":"%s","reason":"%s","head":"%s","digest_base":%s,"digest":%s,"digest_after":%s,"checks":[%s],"evidence":[%s]}\n' \
    "$(json_str "$id")" "$phase" "$ts" "$1" "$(json_str "$2")" "$head_sha" \
    "$( [ -n "$digest_base" ] && printf '"%s"' "$digest_base" || printf null)" "$d1" "$d2" \
    "$checks_json" "$evidence_json" > "$json"
  {
    echo "# $phase — $id"
    echo
    echo "**Verdict: $1**${2:+ — $2}  "
    echo "\`$ts\` · HEAD \`$head_sha\` · digest \`${digest:-none}\`"
    echo
    echo "| check | status | evidence | note |"
    echo "| --- | --- | --- | --- |"
    printf '%s' "$md_rows"
    echo
    echo "Machine verdict: \`$json\`. Logs and screenshots: \`$evdir/\`."
  } > "$md"
  final_written=1
}

# ── run ───────────────────────────────────────────────────────────────────────
run() {
  id="${1:?usage: verify-run.sh run <id> [options]}"; shift
  out=specs/reports; phase=verify; dev=""; ready=""; migrate=""; down=""; db=""; dbwt=false; registry=""
  ready_to=90; check_to=600; deadline=540; confirmed=0; digest_base=""; slots=.worktrees/slots.tsv
  nchecks=0; nshots=0; nskips=0
  checks_file=$(mktemp) || die "mktemp failed"; shots_file=$(mktemp); skips_file=$(mktemp)
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dev) dev="${2-}"; shift 2 ;;
      --ready) ready="${2-}"; shift 2 ;;
      --check) printf '%s\n' "${2-}" >> "$checks_file"; nchecks=$((nchecks + 1)); shift 2 ;;
      --screenshot) printf '%s\n' "${2-}" >> "$shots_file"; nshots=$((nshots + 1)); shift 2 ;;
      --skip) printf '%s\n' "${2-}" >> "$skips_file"; nskips=$((nskips + 1)); shift 2 ;;
      --migrate) migrate="${2-}"; shift 2 ;;
      --migrate-down) down="${2-}"; shift 2 ;;
      --db) db="${2-}"; shift 2 ;;
      --db-per-worktree) dbwt="${2-}"; shift 2 ;;
      --slots) slots="${2-}"; shift 2 ;;
      --digest-base) digest_base="${2-}"; shift 2 ;;
      --phase) phase="${2-}"; shift 2 ;;
      --out) out="${2-}"; shift 2 ;;
      --ready-timeout) ready_to="${2-}"; shift 2 ;;
      --check-timeout) check_to="${2-}"; shift 2 ;;
      --deadline) deadline="${2-}"; shift 2 ;;
      --confirmed) confirmed=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  case "$phase" in verify|revert) ;; *) die "--phase must be verify or revert" ;; esac
  [ -z "$dev" ] || [ -n "$ready" ] || die "--dev needs --ready (a server nobody probes is a guess)"
  if [ -n "$migrate$down" ]; then
    case "$db" in local|shared) ;; *) die "--db local|shared is required with a migration flag" ;; esac
  fi
  [ "$phase" = verify ] && [ -n "$down" ] && [ -z "$migrate" ] && die "--migrate-down needs --migrate (down, then up again)"
  [ "$phase" = revert ] && [ -z "$down" ] && die "--phase revert needs --migrate-down"

  top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  cd "$top" || die "cannot cd to $top"
  mkdir -p "$out" || die "cannot create $out"
  json="$out/$id.$phase.json"; md="$out/$id.$phase.md"; evdir="$out/$id.$phase"
  mkdir -p "$evdir"
  digest=""; digest_after=""; final_written=0; server=""; started=$(now)

  # A run that was killed outright (SIGKILL skips traps) left its groups behind: reap them first.
  if [ -f "$evdir/pgids" ]; then
    echo "verify-run: reaping what a killed run left behind ($(tr '\n' ' ' < "$evdir/pgids"))"
    reap_all "$evdir/pgids"
  fi
  registry="$evdir/pgids"

  # ── ask the gate about every command, before running any ──
  gate="$top/.claude/hooks/cohorte-gate.py"
  if [ ! -f "$gate" ]; then
    common=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
    [ -n "$common" ] && gate="$(cd "$(dirname "$common")" 2>/dev/null && pwd)/.claude/hooks/cohorte-gate.py"
  fi
  denied_file=$(mktemp); asks=""
  gate_verdict() { # prints allow|ask|deny — only exit 0 is an allow; 3 (defer) is an ask
    [ -f "$gate" ] || { echo allow; return; }
    command -v python3 > /dev/null 2>&1 || { echo ask; return; }
    python3 "$gate" --check --cwd "$top" -- "$1" < /dev/null > /dev/null 2>&1
    case $? in 0) echo allow ;; 2) echo deny ;; *) echo ask ;; esac
  }
  consider() { # consider <name> <cmd>
    [ -n "$2" ] || return 0
    case $(gate_verdict "$2") in
      deny) printf '%s\n' "$1" >> "$denied_file" ;;
      ask) asks="$asks
  - $1: $2" ;;
    esac
  }
  consider migrate "$migrate"
  consider migrate-down "$down"
  consider dev "$dev"
  case "$ready" in http://*|https://*|"") ;; *) consider ready "$ready" ;; esac
  while IFS= read -r spec_line; do
    [ -n "$spec_line" ] || continue
    consider "${spec_line%%=*}" "${spec_line#*=}"
  done < "$checks_file"
  if [ -n "$asks" ] && [ "$confirmed" -ne 1 ]; then
    echo "verify-run: the project gate asks for confirmation before:$asks" >&2
    echo "verify-run: nothing was started. Ask the human; on yes re-run with --confirmed." >&2
    rm -f "$checks_file" "$shots_file" "$skips_file" "$denied_file"
    exit 4
  fi
  is_denied() { grep -qxF "$1" "$denied_file"; }

  cleanup() {
    [ -n "$server" ] && { stop_group "$server" 10; forget "$server"; server=""; }
    reap_all "$registry"
    if [ "$final_written" -ne 1 ]; then
      add_check run FAIL "" 0 "" "" "interrupted before the run completed"
      write_report FAIL "interrupted"
    fi
    rm -f "$checks_file" "$shots_file" "$skips_file" "$denied_file" 2>/dev/null
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  # Crash-safe: an old PASS must never survive a run that dies half-way.
  printf '{"id":"%s","phase":"%s","verdict":"FAIL","reason":"incomplete — a run is in progress or died","checks":[],"evidence":[]}\n' \
    "$(json_str "$id")" "$phase" > "$json"

  remaining() { r=$((deadline - ($(now) - started))); [ "$r" -gt 0 ] && echo "$r" || echo 0; }
  feature_digest() {
    fd="$(dirname "$0")/feature-diff.sh"
    [ -n "$digest_base" ] && [ -x "$fd" ] || return 0
    "$fd" --base "$digest_base" --digest 2>/dev/null || true
  }
  digest=$(feature_digest)

  while IFS= read -r s; do
    [ -n "$s" ] && add_check "${s%%=*}" SKIPPED "" 0 "" "" "${s#*=}"
  done < "$skips_file"

  # run_step <name> <cmd> <timeout> — returns 0 on PASS
  run_step() {
    if is_denied "$1"; then add_check "$1" SKIPPED "" 0 "$2" "" "denied by the project gate (gate.deny) — not run"; return 2; fi
    left=$(remaining)
    [ "$left" -gt 0 ] || { add_check "$1" FAIL "" 0 "$2" "" "run deadline reached before it started"; return 1; }
    [ "$3" -lt "$left" ] && tmo="$3" || tmo="$left"
    log="$evdir/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_').log"
    t0=$(now); timed "$tmo" "$log" "$2"; st=$timed_status; dt=$(( $(now) - t0 ))
    if [ "$st" -eq 0 ]; then add_check "$1" PASS 0 "$dt" "$2" "$log" ""; return 0; fi
    if [ "$st" -eq 124 ]; then add_check "$1" FAIL 124 "$dt" "$2" "$log" "timed out after ${tmo}s"; else
      add_check "$1" FAIL "$st" "$dt" "$2" "$log" "exit $st"; fi
    return 1
  }

  verdict_and_exit() {
    if [ "$any_fail" -eq 1 ]; then v=FAIL; code=1
    elif [ "$any_pass" -eq 1 ]; then v=PASS; code=0
    else v=SKIPPED; code=3; fi
    write_report "$v" "$1"
    echo "verify-run: $v — $json"
    exit "$code"
  }

  # ── database guard: never a shared DB ──
  if [ -n "$migrate$down" ]; then
    # Its own DB = a linked worktree that new-feature.sh registered: a row for this branch's last
    # path segment (feature/<id>, fix/patch-<slug>, feature/revert-<id>) in the slot registry. A
    # bare `git worktree add` shares the main checkout's .env, and so its database.
    own_db=0
    if [ "$dbwt" = true ] && [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
      main_dir=$(cd "$(dirname "$(git rev-parse --git-common-dir)")" 2>/dev/null && pwd)
      case "$slots" in /*) reg_file="$slots" ;; *) reg_file="$main_dir/$slots" ;; esac
      wid=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); wid="${wid##*/}"
      [ -n "$wid" ] && [ -f "$reg_file" ] && awk -F'\t' -v w="$wid" '$1 == w { f = 1 } END { exit !f }' "$reg_file" && own_db=1
    fi
    if [ "$db" = shared ] && [ "$own_db" -ne 1 ]; then
      why="the dev database is marked shared (verify.db: shared) and this checkout has no database of its own (a feature worktree registered in $slots, with isolation.db_per_worktree) — refusing to migrate it"
      [ -n "$migrate" ] && add_check migrate SKIPPED "" 0 "$migrate" "" "$why"
      [ -n "$down" ] && add_check "$( [ "$phase" = verify ] && echo rollback || echo migrate-down)" SKIPPED "" 0 "$down" "" "$why"
      verdict_and_exit "shared database: nothing was migrated and the app was not started"
    fi
  fi

  # revert: bring the (fresh, isolated) dev DB up to the default branch first when asked, then
  # run the down step — BEFORE the revert deletes the migration files that hold its code.
  if [ "$phase" = revert ]; then
    if [ -n "$migrate" ] && ! run_step migrate "$migrate" "$check_to"; then
      verdict_and_exit "migrations did not apply — the down step was not run"
    fi
    run_step migrate-down "$down" "$check_to" || true
    verdict_and_exit ""
  fi

  if [ -n "$migrate" ]; then
    if ! run_step migrate "$migrate" "$check_to"; then
      verdict_and_exit "migrations did not apply — the app was not started"
    fi
    if [ -n "$down" ]; then
      if is_denied migrate-down; then
        add_check rollback SKIPPED "" 0 "$down" "" "denied by the project gate (gate.deny) — rollback not verified"
      else
        t0=$(now)
        rlog="$evdir/rollback.log"
        timed "$(remaining)" "$rlog" "$down"; s1=$timed_status
        if [ "$s1" -eq 0 ]; then
          timed "$(remaining)" "$evdir/rollback.reup.log" "$migrate"; s2=$timed_status
          cat "$evdir/rollback.reup.log" >> "$rlog" 2>/dev/null; rm -f "$evdir/rollback.reup.log"
          if [ "$s2" -eq 0 ]; then add_check rollback PASS 0 $(( $(now) - t0 )) "$down && $migrate" "$rlog" "down then up again"
          else add_check rollback FAIL "$s2" $(( $(now) - t0 )) "$down && $migrate" "$rlog" "down worked, re-applying failed (exit $s2) — the dev DB is now behind"
            verdict_and_exit "re-applying migrations after the rollback failed"; fi
        else
          add_check rollback FAIL "$s1" $(( $(now) - t0 )) "$down" "$rlog" "down migration failed (exit $s1)"
          verdict_and_exit "the down migration failed"
        fi
      fi
    fi
  fi

  base_url=""
  case "$ready" in http://*|https://*) base_url=$(printf '%s' "$ready" | sed -E 's#^(https?://[^/]+).*#\1#') ;; esac
  VERIFY_ARTIFACTS="$(cd "$evdir" && pwd)"; export VERIFY_ARTIFACTS
  [ -n "$base_url" ] && { VERIFY_BASE_URL="$base_url"; export VERIFY_BASE_URL; }

  probe() {
    case "$ready" in
      http://*|https://*)
        if command -v curl > /dev/null 2>&1; then curl -s -f -o /dev/null --max-time 3 "$ready" > /dev/null 2>&1
        elif command -v node > /dev/null 2>&1; then
          node -e 'fetch(process.argv[1],{redirect:"manual",signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.status<400?0:1),()=>process.exit(1))' "$ready"
        else wget -q -O /dev/null -T 3 "$ready" > /dev/null 2>&1; fi ;;
      *) timed 10 "$evdir/.probe.log" "$ready"; [ "$timed_status" -eq 0 ] ;;
    esac
  }

  if [ -n "$dev" ]; then
    if is_denied dev; then
      add_check dev SKIPPED "" 0 "$dev" "" "denied by the project gate (gate.deny) — app not started"
      verdict_and_exit "the dev command is denied by the gate"
    fi
    if is_denied ready; then
      add_check ready SKIPPED "" 0 "$ready" "" "the ready probe is denied by the project gate (gate.deny) — app not started"
      verdict_and_exit "the ready probe is denied by the gate"
    fi
    # Something already answering means we would verify someone else's server.
    if probe; then
      add_check ready FAIL "" 0 "$ready" "" "the ready probe answered BEFORE the dev server started — another process holds it (a stale server, the main checkout's app?); stop it and re-run"
      verdict_and_exit "the ready probe was already answering"
    fi
    spawn "$evdir/dev.log" "$dev"; server=$spawned
    add_evidence "$evdir/dev.log"
    t0=$(now)
    [ "$ready_to" -lt "$(remaining)" ] && rt="$ready_to" || rt=$(remaining)
    ok=0
    while [ $(( $(now) - t0 )) -lt "$rt" ]; do
      if ! kill -0 "$server" 2>/dev/null; then
        wait "$server" 2>/dev/null; dst=$?
        add_check ready FAIL "$dst" $(( $(now) - t0 )) "$ready" "$evdir/dev.log" "the dev server exited (status $dst) before it was ready"
        stop_group "$server" 2; forget "$server"; server=""
        verdict_and_exit "the dev server died before it was ready"
      fi
      if probe; then ok=1; break; fi
      sleep 1
    done
    if [ "$ok" -ne 1 ]; then
      add_check ready FAIL "" "$rt" "$ready" "$evdir/dev.log" "not ready after ${rt}s"
      verdict_and_exit "the app never became ready"
    fi
    add_check ready PASS 0 $(( $(now) - t0 )) "$ready" "$evdir/dev.log" ""
  fi

  while IFS= read -r c; do
    [ -n "$c" ] || continue
    run_step "${c%%=*}" "${c#*=}" "$check_to" || true
  done < "$checks_file"

  if [ "$nshots" -gt 0 ]; then
    pw=""
    [ -x "$top/node_modules/.bin/playwright" ] && pw="$top/node_modules/.bin/playwright"
    [ -z "$pw" ] && command -v playwright > /dev/null 2>&1 && pw=$(command -v playwright)
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      sname="${s%%=*}"; surl="${s#*=}"
      # The URL is data, never shell text: a plain http(s) URL only, handed over in the env.
      case "$surl" in
        http://*|https://*) ;;
        *) add_check "screenshot:$sname" SKIPPED "" 0 "$surl" "" "not an http(s) URL — not captured"; continue ;;
      esac
      if [ -z "$pw" ]; then add_check "screenshot:$sname" SKIPPED "" 0 "" "" "no local Playwright CLI (node_modules/.bin/playwright) — evidence not captured"; continue; fi
      f="$evdir/$(printf '%s' "$sname" | tr -c 'A-Za-z0-9._-' '_')"
      slog="$f.screenshot.log"
      VR_PW="$pw"; VR_URL="$surl"; VR_SHOT="$f"; export VR_PW VR_URL VR_SHOT
      timed 60 "$slog" '"$VR_PW" screenshot --viewport-size=390,844 "$VR_URL" "$VR_SHOT.mobile.png" && "$VR_PW" screenshot --viewport-size=1280,800 "$VR_URL" "$VR_SHOT.desktop.png"'
      if [ "$timed_status" -eq 0 ]; then
        add_check "screenshot:$sname" PASS 0 0 "$surl" "$f.mobile.png" "evidence for a human eye — it proves the page rendered, not that it is right"
        add_evidence "$f.desktop.png"
      else
        # Evidence tooling failing (no browser installed) never fails the verdict.
        add_check "screenshot:$sname" SKIPPED "$timed_status" 0 "$surl" "$slog" "screenshot failed — see the log"
      fi
    done < "$shots_file"
  fi

  if [ -n "$server" ]; then stop_group "$server" 10; forget "$server"; server=""; fi

  if [ -n "$digest" ]; then
    digest_after=$(feature_digest)
    if [ -n "$digest_after" ] && [ "$digest_after" != "$digest" ]; then
      add_check tree FAIL "" 0 "" "" "the checks changed the feature diff (a file written outside specs/ and .claude/, not gitignored) — /cohorte-ship would call the review stale; send outputs to \$VERIFY_ARTIFACTS or gitignore them"
    fi
  fi
  verdict_and_exit ""
}

stop_cmd() {
  id="${1:?usage: verify-run.sh stop <id> [--out <dir>] [--phase <p>]}"; shift
  out=specs/reports; phase=verify
  while [ "$#" -gt 0 ]; do
    case "$1" in --out) out="$2"; shift 2 ;; --phase) phase="$2"; shift 2 ;; *) die "unknown option: $1" ;; esac
  done
  top=$(git rev-parse --show-toplevel 2>/dev/null || pwd); cd "$top" || exit 2
  reg="$out/$id.$phase/pgids"
  [ -f "$reg" ] || { echo "verify-run: nothing recorded as running for $id"; exit 0; }
  gs=$(tr '\n' ' ' < "$reg"); reap_all "$reg"
  echo "verify-run: stopped process group(s) $gs"
}

cmd="${1:-}"; [ "$#" -gt 0 ] && shift
case "$cmd" in
  run) run "$@" ;;
  rollback-check) rollback_check "$@" ;;
  stop) stop_cmd "$@" ;;
  *) die "usage: verify-run.sh run <id> [options] | rollback-check <spec.md> | stop <id>" ;;
esac
