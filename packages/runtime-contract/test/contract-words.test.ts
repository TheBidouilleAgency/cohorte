import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('no orchestration vocabulary and no engine name in an exported name or schema key (DESIGN 1.2)', () => {
  const run = spawnSync(process.execPath, ['scripts/check-contract-words.ts'], { cwd: root, encoding: 'utf8' });
  expect(`${run.stdout}${run.stderr}`).toContain('check-contract-words: OK');
  expect(run.status).toBe(0);
});
