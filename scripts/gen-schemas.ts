#!/usr/bin/env node
// scripts/gen-schemas.ts — DESIGN 0.1 C3 / 1.4 step 1: TypeBox is the ONLY place a wire shape is written, and
// `schemas/*.schema.json` is its generated, committed, OPEN projection. Every document below is produced by the
// protocol's own `toOpen*` functions (packages/protocol/src/compile.ts), so forward compatibility is a property of
// that generator rather than of each author's discipline.
//
// `--check` regenerates in memory and BYTE-compares with the files on disk. It never runs `git diff`: nothing is
// committed on `feat/v3-rewrite` while the rewrite is in flight (PLAN F-2), so a `git diff --exit-code schemas/`
// would prove nothing here.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { JsonValue } from '@cohorte/base';
import { CohorteConfig, Manifest, Ownership, SkillManifest, Spec, TrustRecord } from '@cohorte/config/schema';
import { RunSnapshotManifest } from '@cohorte/core/contract';
import { ProjectModel, ReconcilePlan } from '@cohorte/project-model/contract';
import {
  AgentOutput,
  catalogue,
  DOCUMENT_NAMES,
  type DocumentName,
  toOpenCommandsJsonSchema,
  toOpenDocumentJsonSchema,
  toOpenSchema,
} from '@cohorte/protocol';
import { RuntimeCapabilities } from '@cohorte/runtime-contract';
import { FakeScriptSchema } from '@cohorte/runtime-fake';
import { PolicyVerdict, SandboxCapabilities } from '@cohorte/security/contract';
import { CATALOGUE_ROWS } from '@cohorte/tools/catalogue';

// `typebox` is declared by the PACKAGES, never by the repository root (workspace.md: third-party names do not
// resolve from `scripts/**`), so this file names no TypeBox type of its own: what a `toOpen*` function accepts is
// read off that function, and every hand-built document below is plain JSON that goes through the same generator.
type AuthoredSchema = Parameters<typeof toOpenSchema>[0];

export const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const SCHEMA_ID_PREFIX = 'https://cohorte.dev/schemas/3/';

/** Where a published schema comes from. The AC-07 identifier scan covers `protocol` and `runtime-contract` only. */
export type SchemaOrigin =
  | 'protocol'
  | 'runtime-contract'
  | 'runtime-fake'
  | 'config'
  | 'project-model'
  | 'core'
  | 'security'
  | 'tools';

export interface SchemaSource {
  /** published as `schemas/<name>.schema.json` */
  readonly name: string;
  readonly origin: SchemaOrigin;
  readonly build: () => JsonValue;
}

export const schemaId = (name: string): string => `${SCHEMA_ID_PREFIX}${name}.schema.json`;

const isObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A whole published DOCUMENT from one authored schema: dialect, stable `$id`, title, then the open body.
 *
 * The header is spread TWICE on purpose. A later key wins in an object spread, so `{ ...header, ...open }` alone
 * would let an authored schema that carries its own `title` (or `$id`, or `$schema`) silently replace the published
 * one — the generator, not the author, owns those three (DESIGN 0.1 C3, compat.md §1). Repeating the header last
 * gives it the value while the FIRST spread keeps its place in the key order, so the published bytes are unchanged
 * (fix round 1).
 */
export function openDocument(name: string, title: string, schema: AuthoredSchema): JsonValue {
  const open = toOpenSchema(schema);
  if (!isObject(open)) throw new TypeError(`${name}: the open form of an authored schema must be an object schema`);
  const header = { $schema: SCHEMA_DIALECT, $id: schemaId(name), title };
  return { ...header, ...open, ...header };
}

const fromSchema = (name: string, origin: SchemaOrigin, title: string, schema: AuthoredSchema): SchemaSource => ({
  name,
  origin,
  build: () => openDocument(name, title, schema),
});

/** A source whose document the protocol builds whole (it carries its own `$schema`, `$id` and title). */
const fromBuilder = (name: string, origin: SchemaOrigin, build: () => JsonValue): SchemaSource => ({
  name,
  origin,
  build,
});

const DOCUMENT_ORIGIN: SchemaOrigin = 'protocol';

/** TypeBox keeps its bookkeeping under non-enumerable and `~`-prefixed keys: a JSON round trip leaves the schema. */
const plain = (schema: unknown): JsonValue => JSON.parse(JSON.stringify(schema)) as JsonValue;

/**
 * The catalogue of DESIGN 2.7 as ONE published table: a tool call `{ name, input }` with a branch per known tool
 * narrowing `input` to that tool's authored schema and pinning the row's `effect` / `terminal`, plus the catch-all
 * branch every open table carries (a tool added in a MINOR). `tools` authors no envelope of its own, so this is the
 * one place its rows become a wire shape. The whole document is authored first and opened ONCE, so cyclic
 * definitions are hoisted to one root `$defs` rather than repeated per branch (U0.04 R4).
 */
function toolCatalogueSchema(): JsonValue {
  const names = CATALOGUE_ROWS.map((row) => row.name);
  const branches: JsonValue[] = CATALOGUE_ROWS.map((row) => ({
    title: row.name,
    description: row.description,
    properties: {
      name: { const: row.name },
      input: plain(row.inputSchema),
      effect: { const: row.effect },
      terminal: { const: row.terminal },
    },
  }));
  branches.push({
    title: 'a tool added by a later minor version: readers MUST ignore it',
    properties: { name: { not: { enum: names } } },
  });
  return openDocument('tool-catalogue', 'Cohorte tool catalogue: a tool call, one branch per tool of DESIGN 2.7', {
    type: 'object',
    required: ['name', 'input'],
    properties: {
      name: { type: 'string', description: 'the tool as the catalogue names it' },
      input: { description: "the call's arguments, narrowed by the branch for this tool" },
      effect: { type: 'string', description: 'read | write | execute | network | control' },
      terminal: { type: 'boolean', description: 'a terminal tool ends the agent turn' },
    },
    oneOf: branches,
  });
}

/**
 * Every schema this repository publishes, in file-name order. The six of spec 4 (`config`, `project-model`, `spec`,
 * `run-state`, `events`, `agent-output`) are here together with the protocol documents of DESIGN 2.3.4/2.3.5 and the
 * standalone `[S]` shapes DESIGN names: a schema-only client (AC-07) reads nothing else.
 */
export const SCHEMA_SOURCES: readonly SchemaSource[] = [
  fromSchema('agent-output', 'protocol', 'Cohorte agent output (submit_result)', AgentOutput),
  fromBuilder('commands', 'protocol', () => toOpenCommandsJsonSchema()),
  fromSchema('config', 'config', 'Cohorte project configuration (.cohorte/config.yaml)', CohorteConfig),
  fromBuilder('events', 'protocol', () => catalogue.toOpenJsonSchema()),
  // PLAN U1.INT ("gen-schemas adds fake-script.schema.json") and docs/v3/requests/U1.06.md R5: the `[S]` shape of
  // DESIGN 3.10, exported as `FakeScriptSchema` because a TypeBox const sharing the name of its recursive type is
  // the Biome overflow of U0.02 R1. `runtime-fake` is its own origin: the AC-07 identifier scan covers `protocol`
  // and `runtime-contract` only, and a scripted-runtime input is neither.
  fromSchema('fake-script', 'runtime-fake', 'Cohorte fake-runtime script (--runtime fake --script)', FakeScriptSchema),
  fromSchema('manifest', 'config', 'Cohorte installation manifest (.cohorte/manifest.yaml)', Manifest),
  fromSchema('ownership', 'config', 'Cohorte surface ownership map (.cohorte/ownership.yaml)', Ownership),
  fromSchema('policy-verdict', 'security', 'Cohorte policy verdict (policy explain)', PolicyVerdict),
  fromSchema('project-model', 'project-model', 'Cohorte project model (discover --json)', ProjectModel),
  fromSchema('reconcile-plan', 'project-model', 'Cohorte reconcile plan (reconcile --plan --json)', ReconcilePlan),
  fromSchema('run-snapshot-manifest', 'core', 'Cohorte run snapshot manifest', RunSnapshotManifest),
  fromSchema('runtime-capabilities', 'runtime-contract', 'Agent runtime capabilities', RuntimeCapabilities),
  fromSchema('sandbox-capabilities', 'security', 'Cohorte sandbox capabilities (doctor)', SandboxCapabilities),
  fromSchema('skill', 'config', 'Cohorte skill manifest (skills/<id>/skill.yaml)', SkillManifest),
  fromSchema('spec', 'config', 'Cohorte specification (specs/<id>.yaml)', Spec),
  fromBuilder('tool-catalogue', 'tools', toolCatalogueSchema),
  fromSchema('trust-record', 'config', 'Cohorte trust record (~/.cohorte/trust/<projectKeyId>.json)', TrustRecord),
  ...DOCUMENT_NAMES.map((name: DocumentName) =>
    fromBuilder(name, DOCUMENT_ORIGIN, () => toOpenDocumentJsonSchema(name)),
  ),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const SCHEMA_NAMES: readonly string[] = SCHEMA_SOURCES.map((source) => source.name);

/**
 * AC-07 (DESIGN 7.5, ADR-0005 item 7): the identifier scan covers the schemas generated from `@cohorte/protocol` and
 * `@cohorte/runtime-contract` — the protocol IS the frontier that may not name an engine. `config.schema.json` is
 * deliberately OUTSIDE it: a project's config legitimately names the harness it configures (`runtime.pi`,
 * `authentication.anthropicSubscriptionViaPi`), so scanning `schemas/**` would make gate G0 red by construction.
 */
export const PROTOCOL_SCHEMA_NAMES: readonly string[] = SCHEMA_SOURCES.filter(
  (source) => source.origin === 'protocol' || source.origin === 'runtime-contract',
).map((source) => source.name);

export const fileNameOf = (name: string): string => `${name}.schema.json`;

/** Byte-for-byte what a file holds: two-space JSON and a trailing newline, so a diff is a diff. */
export const serialize = (schema: JsonValue): string => `${JSON.stringify(schema, null, 2)}\n`;

export type DifferenceReason = 'missing' | 'different' | 'unexpected';

export interface SchemaDifference {
  readonly file: string;
  readonly reason: DifferenceReason;
}

export interface GenSchemasResult {
  readonly ok: boolean;
  readonly schemasDir: string;
  readonly names: readonly string[];
  /** written in write mode, would-be-written in check mode */
  readonly written: readonly string[];
  readonly removed: readonly string[];
  readonly differences: readonly SchemaDifference[];
}

export interface GenSchemasOptions {
  readonly repoRoot: string;
  readonly check: boolean;
}

/**
 * Regenerate (or verify) `schemas/**`. A `.json` file under `schemas/` that no source claims is `unexpected`: it is
 * removed in write mode and fails `--check`, so a renamed document cannot leave a stale schema behind for a reader to
 * find. The filter is deliberately `.json` and not "every entry": what a schema-only client (AC-07) loads is a JSON
 * file, and a write run that deleted arbitrary neighbours would be a wider power than the freshness rule needs.
 */
export async function generateSchemas(options: GenSchemasOptions): Promise<GenSchemasResult> {
  const schemasDir = join(resolve(options.repoRoot), 'schemas');
  const generated = new Map<string, string>();
  for (const source of SCHEMA_SOURCES) generated.set(fileNameOf(source.name), serialize(source.build()));

  const existing = existsSync(schemasDir) ? readdirSync(schemasDir).filter((entry) => entry.endsWith('.json')) : [];
  const differences: SchemaDifference[] = [];
  const written: string[] = [];
  const removed: string[] = [];

  for (const [file, content] of generated) {
    const path = join(schemasDir, file);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current === content) continue;
    differences.push({ file, reason: current === undefined ? 'missing' : 'different' });
    written.push(file);
  }
  for (const file of existing) {
    if (generated.has(file)) continue;
    differences.push({ file, reason: 'unexpected' });
    removed.push(file);
  }

  if (!options.check) {
    mkdirSync(schemasDir, { recursive: true });
    for (const file of written) writeFileSync(join(schemasDir, file), generated.get(file) as string, 'utf8');
    for (const file of removed) rmSync(join(schemasDir, file), { force: true });
  }

  return {
    ok: !options.check || differences.length === 0,
    schemasDir,
    names: SCHEMA_NAMES,
    written,
    removed,
    differences,
  };
}

/** Node's own resolution of this file's repository root, so `pnpm gen:schemas` works from any cwd. */
export const REPO_ROOT = resolve(import.meta.dirname, '..');

function report(result: GenSchemasResult, check: boolean): string {
  if (check) {
    if (result.ok) return `gen-schemas: ${result.names.length} schema(s) up to date\n`;
    const lines = result.differences.map((difference) => `  ${difference.reason.padEnd(10)} ${difference.file}`);
    return `gen-schemas --check: schemas/ is out of date; run \`pnpm gen:schemas\`\n${lines.join('\n')}\n`;
  }
  const changed = result.written.length + result.removed.length;
  return changed === 0
    ? `gen-schemas: ${result.names.length} schema(s) already up to date\n`
    : `gen-schemas: ${result.names.length} schema(s); ${result.written.length} written, ${result.removed.length} removed\n`;
}

/**
 * `gen-schemas.ts [--check] [--root <repository root>]`. `--root` is a repository ROOT, whose `schemas/` directory is
 * written or verified — the same concept `scripts/schema-compat.ts --root` names. It was spelled `--out` until fix
 * round 2, which read as an output directory in a repository where `scripts/build.ts --out` means exactly that.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, root: { type: 'string' } } });
  const check = values.check === true;
  const result = await generateSchemas({ repoRoot: values.root ?? REPO_ROOT, check });
  const text = report(result, check);
  if (result.ok) process.stdout.write(text);
  else {
    process.stderr.write(text);
    process.exitCode = 1;
  }
}

// `import.meta.main` (node >= 24.2), never a hand-rolled `import.meta.url === argv[1]` comparison: that one is false
// through a symlink and breaks on a path with a space (U0.10 fix round 1, finding 8).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `gen-schemas failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
