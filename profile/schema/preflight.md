## Preflight — the deterministic phase gate

`/cohorte-review` starts by running `pipeline/scripts/preflight.sh` — a plain shell script (no
agent) that executes the profile's mechanical checks in order (typecheck → lint → tests, quiet
variants) with all output redirected to `specs/reports/<id>.preflight.txt`:

- **Any check red** ⇒ the script prints the last 40 lines raw and exits 1. The command **aborts
  there: zero agents are spawned.** A reviewer dispatched onto code that doesn't compile burns its
  whole run rediscovering what `tsc` already printed for free — the failure goes straight to the
  human (or `/cohorte-fix`) instead.
- **All green** ⇒ the script stamps `<state>/preflight.ok` (`<epoch> <HEAD sha> <tree digest>` —
  local and **gitignored**; a versioned stamp describes the tree *before* its own commit and rides
  into every clone and worktree, which breaks the gate both ways).

`hooks/gate.py` enforces the stamp as a **phase gate** (the `preflight` block of `gate-config.json`,
generated from `gate.preflight`): an `Agent` (formerly `Task`) dispatch of a listed `subagent_type` (default
`cohorte-review`) with a missing/stale stamp — older than `max_age_minutes`, or the digest no longer
matches the working tree (`.claude` and `specs` excluded, so the pipeline's own writes and a
commit of already-verified code do not invalidate it) — gets an
"ask", so a lead can't accidentally skip the gate but a human can consciously override it. The gate
hook fires for **every** agent in the session, including subagents spawned by the Workflow runtime
(they run in `acceptEdits` whatever the session mode — Write/Edit auto-approved — but Bash and Agent
still pass through hooks). In `bypassPermissions` (headless runs) every gate "ask" is escalated to a
hard deny, because nobody is there to answer a prompt.
