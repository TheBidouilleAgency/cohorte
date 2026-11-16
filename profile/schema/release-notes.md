## Release notes — the per-feature note the versioning tool consumes

Many repos gate merges on a **per-feature release note**: Changesets' `changeset` CI job fails any PR
that touches product code without a `.changeset/*.md`. That file is **not** something the release
agent can invent — picking the bump level is project policy (semver over an API vs. over a product,
a `0.x` rule forbidding `major`, what counts as user-visible), and the prose is outward-facing copy.
It is the **lead's** to write, exactly like the contract.

The failure mode this block exists to prevent is silent and reproducible: the requirement lives in the
project's `CLAUDE.md`, which the ship flow never reads, so `/cohorte-ship` completes, opens the PR,
moves the kanban card to **Shipped** — and CI goes red on a job nobody looked at. The feature reads as
shipped while being unmergeable. Encoding it in the profile is what makes the step survive a stateless
lead.

- **Authored before the dispatch**, next to the `status: shipped` flip (`/cohorte-ship` §2b), so the note
  lands **inside** the release commit. Written after the fact it needs a second commit, and the PR is
  already open and red.
- **One key in the front-matter** — `anchor_package`. Lockstep/`fixed` version groups propagate the bump
  from it to every other workspace; listing more is how a repo ends up with a package bumped twice.
- **`forbid_levels`** encodes policy the tool itself may not enforce. The common one: while the product
  is `0.y.z`, a `major` changeset makes Changesets jump to `1.0.0` with no human deciding it — so `0.x`
  repos forbid `major` and declare a breaking change as `minor`.
- **Ask, don't guess, on an ambiguous bump.** Between two defensible levels (a refactor that also changes
  what the user sees), state the reading and let the human pick — a wrong bump is a published version
  number, not a fixable draft.
- **`empty_cmd`** covers the honest no-op: a PR that touches product code but must move no version.
  Prefer it to skipping the step; the CI job wants a file, not a version.

`enabled: false` (or `tool: none`) ⇒ §2b is a no-op and nothing below applies.
