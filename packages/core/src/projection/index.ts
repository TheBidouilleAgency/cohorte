import type { DurableEnvelope } from '@cohorte/persistence/contract';
import type { Projection, ProjectionDeps } from '../contract/factories.ts';
import type { RunState } from '../contract/types.ts';
import { evolve } from '../state/evolve.ts';

export type { Projection, ProjectionDeps };
export function createProjection(_deps: ProjectionDeps): Projection {
  return { evolve: (state: RunState, envelope: DurableEnvelope) => evolve(state, envelope) };
}
