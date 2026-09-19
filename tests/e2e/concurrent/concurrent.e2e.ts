import { createMemoryStateStore } from '@cohorte/persistence/memory';
import { FixedClock, SeqIds } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';

describe('concurrent runs', () => {
  test('refuses overlapping zones and permits disjoint zones', async () => {
    const store = createMemoryStateStore({ clock: new FixedClock(), ids: new SeqIds() });
    try {
      await store.open();
      const owner = { hostId: 'host-a', pid: 1, startToken: 'a' };
      const other = { hostId: 'host-b', pid: 2, startToken: 'b' };
      const first = await store.acquireLock({
        scope: 'zone',
        key: 'project',
        mode: 'exclusive',
        owner,
        zones: ['src/app'],
        ttlMs: 60_000,
      });
      expect(first.ok).toBe(true);
      const overlap = await store.acquireLock({
        scope: 'zone',
        key: 'project',
        mode: 'exclusive',
        owner: other,
        zones: ['src/app/ui'],
        ttlMs: 60_000,
      });
      expect(overlap.ok).toBe(false);
      if (!overlap.ok) expect(overlap.heldBy[0]?.zones).toEqual(['src/app']);

      const disjoint = await store.acquireLock({
        scope: 'zone',
        key: 'project',
        mode: 'exclusive',
        owner: other,
        zones: ['src/docs'],
        ttlMs: 60_000,
      });
      expect(disjoint.ok).toBe(true);
    } finally {
      await store.close();
    }
  });
});
