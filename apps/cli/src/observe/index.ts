// apps/cli/src/observe/index.ts — AREA barrel: the `Observer` port (DESIGN 4.7 "pure readers: no lock, no write,
// no temp file; durable events by sequence, poll 250 ms; ephemerals by tailing the spool; merge order (sequence,
// sub); first line = snapshot"). Wave-0 stub: filled by `U4.02`, which owns `apps/cli/src/observe/**`.
import type { JsonValue } from '@cohorte/base';
import type { StateStore } from '@cohorte/persistence/contract';
import type { Observer } from '../contract/index.ts';

export function createObserver(openStore?: () => Promise<StateStore>): Observer {
  return {
    follow(options) {
      return (async function* () {
        let sequence = options.sinceSequence ?? 0;
        let emitted = 0;
        do {
          if (options.signal?.aborted || !openStore) return;
          const store = await openStore();
          const events = await store.readEvents(options.runId as never, { afterSequence: sequence, limit: 1000 });
          await store.close();
          for (const event of events) {
            sequence = Math.max(sequence, event.sequence);
            if (options.replay !== undefined && emitted >= options.replay) return;
            emitted += 1;
            yield event as unknown as JsonValue;
          }
          if (events.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
        } while (!options.signal?.aborted);
      })();
    },
  };
}
