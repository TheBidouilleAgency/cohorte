import type { JsonValue } from '@cohorte/base';
import { AgentOutput, toStrictSchema } from '@cohorte/protocol';
import { TOOL_NAME_PATTERN, ToolGrant as ToolGrantSchema } from '@cohorte/runtime-contract';
import { Compile } from 'typebox/compile';
import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_ROWS,
  type PathArg,
  SEAM_TOOL_NAMES,
  stubImplementation,
  TOOL_CATALOGUE,
  TOOL_NAMES,
  toolIntrospection,
  toToolGrant,
} from '../../src/catalogue/index.ts';

const FORBIDDEN_ROOT_KEYS = ['$ref', '$defs', 'definitions', 'oneOf', 'anyOf', 'allOf'];

describe('every tool input schema', () => {
  for (const row of CATALOGUE_ROWS) {
    it(`${row.name}: is one flat top-level object, additionalProperties:false, no $ref/$defs/oneOf`, () => {
      const grant = toToolGrant(row.name);
      const schema = grant.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      for (const key of FORBIDDEN_ROOT_KEYS) expect(schema).not.toHaveProperty(key);
    });
  }
});

describe('toToolGrant', () => {
  for (const row of CATALOGUE_ROWS) {
    it(`${row.name}: output validates against ToolGrant`, () => {
      const grant = toToolGrant(row.name);
      const check = Compile(ToolGrantSchema);
      expect(check.Check(grant)).toBe(true);
    });
  }

  it('rejects an unknown tool name', () => {
    expect(() => toToolGrant('not_a_tool')).toThrow(RangeError);
  });
});

describe('tool names', () => {
  const namePattern = new RegExp(TOOL_NAME_PATTERN);

  it('every catalogue name matches the tool name pattern', () => {
    for (const name of TOOL_NAMES) expect(name).toMatch(namePattern);
  });

  it('no two names differ only by case', () => {
    const folded = new Set<string>();
    for (const name of TOOL_NAMES) {
      const lower = name.toLowerCase();
      expect(folded.has(lower)).toBe(false);
      folded.add(lower);
    }
  });

  it('has exactly the 9 V3.0 tools plus the 3 seams (12 total), each once', () => {
    expect(TOOL_NAMES).toHaveLength(12);
    expect(new Set(TOOL_NAMES).size).toBe(12);
  });
});

describe('submit_result', () => {
  it('inputSchema deep-equals the AgentOutput JSON Schema', () => {
    const grant = toToolGrant('submit_result');
    expect(grant.inputSchema).toEqual(toStrictSchema(AgentOutput));
  });

  it('is the only terminal tool', () => {
    const terminal = CATALOGUE_ROWS.filter((row) => row.terminal).map((row) => row.name);
    expect(terminal).toEqual(['submit_result']);
  });
});

describe('the three seams', () => {
  it('are flagged granted-to-nobody', () => {
    expect([...SEAM_TOOL_NAMES].sort()).toEqual(['git_commit', 'network_request', 'secret_read']);
    for (const name of SEAM_TOOL_NAMES) expect(TOOL_NAMES).toContain(name);
  });

  it('still mint a valid, flat ToolGrant (registered shapes)', () => {
    for (const name of SEAM_TOOL_NAMES) {
      const grant = toToolGrant(name);
      expect(grant.tool).toBe(name);
    }
  });
});

describe('TOOL_CATALOGUE', () => {
  it('is the catalogue itself (DESIGN 2.7): one entry per row, keyed by name, metadata included', () => {
    expect(Object.keys(TOOL_CATALOGUE).sort()).toEqual([...TOOL_NAMES].sort());
    for (const row of CATALOGUE_ROWS) {
      const impl = TOOL_CATALOGUE[row.name];
      expect(impl).toBeDefined();
      expect(impl?.name).toBe(row.name);
      expect(impl?.description).toBe(row.description);
      expect(impl?.effect).toBe(row.effect);
      expect(impl?.terminal).toBe(row.terminal);
    }
  });

  it('read implementations are executable and reserved seams remain explicit', () => {
    for (const name of ['read_file', 'list_files', 'search', 'git_diff']) {
      expect(TOOL_CATALOGUE[name]?.describeForNote({ idempotencyKey: name } as never)).toContain(name);
    }
    for (const name of SEAM_TOOL_NAMES) expect(TOOL_CATALOGUE[name]).toBeDefined();
  });

  it('stubImplementation rejects an unknown tool name', () => {
    expect(() => stubImplementation('not_a_tool')).toThrow(RangeError);
  });
});

describe('toolIntrospection.schemaOf is on the per-tool-call path (PLAN PC-4)', () => {
  it('returns the SAME object identity on every call, so a validator cache keyed by schema can work', () => {
    for (const name of TOOL_NAMES) {
      const first = toolIntrospection.schemaOf(name);
      expect(first).toBeDefined();
      expect(toolIntrospection.schemaOf(name)).toBe(first);
    }
  });

  it('is the same strict schema `toToolGrant` mints', () => {
    for (const name of TOOL_NAMES) {
      expect(toToolGrant(name).inputSchema).toBe(toolIntrospection.schemaOf(name));
    }
  });

  it('returns undefined for an unknown tool', () => {
    expect(toolIntrospection.schemaOf('not_a_tool')).toBeUndefined();
  });
});

describe('pathArgsOf', () => {
  it('finds the path argument of read_file', () => {
    expect(toolIntrospection.pathArgsOf('read_file', { path: 'src/index.ts' })).toEqual([
      { arg: 'path', value: 'src/index.ts', intent: 'read' },
    ]);
  });

  it('finds every path of a git_diff paths array', () => {
    const found = toolIntrospection.pathArgsOf('git_diff', { paths: ['a.ts', 'b.ts'] });
    expect(found).toEqual([
      { arg: 'paths[0]', value: 'a.ts', intent: 'read' },
      { arg: 'paths[1]', value: 'b.ts', intent: 'read' },
    ]);
  });

  it('finds the nested artifact paths of submit_result', () => {
    const found = toolIntrospection.pathArgsOf('submit_result', {
      status: 'completed',
      summary: 's',
      artifacts: [{ path: 'out.diff', kind: 'diff' }],
      findings: [],
      checks: [],
      questions: [],
      confidence: 1,
    });
    expect(found).toEqual([{ arg: 'artifacts[0].path', value: 'out.diff', intent: 'read' }]);
  });

  it('finds no path for a tool with none (approval_request)', () => {
    expect(toolIntrospection.pathArgsOf('approval_request', { question: 'ok?' })).toEqual([]);
  });

  it('returns [] for an unknown tool', () => {
    expect(toolIntrospection.pathArgsOf('not_a_tool', {})).toEqual([]);
  });

  /** One row per catalogue tool: a minimal valid input and the EXACT `PathArg[]` the gate's stage 3 must see. */
  const PATH_ARG_TABLE: readonly { tool: string; input: JsonValue; expected: PathArg[] }[] = [
    { tool: 'read_file', input: { path: 'src/a.ts' }, expected: [{ arg: 'path', value: 'src/a.ts', intent: 'read' }] },
    { tool: 'list_files', input: { path: 'src' }, expected: [{ arg: 'path', value: 'src', intent: 'list' }] },
    {
      tool: 'search',
      input: { pattern: 'TODO', path: 'packages' },
      expected: [{ arg: 'path', value: 'packages', intent: 'list' }],
    },
    {
      tool: 'write_file',
      input: { path: 'out/new.ts', content: 'x' },
      expected: [{ arg: 'path', value: 'out/new.ts', intent: 'write' }],
    },
    {
      tool: 'patch_file',
      input: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
      expected: [{ arg: 'path', value: 'src/a.ts', intent: 'write' }],
    },
    {
      tool: 'run_command',
      input: { argv: ['pnpm', 'test'], cwd: 'packages/core' },
      expected: [{ arg: 'cwd', value: 'packages/core', intent: 'exec-cwd' }],
    },
    {
      tool: 'git_diff',
      input: { paths: ['a.ts', 'b.ts'] },
      expected: [
        { arg: 'paths[0]', value: 'a.ts', intent: 'read' },
        { arg: 'paths[1]', value: 'b.ts', intent: 'read' },
      ],
    },
    { tool: 'approval_request', input: { question: 'ok?' }, expected: [] },
    {
      tool: 'submit_result',
      input: { status: 'completed', summary: 's', artifacts: [{ path: 'out.diff', kind: 'diff' }], confidence: 1 },
      expected: [{ arg: 'artifacts[0].path', value: 'out.diff', intent: 'read' }],
    },
    { tool: 'git_commit', input: { message: 'm' }, expected: [] },
    { tool: 'network_request', input: { url: 'https://example.invalid' }, expected: [] },
    { tool: 'secret_read', input: { id: 'token' }, expected: [] },
  ];

  it('the table covers every catalogue tool, once', () => {
    expect(PATH_ARG_TABLE.map((entry) => entry.tool)).toEqual(TOOL_NAMES);
  });

  for (const { tool, input, expected } of PATH_ARG_TABLE) {
    it(`${tool}: pathArgsOf returns exactly its path arguments`, () => {
      expect(toolIntrospection.schemaOf(tool)).toBeDefined();
      expect(toolIntrospection.pathArgsOf(tool, input)).toEqual(expected);
    });
  }

  it('git_diff: a non-string element is skipped and the surviving indices are preserved', () => {
    expect(toolIntrospection.pathArgsOf('git_diff', { paths: ['a.ts', 42, 'c.ts'] })).toEqual([
      { arg: 'paths[0]', value: 'a.ts', intent: 'read' },
      { arg: 'paths[2]', value: 'c.ts', intent: 'read' },
    ]);
  });

  it('submit_result: an artifact without a path contributes nothing, and does not shift the others', () => {
    expect(
      toolIntrospection.pathArgsOf('submit_result', {
        status: 'completed',
        summary: 's',
        artifacts: [{ kind: 'log' }, { path: 'out.diff', kind: 'diff' }],
        confidence: 1,
      }),
    ).toEqual([{ arg: 'artifacts[1].path', value: 'out.diff', intent: 'read' }]);
  });

  it('a tool whose optional path argument is absent yields no PathArg', () => {
    for (const tool of ['list_files', 'search', 'run_command', 'git_diff']) {
      expect(toolIntrospection.pathArgsOf(tool, {})).toEqual([]);
    }
  });
});
