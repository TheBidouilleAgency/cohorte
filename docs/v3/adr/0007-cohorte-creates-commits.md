# ADR-0007: Who creates commits — Cohorte (code), never an agent

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 7; brief D9 (commit part)
- **Design reference:** DESIGN.md §5.3, §2.6.4, §4.4

## Context

Spec 9 lists a `git_commit` tool; spec 15 says no agent may merge into a protected branch without capability and approval. An agent-made
commit would bypass the ownership audit and the secret scan, and git hooks are repository-controlled code that would run outside the gate.

## Decision

1. **Cohorte (TypeScript) creates every commit**, in agent worktrees, after the ledger audit, the ownership check of every changed path
   (catches writes made by commands) and the secret scan; commits carry `Cohorte-Run`, `Cohorte-Agent`, `Cohorte-Effect` and
   `Cohorte-Tree-Digest` trailers and go through the effect journal (`verifiable` by trailer).
2. Agents have **no commit capability**: `git_commit` is registered but granted to nobody, and agents have a built-in, non-overridable deny on
   `git commit|push|merge|rebase|reset|checkout|switch|worktree|config|update-ref`.
3. Besides result commits, Cohorte creates **checkpoint commits** (`cohorte(wip)`) at park/pause/suspension/failure/shutdown and immediately
   before any `at-most-once` command (ADR-0025).
4. Every Cohorte-run git invocation uses the hardened runner (hooks, fsmonitor, ssh, gpg signing disabled; global/system config ignored).
5. Anything touching the user's branch, a push or a PR needs the `release-manager` capability **and** human approval; none of it is built in V3.0.

## Consequences

- One place enforces ownership and secret hygiene before content becomes history; the trailer makes commits idempotent across crashes.
- User hooks (husky, commit-msg linters) never run on Cohorte's commits; commit identity is configurable (`user` + co-author, or `cohorte`).
- WIP commits appear on agent branches (no squash in V3.0); the integration branch receives one merge commit per agent branch.

## Revisit when

- Projects require their own hooks (formatters, DCO sign-off) on integrated commits → run them as gated, sandboxed checks rather than as hooks.
- A release phase (V3.1) needs agent-authored commit messages or signed commits → introduce a `release-manager` flow with approval.
- WIP commit noise is a problem for reviewers → squash agent branches at merge time.
