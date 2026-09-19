import { describe, expect, test } from 'vitest';
import { AgentGrant, PolicyVerdict, SandboxCapabilities } from '../../src/contract/index.ts';
import {
  agentGrant,
  allowVerdict,
  approvedVerdict,
  denyVerdict,
  l0Capabilities,
  partialL1Capabilities,
  pathsOf,
} from './samples.ts';

describe('PolicyVerdict [S]', () => {
  test.for([
    ['allow', allowVerdict()],
    ['deny', denyVerdict()],
    ['allow-for-run with its approval', approvedVerdict()],
  ] as const)('%s verdict is schema-valid', ([, verdict]) => {
    expect(pathsOf(PolicyVerdict, verdict)).toEqual([]);
  });

  test('the five decisions of spec 9, exactly', () => {
    for (const decision of ['allow', 'deny', 'ask', 'allow-once', 'allow-for-run']) {
      expect(pathsOf(PolicyVerdict, { ...allowVerdict(), decision })).toEqual([]);
    }
    expect(pathsOf(PolicyVerdict, { ...allowVerdict(), decision: 'allow-always' })).toContain('/decision');
  });

  test('closed, and `normalized` is required (null when nothing will execute)', () => {
    expect(pathsOf(PolicyVerdict, { ...allowVerdict(), shell: 'pnpm run test' })).not.toEqual([]);
    const { normalized: _dropped, ...rest } = allowVerdict();
    expect(pathsOf(PolicyVerdict, rest)).not.toEqual([]);
    expect(pathsOf(PolicyVerdict, { ...allowVerdict(), stage: 'executor' })).toContain('/stage');
  });

  test('a normalized command is argv: there is nowhere to put a command line', () => {
    const verdict = allowVerdict();
    const smuggled = {
      ...verdict,
      normalized: { ...verdict.normalized, command: { ...verdict.normalized?.command, script: 'a && b' } },
    };
    expect(pathsOf(PolicyVerdict, smuggled)).not.toEqual([]);
  });
});

describe('AgentGrant [S]', () => {
  test('the sample is schema-valid; a read-only agent has no workspace', () => {
    expect(pathsOf(AgentGrant, agentGrant())).toEqual([]);
    expect(pathsOf(AgentGrant, { ...agentGrant(), roots: { workspace: null, readOnly: [] } })).toEqual([]);
  });

  test('commands default to deny and nothing else', () => {
    expect(pathsOf(AgentGrant, { ...agentGrant(), commands: { default: 'allow', rules: [] } })).toContain(
      '/commands/default',
    );
  });

  test('secrets are ids, never values', () => {
    const grant = agentGrant();
    const leaking = { ...grant, secrets: [{ ...grant.secrets[0], value: 'npm_abcdefgh' }] };
    expect(pathsOf(AgentGrant, leaking)).not.toEqual([]);
  });
});

describe('SandboxCapabilities [S]', () => {
  test('L0 and a partial L1 are schema-valid', () => {
    expect(pathsOf(SandboxCapabilities, l0Capabilities())).toEqual([]);
    expect(pathsOf(SandboxCapabilities, partialL1Capabilities())).toEqual([]);
  });

  test('`partial` exists for filesystem, network and processEscape; the L0 guarantees can only say `enforced`', () => {
    expect(pathsOf(SandboxCapabilities, { ...l0Capabilities(), envFiltering: 'partial' })).toContain('/envFiltering');
    expect(pathsOf(SandboxCapabilities, { ...l0Capabilities(), network: 'enforced' })).toContain('/network');
    const { processEscape: _dropped, ...rest } = l0Capabilities();
    expect(pathsOf(SandboxCapabilities, rest)).not.toEqual([]);
  });
});
