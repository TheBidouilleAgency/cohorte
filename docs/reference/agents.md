# Agents

Two kinds: **fixed agents** shipped as-is by the installers, and **rendered surface agents**
generated per project by `/cohorte-init-pipeline` from a template. All are stateless — every dispatch
re-supplies everything they need as exact file paths.

## Fixed agents

| Agent | Model | Tools | Job |
| --- | --- | --- | --- |
| `review` | sonnet | Read, Grep, Glob, retrieval MCP | Read-only reviewer / auditor. |
| `release` | haiku | Read, Grep, Glob, Bash | Commit / push / PR ritual at `/cohorte-ship`. |
| `profile-reader` | haiku | Read, Grep, Glob | `PIPELINE.md` machine block → JSON (workflow phase 0). |

### `review`

Read-only **by construction** — no Write, no Edit, no Bash. Reads the staged diff file named in
its dispatch *first* (hunks + immediate context; full source files only when a finding demands
it), prefers retrieval MCP tools over grep-and-read. Checks in order: spec conformance (highest
priority — every deviation from the frozen contract is a finding), correctness, security
(any vulnerability ⇒ verdict **BLOCK**), profile conventions, RBAC and mobile-first when
enabled, TDD coverage — plus per-language traps (TS: `any`, floating promises; Python: mutable
default args, bare `except`; Rust: `.unwrap()` outside tests, `unsafe` without `// SAFETY`;
Go: discarded errors, un-`ctx`'d goroutines, `defer` in loops; SQL: `UPDATE`/`DELETE` without
`WHERE`, N+1, unindexed FK joins).

A last, deliberately weak axis is **over-engineering** — code the diff *added* that didn't need to
exist, tagged `delete:` / `stdlib:` / `native:` / `yagni:` / `shrink:` and always naming the cheaper
replacement. It is capped at **5 findings**, its severity ceiling is **MEDIUM**, and it can never
produce a CRITICAL, a REVISE or a BLOCK: a diff whose only findings are `complexity` ships, and they
park in the backlog like any other nit. Tests, fixtures and anything the contract or an acceptance
criterion mandates are out of bounds — coverage is not bloat. In audit mode the axis widens to the
whole target (10 per domain, biggest cut first, closing with `net: -N lines, -M deps possible.`).

Emits the **REVIEW REPORT**: severity table, verdict (`SHIP` = no CRITICAL/security;
`REVISE` = ≥1 CRITICAL; `BLOCK` = security), findings **capped at 20, one line each, zero code
excerpts**, every finding self-sufficient (`file:line · severity · type · concrete fix`) — it
gets appended verbatim to the spec's Remediation. A separate **`## Deferred`** section (max 10) holds
what is real but **out of this feature's scope** — pre-existing code the diff never touched, each line
carrying its own out-of-scope reason. Deferred items count in no severity row, move no verdict, and get
routed to `specs/refactor-backlog.md` by the lead; anything the diff touched, any spec violation and any
security issue on a path this feature adds or calls is **never** deferrable. In **audit mode**
(dispatched by `/cohorte-audit`
with a path instead of a spec) it emits a prioritized refactor backlog grouped by domain
instead of a verdict.

### `release`

Runs only after a human-confirmed SHIP. Sanity-checks the branch and staged files (refuses
`.env`/secrets), writes conventional commits referencing the feature id, plain `git push`
(never force, never history rewrites), opens the PR via `gh` — or emits the compare URL + a
drafted PR body from the template when `gh`/GitHub isn't available. Never edits source, never
runs migrations, never touches `gate.deny` commands.

### `profile-reader`

Reads the fenced `yaml pipeline-profile` block of `PIPELINE.md` and returns it as faithful JSON
(comments dropped, nothing invented, `<…>` placeholders passed through) — or
`{"error": "…"}` — nothing else. Exists because workflow scripts have no filesystem access;
it's the mandatory phase 0 of all four workflow scripts.

## Rendered surface agents

`/cohorte-init-pipeline` (and `/cohorte-build` §1.5 when a spec grows the surface list) renders one agent per
`surfaces[]` entry from `core/agents/implementer.template.md` into
the runtime's agents dir as `<agent>.md`, substituting:

| Placeholder | Filled with |
| --- | --- |
| `<SURFACE_AGENT>` / `<SURFACE_LABEL>` / `<SURFACE_PATH>` | key, human label, owned tree |
| `<SURFACE_TOOLS>` / `<SURFACE_MODEL>` | frontmatter tools (+ `DesignSync` iff `uses_design`, retrieval MCP tools iff wired) and model tier |
| `<SURFACE_CONVENTIONS>` | the surface's convention slice **baked at render time**: §Conventions `### Shared` + its own `### Surface:` stanza + its §Testing lines |
| `<SURFACE_EXTRA_NEVER>` / `<SURFACE_DESIGN_INPUT>` / `<SURFACE_TDD_STEP1>` | surface-specific never-rules and (for design surfaces) the link-based design-input and design-first TDD step |

The rendered implementer:

- **Owns one tree** (`<path>/**`) and may touch nothing else; never edits the frozen contract
  (mismatch ⇒ report in the handoff, never fix); never runs `gate.deny` commands; migrations
  are append-only.
- **Reads only the machine block** of `PIPELINE.md` at runtime — its conventions are baked in.
  If the bake visibly contradicts the profile, it says so in its handoff (the profile wins; the
  agent needs a re-render via `/cohorte-update-pipeline`).
- **Walks the minimality ladder** before inventing any helper, wrapper, abstraction or new
  dependency: does it need to exist at all → already in this repo → stdlib/framework → native
  platform feature → an already-installed dependency → a few inline lines → only then the minimum
  implementation the contract requires. It governs the **how**, never the **what**: a contract
  field, an acceptance criterion, a test, a validation or an authz check is never "trimmed". Bounded
  to one lookup per candidate, so it costs a symbol search, not an exploration. A shortcut kept
  deliberately goes in the handoff's `## TODO / not done` with its ceiling and upgrade trigger.
- **Works strict TDD**: (design pull first for `uses_design` surfaces) → failing tests from the
  contract → implement to green → refactor to conventions → lint + format. Runs **bridled
  commands** (its `*_quiet_cmd`s, or `cmd 2>&1 | tail -40`).
- On a **fix loop**, doesn't re-read the spec: its dispatch carries its open Remediation items
  verbatim; it reads only the files they name, and computes its own scoped diff
  (`git diff <base> -- <its path>`) when it needs current state.
- Returns the fixed-shape **HANDOFF**: summary, migrations, test results, contract
  mismatches/assumptions, remediation addressed, TODOs — one line per item, no file lists, no
  code excerpts.

**Agent files are regenerable artifacts.** Hand-written rules belong in `PIPELINE.md`
§Conventions (which reconcile never touches), never in the agent files — `/cohorte-update-pipeline`
re-renders them from the current template on every reconcile. `/cohorte-doctor` enforces the no-orphan
rule both ways: every surface has its agent file, every non-fixed agent file has its surface.
