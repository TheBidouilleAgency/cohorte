# Changelog

Entries are shown by `/cohorte-update-pipeline` ("What's new") after a core refresh. Keep them
short, user-facing, most recent first. One `## <version> — <YYYY-MM-DD>` section per release.

> Sections below 2.0.0 name commands **as they were at the time** (`/build`, `/drive`, `/loop`).
> They are history and are deliberately not rewritten — every command gained a `cohorte-` prefix
> in 2.0.0.

## 2.10.1 — 2026-09-14

- **Codex project isolation:** surface agents stay in each repository's `.codex/agents/*.toml`
  even with a global core; no `CODEX_HOME` launcher or auth symlink is required.
- **Codex correctness:** init/update/doctor use native TOML agents and MCP settings, preflight
  covers `spawn_agent` dispatches, explicit Codex model choices survive, and implementer
  templates no longer accidentally force a read-only sandbox. Added regression coverage.

## 2.10.0 — 2026-08-24

- **The dashboard is gone.** The local web cockpit — the `cohorte dashboard` verb, the
  dependency-free HTTP server, the Vite/React app and the prebuilt `dashboard/dist` that shipped
  in every tarball — is removed, along with the fleet registry, kanban and usage readers that
  only it consumed. It was a second surface for state the CLI already reports, with its own
  build step, its own security posture (loopback-bound because its action endpoints executed
  code: install, update, reset, and `/cohorte-init-pipeline`·`/cohorte-update-pipeline`·`/cohorte-audit`
  through headless Claude), and its own drift to police. `cohorte doctor`, `cohorte specs` and
  `cohorte metrics` answer the same questions from the shell, and `doctor` exits 1 on any bad
  check, which the browser never could.

  **What did not go with it:** the four modules those verbs actually run on — the JS port of
  `/cohorte-doctor`, the runtime-layout resolver, the version prober and the block-YAML parser —
  moved from `dashboard/server/` to **`lib/`**. `cohorte doctor` / `specs` / `version` behave
  exactly as before, and so do the Francois extension's `--panel` payloads. Their test suite
  moved with them (`scripts/test-dashboard.mjs` ⇒ `scripts/test-lib.mjs`, 54 assertions), minus
  the cases that covered deleted code.

  Fallout worth naming: the package no longer has a build step at all (`prepack` and
  `build:dashboard` are gone, npm and CI no longer build a React app to publish), the tarball
  drops from 88 files to 73, and `~/.claude/cohorte-dashboard.json` — the tracked-project list —
  is now dead; delete it. `--port` / `--host` / `--open` and `COHORTE_DASHBOARD_PORT` /
  `COHORTE_DASHBOARD_HOST` no longer exist; `cohorte dashboard` prints the usage and exits 2.

## 2.9.0 — 2026-08-22

- **`/cohorte-intake` — the door before the doors.** Work has always entered the pipeline
  pre-distilled by a human: a ticket became a `/cohorte-patch` paste, an email became a
  brainstorm idea, by hand. Intake does the distillation: paste anything that arrives and it
  triages — bug ⇒ the exact structure patch interviews for (inferred repro steps labeled as
  such); feature ⇒ a brainstorm seed whose open-questions list is the panel's agenda, with any
  `_decisions.md` line it contradicts named; noise ⇒ says so and stops, because inventing a
  spec from noise costs a whole pipeline run downstream. The distillate lands on disk and on
  the kanban's Ideas column; freezing anything stays the human's move.

- **`/cohorte-retro` — the pipeline learns from its own findings.** Every review leaves
  structured residue (verdict.json, the specs' Remediation history, the deferred backlog) that
  nothing ever read back. Retro mines it for patterns — the same finding kind on the same
  surface across features, a hotspot module, a recurring fix family — and turns each into ONE
  rule-shaped §Conventions line the human ratifies. Adopted rules re-render the affected
  surface agents (the conventions slice is baked at render time — a rule without a re-render
  is one reviewers enforce and implementers never saw) and land in the decisions journal.
  Findings → rules → the next build never produces the finding: cheaper than any number of
  review rounds catching it.

- **`/cohorte-fleet` — parallel features get a flight controller.** The worktree isolation
  existed; the coordination lived in your head. `plan` builds the feature×surface overlap
  matrix from the specs themselves (contract dependencies ⇒ merge order; same-tree writes ⇒
  serialize or drop one), provisions the worktrees, and prints one launch line per feature.
  `status` is one row per feature ending in the single next action. `sync` does the post-merge
  sweep everyone forgets — rebase every survivor, report conflicts verbatim to their owner's
  session, and say out loud that a rebase invalidates the freshness stamp. What it will never
  do is spawn the work headless: that is the retired 2.2.0 driver's grave, and each feature's
  loop keeps running in its own supervised session.

- **`/cohorte-review --pr <num>` — the pipeline reviews incoming work.** Same reviewers, same
  report, none of the pipeline's certifications: the PR is fetched into a throwaway worktree
  (your checkout untouched), reviewed in audit mode (no spec to conform to), and a red
  preflight makes the mechanical failures the review instead of wasting reviewers on code that
  doesn't compile. Posting the report as a PR comment always asks first — it is outward-facing
  — and declining leaves the report on disk as a complete outcome.

- **What a feature costs, finally on the dashboard.** The workflow paths now stamp an
  approximate `tokens` field into their metrics lines from the runtime's own counter
  (`budget.spent()` deltas — the figure a conversational lead cannot read), the loop's history
  carries cost per round, and the dashboard shows `~Nk tok` per feature and per phase. Marks
  are placed around the review child so build/fix deltas never double-count it; token-less
  conversational lines aggregate as absent, never as "free".



## 2.8.0 — 2026-08-22

- **`/cohorte-loop` is back — as a workflow, which is the whole point.** The 2.2.0 driver was
  retired because it spawned headless child processes it could not supervise: it stalled on a
  permission prompt it could not see, read a missing `build.json` as an empty one, and had a
  session killed mid-write with nothing noticing. `core/workflows/loop.js` runs
  build → review → [fix → review]* for one feature inside the Workflow runtime instead — the
  runtime holds control flow, a dead agent resolves to `null` rather than to silence, and there
  is no prompt to stall on.

  What it will not do is as designed as what it does: it *verifies* `/cohorte-build`'s outputs
  (frozen spec, fresh `readiness.json`, the lead-authored contract) as preconditions and aborts —
  naming the gap — on anything that is a human's call: a `NOT-READY` spec, a surface the profile
  doesn't own, a blocking finding on the contract file itself. A dead reviewer's zero findings
  can never read as ship (`unreviewed` is checked before `blocking`, in that order on purpose);
  identical blocking findings two rounds running abort as treading water instead of burning the
  remaining rounds; `maxRounds` (default 5) is the last net, never the first. State is four files
  in `specs/reports/` — re-invoking resumes, and every file older than the spec is treated as
  absent. There is **no** `core/commands/cohorte-loop.md` and `validate-core.mjs` now fails if
  one appears: without the Workflow runtime the loop refuses explicitly rather than degrading to
  a lead re-reasoning the fan-out every round at session prices. It stamps `in-progress` /
  `in-review` / `blocked` on the spec — the driver states SCHEMA.md kept alive since 2.2.0 have
  a producer again.

  To serve it, the review workflow now writes the same `specs/reports/<id>.verdict.json` the
  conversational `/cohorte-review` §3 guarantees (blocking count, normalized `blocking_items`,
  sha256 fingerprint, the degraded `aborted: "preflight"` form) — one machine contract, two
  producers.

- **A deny behind an ask was reachable with one click.** `gate.py` scanned command segments in
  order and returned on the first match, so `git commit -m x && node ace migration:fresh`
  surfaced only the benign `git commit` confirm — and the human's single "yes" ran the
  hard-denied migration behind it. Deny patterns are now matched across the whole chain before
  any ask is offered. Global installs pick this up with `cohorte update`; bundled repos via
  `/cohorte-update-pipeline`.

- **The SHIP stamp is now earned, not implied.** The conversational `/cohorte-review` ticked the
  DoD and wrote the freshness stamp on every SHIP — including one carrying HIGH findings, which
  `/cohorte-ship`'s gates then happily certified, while the workflow variant refused the same
  state. Both paths now agree: tick + stamp only when nothing above LOW survived; surviving
  HIGH/MEDIUM routes to `/cohorte-fix` (or an explicit park) first.

- **A dozen bugs the release audit surfaced**, the sharper ones being: `cohorte install` seeded
  `cohorte.config.yaml` under `~/.claude` even when `CLAUDE_CONFIG_DIR` pointed elsewhere — a
  config no reader ever probed (CI now asserts the seed lands where the readers look);
  the refactor workflow's retry round discarded the items its first verify had already cleared,
  so the backlog re-dispatched finished work — and invoked with a bare `"backend"` it silently
  refactored *every* big domain; the dashboard trusted the absolute paths in a committed
  `runtimes.json`, going all-red on any cloned or moved checkout; `preflight.sh` fed a UTC
  timestamp to a local-time `touch -t`, future-dating the throwaway index west of UTC (and an
  all-empty command list stamped a green preflight that had verified nothing);
  `new-feature.sh` branched worktrees off the *local* default branch its own fetch never
  updated; a CRLF kanban board failed with "column not found" on a column that exists; and a
  dead mechanical-gates agent read as "0 failures" in the audit workflow. Plus a sweep of doc
  drift (the first-feature walkthrough skipped build *and* review; "Node-less" installers that
  require Node; stale counts of agents, scripts and board columns).

- **The shell installers are now the thin delegators they already were.** Since 2.2.0 both
  scripts handed everything to `bin/cli.js` and then carried ~300 lines of unreachable legacy
  copy code below the hand-off — dead text that `validate-core`'s "does the installer copy X"
  checks were vacuously matching, which is worse than no check: it reads as coverage. The dead
  code is gone; the checks now assert CI's install dry-run postconditions — tests against the
  copy that actually runs. Along the way: `sh install.sh` from inside a checkout silently
  *cloned the remote* instead of installing the local tree (`$0` arrives with no slash and the
  self-locate case missed it); both installers now refuse a Node older than 18 up front instead
  of half-installing before `fs.cpSync` crashes; and the review agent's `tools:` names both
  retrieval providers (`mcp__serena`, `mcp__graphify`) — one fixed agent file, shared across
  projects, only the wired provider is live in a session, and graphify projects' reviewers were
  silently cut off from their own index.


## 2.7.0 — 2026-08-22

- **The metrics panel billed Sonnet 5 fifty percent over.** `prices.json` carried $3/$15 because
  that was the rate scheduled to take effect on 2026-09-01. It never will: Anthropic made the
  $2/$10 introductory rate the standard one. Every run costed since the entry was written reads
  high, and the further back a run is, the more confidently wrong the number looks.

  Sonnet 5 is now $2/$10, and the file says in prose why the increase must not be reinstated —
  the next person to "correct" this back will at least have to argue with a comment first. Sonnet
  4.6 and earlier stay at $3/$15: same tier, different price, and the longest-prefix lookup keeps
  them apart on its own.

- **A concurrency ceiling that moved while the comments stood still.** `audit.js` described the
  runtime as capping concurrent agents at "~16". It is 20, it is named
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), and raising it raises the ceiling without changing this
  script — the queue belongs to the runtime, and a queued domain was never a lost one. Comments
  only; no dispatch logic moved.

- **The design brief was the one step the pipeline handed back to you.** `/cohorte-spec` freezes a
  brief to `specs/design/<feature_id>.md` and then said, in effect, paste this somewhere else. With
  `design.inline: true` it can instead hand that file to `/design`, which reads the codebase,
  matches the existing UI style, and returns editable artboards without leaving the session.

  The flag is off by default and degrades rather than fails: an unmet floor falls back to the
  paste-it-yourself path with a note, never an error. It needs `provider: claude-design`, the new
  `inline_design` runtime capability (Claude Code only), and a CLI ≥ 2.1.234 — a **higher floor than
  workflows' 2.1.154**, which is why `/cohorte-doctor` grew a separate check `8b` instead of raising
  the existing one. Raising the shared floor would have made every install between the two versions
  read as broken while its workflows ran fine.

  Understand what inline does and does not change: it changes who does the pasting. The brief is
  still written to disk first and is still what `/cohorte-build` reads — artboards are an aid to the
  human, not an input to the pipeline. And `/design` is a research preview that **does not save them
  for you**, so check 8b says so on every run, including the runs where everything passes. An
  artboard nobody exported dies with the session, and there is no way to notice afterwards.

- This release adds a runtime capability, a profile flag, and a command section: run
  `/cohorte-update-pipeline` after updating.

## 2.6.0 — 2026-08-14

- **Two ways to type the same command, and one of them silently doesn't work.** The docs wrote
  `npx cohorte install`, the Francois extension's manifest names a bare `cohorte` binary, and
  nothing said why the two could not be the same string. They cannot: `npx` fetches a package
  into a cache and runs it once, leaving nothing on `PATH`, and a Francois panel may only spawn
  a **bare binary name resolved on `PATH`**. So the extension's requirement read like a
  preference the rest of the documentation contradicted.

  Every command is now written one way — `cohorte <verb>`, after `npm i -g cohorte` — across the
  README, the docs, both shell installers, the CLI's own banners, the `/cohorte-doctor` fix
  lines, and the `install` string `/cohorte-init-pipeline` writes into a repo's committed
  `pipeline.json`. `npx cohorte@latest <verb>` still works and is still the right call for a
  one-off on a machine you don't own; it is named once, as the escape hatch it is.

- **The cost of pinning, removed before it could bite.** `install` and `update` lay down the core
  carried by the CLI that runs them. `npx cohorte@latest` made that self-correcting; a global
  install does not, so `cohorte update` on a CLI left at an old version would re-lay an old core
  and report success — an update that updates nothing.

  Both verbs now compare themselves against the registry when they finish and print exactly what
  to run (`npm i -g cohorte@latest`) when they are behind. It is never fatal, never blocks a
  successful install, costs a 2.5s fetch with no `npm view` fallback, and stays silent on any
  failure — an offline install pays 2.5 seconds and says nothing. `COHORTE_NO_VERSION_CHECK=1`
  opts out; `CI` opts out already.

  Nothing in the pipeline changed: no new agent, no gate, no template — this release needs no
  `/cohorte-update-pipeline`.

## 2.5.0 — 2026-08-14

- **Everything the pipeline knew about your repo, it would only say to a coding agent.**
  `/cohorte-doctor` reads the health of an install and `specs/*.md` holds the board, but both
  answers cost a session: you opened Claude Code, ran a command, and read prose. There was no
  way to ask "is this repo's pipeline sound?" from a shell script, a CI job, or anything that
  isn't an LLM.

  Two read-only commands now answer without an agent in the loop:

  ```sh
  cohorte specs     # the board: id · status · branch · title, from specs/*.md frontmatter
  cohorte doctor    # the /cohorte-doctor checks — exits 1 when any check is bad
  ```

  `doctor` **exits 1 on any bad check**, so it drops into CI as-is. Both reuse the dashboard's
  own readers, so the board, the dashboard and the CLI can never give three answers about one
  repo. `--porcelain` gives one record per line with `U+001F` between fields — a spec title
  with a space in it never misaligns a column — and `--json` gives the native document.

- **The pipeline, in Francois.** A third shape, `--panel` (on `specs`, `doctor` and `metrics`),
  emits the payload a [Francois](https://github.com/antoine-gmnz/francois) extension panel
  validates against. It exists for
  [**francois-plugin-cohorte**](https://github.com/TheBidouilleAgency/francois-plugin-cohorte):
  a manifest-only extension — no code, no binary — that renders the 30-day cost, the doctor
  report and the spec board as three panels beside your sessions, on any project with a
  `PIPELINE.md`.

  ```sh
  npm i -g cohorte                                   # a Francois extension may only spawn a
  francois ext install TheBidouilleAgency/cohorte    # bare binary on PATH — never npx, never a shell
  ```

  This is the only Francois-aware surface in the package, and it is one flag wide. Nothing in
  the pipeline itself changed: no new agent, no new gate, no template to re-render — this
  release needs no `/cohorte-update-pipeline`.

## 2.4.0 — 2026-08-13

- **The pipeline froze *what* to build, never *how much*.** A spec pins the contract and the
  acceptance criteria, so the feature was right — but nothing ever asked an implementer whether the
  helper it was about to write already existed three files over, whether the stdlib shipped it, or
  whether the abstraction it was wrapping had exactly one caller. The diff came out correct and
  fatter than it needed to be, and every extra line was then paid twice: once at build, once again at
  `/cohorte-review`, whose cost is linear in the diff it reads.

  Implementers now walk a **minimality ladder** before inventing anything: does it need to exist at
  all → already in this repo → stdlib/framework → native platform feature → an already-installed
  dependency → a few inline lines → only then the minimum the contract requires. It governs the
  **how**, never the **what** — a contract field, an acceptance criterion, a test, a validation or an
  authz check is out of its reach, by construction. It is bounded to **one lookup per candidate**, so
  it costs a symbol search and not an exploration, and a shortcut kept on purpose surfaces in the
  handoff's `## TODO / not done` with its ceiling and its upgrade trigger, instead of rotting in a
  comment.

  The `review` agent gains the matching axis — over-engineering, tagged `delete:` / `stdlib:` /
  `native:` / `yagni:` / `shrink:`, always naming the cheaper replacement. It is deliberately the
  weakest thing in the report: **5 findings max, MEDIUM ceiling, never a CRITICAL, never a REVISE,
  never a BLOCK**. A diff whose only findings are `complexity` ships, and they park in the backlog
  like any other nit. Tests, fixtures and anything the contract mandates are out of bounds — coverage
  is not bloat. In audit mode the axis widens to the whole target (10 per domain, biggest cut first,
  closing with `net: -N lines, -M deps possible.`), and `/cohorte-audit` files them under a new
  `complexity` backlog tag: the cheapest wins in the file, since deleting code needs no new test.

  Doctrine adapted from [ponytail](https://github.com/dietrichgebert/ponytail) (MIT) — the decision
  ladder and the finding tags are theirs; the subordination to the frozen contract and the
  can't-block severity ceiling are what make them safe inside a gated pipeline.

  Run `/cohorte-update-pipeline` to re-render your surface agents — the ladder lives in the
  implementer template, so it only reaches your agents through a reconcile.

## 2.3.0 — 2026-08-12

- **A bug fix had to pretend to be a feature.** The only way into the pipeline was
  `/cohorte-spec` — a section-by-section interview whose critical part is a frozen §5 contract, with
  a ~300-line budget. For a `500` on an empty cart that is more work than the fix, so in practice you
  left the pipeline and patched by hand: no frozen intent, no review, no trace.

  `/cohorte-patch` is the bug-fix entry point. A **triage, not an interview** — repro, expected
  behaviour, what must not change — it locates the cause itself and freezes
  `specs/patch-<slug>.md` (`kind: patch`, ~60 lines). The **§4 regression test replaces §5 CONTRACT**
  as the thing the diff is checked against.

  Then nothing downstream is special-cased: a patch spec *is* a spec, so `/cohorte-build` →
  `/cohorte-review` → `/cohorte-fix` → `/cohorte-ship` consume it unchanged, one `/clear` between
  each — four short sessions instead of one thread re-sending its own triage history at input price
  every turn. Only three places read `kind: patch`: build §1.6/§2 (judge the repro + test, author no
  contract when §5 is `none`), the `review` agent (scope creep becomes a first-class finding), and
  ship (branch off `vcs.patch_branch_prefix`, `patch` bump by default, `fix(<scope>)` commit).

  A patch may span **several surfaces** — one bug, one repro, one spec. The single hard escalation:
  a fix needing **new** contract surface area is a feature wearing a bug's clothes, and it is routed
  to `/cohorte-spec` rather than letting two surfaces invent a shape independently.

- **Telemetry is gone — all of it.** The opt-in usage pings that shipped through 2.2.0 are removed
  wholesale: the `telemetry-send.sh` sender, the per-phase pings in the six funnel commands, the
  consent question in `/cohorte-init-pipeline`, the `telemetry:` block in the config template, the
  `/cohorte-doctor` consent check, the collector contract in `SCHEMA.md`. Cohorte now sends nothing,
  anywhere.

  **Upgrading removes what is already on disk.** Copy-over never deletes, so an existing install
  would otherwise keep an executable that still POSTs to the collector — all three installers
  (`install.sh`, `install.ps1`, `npx cohorte`) now scrub it, and CI asserts its absence. And
  `/cohorte-update-pipeline` deletes the leftover `telemetry:` block from
  `~/.claude/cohorte.config.yaml`: nothing reads it any more, and an `enabled: true` left sitting in
  a file you may open reads as though data were still leaving the machine.

  The OpenTelemetry tip (Claude Code's own metrics export, a collector you point at yourself) is
  gone from `SCHEMA.md` §Measuring cost and the token-economy guide too. `/cost` and
  `pipeline-metrics.jsonl` remain — both entirely local.

  `validate-core.mjs` gained a ratchet: any mention of telemetry or a usage ping under
  `core/{commands,agents,templates,workflows}` now fails CI, so it cannot creep back in by copying an
  old command file. The single exemption is `/cohorte-update-pipeline` — the command that *deletes*
  the leftovers has to name them — and it is itself checked for never naming a ping, a sender or a
  consent flow.

- **Kanban:** `/cohorte-patch` with no argument offers the **Ideas** column, `[patch]`-titled cards
  first, and titles its own card `[patch] <title>` (join key `#patch-<slug>`). The `[<kind>]` prefix
  stays a human convention — nothing parses it.

- **Profile:** new optional `vcs.patch_branch_prefix` (default `fix/`); `/cohorte-update-pipeline`
  tops it up, and a profile without it falls back to the same default.

## 2.2.0 — 2026-08-12

- **The pipeline was Claude Code or nothing.** The doctrine — frozen spec, stateless surfaces, a
  gate you cannot talk your way past — is not Claude-specific, but every artefact that carried it
  was: `.claude/commands/*.md` with Claude frontmatter, `Task` dispatches, a PreToolUse hook. A
  Codex or Cursor user could read the ideas and reimplement nothing.

  `core/commands/` and `core/agents/` are now **runtime-neutral sources**, and the installer renders
  them per coding agent — as slash commands, TOML commands, or **Codex skills**
  (`.agents/skills/<name>/SKILL.md`, committed with the repo: custom prompts are deprecated *and*
  user-scoped, so a teammate cloning the repo would have got the profile and none of the commands) —
  for **Claude Code, Codex CLI, Cursor, Gemini CLI, OpenCode**
  (`npx cohorte install --runtime=codex,cursor`, or `--all-runtimes`, or nothing and it detects and
  asks). Rendering rewrites the surface — markdown + the frontmatter keys that runtime understands,
  or TOML for Gemini — resolves every path through the tokens `<core>` / `<state>` / `<agents>` /
  `<config>` / `<memory>`, and swaps the argument placeholder (`$ARGUMENTS`, `{{args}}`, or an
  explicit note where the runtime substitutes nothing, as Cursor does).

  The part that is not cosmetic: the prompts **branch on what the runtime can enforce**, and say so
  in their own text rather than pretending.

  **The gate really runs on four of the five.** `gate.py` is registered as a blocking hook in each
  runtime's own format — `PreToolUse` in `settings.json` (Claude) and `.codex/hooks.json` (Codex),
  `beforeShellExecution` in `.cursor/hooks.json`, `BeforeTool` in `.gemini/settings.json` — and
  emits that runtime's envelope, selected by `--runtime <id>`. A verdict in the wrong shape is read
  as *allow* by every one of them, so each dialect is covered by `scripts/test-gate.mjs` rather than
  trusted. **Codex and Gemini have no confirmation tier**, so an `ask` verdict is escalated to
  `deny` with the reason attached: the point of that tier is that a human sees the command first,
  and a runtime that cannot ask cannot deliver it — the same rule unattended headless runs already
  used. The phase gate also learned Gemini's shape, where a subagent arrives as a tool of its own
  name rather than as `Task` + `subagent_type`. OpenCode extends via plugins, not hooks, so there
  the commands call `gate.py --check` themselves: same verdicts, but advisory, and
  `/cohorte-doctor` says so instead of reporting ✅.

  **Subagents are real everywhere**, in four different file formats — markdown + frontmatter for
  Claude, Cursor, Gemini and OpenCode, TOML with the body under `developer_instructions` for Codex.
  Read-only enforcement for the reviewer is derived from the source agent's tool list and re-emitted
  as each runtime spells it (`readonly: true`, `sandbox_mode = "read-only"`); where there is no
  equivalent, the rendered reviewer carries an explicit instruction that read-only is on it, and
  why. Model pins do **not** travel: the profile names Anthropic aliases, which are meaningless
  elsewhere, so agents inherit the runtime's own model selection.

  **Real subagents are a requirement, not a capability to degrade around.** A sequential-persona
  fallback shipped mid-development and was removed before release: it asked the lead to simulate the
  isolation boundary by discipline — adopt one agent file, do that surface, drop it — which is not
  the same guarantee, and no supported runtime ever took the branch. A runtime declaring
  `subagents: false` is now refused at install with a named error rather than rendered into a
  pipeline whose central promise is silently absent.

- **`/cohorte-loop` is removed, on every runtime including Claude Code.** The autonomous
  build→review→fix driver was the one part of the pipeline tied to a single vendor's headless CLI —
  it spawned `claude -p` children through two shell scripts, a detached `screen` session, a
  `caffeinate` assertion and a resume protocol stamped into spec front-matter. That is a lot of
  surface, on the platform-specific end of the codebase, for a phase the human-driven cycle already
  covers at a cost the loop was mostly there to hide.

  Gone with it: `scripts/loop.sh`, `scripts/loop-detach.sh`, their test suite, and the
  `loop_pass`/`loop_phase` front-matter fields (dropped from the spec template; still *read* by the
  dashboard so a spec left mid-flight by an older core still explains itself). The installer scrubs
  the command and both scripts on upgrade, in every runtime's layout — copy-over never deletes, and
  a surviving command file is a decoy the model can still fire against a core that no longer ships
  its driver.

  **The file contract stays.** `verdict.json`, `readiness.json` and `build.json` are still written
  on every run, and the `in-progress`/`blocked` spec statuses stay valid: they are what anything
  automating the cycle from outside reads and writes. Removing the built-in driver does not remove
  the ability to drive it — it removes cohorte's opinion about how.

  Layout: each runtime gets its own rendered core (`.cohorte/<id>/`), because the same template
  resolves differently per capability — but the **project state is shared** (`.cohorte/`:
  gate-config, preflight stamp, metrics), so a repo driven from two agents cannot disagree with
  itself about what is gated or what has been verified. The user config is shared too; the shipped
  scripts probe `~/.claude` then `~/.cohorte`, so one kanban board and one telemetry consent.

  **Claude Code is unchanged** — same paths, same frontmatter, same hook, and `scripts/test-adapter.mjs`
  asserts that as a regression test alongside the per-runtime output. `install.sh` / `install.ps1`
  now delegate to the Node CLI: there is no shell renderer, and a raw copy would install prompts
  full of unresolved markers that look installed and instruct the model wrongly.

- **A config dir with a space in it broke every tool call in the session.** The gate-hook
  registration quoted the script path only on Windows, so a `CLAUDE_CONFIG_DIR` under
  `~/Library/Application Support/…` — where a desktop host naturally puts it — produced
  `python3 /Users/x/Library/Application Support/…/gate.py`. The shell split that, python reported
  `can't open file '/Users/x/Library/Application'`, and *every* Bash and Task call failed —
  including the ones needed to undo it. Quoted on every platform now, in both the global
  registration and the per-runtime one, with a test that installs into a path containing a space
  and asserts the quoting plus that a re-install still reconciles its own entry instead of
  stacking a second.

- **`CLAUDE_CONFIG_DIR` was only half honoured.** The runtime registry declares Claude's paths as
  `~/.claude`, and the adapter resolved them from the homedir — so with the variable set, the core
  was written to the real `~/.claude` while the hook was registered in the overridden dir. A
  scratch or CI install silently wrote into the user's actual global core. `resolvePaths` now
  takes a re-rooting override, and the test asserts the core, the commands and the hook all land
  in the override with nothing written to the home default.

- **The dashboard reported a healthy non-Claude install as broken.** Every path it checked was
  `.claude/…`, so a repo driven from Cursor came back "no pipeline core installed", "surface with
  no rendered agent", "artifacts not gitignored", "gate.py not registered" — four findings, all
  false. A false red is worse than no check: it sends someone fixing what is not broken. The
  server now resolves paths from `runtimes.json` (`dashboard/server/runtime.js`), reads the gate
  registration in each runtime's own envelope, names artifacts against the right state dir, reads
  the metrics sink from every state dir in play, skips workflows where there is no engine instead
  of reporting them missing, and the reset action backs up every runtime's directory rather than
  leaving the others behind for the fresh install to land beside.

- **`SCHEMA.md` is the agents' rulebook, read at run time — and it still hardcoded `.claude`.**
  It ships to `<core>/pipeline/`, so on a non-Claude install it was telling agents to write
  rendered agents and read the gate config in a directory that runtime never looks at. It and
  `PIPELINE.template.md` now use the same `<core>`/`<state>`/`<agents>`/`<config>` tokens as the
  commands, and the installer resolves their capability conditionals like any other prompt.

- **The preflight stamp could green code that had changed.** Both sides of the content digest seed
  a throwaway git index from the real one, for its stat cache — but the copy is stamped `now`, and
  git trusts an entry's cached stat data whenever the entry predates the index file. A file edited
  in the same second as the preflight, at an unchanged size, therefore read as clean: the gate let
  a `review` dispatch through onto code the preflight never verified. Both `gate.py` and
  `preflight.sh` now backdate the copy by 5 s, which forces a content check for anything touched
  inside that window and leaves the fast path intact for every older file.

## 2.1.0 — 2026-08-09

- **A repo that gates merges on a per-feature release note shipped red PRs, and the flow reported
  success.** Changesets' `changeset` job fails any PR that touches product code without a
  `.changeset/*.md`, but that requirement lives in the project's `CLAUDE.md` — which the ship flow
  never reads. So `/cohorte-ship` committed, pushed, opened the PR and moved the kanban card to
  **Shipped** while the PR was unmergeable, red on a job nobody was watching.

  The profile gains a `release_notes` block (`enabled`, `tool`, `dir`/`filename`,
  `anchor_package`, `language`, `forbid_levels`, `empty_cmd`, `ci_job`, `guidance` — SCHEMA.md
  §Release notes), and `/cohorte-ship` gains **§2b**: the lead writes the note itself, next to the
  `status: shipped` flip, so it lands *inside* the release commit rather than in a second one after
  the PR is already open. The bump level is project policy, not a git ritual — the release agent is
  now explicitly forbidden from authoring or editing a note, and only stages the one it is handed.
  §4 verifies the note is in the commit; §5 routes a red `ci_job` back to §2b instead of through
  `/cohorte-fix`, which would treat a missing note as a code finding.

  Two things the block encodes that the tool itself does not: `forbid_levels`, for the `0.x` repo
  where a `major` changeset silently jumps to `1.0.0` with no human deciding it, and the rule to
  **ask** rather than guess between two defensible levels — a wrong bump is a published version
  number, not a fixable draft. `empty_cmd` covers the honest no-op, for a PR that must move no
  version at all.

- **Existing projects are asked, not defaulted.** `/cohorte-init-pipeline` detects a versioning tool
  or note-enforcing CI job in Phase 1 and asks the anchor package, language and bump policy in Phase
  2; `/cohorte-update-pipeline` treats `release_notes` as a genuine human decision during reconcile
  rather than topping it up blind. No tool found ⇒ `enabled: false`, and §2b is a silent no-op.

## 2.0.2 — 2026-08-08

- **Kanban cards stopped moving mid-pipeline, and every stage still reported success.** The
  stages only *described* the move — "move card `#<id>` → Building, no-op silently if no board" —
  without saying where a board is even declared. Each phase runs in its own session after a
  `/clear`, so the cheapest reading consistent with that instruction is "I see no board, so there
  is none": a `/cohorte-ship` run announced "no kanban board configured", having opened neither
  `~/.claude/cohorte.config.yaml` nor `PIPELINE.md`, and a feature that shipped and merged left
  its card sitting in "Ready to build". Silence was indistinguishable from correctness, so this
  went unnoticed across several features.

  Resolution is not a judgment call, so it is no longer made by a judge. `kanban-move.sh auto <id>
  <stage>` now reads the profile `name`, the config's `kanban.enabled` / `obsidian.vault_path` /
  `boards[name]`, and maps the **stage key** (`ideas` … `shipped`) to that board's heading through
  `boards[name].columns` → `kanban.columns` → a built-in default. Every stage calls exactly that,
  and reports the line it printed: `moved #<id> -> <column>`, or `kanban: <reason>` naming the
  missing link. Both exit 0 and they are not interchangeable. A board that *is* configured but
  unmovable stays loud (exit 2 usage, exit 3 missing board / unknown column). Explicit board paths
  and literal headings still work.

  `validate-core` now fails any funnel command that moves a card without a literal
  `kanban-move.sh auto …` call, or that omits the instruction not to conclude "no board" without
  running it — the prose-only form is what regressed, so the prose-only form is what is banned.
  New `scripts/test-kanban.mjs` (29 checks) pins the resolution table and the move semantics.

- **Renaming a project silently unlinks its board.** `kanban.boards` is keyed by the profile
  `name`, so editing `name:` orphans the old entry and no lookup matches the new one — a genuine
  "not configured", identical from the outside to never having had a board. `/cohorte-doctor`
  gains check **7b**, which reports the resolved board (or the exact missing link) and flags an
  orphaned entry as a rename; `/cohorte-update-pipeline` offers to re-key it instead of creating a
  second board. New `kanban-move.sh --check` does the resolution alone, for both.

- **The gate judged `cd <other repo> && git commit` against the wrong checkout.** Branch-conditional
  patterns resolved the branch at the payload cwd, but the tool's shell keeps no cwd between calls,
  so agents write the `cd` into the command itself. A commit on a feature branch in another repo was
  therefore refused as if it were on the default branch — and the refusal named a branch the command
  was never going to run on, so no confirmation could lift it (in an unattended run, where `ask`
  escalates to `deny`, it was a hard wall). The branch is now resolved per segment at the cwd that
  segment actually runs in, cached so the common case is still one `git` call. Deliberately narrow:
  a plain absolute/relative/quoted `cd`, never `cd -`, `$(…)`, variables or globs — anything
  unresolvable keeps the previous cwd, which is the direction that keeps gating. `cd` never softens
  the unconditional `deny`/`ask` tiers; 10 new cases in `test-gate.mjs` pin all of it.

- **`/cohorte-brainstorm` tags an Ideas card before moving it.** The join key is the `#<id>` tag,
  and an Ideas card a human typed by hand has none — so the move found nothing, created a second
  card, and stranded the original in Ideas. It now appends the tag first, located by `grep -n`,
  never a full board read.

## 2.0.1 — 2026-08-03

Three fixes, one failure: an autonomous `/cohorte-loop` run that built 1 surface of 3, stamped
itself green, and then hung asking a human to approve its own pre-flight. All in `loop.sh` — no
repo files change, so `npx cohorte@latest update --global` (or `update`) is the whole migration.

- **Child sessions now run in `bypassPermissions`, not `acceptEdits`.** `acceptEdits` auto-approves
  Write/Edit and *nothing else*, so the first `Bash` call no `allow` prefix in `settings.json`
  covers raises a permission prompt — and a `claude -p` child has nobody to answer it. It stalls,
  prints prose asking you to approve, and **exits 0**, which the driver scores as a clean phase.
  That is the whole content of one observed run: the review child blocked on invoking
  `preflight.sh` and the loop logged `▶ /cohorte-review … ok`. It is also backwards from what the
  gate is built for — `hooks/gate.py` escalates every `ask` match to a hard **deny** under
  `bypassPermissions` precisely because an unattended run cannot confirm. So the dangerous commands
  from PIPELINE.md `gate` stay blocked deterministically, while typecheck/lint/tests/`git diff` stop
  needing a human. `CLAUDE_FLAGS` still overrides it for a watched run.

- **A build phase that reported nothing is no longer treated as a build that found nothing.** The
  driver checked `dead[]` in `specs/reports/<id>.build.json` but accepted the file being **absent** —
  and a phase cut short never reaches the step that writes it, so there was no file to grep and no
  surface to name while the child still exited 0. A 3-surface build that lost 2 of them mid-write
  stamped `<id>.built` and sent reviewers at the result. A missing `build.json` after a build now
  aborts as **exit 2**, naming the cause, and leaves no stamp so a re-run rebuilds.

- **`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` is exported for every child.** Print mode otherwise
  *terminates* still-running background tasks at its ceiling ("Background tasks still running after
  600s; terminating") — which is 25–40 min short of a real implementer batch, and killed the two
  surfaces above mid-write. The phase is bounded by its own completion (and by the `caffeinate`
  assertion the driver already holds), not by a stopwatch that fires inside the longest phase.

`test-loop.mjs` pins all three, including the fixture bug that hid the second one: its `ready`
build wrote no `build.json` either.

## 2.0.0 — 2026-08-03

> **Breaking: every command is renamed.** `/build` → `/cohorte-build`, `/review` →
> `/cohorte-review`, and so on for all 13. The driver, `/loop` → `/drive` in 1.6.0, is now
> **`/cohorte-loop`**. Re-run `npx cohorte@latest update --global` (or `update`): the update
> **deletes** the 13 unprefixed command files from your install rather than leaving them as
> decoys. Nothing inside your repo needs editing — `/build` in a spec or PIPELINE.md is prose,
> not a call site. Muscle memory is the only migration cost.

- **Every command now carries a `cohorte-` prefix, ending command shadowing for good.** A command
  whose name collides with a Claude Code built-in is not overridden, it is **shadowed**: the
  built-in answers the slash, our file is never read, and the session confidently reports on a run
  that never happened. `/loop` did exactly that and went unnoticed until a user found the driver had
  never started; `/doctor` was sitting on a watchlist waiting to do the same. 1.6.0 renamed one
  name; this replaces the whole approach. `validate-core` now enforces the prefix structurally
  instead of maintaining a blocklist that could only ever forbid the collisions we already knew
  about. Telemetry **phase** names (`build`, `review`, `fix`, …) stay unprefixed — they are a wire
  contract with the collector, and the retired bare command names are kept in the metrics
  collector's retired list so months of existing transcripts stay attributed instead of silently
  reclassifying to `(chat)`.

- **`/cohorte-loop` can now run for hours.** It previously ran the driver as one foreground Bash
  call, which cannot work: a single call is capped at **600 s** and a build is 25–40 min, so it was
  killed mid-`/cohorte-build`. Backgrounding it was worse — a backgrounded Bash call is **not
  detached**, so the driver stayed in the calling session's process group and every Claude Code
  restart, crash or laptop sleep took `loop.sh` and its `claude -p` children down with it, mid-write.
  Observed on a real run: four teardowns in 45 minutes, each aborting both surface implementers and
  leaving a half-built tree that read as `dead`. New `loop-detach.sh` puts the driver in its own
  `screen` session so it outlives the launching process entirely, and `/cohorte-loop` polls a small
  status file in ~9-minute waits. The driver's exit code — which the report table is keyed on —
  survives as `__EXIT__ <code>` in that file.

- **`loop.sh` holds the machine awake for its whole run.** It re-execs itself under
  `caffeinate -ims` on macOS, `systemd-inhibit` on Linux, because system sleep aborts every
  in-flight `claude -p` request and the abort is byte-identical to "the agent returned nothing" —
  the `dead` family the driver exists to catch. The inhibitor is **probed before the `exec`**, since
  `exec` replaces the shell: one that exists but is refused (`systemd-inhibit` answers `Failed to
  inhibit: Access denied` in a container, in CI, or in any seatless session) would otherwise make its
  own failure the driver's exit code and the run would never start — GitHub's Linux runners turned
  all 24 loop tests red exactly that way. Absent or refused both fall through to a no-op; an unheld
  power assertion is a degraded run, not a failed one, and `test-loop.mjs` now pins both directions.
  **This cannot prevent lid-close sleep** — no userspace assertion can on any platform; keep the
  lid open or use clamshell mode.

- **Platform tiers, stated rather than assumed.** Detaching uses `screen` (macOS + Linux), else
  `setsid` (Linux) — both escape the caller's process group, which is what actually matters. Git
  Bash on Windows has neither, so it falls back to `nohup`, which ignores `SIGHUP` but does **not**
  survive a teardown; `loop-detach.sh` prints that warning rather than degrading silently, and
  points at running `loop.sh` from your own terminal instead. See the platform table in
  `docs/reference/scripts.md`.

- **Fixed — the preflight stamp is keyed on the code, not on HEAD, and is never versioned.** The
  stamp recorded the HEAD sha, which is the wrong key in both directions: the reviewed tree is
  normally *dirty*, so committing the very code the preflight verified made the gate ask on a clean
  tree, while an implementer editing files between preflight and dispatch invalidated nothing. Worse,
  `.claude/preflight.ok` was never gitignored — once a release agent staged `.claude/`, the stamp
  went into git describing the tree *before* its own commit, so it could never match again: every
  review dispatch in that repo asked "HEAD moved" forever, and every new clone or worktree inherited
  a green it never earned. The stamp is now `<epoch> <sha> <tree digest>`, where the digest is the
  git tree id of the working tree (`.claude` and `specs` excluded, so the pipeline's own report,
  metrics and DoD writes don't invalidate it), computed in a throwaway index that never touches
  yours. Pre-2.0.0 two-field stamps still fall back to the HEAD comparison. `/cohorte-doctor` check 3
  now fails hard on a tracked stamp, `/cohorte-update-pipeline` untracks it and fixes `.gitignore`
  (§Reconcile step 8), and `test-gate.mjs` pins all of it — including "commit the verified code ⇒
  still green" and "one edit ⇒ red".

- **`/cohorte-review` and `/cohorte-fix` now spell out the metrics path instead of delegating it.**
  Both said "append a line to `pipeline-metrics.jsonl`" and pointed at `/cohorte-build` §4 for where
  that file lives — a lead running from a feature worktree resolves the bare name against its own
  cwd and strands the batch in a sink that dies at teardown. Both now carry the resolved
  `$(dirname "$(git rev-parse --git-common-dir)")` form inline.

- **Fixed — the dashboard's command allowlist had drifted from its own error message.** The
  server accepted the bare `/audit`/`/init-pipeline`/`/update-pipeline` while the UI sent (and the
  error text advertised) the prefixed names, so the run button would have 400'd on the only
  commands that exist. The test suite checked *rejection* only, which is why it passed; it now pins
  both directions.

## 1.6.0 — 2026-08-01

> **Re-run `npx cohorte@latest update --global` (or `update`)** to pick up the readiness gate, the
> deferred-findings route, the resumable driver and the decision journal — the update *deletes* the
> shadowed `/loop` command and the long-dead `/cycle` from your install, it does not just stop
> shipping them. Existing specs keep working: the new front-matter fields are written on demand, and a
> spec without them simply isn't resumable yet. **`/loop <id>` is now `/drive <id>`.**

- **New — the readiness gate between `/spec` and `/build`.** `/build` §1.6 now scores the frozen spec
  on **implementability** before authoring the contract and before dispatching anything: contract
  shapes complete · every area owned by a surface · named dependencies actually exist · no ambiguity a
  surface would have to guess at · design links present. The verdict goes to
  `specs/reports/<id>.readiness.json` (`READY` · `RESERVATIONS` · `NOT-READY` + `gaps[]`).
  **`NOT-READY` stops the build with zero agents spawned** — a spec that can't be built doesn't get
  cheaper by being built on N surfaces in parallel — and sends you to `/spec`. `RESERVATIONS` never
  blocks: each gap is inlined into the affected surface's dispatch as an assumption the implementer
  applies *and* flags in its handoff. It costs **no extra agent**: the lead already holds the spec,
  the profile and the reconciled surface list.
- **New — deferred findings: `/review` stops throwing away what isn't blocking.** The review agent
  now returns a separate `## Deferred` section (max 10) for what is real but **out of this feature's
  scope** — pre-existing code the diff never touched, adjacent debt the spec never claims to fix —
  each line carrying its own out-of-scope reason. Deferred items count in no severity row, move no
  verdict, are never cross-checked, and on **every** verdict get routed into
  `specs/refactor-backlog.md` under the owning surface's `## <domain>` heading, tagged
  `deferred:<id>`. So `/review` feeds `/refactor` for free instead of dropping everything
  non-blocking on the floor. Never into `## Remediation`, which is what `/fix` re-dispatches. Not
  deferrable, ever: anything the diff touched, any spec violation, any security issue on a path this
  feature adds or calls. `/audit` now **carries open `deferred:` items over** when it rewrites the
  backlog. The verdict JSON gains `deferred: <n>` (informational, outside `blocking`).
- **BREAKING — `/loop` is renamed `/drive`, because Claude Code shadowed it.** Claude Code ships its
  own built-in `/loop` (run a prompt on a recurring interval), which won the name: typing
  `/loop <id>` started the *interval runner* with the feature id as its prompt, so cohorte's driver
  never ran — and the session, having never seen `loop.md`, reported a loop that did not exist. Same
  command, same flags, same script (`pipeline/scripts/loop.sh` keeps its name — nothing about your
  install paths changes): type **`/drive <id>`**. The update scrubs the old `commands/loop.md`, so a
  stale shadowed copy can't linger.
- **`/drive` is resumable — the spec's status is the state machine.** The lifecycle is now
  `draft → frozen → in-progress → in-review → shipped` plus `blocked`. Before every phase the driver
  stamps `status: in-progress` + `loop_pass` + `loop_phase` into the spec's front-matter — plain
  `awk`, a temp file and `mv`, **zero tokens** — and on exit a terminal `in-review` (clean) or
  `blocked`. **`/drive <id> --resume`** then continues at the pass it reached instead of re-paying the
  ones already made, whether the session died, the ceiling hit, or the fix stopped converging.
  `--max` stays a ceiling on the *total* passes. New **exit 4** (`not implementable`) relays the
  readiness gate's `NOT-READY`: the one loop outcome more passes cannot fix. The dashboard's specs
  board gains In-progress and Blocked columns and shows `↻ pass 3 · /review` on the card; `/doctor`
  names any spec left mid-loop.
- **Fixed — a dead subagent no longer reads as a clean one on the conversational path.** The
  "a dead agent is never a clean result" doctrine existed since 1.3.4 — but only inside the
  **workflows**. `/build`, `/review` and `/fix` had nothing: a subagent that dies (rate limit,
  transport error, exhausted context) returns *nothing*, and nothing was indistinguishable from
  "finished, nothing to report". Concretely, a dead **reviewer** produced zero findings ⇒
  `blocking: 0` ⇒ verdict `SHIP` ⇒ `/drive` exit 0 ⇒ the human sent to `/ship` — a clean bill of
  health on code no agent ever read. Now every fan-out phase does a **roll call** before integrating:
  a silent surface is retried **once** alone (byte-identical prompt, so recovery costs one agent, not
  a rebuild), then `/build` marks it `dead` and verifies the tree with that surface's own quiet
  commands instead of speaking for the agent, `/review` lists it in the verdict's new `unreviewed[]`
  and **refuses to score `SHIP`**, and `/fix` leaves every one of its items `- [ ]` (a dead agent
  never ticks a box). `/build` also writes `specs/reports/<id>.build.json` with `dead[]`, and
  `loop.sh` aborts on either signal with **exit 2** *before* reading `blocking` — because a dead
  reviewer makes `blocking == 0` a statement about unread code. `unreviewed` is deliberately kept
  out of `blocking`: faking a count there would corrupt the one field the driver contract rests on.
  The metrics line is now written even when a surface died (`"<key>":"dead"`) — an incomplete batch
  is exactly the batch worth recording.
- **Fixed — `/cycle` and its workflow were removed in 1.4.0 but no installer ever scrubbed them.**
  Every install since has kept `commands/cycle.md` + `workflows/cycle.js` on disk, so a dead command
  stayed listed and invokable — dispatching a workflow whose phases 1.5.0 then deleted. All three
  installers now remove them (as they already did for `/smoke`), and CI **plants the orphans before
  re-installing** instead of asserting their absence on a fresh scratch home, which is exactly the
  blind spot that let this survive four releases.
- **Reconcile now tops up `specs/_template.md`.** It was seeded once at install and never refreshed,
  so every repo kept the front-matter its core shipped with. `/update-pipeline` adds the missing
  front-matter fields (never the body — the section list is yours).
- **New — `specs/_decisions.md`, the transverse decision journal.** `PIPELINE.md` is a *stack* profile;
  it says nothing about what the project has **decided**, so every `/spec` re-discovered or
  contradicted the same choices. The journal is deliberately tiny: **append-only, one line per
  decision** (`- <date> · <area> · <decision> — because <reason> · <feature_id>`), reversal by a
  superseding line rather than an edit. Written by `/spec` at freeze (typically 0–3 lines; zero is
  normal) and by `/build` when it adds or splits a surface. Read by the **deciding** stages only —
  `/brainstorm`, `/spec`, `/audit`. **Implementers and reviewers never load it:** they have the frozen
  contract, and shipping them the rationale would cost `surfaces × dispatches` tokens per feature for
  a fact they can't act on. That exclusion is what keeps it cheap enough to be worth having. The `_`
  prefix means `/doctor`, the dashboard scanner and the kanban backfill already skip it.

## 1.5.0 — 2026-08-01

> **Re-run `npx cohorte@latest update --global` (or `update`)** to pick up the collector and the
> `/smoke` removal — the update *deletes* the command and its agent from your install, it does not
> just stop shipping them. The new dashboard panel comes with `npx cohorte dashboard`.

- **New — `/loop <id>`: the review ⇄ fix cycle, run for you.** _(renamed `/drive` in 1.6.0 — see
  there.)_ `/build` → `/review` → `/fix` →
  `/review` … until a review reports **zero blocking findings** (a CRITICAL or a security issue —
  a LOW nit never costs a pass), or the pass ceiling (`--max=N`, default 5), or two consecutive
  reviews returning the *same* blocking findings, which means the fix is treading water and more
  passes won't help. `--no-build` re-runs the loop on an already-built feature; `--rebuild` forces
  a build. Every fix pass is committed (`loop(<id>): fix pass <i>`) — your way back after N
  autonomous passes — and **no fix runs on the last pass**, since fixing without a review behind
  it leaves unaudited code. Exit codes distinguish clean · ceiling · no verdict · non-convergent ·
  usage, so a wrapper can tell "needs more passes" from "needs a human".
- **The loop does not run in your session — that's the whole design.** Each phase is a separate
  `claude -p` child with its own fresh context, driven by the new shipped `loop.sh`; all child
  output goes to `specs/reports/<id>.loop.log`, which the command is forbidden to read back. Your
  session sees one line per phase and a three-line summary. A slash command cannot `/clear` itself,
  so a conversational loop would pile the diff plus N review reports plus N contracts into a
  history re-sent at input price every turn — it would cost more than the loop saves.
  `disable-model-invocation: true`: an autonomous loop only ever starts because you asked.
- **`/review` now writes a machine-readable verdict** to `specs/reports/<id>.verdict.json` on every
  run — verdict, finding counts by severity, per-surface breakdown, the normalized blocking items
  and a stable `fingerprint` over them. It is the only contract between the pipeline and any
  driver; no prose is parsed. `blocking` restates the reviewer's existing rule as a number
  (CRITICAL + security, deduplicated), so `blocking == 0` ⟺ `SHIP`. The fingerprint hashes
  *surface + file + problem* with the line number deliberately dropped — a fix that inserts lines
  would otherwise change it every pass and the drift detection would never fire. A red preflight
  writes a degraded `{"aborted":"preflight"}` verdict rather than nothing, so an abort is a
  diagnosis instead of a silence.
- **BREAKING — `/smoke` and the `smoke` agent are removed.** The end-to-end run phase is gone:
  the command, the agent, its preflight wiring, its telemetry phase and its documentation. The
  loop is now `/brainstorm` → `/spec` → `/build` → `/review` → (`/fix` → `/review`)* → `/ship`,
  with `/clear` safe between each. Nothing else depended on it; a `/smoke` in an old habit will
  report an unknown command.
- **Nothing in the pipeline runs your app any more — that part is yours.** `/build` now closes by
  telling you to exercise the feature by hand if it's worth it, and `/fix` says the same for
  runtime failures. `/review` follows suit at the SHIP verdict: it ticks only what a stage
  actually verified, and **leaves any DoD criterion that needs the app up open** (runtime flows,
  a visual check against the design) unless you say you exercised it yourself and it held.
- **The preflight phase gate now gates `review` alone** (`gate.preflight.agents` defaults to
  `[review]`). Existing profiles that list `smoke` keep working — the hook just never sees that
  dispatch. `/doctor` compares against the new default, so re-run it after the update if it
  flags gate drift.
- **Retired-phase data still renders.** Metrics files and dashboards carrying `phase: "smoke"`
  keep their column, the transcript collector keeps attributing past `/smoke` runs to `/smoke`
  instead of silently reclassifying them, and `telemetry-send.sh` still accepts the phase from a
  stale install. Same treatment `/cycle` got in 1.4.0.
- **The cockpit now shows what a feature actually cost.** The dashboard's only metrics source
  was `pipeline-metrics.jsonl`, written by the model itself — so it misses any run that ended
  early and can never report tokens. On a real project it had captured 18 phase batches where
  the transcripts hold 53 runs. The new **Cost & runtime** panel reads
  `cohorte metrics` instead: per command, the number of runs, $ per run, $ total, tokens, wall
  and active time, and the median number of subagents dispatched. That last column is the one
  that makes a broken run obvious — a `/build` reporting 0 agents did no fan-out at all.
- **Both metrics sources are kept, because they answer different questions.** `pipeline-metrics.jsonl`
  carries per-surface verdicts (`ok`, `REVISE:2`, `error`) that only the model knows and the
  transcripts never contain; the collector carries money and time, which the model cannot report
  and the transcripts record exactly. The two panels sit side by side and each says what it is
  for. Neither replaces the other.
- **Fixed: discussing a command counted as running it.** An inline command mention was treated
  as an invocation regardless of context, so a long message *about* `/review` billed that whole
  conversation to `/review` — in cohorte's own repo it invented five `/cycle` runs out of a
  design discussion. Inline mentions are now length-gated (an instruction is short; a discussion
  is not); an explicit slash-command invocation is always counted.

## 1.4.0 — 2026-08-01

> **Re-run `npx cohorte@latest update --global` (or `update`)** — the workflow fixes only apply
> once the installed core is refreshed. Both the workflow scripts and the `profile-reader` agent
> are replaced by the update.

- **BREAKING — `/cycle` and `cycle.js` are removed.** The full-cycle workflow is gone: the command
  file, the script, its tests and its documentation. The conversational path it wrapped is
  unchanged and remains the way to run a feature — `/build` → `/smoke` → `/review` → `/fix` →
  `/ship`, with `/clear` safe between each. `review.js`, `audit.js` and `refactor.js` are
  untouched. Nothing else in the pipeline depended on it; a `/cycle` in an old habit will simply
  report an unknown command. Metrics files and dashboards that already carry `phase: "cycle"`
  lines keep rendering them.
- **A workflow could dispatch zero agents and still report a verdict.** Phase 0's `profile-reader`
  (haiku) intermittently returned the profile as a JSON *string* nested under a wrapper field
  (`{"output": "{\"surfaces\": …}"}`) instead of at the top level. The schema was
  `{type: 'object', additionalProperties: true}` — no declared properties, no required keys — so
  the wrapper validated cleanly and every field then read as `undefined`: `surfaces` fell back to
  `[]`, `parallel([])` dispatched **nothing**, and because every later guard compares against
  `surfaces`, an empty list made them all vacuously pass. The run finished with a verdict, no code
  written, and no complaint — indistinguishable from a clean run with an empty diff. Fixed in three
  places: `profile-reader.md` now states that the profile's keys go at the top level of the
  structured-output tool (with the wrong shapes shown), the schema declares what it expects, and a
  profile with no surfaces **aborts loudly** instead of proceeding. All three workflows.
- **`args` given as a JSON string became the feature id.** A caller that JSON-encoded its arguments
  got that whole blob used as the id — which is how a report was written to
  `specs/reports/{"feature": "x"}.md` — and the other options (`maxRounds`, `smoke`) silently read
  as `undefined` on the same run, so a run could skip smoke without saying so. `args` is now parsed
  back into an object (a bare slug is still valid shorthand), and a feature id that is not a slug
  throws with an actionable message **before** anything touches the filesystem — so no junk file
  can be written, and a path-shaped id is rejected.
- **`/doctor` warned about a file cohorte itself had written.** `/audit` writes
  `specs/refactor-backlog.md` by design; the spec scanner globbed `specs/*.md` and flagged it for
  having no valid front-matter `status`. It fired in every project that had ever run `/audit`. Both
  the conversational `/doctor` and the dashboard port now exclude it.
- **New: `cohorte metrics` — real cost and runtime per command.** Reconstructs tokens, USD,
  wall/active time and subagent counts from Claude Code's own transcripts, so it needs nothing
  enabled and works retroactively on runs that already happened. It is worktree-aware (a feature
  built across worktrees adds up instead of being dropped), attributes subagent spend back to the
  command that spawned it, and de-duplicates the repeated `usage` blocks a single API response
  writes across several transcript lines — summing those naively inflates tokens ~1.8×.
  `--json`, `--runs`, `--days=N`, `--since=ISO`. Prices live in `scripts/metrics/prices.json`.

## 1.3.4 — 2026-07-31

> **Re-run `npx cohorte@latest update --global` (or `update`)** — the workflow and script
> fixes only apply once the installed core is refreshed.

- **The dashboard server now has tests.** `dashboard/server/*.js` is shipped runtime code — a
  hand-rolled YAML parser every `/doctor` check derives from, the metrics aggregator, the JS port
  of `/doctor`, the board parser, the fleet registry, and the HTTP guards — with no coverage at
  all. `scripts/test-dashboard.mjs` (83 assertions, in CI) pins each module, including every
  `/doctor` check both green and deliberately broken.
- **The gate hook now has tests.** `hooks/gate.py` is the one component that can block a command,
  and CI only ever checked that it *parsed* — every one of its shipped regressions reached users
  first. `scripts/test-gate.mjs` drives its real stdin→stdout contract (42 assertions: deny/ask
  tiers, chained-command splitting, branch-conditional gating at the payload's cwd, the
  `bypassPermissions` ask⇒deny escalation, config robustness, the preflight phase gate, worktree
  HEAD matching) and runs in CI. No new defect was found in the gate itself — the behaviour is
  now pinned.
- **A crashed reviewer scored as a clean surface.** `agent()` returns `null` when a subagent dies,
  and a dead reviewer returns zero findings — byte-identical to a surface with nothing wrong. Both
  `review.js` and `cycle.js` read that as `SHIP`: the review workflow answered "`/ship`" when
  *every* reviewer had crashed, and the cycle workflow exited **SHIP-READY**, ticked the DoD and
  stamped the freshness gate over code nobody had read. Unreviewed surfaces are now named in
  `unreviewedSurfaces` + `questions`, can never score `SHIP`, and the cycle re-reviews instead of
  dispatching an empty fix round. `scripts/test-workflows.mjs` (new, run in CI) pins this.
- **Swept the whole "dead agent read as success" family across all four workflows** — the same
  root cause as the two above, found at eight more call sites by auditing every `agent()` result
  in `cycle.js` · `review.js` · `audit.js` · `refactor.js`. The worst: a dead **diff-staging**
  agent in `review.js` returned `verdict: SHIP` ("no diff — nothing to review") for a feature
  nobody had looked at; and a dead **close/staging** agent let both `/cycle` and the review
  workflow report `SHIP-READY` + a report path + "ship is a straight shot" when the report, the
  DoD ticks, the freshness stamp and the metrics had never been written (and `/ship`'s freshness
  gate skips silently when those fields are absent, so the human would have shipped on it). Also:
  a dead auditor made a domain look **clean** instead of unaudited; a dead backlog writer/reader
  and a dead item-ticker were each reported as success. Every one of these now distinguishes
  "died" from "succeeded with nothing to say", and `scripts/test-workflows.mjs` pins all of them.
- **A dead contract agent was reported as a successful re-authoring.** Same failure shape as the
  crashed reviewer: when the lead-equivalent agent that re-authors spec §5 + the contract file
  died, `/cycle` still pushed a `contractChanges` entry and handed **every** consuming surface a
  CRITICAL "the contract was RE-AUTHORED — re-read it and realign" item, pointing at a file
  nobody had touched. It now reports the contract as UNCHANGED and ripples nothing.
- **A red preflight nobody owns burned every remaining round.** When no surface path appeared in
  the failure tail and no implementer had survived the build, the fix round dispatched *zero*
  agents, the next round found the same red gates, and the loop spun to the cap doing literally
  nothing before reporting a stale verdict. It now stops immediately with the failure tail.
- **Findings belonging to no surface were dropped silently.** A finding whose file sits outside
  every surface tree — reachable when the diff-staging agent names a key the profile lacks —
  stayed in the open set (so the loop could never exit clean) while nobody was ever dispatched to
  fix it. They are now named, with their `file:line`, in `questions`.
- **`/cycle` build telemetry hid dead implementers**: results were mapped over the *survivors*, so
  two of three surfaces reported `ok,ok` and the dead one vanished from the funnel entirely.
- **The review workflow sent HIGH findings straight to `/ship`.** A `SHIP` verdict can legitimately
  carry HIGH/MEDIUM findings (only CRITICAL and security force a fix), but the conversational
  `/review` routes any surviving HIGH to `/fix` — the workflow said `/ship`. It now only recommends
  shipping when nothing above LOW survived, and stamps the freshness gate on that same condition.
- **Smoke is now opt-in in the cycle workflow** — `/cycle <id> smoke` (or `args.smoke: true`).
  Booting the app every round is expensive and a library project has nothing to smoke. Without it
  the run reports `smoke: "SKIPPED"`, leaves the runtime-flow DoD boxes unticked, and says so.
- **The dashboard reset could move the shared global core.** Nothing stopped a project path of
  `~` — reset would then rename `~/.claude` into a backup dir and break every repo on the machine,
  while the UI promised the global core is never touched. It now refuses that path outright.
- **The cycle workflow polluted the metrics with phantom surfaces.** It wrote `rounds` / `verdict` /
  `smoke` inside the metrics line's `surfaces` map, so the dashboard rendered them as three surface
  rows and scored `rounds: "1"` as a failing surface. Run-level facts now sit outside `surfaces`,
  and the dashboard knows the `cycle` phase.
- **Telemetry from bundled installs reported no core version.** `telemetry-send.sh` read `VERSION`
  only from the *global* core; it now resolves the core that ships it. Payloads are also hardened —
  a quote or newline in the results string used to produce JSON the collector dropped.
- **Every kanban card move added a blank line.** Ten moves of one card padded a board with fifteen
  of them, and every phase command moves cards. Runs of blank lines are now collapsed; a board is
  byte-stable across moves. Sub-notes of a duplicate card are no longer duplicated either.
- **Python bytecode could reach the published package and users' `.claude`.** `.npmignore` is inert
  under an explicit `files` allowlist, so its `__pycache__/` rule never fired, and all three
  installers copied the directory verbatim. Excluded at both ends, asserted in CI.
- **Every non-design surface agent rendered with a blank first TDD step.** `<SURFACE_TDD_STEP1>`
  sat as numbered item 1 of the TDD list but is filled only for `uses_design` surfaces, so every
  other agent got an empty "1." above its real first step. It is now a lead-in paragraph.
- Doc/template corrections found by reading the whole core against the code: the spec template's
  `## 6+. Surface tasks` could collide with the `§8`/`§9` sections the pipeline references by
  number; `/init-pipeline` step 04 forgot `smoke.md` in its "leave the fixed agents as-is" list;
  the getting-started page placed `implementer.template.md` in `agents/` (it ships in `pipeline/`);
  the dashboard docs never documented the CSRF/DNS-rebinding guard; `dashboard/README.md` was
  missing `metrics.js`, `/api/metrics` and `/audit`; the two reference-only templates
  (`agent-handoff.md`, `review-feedback.md`) are unreferenced copies of shapes that live in the
  agents — `review-feedback.md` had drifted and is re-synced, and both now say so.
- Smaller: the dashboard no longer stalls for 13 s per project when npm is unreachable (failed
  lookups are cached and de-duplicated); `--port=` rejects a non-numeric value instead of listening
  on a random port; a missing hashed asset 404s instead of being served `index.html`; a project
  card is now keyboard-activatable; long headless logs are trimmed instead of growing unbounded;
  `install.sh --help` exists; the preflight stamp is written once per distinct directory.

## 1.3.3 — 2026-07-30

> **Re-run `npx cohorte@latest update --global` (or `update`)** — the gate fixes only apply once
> the installed `hooks/gate.py` is refreshed.

- **The cycle workflow could exit SHIP-READY with open findings.** A round with only HIGH/MEDIUM
  findings scored `SHIP`, broke the loop, ticked the DoD and stamped the freshness gate — making
  `/ship` a straight shot over unfixed findings, against the workflow's own "zero open findings"
  contract. The exit condition is now literally zero open findings + a smoke PASS.
- **Dead implementers went undetected in the cycle workflow.** `agent()` returns `null` when a
  subagent dies, but the build fan-out wrapped every result in a truthy object before the check —
  so the "implementer(s) died" question never fired and build telemetry always said `ok`.
- **`gate.py` gated worktree commands as if they ran on the default branch.** Branch and HEAD were
  resolved in `CLAUDE_PROJECT_DIR` (the main checkout, usually on `main`) instead of where the
  command actually runs — so in a feature worktree, every `ask_on_default_branch` pattern
  prompted, and the preflight HEAD-moved check compared against the wrong checkout. Git state now
  resolves at the hook payload's `cwd`.
- **The preflight phase gate hung headless runs.** The bypassPermissions "nobody can answer an
  ask ⇒ deny" escalation only covered Bash patterns; a review/smoke Task dispatch with a stale
  stamp still emitted an unanswerable `ask`. The phase gate now escalates the same way.
- **`/init-pipeline` bundled installs registered the gate with the dead `Bash`-only matcher** —
  the exact bug 1.3.2 fixed in the installers lived on in the template — and never dropped an
  existing registration, so a bundled repo later switched to global ran the gate twice per
  command. The template now mandates `Bash|Task` and a reconcile.
- Smaller cycle-workflow fixes: smoke telemetry reports the real failure count (was always 0 —
  it filtered on a `kind` value that doesn't exist); a run whose last round ends on a red
  preflight now flags that the reported findings are from the previous round; a malformed
  preflight stamp says "unreadable" instead of "not found".

## 1.3.2 — 2026-07-30

> **Re-run `npx cohorte@latest update --global` (or `update`).** This release repairs the gate
> hook registration in place — updating is what applies it.

- **1.3.0's preflight phase gate never fired on any install.** `gate.py` gates review/smoke
  dispatches on `tool_name == "Task"`, but all three installers registered the hook with
  `matcher: "Bash"` — a Task call never reached it. The `preflight` block in `gate-config.json`
  and `gate.preflight` in `PIPELINE.md` were both dead config. The matcher is now `Bash|Task`.
- **Re-installing duplicated the hook, every time.** The "already registered?" test was
  `command.endswith("gate.py")`, which is false for the Windows form `py "C:\…\gate.py"` because
  of the trailing quote — so `install.sh` and `bin/cli.js` appended another copy on each run, and
  `gate.py` ran once per copy on every Bash call (four copies seen in the wild). Registration is
  now a **reconcile**: it drops every existing `gate.py` entry and writes exactly one. Idempotent,
  it collapses the duplicates you already have, and it upgrades the stale matcher — an
  append-if-absent would have found the stale entry and skipped, pinning the bug forever.
  Unrelated hooks and every other settings key are untouched.
- **`npx cohorte update` never touched the hook at all**, so neither fix above could have reached
  you through the command you actually run to get fixes — only a full re-install rewrote it.
  `install.sh` and `install.ps1` always registered on update; this port had drifted (the same
  class of drift as 1.2.4 and 1.2.6). It now registers on both paths.
- CI installs **twice** before asserting the hook, via a new `scripts/assert-gate-hook.mjs`:
  exactly one registration, matcher covering both Bash and Task. A single install could never
  surface the duplication — which is precisely why CI stayed green while it shipped.

## 1.3.1 — 2026-07-30

- **`/cycle <feature_id> [max_rounds]`** — a launcher command for the full dev-cycle workflow,
  so you don't have to phrase the request in prose. It resolves `workflows/cycle.js`
  (bundled or global), checks the runtime is available (missing ⇒ it hands you the
  conversational `/build` → `/smoke` → `/review` path instead), sanity-checks the spec is
  frozen, launches the workflow in the background, then relays the verdict: outcome,
  contract re-authorings to eyeball, the `questions` array verbatim, and the next step
  (`/ship` on SHIP-READY, rerun `/cycle` or `/fix` otherwise). Kanban card moves included.

## 1.3.0 — 2026-07-30

**Token economy — immediate wins, no workflow needed:**

- **Deterministic pre-flight before `/review` and `/smoke`.** A shipped script
  (`pipeline/scripts/preflight.sh`) runs typecheck + lint + tests first; red ⇒ the command
  aborts with the raw last-40 lines and **spawns zero agents** — a reviewer no longer burns
  its whole run rediscovering what `tsc` printed for free. Green runs stamp
  `.claude/preflight.ok`, and `gate.py` enforces it as a **phase gate**: a review/smoke
  dispatch with a missing/stale stamp gets a confirm (`gate.preflight` in the profile).
- **Quiet commands.** New profile fields (`test_quiet_cmd`/`lint_quiet_cmd` per surface,
  `commands.test_quiet`/`lint_quiet` repo-wide) hold the bridled forms agents actually run
  (`--reporter=dot`, `--quiet`, failures-only); absent ⇒ `<cmd> 2>&1 | tail -40`.
  `/init-pipeline` now asks for them instead of storing a bare `pnpm test`;
  `/update-pipeline` tops up older profiles.
- **`/review` computes the diff once.** One `git diff --stat`, then full patches staged to
  disk only for the touched surfaces — reviewers read the artifact instead of each
  re-running git.
- **Conventions baked into rendered agents.** The implementer template gets a
  `<SURFACE_CONVENTIONS>` slice rendered at init; at runtime agents read only the profile's
  machine block. Edit conventions in `PIPELINE.md`, then `/update-pipeline` re-renders.
- **Capped reports.** Review reports: max 20 findings, one line each, zero code excerpts;
  smoke returns: max 10 ❌ lines. Dispatch prompts now keep every volatile slot (feature id,
  paths, file lists) at the END so repeats hit the prompt-cache prefix.
- `gate.py` also escalates every `ask` to a hard deny in unattended runs
  (`bypassPermissions`) — nobody is there to answer a prompt.

**Workflows (opt-in — conversational commands stay the default and the fallback):**

- Four deterministic multi-agent scripts for the Claude Code Workflow runtime
  (≥ 2.1.154, workflows enabled): **`workflows/cycle.js` — the full dev cycle on a frozen
  spec** (contract → parallel build → smoke ∥ review(+cross-check) → fix, looping until
  zero findings + PASS; contract changes handled in-loop by a lead-equivalent agent, human
  decisions returned in a `questions` array at the end; a clean exit ticks the DoD and
  stamps the freshness gate so `/ship` follows directly), `workflows/review.js` (preflight
  gate → one reviewer per touched surface → adversarial cross-check of CRITICAL/security
  findings → verdict only), `workflows/audit.js` (one auditor per domain, concurrent,
  prioritized backlog), `workflows/refactor.js` (big domains only: shared first, parallel
  implementers, per-domain verify + one retry). Mechanical phases route to haiku.
- New `profile-reader` agent (haiku) — phase 0 of every workflow: returns the
  `PIPELINE.md` machine block as JSON, since workflow scripts have no filesystem access.
- `/doctor` check 8 reports the workflow prerequisites and which path a session will take;
  the generated `settings.json` allow-list now covers what workflow agents need (quiet
  commands, shipped scripts, `git rev-parse`, retrieval MCP tools) so runs don't stall on
  prompts nobody is watching.
- Installers (npx CLI, install.sh, install.ps1) ship `core/workflows/` + `preflight.sh` +
  the `profile-reader` agent in both global and bundled modes; CI dry-runs assert it.
- Dashboard: new headless **Audit** action (`claude -p "/audit"` — starts without a prompt,
  no resume if the session dies) and the workflows state in the project drill-down.

## 1.2.6 — 2026-07-30

- **`npx cohorte install` never installed the `smoke` agent.** It copied only `review.md` and
  `release.md`, so `/smoke` was there but the agent it dispatches was not — the run failed
  saying `/smoke` is not installed. The shell installers always copied it; only the npm port
  drifted. It now copies every non-template agent in `core/agents/`, so nothing to keep in sync.
  Fix an affected install by re-running `npx cohorte install --global` (or `install --repo`).

## 1.2.5 — 2026-07-29

- **`.claude/pipeline.json`'s `core_version` never updated on global installs.** The installer
  bumps it in bundled mode, but a global core is shared — it cannot know which repos point at
  it, so nothing bumped the field and it drifted forever. Repos running a current core were
  still claiming `1.0.0`. `/update-pipeline` now syncs the pointer in both modes.
- `/doctor` no longer reports that drift as a broken install: a global-mode pointer lagging the
  VERSION file is ⚠️ with the one-command fix, not ❌. The core was never the problem.

## 1.2.4 — 2026-07-29

> **If you installed with `npx cohorte`, this is the release that makes 1.2.3 actually
> reach you.** Re-run `npx cohorte@latest update --global` (or `update` for a bundled core).

- **`npx cohorte install/update` shipped a core missing two scripts.** `bin/cli.js` — the
  port of `install.sh` that `npx` actually runs — copied only `scripts/*.template`, never
  `kanban-move.sh` or `telemetry-send.sh`. Since every caller chains them with `|| true`,
  the result was silent on every npx-installed machine: no kanban card moves, no telemetry
  pings, no error anywhere. The shell installers named both files explicitly and this port
  drifted from them. It now copies by a rule that needs no list to keep in sync.
- The same port never copied `CHANGELOG.md` into the core either, so `/doctor` and
  `/update-pipeline`'s "What's new" had nothing to read on npx installs. Fixed.
- CI now dry-runs `bin/cli.js` into a scratch dir and asserts the same postconditions as
  the `install.sh` dry-run. 1.2.3's guard only grepped the two shell installers — it would
  have passed this bug, because the port copies by rule rather than by name.

## 1.2.3 — 2026-07-29

- **Telemetry now covers the whole funnel.** Only `/build` was actually pinging; `/smoke`,
  `/review` and `/fix` wrote their metrics line but never sent one, so consenting installs
  reported a quarter of their pipeline. Those three are fixed, and `/brainstorm`, `/spec`
  (on a landed freeze) and `/ship` join them — the seven stages of `idea → PR` now report,
  so it's finally possible to see *where* features stall. Setup and maintenance commands
  (`/doctor`, `/init-pipeline`, `/update-pipeline`, `/audit`, `/refactor`, `/align-ds`)
  deliberately never ping: the collected set stays inside what the consent text describes.
  Same data categories as before, same purpose — nothing new about you is sent, so your
  existing consent stands and nothing re-asks. The full table is in SCHEMA.md §Telemetry.
- `telemetry-send.sh` now allowlists the phase name client-side — a typo in a command file
  used to sail through and land a phantom phase in the dataset.
- `/fix` never defined a wall-clock start, so the `seconds` in its metrics line was
  undefined. It now notes the epoch like `/build` and `/review` do.
- **`/doctor` catches a half-copied core.** New check: `pipeline/scripts/` must hold every
  shipped script, and `VERSION` must not be newer than its siblings. Callers chain these
  scripts with `|| true`, so a missing one was invisible — no kanban move, no telemetry
  ping, no error. If you saw either go quiet, this is why: re-run the installer.
- CI now fails if an installer forgets to copy a `scripts/*.sh`, and the dry-run install
  asserts the scripts land executable — the root cause above, caught before release
  rather than on someone's machine.
- The npm tarball no longer ships `scripts/new-feature.sh` + `scripts/remove-feature.sh`
  — cohorte's *own* rendered isolation scripts, with this repo's ports and paths baked
  in. They claimed in their header to be excluded but never were (an explicit `files`
  whitelist wins over `.npmignore`). Only the `*.sh.template` files ship, as intended.
- Fixed `validate-core.mjs` crashing on Windows (`C:\C:\…` path), so the guard above
  actually runs locally too.

## 1.2.2 — 2026-07-29

- The reference collector moved to its own (private) deployment repo; the public repo keeps
  the collector API contract in SCHEMA.md §Telemetry. No behavior change for users.

## 1.2.1 — 2026-07-29

- Telemetry collector URL shipped as the config-template default
  (`https://telemetry.cohorte.thebidouille.fr/v1/events`) — consenting installs start
  reporting once the collector is live. Still strictly opt-in; nothing changes for anyone
  who declined (or never answered) the consent question.

## 1.2.0 — 2026-07-29

> **Opt-in anonymous telemetry, GDPR-first.** Nothing is sent unless you explicitly say yes.

- `/init-pipeline` (and `/update-pipeline` on existing installs) ask ONE consent question, once per
  machine, default **No** — both answers are recorded in `~/.claude/cohorte.config.yaml` §`telemetry`
  so you're never re-asked.
- When enabled, each pipeline phase fires a ~200-byte ping (fire-and-forget, 2s timeout, never
  blocks): core version, OS, phase, duration, per-surface result counts, and a **hash** of the
  feature id. Never sent: repo names, paths, code, spec content, IPs.
- Withdraw anytime (`telemetry.enabled: false`); erase your history anytime (`/doctor` prints your
  `install_id`; `DELETE /v1/install/<id>` on the collector drops it). Full spec: SCHEMA.md
  §Telemetry; privacy summary in the README.
- Ships a zero-dependency reference collector (`telemetry/collector.mjs` — NDJSON storage, strict
  field allowlist, erasure endpoint, stores no IPs) to self-host.
- `/doctor` reports telemetry consent state and flags incoherent configs (enabled without a
  recorded consent).
- Note: the shipped default `endpoint` is empty — telemetry stays dormant even for consenting
  installs until a collector URL ships in the config template.

## 1.1.1 — 2026-07-29

- **Fix: pipeline metrics survive worktree teardown.** With `isolation.enabled` the lead session
  runs inside the feature worktree, so metrics lines landed in the worktree's `.claude/` and were
  deleted with it — defeating their purpose (cross-feature evidence for surface splits, dashboard
  history). All phases now append to the **main checkout's** `.claude/pipeline-metrics.jsonl`,
  resolved from anywhere via `git rev-parse --git-common-dir`; `/doctor` flags a stray metrics file
  inside a worktree as a stale-core sign.

## 1.1.0 — 2026-07-29

> **The token-economy release.** A full audit of the core (40 verified fixes) cuts the pipeline's
> consumption by an estimated 40–60% per feature, and the pipeline no longer inherits your session's
> model for orchestration. Plus: pipeline metrics in the dashboard, CI on the core, and a documented
> parallel-features workflow.

- **Byte-stable dispatches.** One dispatch template for builds AND fix loops; variable parts
  (design links, open Remediation items inlined verbatim) sit at the end so repeats hit the prompt
  cache. The lead never pastes a diff — agents compute their own, scoped to their tree. On fix
  loops, implementers no longer re-read the spec at all.
- **Reviewers read hunks, not whole files.** `/review` stages each surface's diff to
  `specs/reports/<id>.<key>.diff`; tiny re-reviews skip the dispatch entirely (fast path); the
  merged report is staged to disk with only a verdict summary printed; LOW-only findings defer to
  the refactor backlog instead of forcing a fix cycle.
- **`/smoke` is now an agent.** A new pinned `smoke` agent runs infra/curl/UI checks so logs,
  response bodies, and screenshots never enter (and re-bill in) your session's history.
- **Model pins everywhere.** The `review` agent and the 10 mechanical commands
  (build/review/fix/smoke/ship/audit/refactor/doctor/align-ds/update-pipeline) are pinned
  `model: sonnet` — orchestration runs on Sonnet even if your session runs Opus/Fable. `/doctor`
  checks agent AND command pins; the profile template's frontend example no longer suggests
  `inherit`.
- **Leaner outputs.** Handoff + review-report formats are inlined in the agent bodies (no template
  probe), templates de-boilerplated, the design brief is authored once to `specs/design/<id>.md`,
  metrics collapsed to one JSONL line per phase, and every command's closing now *recommends*
  `/clear` (all state is on disk by design).
- **Pipeline metrics in the dashboard.** New per-project panel: wall-clock per phase, fix rounds,
  and per-surface results from `.claude/pipeline-metrics.jsonl` — see which phase/surface dominates
  before tuning anything.
- **`kanban-move.sh`.** Card moves (move/create/dedupe/`--pr`) now run as a script outside the
  agent's context; installed to `<core>/pipeline/scripts/`, with the manual grep-based op as
  fallback.
- **Spec size budget.** `/spec` targets ≤~300 lines and proposes a feature split beyond that —
  every spec line is paid `surfaces × dispatches` times.
- **Parallel features documented.** README: one session per feature, worktree isolation as the
  safety mechanism, ship-then-rebase rule; `/doctor` prints the live slot table when ≥2 features
  run in parallel.
- **CI on the core.** `scripts/validate-core.mjs` + GitHub Actions: frontmatter/pin invariants,
  render placeholders, cross-references, installer coverage (would have caught the smoke-agent
  install gap this release also fixes), plus an end-to-end install dry-run.

## 1.0.0 — 2026-07-28

> **Renamed `thebidouille-agents` → `cohorte`** and cut the first stable release. The npm package,
> the CLI (`npx cohorte …`), the repo, and the user config file are all renamed. The pre-rename
> `~/.claude/thebidouille.config.yaml` and `~/.claude/thebidouille-dashboard.json` are still read as a
> fallback, so existing installs keep working — `/update-pipeline` migrates them forward on next run.

- **Repo moved to the `TheBidouilleAgency` org** (`github.com/TheBidouilleAgency/cohorte`), with a
  proper logo/brand kit under `assets/` and a dashboard favicon set.

- **The research + questionnaire capability was removed from the core.** `/research`,
  `/questionnaire`, their agents, templates and step files are extracted to a separate private repo
  and will return later as an installable Cohorte **plugin**. `update` scrubs the now-orphaned files
  from existing installs. The global config keeps only the shared Obsidian vault + the kanban mirror;
  the `research:`/`questionnaire:` config keys are gone.

- **`/ship` now reliably moves the kanban card to Shipped and writes the PR number.** The
  move-to-Shipped was a parenthetical in the command header, easy to skip — so shipped features could
  leave their card stuck in an earlier column. It is now an explicit, verify-after step (§4): move
  card `#<id>` → `shipped` **and append `PR #<num>`** (from the PR URL), then re-read the board to
  confirm. The bare `#<num>` is what the dashboard renders as a clickable PR link. SCHEMA.md §Kanban
  documents the shipped-card format. (`/ship` also moves the card → `ship` on confirm, in §1.)

- **Branch-aware gate — git + docker run freely on feature branches, gated only on the default
  branch.** The `gate` block gains two keys: `ask_on_default_branch` (patterns confirmed *only* when
  the checked-out branch is `default_branch`) and `default_branch` (default `main`). `gate.py`
  resolves the current branch at run time (`git rev-parse`); an unknown branch (no repo / detached)
  is treated conservatively as gated. The default profile moves git (commit/push/merge/rebase/reset)
  and `docker compose` into this tier, so agents move fast on feature branches while `main` stays
  protected; DB commands (`migration:run`, `db:`, `psql`) remain always-`ask`, destructive migrations
  always-`deny`. Existing gate-configs without the new keys keep working unchanged. Re-run
  `/update-pipeline` to regenerate `gate-config.json` with the new tier.

- **New `dashboard` subcommand — a local web cockpit for the pipeline.** Run
  `npx cohorte dashboard` to open a browser view of pipeline state: a **Fleet**
  overview (global core version vs npm latest + every tracked project's freshness and health
  at a glance), a per-project drill-down that renders `/doctor` as a live checklist, the
  **Surfaces ↔ agents** map from `PIPELINE.md`, and a **Specs board** (kanban by
  `draft·frozen·in-review·shipped`). Install/update actions run the CLI and stream their output
  live. Add projects by path — the set is remembered in `~/.claude/cohorte-dashboard.json`.
  The runtime is dependency-free (node's built-in `http` serves a prebuilt React app); the
  `/doctor` checks are reimplemented in JS so they run without a Claude session. Point it at any
  pipeline-ised repo, or at nothing (it seeds the launch directory). A **folder picker** browses
  the filesystem to add projects (dirs with a `PIPELINE.md` are flagged), and a **Reset pipeline**
  action wipes a project's entire pipeline footprint (`.claude/`, `PIPELINE.md`, optionally
  `specs/`) — backed up first to `.claude.bak-<ts>/`, the shared `~/.claude` core untouched — so a
  project riddled with old-version relics can be brought back to a clean, pipeline-managed state
  (then `/init-pipeline` regenerates the profile). **Init-pipeline / Update-pipeline** buttons run
  those Claude Code commands headless (`claude -p … --dangerously-skip-permissions`) in the project
  and stream the output. The server **binds `127.0.0.1` by default** (its actions execute code);
  `--host=ADDR` exposes it with a printed security warning, `--open` launches the browser.
  Projects with a linked **Obsidian Kanban board** (config `kanban.boards`) get it rendered inline —
  columns + cards read straight from the vault markdown (local, no token; Notion is not a kanban
  source in this pipeline, only /research archival). PR references become clickable links, enriched
  with **live PR status** (open/merged/closed/draft) + date via the user's `gh` CLI (cached 60s), and
  the **Shipped** column is sorted by ship date. Cards missing an explicit `#<num>` have their PR
  **inferred from the branch** (`…/<feature_id>`), so historical boards light up too.

## 0.1.27 — 2026-07-28

- **README gains a Prerequisites section.** Spells out what a new machine actually needs: Node ≥ 18 + npm
  (the only hard requirement, for the `npx` installer) versus `uv` + the Serena CLI (optional, the default
  retrieval provider — installed separately, independent of the `npx` core install, order irrelevant, and
  the pipeline still runs without it by falling back to Grep/Read). Also documents the cloned-repo case
  (Serena registration travels in the committed `.mcp.json`; just install the CLI + restart + `/doctor`).
  The mechanics were already in `SCHEMA.md` §Code retrieval, but not in the human-facing onboarding doc.

## 0.1.26 — 2026-07-28

- **The design step now references designs by full link, not a stored project id + bare filename.** A
  `design_files` entry is a self-contained `https://claude.ai/design/p/<projectId>?file=<file>` link that
  carries its own project (`/p/<projectId>`) and page (`?file=`); agents extract both and read it via
  `DesignSync get_file(<projectId>, <file>)`. No stored `design_project` id means a design-system rebuild
  (which mints a new project id) no longer breaks every spec — you just paste the new links. `design_project`
  becomes an optional legacy fallback (default `none`) for old bare-filename specs. Updated across `/build`
  (design gate + dispatch), `/smoke`, `/spec` + the spec template, `PIPELINE.md` (§design + conventions),
  `SCHEMA.md`, and `/doctor`. Crucially, the surface-agent render step now specifies the link-based
  `<SURFACE_DESIGN_INPUT>`/`<SURFACE_TDD_STEP1>` — so `/update-pipeline` re-renders design agents to resolve
  from the link instead of the stale `get_file(design_project, <file>)`. Existing specs keep their bare
  filenames until you replace them with links.

## 0.1.25 — 2026-07-27

- **`research-agent` defaults to `sonnet`** instead of silently inheriting the session model (Opus). Its
  work — MAP / ANALYSE / SYNTHESISE of pre-extracted text — is extraction-and-summary that Sonnet handles
  well at a fraction of the cost, and `/cost` showed it was one of the two heaviest subagents. The fixed
  agents were never tiered like the surfaces; this closes the biggest gap. If cross-cutting synthesis ever
  needs more, the `/research` SYNTHESISE dispatch can override the model for just that pass.
- **README documents the `/clear`-safe loop** as the top token lever — since all pipeline state lives on
  disk, `/clear`-ing between stages sheds the accumulated main-thread context (long >150k sessions are
  expensive even cached), with the safe-to-clear boundary shown for the whole `/spec → … → /ship` loop.

## 0.1.24 — 2026-07-27

- **The dev loop is now `/clear`-safe between every stage.** All pipeline state already lives on disk
  (spec, contract, diff, Remediation checkboxes, freshness stamp), so you can `/clear` between commands
  to shed the accumulated main-thread context and cut token cost — each command reloads everything from
  disk. Every command now marks its handoff as safe to `/clear` before the next step.
- **`/review` and `/smoke` stage their report to `specs/reports/<id>.md`** (a gitignored buffer in its own
  subfolder, like `specs/design/`) — the one context-coupling that a `/clear` used to break. `/fix` and
  `/spec` Mode B read the report back from disk when the context was cleared. `/init-pipeline` gitignores
  the buffer; `/doctor` reports it. The non-recursive `specs/*.md` glob skips the subfolder, so it never
  shows up as a phantom kanban card or spec.

## 0.1.23 — 2026-07-26

- **Cheaper dev loop by default — implementers now default to `sonnet`, not the Opus lead.** A surface
  agent mostly applies a frozen contract, which Sonnet handles well at a fraction of the cost;
  `/init-pipeline` and reconcile now default `surfaces[].model` to `sonnet`, keeping `haiku` for purely
  mechanical scaffolding and `inherit` only for surfaces with real design decisions. The fixed `release`
  and `questionnaire-validator` agents drop to `haiku`, `questionnaire-writer` to `sonnet`. Existing
  projects pick this up on the next `/update-pipeline` (agents re-render; a `model` you set by hand is kept).
- **Stateless agents read a *slice* of `PIPELINE.md`, not the whole file.** The implementer and reviewer
  now load the machine block + only the `### Shared` and their own `### Surface:` convention stanza
  (+ §Testing), never the other surfaces' prose — less context re-read on every parallel dispatch.
- **Leaner fix loops.** On a `/fix` re-dispatch, a surface agent works from the self-contained open
  Remediation items + the diff and reads only the files those findings name — no longer re-reading the
  whole (growing) spec or re-exploring its tree.
- **Freshness gate at `/ship`.** `/review` now fingerprints the reviewed source (`reviewed_base` +
  `reviewed_digest` in the spec front-matter) at a SHIP verdict, and `/ship` re-checks it — refusing to
  ship if any source or contract file changed after the review, so a verdict can't go stale unnoticed.
  Specs are excluded (DoD ticks + the ship status flip don't trip it); a spec predating the gate skips it.
- **Big commands lazy-load their steps (progressive disclosure).** `/init-pipeline`, `/research` and
  `/questionnaire` are now thin routers (a bootstrap block + a steps table) that read each step from
  `templates/steps/<command>/NN-*.md` as they reach it, instead of one monolithic body — the branchy
  commands (esp. `/research`) no longer pull an unused branch into context. Pure re-partition, verified
  token-for-token identical to the old bodies. No installer change (steps ride the existing `templates/` copy).
- **Machine-checkable postconditions on the two silent-failure gates** — `/spec` freeze asserts
  `status: frozen` actually landed; `/build` asserts the contract file exists before dispatching agents.
- **`/review` lets git group the diff by surface** (`git diff --name-only -- <path>` + an `:(exclude)`
  remainder) instead of the lead reasoning it out file by file — deterministic and cheaper.
- **`/fix` collapses fully-resolved Remediation rounds** to a one-line summary, so the spec every agent
  re-reads stops growing unbounded across fix loops (rounds with any open item stay expanded).
- **New SCHEMA § "Measuring cost"** — documents `/cost` (built-in per-subagent + per-command usage share)
  and the OTEL `settings.json` env block (`claude_code.token.usage` / `cost.usage`) for exact numbers.

## 0.1.22 — 2026-07-26

- **`/spec` exports a standalone design brief** — for a UI feature, freezing the spec now also writes
  §8 (the "spec return") to its own `specs/design/<id>.md`, in addition to printing the copy-paste
  block. One `.md` you can open, share, or drop straight into the design tool instead of scrolling back
  through the chat — regenerated on every freeze so it never drifts from the spec. Lives in the
  `specs/design/` subfolder on purpose, so the non-recursive `specs/*.md` glob (kanban backfill,
  `/doctor`) never mistakes it for a spec. Backend-only features are unaffected.

## 0.1.21 — 2026-07-24

- **Reliable local-PDF reading for `/research`** — subagent nodes often lack a PDF renderer (no
  poppler), which made research-agents silently fall back to a web copy of the document — fine for a
  public PDF, a silent fabrication risk for a private one. `/research` now **extracts the PDF to
  per-page text ONCE up front** (pure-Python `pypdf` in a throwaway venv — no system deps) and agents
  read that text, never the binary PDF. A local read that fails now returns a loud `===READ-FAILED===`
  instead of reconstructing from the web; the orchestrator re-extracts or surfaces it. Adds a
  scanned-PDF guard (no text layer ⇒ stop, needs OCR).

## 0.1.20 — 2026-07-24

- **`/fix` now checks off resolved Remediation items** — the lead flips `- [ ]` → `- [x]` (with a
  short "fixed" note) for every item the surface agents report addressed in their handoff, and skips
  already-`[x]` items when scoping the re-dispatch. Fixes two long-standing quirks: a spec whose
  Remediation looked permanently open even after fixes landed, and a later `/fix` re-sending
  already-fixed items from earlier rounds to the agents.
- **`/review` now ticks the §9 DoD at a SHIP verdict** — a SHIP verdict is the pipeline's statement
  that the feature is done, so the lead checks off each Acceptance-criteria item its verifying stage
  actually covered (conformance/copy = review, tests/lint/types = build, mobile-first/runtime = smoke),
  leaving open any whose stage didn't run. `/ship` gains a matching gate: it lists any still-open DoD
  item and asks before shipping (it never ticks — that's `/review`'s job).

## 0.1.19 — 2026-07-24

- **Research decoupled from the questionnaire** — `/research` now dispatches a dedicated, standalone
  **`research-agent`** (an autonomous research assistant that extracts everything important in the
  source) instead of the old bi-mode `questionnaire-researcher`. The report no longer carries any
  "future questionnaire" framing: the domain-brief `goal` is a research objective, and the brief
  template is renamed `research-brief.md`. The blueprint step moves to its own **`questionnaire-architect`**
  agent, dispatched by `/questionnaire`. New Notion archive databases are titled « Recherche ». Update
  scrubs the retired `questionnaire-researcher` agent and old template automatically.
- **Multi-pass research for large sources** — `/research` now maps a big PDF into a reading plan, runs
  one deep `research-agent` pass **per segment in parallel**, synthesises the cross-cutting sections,
  and assembles a single report. Report length scales with the source (no fixed word-count cap), so a
  dense thesis or state-of-the-art gets exhaustive coverage instead of being compressed into one pass.
  Small sources and URLs still take the single-pass path.

## 0.1.18 — 2026-07-22

- **Consolidated global config** — the research/questionnaire settings move from
  `~/.claude/questionnaire.config.yaml` into one `~/.claude/cohorte.config.yaml` with
  `obsidian` / `research` / `questionnaire` / `kanban` sections and a shared `obsidian.vault_path`.
  The old file is still read as a fallback; `/update-pipeline` migrates it for you. The `npx`
  installer now offers a quick interactive setup on a TTY.
- **Obsidian kanban mirror** — an optional per-project board mirrors the pipeline
  (`/brainstorm`…`/ship`): each stage moves the feature's card across columns
  (Ideas → Brainstorm → Spec → Ready to build → Building → Review → Fix → Ship → Shipped).
  `/brainstorm` can pick an idea straight from the *Ideas* column; `/init-pipeline` creates + links
  a board (keyed by the project's `PIPELINE.md` name); `/update-pipeline` links/repairs it and
  **backfills existing `specs/` onto the board**, syncing each card to its spec's status. Enable it
  via `/init-pipeline` (new project) or `/update-pipeline` (existing) — no hand-editing.

## 0.1.17 — 2026-07-22

- **Serena dashboard no longer auto-opens** — the per-repo Serena launcher `/init-pipeline` wires now
  passes `--open-web-dashboard False`. The dashboard stays available (`http://localhost:24282/dashboard/`)
  but no longer pops a browser tab on every server start. The flag overrides each machine's
  `serena_config.yml`, so behaviour is uniform across the team; `/update-pipeline`'s health check appends
  the flag to launcher entries that predate it.

## 0.1.16 — 2026-07-22

- **Obsidian store: research and questionnaires split** — research notes land in
  `obsidian_research_folder` (default `Recherches/`, with `_sources/`), and a derived questionnaire
  is now a **separate note** in `obsidian_questionnaire_folder` (default `Questionnaires/`),
  wikilinked both ways with the research note. Statut lifecycle: the research note stays
  `Recherche`; the questionnaire note carries `À relire` / `Bloqué` / `Approuvé`. (Replaces
  0.1.15's single `obsidian_folder` key.) Notion store unchanged — one page per run.

## 0.1.15 — 2026-07-22

- **Obsidian store for research runs** — the research/questionnaire capability gains a `store:`
  switch in `~/.claude/questionnaire.config.yaml`: `notion` (default, unchanged) or `obsidian` —
  each run becomes a markdown note in `<vault>/<obsidian_folder>/` with frontmatter properties
  (`run_id`, `sujet`, `cadre`, `statut`, `date`), source PDFs copied to `_sources/` for provenance.
  No MCP needed; the vault path is asked once on first `/research`, then saved. Old Notion runs stay
  readable — pass their URL to `/questionnaire`.

## 0.1.14 — 2026-07-22

- **`/fix`** — scoped fix loop: appends a REVIEW REPORT (or `/smoke` failures) to the spec's
  `## Remediation` and re-dispatches ONLY the surfaces with findings, instead of the full
  paste-into-`/spec` + full `/build` round-trip.
- **`/smoke`** — end-to-end verification between `/build` and `/review`: infra up in the feature
  worktree, migrations, real contract endpoints via curl (incl. RBAC denials), spec §8 UI flows
  mobile-first, optional screenshot diff against the Claude Design pages.
- **`/doctor`** — installation diagnostic: core/pointer versions, agents↔surfaces orphans, hooks &
  gate config, retrieval health, design wiring, stale worktree slots — each failure with its exact fix.
- **Dispatch metrics** — `/build`, `/review`, `/fix`, `/smoke` append per-agent JSONL evidence to
  `.claude/pipeline-metrics.jsonl` (gitignored); SCHEMA §Specialization now points at it.
- **`/ship`** — watches the PR's CI checks (`gh pr checks --watch`) and, after the merge is
  confirmed, proposes `scripts/remove-feature.sh` (worktree + slot teardown, db kept by default).
- **`/init-pipeline`** — generates `.github/workflows/pipeline-ci.yml` from the profile's commands
  (with go-ahead) and gitignores the metrics sink.
- **CHANGELOG** — this file; shipped with the core, shown by `/update-pipeline` after an update.

## 0.1.13 — 2026-07-22

- **`/review` is parallel** — one review agent per touched surface in a single dispatch (wall-clock =
  slowest surface, not the sum); the lead merges the reports, worst verdict wins.
- **Review agent reads less** — `mcp__serena` in its toolset (harmlessly absent when a project has no
  retrieval provider) and a diff-hunks-first reading rule instead of whole-file reads.

## 0.1.12 — 2026-07-22

- **Per-feature design projects** — spec `design_files` now accepts full Claude Design links, each
  carrying its own project id (extracted at `/build`'s design gate); the profile's `design_project`
  becomes an optional fallback. Design each feature in a fresh project and just paste the link.

## 0.1.11 and earlier

Pre-changelog releases: serena wiring made PATH-proof and health-checked (0.1.9–0.1.11), OIDC npm
trusted publishing (since 0.1.4). See `git log` for details.
