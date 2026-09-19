import { type TUnsafe, Type } from 'typebox';

/** The keyword a PUBLISHED schema carries instead of `enum`: the values this version knows, as documentation. */
export const OPEN_ENUM_KEYWORD = 'x-cohorte-known';

/** The known values stay visible to completion and to exhaustive switches; any other string is still assignable. */
export type OpenEnumOf<K extends string> = K | (string & Record<never, never>);

export interface EnumOptions {
  description?: string;
}

const checked = (values: readonly string[], what: string): string[] => {
  if (values.length === 0) throw new RangeError(`${what}: at least one value is required`);
  if (new Set(values).size !== values.length)
    throw new RangeError(`${what}: duplicate value in [${values.join(', ')}]`);
  return [...values];
};

/**
 * OPEN enums (values may be added in a minor): strict compile -> enum [...known];
 * published schema -> { type: 'string', 'x-cohorte-known': [...] } (compile.ts does the rewrite).
 * The authored form carries BOTH keywords: `enum` is what the writer-side validator enforces, the marker is what
 * tells the generator that this enum, unlike a closed one, must lose its `enum` when published.
 */
export function OpenEnum<const V extends readonly string[]>(
  known: V,
  opts: EnumOptions = {},
): TUnsafe<OpenEnumOf<V[number]>> {
  const values = checked(known, 'OpenEnum');
  return Type.Unsafe<OpenEnumOf<V[number]>>({
    type: 'string',
    enum: values,
    [OPEN_ENUM_KEYWORD]: [...values],
    ...opts,
  });
}

/** A CLOSED string enum: adding a value is a MAJOR. One `enum` keyword rather than an `anyOf` of constants. */
export function ClosedEnum<const V extends readonly string[]>(values: V, opts: EnumOptions = {}): TUnsafe<V[number]> {
  return Type.Unsafe<V[number]>({ type: 'string', enum: checked(values, 'ClosedEnum'), ...opts });
}

/** The known values of an authored or published open enum; undefined for anything else. */
export function knownValuesOf(schema: unknown): readonly string[] | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const known: unknown = (schema as Record<string, unknown>)[OPEN_ENUM_KEYWORD];
  return Array.isArray(known) && known.every((value) => typeof value === 'string') ? known : undefined;
}
