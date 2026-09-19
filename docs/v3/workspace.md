# The V3 workspace

How the monorepo is put together, what is frozen, and what the warnings mean. Delivered by unit `U0.01`;
the rationale is in DESIGN §1, §7.0 and ADR-0016 / ADR-0017.

## Layout

```text
apps/cli/            the ONLY published package (`cohorte`); apps/daemon/ is a README, not a package
packages/<name>/     fifteen private, ESM-only, source-first packages (`@cohorte/<name>`)
tests/<suite>/       cross-package suites: integration, e2e, security, crash, dogfood, packaging, acceptance, live
scripts/             tooling, run as TypeScript by Node itself (no tsx, no build step)
legacy/v2/           Cohorte V2, reference only, on no execution path
docs/                a VitePress site with its OWN npm toolchain; docs/v3/ holds the V3 documents
```

`pnpm-workspace.yaml` lists `apps/*` and `packages/*` and nothing else: never `docs/`, never `legacy/`.

Toolchain: Node `^24.16.0 || >=26.1.0` (it runs `.ts` natively), pnpm 12.4.2, TypeScript 7.0.2 (`tsc` is
a type checker here and emits declarations only, into the ignored `dist-types/`), tsdown 0.23.0, vitest 5,
Biome 2.5.14 (exact, because `nursery/noFloatingPromises` is an error).

## Dependencies are declared once, by Wave 0

Every third-party dependency of 3.0 is in the `catalog:` of `pnpm-workspace.yaml`, the single source of
versions; every `package.json` says `"catalog:"`. `pnpm install` ran once. **No unit runs `pnpm install`,
`pnpm add`, or anything else that rewrites `pnpm-lock.yaml`.** If you need a dependency or a workspace
edge, write `docs/v3/requests/<unitId>.md`.

- `overrides` pin the three `@earendil-works/*` packages to `0.85.1` and `typebox` to `1.3.7`: pnpm
  ignores Pi's shrinkwrap, and two copies of `pi-ai` would break `instanceof ModelsError`.
- `allowBuilds: false` for `@google/genai`, `esbuild`, `protobufjs`: pnpm 12 refuses to install until
  each dependency with a build script has an explicit answer.
- `apps/cli` re-declares every third-party runtime dependency, Pi included. That is the
  silent-inlining guard of the bundle, and it is what makes `apps/cli/node_modules` the exact
  dependency set a linked gate build needs to run offline (PLAN F-7).

## The package graph is data: `layers.json`

`layers.json` is DESIGN 1.1/1.2 as data. Three kinds of edge:

| Kind | Declared as | Legal from |
|---|---|---|
| `normal` | `dependencies` + a tsconfig `references` entry | anywhere |
| `typeOnly` (`core -> persistence`, `tools -> persistence`) | `dependencies` + `references` | `src/**` with `import type` only, from the listed subpaths; anything from `test/**` |
| `dev` (`testkit` everywhere, `runtime-fake` + `persistence` in `core`, every package at the root) | `devDependencies` | `test/**`, `tests/**`, `scripts/**` only |

Four nets enforce it, and they do not overlap as much as DESIGN 1.2 says:

| Net | Catches | Does NOT catch |
|---|---|---|
| 1. pnpm links only what a package declares | an undeclared THIRD-PARTY import (it does not resolve) | an undeclared `@cohorte/*` import: the root declares every workspace package, so the name resolves from anywhere (next section) |
| 2. `tsc -b` over the project references | a reference cycle (TS6202); a RELATIVE import into another package (TS6059 + TS6307) | an import BY NAME of a workspace package the importer does not reference, undeclared or dev-only: exit 0, no diagnostic |
| 3. `node scripts/check-layers.ts` (rules a-h) | every import that is not an edge of `layers.json`, from `src/**` and from `test/**`; a dev-only or value-across-typeOnly import from `src/**` | — |
| 4. the bundle's per-entry import allowlist (tsdown `deps.onlyImport`, `U0.10`) | a third-party module inlined into, or imported by, the wrong entry | workspace edges: `@cohorte/*` packages are private and bundled, the allowlist says nothing about them |

`scripts/test/resolve-edges.test.ts` proves that every `package.json`, every `tsconfig.json` and the
installed `node_modules` agree with `layers.json`; `scripts/test/reference-net.test.ts` pins the two
columns of net 2 on a mirror of the real configuration.

`layers.json` is itself held to DESIGN 1.2 each time it is loaded (`validateLayers`, so by `check-layers`
and by `unit:check`): every `normal` and `typeOnly` edge goes DOWN the `layer` order `L0 .. L5`, sideways
only inside `L2` (never `L1 -> L1`), and the `dev` layer (`testkit`) is reached by `dev` edges alone. An
integrator who adds an edge that merely avoids a cycle, `security -> tools` for instance, gets a red
`check-layers` that names the two layers.

What the scanner reads as an import: `import` / `export … from` in every form, `import('x')` and
`` import(`x`) ``, `require('x')`, and `createRequire(…)('x')` directly or through the name the file binds
it to. A COMPUTED specifier is invisible to rules a-d; in shipped code rule g refuses the construct itself
(`import(` and `createRequire` alike, outside `apps/cli/src/lazy.ts` and
`packages/runtime-pi/src/child/load-pi.ts`).

### What pnpm strictness does NOT catch here

The repository root declares every `@cohorte/*` package (for `tests/**` and `scripts/**`). Node resolves
by walking up, so **any `@cohorte/*` name resolves from any package directory through the root
`node_modules`**, declared or not. An undeclared workspace import therefore runs under vitest.
Third-party names are different: `yaml`, `typebox`, `commander`, `picomatch` and Pi are declared by
packages only, never by the root, so an undeclared one does not resolve at all.

### What `tsc -b` does NOT catch either

Exports are source-first, so that name resolves, through a `node_modules` symlink, to the other
package's `.ts` sources. TypeScript 7.0.2 treats a file reached through `node_modules` as an external
library: it compiles those sources into the IMPORTER's program and reports nothing — no TS6307, no
TS6059, exit 0 — whether the package is undeclared or a `devDependencies`-only edge such as
`@cohorte/testkit` or `core -> runtime-fake`. (A declared edge is different and correct: it is read from
the reference's `dist-types/*.d.ts`.)

**So for an undeclared or dev-only `@cohorte/*` import from `src/**`, `check-layers` is the only net**
(rule a, rule d). That is why `unit:check` runs it too: a violation in a file the unit owns fails the
unit's own check instead of waiting for the gate. The fix for a missing edge is a request for the edge
(`docs/v3/requests/<unitId>.md`), never a relative import — that one `tsc -b` does refuse.

### The cyclic-workspace warning is expected

```text
[WARN] There are cyclic workspace dependencies: .../packages/base, .../packages/testkit, .../packages/config
```

`@cohorte/testkit` depends on every package, and every package lists `@cohorte/testkit` under
`devDependencies` (test-only). The cycle is dev-only, never reaches a bundle (`check-layers` rule d
forbids `testkit` from `src/**`), and is accepted (DESIGN 1.1, ADR-0016 item 7). It is also the reason
test files are not part of the composite TypeScript projects.

## Imports: barrels, contract entry points, areas

Every package exports, source-first (`types` and `default` both point at `.ts` sources):

| Subpath | Target | Use |
|---|---|---|
| `.` | `src/index.ts` | the barrel — frozen at G0 |
| `./contract` (`./schema` for config, `./catalogue` for tools, `./host-protocol` for runtime-pi, `./conformance` for runtime-contract and persistence) | the Wave-0 contract file | safe to import in any wave |
| `./*` | `src/*/index.ts` | one AREA: `@cohorte/security/decide/paths`, `@cohorte/persistence/memory`, `@cohorte/testkit/http-provider` |

Inside a parallel wave, import a finished area through its area subpath — **never the barrel of a
package that still has an active unit** (PLAN §3 rule 4): a barrel loads every area, so a sibling's
half-written file would break your typecheck and your tests.

## Three kinds of TypeScript project

| Config | What | Run by |
|---|---|---|
| `packages/*/tsconfig.json`, `apps/cli/tsconfig.json` (composite, `include: ["src"]`, colocated `*.test.ts` excluded) + root `tsconfig.json` (references only) | `tsc -b`: shipped code, in dependency order | Wave 0 and integrators |
| `tsconfig.tests.json` (non-composite, `noEmit`) | every test file, `tests/**`, `scripts/**`, `packages/testkit/**`, `fixtures/**/*.ts`, and the config files no composite project includes (`vitest*.config.ts`, `apps/*/*.config.ts`) — what keeps `expectTypeOf`, `@ts-expect-error` and the Pi API `type-proof.ts` alive after their wave | `pnpm typecheck`, `pnpm verify`, CI |
| `tsconfig.checks/<unit>.json` (GENERATED from `docs/v3/plan.json`) | only what ONE unit owns | `pnpm --reporter=silent unit:check <unitId>` |

`isolatedDeclarations` is off repo-wide (ADR-0016: exported TypeBox consts fail with TS9010/TS9013).

## Tests are discovered by file suffix

`*.test.ts` unit · `*.itest.ts` integration · `*.e2e.ts` e2e · `*.live.ts` live (own config, never in a
default run). Helpers and tables under `test/` are never collected, and nobody edits `vitest.config.ts`.

The suffix is half of it; the LOCATION is the other half. `vitest.config.ts` collects `*.test.ts` under
`{packages,apps}/*/{src,test}` and `scripts/test`, `*.itest.ts` under `{packages,apps}/*/test` and
`tests/integration`, `*.e2e.ts` under `tests/<suite>`. A `*.e2e.ts` inside a package, an `*.itest.ts`
under `src/`, a `*.test.ts` under `tests/` never run. `unit:check` fails on such a file when the unit
owns it, and warns about any other test-looking name (`*.spec.ts`, a `.tsx` / `.mts` / `.js` extension)
because that one may be fixture data.
`legacy/**`, `.cohorte/**`, `.build/**`, `**/dist/**`, `**/node_modules/**` are excluded from vitest,
Biome and every tsconfig.

## Commands

pnpm 12.4.2 rejects the short flag of `pnpm --reporter=silent <script>` (`unexpected argument '-s'`); the quiet spelling is
`pnpm --reporter=silent <script>`. PLAN.md still prints the old one (request `U0.01` R1).

| Command | Who |
|---|---|
| `pnpm --reporter=silent unit:check <unitId>` — tsc on owned paths (foreign diagnostics are warnings) + `biome check` on owned paths + `check-layers` (read-only; a violation in an owned file is red, elsewhere a warning) + `vitest run --maxWorkers=2 <testPaths>` with a private cache in `.build/.vitest/<unit>`; red when no test file matched, when ONE of the `testPaths` selects no file on its own (checked with `vitest list`, which runs nothing), or when an owned `*.test.ts` / `*.itest.ts` / `*.e2e.ts` sits where no vitest project collects it (see below) | any unit |
| `pnpm --reporter=silent verify` — frozen offline install, `tsc -b`, `tsc -p tsconfig.tests.json`, `biome ci .`, `check-layers`, `check-contract-words`, `gen-schemas --check`, unit + integration tests | Wave 0 and integrators |
| `node scripts/gen-unit-checks.ts [--check]` — regenerate / verify `tsconfig.checks/**` | Wave 0 and integrators |
| `COHORTE_CHECKPOINT_DIR=<abs dir outside the repo> node scripts/checkpoint.ts G<n>` — rollback checkpoint, never a commit | integrators |
| `pnpm --reporter=silent legacy:test` — the seven V2 suites, from `legacy/v2`, with a throwaway `HOME` | anyone |

`verify`, `build`, `pack:check` and `gen:schemas` name scripts that later Wave-0 units deliver
(`scripts/gen-schemas.ts`: `U0.G`; `scripts/build.ts`, `scripts/pack-check.ts`: `U0.10`).
