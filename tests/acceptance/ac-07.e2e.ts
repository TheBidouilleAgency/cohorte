import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('AC-07 published schemas stay free of runtime-specific protocol identifiers', async () => {
  const names = ['events.schema.json', 'commands.schema.json'];
  for (const name of names) {
    const text = await readFile(`schemas/${name}`, 'utf8');
    expect(text).not.toMatch(/\bpi\b|claude|codex/i);
  }
});
