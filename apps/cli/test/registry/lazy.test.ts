// apps/cli/test/registry/lazy.test.ts — the verb loader. `lazy.ts` is the single `import(` site (DESIGN 1.2 net 3
// rule g) AND the one place a bundler has to be able to see every verb module: a runtime-computed specifier emits
// no chunk, so the SHIPPED cli.mjs could not execute a single verb. These tests pin the map against `VERBS` in both
// directions; `packaging.test.ts` proves the other half (the BUILT bundle really loads one).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { VERBS } from '../../src/contract/index.ts';
import { COMMAND_MODULES, loadCommandModule } from '../../src/lazy.ts';

const COMMANDS_DIR = join(import.meta.dirname, '../../src/commands');

describe('COMMAND_MODULES', () => {
  test('every registered verb has a loader', () => {
    const missing = VERBS.map((verb) => verb.name).filter((name) => !COMMAND_MODULES[name]);
    expect(missing, 'verbs in VERBS with no lazy.ts loader').toEqual([]);
  });

  test('every loader names a registered verb', () => {
    const names = new Set(VERBS.map((verb) => verb.name));
    const extra = Object.keys(COMMAND_MODULES).filter((name) => !names.has(name));
    expect(extra, 'lazy.ts loaders for unknown verbs').toEqual([]);
  });

  test('every loader points at an existing commands/<verb>/index.ts', () => {
    for (const name of Object.keys(COMMAND_MODULES)) {
      expect(existsSync(join(COMMANDS_DIR, name, 'index.ts')), `commands/${name}/index.ts is missing`).toBe(true);
    }
  });

  test('the map is frozen: nobody adds a verb at run time', () => {
    expect(Object.isFrozen(COMMAND_MODULES)).toBe(true);
  });

  test.for(VERBS)('$name loads a CommandModule whose verb matches', async (verb) => {
    const mod = await loadCommandModule(verb.name);
    expect(mod.verb).toBe(verb.name);
    expect(typeof mod.run).toBe('function');
  });

  test('an unregistered verb is a RangeError, not a module-resolution failure', async () => {
    await expect(loadCommandModule('../../../etc/passwd')).rejects.toBeInstanceOf(RangeError);
    await expect(loadCommandModule('not-a-verb')).rejects.toThrow(/no command module registered/);
  });
});
