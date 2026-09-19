import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { deriveDesiredState } from '../../src/desired/index.ts';
import { scanRepository } from '../../src/scan/index.ts';

describe('desired project state', () => {
  test('derives deterministic hashes for built-in files', async () => {
    const model = await scanRepository('.', { clock: new FixedClock(), toolVersion: 'test' });
    const state = deriveDesiredState({ model, config: DEFAULT_CONFIG, cohorteVersion: '3.0.0', skills: {} });
    expect(state.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['manifest.yaml', 'project.yaml', 'config.yaml']),
    );
    expect(new Set(state.files.map((file) => file.path)).size).toBe(state.files.length);
  });
});
