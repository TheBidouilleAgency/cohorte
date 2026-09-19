// apps/cli/src/contract/doctor.ts — the frozen list of doctor check modules (PLAN PC-4 "DoctorCheck + the frozen
// list of doctor check modules"). `doctor/index.ts` (area barrel, U4.05) runs every id of `DOCTOR_CHECK_IDS`
// through `doctor/checks/<id>/index.ts`; only `auth` is a Wave-0 owned stub (`apps/cli/src/doctor/checks/auth`,
// filled by U5.05) — the rest are created, under the same shape, by U4.05.
import type { DOCTOR_CHECK_STATUSES } from '@cohorte/protocol';
import type { CliContext } from './context.ts';

export type DoctorCheckStatus = (typeof DOCTOR_CHECK_STATUSES)[number];

export interface DoctorCheckResult {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly remediation?: string;
}

export interface DoctorCheck {
  readonly id: string;
  readonly description: string;
  run(ctx: CliContext): Promise<DoctorCheckResult>;
}

/** DESIGN §9 doctor capabilities + F-1 (ripgrep backend) + F-3 (sandbox availability) + 6.3 (protected roots). */
export const DOCTOR_CHECK_IDS = [
  'node-version',
  'git',
  'sqlite',
  'search-backend',
  'sandbox',
  'auth',
  'install',
  'config',
  'worktree-root',
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];
