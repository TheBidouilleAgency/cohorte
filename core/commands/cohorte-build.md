---
model: sonnet
description: Author the contract from the frozen spec, then dispatch one implementer agent per surface in parallel.
argument-hint: <feature_id> [--readiness-only]
---

You are the **lead**. Build feature **$ARGUMENTS** from its frozen spec.

**Arguments: `<feature_id> [--readiness-only]`.** Strip the flag first — every `$ARGUMENTS` below
means the **bare feature id** (in paths, kanban calls, JSON). `--readiness-only` runs §1 → §2 (checks,
reconcile, readiness verdict, contract) and **stops before §3**: no dispatch, no `build.json`, no
metrics line, no kanban move. It exists to refresh what the loop workflow's preconditions read
(`readiness.json` newer than the spec, the contract on disk) without a full build — the loop then
builds itself. Say which mode you ran in your last line.

> Read `.claude/profile.json` first (the parsed `pipeline-profile` block; absent ⇒ read that block in `PIPELINE.md`): the `surfaces` list (how many implementers to
> dispatch + their agent names), `contract` (mechanism + path), and the `design` flag. _Skip the
> re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (`<core>/pipeline/schema/kanban.md`): once §1 confirms the frozen spec, run
> `<core>/pipeline/scripts/kanban-move.sh auto $ARGUMENTS building`. `auto` resolves the board from the config itself and
> exits 0 with a `kanban: <reason>` line when there is none — so **never decide "no board is
> configured" without running it**. That inference, not a missing board, is what used to freeze
> cards mid-pipeline.

## 1. Load & check

- Check the spec front-matter FIRST — `grep '^status:' specs/$ARGUMENTS.md` (or Read with a ~15-line
  limit) — before any full read. Buildable statuses are `frozen`, `in-review` and `in-progress`
  (`<core>/pipeline/schema/spec-status.md`). `blocked` means a loop round gave up here: say so with the `reason` from
  `specs/reports/$ARGUMENTS.loop.json` (a reason with no `outcome` is a resumable stop — re-running the
  loop workflow resumes it), and route by the spec's `## Remediation` — open items ⇒ `/cohorte-fix`
  (or `--readiness-only`, to hand them back to the loop), none ⇒ continue this build. `shipped` / `merged` / `abandoned` ⇒ done, say so and stop. Anything
  else (`draft`, missing) ⇒ stop and tell the human to run `/cohorte-spec` first. Only then read the body, selectively: front-matter, §5 contract, the surface
  task sections, and `## Remediation` (fall back to a full read if the spec doesn't follow the
  template's headings).
- **Feature branch — when nothing else made it.** With `isolation.enabled`, `new-feature.sh` already
  created `<prefix>$ARGUMENTS` with its worktree: confirm you are in it. With isolation **off**,
  nothing does, yet `/cohorte-ship` refuses any other branch: `git rev-parse --abbrev-ref HEAD`, and
  on `<default_branch>` run `git switch <prefix>$ARGUMENTS 2>/dev/null || git switch -c <prefix>$ARGUMENTS`
  (uncommitted work carries over). `<prefix>` = `vcs.patch_branch_prefix` (else `fix/`) for
  `kind: patch`, `vcs.feature_branch_prefix` otherwise. On some *other* branch ⇒ say which and ask.
- **`kind: refactor` ⇒ stop.** `/cohorte-refactor` already built it; it has no contract to author
  and no implementer to dispatch. Say so and route to `/cohorte-review $ARGUMENTS`.
- **`kind: patch` in the front-matter ⇒ this is a bug fix** frozen by `/cohorte-patch`, and it is
  built by this command like any other spec, with two differences called out where they apply: §1.6
  judges it against its regression test instead of a contract, and §2 authors no contract unless §5
  carries a delta. Everything else — surface mapping, parallel dispatch, roll call, metrics — is
  identical, and `kind` absent means feature, so nothing changes for existing specs.
- **Route check** (skipped under `--readiness-only`, which dispatches nothing — the loop workflow
  then routes those items through its own fix rounds) — if `## Remediation` has open `- [ ]` items and none requires a contract change,
  stop and tell the human to run `/cohorte-fix $ARGUMENTS` instead: it re-dispatches only the surfaces with
  findings. A full build with open items is only right when the contract change ripples into clean
  surfaces (the case `/cohorte-fix` §1 falls back here for).
- **Design gate** — only if `design.enabled` and the feature has UI (some surface `uses_design`): if the
  spec front-matter `design_files` is empty, ask the human for the feature's design **links** and store
  them in `design_files`, then continue. Each entry is a full self-contained link of the form
  `https://claude.ai/design/p/<projectId>?file=<file>` — it carries its own project (the `/p/<projectId>`
  path segment) and page (the `?file=` query), so nothing needs a stored project id and the reference
  survives a design-system rebuild (a new DS ⇒ just paste the new links, no profile change). _Legacy bare
  file names still resolve against the optional `design.design_project` fallback, but new specs use links._
  Skip if the feature is backend-only / no UI.
- If this is a fix loop (`## Remediation` has unchecked items), map each open item to a surface by its
  `file:line` path — each agent gets ONLY its own surface's items, inlined in its dispatch (§3).

## 1.5 Reconcile surfaces — auto-grow / specialize agents

Map every area the spec touches (§5 contract + each surface's tasks + touched paths) onto the
`surfaces[]` in `PIPELINE.md`. Two triggers add an agent — handle them BEFORE authoring the contract:

- **Unowned area → new agent.** If the spec introduces work in a tree that falls under NO existing
  `surfaces[].path` (a genuinely new thing — a new service, a new app, a new top-level area), that work
  has no owner. Auto-detect it and propose a new surface for it.
- **Bottleneck area → specialize.** If one existing surface carries a large, cleanly-separable chunk of
  this feature (e.g. a whole new feature-module) that would dominate build time, propose splitting that
  chunk into its own specialized surface. Use the heuristic in `<core>/pipeline/schema/specialization.md` — only when the
  boundary is clean; skip when tangled or tiny.

For each surface to add: infer its `key`, `path`, `label`, `agent`, `tools`, `model`, `*_cmd`s, and
`uses_design` (mirror a sibling surface), show the human a one-line proposal, and on go-ahead **render it now** per
`<core>/pipeline/schema/rendering.md` — write the `surfaces[]` entry + §Conventions/§Testing
stanza into `PIPELINE.md`, render `<agents>/<agent>.md` from the implementer template, applying the
shared-code rule (shared trees get a single-owner surface; cross-slice shapes go through the contract),
then run `<sync>` — implementers read `<state>/profile.json`, and until it is regenerated it lacks
the new surface.
This is the automatic path: you don't send the human back to `/cohorte-init-pipeline`. If nothing new is needed,
say so and continue. Dispatch (§3) then covers the reconciled surface list.

**Adding or splitting a surface is an architectural decision** — append ONE line for it to
`specs/_decisions.md` §Live (`<core>/pipeline/schema/decisions.md`; create from `<core>/templates/decisions.template.md`
if absent), area `surfaces`, e.g.
`- <date> · surfaces · <key> owns <path>, single owner of <what> — because <the boundary reason> · $ARGUMENTS`.
One `>>` in the Bash call you're already making. Nothing added ⇒ nothing to append.

## 1.6 Readiness verdict — the gate before N dispatches

**Zero extra agents: you already hold the spec, the profile and the reconciled surface list.** The
whole point is that a bancal spec costs one verdict here instead of N implementers discovering it in
parallel. Judge the frozen contract on **implementability only** — never on whether the feature is a
good idea (that was `/cohorte-brainstorm`), never by re-reading files you don't already need:

1. **Contract completeness** (§5) — every endpoint/interface has method+path (or signature), auth,
   request fields with types + validation, the success shape, and its error cases. A missing
   **request or success shape** ⇒ `NOT-READY` (an implementer would invent it, and the other surface
   would invent a different one). A missing **error case** ⇒ `RESERVATIONS`.
   **On a `kind: patch` spec this check is replaced, not skipped** — a patch has no contract to be
   complete, so judge §1 Symptom & repro + §4 Regression test instead: no stated expected behaviour,
   or a §4 that names no test and no reason the fix would be verifiable ⇒ `NOT-READY` (an implementer
   would fix whatever it guessed the bug was, and nothing would catch a wrong guess). A repro
   explicitly frozen as a hypothesis, or a cause left to the implementer to find, is
   `RESERVATIONS` — normal for a patch, never a blocker. Then judge §5 as above **only** if it
   carries a delta rather than `none`.
2. **Surface coverage** — every §6 task maps to a surface in the reconciled list, and every contract
   entry has an owner **on each side it names** (producer and consumer). A contract entry no surface
   owns ⇒ `NOT-READY`.
3. **Dependencies exist** — for the modules, packages, tables, env vars and shared helpers the spec
   names as *pre-existing*: verify them in ONE Bash call (`test -f` / `grep -l` / a package-manifest
   grep, output redirected — never a file read per name). Named as pre-existing but absent, and not
   listed as created by this feature ⇒ `NOT-READY`.
4. **Residual ambiguity** (§10) — an open question a surface would have to *guess* at: blocks a
   contract decision ⇒ `NOT-READY`; merely narrows an implementation choice ⇒ `RESERVATIONS`.
5. **Design gate** — a `uses_design` surface in scope with `design_files` still empty ⇒ `NOT-READY`
   (this is §1's gate restated as a verdict, so an automated driver sees the same fact).

Write the machine-readable verdict to `specs/reports/$ARGUMENTS.readiness.json` (overwrite,
`mkdir -p specs/reports` first — the same gitignored buffer dir `/cohorte-review` stages into, which may not
exist yet on a first build) — on **every** build, including `READY`. It is the only channel between
this gate and any automated driver, which parses no prose:

```json
{ "id": "$ARGUMENTS", "phase": "readiness", "ts": "<ISO>", "verdict": "RESERVATIONS",
  "gaps": ["contract|POST /orders|no 409 case for a duplicate id"],
  "surfaces": ["backend", "frontend"] }
```

- **`gaps`** — one normalized string per gap, `<check>|<where>|<what is missing>`: `<check>` is
  `contract` · `coverage` · `dependency` · `ambiguity` · `design` — plus `repro` on a `kind: patch`
  spec, for a gap check 1 raised against §1/§4; `<where>` is the contract entry,
  surface key or dependency name (no `:line` — it shifts on every edit); `<what>` is the gap, not the
  fix. `READY` ⇒ `[]`.
- **`NOT-READY` ⇒ STOP: author no contract and spawn NO agent.** Print the gaps and send the human to
  `/cohorte-spec $ARGUMENTS` to patch the contract, then re-run `/cohorte-build`. This abort is the whole point of the
  step — a spec that cannot be built does not get cheaper by being built N times in parallel.
- **`RESERVATIONS` ⇒ continue.** It never blocks (a gate that stalls a sound build on a missing error
  case would cost more human round-trips than it saves): inline each gap verbatim into the dispatch of
  the surface it affects, as an explicit assumption the agent must implement *and* flag in its handoff,
  and relay the list to the human in one line each.
- **`READY` ⇒ continue silently** — one line, no restatement.

A `blocked` spec (§1) re-entered here is unblocked by the run itself: once the readiness verdict is
written (and is not `NOT-READY`), set `status: in-review` — the loop workflow and `/cohorte-doctor`
read a `blocked` spec whose readiness is newer than its `loop.json` as "a human re-entered".

## 2. Author the contract (lead-only — the single sync channel)

_Skipped entirely on a `kind: patch` spec whose §5 Contract delta is `none`_ — which is the usual
case: a bug fix corrects behaviour behind a shape that already exists, and re-authoring that shape
would put the contract file in the diff for nothing. Say you skipped it and why, in one line. A patch
whose §5 **does** carry a delta is authored exactly as below, from the delta, against the existing
file — never rewritten from scratch. (A patch needing *new* contract surface area never reaches here:
`/cohorte-patch` §3 routes it to `/cohorte-spec`.) When you skip, still run `<core>/pipeline/scripts/phase-clock.sh start $ARGUMENTS build` on its own —
the skipped postcondition is where §4's wall-clock start comes from, and a build with no start
writes a metrics line with no duration.

_Only if `contract.enabled`._ From §5 of the spec, write/update the feature's contract file at
`<contract.path>/$ARGUMENTS.<contract.ext>` in the profile's `mechanism` (e.g. Zod v4 schemas + inferred
types for `shared-types-zod`). Export it from `contract.index` if set. This is the ONLY file the agents
share; they import it read-only and must not edit it. If `contract.enabled` is false, the spec prose is
the sync channel — say so and skip, but still run `<core>/pipeline/scripts/phase-clock.sh start $ARGUMENTS build` on
its own (same as the patch skip above). **Postcondition (if `contract.enabled`):** check with the Glob
tool that `<contract.path>/$ARGUMENTS.<contract.ext>` exists — the stateless agents have nothing to
build against otherwise — then run `<core>/pipeline/scripts/phase-clock.sh start $ARGUMENTS build`,
alone: it records §4's wall-clock start under `specs/reports/` (one plain command, no approval prompt).

**`--readiness-only` stops here** — print the readiness verdict + contract path and point at
**`/cohorte-loop $ARGUMENTS`** (the loop workflow, `{feature: "$ARGUMENTS"}` — it builds, reviews and
fixes on its own; the recommended next step) or a plain `/cohorte-build $ARGUMENTS`.

## 3. Dispatch one implementer per surface — IN PARALLEL

Spawn every surface's agent in a **single message** (one dispatch each) so they run concurrently —
NEVER serially: build wall-clock must be the slowest surface, not the sum. Use
the reconciled `surfaces` list from §1.5 (existing + any just-rendered). Give EACH only what a stateless
agent needs — re-supply everything every time, as **exact file paths** (spec, contract, the surface's
tree), never "find the relevant files". Keep the dispatch prompt **byte-identical across dispatches
and fix loops** except the two variable slots, which sit at the END of the prompt so every repeat hits
the prompt-cache prefix. Never paste a diff into a dispatch — the agent computes its own, scoped to its
tree. For each surface in `surfaces`:

> `subagent_type: <surface.agent>` — "Implement the **<surface.key>** surface for feature `$ARGUMENTS`.
> Read `.claude/profile.json` first (your surface's commands and flags). Spec: `specs/$ARGUMENTS.md`. Contract: `<contract.path>/$ARGUMENTS.<ext>`
> (import read-only). Work test-first. Touch only `<surface.path>`. Need the current state of your
> tree? Compute it yourself: `<core>/pipeline/scripts/feature-diff.sh --default <default_branch> --patch -- <surface.path>`. Return the handoff in the
> format your agent instructions define. Design files: <the spec's `design_files` links — each
> `https://claude.ai/design/p/<projectId>?file=<file>` carries its own project + page, fetch read-only
> via `DesignSync get_file`, build mobile-first · or `none` (non-design surface, or a fix loop whose
> open items are all non-visual)>. Open Remediation items for YOUR surface (self-contained — fix
> exactly these, reading only the files they name; `none` ⇒ first build, implement the spec's tasks
> for your surface): <the surface's open `- [ ]` lines verbatim, or `none`>. Readiness gaps for YOUR
> surface (§1.6 `RESERVATIONS` — the spec is silent here: implement the stated assumption and flag what
> you assumed in your handoff): <that surface's `gaps` entries verbatim, or `none`>."
>
> **Model routing.** When your own prompt carries a `Model routing:` line (the `cohorte ui` autopilot
> adds one), pass that model as the Agent tool's `model` parameter on every implementer dispatch — the
> dispatch text above stays byte-identical. No such line ⇒ omit the parameter (the agent's own
> `model:` applies).

**While they run, the developer only needs three facts.** If your turn ends while the agents work in
the background, its last message — in the developer's language — says: what is being built, for each
surface in a few user-visible words (not your task list); that **they have nothing to do**, the build
carries on by itself and you come back when every surface has answered; and how long a surface usually
takes when you know it. No pipeline vocabulary ("implementers", "integrate", "handoff", "roll call"):
say "the API side" / "the app side", not "the backend implementer". For example: *"Two agents are
building the feature at the same time: the API side (accounts, sign-in, the dashboard's data) and the
app side (sign-in screen, offline mode, the dashboard screen). Nothing to do on your side — I'll pick
up when both are done, usually within 10 minutes."*

## 3.5 Roll call — account for EVERY dispatch before integrating

A surface's work can die: a rate limit mid-run, a transport error after retries, context exhausted.
When it does, it returns **nothing** — and nothing is byte-identical to "a clean surface with nothing
to report". Silence is not a green light; treat it as the failure it is (`<core>/pipeline/schema/dead-agents.md`).

- **Roll call.** Every surface handled in §3 must come back with a handoff in the format its
  agent instructions define. Missing, empty, or truncated mid-sentence ⇒ that surface is **dead**.
- **Never infer success from silence,** and never speak for a dead agent — you did not see its work.
- **Retry that surface ONCE, alone.** Re-dispatch it with the byte-identical §3 prompt. The other
  surfaces' work is already on disk and untouched, so this costs one agent, not a rebuild — and most
  deaths are transient. Never retry a surface that *did* answer.
- **Died twice ⇒ stop guessing and look.** Run that surface's own quiet commands
  (`<surface>.typecheck_cmd`, `lint_quiet_cmd`, `test_quiet_cmd`) with output redirected to
  `specs/reports/$ARGUMENTS.<key>.deadcheck.txt`, then grep it — never into your context. Report the
  three results plus which of the spec's tasks for that surface actually landed, checked against the
  tree, not against a handoff you never got. Say plainly that the surface is **unverified**.

## 4. Integrate

When all return, flag any contract mismatch or failing test from the handoffs; otherwise print one
status line per surface (`<key> · tests pass/fail · <n> TODOs`) — do not restate handoff content.

**Questions, assumptions, learnings — route them, do not drop them.** In one Bash heredoc, append to
`specs/reports/$ARGUMENTS.notes.md` (create it; one `## <surface> · build` heading per surface) the
handoffs' `Assumptions` and `Learnings` lines verbatim — the human signs the assumptions off at ship
time and `/cohorte-learn` keeps the learnings. Then, if any handoff has **Questions**, ask them all in
ONE **AskUserQuestion** call (at most 4; merge duplicates across surfaces): the implementer's
recommended option first with `(Recommended)` appended to its label, `header` = the question's class.
For every answer that differs from the recommendation, append a Remediation item to the spec
(`- [ ] MEDIUM · <file:line or surface> · decision · apply "<answer>" to <question>`, under a
`### Decisions — build` subheading) so the next `/cohorte-fix` applies it; record each question and its
answer in `notes.md` under `## Decisions`. A run without a human (an autopilot) gets its answers the
same way — the call is answered for you or waits; never skip it.
A dead surface (§3.5) prints `<key> · DEAD — unverified` and **the batch is never reported as ok**.
Append **ONE line for the batch** to the **main checkout's** `<state>/pipeline-metrics.jsonl` (not
the worktree's, which dies at teardown) with one plain command:
`<core>/pipeline/scripts/phase-clock.sh metrics $ARGUMENTS build '{"<key>":"ok|error|dead",…}'` — it
resolves the main checkout, computes the seconds from §2's start and writes
`{"ts":"<ISO date>","feature":"$ARGUMENTS","phase":"build","seconds":<wall-clock>,"surfaces":{…}}`.
— **write this line even when a surface died.** An incomplete batch is exactly the batch worth having
in the record; skipping the append to "wait until it's complete" silently deletes the evidence that
anything went wrong. Then write the machine-readable batch result to
`specs/reports/$ARGUMENTS.build.json` (overwrite, with the Write tool) — the channel an automated driver reads, since it
never sees your chat:
`{"id":"$ARGUMENTS","phase":"build","ts":"<ISO>","surfaces":{"<key>":"ok|error|dead",…},"dead":["<key>",…]}`
— this is the evidence `<core>/pipeline/schema/specialization.md` asks for before splitting a surface.
Then tell the human the next step — **recommended: `/cohorte-loop $ARGUMENTS`**, which runs review →
fix rounds unattended until nothing blocking is left (it reuses this build, it does not rebuild);
or step by step, `/cohorte-review $ARGUMENTS` — and after either ends clean, `/cohorte-verify $ARGUMENTS`
(when the profile has runtime commands — it runs the app and its migrations; until then exercise it
by hand if it's worth it) —
unless a surface is dead, in which case say so first and let them decide whether to re-run `/cohorte-build`
(a dead surface has no findings, so `/cohorte-fix` has nothing to re-dispatch).
Do not run the app or migrations yourself here — building is not running; that is `/cohorte-verify`'s
job, through its script.
**Recommend a `/clear` now** — the spec, contract and diff are all on
disk, and the lead's history is re-sent at input price on every turn it survives.

**Your last message to the developer** — in their language, in plain words: what happened, and
what they need to do (often nothing, or one command). No pipeline jargon (DoD, readiness, contract mechanism, surface, dispatch, handoff…) — those
terms stay in the files you write. If something stopped you (a permission, a missing tool), say in
one plain sentence what they should do about it. A `/clear` tip is one optional sentence, never an
order.
