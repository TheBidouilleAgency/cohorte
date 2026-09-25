# Changelog

Release notes for the Python Cohorte package. Add a dated section for each published version,
with the newest version first. Describe the verified scope and known limitations of a dev release.

## Unreleased

_No changes recorded yet._

## 1.0.0a10 — 2026-09-25

- Restore agent proposals in the guided `spec` flow: the profile's Codex or Claude agent suggests answers to open questions and a complete, project-grounded draft with scenarios, acceptance criteria, check IDs, tests, errors, migration and rollback. Suggestions run read-only and never resolve a user decision or freeze a spec automatically.
- Let users accept the proposed draft, continue with `--manual`, or request a proposal for an existing draft without losing its prior decisions. Reject proposed criteria that reference a surface or check outside the selected profile; clarify that a check prompt expects its ID, not a shell command.
- Validation: PR #64 passed documentation and Python 3.12/3.13 CI on Ubuntu, macOS and Windows. Integration tests cover new and existing drafts and preserve exact approval. Provider-live proposal quality remains to be verified in a real project run.
- Scope: this release improves the guided CLI; the planned graphical interface with shadcn is not included.

## 1.0.0a9 — 2026-09-24

- Complete the project-context handoff for Fleet integration: its independent review and correction agents now receive bounded, cited excerpts from the current candidate worktree. Fleet correction also receives every participating frozen spec and the project profile, alongside failed checks and findings.
- `patch`, `refactor`, and design alignment already use the common build/review/fix runner; `audit` supplies its own bounded source snapshot. This release closes the remaining independent agent prompt found in the workflow audit.
- Validation: PR #62 passed documentation and Python 3.12/3.13 CI on Ubuntu, macOS and Windows. A local integration test forces an integration finding and confirms that both Fleet review and fix receive current source evidence. Live Codex/Claude end-to-end quality remains to be verified by a project run.

## 1.0.0a8 — 2026-09-24

- Carry project-aware source references through the guided feature workflow. `spec` shows current and brief-linked file leads before decisions are frozen; `build`, `review`, and `fix` each receive bounded, cited excerpts from their current worktree alongside the frozen spec and profile. Multi-surface implementers and integration reviewers receive the same context.
- Recognize code in nonstandard surface roots such as `backend/`, and refresh excerpts between phases so review can inspect source changed by build. Excerpts remain untrusted reading leads; agents must inspect full files, and product facts outside the repository still need explicit decisions.
- Validation: PR #60 passed documentation and Python 3.12/3.13 CI on Ubuntu, macOS and Windows. Local tests cover spec references, all feature-agent phases, multi-surface prompts and changed-source refresh. Live Codex/Claude end-to-end response quality and other maintenance workflows remain to be qualified.

## 1.0.0a7 — 2026-09-24

- Give every `brainstorm` panel contribution and its synthesis bounded excerpts of relevant local source and project notes, with path and line references. Recompute this context on each follow-up round so agents can see intervening file changes.
- Ask agents to inspect complete files before making code claims and to keep unsupported claims as assumptions. The local search is lexical and cannot establish that a behavior or file is absent; `--context` remains available for product facts outside the repository.
- Validation: PR #58 passed the documentation build and Python 3.12/3.13 CI matrix on Ubuntu, macOS and Windows. Local integration tests cover panel delivery, follow-up refresh, citations and private-file exclusion. Live Codex/Claude response quality on an existing project brief has not yet been retested.

## 1.0.0a6 — 2026-09-24

- Fix `cohorte service stop` hanging when an idle client remains connected to the Unix socket. The host now closes its client connections during shutdown, allowing the process to finish and remove its PID file.
- Add an integration test that reproduces the timeout with an initialized idle client and checks both the stop response and client disconnect.
- Validation: the regression test failed before the fix and passes afterward; the local Python suite, Ruff and mypy pass on Darwin arm64. The release workflow will repeat the Python 3.12/3.13 matrix on Ubuntu, macOS and Windows. Provider-live qualification and François UI coverage are unchanged from `1.0.0a5`.

## 1.0.0a5 — 2026-09-24

- Continue a guided brainstorm from a stored brief: the panel can ask another round of questions, retain previous answers, link revisions and show the resulting synthesis with `brief show`.
- Continue an `intake` with stored answers and an explicit feature or patch route. `brainstorm --from-intake` carries the source provenance and answers into the feature panel; `patch-spec --from-intake` guides a bounded fix with reproduction, regression check, write paths and rollback.
- Prepare guided specs with multiple surfaces, scenarios and acceptance criteria. Open questions can be answered on a later invocation, and a newer brief can be attached without erasing the existing draft. Multi-surface specs capture a shared contract before exact-hash approval.
- Restore the Cohorte logo, add an illustrated V3 workflow animation, and rewrite the README and VitePress first steps around concrete user situations. Clarify that `intake` is optional and does not change code.
- Document that a running local service retains its old version after a CLI upgrade until it is restarted; `service status` exposes the daemon version for comparison.
- Validation: PRs #54 and #55 passed hosted documentation and Python CI jobs on Ubuntu, macOS and Windows with Python 3.12 and 3.13. A bounded two-round Codex brainstorm probe passed on Darwin arm64; the new intake, spec and patch CLI paths have deterministic integration tests but have not received new live-provider qualification.
- Remaining scope: François UI integration is still partial in the qualification matrix. The full cross-provider model corpus and real-host qualification across target platforms remain open; this preview is not a claim of complete V2 parity.

## 1.0.0a4 — 2026-09-24

- Add `cohorte brief show FEATURE_ID` to read a stored brainstorm brief without rerunning the provider panel. Human-readable output includes the synthesis, open questions, user answers and independent contributions; `cohorte --json brief show FEATURE_ID` returns the structured brief and artifact reference.
- Scope the lookup to the current registered project and document the command in the CLI guide and README.
- Validation: the feature PR passed the hosted documentation job and Python CI matrix on Ubuntu, macOS and Windows with Python 3.12 and 3.13. The release candidate will be rebuilt and checked by the release workflow after merge.
- Scope limits remain unchanged from `1.0.0a3`: the guided spec handles one surface and one initial scenario/criterion; François's external UI integration, the cross-provider model corpus and real-host qualification across target platforms remain open.

## 1.0.0a3 — 2026-09-23

- Guide project setup and profile review from the current directory. `init` now inventories nested pnpm/npm workspaces, and `profile show`, `edit`, and `apply` support explicit corrections.
- Add concise interactive `intake`, `status`, and `brainstorm` flows while retaining explicit JSON commands for automation.
- Add `cohorte spec` and `cohorte start` for a single-surface path from a stored brainstorm brief to an exactly approved frozen spec and isolated run. Open questions block freezing; the approved spec and profile are verified before execution. Shipping still requires a separate decision.
- Publish a French VitePress guide with installation, workflow, CLI, profile, integration, and troubleshooting references. The site is built in CI and deployed through GitHub Pages.
- Validation: the documentation build and Python CI matrix passed on hosted Ubuntu, macOS, and Windows with Python 3.12 and 3.13. The guided run was exercised on a disposable repository with a test runtime; live provider behavior for this new interface has not yet been qualified.
- Scope limits: the guided spec handles one surface and one initial scenario/criterion; multi-surface specs still use the explicit file-based flow. François's external UI integration, the cross-provider model corpus, and real-host qualification across target platforms remain open.

## 1.0.0a2 — 2026-09-23

- Fix `cohorte brainstorm` after `cohorte init`: stored project profiles now reload through the strict JSON validation path. A live Codex run on a disposable project produced three independent perspectives and a synthesis.
- Restore Discord release announcements with a descriptive User-Agent, safe numeric error diagnostics, and a workflow to retry an existing announcement without republishing. The `1.0.0a1` announcement was delivered by the retry workflow.
- Scope limits remain unchanged from `1.0.0a1`: François UI integration and the full cross-provider, cross-platform model corpus are not yet certified.

## 1.0.0a1 — 2026-09-23

- First scoped preview of the Python Cohorte engine, published as `cohorte-engine` with the `cohorte` CLI. It is separate from the earlier npm package and its version series.
- Add durable SQLite workflows, isolated worktrees, review and fix gates, Fleet scheduling, V2 import, and local `cohorte/1` JSON-RPC service with event replay and run controls.
- Add official Codex and Claude SDK adapters, native login handoff, and common redacted turn, tool and usage events. Live provider evidence is currently bounded to the qualified Darwin arm64 accounts and runtimes.
- Qualify wheel installation and upgrade checks in CI on Ubuntu, macOS and Windows with Python 3.12 and 3.13; GitHub and GitLab delivery have also been exercised on disposable repositories.
- Scope limits: François's Python-service PR remains open, so real François UI integration is not yet certified. The two-provider model corpus and real-host qualification across all target platforms are not complete. This alpha is not a V2-parity or full-platform support claim.

## 0.1.0a1 — unreleased

- Start the Python 3.12 root rewrite with no dependency on former Cohorte implementations.
- Add strict contracts, a pure reducer, SQLite persistence and immutable artifacts.
- Add project discovery, readiness/auth gates, conflict-aware scheduling and controlled checks.
- Add the CLI, JSON-RPC stdio bridge, event replay and operation deduplication.
- Add Codex subscription inspection and an explicit read-only live verification probe.
- Certify Codex 0.155.1 read-only enforcement, interruption and session resume on Darwin arm64.
- Build and verify wheel/sdist packaging while keeping provider support explicitly uncertified.
