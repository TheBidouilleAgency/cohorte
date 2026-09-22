import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Config, parseConfig } from './contracts.ts';
import { command } from './process.ts';

export interface Profile {
  version: 1;
  baseImage: string;
  nodeHeapMb: number;
  copyPaths: string[];
  config: Config;
}

export function parseProfile(value: unknown): Profile {
  const p = value as Profile;
  if (
    !p ||
    typeof p !== 'object' ||
    Array.isArray(p) ||
    Object.keys(p).sort().join(',') !== 'baseImage,config,copyPaths,nodeHeapMb,version' ||
    p.version !== 1 ||
    typeof p.baseImage !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]{0,255}$/.test(p.baseImage) ||
    !Number.isInteger(p.nodeHeapMb) ||
    p.nodeHeapMb < 64 ||
    p.nodeHeapMb > 384 ||
    !Array.isArray(p.copyPaths) ||
    !p.copyPaths.length ||
    p.copyPaths.length > 64 ||
    p.copyPaths.some(
      (path) =>
        typeof path !== 'string' ||
        !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(path) ||
        ['node_modules', 'vendor', 'dist', 'id_rsa', 'id_ed25519'].includes(path) ||
        /\.(pem|key|p12)$/i.test(path),
    ) ||
    new Set(p.copyPaths).size !== p.copyPaths.length ||
    !p.copyPaths.includes('package.json')
  )
    throw new Error('Invalid npm project profile; see examples/francois.profile.json');
  // Image is derived by prepare; the profile cannot silently select another image.
  const config = parseConfig(p.config);
  if (config.image !== 'prepared') throw new Error('Profile config.image must be "prepared"');
  return { ...structuredClone(p), config };
}

async function manifest(repo: string, name: string) {
  const file = await open(join(repo, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw new Error(`Invalid manifest: ${name}`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export function validateManifests(pkg: Buffer, lock: Buffer) {
  const packageJson = JSON.parse(pkg.toString('utf8'));
  const lockJson = JSON.parse(lock.toString('utf8'));
  if (packageJson.workspaces || ![2, 3].includes(lockJson.lockfileVersion) || !lockJson.packages)
    throw new Error('Only standalone npm projects with lockfile v2/v3 are supported');
  for (const entry of Object.values(lockJson.packages) as Record<string, unknown>[]) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.link ||
      (entry.resolved !== undefined && (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://')))
    )
      throw new Error('Only registry HTTPS dependencies are supported; no local/workspace/git dependencies');
  }
}

// Executed inside the check container only. The source bind mount stays read-only.
export const runner = String.raw`
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const profile = JSON.parse(readFileSync('/opt/cohorte/profile.json', 'utf8'));
for (const [name, expected] of Object.entries(profile.manifests)) {
  const path = '/workspace/' + name;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
    throw new Error('Invalid manifest: ' + name);
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== expected) throw new Error('Dependencies changed; run cohorte-next prepare again: ' + name);
}
const index = process.argv[2];
if (!/^(0|[1-9][0-9]*)$/.test(index ?? '') || !profile.checks[Number(index)])
  throw new Error('Unknown profile check');
const cwd = '/tmp/cohorte-project';
mkdirSync(cwd);
let bytes = 0;
let count = 0;
function inspect(path, depth = 0) {
  if (++count > 10000 || depth > 32) throw new Error('Source copy limit exceeded');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
    throw new Error('Non-regular source path: ' + path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name.startsWith('.') || ['node_modules', 'vendor', 'dist', 'id_rsa', 'id_ed25519'].includes(name) || /\.(pem|key|p12)$/i.test(name))
        throw new Error('Excluded source path: ' + name);
      inspect(path + '/' + name, depth + 1);
    }
  } else {
    bytes += stat.size;
    if (bytes > 64 * 1024 * 1024) throw new Error('Source copy exceeds 64 MiB');
  }
}
for (const name of profile.copyPaths) {
  inspect('/workspace/' + name);
  cpSync('/workspace/' + name, cwd + '/' + name, { recursive: true });
}
symlinkSync('/opt/deps/node_modules', cwd + '/node_modules');
const [binary, ...args] = profile.checks[Number(index)];
const result = spawnSync(binary, args, {
  cwd, stdio: 'inherit', shell: false,
  env: { ...process.env, CI: 'true', PATH: cwd + '/node_modules/.bin:' + process.env.PATH },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

export async function prepareProfile(repoPath: string, profilePath: string, outputPath: string, signal: AbortSignal) {
  const repo = await realpath(repoPath);
  const profile = parseProfile(JSON.parse(await readFile(profilePath, 'utf8')));
  const output = resolve(outputPath);
  // Resolve parent symlinks before checking containment. Never overwrite a preparation.
  const parent = await realpath(resolve(output, '..'));
  const actualOutput = join(parent, basename(output));
  if (actualOutput === repo || actualOutput.startsWith(`${repo}/`))
    throw new Error('Preparation output must live outside the target repository');
  const pkg = await manifest(repo, 'package.json');
  const lock = await manifest(repo, 'package-lock.json');
  validateManifests(pkg, lock);
  signal.throwIfAborted();
  await mkdir(actualOutput, { mode: 0o700 });
  const context = join(actualOutput, 'image');
  await mkdir(context);
  const manifests = {
    'package.json': createHash('sha256').update(pkg).digest('hex'),
    'package-lock.json': createHash('sha256').update(lock).digest('hex'),
  };
  await writeFile(join(context, 'package.json'), pkg);
  await writeFile(join(context, 'package-lock.json'), lock);
  await writeFile(join(context, 'check.mjs'), runner);
  await writeFile(
    join(context, 'profile.json'),
    JSON.stringify({ manifests, copyPaths: profile.copyPaths, checks: profile.config.checks }),
  );
  const dockerfile = `FROM ${profile.baseImage}\nENV NODE_OPTIONS=--max-old-space-size=${profile.nodeHeapMb}\nWORKDIR /opt/deps\nCOPY package.json package-lock.json ./\nRUN npm ci --ignore-scripts --no-audit --no-fund && mkdir -p node_modules && chmod -R a+rX /opt/deps\nCOPY check.mjs profile.json /opt/cohorte/\n`;
  await writeFile(join(context, 'Dockerfile'), dockerfile);
  const build = await command(profile.config.docker, ['build', '--iidfile', join(actualOutput, 'image.id'), context], {
    signal,
    timeoutMs: profile.config.timeoutMs,
    limit: 1024 * 1024,
  });
  await writeFile(join(actualOutput, 'build.log'), build.output);
  if (build.exitCode !== 0) throw new Error(`Image preparation failed; inspect ${join(actualOutput, 'build.log')}`);
  const image = (await readFile(join(actualOutput, 'image.id'), 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Invalid prepared image identity');
  const config = parseConfig({
    ...profile.config,
    image,
    checks: profile.config.checks.map((_, index) => ['node', '/opt/cohorte/check.mjs', String(index)]),
  });
  await writeFile(join(actualOutput, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(actualOutput, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
  return { config: join(actualOutput, 'config.json'), image, checks: profile.config.checks };
}
