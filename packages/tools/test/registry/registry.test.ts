import { describe, expect, test } from 'vitest';
import { TOOL_CATALOGUE } from '../../src/catalogue/index.ts';
import { createToolRegistry } from '../../src/registry/index.ts';

describe('ToolRegistry', () => {
  test('keeps the composition-provided implementations and exposes stable names', () => {
    const registry = createToolRegistry(TOOL_CATALOGUE);
    expect(registry.get('read_file')).toBeDefined();
    expect(registry.get('does_not_exist')).toBeUndefined();
    expect(registry.names()).toEqual(Object.keys(TOOL_CATALOGUE));
  });
});
