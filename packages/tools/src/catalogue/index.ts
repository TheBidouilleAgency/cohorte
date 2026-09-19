// @cohorte/tools/catalogue — DESIGN 2.7, frozen in Wave 0: both the prompts and the fake scripts meet on these
// shapes. `toToolGrant` is the ONLY place a `ToolGrant` (what the brain sees) is minted from the catalogue's own
// data, and it is where the flat-schema rule is ASSERTED, not merely hoped for.

import type { JsonValue } from '@cohorte/base';
import { toStrictSchema } from '@cohorte/protocol';
import {
  TOOL_INPUT_SCHEMA_FORBIDDEN_ROOT_KEYS,
  type ToolGrant,
  ToolGrant as ToolGrantSchema,
  toolGrantProblems,
} from '@cohorte/runtime-contract';
import type { ToolIntrospection } from '@cohorte/security/contract';
import { Compile } from 'typebox/compile';
import { EXEC_TOOLS } from '../impl/exec/index.ts';
import { READ_TOOLS } from '../impl/read/index.ts';
import { STATE_TOOLS } from '../impl/state/index.ts';
import { WRITE_TOOLS } from '../impl/write/index.ts';
import { CATALOGUE_ROWS } from './schemas.ts';
import type { ToolImplementation } from './types.ts';

export type {
  ApprovalRequestInput,
  CatalogueRow,
  GitCommitInput,
  GitDiffInput,
  ListFilesInput,
  NetworkRequestInput,
  PatchFileInput,
  PathArg,
  PathIntent,
  ReadFileInput,
  RunCommandInput,
  SearchInput,
  SecretReadInput,
  WriteFileInput,
} from './schemas.ts';
export { CATALOGUE_ROWS, GIT_DIFF_BASES, SEAM_TOOL_NAMES, TOOL_NAMES } from './schemas.ts';
export { stubImplementation } from './stub.ts';
export type {
  EffectIntent,
  EffectKind,
  EffectRecord,
  NormalizedCall,
  ReplayClass,
  ToolExecContext,
  ToolExecuteResult,
  ToolImplementation,
  ToolPlan,
} from './types.ts';

const rowByName = new Map(CATALOGUE_ROWS.map((row) => [row.name, row]));

/** `ToolIntrospection` is on the per-tool-call path (PLAN PC-4: the gate validates a call's shape without importing
 * `tools`), so the strict schema of every row is built ONCE, here: `schemaOf` returns the same object identity on
 * every call and a validator cache keyed by schema identity in the gate (U2.01/U2.02) keeps working. */
const strictSchemaByName = new Map<string, JsonValue>(
  CATALOGUE_ROWS.map((row) => [row.name, toStrictSchema(row.inputSchema) as JsonValue]),
);

/** One TypeBox compilation for the whole process, not one per minted grant. */
const GRANT_CHECK = Compile(ToolGrantSchema);

const isFlatObjectSchema = (schema: JsonValue): boolean => {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const record = schema as Record<string, JsonValue>;
  if (record.type !== 'object') return false;
  return TOOL_INPUT_SCHEMA_FORBIDDEN_ROOT_KEYS.every((key) => !(key in record));
};

/**
 * Mints the `ToolGrant` (what the brain sees) of one catalogue tool: the closed, strict form of its schema
 * (`toStrictSchema`, the same generator `@cohorte/protocol` uses everywhere else — DESIGN 0.1 C3), asserted to be
 * ONE flat top-level object with no `$ref`/`$defs`/`oneOf`/`anyOf`/`allOf` at the root (DESIGN 2.7).
 */
export function toToolGrant(name: string): ToolGrant {
  const row = rowByName.get(name);
  if (!row) throw new RangeError(`toToolGrant: unknown tool ${JSON.stringify(name)}`);
  const inputSchema = strictSchemaByName.get(name);
  if (inputSchema === undefined || !isFlatObjectSchema(inputSchema)) {
    throw new TypeError(`toToolGrant: ${name}'s input schema is not one flat top-level object`);
  }
  const grant: ToolGrant = {
    tool: row.name,
    description: row.description,
    inputSchema,
    effect: row.effect,
    terminal: row.terminal,
  };
  const problems = GRANT_CHECK.Errors(grant);
  const first = problems[0];
  if (first) throw new TypeError(`toToolGrant: ${name} does not validate against ToolGrant: ${first.message}`);
  return grant;
}

const namingProblems = toolGrantProblems(CATALOGUE_ROWS.map((row) => ({ tool: row.name })));
if (namingProblems.length > 0) throw new TypeError(`tool catalogue: ${namingProblems.join('; ')}`);

/** Catalogue-derived: never a second, hand-written copy of what a tool's input schema says (PLAN PC-4: `security`
 * validates a call's shape and path arguments without importing `tools`). */
export const toolIntrospection: ToolIntrospection = {
  schemaOf(tool) {
    return strictSchemaByName.get(tool);
  },
  pathArgsOf(tool, input) {
    const row = rowByName.get(tool);
    if (!row) return [];
    return row.pathArgsOf(input);
  },
};

/** The 9 V3.0 tools + the 3 seams, by name (DESIGN 2.7). Every value is `stubImplementation(name)` until Wave 2
 * replaces the bodies in `impl/**`; the metadata is already the catalogue's own. */
export const TOOL_CATALOGUE: Readonly<Record<string, ToolImplementation>> = Object.freeze({
  ...READ_TOOLS,
  ...WRITE_TOOLS,
  ...EXEC_TOOLS,
  ...STATE_TOOLS,
});
