## Specialization — when to split one surface into more agents

`/cohorte-build` dispatches ONE agent per surface, in parallel, so build wall-clock ≈ the **slowest single
surface**. More agents only build faster when they let the *slowest* surface's work run concurrently —
and only if the split is safe. The invariant that keeps parallelism safe is **one owner per tree, and
the frozen contract as the only cross-surface channel**. So specialization means carving a surface into
**smaller non-overlapping surfaces**, never pointing two agents at the same tree.

**Split a surface into specialized sub-surfaces only when BOTH hold:**

1. **It's a bottleneck** — the surface is large (many modules / high LOC) and dominates build time.
2. **The boundary is clean** — its work partitions into trees that don't share files, e.g. feature
   modules (`src/features/*`, `src/modules/*`), route groups, or independent services (`services/*`).

**Rules when splitting (non-negotiable — they preserve the invariant):**

- **One owner per tree is a convention, not a sandbox.** Nothing mechanical enforces it: an agent's
  `tools:` frontmatter names tools, not paths, and implementers have Write/Edit/Bash on the whole
  repo. It holds because each dispatch names one tree ("Touch only `<surface.path>`"), the rendered
  agent says the same, and review reads the diff per surface — so a stray write shows up there.
- **Shared code gets its own surface with a single owner.** Anything two slices both touch — routing,
  global state/store, the design-system kit + tokens, shared utils — becomes its OWN surface (e.g.
  `web-shared`), owned by exactly one agent. Never let two feature-slice agents both edit shared trees.
- **Cross-slice references go through the contract**, not direct imports between slice trees. If
  `web-checkout` needs a shape produced by `api-billing`, that shape lives in the frozen contract.
- **Don't over-split.** A slice too small to hold ≥1 real task, or one with tangled boundaries, is worse
  than not splitting — the coordination + token cost (each stateless agent re-reads `PIPELINE.md` + spec)
  outweighs the parallelism. When boundaries aren't clean, keep one surface.

Coarse first, specialize on evidence: start with one `frontend` / `backend` surface each; split only a
surface that's proven slow and cleanly separable. The evidence lives in
the **main checkout's** `<state>/pipeline-metrics.jsonl` (gitignored) — one JSONL line per phase batch
(`ts`/`feature`/`phase`/`seconds`/`surfaces:{key: result}`), appended by `/cohorte-build`, `/cohorte-review`
and `/cohorte-fix`.
**`surfaces` keys are surface keys, nothing else** — run-level facts go in their own top-level
fields. Anything put inside `surfaces` is read
as a surface: `cohorte doctor` renders it as a row in the per-surface table and scores a non-`ok`
value as that surface failing. Always the main checkout, never the feature worktree (which dies at teardown while
metrics must accumulate across features) — resolve from anywhere with
`$(dirname "$(git rev-parse --git-common-dir)")/<state>/pipeline-metrics.jsonl`. Read it before
proposing a split: split the surface that actually dominates wall-clock, not the one that feels big.
