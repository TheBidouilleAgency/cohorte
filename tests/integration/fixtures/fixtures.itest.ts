import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Spec, specContentSha256 } from '@cohorte/config/schema';
import { parseFakeScript } from '@cohorte/runtime-fake';
import { describe, expect, test } from 'vitest';
import { buildFrontendBackend } from '../../../fixtures/repos/frontend-backend/build.ts';
import { buildTsMonorepo } from '../../../fixtures/repos/ts-monorepo/build.ts';

describe('V3 E2E fixtures', () => {
  test('builders produce fresh git-shaped repositories with exact checks and ownership', async () => {
    const ts = await buildTsMonorepo();
    const fb = await buildFrontendBackend();
    const config = await readFile(join(ts, '.cohorte/config.yaml'), 'utf8');
    const ownership = await readFile(join(fb, '.cohorte/ownership.yaml'), 'utf8');
    expect(config).toContain('test: [pnpm, test]');
    expect(ownership).toContain('frontend:');
    expect(ownership).toContain('backend:');
    expect(ownership).toContain('shared:');
  });

  test('fake scripts and the frozen spec source validate', async () => {
    const happy = await readFile(new URL('../../../fixtures/scripts/happy.yaml', import.meta.url), 'utf8');
    const result = parseFakeScript(happy, 'yaml');
    expect(result.ok).toBe(true);
    const draft = JSON.parse(
      JSON.stringify({
        id: 'add-greeting',
        kind: 'feature',
        status: 'draft',
        title: 'Add greeting',
        acceptance: ['the frontend exposes a greeting', 'the backend health endpoint remains available'],
        surfaces: {
          frontend: { tasks: ['expose the greeting'] },
          backend: { tasks: ['preserve the health endpoint'] },
        },
        contract: 'contracts/greeting.md',
        openQuestions: [],
      }),
    ) as Spec;
    expect(draft.status).toBe('draft');
    const frozen = { ...draft, status: 'frozen' as const, sha256: specContentSha256(draft) };
    expect(specContentSha256(frozen)).toBe(frozen.sha256);
  });
});
