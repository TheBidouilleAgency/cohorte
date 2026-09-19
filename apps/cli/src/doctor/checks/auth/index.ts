// apps/cli/src/doctor/checks/auth/index.ts — the `auth` doctor check (spec 10 "auth status"). Wave-0 typed stub:
// filled by `U5.05`, which owns `apps/cli/src/doctor/checks/auth/**`.
import type { DoctorCheck } from '../../../contract/index.ts';

const authDoctorCheck: DoctorCheck = {
  id: 'auth',
  description: "Checks that the configured provider's authentication is usable, without reading the token.",
  async run(ctx) {
    try {
      const statuses = await ctx.runtime.resolve().authStatus([]);
      const usable = statuses.every((status) => status.state !== 'absent' && status.state !== 'unknown-transient');
      const accountNote = statuses.some((status) => status.accountLabel === undefined)
        ? '; account: not exposed by the engine'
        : '';
      return {
        id: 'auth',
        status: usable ? 'ok' : 'warning',
        summary: `${usable ? 'runtime authentication is available' : 'runtime authentication needs attention'}${accountNote}`,
      };
    } catch (error) {
      return { id: 'auth', status: 'error', summary: `authentication status unavailable: ${String(error)}` };
    }
  },
};

export default authDoctorCheck;
