# Implementation status

This repository implements the local deterministic part of the Cohorte V3 specification. It is a
pre-release foundation, not a V2-parity or provider-support claim.

## Implemented and locally testable

- Python 3.12 package and `cohorte` CLI.
- Strict Pydantic contracts for profiles, specs, task plans, runs and protocol envelopes.
- Pure workflow reducer with evidence-gated advancement, pause, resume, cancellation, fix and
  uncertain-effect states.
- SQLite WAL store with foreign keys, optimistic run updates, immutable hashed artifacts, durable
  events, requests, decisions and idempotent operations.
- Read-only project discovery for basic Python, JavaScript and workspace layouts.
- DAG and coverage validation, bounded argv-only check execution, filtered environment and output.
- JSON-RPC stdio handshake, bounded frames, structured errors, deduplication and replay.
- Passive Codex auth inspection and an explicit bounded live probe using the pinned SDK/runtime.
- Live Codex evidence for subscription routing, read-only enforcement, interruption and resume on
  Darwin arm64 with SDK/runtime 0.155.1.
- A Codex-only `loop` vertical with a frozen spec, deterministic task plan, isolated Git worktree,
  path ownership enforcement, bounded checks, independent read-only review, bounded fix cycles and
  candidate-bound ship evidence.
- Live G1 vertical evidence on a disposable repository: workspace-write implementation, two passing
  standard-library tests, complete surface review and a blocker-free `ready_to_ship` verdict. The
  final run is re-readable from SQLite as `SHIP / waiting_user`, with a candidate-bound ship request.
- Durable phase checkpoints and `resume`, `pause` and `cancel` controls. A live controller was
  interrupted during review, then resumed from the same worktree and candidate hash. The recovered
  journal contained one build, two safe check executions, one completed review and one ship request.
- G2 delivery core: candidate-bound `approve`/`deny`, freshness and remote-base preflight, marked Git
  commit, non-force push, GitHub PR and GitLab MR adapters, CI status refresh, and durable effect
  reconciliation. Local bare-remote tests prove commit/push identity and PR-created-before-ack recovery
  without a duplicate.
- Live GitHub G2 evidence: private disposable repository, exact approved candidate committed and
  pushed, PR confirmed open with a clean merge state, and all three delivery effects reconciled in
  SQLite. A second run based on a real GitHub Actions workflow reached `ci_passed` with the `unit`
  check confirmed successful.
- G3 multi-surface execution: criteria are mapped to a validated task DAG, contract dependencies run
  before consumers, independent tasks use isolated worktrees and bounded parallel Codex sessions,
  and Cohorte creates and serially integrates marked task commits before global checks.
- Live Codex G3 evidence on Darwin arm64: one contract task followed by concurrent backend/client
  tasks (`max_parallelism=2`), five integrated files, four passing unit tests, per-surface plus
  integration review, and exact-hash durable evidence ending at `SHIP / waiting_user`.
- Durable mid-wave recovery: SQLite stores task attempts, generation-fenced leases, worktree and
  branch identities, produced commits and integration commits. A live controller-crash scenario
  recovered the still-`running` client task from its existing commit, completed with exactly three
  attempts and zero remaining leases, then passed checks and the bounded review/fix/re-review cycle.
- Provider auth expiry and exhausted quota suspend runs in `waiting_auth` or `waiting_quota` while
  preserving their stage and candidate. Transient overload retry is limited to two attempts.
- Active task leases cannot be replaced before expiry. A POSIX `SIGKILL` qualification leaves a
  worker alive after controller death, rejects concurrent recovery, then resumes only after worker
  termination and lease expiry.
- A live Codex interrupt probe observes a marked descendant before interruption and proves it is
  gone afterward. A killed reviewer yields `TransportClosedError` and no accepted review.
- G3 Fleet: cross-feature write-set overlap matrix, derived and explicit dependencies, bounded
  parallel feature waves, isolated feature worktrees, serialized integration, per-feature
  revalidation after every base change, global checks and cross-feature review.
- Live Fleet evidence: API and Web ran in parallel, the overlapping API follow-up ran in the next
  wave from the integrated API+Web head, all three revalidation checkpoints passed, six global unit
  tests passed and the final review covered both surfaces with a `ready` verdict.
- Intake and Patch workflows: text, file and URL sources retain their locator, timestamp and content
  hash; deterministic triage routes explicit reproduced bugs to Patch and ambiguous reports to
  questions. Ticket content remains untrusted data. Patch freezes a minimal, source-linked scope,
  narrows write ownership, requires an existing automatic regression to fail, then reuses the
  isolated build/check/review/ship pipeline.
- Live Patch evidence: an immutable intake source became a frozen patch; a committed regression
  failed with `6 != 5`, Codex changed only `calc.py`, the same regression passed, review returned
  `ready`, and SQLite ended at `SHIP / waiting_user` on the exact candidate hash.
- Audit/refactor/retro deterministic core: bounded Audit rejects any source-tree mutation and emits
  a prioritized backlog; Refactor requires an exact-hash persisted approval, a green behavioral
  baseline, narrowed paths and the common build/check/review/ship loop; Retro extracts repeated
  finding fingerprints and updates the profile only after a proposal-bound approval decision.
- Live maintenance evidence: two read-only audits retained the exact source-tree digest and emitted
  the same deterministic duplicate-branch fingerprint; the exact-hash approved refactor kept its
  regression green before and after changing only `calc.py`, passed independent review and reached
  `SHIP / waiting_user`. Retro then required its own proposal-bound decision before producing
  profile revision 2 with the ratified convention.
- Design/retrieval ports and local adapters: disabled design is explicitly skipped; file design
  sources produce immutable versioned snapshots; inaccessible configured design is blocked.
  Retrieval searches bounded file roots when disabled or configured for files, exposes configured
  provider failures, and labels an allowed file fallback with its reason.
- Align-ds local workflow: compare the captured source with the committed JSON snapshot, persist
  exact add/update/remove deltas, bind approval to the plan hash, narrow write ownership, then reuse
  the durable build/check/review/ship loop.
- Live align-ds evidence: four exact deltas from a versioned local design source changed only
  `design-snapshot.json`; the declared design check passed, independent review returned `ready`,
  and the run reached `SHIP / waiting_user` on the candidate hash.
- Obsidian Kanban projection: one configured board path, exact-hash concurrency guard, backup before
  atomic replacement, stable feature markers and durable projection versions. A retry is a no-op,
  stale state is rejected and no vault scan is performed.
- Metrics report: run outcomes, elapsed duration, human interventions and fix cycles are computed
  from SQLite, with project, run, phase and provider groups. Provider tokens/cache and estimated
  cost carry explicit availability; missing usage remains `null` rather than becoming zero.
- Opt-in V2 migration: an inspectable hash-bound plan lists exact files, mappings, exclusions,
  losses, warnings and ambiguities. Credentials are excluded, YAML/frontmatter remains inert data,
  symlinks are rejected, imported metadata is historical/non-certified, old active runs are never
  resumed, and apply rechecks every source hash before one transactional import. The CLI creates and
  verifies a database backup and supports an exercised rollback.
- Monotonic SQLite schema upgrades: schema 1 upgrades to schema 2 under an exclusive transaction
  after a verified backup, existing data/configuration remains intact, and a future schema is
  refused without a silent reset. An installed 0.1.0a1 wheel is upgraded in place to 0.1.0a2
  in hosted Ubuntu, macOS and Windows CI on Python 3.12/3.13; external configuration, project
  data and artifact bytes are compared across the upgrade.
- François-facing stdio contract: capability-negotiated handshake, project/feature/request read
  models, grouped metrics, run controls, request responses and durable event replay/unsubscribe.
  Passive account status exposes no credentials. This is the Cohorte protocol surface; the external
  François UI remains unvalidated.
- Persistent POSIX service host: the CLI starts, probes and stops a background Unix-socket host;
  filesystem permissions and kernel peer credentials restrict it to the local user. Connections
  reuse the same RPC implementation, enforce bounded frames and writer drain timeouts, and a client
  disconnect leaves durable workflow state unchanged. Durable replay continues into live event
  notifications without a query gap. This path is validated on Darwin arm64.
- Windows named-pipe backend: user-SID-only DACL, remote-client rejection, single-service mutex,
  bounded frames and the same start/status/stop RPC lifecycle. The Windows-only integration test is
  green in the Python 3.12/3.13 GitHub-hosted Windows CI matrix. This validates the runtime
  lifecycle, while release support still requires real-host and load-level qualification.
- Passive Claude executable inspection which never claims provider support.
- Live brainstorm preparation: product, architecture and QA run in distinct ephemeral read-only
  Codex sessions over one factual bundle, followed by a separately identified synthesis session.
  The brief retains contribution references, divergences, strong objections and user answers in a
  content-addressed SQLite artifact; only user answers become decisions. Invalid contribution
  references receive at most two bounded correction attempts.
- Complete spec freeze workflow: draft schema and semantic completeness, surface/check/reference
  resolution and task-plan coverage are verified before an approval request is created. The user
  decision targets the canonical hash of the exact final `frozen` document and current profile;
  any later draft, profile, reference or plan change refuses the freeze. The CLI writes the approved
  document atomically and advances the durable feature status to `frozen`.
- Machine-checked AC01–AC30 qualification ledger with explicit passed, partial, blocked, deferred
  and not-started states. The first tranche adds a clean wheel-install verifier, multi-stack
  discovery coverage and an out-of-scope ownership rejection regression.

## Deliberately unverified or incomplete

- G0 Codex user questions, model catalogue and usage reporting; Claude remains unavailable pending
  an account. Permission retry remains unqualified because the runtime emitted no command-level
  denial events during the live negative probe.
- GitLab live delivery evidence and a persistent background controller remain open.
- External Figma/Serena/Graphify validation remains open. Manual Patch reproduction remains blocked
  until candidate-bound human evidence is implemented.
- Windows real-host and load-level slow-client qualification, and the François UI client.
- Multi-platform packaging and the AC01–AC30 qualification matrix.

These items remain blocked on implementation or live evidence. Mocks must not be reported as
provider support.
