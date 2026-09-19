import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function buildFrontendBackend(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-fixture-fb-'));
  await mkdir(join(root, '.cohorte', 'specs'), { recursive: true });
  await mkdir(join(root, 'frontend'), { recursive: true });
  await mkdir(join(root, 'backend'), { recursive: true });
  await writeFile(
    join(root, '.cohorte', 'ownership.yaml'),
    'surfaces:\n  frontend: { paths: [frontend/**], owners: [implementer], reviewers: [reviewer] }\n  backend: { paths: [backend/**], owners: [implementer], reviewers: [reviewer] }\n  shared: { paths: [contracts/**], owners: [implementer], reviewers: [reviewer], approval: human }\n',
  );
  await writeFile(join(root, 'frontend/index.ts'), 'export const app = true;\n');
  await writeFile(join(root, 'backend/index.ts'), 'export const api = true;\n');
  await mkdir(join(root, 'contracts'), { recursive: true });
  await writeFile(join(root, 'contracts/api.md'), '# API contract\n');
  return root;
}
