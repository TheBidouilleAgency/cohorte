import { EVENTS } from '@cohorte/protocol';
import { RUNTIME_EVENT_TYPE_NAMES, RUNTIME_EVENT_TYPES, type RuntimeEventType } from '@cohorte/runtime-contract';
import { describe, expect, it } from 'vitest';
import { RUNTIME_EVENT_TARGETS, SPECIAL_MAPPING_TARGETS, targetsOf } from '../../src/contract/event-mapping.ts';

describe('RUNTIME_EVENT_TARGETS', () => {
  it('every RuntimeEvent type has an entry (runtime totality mirroring the type-level `satisfies`)', () => {
    expect(Object.keys(RUNTIME_EVENT_TARGETS).sort()).toEqual([...RUNTIME_EVENT_TYPE_NAMES].sort());
  });

  it('EVERY target of every row is a special case or a key of EVENTS with the SAME durability', () => {
    for (const source of RUNTIME_EVENT_TYPE_NAMES) {
      const targets = targetsOf(source);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        if ((SPECIAL_MAPPING_TARGETS as readonly string[]).includes(target)) continue;
        expect(EVENTS).toHaveProperty(target);
        const sourceDurability = RUNTIME_EVENT_TYPES[source].durability;
        const targetDurability = EVENTS[target as keyof typeof EVENTS].durability;
        expect(targetDurability).toBe(sourceDurability);
      }
    }
  });

  it('has exactly the two documented special cases', () => {
    const specials = RUNTIME_EVENT_TYPE_NAMES.filter((source) =>
      targetsOf(source).some((target) => (SPECIAL_MAPPING_TARGETS as readonly string[]).includes(target)),
    ).sort();
    expect(specials).toEqual(['tool.call.delivered', 'tool.call.requested']);
  });

  it('carries BOTH targets of the one DESIGN 2.3.3 row that has two (agent.exited)', () => {
    // DESIGN 2.3.3: "`agent.exited` -> **`agent.completed`** or **`agent.failed`** (+ `agent.state.changed`),
    // decided by the supervisor from AgentExit + the accepted result". The table names the legal targets so the
    // Wave-3 mapper discovers nothing; it does not decide between them.
    expect(targetsOf('agent.exited')).toEqual(['agent.completed', 'agent.failed']);
  });

  it('targetsOf is single-valued for every other row', () => {
    const multi = RUNTIME_EVENT_TYPE_NAMES.filter((source: RuntimeEventType) => targetsOf(source).length > 1);
    expect(multi).toEqual(['agent.exited']);
  });
});
