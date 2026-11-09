# /cohorte-init-pipeline · 02 Interview the gaps

### Phase 2 — Interview the gaps (AskUserQuestion)

Ask ONLY what you couldn't confidently detect. Batch related questions. Cover:

- **Surfaces & ownership** — confirm the surface list and each one's path + owning agent name. (If a
  single-app repo, one surface.) Confirm the `tools` each agent needs (add `DesignSync` only to a
  surface with `uses_design: true`), and each surface's `model` tier: `sonnet` (Recommended default —
  implementers mostly apply a frozen contract, which Sonnet handles at a fraction of the Opus-lead
  cost), `haiku` for purely mechanical surfaces (scaffolding), `inherit` only for surfaces with real
  design decisions worth running on the lead's model.
- **Specialization (only if Phase 1 flagged a large + cleanly-separable surface)** — offer to split it
  into specialized sub-surfaces (e.g. `web-checkout`, `web-billing`) so `/cohorte-build` runs them in parallel,
  per SCHEMA.md §Specialization. If the human accepts, apply the rules: **shared code (routing, global
  state, DS kit/tokens) becomes its own single-owner surface**, and cross-slice shapes go through the
  contract. Default to NOT splitting when boundaries are tangled or slices are tiny — coarse is fine.
- **Quiet commands** (never store a bare `pnpm test` as what agents execute) — for each noisy command
  (tests, lint; per surface AND repo-wide), propose the detected **bridled variant** as the
  Recommended option: dot/failures-only reporter (`--reporter=dot` vitest/playwright, `--silent`
  jest, `-q` pytest, `--quiet` eslint/ruff — whatever the detected runner supports). These land in
  `test_quiet_cmd`/`lint_quiet_cmd` + `commands.test_quiet`/`lint_quiet` and are what agents and the
  `/cohorte-review` pre-flight actually run (SCHEMA.md §Output discipline). If the human declines or
  the runner has no such flag, leave `""` — consumers then fall back to `<cmd> 2>&1 | tail -40`.
- **Contract** — mechanism (`shared-types-zod` / `openapi` / `protobuf` / `json-schema` / `none`) and
  where feature contracts are authored. If `none`, surfaces sync by the spec prose alone.
- **Release notes (only if Phase 1 found a versioning tool or a note-enforcing CI job)** — confirm the
  anchor package (a `fixed`/lockstep group means ONE key propagates to all), the note's language, and the
  **bump policy** the lead will apply at `/cohorte-ship`: what counts as major/minor/patch here, and
  whether any level is forbidden (a `0.y.z` product normally forbids `major` — Changesets would jump it
  to `1.0.0` with no human deciding). Policy prose lands in `release_notes.guidance`. Nothing detected ⇒
  don't ask; leave `release_notes.enabled: false`.
- **UI language** — language of all user-facing copy.
- **RBAC** — is there a role hierarchy? If yes, list it highest→lowest.
- **Design system** — enabled? provider (Claude Design / Figma / none) + project ids + kit/token paths.
- **Code retrieval** — confirm the provider (see SCHEMA.md §Code retrieval): `serena` (Recommended
  default — live LSP symbol navigation, no index to maintain), `graphify` (persistent knowledge graph
  over code + docs — better on very large or mixed code+docs repos, but needs an index step + rescans),
  or `none`. Only demote from `serena` if the human objects or the provider CLI can't be installed.
- **Isolation** — build features in parallel git worktrees with per-feature DB + ports, or just in the
  main checkout? If worktrees: DB-per-worktree? port bases? compose file?
- **Gate** — confirm the destructive commands to hard-deny and the ones to confirm-first (seed from the
  detected DB/migration tooling + always git commit/push/merge/rebase/reset).
- **Personas** — keep the default `/cohorte-brainstorm` panel, or customize members for this domain?

Prefer sensible defaults from Phase 1 as the first (Recommended) option in each question.

- **Kanban** (optional) — mirror this project's pipeline (`/cohorte-brainstorm`…`/cohorte-ship`) onto an Obsidian
  Kanban board? If the human says yes: confirm the shared vault path (`obsidian.vault_path` in
  `<config>`; ask if empty) and the board's location inside it (default
  `<ProjectName>/Tasks.md`). Phase 4 creates the board and records the link. Default: no.

> The **kanban** link is user-scoped (it points at a personal vault, so it never goes in the committed
> `PIPELINE.md`), but IS wired here because it is per-project — see Phase 4.

