// apps/cli/test/registry/embed-assets.test.ts — PLAN U0.10 test list: "embed-assets is deterministic (two runs,
// identical treeSha256); a tampered asset is detected". Runs `scripts/embed-assets.ts` as a SUBPROCESS
// (`node scripts/embed-assets.ts ...`), never a relative import: `check-layers` rule a refuses a relative import
// that leaves `apps/cli` (`scripts/` is not a `@cohorte/*` package, so there is no "import by name" either) — the
// same reason `apps/cli/test/registry/packaging.test.ts` spawns `build.ts` / `pack-check.ts` instead of importing
// them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/embed-assets.ts');

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSourceTree(): string {
  const repoRoot = tempDir('cohorte-embed-src-');
  mkdirSync(join(repoRoot, 'prompts/agents'), { recursive: true });
  mkdirSync(join(repoRoot, 'skills'), { recursive: true });
  mkdirSync(join(repoRoot, 'migrations/config'), { recursive: true });
  writeFileSync(join(repoRoot, 'prompts/agents/implementer.md'), '# implementer\n');
  writeFileSync(join(repoRoot, 'skills/README.md'), '# skills\n');
  writeFileSync(join(repoRoot, 'migrations/config/README.md'), '# migrations\n');
  // schemas/ intentionally absent: U0.G has not run yet (PLAN optimistic scheduling).
  return repoRoot;
}

interface AssetManifest {
  readonly treeSha256: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
}

function embed(repoRoot: string, outDir: string): AssetManifest {
  const done = spawnSync(
    process.execPath,
    [SCRIPT, '--repo-root', repoRoot, '--out-dir', outDir, '--cohorte-version', '9.9.9'],
    { encoding: 'utf8' },
  );
  if (done.status !== 0) throw new Error(`embed-assets subprocess failed: ${done.stderr}`);
  return JSON.parse(done.stdout) as AssetManifest;
}

function verify(outDir: string): { ok: boolean; mismatches: readonly { path: string; reason: string }[] } {
  const done = spawnSync(process.execPath, [SCRIPT, '--verify', outDir], { encoding: 'utf8' });
  return JSON.parse(done.stdout);
}

describe('embed-assets', () => {
  test('two runs over the same source tree produce an identical treeSha256', () => {
    const repoRoot = makeSourceTree();
    const out1 = tempDir('cohorte-embed-out1-');
    const out2 = tempDir('cohorte-embed-out2-');
    const manifest1 = embed(repoRoot, out1);
    const manifest2 = embed(repoRoot, out2);
    expect(manifest1.treeSha256).toBe(manifest2.treeSha256);
    expect(manifest1.files).toEqual(manifest2.files);
  });

  test('a missing schemas/ root contributes zero files without failing', () => {
    const repoRoot = makeSourceTree();
    const out = tempDir('cohorte-embed-out-');
    const manifest = embed(repoRoot, out);
    expect(manifest.files.some((file) => file.path.startsWith('schemas/'))).toBe(false);
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  test('files are sorted by byte order, not localeCompare', () => {
    const repoRoot = makeSourceTree();
    writeFileSync(join(repoRoot, 'prompts/Z.md'), 'z\n');
    writeFileSync(join(repoRoot, 'prompts/_a.md'), 'a\n');
    const out = tempDir('cohorte-embed-out-');
    const manifest = embed(repoRoot, out);
    const paths = manifest.files.map((f) => f.path);
    const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(paths).toEqual(sorted);
  });

  test('verify: ok on a freshly embedded tree', () => {
    const repoRoot = makeSourceTree();
    const out = tempDir('cohorte-embed-out-');
    embed(repoRoot, out);
    expect(verify(out)).toEqual({ ok: true, mismatches: [] });
  });

  test('verify: a tampered asset is detected', () => {
    const repoRoot = makeSourceTree();
    const out = tempDir('cohorte-embed-out-');
    embed(repoRoot, out);
    writeFileSync(join(out, 'prompts/agents/implementer.md'), '# implementer TAMPERED\n');
    const result = verify(out);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual({ path: 'prompts/agents/implementer.md', reason: 'hash-mismatch' });
  });

  test('verify: a missing manifest is reported, not thrown', () => {
    const out = tempDir('cohorte-embed-empty-');
    const result = verify(out);
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]?.reason).toBe('missing');
  });
});
