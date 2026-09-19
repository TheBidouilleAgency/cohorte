// DESIGN 1.2 port table ("`ToolRegistry`, `WorkspaceReader` | `tools`") — the `ToolRegistry` type, frozen in Wave 0
// so `core/src/contract/ports.ts` can name it without importing `packages/tools/src/impl/**`. The factory,
// `createToolRegistry(impls)`, is Wave 2's (`U2.03`): "implementations are PASSED IN by the composition root: this
// unit never imports U2.04" (PLAN U2.03) — U0.08 (this unit) never imports `impl/**` here either, for the same
// reason: only the TYPE is frozen now, the lookup table is built once every tool is real.
import type { ToolImplementation } from '../catalogue/index.ts';

/** `CohorteToolHost` stage 7 looks a tool up by name (`plan`/`execute`), inside its per-slot effect mutex. */
export interface ToolRegistry {
  get(tool: string): ToolImplementation | undefined;
  names(): readonly string[];
}

export function createToolRegistry(implementations: Readonly<Record<string, ToolImplementation>>): ToolRegistry {
  const entries = new Map(Object.entries(implementations));
  return Object.freeze({
    get: (tool: string) => entries.get(tool),
    names: () => Object.freeze([...entries.keys()]),
  });
}
