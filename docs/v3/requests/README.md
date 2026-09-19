# docs/v3/requests — how a unit asks for a change it may not make

A unit edits files **only** under the paths it owns (`docs/v3/plan.json`, `ownedPaths`). Everything else
is somebody else's, or structural (PLAN §3 rules 1-2): root configuration, every `package.json` and
`tsconfig.json`, the lockfile, `layers.json`, every `src/index.ts` barrel, the CLI registry, `schemas/**`,
and — after gate G0 — every frozen contract.

When you need one of those changed, do not make the change. Write **`docs/v3/requests/<unitId>.md`**
(the one file outside your owned paths that is always yours) and keep working against a local adapter
or a local fake.

## Format

One section per request:

```markdown
## R1 — <one line: what should change>

- **Where:** the file(s) and, for a contract, the exported name
- **Why:** what breaks or cannot be written without it (paste the error, name the test)
- **Proposed change:** the exact diff or the exact new signature
- **Meanwhile:** what your unit does until the gate (local adapter, local fake, skipped-with-reason test)
- **Affects:** other units that read the same thing, if you know them
```

Typical requests: a dependency or a `devDependencies` edge (nobody but Wave 0 and the integrators may
touch the lockfile), an export missing from a barrel, a contract field, a `layers.json` edge or rule
exemption, a vitest or Biome setting.

## What happens to it

The wave's integrator (`U<n>.INT`; `U0.G` for Wave 0) reads every file here before running the gate,
applies or rejects each request, regenerates what depends on it (`gen-schemas`, `gen-unit-checks`), and
records the outcome — applied, rejected and why — in `docs/v3/gates/G<n>.md`. A request is never
applied silently and never by the unit that wrote it.
