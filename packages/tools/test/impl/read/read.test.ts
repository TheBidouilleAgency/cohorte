import { describe, expect, test } from 'vitest';
import { READ_TOOL_NAMES } from '../../../src/impl/read/index.ts';

describe('read tool catalogue', () => {
  test('registers the four read tools', () => {
    expect(READ_TOOL_NAMES).toEqual(['read_file', 'list_files', 'search', 'git_diff']);
  });
});
