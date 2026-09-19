import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { checkContractWords, findForbiddenWord, scanContractSource, splitWords } from '../check-contract-words.ts';
import { REPO_ROOT, test } from './support/tree.ts';

describe('splitWords', () => {
  test.for([
    ['piSession', ['pi', 'session']],
    ['phaseId', ['phase', 'id']],
    ['RuntimePin', ['runtime', 'pin']],
    ['capabilities', ['capabilities']],
    ['PIVersion', ['pi', 'version']],
    ['review_round', ['review', 'round']],
    ['APPROVAL_TTL_MS', ['approval', 'ttl', 'ms']],
    ['tool-call.policy', ['tool', 'call', 'policy']],
    ['sha256Of', ['sha', '256', 'of']],
  ] as const)('%s -> %j', ([identifier, words]) => {
    expect(splitWords(identifier)).toEqual(words);
  });
});

describe('findForbiddenWord', () => {
  test.for([
    'piSession',
    'phaseId',
    'pipelineState',
    'GateVerdict',
    'policy',
    'approvalId',
    'ReviewRound',
    'ownership',
    'worktreePath',
    'findings',
    'policies',
    'PI_VERSION',
  ])('%s fails', (identifier) => {
    expect(findForbiddenWord(identifier)).not.toBeNull();
  });

  test('SandboxPolicy, the spec 5.1 name of SpawnRequest.sandbox, is the one identifier let through by name', () => {
    expect(findForbiddenWord('SandboxPolicy')).toBeNull();
    expect(findForbiddenWord('sandboxPolicy')).toBe('policy');
    expect(findForbiddenWord('SandboxPolicyRule')).toBe('policy');
    expect(findForbiddenWord('ToolPolicy')).toBe('policy');
  });

  test.for([
    'capabilities',
    'RuntimePin',
    'pin',
    'pid',
    'apiKey',
    'spinner',
    'Gateway',
    'previewText',
    'agentId',
    'runId',
    'toolCallId',
    'epic',
    'pixel',
  ])('%s passes', (identifier) => {
    expect(findForbiddenWord(identifier)).toBeNull();
  });
});

describe('scanContractSource', () => {
  test('reports exported names and schema keys, and nothing else', () => {
    const source = [
      "import type { Policy } from './elsewhere.ts';",
      '// phaseId in a comment is not a name',
      "const note = 'piSession in a string is not a name';",
      'function review(policy: Policy) { return policy; } // local function and its parameter',
      'export interface SpawnRequest {',
      '  readonly agentId: string;',
      '  phaseId?: string;',
      '  pause(gate: string): void;',
      "  nested: { 'worktree-path': string; ok: number };",
      '}',
      'export type PiSession = { id: string };',
      'export const RuntimePin = Type.Object({ capabilities: Type.String(), approvalId: Type.String() });',
      'export function capabilities() { const finding = 1; return review({ finding } as never); }',
      'export { note as pipelineNote };',
      'export type { Policy as EnginePolicy };',
    ].join('\n');
    const hits = scanContractSource(source).map((h) => [h.identifier, h.kind, h.line]);
    expect(hits).toEqual([
      ['phaseId', 'key', 7],
      ['worktree-path', 'key', 9],
      ['PiSession', 'export', 11],
      ['approvalId', 'key', 12],
      ['pipelineNote', 'export', 14],
      ['EnginePolicy', 'export', 15],
    ]);
  });

  test('reads the keys of an inline object type in a signature: parameters and return types', () => {
    const source = [
      'export interface AgentRuntime {',
      '  spawn(opts: { phaseId: string; ok: number }): Promise<{ worktreePath: string }>;',
      '  on(listener: (event: { approvalId: string }) => void): void;',
      '  configure({ verbose }: { verbose: boolean }, policy: string): void;',
      '}',
      'export function open(opts: { pipelineId: string }, extra: A | { gateName: string }): void {}',
      'export async function close<T>(handle: T): Promise<{ reviewRound: number }> {',
      '  const local = { finding: 1 };',
      '  return { reviewRound: local.finding };',
      '}',
      'export const send = (frame: { ownershipMap: string }): void => {};',
      'export declare function ping(opts?: { ok: boolean }): { pid: number };',
      'function internal(opts: { phaseId: string }): { policy: string } { return { policy: opts.phaseId }; }',
      "export const options = Type.String({ description: 'x' });",
    ].join('\n');
    const hits = scanContractSource(source).map((h) => [h.identifier, h.kind, h.line]);
    expect(hits).toEqual([
      ['phaseId', 'key', 2],
      ['worktreePath', 'key', 2],
      ['approvalId', 'key', 3],
      ['pipelineId', 'key', 6],
      ['gateName', 'key', 6],
      ['reviewRound', 'key', 7],
      ['ownershipMap', 'key', 11],
    ]);
  });

  test('accepts the vocabulary the runtime contract really uses', () => {
    const source = [
      'export type Unsubscribe = () => void;',
      'export interface AgentRuntime {',
      "  readonly id: string;                 // 'pi' | 'fake'",
      '  capabilities(): RuntimeCapabilities;',
      '  spawn(request: SpawnRequest): Promise<RuntimeAgentHandle>;',
      '  pause(agentId: string): Promise<void>;',
      '}',
      'export interface RuntimeToolCall { runId: RunId; toolCallId: ToolCallId; ordinal: number; tool: string; input: JsonValue; }',
      'export interface RuntimePin { engine: string; engineVersion: string; }',
      'export interface SpawnRequest { tools: ToolGrant[]; sandbox: SandboxPolicy; budget: Budget; }',
      'export interface SandboxPolicy { readOnly: string[]; readWrite: string[]; }',
    ].join('\n');
    expect(scanContractSource(source)).toEqual([]);
  });
});

describe('checkContractWords', () => {
  test('scans packages/runtime-contract/src and nothing else', async ({ tree }) => {
    await tree.write({
      'packages/runtime-contract/src/index.ts': 'export interface RuntimePin { capabilities: string }\n',
      'packages/runtime-contract/src/spawn.ts':
        'export interface SpawnRequest { piSession: string; phaseId: string }\n',
      'packages/runtime-contract/test/words.test.ts': 'export const phaseId = 1;\n',
      'packages/protocol/src/index.ts': 'export type PipelineState = string;\n',
    });
    const result = checkContractWords({ root: tree.root });
    expect(result.filesScanned).toBe(2);
    expect(result.hits.map((h) => `${h.file}:${h.line} ${h.identifier} (${h.word})`)).toEqual([
      'packages/runtime-contract/src/spawn.ts:1 piSession (pi)',
      'packages/runtime-contract/src/spawn.ts:1 phaseId (phase)',
    ]);
  });

  test('command line: exit 1 with the offending names, exit 0 when clean', async ({ tree }) => {
    const script = join(REPO_ROOT, 'scripts/check-contract-words.ts');
    await tree.write({
      'packages/runtime-contract/src/index.ts': 'export interface RuntimePin { capabilities: string }\n',
    });
    const clean = spawnSync(process.execPath, [script, '--root', tree.root], { encoding: 'utf8' });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('check-contract-words: OK');

    await tree.write({ 'packages/runtime-contract/src/bad.ts': 'export type PiSession = string;\n' });
    const dirty = spawnSync(process.execPath, [script, '--root', tree.root], { encoding: 'utf8' });
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('packages/runtime-contract/src/bad.ts:1');
    expect(dirty.stderr).toContain('PiSession');
  });
});
