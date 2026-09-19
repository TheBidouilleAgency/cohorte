// DESIGN 1.2 — the one L3->L2 edge that is type-only: `tools -> persistence` (`import type` from
// `@cohorte/persistence/contract`, never a value import, never the package's other subpaths). `scripts/check-layers.ts`
// (run separately by this unit's check command) is the authoritative net over the whole tree; this test pins the
// property for `packages/tools/src` alone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..', '..', 'src');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** One `import`/`export ... from` line, whether or not it opens with `type`. Good enough for a single-package scan
 * (no re-exports of persistence subpaths exist under `packages/tools/src`, checked by the assertion below too). */
const IMPORT_LINE = /^\s*(import|export)\s+(type\s+)?(?:[^;]*?)\s+from\s+['"](@cohorte\/persistence[^'"]*)['"]/gm;

describe('every import of @cohorte/persistence under packages/tools/src is `import type` from ./contract', () => {
  const files = collectTsFiles(SRC_DIR);

  it('scans at least one file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relative = file.slice(SRC_DIR.length + 1);
    const text = readFileSync(file, 'utf8');
    const matches = [...text.matchAll(IMPORT_LINE)];
    if (matches.length === 0) continue;
    it(`${relative}`, () => {
      for (const match of matches) {
        const [, kind, typeKeyword, specifier] = match;
        expect(typeKeyword, `${relative}: ${specifier} must be \`import type\``).toBeDefined();
        expect(specifier).toBe('@cohorte/persistence/contract');
        expect(kind === 'import' || kind === 'export').toBe(true);
      }
    });
  }
});
