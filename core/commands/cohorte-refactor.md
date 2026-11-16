---
model: sonnet
description: Apply the refactor backlog for one or more domains via the surface implementer agents (TDD-first, parallel across independent surfaces), re-verify, then freeze a refactor spec for /cohorte-review → /cohorte-ship.
argument-hint: <domain…> (one or more surface keys, "shared", or "all")
---

You are the **lead**. Refactor domain **$ARGUMENTS** to match `PIPELINE.md`, using the `/cohorte-audit` backlog.

> Read `PIPELINE.md` §`surfaces` (map the domain → a surface + its agent + commands), §`contract`
> and §`vcs` (§4's branch).
>
> **Kanban** (`<core>/pipeline/schema/kanban.md`): §4 runs
> `<core>/pipeline/scripts/kanban-move.sh auto <spec id> ready --title "[refactor] <domains>"`. `auto`
> resolves the board from the config itself and exits 0 with a `kanban: <reason>` line when there is
> none — so **never decide "no board is configured" without running it**.
>
> **Workflow variant** (opt-in — `<core>/pipeline/schema/workflows.md`): for BIG domains (many open backlog items
> across several surfaces), on Claude Code ≥ 2.1.154 with workflows enabled, the human can ask to
> "run the refactor workflow" (`<core>/workflows/refactor.js`). For a handful of items this
> conversational path is cheaper — and it stays the default and the fallback.

## 1. Gather

- Read `specs/refactor-backlog.md`; select the **open** (`- [ ]`) items for `$ARGUMENTS` (`all` =
  every domain with open items). A ticked line carrying `· refactor:<id>` is done and in flight in
  that spec — never re-dispatch it.
- Map each domain to a surface. `shared` = the contract package (`contract.path`), owned by you/lead —
  refactor it directly, don't dispatch.

## 2. Dispatch the surface's implementer agent — TDD-first, stateless

Spawn the matching `<surface.agent>` with the template below (as `subagent_type: <surface.agent>`).
Keep it **byte-identical across loop
rounds** (only the final items slot varies — it sits at the end so repeats hit the prompt cache), and
never paste a diff — the agent computes its own, scoped to its tree:

> "Refactor pass on your surface (no feature spec). Read
> `PIPELINE.md` first. **Add the missing tests FIRST** (pin current behavior / cover the entry
> points), watch them pass, **then** refactor to clear each item. Preserve current public behavior
> unless an item marks it a bug. Migrations stay additive. Need the current state of your tree?
> Compute it yourself: `<core>/pipeline/scripts/feature-diff.sh --default <default_branch> --patch -- <surface.path>`. Lint + format before handoff;
> return the handoff in the format your agent instructions define. Backlog items for YOUR surface
> (self-contained — clear exactly these, reading only the files they name): <the domain's open
> `- [ ]` lines verbatim, with exact file paths>."

**Parallel when domains are independent:** if the human passed several domains (or `all`), dispatch
their implementers **concurrently in a single message** — surface trees are disjoint by construction,
so parallel is safe. Exception: `shared` (the contract package) never joins a parallel batch — the
slices import it, so refactor it alone, first.

- **Preserve current public behavior** unless a finding marks it a bug/convention violation — existing
  code has no contract spec, so don't silently change shapes.
- Migrations stay **additive**; never `PIPELINE.md` §`gate.deny` commands.
- Touch only its surface; lint + format before handoff.

## 3. Verify & loop

After each agent returns: its surface's `test_quiet_cmd`/`lint_quiet_cmd` (else the `tail -40`
fallback — `<core>/pipeline/schema/output-discipline.md`), `commands.typecheck`, `commands.format --check` (redirect
output to a file and grep it — don't print gate output into your context). Then verify each backlog item cleared by checking its `file:line` directly — do NOT re-run
`/cohorte-audit` per round (that repeats the repo-wide gates + a review dispatch you don't need); one optional
final `/cohorte-audit` once ALL dispatched domains are clean is enough. Check cleared items off in
`specs/refactor-backlog.md` (`- [ ]` → `- [x]`) as they verify — whatever happens next. Loop until
each dispatched domain is clean. Verification is per-domain even when the dispatch was parallel — one failing surface loops
alone, the others don't redo work.

## 4. Deliver — freeze a `kind: refactor` spec, then review → ship

The round is code in the working tree with no route to a PR: `/cohorte-ship` ships a spec. So once
the gates are green and ≥ 1 item cleared (red gates ⇒ no spec — `/cohorte-review`'s preflight would
abort it anyway), write **one spec for the whole round** — review's diff, the freshness digest and
the release commit all cover the whole tree, so per-domain specs would each claim the others' code.

- **One open refactor spec per branch.** Already on `<feature_branch_prefix>refactor-…` with that
  spec unshipped (`status: frozen`/`in-review`) ⇒ append this round's items to its §6 (new
  `### <domain>` as needed) and skip to linking the ticks — whatever the domains.
- **Id** otherwise `refactor-<domains>-<YYYY-MM-DD>` (`date +%F`): `<domains>` = the cleared domains'
  keys lowercased, every run of non-`[a-z0-9]` turned into `-`, joined by `-` — or `all` past three.
  A spec of that id already shipped ⇒ suffix `-2`, `-3`…
- **Branch** — `/cohorte-ship` refuses any branch but `<vcs.feature_branch_prefix><id>`: on
  `<default_branch>`, `git switch -c <prefix><id>` (uncommitted work carries over); already on it ⇒
  fine; on some other branch ⇒ say which and ask.
- **Write `specs/<id>.md`** — create it, don't ask the human to. No §5: there is no contract, and the
  numbers `/cohorte-review` and `/cohorte-ship` read (§1/§2, §9, `## Remediation`) are kept:

  ```
  ---
  feature_id: <id>
  kind: refactor # behaviour-preserving backlog pass — no contract; commit as refactor(<scope>)
  title: Refactor <domains> — <n> backlog items
  status: frozen
  branch: <feature_branch_prefix><id>
  created: <YYYY-MM-DD>
  reviewed_base:
  reviewed_digest:
  ---
  # Refactor <domains> — <n> backlog items
  ## 1. Goal
  Clear <n> `specs/refactor-backlog.md` items on <domains> with no change of public behaviour.
  ## 2. Scope
  **In:** the §6 items, verbatim. **Out:** any behaviour change; the items §7 lists.
  ## 6. Surface tasks
  ### <domain>
  - <cleared item, `- [ ] ` prefix dropped>
  ## 7. Out of scope
  - <items still open in the backlog for these domains — not claimed by this spec> (or `none`)
  ## 9. Acceptance criteria / DoD
  - [ ] Public behaviour preserved — no exported signature, route, response shape, CLI flag or persisted format changed (unless an item marks it a bug)
  - [ ] Each §6 item cleared at its file:line
  - [ ] All tests green — behaviour pinned by tests added first; no existing test loosened
  - [ ] `PIPELINE.md` commands.lint · typecheck · test green
  - [ ] Nothing outside §6's surfaces changed
  ## Remediation
  ```

- **Link the ticks** — append ` · refactor:<id>` to each line §3 ticked this round, so the backlog
  says where the item went (and `/cohorte-audit` keeps it until that spec merges).
- `grep -q '^kind: refactor' specs/<id>.md` (the postcondition), then the kanban move above, in the
  same Bash call — report what it printed: `moved #…` or `kanban: <reason>`, never a guess.
- **Hand off:** `/cohorte-review <id>` → (`/cohorte-fix <id>` → `/cohorte-review <id>`)* →
  `/cohorte-ship <id>` — **recommend a `/clear` first**. Never `/cohorte-build` it, nor the loop
  workflow: both treat any non-patch spec as contract-bearing.
