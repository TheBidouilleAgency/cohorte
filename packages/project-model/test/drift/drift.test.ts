import { toIsoInstant } from '@cohorte/base';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { diffStates } from '../../src/drift/index.ts';

describe('project drift', () => {
  test('does not report identical files', () => {
    const sha = 'a'.repeat(64) as never;
    const report = diffStates(
      { cohorteVersion: '3.0.0', files: [{ path: 'project.yaml', class: 'generated', sha256: sha }] },
      { manifest: null, files: [{ path: 'project.yaml', class: 'generated', sha256: sha }] },
      new FixedClock(toIsoInstant(0)),
    );
    expect(report.entries).toEqual([]);
  });
});
