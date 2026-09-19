import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig, resolveConfig } from '../../src/load/index.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('config loading', () => {
  test('walks up to the project config and resolves a trusted CLI override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-config-'));
    roots.push(root);
    await mkdir(join(root, '.cohorte'), { recursive: true });
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await writeFile(join(root, '.cohorte', 'config.yaml'), 'host:\n  pollMs: 300\n');
    await writeFile(join(root, '.cohorte', 'ownership.yaml'), 'surfaces: {}\n');

    const loaded = await loadConfig({ cwd: join(root, 'packages', 'app'), home: join(root, 'home') });
    const resolved = await resolveConfig(loaded, {
      trustStore: { lookup: async () => undefined } as never,
      projectKeyId: 'project-test',
      trustProjectConfig: true,
    });

    expect(loaded.projectRoot).toBe(root);
    expect(resolved.status).toBe('resolved');
  });
});
