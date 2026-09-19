// R10 / spec 17 / DESIGN 7.5 AC-07 (seed): François never has to know the engine. The scan covers every schema THIS
// package publishes — events, commands, every document, the agent output — and looks at what a client reads: property
// names, $defs names, enum / const / open-enum values.
import { describe, expect, test } from 'vitest';
import { AgentOutput, ReviewResult } from '../../src/agent-output.ts';
import { catalogue } from '../../src/catalogue.ts';
import { toOpenCommandsJsonSchema } from '../../src/commands.ts';
import { DOCUMENT_NAMES, toOpenDocumentJsonSchema } from '../../src/documents.ts';

const FORBIDDEN_TOKENS = ['pi', 'earendil', 'pimono'];
const FORBIDDEN_FRAGMENTS = ['earendil', 'pi-mono', 'pi-ai', 'pi-agent', 'pi-coding-agent', 'pi-tui'];

const NAME_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
const VALUE_LISTS = ['enum', 'x-cohorte-known', 'required'];

function identifiersOf(schema: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const object = node as Record<string, unknown>;
    for (const keyword of NAME_MAPS) {
      const map = object[keyword];
      if (typeof map === 'object' && map !== null) found.push(...Object.keys(map));
    }
    for (const keyword of VALUE_LISTS) {
      const list = object[keyword];
      if (Array.isArray(list)) found.push(...list.filter((value): value is string => typeof value === 'string'));
    }
    if (typeof object.const === 'string') found.push(object.const);
    for (const value of Object.values(object)) walk(value);
  };
  walk(schema);
  return [...new Set(found)];
}

const tokensOf = (identifier: string): string[] =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());

const offending = (identifiers: readonly string[]): string[] =>
  identifiers.filter(
    (identifier) =>
      tokensOf(identifier).some((token) => FORBIDDEN_TOKENS.includes(token)) ||
      FORBIDDEN_FRAGMENTS.some((fragment) => identifier.toLowerCase().includes(fragment)),
  );

const PUBLISHED: Record<string, unknown> = {
  events: catalogue.toOpenJsonSchema(),
  commands: toOpenCommandsJsonSchema(),
  'agent-output': AgentOutput,
  'review-result': ReviewResult,
  ...Object.fromEntries(DOCUMENT_NAMES.map((name) => [name, toOpenDocumentJsonSchema(name)])),
};

describe('identifier scan of the protocol frontier', () => {
  test('the scanner sees property names, enum values, constants and $defs, and tokenises camelCase', () => {
    const planted = {
      properties: { piSessionId: { enum: ['via-pi'] }, apiKey: { const: 'pipeline' } },
      $defs: { EarendilThing: { 'x-cohorte-known': ['@earendil-works/pi-ai'] } },
    };
    expect(offending(identifiersOf(planted)).sort()).toEqual(
      ['@earendil-works/pi-ai', 'EarendilThing', 'piSessionId', 'via-pi'].sort(),
    );
    expect(offending(['apiKey', 'api-key', 'pipeline.started', 'spinner', 'topic', 'expiresAt'])).toEqual([]);
  });

  test.for(Object.keys(PUBLISHED).map((name) => [name] as const))('%s: no `pi` token, no engine name', ([name]) => {
    const identifiers = identifiersOf(JSON.parse(JSON.stringify(PUBLISHED[name])));
    expect(identifiers.length).toBeGreaterThan(3);
    expect(offending(identifiers)).toEqual([]);
  });

  test('the scan really reads the catalogue: it finds event types and payload keys', () => {
    const identifiers = identifiersOf(PUBLISHED.events);
    expect(identifiers).toEqual(expect.arrayContaining(['tool.rejected', 'waitedMs', 'runtimeRef', 'hmac-sha256']));
  });
});
