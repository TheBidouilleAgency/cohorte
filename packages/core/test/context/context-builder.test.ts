import { canonicalJson, sha256Hex } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { createContextBuilder } from '../../src/context/index.ts';
import type { ContextDeps } from '../../src/contract/factories.ts';
import type { AgentPlan } from '../../src/contract/types.ts';

describe('ContextBuilder', () => {
  test('renders deterministic system and task inputs through injected ports', async () => {
    const prompt = new TextEncoder().encode('system doctrine');
    const task = new TextEncoder().encode('implement surface');
    const plan = {
      agentId: 'agt_impl_web' as never,
      role: 'implementer',
      owner: 'web',
      promptId: 'agents/implementer',
      task: { role: 'implementer', objective: 'build', stablePrefix: 'implement surface', ownedPaths: ['web/**'] },
      context: { tiers: ['system', 'task'] as const },
      tools: ['read_file'],
      grant: { role: 'implementer', ownedPaths: ['web/**'], tools: ['read_file'] },
      modelTier: 'coding',
      budget: { maxEngineRetries: 0 },
      workspace: { kind: 'slot', slot: 'web' },
    } as never;
    const builder = createContextBuilder({
      writeTask: async (_plan: AgentPlan, bytes: Uint8Array) => ({
        path: 'contexts/task.md',
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      }),
    } as ContextDeps);
    const result = await builder.build(
      plan,
      {
        read: async () => prompt,
        ref: () => ({ path: '/assets/agents/implementer', sha256: sha256Hex(prompt), bytes: prompt.byteLength }),
      },
      {} as never,
    );
    expect(result.systemPrompt).toMatchObject({ id: 'agents/implementer', bytes: prompt.byteLength });
    expect(result.task).toMatchObject({ path: 'contexts/task.md', sha256: sha256Hex(task) });
    expect(result.manifest.entries.map((entry) => entry.id)).toEqual(['system-prompt', 'task']);
    expect(result.manifest.manifestSha256).toBe(sha256Hex(canonicalJson(result.manifest.entries)));
  });
});
