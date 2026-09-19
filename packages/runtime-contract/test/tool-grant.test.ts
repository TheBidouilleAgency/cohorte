import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import {
  TOOL_INPUT_SCHEMA_FORBIDDEN_ROOT_KEYS,
  TOOL_NAME_PATTERN,
  ToolGrant,
  toolGrantProblems,
} from '../src/index.ts';
import { toolGrant } from './samples.ts';

const check = Compile(ToolGrant);

describe('ToolGrant.tool', () => {
  test.for(['ls', 'read_file', 'submit_result', 'a1', `a${'b'.repeat(40)}`])('accepts %s', (tool) => {
    expect(check.Check({ ...toolGrant, tool })).toBe(true);
  });

  test.for(['a', 'Read', 'read-file', '1tool', '_tool', 'read file', '', `a${'b'.repeat(41)}`, 'outil_é'])(
    'refuses %j',
    (tool) => {
      expect(check.Check({ ...toolGrant, tool })).toBe(false);
      expect(toolGrantProblems([{ tool }])).toEqual([expect.stringContaining(TOOL_NAME_PATTERN)]);
    },
  );
});

describe('ToolGrant.inputSchema is ONE flat top-level object', () => {
  test('accepts an object schema, with or without properties', () => {
    expect(check.Check(toolGrant)).toBe(true);
    expect(check.Check({ ...toolGrant, inputSchema: { type: 'object' } })).toBe(true);
    // Nested composition is the provider's business only at the ROOT.
    const nested = { type: 'object', properties: { mode: { oneOf: [{ const: 'a' }, { const: 'b' }] } } };
    expect(check.Check({ ...toolGrant, inputSchema: nested })).toBe(true);
  });

  test.for(TOOL_INPUT_SCHEMA_FORBIDDEN_ROOT_KEYS)('refuses %s at the root', (key) => {
    expect(check.Check({ ...toolGrant, inputSchema: { type: 'object', [key]: [] } })).toBe(false);
  });

  test.for([
    ['a string schema', { type: 'string' }],
    ['no type', { properties: {} }],
    ['a type list', { type: ['object', 'null'] }],
    ['an array', []],
    ['true', true],
    ['null', null],
    ['properties that is not a map', { type: 'object', properties: [] }],
  ] as const)('refuses %s', ([, inputSchema]) => {
    expect(check.Check({ ...toolGrant, inputSchema })).toBe(false);
  });
});

describe('toolGrantProblems', () => {
  test('is empty for distinct valid names', () => {
    expect(toolGrantProblems([{ tool: 'read_file' }, { tool: 'write_file' }, { tool: 'submit_result' }])).toEqual([]);
  });

  test('names a tool granted twice', () => {
    expect(toolGrantProblems([{ tool: 'read_file' }, { tool: 'read_file' }])).toEqual([
      expect.stringContaining('granted twice'),
    ]);
  });

  test('names two tools that differ only by case', () => {
    const problems = toolGrantProblems([{ tool: 'read_file' }, { tool: 'Read_File' }]);
    expect(problems).toContainEqual(expect.stringContaining('differ only by case'));
  });
});
