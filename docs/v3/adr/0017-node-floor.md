# ADR-0017: Node.js support floor — `^24.16.0 || >=26.1.0`

- **Status:** Provisional — **needs the human's sign-off** (it narrows spec 26)
- **Date:** 2026-09-18
- **Covers:** brief D4 ("Node floor: propose one and justify"); spec 26 "Node.js LTS supporté"
- **Design reference:** DESIGN.md §0.4, §11 D-2

## Context

On 2026-09-18: Node 22 is maintenance LTS until 2027-04-30; Node 24 is active LTS (maintenance from 2026-10-20, end 2028-04-30); Node 26
becomes LTS on 2026-10-28. Pi forces >= 22.19.0. `node:sqlite` is "active development" (1.1) on 22 and Release Candidate (1.2) from 24.15;
`crypto.randomUUIDv7()` exists from 24.16 / 26.1 and is absent on 22; native TypeScript type stripping is stable from 24.12. The state store
is the most critical V3.0 component (resume without dangerous duplicates). The maintainer runs Node 24.

## Decision

`"engines": { "node": "^24.16.0 || >=26.1.0" }`. CI matrix: 24.16.0 (the exact floor), latest 24.x, latest 26.x, on ubuntu and macos.

## Consequences

- One SQLite driver and one id generator, no polyfill dependency, one store test matrix.
- Users on Node 22 — still a supported LTS line for about seven months after this date — cannot install V3.0. This is a product decision, not
  only an engineering one.

## Revisit when

- The human refuses → fallback `>=22.19.0`: ship the `better-sqlite3` driver behind `SqlDriver` for the 22 line (doubles the store matrix), add
  a UUIDv7 dependency, and restrict `StateStore` to the `node:sqlite` API subset present on 22.
- Node 24 leaves active LTS and 26 is the mainstream line → consider raising the floor at a minor release.
- Pi raises its own floor above ours → follow it.
