// S-20 (DESIGN 7.4, PLAN F-8): with canaries in the PARENT env, no canary name or value ever reaches a `node`
// child, and every visible name lies in `allow ∪ OS_INJECTED_ENV[platform]` — never an exact-equality assertion,
// because macOS injects `__CF_USER_TEXT_ENCODING` into every process regardless of what the executor asked for.
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { ExecRequest } from '../../src/contract/index.ts';
import { visibleEnvAllowed } from '../../src/contract/index.ts';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, nodeRequest } from './support.ts';

const CANARY = 'canary-value-must-never-leak';
const REPORT_ENV =
  'process.stdout.write(JSON.stringify({keys: Object.keys(process.env), values: Object.values(process.env)}))';

/** Runs `REPORT_ENV` with the canaries in the PARENT env and asserts the invariant on what the child could see. */
async function assertEnvIsAllowlisted(tempDir: string, limits: ExecRequest['limits']): Promise<void> {
  const previous = { key: process.env.ANTHROPIC_API_KEY, token: process.env.GH_TOKEN };
  process.env.ANTHROPIC_API_KEY = CANARY;
  process.env.GH_TOKEN = CANARY;
  try {
    const allow = ['PATH'];
    const req = nodeRequest(canonical(tempDir), REPORT_ENV, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      limits,
    });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });
    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    const report = JSON.parse(result.tail) as { keys: string[]; values: string[] };
    const allowed = visibleEnvAllowed(allow, process.platform);

    for (const key of report.keys) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(report.keys).not.toContain('ANTHROPIC_API_KEY');
    expect(report.keys).not.toContain('GH_TOKEN');
    expect(report.values).not.toContain(CANARY);
  } finally {
    if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.key;
    if (previous.token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.token;
  }
}

describe('S-20: L0 env is built ONLY from ExecRequest.env, never process.env', () => {
  // The direct-spawn path (no rlimit requested): no shell exists, so there is nothing that could re-export a name.
  test('no canary name or value reaches a node child; every visible name lies in the allowlist', async ({
    tempDir,
  }) => {
    await assertEnvIsAllowlisted(tempDir, {});
  }, 10_000);

  // The wrapper path, which is where the invariant is actually FRAGILE: macOS `/bin/sh` re-exports `PWD` and
  // `SHLVL` into the environ on every `exec`, and only the wrapper's `/usr/bin/env -u PWD -u SHLVL` strips them.
  // Neither name is in `allow` nor in `OS_INJECTED_ENV`, so a regression there fails right here.
  test('a request that asks for rlimits goes through the shell wrapper and is still exactly the allowlist', async ({
    tempDir,
  }) => {
    await assertEnvIsAllowlisted(tempDir, { cpuSeconds: 30, openFiles: 256 });
  }, 10_000);

  test('a name outside the allowlist is refused by the invariant helper itself (sanity)', () => {
    const allowed = visibleEnvAllowed(['PATH'], 'darwin');
    expect(allowed.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(allowed.has('__CF_USER_TEXT_ENCODING')).toBe(true);
  });
});
