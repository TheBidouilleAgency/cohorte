import { describe, expect, test } from 'vitest';
import doctor from '../../src/commands/doctor/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('doctor', () => {
  test('publishes the complete check list as JSON', async () => {
    const out = captureStream();
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      install: { installDir: () => '/dist', bundleManifest: async () => [] },
    });
    expect(await doctor.run(ctx, { positionals: [], options: {}, json: true })).toBeLessThanOrEqual(1);
    const report = JSON.parse(out.text()) as { checks?: readonly unknown[]; ok?: boolean };
    expect(typeof report.ok).toBe('boolean');
    expect(report.checks?.length).toBeGreaterThan(0);
  });
});
