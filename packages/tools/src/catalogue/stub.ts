// The Wave-0 seam of every catalogue tool. It lives in its own module — not in `./index.ts` — so that `./index.ts`
// can assemble `TOOL_CATALOGUE` from `impl/**` (DESIGN 2.7) while `impl/**` keeps importing the stub: the edge runs
// `index.ts -> impl/** -> stub.ts` in one direction only.
import type { JsonValue } from '@cohorte/base';
import { NotImplemented } from '@cohorte/base';
import { CATALOGUE_ROWS } from './schemas.ts';
import type { ToolExecuteResult, ToolImplementation, ToolPlan } from './types.ts';

const rowByName = new Map(CATALOGUE_ROWS.map((row) => [row.name, row]));

/**
 * Every deliverable of THIS unit (U0.08) ends here: a `ToolImplementation` whose `plan`/`execute`/`verifyAfterCrash`
 * /`describeForNote` throw. The metadata (`name`, `inputSchema`, `description`, `effect`, `terminal`) is real —
 * `impl/read`, `impl/write`, `impl/exec` and `impl/state` (Wave 2: `U2.03`, `U2.04`) call this for every tool they
 * do not yet implement, and REPLACE the body, never the metadata, one tool at a time.
 */
export function stubImplementation(name: string): ToolImplementation {
  const row = rowByName.get(name);
  if (!row) throw new RangeError(`stubImplementation: unknown tool ${JSON.stringify(name)}`);
  const notImplemented = (member: string): never => {
    throw new NotImplemented(`tools/${name}.${member} (Wave 2 fills packages/tools/src/impl/**)`);
  };
  return {
    name: row.name,
    inputSchema: row.inputSchema,
    description: row.description,
    effect: row.effect,
    terminal: row.terminal,
    plan(): ToolPlan | null {
      return notImplemented('plan');
    },
    execute(): Promise<ToolExecuteResult<JsonValue>> {
      return notImplemented('execute');
    },
    verifyAfterCrash(): Promise<'done' | 'not-done' | 'in-doubt'> {
      return notImplemented('verifyAfterCrash');
    },
    describeForNote(): string {
      return notImplemented('describeForNote');
    },
  };
}
