import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('AC-12 CI jobs map to local ci scripts', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts?: Record<string, string> };
  for (const job of [
    'lint',
    'typecheck',
    'unit',
    'integration',
    'schema-compat',
    'migrations',
    'packaging',
    'e2e-fake',
    'crash-matrix',
    'security',
    'dogfood',
    'acceptance',
    'pi-latest',
    'live-provider',
  ]) {
    expect(workflow).toContain(`pnpm ci:${job}`);
    expect(packageJson.scripts?.[`ci:${job}`]).toBeTypeOf('string');
  }
});
