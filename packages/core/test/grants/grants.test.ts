import { describe, expect, test } from 'vitest';
import { createGrantComputer } from '../../src/grants/index.ts';

describe('grant computation', () => {
  test('keeps implementation writes inside the owned surface and is deterministic', () => {
    const request = { role: 'implementer', ownedPaths: ['packages/core'], tools: ['read_file', 'write_file'] } as const;
    const computer = createGrantComputer({});
    const first = computer.compute(request);
    const second = computer.compute(request);

    expect(first.write.include).toEqual(['packages/core/**']);
    expect(first.denyWrite.include).toContain('**/.cohorte/**');
    expect(first.digest).toBe(second.digest);
  });

  test('reviewers cannot write or execute', () => {
    const grant = createGrantComputer({}).compute({
      role: 'reviewer',
      ownedPaths: ['packages/core'],
      tools: ['read_file', 'write_file', 'patch_file', 'run_command'],
    });

    expect(grant.tools).toEqual(['read_file']);
    expect(grant.write.include).toEqual([]);
    expect(grant.denyWrite.include).toContain('**');
  });
});
