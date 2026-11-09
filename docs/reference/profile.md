# The profile — `PIPELINE.md`

Generated once by `/cohorte-init-pipeline` at the repo root, kept current by `/cohorte-update-pipeline`. The
**single place** the pipeline reads for everything stack-specific — the installed core is
generic and references this file by section. **Machine block first, prose after**: the fenced
`yaml pipeline-profile` block is the deterministic contract commands parse and branch on; the
prose sections carry conventions agents read (baked into their rendered files).

The full field-by-field reference lives in the repo:
[`profile/SCHEMA.md`](https://github.com/TheBidouilleAgency/cohorte/blob/main/profile/SCHEMA.md)
(installed as `<core>/pipeline/SCHEMA.md`). This page summarizes each block and its consumers.

## Machine block

### Identity & repo

```yaml
name: MyApp
one_liner: what this product is
ui_language: French            # language of ALL user-facing copy — review enforces it
package_manager: pnpm
vcs: { host: github, remote: acme/myapp, default_branch: main, feature_branch_prefix: feature/,
       patch_branch_prefix: fix/ }
repo: { layout: monorepo, workspace_tool: turborepo }
```

`vcs.default_branch` is the diff base for reviews and the PR base; the branch prefix drives the
isolation scripts and `/cohorte-ship`. `patch_branch_prefix` is the same for a `kind: patch` spec
(`/cohorte-patch`) — optional, and a profile that predates it falls back to `fix/`.

### Code retrieval

```yaml
retrieval:
  provider: serena             # serena | graphify | none
```

A value, not a boolean — switching provider later is a one-line change + re-wiring. `serena`
(default): live LSP symbol navigation, no index; registered as a **project-scope MCP server**
(committed `.mcp.json`) with a PATH-proof launcher so it survives GUI launches with a bare PATH.
`graphify`: persistent tree-sitter knowledge graph (needs indexing + rescans). Agents are told to
prefer the provider's MCP tools over grep-and-read; `/cohorte-doctor` runs the four-step health check
(CLI resolvable, registered, gitignored, actually connected).

### Surfaces

```yaml
surfaces:
  - key: backend
    path: apps/api               # the ONLY tree this surface's agent may touch
    label: backend (AdonisJS)
    agent: backend               # rendered as backend.md in the runtime's agents dir
    tools: [Read, Write, Edit, Bash, Grep, Glob, mcp__serena]
    model: sonnet                # sonnet (default) | haiku (mechanical) | inherit (rare)
    test_cmd: pnpm --filter api test
    test_quiet_cmd: pnpm --filter api test --reporter=dot
    lint_cmd: pnpm --filter api lint
    lint_quiet_cmd: pnpm --filter api lint --quiet
    format_cmd: pnpm --filter api format
    typecheck_cmd: pnpm --filter api exec tsc --noEmit
    build_cmd: ""
    uses_design: false
```

One entry per independently-implemented area; `/cohorte-build` dispatches one implementer per entry, in
parallel. The list **grows automatically**: `/cohorte-build` §1.5 adds a surface (and renders its agent)
when a spec touches an unowned tree, or splits a proven bottleneck into specialized sub-surfaces
— shared code always gets its own single-owner surface, and the metrics file is the required
evidence before any split. The `*_quiet_cmd` fields are the bridled forms agents actually run
(see [Token economy](/guide/token-economy)).

### Contract

```yaml
contract:
  enabled: true
  mechanism: shared-types-zod    # openapi | protobuf | json-schema | none
  path: packages/shared-types/src
  ext: ts
  index: packages/shared-types/src/index.ts
  authored_by: lead              # NEVER the implementer agents
```

The only cross-surface sync channel. `enabled: false` ⇒ spec §5 prose is the contract.

### Release notes

```yaml
release_notes:
  enabled: true
  tool: changesets               # none
  dir: .changeset
  filename: "<feature_id>.md"
  anchor_package: shared-types   # a fixed/lockstep group propagates the bump from this one key
  language: French
  forbid_levels: [major]         # e.g. while the product is 0.y.z
  empty_cmd: "pnpm changeset --empty"
  ci_job: changeset
  guidance: |
    major = the deploy needs an operator action; minor = a user-visible capability;
    patch = fix/perf/refactor with no change of use.
```

The per-feature note a versioning tool consumes. `/cohorte-ship` §2b has the **lead** write it before
dispatching the release agent, so it lands inside the release commit — picking the bump is project
policy, not a git ritual. Set this whenever CI fails a PR that lacks a note (Changesets' `changeset`
job): without it the ship "succeeds" — PR opened, kanban card **Shipped** — on a red check.
`enabled: false` ⇒ the step is a silent no-op.

### Repo-wide commands

```yaml
commands:
  install: pnpm install
  dev: pnpm dev
  lint: pnpm lint
  lint_quiet: pnpm lint --quiet
  format: pnpm format
  typecheck: pnpm check-types
  test: pnpm test
  test_quiet: pnpm test --reporter=dot   # what the /cohorte-review preflight runs
  migrate: "cd apps/api && node ace migration:run"
  make_migration: "cd apps/api && node ace make:migration"
```

### RBAC & design

```yaml
rbac: { enabled: true, hierarchy: [super-admin, admin, editor, member] }
design:
  enabled: true
  provider: claude-design        # figma | none
  design_system_project: <id>    # the UI-kit source of truth
  design_project: none           # legacy fallback only — feature links carry their own project
  snapshot_dir: apps/web/design-reference
  direction: design-to-code
  ui_kit_path: apps/web/src/components/ui
  tokens_path: apps/web/src/index.css
```

`rbac.enabled` turns on the role personas in `/cohorte-brainstorm`, and the authz audit in `/cohorte-review`. See [Design system](/guide/design-system) for the design
block.

### Isolation

```yaml
isolation:
  enabled: true
  unit: git-worktree
  db_per_worktree: true
  db_name_pattern: "myapp_<id>"
  port_base: { api: 3333, web: 5173 }
  compose_file: docker-compose.yml
  registry: .worktrees/slots.tsv
```

Drives the rendered `scripts/new-feature.sh` / `remove-feature.sh` — see
[Parallel features](/guide/parallel-features).

### Gate

```yaml
gate:
  default_branch: main
  deny:  ["node ace migration:fresh", "node ace db:wipe", …]   # hard-blocked, any branch
  ask:   ["node ace migration:run", "psql", …]                 # confirm, any branch
  ask_on_default_branch: ["git commit", "git push", "git merge", "git rebase", "git reset", "docker compose"]
  preflight: { enabled: true, agents: [review], max_age_minutes: 30 }
```

See [Gate & permissions](/reference/gate) for how `hooks/gate.py` enforces this.

## Prose sections

- **Conventions** — terse, rule-shaped, per surface (`### Shared`, `### Surface: <key>`).
  Baked into each rendered agent at render time; review audits against them. **This is where
  you customize agents** — never by editing the agent files, which reconcile regenerates.
- **Testing** — the TDD contract per surface (what a test must cover, DB isolation).
- **Design brief note** — feeds `/cohorte-spec` §8 and the design step.
- **Personas** — the `/cohorte-brainstorm` panel; one per RBAC role when enabled.

## Reconcile — how the profile survives core upgrades

Every generated artifact is a deterministic function of *(current core template × profile
data)*. `/cohorte-update-pipeline` therefore reconciles instead of regenerating: new fields are topped
up at their documented defaults (batched question only for genuine human decisions), agent files
are re-rendered (refreshing baked conventions), `settings.json`/`gate-config.json` are patched
additively, capability wiring is health-checked and repaired, the global config is seeded if
absent, and the kanban board is synced. Your values are never overwritten; the prose sections
are never touched. Re-running `/cohorte-init-pipeline` stays possible but is only *needed* when the
stack itself changes in ways `/cohorte-build` can't auto-grow (package-manager or contract-mechanism
swap).
