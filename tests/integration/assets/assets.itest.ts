import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkPrompts, checkPromptText } from '../../../scripts/check-prompts.ts';

describe('shipped assets', () => {
  test('the repository prompt tree has no control-flow instructions', () => {
    expect(checkPrompts(process.cwd())).toEqual([]);
  });

  test('detects transition vocabulary in a prompt fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-prompts-'));
    await mkdir(join(root, 'prompts'), { recursive: true });
    await writeFile(join(root, 'prompts', 'bad.md'), 'After review, transition to SHIP and stop the run.\n');
    expect(checkPromptText('prompts/bad.md', 'After review, transition to SHIP and stop the run.')).toHaveLength(1);
    expect(checkPrompts(root)).toHaveLength(1);
  });
});
