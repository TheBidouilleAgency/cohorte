import type { Sha256 } from '@cohorte/base';
import { createMemoryBlobStore } from '@cohorte/persistence/memory';
import { FAKE_CAPABILITIES } from '@cohorte/runtime-fake';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, it } from 'vitest';
import { createRunSnapshotterImpl } from '../../src/snapshot/implementation.ts';

const hash = 'a'.repeat(64) as Sha256;

describe('RunSnapshotter', () => {
  it('materializes config and spec bytes into the CAS and verifies the manifest', async () => {
    const store = createMemoryBlobStore();
    const files: Record<string, Uint8Array> = {
      '/project/.cohorte/config.yaml': new TextEncoder().encode('config: true\n'),
      '/project/.cohorte/ownership.yaml': new TextEncoder().encode('ownership: true\n'),
      '/project/.cohorte/policy.yaml': new TextEncoder().encode('policy: true\n'),
      '/project/spec.md': new TextEncoder().encode('# Spec\n'),
    };
    const materialized: string[] = [];
    const snapshotter = createRunSnapshotterImpl({
      installInspector: { installDir: () => '/install', bundleManifest: async () => [] },
      clock: new FixedClock(),
      pinStore: store,
      metadata: {
        app: { version: '3.0.0', gitHash: null },
        packages: [],
        assets: { treeSha256: hash, embeddedTreeSha256: hash },
        schemas: { stateSchemaVersion: 1, configSchemaVersion: 1, transitionTableVersion: 1 },
        prompts: [],
        skills: [],
        environment: {
          pinnedPath: ['/usr/bin'],
          platform: 'darwin',
          arch: 'arm64',
          sandbox: {
            level: 'L0-process',
            backend: 'none',
            filesystem: 'advisory',
            network: 'unenforced',
            processEscape: 'possible',
            envFiltering: 'enforced',
            timeout: 'enforced',
            outputCap: 'enforced',
            cpuTime: 'unavailable',
            memory: 'unavailable',
            processes: 'unavailable',
            killTree: 'process-group-with-sweep',
            missing: [],
            notes: [],
          },
          runtimeCapabilities: FAKE_CAPABILITIES,
        },
        readFile: async (path) => files[path] ?? new Uint8Array(),
        onMaterialized: (path) => materialized.push(path),
      },
    });
    const manifest = await snapshotter.capture({
      runId: 'run_0123456789abcdef0123456789abcdef' as never,
      projectRoot: '/project',
      installDir: '/install',
      spec: { id: 'spec-1' as never, path: '/project/spec.md' },
      configPaths: {
        config: '/project/.cohorte/config.yaml',
        ownership: '/project/.cohorte/ownership.yaml',
        policy: '/project/.cohorte/policy.yaml',
      },
      runtime: {
        runtimeId: 'fake',
        adapterVersion: '1',
        engine: { name: 'fake', version: '1' },
        node: { version: 'v24', execPath: '/usr/bin/node' },
        artifacts: [],
        digest: hash,
      },
      trust: { policySha256: hash, loosenedKeys: [], grantedBy: 'none-needed' },
      sandbox: {} as never,
      models: [],
    });
    expect(materialized).toEqual(['config.yaml', 'ownership.yaml', 'policy.yaml', 'spec.md']);
    expect((await snapshotter.verify(manifest)).ok).toBe(true);
  });

  it('pins prompt bytes and keeps their digest independent from the source file', async () => {
    const store = createMemoryBlobStore();
    const files: Record<string, Uint8Array> = {
      '/project/.cohorte/config.yaml': new TextEncoder().encode('config: true\n'),
      '/project/.cohorte/ownership.yaml': new TextEncoder().encode('ownership: true\n'),
      '/project/.cohorte/policy.yaml': new TextEncoder().encode('policy: true\n'),
      '/install/prompts/agents/implementer.md': new TextEncoder().encode('original prompt\n'),
    };
    const snapshotter = createRunSnapshotterImpl({
      installInspector: { installDir: () => '/install', bundleManifest: async () => [] },
      clock: new FixedClock(),
      pinStore: store,
      metadata: {
        app: { version: '3.0.0', gitHash: null },
        packages: [],
        assets: { treeSha256: hash, embeddedTreeSha256: hash },
        schemas: { stateSchemaVersion: 1, configSchemaVersion: 1, transitionTableVersion: 1 },
        prompts: [],
        skills: [],
        environment: {
          pinnedPath: ['/usr/bin'],
          platform: 'darwin',
          arch: 'arm64',
          sandbox: {
            level: 'L0-process',
            backend: 'none',
            filesystem: 'advisory',
            network: 'unenforced',
            processEscape: 'possible',
            envFiltering: 'enforced',
            timeout: 'enforced',
            outputCap: 'enforced',
            cpuTime: 'unavailable',
            memory: 'unavailable',
            processes: 'unavailable',
            killTree: 'process-group-with-sweep',
            missing: [],
            notes: [],
          },
          runtimeCapabilities: FAKE_CAPABILITIES,
        },
        readFile: async (path) => files[path] ?? new Uint8Array(),
      },
    });
    const manifest = await snapshotter.capture({
      runId: 'run_0123456789abcdef0123456789abcdef' as never,
      projectRoot: '/project',
      installDir: '/install',
      configPaths: {
        config: '/project/.cohorte/config.yaml',
        ownership: '/project/.cohorte/ownership.yaml',
        policy: '/project/.cohorte/policy.yaml',
      },
      runtime: {
        runtimeId: 'fake',
        adapterVersion: '1',
        engine: { name: 'fake', version: '1' },
        node: { version: 'v24', execPath: '/usr/bin/node' },
        artifacts: [],
        digest: hash,
      },
      trust: { policySha256: hash, loosenedKeys: [], grantedBy: 'none-needed' },
      sandbox: {} as never,
      models: [],
      prompts: [
        {
          id: 'agents/implementer',
          source: 'shipped',
          logicalPath: 'prompts/agents/implementer.md',
          path: '/install/prompts/agents/implementer.md',
        },
      ],
    });
    files['/install/prompts/agents/implementer.md'] = new TextEncoder().encode('mutated prompt\n');
    expect(manifest.prompts).toHaveLength(1);
    expect(await store.read(manifest.prompts[0]?.sha256 ?? hash)).toEqual(
      new TextEncoder().encode('original prompt\n'),
    );
    expect((await snapshotter.verify(manifest)).ok).toBe(true);
  });
});
