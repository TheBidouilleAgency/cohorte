import type { IsoInstant, Sha256, SpecId } from '@cohorte/base';
import { Compile } from 'typebox/compile';
import { describe, expect, it } from 'vitest';
import { RunSnapshotManifest } from '../../src/contract/snapshot-manifest.ts';

const HEX64 = '630578ddfd2a045b52f862361ac5fb33f1a9638ed0f12ef4210d2b363035bbc6' as Sha256;
const INSTANT = '2026-09-18T10:20:30.123Z' as IsoInstant;

const yes = { value: 'yes' } as const;

const sample = (): RunSnapshotManifest => ({
  manifestVersion: 1,
  createdAt: INSTANT,
  app: { name: 'cohorte', version: '3.0.0', installDir: '/opt/cohorte', gitHash: 'abc123' },
  packages: [{ name: 'typebox', version: '1.0.0' }],
  bundles: [{ file: 'dist/cli.mjs', sha256: HEX64, bytes: 1024 }],
  assets: { treeSha256: HEX64, embeddedTreeSha256: HEX64 },
  schemas: {
    protocolVersion: '1.0',
    stateSchemaVersion: 1,
    configSchemaVersion: 1,
    transitionTable: { profile: 'feature', version: 1 },
  },
  prompts: [{ id: 'agents/implementer', source: 'shipped', logicalPath: 'prompts/implementer.md', sha256: HEX64 }],
  skills: [{ id: 'writing-tests', version: '1', source: 'shipped', sha256: HEX64 }],
  config: {
    resolvedSha256: HEX64,
    ownershipSha256: HEX64,
    policySha256: HEX64,
    conventionsSha256: null,
    trust: { policySha256: HEX64, loosenedKeys: [], grantedBy: 'none-needed' },
  },
  spec: { id: 'feature-29' as SpecId, sha256: HEX64 },
  environment: {
    pinnedPath: ['/usr/bin'],
    platform: 'darwin',
    arch: 'arm64',
    sandbox: {
      level: 'L1-os',
      backend: 'seatbelt',
      filesystem: 'enforced',
      network: 'enforced-off',
      processEscape: 'denied',
      envFiltering: 'enforced',
      timeout: 'enforced',
      outputCap: 'enforced',
      cpuTime: 'enforced',
      memory: 'enforced',
      processes: 'enforced',
      killTree: 'process-group-with-sweep',
      missing: [],
      notes: [],
    },
    runtimeCapabilities: {
      contractVersion: '1',
      toolExecution: 'host-delegated',
      streaming: yes,
      thinkingStream: yes,
      send: { steer: yes, followUp: yes },
      cancelCooperative: yes,
      cancelHard: yes,
      pause: { toolBoundary: yes, modelBoundary: yes },
      continuationFromTranscript: yes,
      processIsolation: yes,
      envFiltering: yes,
      brainSandbox: yes,
      resourceLimits: yes,
      budgetEnforcement: {
        turns: yes,
        modelRequests: yes,
        tokens: yes,
        context: yes,
        wallClock: yes,
        outputTokensPerRequest: yes,
      },
      hiddenModelCalls: yes,
      usageReporting: yes,
      effectiveModelReporting: yes,
      quotaReporting: yes,
      authStatusWithoutSecret: yes,
      subscriptionModeAssertion: yes,
      systemPromptExact: yes,
      runtimePinning: yes,
      platforms: { darwin: yes, linux: yes, win32: yes },
      hints: { memoryPerAgentMb: 200, coldStartMs: 900, maxConcurrentAgents: 4 },
    },
  },
  runtime: {
    runtimeId: 'pi',
    adapterVersion: '3.0.0',
    engine: { name: 'pi', version: '0.85.1' },
    node: { version: 'v24.16.0', execPath: '/usr/bin/node' },
    artifacts: [{ role: 'agent-host-bundle', path: 'dist/agent-host.mjs', sha256: HEX64, bytes: 2048 }],
    digest: HEX64,
  },
});

describe('RunSnapshotManifest', () => {
  it('a sample validates', () => {
    const check = Compile(RunSnapshotManifest);
    const value = sample();
    const errors = [...check.Errors(value)];
    expect(errors).toEqual([]);
    expect(check.Check(value)).toBe(true);
  });

  it('rejects an unknown top-level property (additionalProperties: false)', () => {
    const check = Compile(RunSnapshotManifest);
    expect(check.Check({ ...sample(), extra: true })).toBe(false);
  });

  it('accepts a future trust.grantedBy value (OPEN on the wire, ADR-0004)', () => {
    const check = Compile(RunSnapshotManifest);
    const value = sample();
    value.config.trust.grantedBy = 'a-future-value';
    expect(check.Check(value)).toBe(true);
  });

  it('rejects a wrong manifestVersion', () => {
    const check = Compile(RunSnapshotManifest);
    expect(check.Check({ ...sample(), manifestVersion: 2 })).toBe(false);
  });
});
