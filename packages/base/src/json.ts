import { type Static, type TUnsafe, Type } from 'typebox';

/** DESIGN 2.1, verbatim. JSON on a wire never contains `undefined`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const JsonValueCyclic = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref('JsonValue')),
      Type.Record(Type.String(), Type.Ref('JsonValue')),
    ]),
  },
  'JsonValue',
);

/**
 * The schema of {@link JsonValue}. Its static type is the hand-written alias rather than the type derived from
 * the cyclic schema: the two are the same type (the assertion below breaks `tsc` if they drift), but the alias
 * costs the compiler nothing where the derived one is re-expanded inside every schema that embeds a JSON value.
 *
 * NOT named `JsonValue` like its type, on purpose. Biome 2.5.14 (type-aware because of nursery/noFloatingPromises)
 * overflows its stack on a RECURSIVE UNION whose name is shared by a TypeBox const, as soon as a class that extends
 * Error holds a value of that type — `CohorteError.info.details` does. It then exits 0, so the lint looks green
 * while nothing was checked. DESIGN 2.1 lists `JsonValue` as a type only (it is not `[S]`), so no contract moves.
 * KEEP THE EXPLICIT ANNOTATION too: having to INFER this call is the other way into the same overflow (a
 * `typeof JsonValueSchema`, or a namespace import of the barrel, is enough). See docs/v3/requests/U0.02.md R1.
 */
export const JsonValueSchema: TUnsafe<JsonValue> = Type.Unsafe<JsonValue>(JsonValueCyclic);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _JsonValueMatchesItsSchema = Assert<MutuallyAssignable<Static<typeof JsonValueCyclic>, JsonValue>>;

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isJson = (value: unknown, ancestors: Set<object>): boolean => {
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isJson(value[index], ancestors)) return false;
      }
      return true;
    }
    if (!isPlainObject(value)) return false;
    return Object.values(value).every((member) => isJson(member, ancestors));
  } finally {
    ancestors.delete(value);
  }
};

/** Structural guard: finite numbers only, no `undefined`, no hole, plain objects only, no cycle. Never throws on data. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return isJson(value, new Set());
  } catch {
    // A hostile object (a Proxy whose traps throw) is not JSON.
    return false;
  }
}
