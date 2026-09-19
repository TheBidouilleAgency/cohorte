import type { PhasesExecutorDeps } from '../../contract/factories.ts';
import { createPhaseExecutor as createPhaseExecutorImpl } from './implementation.ts';

export type { PhasesExecutorDeps };
export function createPhaseExecutor(deps: PhasesExecutorDeps) {
  return createPhaseExecutorImpl(deps);
}
