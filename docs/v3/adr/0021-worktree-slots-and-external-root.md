# ADR-0021: Worktree slot per surface, own branch per agent, worktree root outside the repository

- **Status:** Provisional — a clarification of spec 15 and a default for spec 14; needs the human's awareness
- **Date:** 2026-09-18
- **Covers:** spec 14 (`worktrees/` "gitignored ou emplacement externe"), spec 15 ("worktree dédié")
- **Design reference:** DESIGN.md §5.1, §5.2, §5.7, §2.6.3, §11 D-10/D-11

## Context

Spec 15 says each build agent modifying code works in a dedicated worktree and agents sharing a surface are serialised or use a reservation.
A fresh worktree of a pnpm monorepo has no `node_modules`; provisioning it costs a full install. With worktrees *inside* the repository
(`.cohorte/worktrees/…`), Node, TypeScript, Biome and vitest resolve configuration and `node_modules` **upward into the user's main checkout**,
and the worktrees sit next to `.cohorte/state`. One proposal put worktrees under `~/.cohorte` while also hard-protecting and read-denying all
of `~/.cohorte`, which would have denied every agent write.

## Decision

1. **Default worktree root: `~/.cohorte/worktrees/<projectKeyId>/<runId>/`**, outside the repository. `git.worktreeRoot` may point at any
   other directory **outside the built-in protected roots**. `.cohorte/worktrees` is inside one (`<project>/.cohorte/**` is protected and
   not overridable), so every agent write there would be denied as `protected-root`: V3.0 **refuses** that value at config resolution
   (`configuration/worktree-root-protected`) instead of advertising an option that cannot work, and does not carve an exception into a
   non-overridable rule (deviation D-10).
2. The protected / `denyRead` set names **specific** directories — `~/.cohorte/{keys,versions,pi-agent,brains}` — never `~/.cohorte` as a
   whole, so the worktree root is writable by the agent that holds the slot and by nothing else.
3. **A slot per surface** (+ `_integration`, `_review-<n>`): a dedicated worktree that **at most one writing agent holds at a time** (slot
   lock). **Each agent gets its own branch**, created at the current integration head when it acquires the slot. The implementer and a later
   fixer of one surface reuse the directory and its provisioned dependencies; they never share a branch and never run concurrently.
4. Provisioning is keyed by `(slot, lockfile hash)` and re-runs only when the lockfile changes. Reusing provisioned dependencies is safe
   only because **agent-influenced code cannot write them**: dependency directories are read-only for agent commands and checks, never
   hardlinked into the package store (pnpm `clone-or-copy`, `nlink == 1` asserted), and their manifest digest is re-verified before each TEST
   (DESIGN 5.7). The package store is reached through an allowlisted `provision.env` channel, since the executor's scratch `HOME` hides it.

## Consequences

- No upward bleed of `node_modules`, `tsconfig`, lint or test roots from the main checkout into agent work — essential when dogfooding.
- Provisioning cost is once per surface per lockfile instead of once per agent.
- Spec 15's "dedicated worktree per build agent" is read as "no two agents ever share a worktree at the same time, and none shares a branch".
- Disk usage lives under the user's home; `cohorte gc` and `git.keepWorktrees` manage it; `doctor` reports the root and free space.

## Revisit when

- A user or reviewer insists on the literal reading (a fresh worktree per agent) → make it a policy switch; cost = one provision per agent.
- Tools in real projects require the worktree to be inside the repository tree (relative paths to sibling checkouts) → allow an in-repo
  root by defining the protected set as `<project>/.cohorte/**` minus the canonical configured root, with a path-table case and the
  upward-resolution caveats documented.
- Parallel fixers on one surface become desirable → needs file-level reservations (spec 28 V3.2+).
