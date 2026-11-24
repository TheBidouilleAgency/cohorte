---
model: sonnet
description: Apply a REVIEW REPORT — append it to the spec's Remediation, then re-dispatch ONLY the surfaces that have findings.
argument-hint: <feature_id> [paste REVIEW REPORT]
---

You are the **lead**. Run the fix loop for feature **$ARGUMENTS** — the scoped, cheap path after a
`REVISE`/`BLOCK` verdict. The full `/cohorte-spec` (Mode B) + `/cohorte-build` path still exists for review returns
that change the *contract*; `/cohorte-fix` is for everything else.

> Read `.claude/profile.json` first (the parsed `pipeline-profile` block; absent ⇒ read that block in `PIPELINE.md`): `surfaces` (paths + agent names) and `contract`.
> _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (`<core>/pipeline/schema/kanban.md`): once §1 has found a report with real findings to
> apply — never before — run, as its own Bash call, `<core>/pipeline/scripts/kanban-move.sh auto $ARGUMENTS fix`;
> the card returns to **Review** when `/cohorte-review` re-runs. `auto` resolves the board from the
> config itself and exits 0 with a `kanban: <reason>` line when there is none — so **never decide
> "no board is configured" without running it**.
>
> **One plain command per Bash call** throughout — never chain commands with `&&`, `;` or a pipe
> ("note the epoch, move the card and grep the spec" in one call stops on a permission prompt every
> time). Write and edit files with the Write/Edit tools.

## 1. Ingest the report

- The report is either pasted after the feature id (a REVIEW REPORT, or failures the human hit by
  hand), this session's last `/cohorte-review` REVIEW REPORT, or — if the context was cleared — read from
  `specs/reports/<id>.md`, where `/cohorte-review` stages its last report for exactly this reason.
  If you have none of these, ask for it and wait — and move nothing, start nothing: no report, no fix.
- **Lint warnings alone dispatch nobody.** If every finding left to apply is a lint/format warning
  and no CRITICAL or security finding is open (in the report or in the spec's `## Remediation`), do
  not append them to the spec and do not dispatch an implementer: park them in
  `specs/refactor-backlog.md` in `/cohorte-review` §3.5's format (`deferred:$ARGUMENTS`), stop there
  (no clock, no card move, no dispatch), and tell the developer nothing blocking is left. Lint
  warnings that sit next to real findings on a surface simply ride along with that surface's dispatch.
- **Real findings to apply — now start:** run `<core>/pipeline/scripts/phase-clock.sh start $ARGUMENTS fix`
  (it prints the epoch and keeps it in `specs/reports/$ARGUMENTS.fix.start`, inside this checkout —
  never a shared `/tmp` path; script absent ⇒ `date +%s` alone, and keep the number), then the
  kanban move above, each as its own Bash call.
- Append each finding to `specs/<id>.md` **`## Remediation`** (same format as `/cohorte-spec` Mode B, under a
  dated/numbered subheading): `- [ ] <severity> · <file:line> · <type> · <concrete fix>`. Set
  `status: in-review`. Don't pull the whole spec into context for this: grep the line numbers of the
  front-matter `status:` and the `## Remediation` heading, then Read only those regions (offset/limit)
  before editing.
- **Contract check:** if any finding implies the frozen contract must change, update spec §5 and
  re-author the contract file yourself now (lead-only, per `/cohorte-build` §2) — agents never edit it. If
  the contract change ripples into surfaces *without* findings, fall back to full `/cohorte-build` instead
  and say so.

## 2. Scope the re-dispatch — only surfaces with findings

- Map every **open** (`- [ ]`) Remediation item to a surface by matching its `file:line` path against
  `surfaces[].path`. Items already checked `- [x]` (fixed in a prior round) are done — skip them, never
  re-dispatch them. Items outside every surface path (contract file, root config) are yours or go
  to the most relevant surface — say which.
- Re-dispatch **ONLY the surfaces owning ≥1 item**, in parallel, in a **single message** — the exact
  dispatch template from `/cohorte-build` §3 (one byte-stable template for builds and fix loops; you do NOT
  paste a diff — the agent computes its own, scoped to its tree). Fill the template's **Remediation
  slot** with that surface's open `- [ ]` item lines **verbatim**, so the agent needs no spec re-read to
  find its work; fill the design slot with `none` when a `uses_design` surface's open items are all
  non-visual (no DesignSync re-fetch for a type fix), and the readiness-gaps slot with `none` (a fix
  loop has no fresh §1.6 verdict). Surfaces without findings are NOT re-dispatched —
  that is the point.

## 3. Integrate & check off what's fixed

When the agents return:

- **Roll call first (`<core>/pipeline/schema/dead-agents.md`).** A re-dispatched agent that returns nothing has fixed
  nothing you can verify. Retry that surface ONCE with the byte-identical dispatch; still silent ⇒ leave
  **every one of its items `- [ ]`** (a dead agent never ticks a box — that would hide an open finding
  from the next round and from the driver), print `<key> · DEAD — items untouched`, and say the surface
  is unverified.
- **Tick the resolved items.** Each handoff's `## Remediation addressed` lists what that agent fixed
  (by `file:line`). For every Remediation item an agent reports fixed, flip its `- [ ]` → `- [x]` in
  `specs/<id>.md` and append a terse ` — fixed: <what/where>` note (the convention prior rounds already
  use). Leave genuinely-unaddressed items `- [ ]` so the next loop still sees them. This keeps the
  checkbox state honest and stops a later `/cohorte-fix` from re-dispatching already-fixed items (§2). Ticking
  here is the lead's job — surface agents own only their tree, never the spec.
- **Collapse fully-resolved rounds (keep the spec bounded).** When a whole dated Remediation round is now
  entirely `- [x]`, replace its item lines with a single summary line (`- <date> — <N> findings, all
  fixed`) — the audit fact survives, but the per-item bulk stops growing the spec that every agent
  re-reads each loop. Keep any round with ≥1 still-open `- [ ]` item fully expanded (§2's skip logic
  needs those checkboxes).
- **Questions, assumptions, learnings** — exactly as `/cohorte-build` §4: append the handoffs'
  `Assumptions` and `Learnings` to `specs/reports/$ARGUMENTS.notes.md` under `## <surface> · fix <round>`,
  and ask every handoff `Question` in ONE AskUserQuestion call (recommended option first, `header` = its
  class); an answer that differs from what was built becomes a new open Remediation item.
- **Model routing** — the same rule as `/cohorte-build` §3: a `Model routing:` line in your prompt sets
  the Agent tool's `model` parameter on every re-dispatch.
- Print one status line per surface (`<key> · items fixed <n>/<m> · tests pass/fail`) — do not restate
  handoff content — and append ONE metrics line for the batch, **even when a surface died** (an
  incomplete batch is exactly the one worth recording), with one plain command:
  `<core>/pipeline/scripts/phase-clock.sh metrics $ARGUMENTS fix '{"<key>":"ok|error|dead",…}'`
  — one entry per re-dispatched surface. It computes `seconds` from §1's start file and appends
  `{"ts":"<ISO>","feature":"$ARGUMENTS","phase":"fix","seconds":<wall-clock>,"surfaces":{…}}` to the
  **main checkout's** `<state>/pipeline-metrics.jsonl`, from a feature worktree too. Script absent
  (older core) ⇒ append that same line yourself to
  `$(dirname "$(git rev-parse --git-common-dir)")/<state>/pipeline-metrics.jsonl`, never a bare
  relative path.
- Tell the human: re-test by hand if the failures were runtime ones, and `/cohorte-review $ARGUMENTS` for the
  re-verdict — the re-review is what *verifies* the ticked items actually hold (a regression simply
  reappears as a new finding in the next round). To let the review → fix rounds run on their own
  until nothing blocking is left, recommend `/cohorte-loop $ARGUMENTS` instead. **Recommend a
  `/clear`** — all state (spec, checkboxes, staged report) is on disk, and the lead's history is
  re-sent at input price every turn.

**Your last message to the developer** — in their language, in plain words: what happened, and
what they need to do (often nothing, or one command). No pipeline jargon (Remediation, DoD, readiness, preflight, freshness stamp, round, handoff…) — those
terms stay in the files you write. If something stopped you (a permission, a missing tool), say in
one plain sentence what they should do about it. A `/clear` tip is one optional sentence, never an
order.
