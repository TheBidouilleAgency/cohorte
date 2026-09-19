import { describe, expect, test } from 'vitest';
import { generateProtocolDocs } from '../../../scripts/gen-protocol-docs.ts';

describe('generated protocol documentation', () => {
  test('is reproducible from the current schemas', () => {
    expect(generateProtocolDocs({ repoRoot: process.cwd(), check: true })).toBe(true);
  });
});
