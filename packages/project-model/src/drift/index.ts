import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type Clock, sha256Hex } from '@cohorte/base';
import { parse } from 'yaml';
import type { ActualState, DesiredState, DriftEntry, DriftReport } from '../contract.ts';

export async function readActualState(root: string): Promise<ActualState> {
  const stateRoot = join(root, '.cohorte');
  let manifest = null;
  try {
    manifest = parse(await readFile(join(stateRoot, 'manifest.yaml'), 'utf8')) as ActualState['manifest'];
  } catch {
    return { manifest: null, files: [] };
  }
  const files: ActualState['files'] = [];
  const visit = async (dir: string): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'state' || entry.name === 'runs') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          const relativePath = relative(stateRoot, path).split('\\').join('/');
          const generated =
            relativePath === 'manifest.yaml'
              ? { path: relativePath, templateId: 'cohorte/manifest/v1', renderedSha256: sha256Hex(bytes) }
              : manifest?.generated.find((item) => item.path === relativePath);
          files.push({
            path: relativePath,
            class: generated ? 'generated' : 'human',
            sha256: sha256Hex(bytes),
            ...(generated?.templateId ? { templateId: generated.templateId } : {}),
          });
        }
      }
    } catch {
      return;
    }
  };
  await visit(stateRoot);
  return { manifest, files };
}

export function diffStates(desired: DesiredState, actual: ActualState, clock: Clock): DriftReport {
  const desiredByPath = new Map(desired.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const recorded = new Map((actual.manifest?.generated ?? []).map((file) => [file.path, file.renderedSha256]));
  const paths = [...new Set([...desiredByPath.keys(), ...actualByPath.keys()])].sort();
  const entries = paths.flatMap((path): DriftEntry[] => {
    const expected = desiredByPath.get(path);
    const found = actualByPath.get(path);
    const recordedSha256 = recorded.get(path);
    if (!found && expected)
      return [
        {
          target: path,
          class: expected.class,
          diff: 'absent' as const,
          desiredSha256: expected.sha256,
          ...(recordedSha256 ? { recordedSha256 } : {}),
          detail: 'desired file is absent',
        },
      ];
    if (found && !expected)
      return [
        {
          target: path,
          class: found.class,
          diff: found.class === 'generated' ? ('potential-deletion' as const) : ('unknown' as const),
          actualSha256: found.sha256,
          ...(recordedSha256 ? { recordedSha256 } : {}),
          detail: 'file exists but is not desired',
        },
      ];
    if (!found || !expected) throw new Error('unreachable drift entry');
    if (found.sha256 === expected.sha256) return [];
    if (found.class === 'human')
      return [
        {
          target: path,
          class: found.class,
          diff: 'human-change' as const,
          desiredSha256: expected.sha256,
          actualSha256: found.sha256,
          ...(recordedSha256 ? { recordedSha256 } : {}),
          detail: 'content changed in a human-owned file',
        },
      ];
    if (recordedSha256 === undefined || found.sha256 === recordedSha256)
      return [
        {
          target: path,
          class: expected.class,
          diff: 'expected-change' as const,
          desiredSha256: expected.sha256,
          actualSha256: found.sha256,
          ...(recordedSha256 ? { recordedSha256 } : {}),
          detail: 'generated content differs from the previous render',
        },
      ];
    return [
      {
        target: path,
        class: found.class,
        diff: 'conflict' as const,
        desiredSha256: expected.sha256,
        actualSha256: found.sha256,
        recordedSha256,
        detail: 'content changed since the recorded render',
      },
    ];
  });
  return { schemaVersion: 1, generatedAt: clock.now(), entries };
}
