---
model: sonnet
description: Refresh the machine-wide pipeline core, re-wire this repo (gate, pointer) and reconcile its generated files — /cohorte-init-pipeline stays one-time.
argument-hint: [path-to-local-checkout]
---

You are the **pipeline updater**. Refresh the machine-wide core to the latest published version, re-wire
this repo against it, then bring the repo's generated files up to the new core (§3.5) — additively, never
clobbering the human's choices — so `/cohorte-init-pipeline` never needs re-running for an upgrade.
The installer never touches `PIPELINE.md`, the surface agents, `gate-config.json` or the filled `<config>`.

## 1. Current version

Read `<core>/pipeline/VERSION` (a semver) and this repo's `<state>/pipeline.json` `core_version`. Note
both. A pointer that still carries `"mode": "bundled"` or `"mode": "global"` is a **2.x repo**: §2b
migrates it.

## 2. Run the update

```sh
npm i -g cohorte@latest && cohorte update     # refresh the CLI, then the machine-wide core
```

If `cohorte` is not on PATH, `npx cohorte@latest update` does the same. If `$ARGUMENTS` is a path to a
local checkout of the cohorte repo (it contains `bin/cli.js`), run `node <path>/bin/cli.js update`
instead — useful when iterating on the pipeline itself. `cohorte update` exits non-zero and changes
nothing if `~/.claude/settings.json` is not valid JSON: show the error and stop.

## 2b. Re-wire this repo — run `<sync>`

Always, from the repo root (one Bash call), and show its output. It refreshes the committed gate
(`.claude/hooks/cohorte-gate.py`) and its registration, bumps the `<state>/pipeline.json` pointer, and
keeps the `.gitignore` entries. On a **2.x repo** it also removes the vendored core (`.claude/pipeline/`,
`.claude/templates/`, `.claude/workflows/`, `.claude/commands/cohorte-*.md`, `.claude/agents/{review,release,profile-reader}.md`,
`.claude/hooks/gate.py`): files git tracks unmodified are deleted (git keeps them), anything else is moved
to `.claude/cohorte-legacy-backup/`. Tell the human to commit the result.

If this repo's surface agents are missing from `<agents>/` but exist in `~/.claude/agents/` (a 2.x
"global" repo rendered them there), re-render them into `<agents>/` in §3.5 — do not copy the global
files, render from the current template — and tell the human the global copies can be deleted once no
other repo uses them.

## 3. Report old → new

Re-read the VERSION file(s) and print `old → new`. If unchanged, say the core was already up to date.

Then print **What's new**: read the installed `<core>/pipeline/CHANGELOG.md` and show the entries
between the old and new versions (most recent first). File absent ⇒ the old core predates 0.1.14 —
skip silently.

## 3.5 Reconcile this repo's generated files

Only when the current repo has a `PIPELINE.md`: run the **Reconcile procedure** from the installed
`pipeline/SCHEMA.md` §Reconcile — top up the profile's machine block with new fields at their defaults
(one batched question set for any genuinely new human decision — e.g. choosing a `retrieval` provider,
or the **quiet command variants**: `test_quiet_cmd`/`lint_quiet_cmd` + `commands.test_quiet`/
`lint_quiet`, proposing the detected bridled forms per §Output discipline; `gate.preflight` tops up
silently at its defaults), re-render the surface agents from the current `implementer.template.md`
(this refreshes each agent's **baked §Conventions slice** — required after any hand-edit of the
profile's prose).
Additively patch the `settings.json` permissions and `gate-config.json` (including the `preflight`
block and the workflow-agent `allow` entries from init step 5) — never the gate hook entries, `<sync>`
owns those — and run any newly-added capability's wiring (e.g. Serena's project-scope `claude mcp add`).
Verify the refreshed core actually carries `<workflows>/cohorte-review.js` + `<fixed-agents>/cohorte-profile-reader.md`
— missing means the update half-ran: re-run `cohorte update`. Even when no capability is new, **re-run the retrieval provider's
health check** (SCHEMA.md §Code retrieval: CLI resolvable from PATH, `.mcp.json` entry present —
upgrading a bare `serena` entry to the PATH-proof launcher form, `.serena/` gitignored, server
actually connected) and repair whatever fails — wiring that worked at
init can rot (PATH changes, uninstalls, hand-edits). Report what was reconciled; if nothing was
missing, say so. This is why `/cohorte-init-pipeline` never needs re-running for a core upgrade.

Four of the §Reconcile steps matter specifically here:

- **Local-artifact hygiene** (§Reconcile step 8): gitignore + untrack the pipeline's runtime files
  (`<state>/preflight.ok`, `<state>/pipeline-metrics.jsonl`, `specs/reports/`). A tracked
  `preflight.ok` — what every pre-2.0.0 install ends up with once a release agent stages `.claude/` —
  makes the phase gate ask on every single review dispatch, so fix it here and say so.

- **Spec-template top-up** (§Reconcile step 7): `specs/_template.md` was seeded at install and never
  refreshed since, so add the front-matter fields the current `templates/spec.template.md` has and the
  repo's copy lacks — and drop `loop_pass`/`loop_phase`, retired with the 2.2.0 conversational loop driver —
  front-matter only, never the body.

- **Global config seed** (§Reconcile step 5): if `<config>` is absent, seed it
  from the template so the kanban + shared-vault config has a home. Never clobber an existing filled
  file. Report what was seeded. Then **scrub the retired `telemetry:` block** if the existing file
  still has one (every install seeded before 2.3.0 does) — one targeted Edit deleting the block and
  its comment header, nothing else touched. That capability was removed in 2.3.0, sender included,
  so the block is dead config: nothing reads it, and an `enabled: true` left sitting in a file the
  human may open reads as though data were still leaving the machine. Say you removed it.
- **Kanban sync** (§Reconcile step 6): resolve this project's board with
  `<core>/pipeline/scripts/kanban-move.sh --check` — it prints either the board path or the exact
  missing link. **Not linked** → offer to link/create a board (confirm the vault + `<folder>/Tasks.md`,
  write the `boards` entry, create the board file per §Kanban). **Linked** → verify the board file
  exists (recreate if the human confirms) and its columns match `kanban.columns` (repair drift). Either
  way, run the §Kanban **full sync/backfill** from `specs/*.md` — one
  `kanban-move.sh auto <id> <stage>` per spec, `<stage>` from the status mapping — this is what adds
  every already-developed feature to the board and repositions cards to match each spec's `status`.
  Report cards added / moved / already-correct. Skip silently if `kanban.enabled` is false and the
  human doesn't want to turn it on.
- **A project renamed since its last update loses its board silently** — `boards` is keyed by the
  profile `name`, so a `name:` edit orphans the old entry and no lookup matches the new one. When
  `--check` finds no entry for `<name>` but `boards` holds exactly one other key whose board file
  exists, say so and offer to re-key it rather than creating a second board.

## 4. Tell the human the follow-ups

- **Restart / reload the coding-agent session** so it picks up updated commands, agents, and any
  newly-registered MCP server.
- **Other repos using the global core:** their core is already fresh, but reconcile is per-repo — run
  `/cohorte-update-pipeline` inside each (it will skip the already-done core update and just reconcile).
- **Commit** the reconciled files (`PIPELINE.md`, `.claude/`, `.mcp.json` if added) so teammates get them.
- The kanban config is global and user-scoped
  (`<config>`) — never committed. The core update never touches it; only the
  reconcile above seeds the file and writes kanban board links (into that global file, not the repo).
