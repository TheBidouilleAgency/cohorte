// DESIGN 2.5.1 / ADR-0018 §3: `bugfix@1` = `feature@1` minus the BRAINSTORM/SPEC entry rows (T01-T03), with
// `spec.kind = 'patch'` selecting the patch PREFLIGHT contract variant — a `PhaseContract` concern (a later wave),
// not a transition-row shape difference. T04 (the `either`-actor `IDLE -> PREFLIGHT` entry) is untouched.
import type { TransitionTable } from '../../contract/types.ts';
import { FEATURE_STOP_ROW_MAP, FEATURE_V1 } from './feature.v1.ts';

const EXCLUDED_IDS = new Set(['T01', 'T02', 'T03']);
const EXCLUDED_PHASES = new Set(['BRAINSTORM', 'SPEC']);

export const BUGFIX_STOP_ROW_MAP = FEATURE_STOP_ROW_MAP;

export const BUGFIX_V1 = {
  profile: 'bugfix',
  version: 1,
  initial: 'IDLE',
  phases: FEATURE_V1.phases.filter((phase) => !EXCLUDED_PHASES.has(phase)),
  rows: FEATURE_V1.rows.filter((row) => !EXCLUDED_IDS.has(row.id)),
} as const satisfies TransitionTable;
