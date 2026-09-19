import { createHash } from 'node:crypto';
import type { Sha256 } from './ids.ts';
import type { JsonValue } from './json.ts';

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === 'string' && name ? name : 'object';
};

const write = (value: unknown, path: string, ancestors: Set<object>): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: ${value} at ${path || '/'} is not a JSON number`);
      // JSON.stringify is the ECMAScript shortest round-trip form RFC 8785 prescribes, and writes -0 as 0.
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} at ${path || '/'} is not JSON`);
  }

  if (ancestors.has(value)) throw new TypeError(`canonicalJson: cycle at ${path || '/'}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1)
        items.push(write(value[index], `${path}/${index}`, ancestors));
      return `[${items.join(',')}]`;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: a ${describe(value)} at ${path || '/'} is not a plain JSON object`);
    }
    const members = new Map<string, string>();
    for (const [rawKey, member] of Object.entries(value)) {
      // Dropped exactly as JSON.stringify drops it, so a value hashes like the form that gets stored.
      if (member === undefined) continue;
      const key = rawKey.normalize('NFC');
      if (members.has(key))
        throw new TypeError(
          `canonicalJson: two keys collide as ${JSON.stringify(key)} at ${path || '/'} once normalised`,
        );
      members.set(key, write(member, `${path}/${key}`, ancestors));
    }
    // Default sort = UTF-16 code units, the order of RFC 8785.
    const keys = [...members.keys()].sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${members.get(key)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * The one serialisation that is hashed, signed or compared: sorted keys, no whitespace, NFC strings (keys included).
 * Throws a TypeError on anything that is not JSON — a non-finite number, `undefined` outside an object member,
 * a function, a bigint, a class instance, a cycle — rather than hash something `JSON.parse` could not give back.
 */
export function canonicalJson(v: JsonValue): string {
  return write(v, '', new Set());
}

/** A string is hashed as UTF-8, as given: no normalisation here. */
export function sha256Hex(data: string | Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex') as Sha256;
}
