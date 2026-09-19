# ADR-0023: A run belongs to its install — resuming under a different runtime is refused

- **Status:** Provisional — needs the human's awareness (it can strand a run across an in-place upgrade)
- **Date:** 2026-09-18
- **Covers:** spec 3 principle 8, spec 16, spec 26 ("une mise à jour ne remplace jamais le runtime d'un run actif"), spec 29
- **Design reference:** DESIGN.md §6.2, §6.3, §4.4 step 4, §3.9

## Context

Spec principle 8 says a Cohorte update never changes the code executed in the middle of a run; spec 29 repeats it as an acceptance criterion.
Two proposals shipped a convenience flag (`--adopt-runtime`, `--accept-runtime-change`) letting a human re-pin a live run onto a different
install. That is a documented way of doing exactly what the spec says never happens, and none listed it as an open question.

## Decision

1. At run start Cohorte captures a snapshot (app version, package manifest, git hash, schemas, prompts, skills, config, active runtime) and a
   `RuntimePin` covering every file under the install's `dist/`, the full package trees of the three Pi packages, the install's lock evidence
   and the Node binary. Everything a run reads afterwards comes from the content-addressed snapshot through `PinReader` (hash re-verified on
   every read).
2. `runs.pinned_install_dir` records the install. **The detached host is always spawned from that directory**, at start and at every resume,
   after its hashes verify — never from whichever CLI the user invoked. Side-by-side installs (`~/.cohorte/versions/<version>-<sha8>/`,
   produced by `scripts/dogfood-install.ts`) make a newer CLI transparently re-exec the pinned one.
3. If the pinned files are gone or changed, `resume` **refuses** (`runtime-incompatible` ⇒ BLOCKED, remediation: reinstall the pinned version
   or cancel the run). **No adopt/accept flag exists in V3.0.**
4. The run host refuses to start when its own bundle is inside the target repository or a worktree (`security/runtime-inside-target`).
5. The pin is re-verified before every agent spawn; the install dir and `~/.cohorte/versions` are protected roots for every tool and command.

## Consequences

- "New code only at the next run" holds across crashes and resumes, not only while one process lives.
- A user who upgrades a global install in place while a run is suspended must reinstall the old version (or cancel) to continue it.
- Transitive dependencies of Pi are covered by lock evidence only; `runtimePinning` is reported `partial`.

## Revisit when

- Users are repeatedly stranded by in-place upgrades → consider making side-by-side installs the default install layout, or — only then — an
  override that is an approval-backed, MAC-authenticated event, off by default, with its own acceptance test.
- A state-compatible hotfix must reach live runs (e.g. a security fix in the gate) → define a signed "compatible runtime set" rather than a
  blanket adopt flag.
