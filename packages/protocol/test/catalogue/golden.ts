import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The seed of the schema-compat golden set: `<kind>.<name>.json`, flat (DESIGN 1.4 `fixtures/schema-compat/<version>/*.json`). */
export const GOLDEN_DIR = fileURLToPath(new URL('../../../../fixtures/schema-compat/3.0.0-dev/', import.meta.url));

export type GoldenKind = 'event' | 'command' | 'document';
export interface GoldenFile {
  file: string;
  kind: string;
  name: string;
  value: unknown;
}

export function goldenFiles(): GoldenFile[] {
  return readdirSync(GOLDEN_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const stem = file.slice(0, -'.json'.length);
      const dot = stem.indexOf('.');
      return {
        file,
        kind: stem.slice(0, dot),
        name: stem.slice(dot + 1),
        value: JSON.parse(readFileSync(`${GOLDEN_DIR}${file}`, 'utf8')) as unknown,
      };
    });
}

export const goldenOf = (kind: GoldenKind): GoldenFile[] => goldenFiles().filter((golden) => golden.kind === kind);

export function golden(kind: GoldenKind, name: string): unknown {
  const found = goldenOf(kind).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no golden fixture ${kind}.${name}.json`);
  return found.value;
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('not an object');
  return value as Record<string, unknown>;
};
