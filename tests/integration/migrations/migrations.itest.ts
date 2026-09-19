import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('state migrations', () => {
  test('the initial migration is shipped and defines the state tables', () => {
    const path = join(process.cwd(), 'migrations/state/0001_init.sql');
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, 'utf8');
    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('runs');
    expect(sql).toContain('events');
  });
});
