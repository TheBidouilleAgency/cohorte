import { describe, expect, test } from 'vitest';
import { buildUnknownAmbiguous } from '../../../fixtures/repos/unknown-ambiguous/build.ts';
import { runCli } from '../support/cli.ts';

describe('unknown project', () => {
  test('reports ambiguity without inventing a command', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const root = await buildUnknownAmbiguous();
    const result = await runCli(root, root, ['discover', '--json']);
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as { unknowns?: readonly unknown[]; commands?: unknown };
    expect(model.unknowns).toHaveLength(1);
    expect(model.commands).toEqual({});
  });
});
