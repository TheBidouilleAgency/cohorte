// DESIGN 3.9 — runtime pinning (spec 16). Engine-free: the engine's packages are FILES to hash here, never modules
// to load. `pin()` runs once at run start; every spawn re-verifies through a stat cache.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { CohorteError, canonicalJson, errorOf, type Sha256, sha256Hex } from '@cohorte/base';
import type { RuntimePin } from '@cohorte/runtime-contract';

export const RUNTIME_ID = 'pi';
export const ADAPTER_VERSION = '3.0.0';
export const ENGINE_NAME = 'pi';
/** The three packages the brain loads. Their versions MUST be equal (ADR-0001). */
export const ENGINE_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
] as const;

export interface PinOptions {
  /** the install whose `dist/` holds both bundles */
  installDir: string;
  loadFrom: 'package' | 'bundle';
  /** TESTS ONLY: the child entry that replaces the pinned one (the fake brain). That one file is pinned, and no engine. */
  entryOverride?: string;
}

export type PinDiagnostics = Record<string, string>;
type Artifact = RuntimePin['artifacts'][number];

interface HashCache {
  entries: Map<string, { key: string; sha256: Sha256 }>;
  hashed: number;
}
const newCache = (): HashCache => ({ entries: new Map(), hashed: 0 });

const engineInit = (message: string): CohorteError => new CohorteError(errorOf('configuration/engine-init', message));

/** The content hash of one file, re-read only when `(dev, ino, size, mtimeNs)` moved. */
async function hashFile(path: string, cache: HashCache): Promise<{ sha256: Sha256; size: number }> {
  const info = await stat(path, { bigint: true });
  const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
  const known = cache.entries.get(path);
  if (known?.key === key) return { sha256: known.sha256, size: Number(info.size) };
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex') as Sha256;
  cache.hashed += 1;
  cache.entries.set(path, { key, sha256 });
  return { sha256, size: Number(info.size) };
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
      else if (entry.isSymbolicLink() && (await stat(path)).isFile()) found.push(path);
    }
  };
  await walk(root);
  return found;
}

/** One sorted `{path,size,sha256}` tree digest: an added, removed, renamed or edited file all move it. */
async function treeArtifact(
  role: Artifact['role'],
  root: string,
  files: readonly string[],
  cache: HashCache,
): Promise<Artifact> {
  const rows: { path: string; size: number; sha256: Sha256 }[] = [];
  for (const file of files) {
    const { sha256, size } = await hashFile(file, cache);
    rows.push({ path: relative(root, file).split(sep).join('/'), size, sha256 });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    role,
    path: root,
    sha256: sha256Hex(canonicalJson(rows)),
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.size, 0),
  };
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Node's own walk for a bare specifier, done by hand: `createRequire` is refused in shipped code (check-layers rule g). */
async function findPackage(from: string, name: string): Promise<{ dir: string; nodeModules: string } | undefined> {
  for (let dir = from; ; dir = dirname(dir)) {
    const nodeModules = join(dir, 'node_modules');
    if (await exists(join(nodeModules, name, 'package.json'))) return { dir: join(nodeModules, name), nodeModules };
    if (dirname(dir) === dir) return undefined;
  }
}

async function engineArtifacts(
  options: PinOptions,
  cache: HashCache,
): Promise<{ artifacts: Artifact[]; version: string; nodeModules: string }> {
  const packages = options.loadFrom === 'bundle' ? ENGINE_PACKAGES.slice(0, 1) : ENGINE_PACKAGES;
  const artifacts: Artifact[] = [];
  const versions = new Map<string, string>();
  let nodeModules = '';
  for (const name of packages) {
    const found = await findPackage(options.installDir, name);
    if (!found) throw engineInit(`the engine package ${name} is not installed next to ${options.installDir}`);
    nodeModules ||= found.nodeModules;
    const dir = await realpath(found.dir);
    const manifest = join(dir, 'package.json');
    const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'));
    const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed ? String(parsed.version) : '';
    versions.set(name, version);
    const code = join(dir, 'dist', ...(options.loadFrom === 'bundle' ? ['bundle'] : []));
    if (!(await exists(code))) throw engineInit(`the engine package ${name} has no ${relative(dir, code)} directory`);
    artifacts.push(await treeArtifact('engine-package-tree', dir, [manifest, ...(await filesUnder(code))], cache));
  }
  const distinct = [...new Set(versions.values())];
  const [version] = distinct;
  if (distinct.length !== 1 || !version)
    throw engineInit(
      `the engine packages must all be at the same version: ${[...versions].map(([name, v]) => `${name}@${v}`).join(', ')}`,
    );
  return { artifacts, version, nodeModules };
}

async function lockArtifact(
  options: PinOptions,
  nodeModules: string,
  cache: HashCache,
  diagnostics: PinDiagnostics,
): Promise<Artifact[]> {
  // A gate or unit build links `<dir>/node_modules` into the workspace (PLAN F-7): it has no lock evidence of its own.
  const own = await lstat(join(options.installDir, 'node_modules')).catch(() => undefined);
  if (own?.isSymbolicLink()) {
    diagnostics.installLock = 'absent (linked development build)';
    return [];
  }
  for (const name of ['.package-lock.json', '.modules.yaml']) {
    const path = join(nodeModules, name);
    if (!(await exists(path))) continue;
    const { sha256, size } = await hashFile(path, cache);
    diagnostics.installLock = name;
    return [{ role: 'install-lock', path, sha256, files: 1, bytes: size }];
  }
  diagnostics.installLock = 'absent';
  return [];
}

async function compute(
  options: PinOptions,
  cache: HashCache,
): Promise<{ pin: RuntimePin; diagnostics: PinDiagnostics }> {
  const diagnostics: PinDiagnostics = { loadFrom: options.loadFrom };
  const artifacts: Artifact[] = [];
  let engine: RuntimePin['engine'] = null;
  if (options.entryOverride !== undefined) {
    const { sha256, size } = await hashFile(options.entryOverride, cache);
    artifacts.push({ role: 'agent-host-bundle', path: options.entryOverride, sha256, files: 1, bytes: size });
    diagnostics.entry = 'override (tests only): no engine is pinned';
  } else {
    const dist = join(options.installDir, 'dist');
    if (!(await exists(dist))) throw engineInit(`${options.installDir} has no dist/ directory: nothing to pin`);
    artifacts.push(await treeArtifact('agent-host-bundle', dist, await filesUnder(dist), cache));
    const found = await engineArtifacts(options, cache);
    artifacts.push(...found.artifacts, ...(await lockArtifact(options, found.nodeModules, cache, diagnostics)));
    engine = { name: ENGINE_NAME, version: found.version };
    // Transitive dependencies are covered by the lock evidence only: `runtimePinning` is reported `partial`.
    diagnostics.transitive = 'lock evidence only';
  }
  const body = {
    runtimeId: RUNTIME_ID,
    adapterVersion: ADAPTER_VERSION,
    engine,
    node: { version: process.version, execPath: process.execPath },
    artifacts,
  };
  return { pin: { ...body, digest: sha256Hex(canonicalJson(body)) }, diagnostics };
}

export function pinWithDiagnostics(options: PinOptions): Promise<{ pin: RuntimePin; diagnostics: PinDiagnostics }> {
  return compute(options, newCache());
}

export interface PinVerifier {
  /** Rejects with `security/runtime-pin-mismatch` when the installed code is not what `pinned` names. */
  verify(pinned: RuntimePin): Promise<void>;
  stats(): { hashed: number; cached: number };
}

/** One per runtime: its stat cache makes the per-spawn verification a walk of `stat` calls. */
export function createPinVerifier(options: PinOptions): PinVerifier {
  const cache = newCache();
  return {
    stats: () => ({ hashed: cache.hashed, cached: cache.entries.size }),
    async verify(pinned) {
      const { pin: now } = await compute(options, cache);
      // The whole value, not the digest alone: a pin whose body was edited under an intact digest is a mismatch too.
      if (canonicalJson(now) === canonicalJson(pinned)) return;
      const differing = [
        ...(canonicalJson(now.node) === canonicalJson(pinned.node) ? [] : ['node']),
        ...(canonicalJson(now.engine) === canonicalJson(pinned.engine) ? [] : ['engine']),
        ...now.artifacts
          .filter((a, i) => canonicalJson(a) !== canonicalJson(pinned.artifacts[i] ?? null))
          .map((a) => a.path),
        ...(now.artifacts.length === pinned.artifacts.length ? [] : ['artifact count']),
      ];
      throw new CohorteError(
        errorOf(
          'security/runtime-pin-mismatch',
          `the installed runtime is not the one pinned at run start: ${differing.join(', ')}`,
          {
            details: { pinned: pinned.digest, found: now.digest, differing },
          },
        ),
      );
    },
  };
}
