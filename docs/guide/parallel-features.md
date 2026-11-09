# Parallel features

Two distinct kinds of parallelism, and the invariants that keep both safe.

## Within a feature: parallel surfaces

`/cohorte-build` dispatches **one implementer per surface in a single message** — build
wall-clock is the slowest surface, not the sum. This is safe because of two invariants the whole
pipeline enforces:

- **One owner per tree.** Each `surfaces[].path` is disjoint; an agent may touch nothing outside
  its own. Shared code (routing, global state, the DS kit + tokens) gets its **own single-owner
  surface** — never two agents in one tree.
- **The frozen contract is the only cross-surface channel.** Authored by the lead before
  dispatch; implementers import it read-only. Cross-slice shapes go through it, never through
  direct imports between slice trees.

### Splitting a bottleneck surface

More agents only help when they let the *slowest* surface's work run concurrently. Split a
surface into specialized sub-surfaces (e.g. `web-checkout`, `web-billing`) only when **both**
hold: it dominates build time, **and** the boundary is clean (feature modules, route groups,
independent services). The evidence lives in `pipeline-metrics.jsonl` — one line per
phase batch — read it before splitting; split what actually dominates wall-clock, not what feels
big. `/cohorte-build` §1.5 proposes and renders the split automatically when a spec warrants it.

## Across features: worktree isolation

With `isolation.enabled`, every feature gets its own checkout, ports, and database:

```sh
scripts/new-feature.sh <feature_id>
```

creates a sibling git worktree `../<project-slug>-<id>` on branch
`<feature_branch_prefix><id>`, assigns it a **slot** (tracked in `.worktrees/slots.tsv`; slot 0
is the main checkout), and derives from the slot:

- its own **database** (`<name>_<id>` pattern) — the shared infra stack stays single; only the
  logical DB differs;
- its own **ports** (`port_base.api + slot`, `port_base.web + slot`) — so two features' dev servers
  runs never collide.

Teardown after the merge:

```sh
scripts/remove-feature.sh <feature_id>          # worktree + branch + slot
scripts/remove-feature.sh <feature_id> --drop-db   # also drop the feature DB
```

Both scripts are rendered from templates by `/cohorte-init-pipeline` with your project's slug, DB
pattern, port bases, and compose file substituted in. `/cohorte-ship` proposes the teardown once you
confirm the merge — never before.

## The real multiplier: one session per feature

While feature A's `/cohorte-build` runs its agents (minutes of wall-clock you'd otherwise spend
waiting), a second session can `/cohorte-spec` or `/cohorte-review` feature B:

```
session 1:   /cohorte-spec feat-a → /cohorte-build feat-a   (agents run…)
session 2:   /cohorte-spec feat-b → /cohorte-build feat-b   (agents run…)
session 1:   /cohorte-review feat-a → /cohorte-ship feat-a
session 2:   /cohorte-review feat-b → …
```

Rules that keep it safe:

- **One feature per session.** All lead-side state is keyed by feature id **on disk**
  (`specs/<id>.md`, `<contract.path>/<id>.*`, `specs/reports/<id>*`) — sessions never share
  state. A single session interleaving two features accumulates both histories and pays for both.
- **The contract package is the one shared tree** across features — but each feature edits only
  its own `<id>.<ext>` file, so no conflicts. Merge order matters only when a later feature
  *imports* an earlier one's contract: ship the dependency first.
- **`/cohorte-ship` one at a time.** It commits from the feature's branch, and the freshness gate keeps a
  stale verdict from shipping. After each merge, the surviving worktrees need a rebase so their
  eventual reviews diff against reality — `/cohorte-fleet sync` (below) sweeps that for you, or
  `git rebase main` by hand from each worktree's own session.
- **`/cohorte-doctor` check 6** prints the live slot table (feature · worktree · ports · db · branch
  behind main by N commits) when you lose track — a worktree far behind main means its next
  review diffs against stale code.

## Metrics discipline

`pipeline-metrics.jsonl` always belongs to the **main checkout** — never the worktree, which
dies at teardown while metrics must accumulate across features. Every command resolves it from
anywhere via `$(dirname "$(git rev-parse --git-common-dir)")/<state>/pipeline-metrics.jsonl`;
`/cohorte-doctor` flags a stray copy inside a worktree.

## `/cohorte-fleet` — the flight controller

Everything above works but lives in your head: which specs collide, which merges first, who
rebases the survivors. `/cohorte-fleet` owns that coordination:

- **`plan <id> <id> …`** — verifies every spec is frozen, builds the *feature × surface* overlap
  matrix from the specs' §5/§6 (contract dependencies ⇒ merge order; same-tree writes ⇒
  serialize or drop one), provisions a worktree per feature via `new-feature.sh`, writes the
  flight plan to `specs/reports/fleet.json`, and prints one launch line per feature — the
  worktree to open a session in and the first command to run there.
- **`status`** — one row per feature: spec status, loop round/outcome, blocking count,
  ahead/behind main, and the *single next action*.
- **`sync`** — after each merge: rebases every surviving worktree onto main (conflicts reported
  verbatim and left to their owner's session, never resolved from outside), and says the part
  everyone forgets — a rebase invalidates the `reviewed_digest`, so `/cohorte-ship` will refuse
  until a fresh `/cohorte-review` re-stamps.

What it deliberately does **not** do is launch the work headless — each feature's build/review/
loop runs in its own supervised session (the retired 2.2.0 driver is why). The fleet plans,
watches and rebases; you fly.
