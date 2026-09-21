import { resolve } from 'node:path';

export function resolveSpecPath(cwd: string, value: string): string {
  if (value.includes('/') || value.includes('\\') || value.endsWith('.yaml')) return resolve(cwd, value);
  return resolve(cwd, '.cohorte', 'specs', `${value}.yaml`);
}
