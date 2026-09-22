# Delivery gates

The complete specification is delivered through evidence gates. A gate is complete only when its
mandatory acceptance scenarios have current evidence for the exact candidate.

| Gate | Scope | Current state |
| --- | --- | --- |
| G0 | Real provider auth, subscription route, capabilities, stop/resume | Codex 0.155.1 passed smoke/read-only/interrupt/resume on Darwin arm64; Claude 2.1.280 passed SDK smoke, structured read, workspace edit, outside-write denial, guarded read-only denial, native session-resume, CLI cancel and CLI pause/resume probes. Full login interaction and safe native mid-turn recovery remain open |
| G1 | Contracts, state machine, SQLite, recovery primitives, CLI/protocol, fake-free unit tests | In progress; Codex and Claude single-surface verticals and controller-crash recovery validated live |
| G2 | Init through reviewed PR on a disposable repository | GitHub PR and Actions CI validated live; GitLab deferred at user request |
| G3 | Parallel surfaces and workflow variants/integrations | Workflow variants and local-source align-ds validated live; file retrieval, Kanban projection and grouped project metrics pass locally; external providers remain open |
| G4 | François, migration, upgrades, multi-platform packaging | V2 import, installed a1→a2 wheel upgrade and SQLite migration pass hosted CI on Ubuntu, macOS and Windows with Python 3.12/3.13; François-facing stdio and Darwin Unix service with replay/live follow pass; Windows named-pipe lifecycle passes hosted CI; external UI and release qualification remain open |
| G5 | AC01–AC30 and model qualification corpus | In progress: 25 passed, 4 partial, 0 blocked and 1 deferred; the model corpus remains open |

Current automated evidence: strict model validation, DAG validation, subscription gating,
write-conflict scheduling, reducer transitions, SQLite integrity and optimistic concurrency,
idempotent decisions, bounded checks, protocol handshake/errors, CLI honesty, lint, formatting,
strict typing, wheel/sdist build, and a fresh Python 3.12 wheel installation.
The disposable G1 vertical additionally proves an isolated implementation worktree, ownership
checks, a real local test command and an independent read-only Codex review; see
`docs/evidence/g1-codex-vertical-darwin-arm64.json`.
Controller recovery evidence is recorded separately in
`docs/evidence/g1-codex-recovery-darwin-arm64.json`.
Local G2 delivery evidence is recorded in `docs/evidence/g2-local-delivery.json`; it is not remote
GitHub/GitLab evidence.
Live GitHub evidence is recorded in `docs/evidence/g2-github-darwin-arm64.json`.
Live multi-surface Codex evidence is recorded in
`docs/evidence/g3-codex-multisurface-darwin-arm64.json`.
Live task/lease recovery evidence is recorded in
`docs/evidence/g3-codex-mid-wave-recovery-darwin-arm64.json`.
Live overlap-aware Fleet evidence is recorded in
`docs/evidence/g3-codex-fleet-darwin-arm64.json`.
Live intake-to-Patch evidence is recorded in
`docs/evidence/g3-codex-intake-patch-darwin-arm64.json`.
Live Audit/Refactor/Retro evidence is recorded in
`docs/evidence/g3-codex-maintenance-darwin-arm64.json`.
Local design and retrieval evidence is recorded in
`docs/evidence/g3-local-design-retrieval.json`; it is not external-provider evidence.
Live local-source align-ds evidence is recorded in
`docs/evidence/g3-codex-align-ds-darwin-arm64.json`; it is not Figma evidence.
Local Obsidian projection and metrics evidence is recorded in
`docs/evidence/g3-local-kanban-metrics.json`.
Local V2 migration, rollback and SQLite upgrade evidence is recorded in
`docs/evidence/g4-local-v2-migration-upgrade.json`.
Local François-facing protocol evidence is recorded in
`docs/evidence/g4-local-francois-protocol.json`; it is not external UI evidence.
Darwin Unix-service evidence is recorded in
`docs/evidence/g4-local-service-host-darwin-arm64.json`.
The hosted Windows runtime result is recorded in
`docs/evidence/g4-windows-named-pipe-implementation.json`; it validates the named-pipe lifecycle in
CI, not full real-host release support.
The complete acceptance ledger is stored in `docs/qualification/ac-matrix.json`. AC01 clean
installation evidence is recorded in `docs/evidence/g5-ac01-clean-install-darwin-arm64.json`; the
same verifier is part of every operating-system CI job.
Installed a1→a2 wheel upgrade evidence is recorded in
`docs/evidence/g5-ac26-installed-upgrade.json`; the verifier runs in each hosted CI job.
Codex control and hard-kill evidence is recorded in
`docs/evidence/g5-codex-control-darwin-arm64.json`; its permission retry result is explicitly
inconclusive and does not close AC30.
Direct read-only command refusals are recorded in
`docs/evidence/g5-ac30-runtime-sandbox-darwin-arm64.json`; agent-driven retry evidence is still
missing, so AC30 remains partial.
Live multi-session brainstorm evidence is recorded in
`docs/evidence/g5-codex-brainstorm-darwin-arm64.json`; it uses a synthetic read-only repository and
does not expose the Cohorte source checkout.

The following labels are prohibited until G5: “V2 parity”, “Claude supported”, “François
integrated”, and “multi-platform supported”. Codex support is limited to the exact combination in
`docs/evidence/g0-codex-darwin-arm64.json`; a provider mock or installed executable is not live
provider evidence.
