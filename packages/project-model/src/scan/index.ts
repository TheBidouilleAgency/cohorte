// Deterministic repository scan: bounded filesystem observations, never guessed semantics.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Clock } from '@cohorte/base';
import type { ProjectModel } from '../contract.ts';

export interface ScanOptions {
  clock: Clock;
  /** stamped into `provenance.toolVersion` */
  toolVersion: string;
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.cohorte' ||
          entry.name === '.pi' ||
          entry.name === '.build' ||
          entry.name === 'dist' ||
          entry.name === 'coverage'
        )
          continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) found.push(relative(root, path).split('\\').join('/'));
      }
    } catch {
      return;
    }
  };
  await visit(root);
  return found.sort();
}

function field<T>(
  value: T,
  detector: string,
  sources: string[],
  className: ProjectModel['project']['id']['class'] = 'observed',
) {
  return { value, class: className, provenance: { detector, sources } };
}

const WORKSPACE_ROOTS = new Set(['apps', 'packages', 'services', 'modules', 'libs', 'plugins']);

function surfaceId(path: string): string {
  return path
    .replaceAll('/', '-')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 128);
}

const topLevelOf = (file: string): string | undefined => file.split('/')[0];

/**
 * Finds stable, implementation-sized boundaries without making semantic guesses. A package manifest is the
 * strongest local signal; for repositories without manifests we fall back to top-level directories.
 */
function discoverSurfacePaths(files: string[]): Map<string, { glob: string; sources: string[] }> {
  const candidates = new Map<string, { glob: string; sources: string[] }>();
  const packageDirs = files
    .filter((file) => file.endsWith('/package.json'))
    .map((file) => file.slice(0, -'/package.json'.length))
    .filter((dir) => dir.includes('/'));

  for (const dir of packageDirs) {
    const first = topLevelOf(dir);
    if (first === undefined || !WORKSPACE_ROOTS.has(first)) continue;
    const glob = `${dir}/**`;
    candidates.set(surfaceId(dir), {
      glob,
      sources: files.filter((file) => file === dir || file.startsWith(`${dir}/`)),
    });
  }

  const topLevelDirectories = new Set(
    files
      .filter((file) => file.includes('/'))
      .map(topLevelOf)
      .filter((name): name is string => Boolean(name && !name.startsWith('.'))),
  );
  for (const topLevel of [...topLevelDirectories].sort()) {
    if (WORKSPACE_ROOTS.has(topLevel)) continue;
    const glob = `${topLevel}/**`;
    candidates.set(topLevel, { glob, sources: files.filter((file) => file.startsWith(`${topLevel}/`)) });
  }

  if (candidates.size === 0) {
    const topLevelDirectoriesOnly = new Set(
      files
        .filter((file) => file.includes('/'))
        .map(topLevelOf)
        .filter((name): name is string => Boolean(name && !name.startsWith('.'))),
    );
    for (const topLevel of [...topLevelDirectoriesOnly].sort()) {
      const glob = `${topLevel}/**`;
      candidates.set(topLevel, { glob, sources: files.filter((file) => file.startsWith(`${topLevel}/`)) });
    }
  }

  return candidates;
}

export async function scanRepository(root: string, options: ScanOptions): Promise<ProjectModel> {
  const files = await filesUnder(root);
  const packagePath = join(root, 'package.json');
  let pkg: {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(await readFile(packagePath, 'utf8')) as typeof pkg;
  } catch {
    /* absent or invalid package.json is an observation */
  }
  const ext = new Map<string, string>([
    ['.ts', 'typescript'],
    ['.tsx', 'typescript'],
    ['.js', 'javascript'],
    ['.jsx', 'javascript'],
    ['.py', 'python'],
    ['.go', 'go'],
    ['.rs', 'rust'],
    ['.java', 'java'],
  ]);
  const languages = [
    ...new Set(
      files
        .map((file) => ext.get(file.slice(file.lastIndexOf('.'))))
        .filter((value): value is string => value !== undefined),
    ),
  ].sort();
  const supportedLocks = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];
  const locks = files.filter((file) => supportedLocks.includes(file));
  const lock = locks.length === 1 ? locks[0] : undefined;
  const packageManager =
    lock === undefined
      ? (pkg.packageManager?.split('@')[0] ?? null)
      : lock === 'pnpm-lock.yaml'
        ? 'pnpm'
        : lock === 'package-lock.json'
          ? 'npm'
          : lock === 'yarn.lock'
            ? 'yarn'
            : 'bun';
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const frameworks = Object.keys(deps)
    .filter((name) =>
      /^(react|vue|angular|svelte|next|nuxt|express|nestjs|fastify|vite|vitest|jest|playwright)/i.test(name),
    )
    .sort();
  const scripts = pkg.scripts ?? {};
  const commands: Record<string, ReturnType<typeof field<string[]>>> = {};
  for (const name of Object.keys(scripts).sort()) {
    const command = scripts[name];
    if (command !== undefined) commands[name] = field(command.split(/\s+/u), 'package-json', ['package.json']);
  }
  const testLocations = files.filter((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./u.test(file));
  const surfaces: ProjectModel['surfaces'] = {};
  for (const [id, candidate] of discoverSurfacePaths(files))
    surfaces[id] = { paths: field([candidate.glob], 'workspace-layout', candidate.sources) };
  const id =
    pkg.name?.replace(/^@[^/]+\//u, '') ??
    (relative(process.cwd(), root).replace(/[^A-Za-z0-9_.-]/g, '_') || 'project');
  const unknowns =
    locks.length > 1
      ? [
          {
            id: 'package-manager',
            question: 'more than one supported lockfile was detected; which package manager is authoritative?',
            candidates: [...locks].sort(),
            sources: [...locks].sort(),
          },
        ]
      : [];
  return {
    schemaVersion: 1,
    project: { id: field(id, 'package-json', ['package.json'], 'human'), root: field(root, 'filesystem', []) },
    stack: {
      languages: field(languages, 'file-extensions', files),
      packageManager: field(packageManager, 'lockfile', lock ? [lock] : []),
      frameworks: field(frameworks, 'package-json', ['package.json']),
    },
    surfaces,
    commands,
    testStrategy: field(
      { runner: scripts.test ? (scripts.test.split(/\s+/u)[0] ?? null) : null, locations: testLocations },
      'package-json',
      ['package.json'],
    ),
    deploymentHints: field(
      files.filter((file) => /(^|\/)(Dockerfile|Procfile|vercel\.json|fly\.toml)$/u.test(file)),
      'file-presence',
      files,
    ),
    ownership: field(
      { codeowners: files.includes('.github/CODEOWNERS') ? '.github/CODEOWNERS' : null },
      'file-presence',
      ['.github/CODEOWNERS'],
    ),
    risks:
      packageManager === null
        ? [{ id: 'missing-lockfile', severity: 'medium', message: 'no supported lockfile was detected', sources: [] }]
        : [],
    conventions: field(
      files.filter((file) => /(^|\/)(CONTRIBUTING|conventions)\.(md|yaml)$/iu.test(file)),
      'file-presence',
      files,
    ),
    generatedArtifacts: field(['manifest.yaml', 'project.yaml'], 'manifest', ['.cohorte/manifest.yaml']),
    unknowns,
    provenance: { generatedAt: options.clock.now(), toolVersion: options.toolVersion, analysis: 'deterministic' },
  };
}
