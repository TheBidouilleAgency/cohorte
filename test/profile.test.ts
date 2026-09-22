import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseProfile, validateManifests } from '../src/profile.ts';

const sample = JSON.parse(await readFile(new URL('../examples/francois.profile.json', import.meta.url), 'utf8'));
test('profile rejects injected image instructions, source escape and unbounded resources', () => {
  assert.deepEqual(parseProfile(sample), sample);
  for (const change of [
    { version: 2 },
    { baseImage: 'node:24\nRUN evil' },
    { nodeHeapMb: 4096 },
    { copyPaths: ['package.json', '../secret'] },
    { copyPaths: ['package.json', '/home'] },
    { copyPaths: ['package.json', '.env'] },
    { copyPaths: ['package.json', 'node_modules'] },
    { copyPaths: ['package.json', 'src', 'src'] },
    { copyPaths: ['src'] },
    { config: { ...sample.config, image: 'unprepared:latest' } },
    { typo: true },
  ])
    assert.throws(() => parseProfile({ ...sample, ...change }));
});

test('npm preparation refuses workspace, local and git dependencies before a build', () => {
  const pkg = Buffer.from('{"name":"fixture"}');
  const lock = (entry: object) =>
    Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': entry } }));
  validateManifests(pkg, lock({ resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' }));
  for (const entry of [
    { link: true },
    { resolved: 'file:../private' },
    { resolved: 'git+ssh://host/a' },
    { resolved: 123 },
  ])
    assert.throws(() => validateManifests(pkg, lock(entry)));
  assert.throws(() => validateManifests(Buffer.from('{"workspaces":["apps/*"]}'), lock({})));
  assert.throws(() => validateManifests(pkg, Buffer.from('{"lockfileVersion":1}')));
});
