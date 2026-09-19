import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSchema, type SchemaIssue } from '@cohorte/protocol';
import type { TSchema } from 'typebox';
import { parse } from 'yaml';
import {
  CohorteConfig,
  frozenSpecProblems,
  Manifest,
  Ownership,
  ownershipProblems,
  SkillManifest,
  Spec,
} from '../../src/schema/index.ts';

export const FIXTURES = join(import.meta.dirname, '../../../../fixtures/config');

export interface Issue {
  path: string;
  message: string;
}
interface Kind {
  schema: TSchema;
  /** the rules a JSON Schema cannot say; run only on a schema-valid document */
  rules: (document: never) => Issue[];
}
const KINDS: Record<string, Kind> = {
  config: { schema: CohorteConfig, rules: () => [] },
  ownership: { schema: Ownership, rules: (document: Ownership) => ownershipProblems(document) },
  spec: { schema: Spec, rules: (document: Spec) => frozenSpecProblems(document) },
  manifest: { schema: Manifest, rules: () => [] },
  skill: { schema: SkillManifest, rules: () => [] },
};

export interface Sample {
  name: string;
  kind: string;
  /** invalid samples only */
  expect?: string;
  document: unknown;
}

const header = (text: string, key: string): string | undefined =>
  new RegExp(`^# ${key}:(.*)$`, 'm').exec(text)?.[1]?.trim();

export function samplesOf(folder: 'valid' | 'invalid'): Sample[] {
  return readdirSync(join(FIXTURES, folder))
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(FIXTURES, folder, name), 'utf8');
      const expect = header(text, 'expect');
      return {
        name,
        kind: header(text, 'schema') ?? '',
        ...(expect === undefined ? {} : { expect }),
        document: parse(text) as unknown,
      };
    });
}

export function issuesOf(sample: Pick<Sample, 'kind' | 'document'>): Issue[] {
  const kind = KINDS[sample.kind];
  if (kind === undefined) throw new Error(`unknown "# schema:" header: ${JSON.stringify(sample.kind)}`);
  const checked = compileSchema(kind.schema)(sample.document);
  if (!checked.ok) return checked.error.map((issue: SchemaIssue) => ({ path: issue.path, message: issue.message }));
  return kind.rules(sample.document as never);
}

export function readSample(folder: 'valid' | 'invalid', name: string): Sample {
  const found = samplesOf(folder).find((sample) => sample.name === name);
  if (found === undefined) throw new Error(`no sample ${folder}/${name}`);
  return found;
}
