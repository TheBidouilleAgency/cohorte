# Cohorte Protocol compatibility rules (normative)

What a Cohorte release may change in the wire shapes under `schemas/`, and what a client may rely on.
Frozen at gate G0. Source of record: DESIGN §2.3.2 (the paragraph "Compatibility rules"), §7.6 (the
`schema-compat` CI job), ADR-0005 item 7. Enforced by `scripts/gen-schemas.ts`, `scripts/schema-compat.ts`
and, from Wave 5, the full five-check `schema-compat` job (`U5.07`).

`PROTOCOL_VERSION` is `1.0`. `.cohorte/manifest.yaml` records `protocol: { min: "1.0", max: "1.0" }` (R4).

## 1. What is published, and how

One authored TypeBox schema per wire shape, in exactly one place (DESIGN 0.1 C3). From it the generator
derives two forms:

| Form | Who runs it | What it does |
|---|---|---|
| **strict** | every Cohorte writer, before it emits or stores anything | every object that declares `properties` is closed; an open enum is `enum [...known]` |
| **open** | what is committed under `schemas/*.schema.json` and what a client compiles | no object is closed; an open enum is `{ "type": "string", "x-cohorte-known": [...] }`; a table of types is a `oneOf` over its discriminant **with a catch-all branch** for the types of a later minor |

Forward compatibility is therefore a property of the generator, not of an author's discipline.

`schemas/` is generated and committed. `node scripts/gen-schemas.ts --check` regenerates in memory and
compares byte for byte; it never consults `git diff` (nothing is committed while the rewrite is in flight,
PLAN F-2). A `.json` file under `schemas/` that no source claims fails the check and is removed by a write
run, so a renamed document can never leave a stale schema behind for a reader to find. The generator's
repository root is `--root <dir>` (the spelling `scripts/schema-compat.ts` uses); `--out` would read as an
output directory, which it is not.

Each published document is self-contained: `$schema` (2020-12), a stable `$id`
(`https://cohorte.dev/schemas/3/<name>.schema.json`), a title, and one root `$defs` holding each recurring
definition **once** (a repeated `$id` is what a second validator refuses; U0.04 R4). Compose authored
schemas and publish once — never embed one published document inside another.

## 2. MINOR (no client breaks)

A MINOR release **may**:

- add an event type, and add a command;
- add an **optional** field to any payload, envelope or document;
- add a value to an `OpenEnum` (a value already published under `x-cohorte-known` is never removed);
- add a `$defs` definition;
- relax a constraint (a wider `maximum`, a looser `pattern`, a dropped `required` entry).

A MINOR release **may not** do anything in §3, whatever the reason.

## 3. MAJOR (a client may break)

A MAJOR release is required to:

- remove or rename an event type, a command, a document, a field, or a `$defs` definition;
- add a **required** field, anywhere;
- change the type of a field, or narrow a closed enum;
- close an open enum (drop `x-cohorte-known` for a plain `enum`);
- change the **durability** of an event type;
- change an `$id`, or `PROTOCOL_VERSION`.

Every MAJOR change ships with a numbered migration and a golden fixture (DESIGN 7.6 check 4).

## 4. What a reader MUST do

A client that wants to survive a MINOR:

1. **Ignore an unknown `type`.** Both tables (`events`, `commands`) carry a catch-all branch, so an envelope
   of a later minor still validates; a reader that switches exhaustively on `type` must have a default.
2. **Ignore an unknown field.** No published object is closed. Do not re-add `additionalProperties: false`.
3. **Ignore an unknown open-enum value.** `x-cohorte-known` is documentation of what THIS version knows, not
   a constraint; the value space is `string`.
4. **Read the durability off the envelope**, never off a hard-coded table: `durability` is pinned per branch
   in the published schema.
5. **Order by `(sequence, sub)`**, never by `timestamp` (DESIGN 2.3.2, the ordering rule under batching).

A client that does these five things needs no Cohorte code: `ajv/dist/2020` in strict mode, plus the
`x-cohorte-known` keyword declared as annotation-only and `ajv-formats` for `date-time`, compiles every
document in `schemas/` (AC-07; this is what `scripts/schema-compat.ts --self` proves on every gate).

## 5. Where an engine may be named

The "no Pi identifier" rule (R10, spec 17, AC-07) is about the **protocol**. The identifier scan of gate G0
covers the schemas generated from `@cohorte/protocol` and `@cohorte/runtime-contract`:

```text
agent-output  auth-status  command-result  commands  doctor-report  events  inspect
project-status  run-diff  run-state  runtime-capabilities
```

`schemas/config.schema.json` is deliberately **outside** it: a project's configuration legitimately names the
harness it configures (`runtime.pi`, `authentication.anthropicSubscriptionViaPi`), and "via Pi" is exactly the
information the billing caveat needs (ADR-0005 item 7). Scanning all of `schemas/` would make the gate red by
construction. The list is data — `PROTOCOL_SCHEMA_NAMES`, exported by `scripts/gen-schemas.ts` — so the scan
and the generator can never disagree.

`runtimeRef` (R8) stays optional and opaque: a client may display it, never parse it.

## 6. The checks, and who runs them

| # | Check | Where |
|---|---|---|
| 1 | `gen-schemas --check`: the committed schemas are what the TypeBox sources produce | `pnpm verify`, CI `schema-compat` |
| 2 | every `schemas/*.schema.json` compiles under `ajv/dist/2020` **strict** | `scripts/schema-compat.ts --self`, gate G0 on |
| 3 | golden instances of every past release validate under the new schemas | `U5.07` |
| 4 | structural diff against the last release tag: a removal, a new `required`, a narrowed closed enum, a changed type or a changed durability is BREAKING | `U5.07` |
| 5 | forward tolerance: the previous release's open schema accepts the new golden stream | `U5.07` |

Checks 1 and 2 need only the release under test and run from gate G0 on. Checks 3-5 need a published
previous release; `scripts/schema-compat.ts` is the file they grow into.

Golden instances live in `fixtures/schema-compat/<version>/`, one flat file per case. The file name names the
schema the instance must validate against, in one of four forms:

| File name | Schema |
|---|---|
| `event.<type>.json` | `events` (a complete envelope) |
| `command.<type>.json` | `commands` |
| `document.<name>[.<variant>].json` | `<name>` |
| `schema.<name>[.<variant>].json` | `<name>` |

`<name>` is any of the published schemas, not only the seven protocol documents: `schema.agent-output.json`,
`schema.config.json` and `schema.tool-catalogue.json` are as addressable as `document.run-state.json`, and
the two kinds resolve identically — `schema.` exists because a fixture for a project's config or for the tool
catalogue is not a protocol *document*. The optional `<variant>` suffix is dropped one dot-segment at a time,
so `document.command-result.completed.json` validates against `command-result`. **Every published schema must
be addressable**, or checks 3 and 5 could never cover it. A fixture whose name names no schema fails the job
rather than being silently skipped.
