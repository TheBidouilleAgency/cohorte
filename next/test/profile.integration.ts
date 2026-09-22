import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerChecks } from '../src/checks.ts';
import { parseConfig } from '../src/contracts.ts';
import { prepareProfile } from '../src/profile.ts';

test('real prepared image: isolated generated files, reusable checks, stale manifests and source links rejected', {
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-profile-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'package.json'), '{"name":"profile-fixture","version":"1.0.0"}');
    await writeFile(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'profile-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'profile-fixture', version: '1.0.0' } },
      }),
    );
    await writeFile(join(repo, '.env'), 'HOST_PRIVATE_SENTINEL');
    await writeFile(
      join(repo, 'src/check.cjs'),
      `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.existsSync('.env'), false);
assert.throws(() => fs.writeFileSync('/workspace/escape', 'no'));
fs.mkdirSync('dist'); fs.writeFileSync('dist/result.txt', 'generated');
assert.equal(fs.readFileSync('dist/result.txt', 'utf8'), 'generated');
console.log('temporary output verified');
`,
    );
    const profile = {
      version: 1,
      baseImage: 'node:24-alpine',
      nodeHeapMb: 384,
      copyPaths: ['src', 'package.json'],
      config: {
        model: 'gpt-6-astra',
        codex: 'codex',
        docker: 'docker',
        image: 'prepared',
        checks: [['node', 'src/check.cjs']],
        writablePaths: ['src'],
        maxRounds: 1,
        timeoutMs: 120000,
      },
    };
    const file = join(root, 'profile.json');
    await writeFile(file, JSON.stringify(profile));
    const signal = new AbortController().signal;
    await assert.rejects(prepareProfile(repo, file, join(repo, 'output'), signal), /outside/);
    const prepared = await prepareProfile(repo, file, join(root, 'prepared'), signal);
    assert.match(prepared.image, /^sha256:/);
    assert.deepEqual((await readdir(join(root, 'prepared/image'))).sort(), [
      'Dockerfile',
      'check.mjs',
      'package-lock.json',
      'package.json',
      'profile.json',
    ]);
    const config = parseConfig(JSON.parse(await readFile(prepared.config, 'utf8')));
    const run = { id: 'profile-integration', worktree: repo, config };
    const checks = new DockerChecks();
    for (let i = 0; i < 2; i++) {
      const [result] = await checks.execute(run, signal);
      assert.equal(result?.exitCode, 0, result?.output);
      assert.match(result.output, /temporary output verified/);
      assert(!(await readdir(repo)).includes('dist'));
    }
    await assert.rejects(prepareProfile(repo, file, join(root, 'prepared'), signal), /EEXIST/);
    await symlink(join(repo, '.env'), join(repo, 'src/link'));
    const [linked] = await checks.execute(run, signal);
    assert(linked);
    assert.notEqual(linked.exitCode, 0);
    assert.match(linked.output, /Non-regular source path/);
    await rm(join(repo, 'src/link'));
    await writeFile(join(repo, 'package.json'), '{"name":"changed"}');
    const [stale] = await checks.execute(run, signal);
    assert(stale);
    assert.notEqual(stale.exitCode, 0);
    assert.match(stale.output, /Dependencies changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
