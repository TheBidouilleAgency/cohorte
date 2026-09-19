# ADR-0016: Toolchain — as researched, with `isolatedDeclarations` turned off

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** brief D4
- **Design reference:** DESIGN.md §1.4, §2 (authoring convention), §7.0, §11 D-4

## Context

The toolchain research verified a prototype: pnpm workspace, ESM-only, TypeScript 7.0.2 with `tsc -b` as a declaration-only type checker,
tsdown 0.23 single-bundle publish of one npm package with a sha256 asset manifest, vitest 5 with `projects`, Biome 2, TypeBox 1.x as the schema
source of truth, `node:sqlite`, commander, picomatch, `yaml`, spawned `git`. Its base tsconfig enables `isolatedDeclarations`.
**Verified conflict:** with exported TypeBox schema consts (the schema source of truth), `isolatedDeclarations: true` fails on every schema —
TS9010 / TS9013, 8 errors on a 2-schema file with TS 7.0.2 + typebox 1.3.7, 0 errors with the flag off (probe re-run by two judges).

## Decision

1. Adopt the researched toolchain, with **`isolatedDeclarations: false`** repo-wide. Declarations are emitted only by `tsc -b` (~0.1 s), so
   the flag buys nothing here. Kept: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`,
   `noUncheckedIndexedAccess`, `skipLibCheck: true` (mandatory with Pi's own `.d.ts` under NodeNext).
2. Source-first private packages; tsdown inlines workspace code, keeps every third-party dependency external, with `deps.onlyBundle: []` and a
   per-entry `deps.onlyImport` allowlist. Two entries: `cli` and `agent-host`. Publish from a staged directory with a generated `package.json`.
3. `typebox` pinned to Pi's exact `1.3.7`; the three Pi packages exact + pnpm `overrides`; pnpm `allowBuilds: false` for `@google/genai`,
   `esbuild`, `protobufjs`.
4. vitest 5 **`projects` in `vitest.config.ts`** (no workspace file), selection by file suffix; scripts run as `.ts` on native Node type
   stripping (no `tsx`).
5. No `@anthropic-ai/sandbox-runtime` in V3.0 (ADR-0003); in-house logger; `crypto.randomUUIDv7`.
6. **Tests are typechecked by their own root project.** `tsc -b` covers `src/` only (tests cannot join the composite projects: `testkit` ↔
   packages would be a reference cycle) and vitest does not typecheck. A non-composite `tsconfig.tests.json` (tests, `tests/**`,
   `scripts/**`, testkit) runs in `pnpm verify` and in the CI jobs `typecheck` and `pi-latest`; without it every type-level guarantee
   (sealed drafts, brands, the Pi API `type-proof.ts`) would be inert after the wave that wrote it.
7. **Test-only workspace edges are declared, as `devDependencies`** (`testkit` everywhere, `runtime-fake` + `persistence` in `core`, every
   package in the root): pnpm resolves nothing undeclared and no unit may touch the lockfile. `check-layers` forbids them from `src/**`.
   The resulting cyclic-workspace warning is accepted.
8. **A `--out` build is made runnable by a `node_modules` symlink** to `apps/cli/node_modules` (the bundles keep their third-party imports
   external, and under pnpm's strict layout nothing resolves from `.build/`). The link is never packed; `pack-check` still proves the
   installed tarball.

## Consequences

- Wave-0 typecheck passes with TypeBox as the single place a wire shape is written.
- Exported API surfaces are not forced to carry explicit annotations; internal packages are never published, so this costs nothing.

## Revisit when

- TypeBox (or TypeScript) makes schema consts compatible with `isolatedDeclarations` → re-enable for faster parallel declaration emit.
- vitest 5 (weeks old) shows blocking bugs → fall back to 4.1.x (API parity to be checked).
- tsdown changes `onlyImport`/`onlyBundle` semantics → re-verify the silent-inlining guard in the packaging test.
