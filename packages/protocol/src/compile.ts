// DESIGN 0.1 C3 / 2.3.2 — TypeBox is the only place a wire shape is written. From ONE authored schema this file derives:
//   strict (writer side):   every object is closed, an OpenEnum is `enum [...known]`
//   open (published side):  no object is closed, an OpenEnum is { type: 'string', 'x-cohorte-known': [...] },
//                           and a table of types becomes a `oneOf` over `type` WITH a catch-all branch.
// Forward compatibility is therefore a property of this generator, not of each author's discipline.
import { err, type JsonValue, ok, type Result } from '@cohorte/base';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { EnvelopeBase, type EnvelopeOf, type EventTable, type PayloadOf } from './envelope.ts';
import { knownValuesOf } from './open-enum.ts';

export type { EventDeclaration, EventTable } from './envelope.ts';

export interface SchemaIssue {
  /** JSON pointer into the VALUE ('' = the value itself) */
  path: string;
  /** the JSON Schema keyword that failed: 'additionalProperties', 'enum', 'type', 'required', ... */
  keyword: string;
  message: string;
}
export type Validator<T> = (value: unknown) => Result<T, SchemaIssue[]>;

type JsonObject = { [key: string]: JsonValue };
type Mode = 'strict' | 'open';

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const EVENTS_SCHEMA_ID = 'https://cohorte.dev/schemas/3/events.schema.json';

// Keyword-aware walk: a PROPERTY may be named `enum`, `const` or `additionalProperties`, so "recurse into everything"
// would rewrite data. Only these keywords hold schemas; every other keyword is copied as it is.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_SINGLES = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
]);

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** TypeBox keeps its own bookkeeping under non-enumerable or `~`-prefixed keys: a JSON round trip leaves the JSON Schema. */
const plain = (schema: unknown): JsonValue => JSON.parse(JSON.stringify(schema)) as JsonValue;

/** Post-order map over every SCHEMA of a document: `post` sees a node whose sub-schemas are already mapped. */
function mapSchemas(
  node: JsonValue,
  post: (out: JsonObject, closable: boolean) => JsonValue,
  closable = true,
): JsonValue {
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (SCHEMA_MAPS.has(keyword) && isObject(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, member]) => [name, mapSchemas(member, post)]),
      );
    } else if ((SCHEMA_LISTS.has(keyword) || keyword === 'items') && Array.isArray(value)) {
      // `items` as a LIST is how TypeBox writes a tuple (with `additionalItems`), where 2020-12 says `prefixItems`.
      out[keyword] = value.map((member) => mapSchemas(member, post));
    } else if (keyword === 'allOf' && Array.isArray(value)) {
      // The members of an intersection describe ONE object together: closing each of them would refuse every value.
      out[keyword] = value.map((member) => mapSchemas(member, post, false));
    } else if (SCHEMA_SINGLES.has(keyword) && isObject(value)) {
      out[keyword] = mapSchemas(value, post);
    } else {
      out[keyword] = value;
    }
  }
  return post(out, closable);
}

function rewrite(node: JsonValue, mode: Mode): JsonValue {
  return mapSchemas(node, (out, closable) => {
    if (mode === 'open') {
      if (out.additionalProperties === false) delete out.additionalProperties;
      if (knownValuesOf(out) !== undefined) delete out.enum;
    } else if (closable && isObject(out.properties) && !('additionalProperties' in out)) {
      out.additionalProperties = false;
    }
    return out;
  });
}

/**
 * TypeBox inlines a `Type.Cyclic` at EVERY use as `{ $defs: { X: { $id: 'X', … } }, $ref: 'X' }`. Its own compiler
 * accepts the repetition; a second implementation (ajv) refuses two schemas with one `$id` in one document, and the
 * published schema exists for second implementations (AC-07). So a published DOCUMENT carries each such definition
 * once, under the root `$defs`, without its `$id`, and every reference becomes a pointer. Two different definitions
 * under one name are an authoring error, never merged. The result is a whole document: embed authored schemas in a
 * bigger one, not published ones (their pointers are relative to the root).
 */
function hoistDefinitions(document: JsonValue): JsonValue {
  const hoisted: JsonObject = {};
  const hoist = (name: string, definition: JsonObject): void => {
    const { $id: _id, ...body } = definition;
    const found = hoisted[name];
    if (found !== undefined && JSON.stringify(found) !== JSON.stringify(body)) {
      throw new TypeError(`two different definitions are named ${JSON.stringify(name)} in one published schema`);
    }
    hoisted[name] = body;
  };
  const lifted = mapSchemas(document, (out) => {
    if (!isObject(out.$defs)) return out;
    const kept: JsonObject = {};
    for (const [name, member] of Object.entries(out.$defs)) {
      if (isObject(member) && member.$id === name) hoist(name, member);
      else kept[name] = member;
    }
    if (Object.keys(kept).length > 0) out.$defs = kept;
    else delete out.$defs;
    return out;
  });
  if (!isObject(lifted) || Object.keys(hoisted).length === 0) return lifted;
  const own = isObject(lifted.$defs) ? lifted.$defs : {};
  for (const name of Object.keys(hoisted)) {
    if (name in own)
      throw new TypeError(`two different definitions are named ${JSON.stringify(name)} in one published schema`);
  }
  return mapSchemas({ ...lifted, $defs: { ...own, ...hoisted } }, (out) => {
    if (typeof out.$ref === 'string' && Object.hasOwn(hoisted, out.$ref)) out.$ref = `#/$defs/${out.$ref}`;
    return out;
  });
}

/** Writer side. Closes every object that declares `properties`, whether or not its author remembered to. */
export function toStrictSchema(schema: TSchema | JsonValue): JsonValue {
  return rewrite(plain(schema), 'strict');
}

/** Published side. Readers MUST ignore unknown fields and unknown open-enum values: the schema must let them. */
export function toOpenSchema(schema: TSchema | JsonValue): JsonValue {
  return hoistDefinitions(rewrite(plain(schema), 'open'));
}

function validatorOf<T>(jsonSchema: JsonValue): Validator<T> {
  const compiled = Compile(jsonSchema as TSchema);
  return (value) => {
    if (compiled.Check(value)) return ok(value as T);
    const issues: SchemaIssue[] = [];
    for (const issue of compiled.Errors(value)) {
      issues.push({ path: issue.instancePath, keyword: issue.keyword, message: issue.message });
    }
    return err(issues);
  };
}

const strictCache = new WeakMap<object, Validator<unknown>>();

/** The STRICT validator of any authored schema: commands, documents, agent output. Compiled once per schema object. */
export function compileSchema<S extends TSchema>(schema: S): Validator<Static<S>> {
  let found = strictCache.get(schema);
  if (!found) {
    found = validatorOf<unknown>(toStrictSchema(schema));
    strictCache.set(schema, found);
  }
  return found as Validator<Static<S>>;
}

/**
 * The validator a READER of this version would run: the open form of an authored schema, or an already published
 * schema (the transform is idempotent). It proves nothing about the static type of the value: a future field or a
 * future enum value is in it.
 */
export function compileOpen(schema: TSchema | JsonValue): Validator<JsonValue> {
  return validatorOf<JsonValue>(toOpenSchema(schema));
}

const rowOf = <E extends EventTable>(events: E, type: string): E[keyof E] => {
  if (!Object.hasOwn(events, type)) throw new RangeError(`no event type ${JSON.stringify(type)} in this catalogue`);
  return events[type as keyof E];
};

/** Writer side: the payload of one event type, unknown keys rejected. Generic over the table, so a catalogue only adds rows. */
export function compileStrict<E extends EventTable, T extends keyof E & string>(
  events: E,
  type: T,
): Validator<PayloadOf<E, T>> {
  return compileSchema(rowOf(events, type).payload) as Validator<PayloadOf<E, T>>;
}

/**
 * The properties that make a base envelope the envelope of ONE row: the discriminant, the narrowed body and whatever
 * the row pins (an event pins its durability). Shared by the strict and the open form, so the two cannot disagree.
 */
function narrowed(
  base: JsonValue,
  discriminant: string,
  type: string,
  body: string,
  bodySchema: JsonValue,
  pinned: JsonObject,
) {
  if (!isObject(base) || !isObject(base.properties)) throw new TypeError('an envelope schema must be an object schema');
  const properties: JsonObject = { ...base.properties, [discriminant]: { const: type }, [body]: bodySchema };
  for (const [name, value] of Object.entries(pinned)) properties[name] = { const: value };
  return { ...base, properties };
}

const envelopeCache = new WeakMap<object, Map<string, Validator<unknown>>>();

/** Writer side: the WHOLE envelope of one event type — closed, its `type` and its durability pinned by the table. */
export function compileStrictEnvelope<E extends EventTable, T extends keyof E & string>(
  events: E,
  type: T,
): Validator<EnvelopeOf<E, T>> {
  const row = rowOf(events, type);
  let perTable = envelopeCache.get(events);
  if (!perTable) {
    perTable = new Map();
    envelopeCache.set(events, perTable);
  }
  let found = perTable.get(type);
  if (!found) {
    const schema = narrowed(toStrictSchema(EnvelopeBase), 'type', type, 'payload', toStrictSchema(row.payload), {
      durability: row.durability,
    });
    found = validatorOf<unknown>(schema);
    perTable.set(type, found);
  }
  return found as Validator<EnvelopeOf<E, T>>;
}

export interface OpenTableOptions {
  $id: string;
  title: string;
  /** the envelope every row shares */
  base: TSchema;
  /** the property that names the row: `type` */
  discriminant: string;
  /** the property each row narrows: `payload` */
  body: string;
  rows: readonly { type: string; body: TSchema; pinned?: JsonObject }[];
}

/**
 * The published form of a table of types: the open base envelope, then a `oneOf` with one branch per KNOWN type and a
 * catch-all branch for the types of a later minor. Exactly one branch matches any envelope, because the base requires
 * the discriminant. Used for events here and for commands in commands.ts.
 */
export function toOpenTableSchema(options: OpenTableOptions): JsonValue {
  // the parts stay un-hoisted: definitions are lifted ONCE, to the root of the whole document
  const base = rewrite(plain(options.base), 'open');
  if (!isObject(base)) throw new TypeError('an envelope schema must be an object schema');
  const known = options.rows.map((row) => row.type);
  const branches: JsonValue[] = options.rows.map((row) => {
    const branch = narrowed(
      { properties: {} },
      options.discriminant,
      row.type,
      options.body,
      rewrite(plain(row.body), 'open'),
      row.pinned ?? {},
    );
    return { title: row.type, ...branch };
  });
  branches.push({
    title: 'a type added by a later minor version: readers MUST ignore it',
    properties: { [options.discriminant]: { not: { enum: known } } },
  });
  return hoistDefinitions({
    $schema: SCHEMA_DIALECT,
    $id: options.$id,
    title: options.title,
    ...base,
    oneOf: branches,
  });
}

/** Generator side of DESIGN 2.3.2, over any events table. */
export function toOpenJsonSchema(events: EventTable, options: { $id?: string; title?: string } = {}): JsonValue {
  return toOpenTableSchema({
    $id: options.$id ?? EVENTS_SCHEMA_ID,
    title: options.title ?? 'Cohorte Protocol event envelope',
    base: EnvelopeBase,
    discriminant: 'type',
    body: 'payload',
    rows: Object.entries(events).map(([type, row]) => ({
      type,
      body: row.payload,
      pinned: { durability: row.durability },
    })),
  });
}

export interface BoundCatalogue<E extends EventTable> {
  compileStrict<T extends keyof E & string>(type: T): Validator<PayloadOf<E, T>>;
  compileStrictEnvelope<T extends keyof E & string>(type: T): Validator<EnvelopeOf<E, T>>;
  toOpenJsonSchema(): JsonValue;
}

/** The exact signatures of DESIGN 2.3.2, bound to one table: `bindCatalogue(EVENTS)` is all a catalogue has to write. */
export function bindCatalogue<E extends EventTable>(events: E): BoundCatalogue<E> {
  return {
    compileStrict: (type) => compileStrict(events, type),
    compileStrictEnvelope: (type) => compileStrictEnvelope(events, type),
    toOpenJsonSchema: () => toOpenJsonSchema(events),
  };
}
