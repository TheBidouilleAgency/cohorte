import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function buildUnknownAmbiguous(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-fixture-unknown-'));
  await mkdir(join(root, '.cohorte'), { recursive: true });
  await writeFile(join(root, 'package-lock.json'), '{}\n');
  await writeFile(join(root, 'yarn.lock'), '# intentionally ambiguous\n');
  await writeFile(join(root, 'README.md'), '# Unknown project\n');
  return root;
}
