# legacy/v2 — Cohorte V2 sources (reference only)

This directory is the complete V2 code base (`2.10.0`), moved here by `git mv` when the V3 rewrite started
(DESIGN D8, ADR-0014).

**Nothing in here is on the V3 execution path.**

- No V3 file imports from `legacy/v2`. It is excluded from every tsconfig, from Biome, from vitest and from
  every bundle glob. `pnpm-workspace.yaml` does not list it, so it is not a workspace package.
- It is read as a reference when V2 logic is ported: the loop reducer, the verdict math, finding identity,
  the tree digest, the doctor check list and the gate cases are ported **with their test tables**, never
  reused as code (ADR-0014 item 3).
- It is not published. The V3 package `cohorte` is built from `apps/cli` and contains nothing from `legacy/`.

## What moved, what stayed

Moved: `bin core lib profile scripts install.sh install.ps1 package.json .npmignore`.

Stayed at the repository root: `LICENSE`, `CHANGELOG.md`, `README.md`, `docs/`, `.github/` and the brand
`assets/` directory (the README images are `raw.githubusercontent.com/.../main/assets/...` URLs, PLAN PC-2).
`bin/cli.js` copies `CHANGELOG.md` into an install only when the file sits beside it, so a V2 install made
from this directory carries no changelog; nothing tests for it.

## Running the V2 suites

```sh
pnpm legacy:test           # from the repository root (quiet: pnpm --reporter=silent legacy:test)
node run-suites.mjs        # from this directory
```

`run-suites.mjs` runs the seven V2 suites (`validate-core`, `test-workflows`, `test-adapter`, `test-gate`,
`test-lib`, `test-kanban`, `test-metrics`) with this directory as the working directory and a throwaway
`HOME`. The throwaway `HOME` is not cosmetic: `lib/runtime.js` reads `os.homedir()` directly, so on a
machine that has a real `~/.cohorte/<runtime>/` install `test-lib` reports three false failures.

## The one edit made after the move

`scripts/validate-core.mjs` cross-checks the text of `.github/workflows/ci.yml` relative to its own root,
which is now `legacy/v2/`, where no workflow exists. Every such check was already guarded by "only when
the file is there" except the workflow-script one; that guard was added. The V3 `ci.yml` keeps a
`legacy-v2` job that runs these suites, and no longer dry-runs the V2 installers.
