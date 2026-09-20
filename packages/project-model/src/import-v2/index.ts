import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256Hex } from '@cohorte/base';
import { parse, stringify } from 'yaml';
import type { ProjectModel } from '../contract.ts';

const FORMAT = 'cohorte-v2-export';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.build', 'dist', 'coverage', '.cohorte']);
const SECRET =
  /(^|[/\\])(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*token.*|.*password.*|.*api[-_]?key.*)$/iu;

export interface V2ExportFile {
  path: string;
  sha256: string;
  bytes: number;
  kind: 'config' | 'spec' | 'history' | 'marker';
}

export interface V2ExportManifest {
  format: typeof FORMAT;
  version: 1;
  sourceVersion: string | null;
  createdAt: string;
  projectRootDigest: string;
  files: V2ExportFile[];
  excluded: Array<{ path: string; reason: string }>;
  warnings: V2ImportWarning[];
}

export interface V2ImportWarning {
  code: string;
  path?: string;
  message: string;
  blocking: boolean;
}

export interface V2ExportOptions {
  root: string;
  destination: string;
  now?: string;
}

export interface V2ExportResult {
  bundleRoot: string;
  manifest: V2ExportManifest;
  checksumsPath: string;
}

export interface V2ImportFile {
  path: string;
  content: string;
  action: 'create' | 'replace' | 'keep' | 'conflict';
  reason: string;
}

export interface V2ImportPlan {
  bundleRoot: string;
  projectRoot: string;
  sourceVersion: string | null;
  files: V2ImportFile[];
  warnings: V2ImportWarning[];
  conflicts: string[];
  sourceDigest: string;
  targetDigest: string;
}

export interface V2ImportOptions {
  model?: ProjectModel;
}

export interface V2ImportReport {
  reportId: string;
  status: 'applied' | 'rolled-back';
  bundleRoot: string;
  projectRoot: string;
  backupRoot: string;
  sourceDigest: string;
  targetDigest: string;
  files: string[];
  warnings: V2ImportWarning[];
  createdAt: string;
}

interface BundleInput {
  manifest: V2ExportManifest;
  files: Map<string, string>;
  sourceDigest: string;
}

function normalisePath(value: string): string {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === ''))
    throw new Error(`configuration/import-invalid: unsafe relative path ${JSON.stringify(value)}`);
  return path;
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    const rel = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) throw new Error(`configuration/import-symlink: refusing symbolic link ${rel}`);
    if (entry.isDirectory()) result.push(...(await walk(root, absolute)));
    else if (entry.isFile()) result.push(rel);
  }
  return result.sort();
}

function fileKind(path: string): V2ExportFile['kind'] {
  if (path === 'PIPELINE.md' || path === 'cohorte.config.yaml' || path.startsWith('profile/')) return 'config';
  if (path.startsWith('specs/')) return path.startsWith('specs/reports/') ? 'history' : 'spec';
  return 'marker';
}

function warning(code: string, message: string, path?: string, blocking = false): V2ImportWarning {
  return { code, message, ...(path === undefined ? {} : { path }), blocking };
}

async function digestFiles(root: string, files: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  return hash.digest('hex');
}

function sourceVersion(pipeline: string | undefined): string | null {
  const match = pipeline?.match(/(?:version|core_version)\s*[:=]\s*["']?([0-9]+\.[0-9]+\.[0-9]+)/iu);
  return match?.[1] ?? null;
}

export async function exportV2(options: V2ExportOptions): Promise<V2ExportResult> {
  const root = resolve(options.root);
  const destination = resolve(options.destination);
  const all = await walk(root);
  const files: V2ExportFile[] = [];
  const excluded: V2ExportManifest['excluded'] = [];
  const warnings: V2ImportWarning[] = [];
  for (const path of all) {
    if (SECRET.test(path)) {
      excluded.push({ path, reason: 'sensitive-path' });
      warnings.push(warning('sensitive-excluded', 'sensitive file excluded from export', path));
      continue;
    }
    const info = await stat(join(root, path));
    if (info.size > MAX_FILE_BYTES) {
      excluded.push({ path, reason: 'file-too-large' });
      warnings.push(warning('file-too-large', `file exceeds ${MAX_FILE_BYTES} bytes`, path, true));
      continue;
    }
    const content = await readFile(join(root, path));
    files.push({ path, sha256: sha256Hex(content), bytes: content.byteLength, kind: fileKind(path) });
  }
  const selected = files.map((file) => file.path);
  const pipeline = all.includes('PIPELINE.md') ? await readFile(join(root, 'PIPELINE.md'), 'utf8') : undefined;
  const manifest: V2ExportManifest = {
    format: FORMAT,
    version: 1,
    sourceVersion: sourceVersion(pipeline),
    createdAt: options.now ?? new Date().toISOString(),
    projectRootDigest: await digestFiles(root, selected),
    files,
    excluded,
    warnings,
  };
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, 'files'), { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = join(destination, 'files', file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, await readFile(join(root, file.path)), { mode: 0o600 });
  }
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const checksums = files
    .map((file) => `${file.sha256}  files/${file.path}`)
    .concat(`${sha256Hex(canonicalJson(manifest as never))}  manifest.json`)
    .join('\n');
  const checksumsPath = join(destination, 'checksums.sha256');
  await writeFile(checksumsPath, `${checksums}\n`, { mode: 0o600 });
  return { bundleRoot: destination, manifest, checksumsPath };
}

async function readBundle(bundleRoot: string): Promise<BundleInput> {
  const root = resolve(bundleRoot);
  const manifestPath = join(root, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error('security/import-invalid: manifest must be a regular file');
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText) as V2ExportManifest;
  if (manifest.format !== FORMAT || manifest.version !== 1)
    throw new Error('configuration/import-invalid: unsupported V2 export format');
  const files = new Map<string, string>();
  const expectedChecksums = new Map<string, string>();
  const checksums = await readFile(join(root, 'checksums.sha256'), 'utf8');
  for (const line of checksums
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/u);
    if (!match?.[1] || !match[2]) throw new Error('security/import-invalid: malformed checksums file');
    expectedChecksums.set(match[2], match[1]);
  }
  if (expectedChecksums.get('manifest.json') !== sha256Hex(canonicalJson(manifest as never)))
    throw new Error('security/import-checksum-mismatch: manifest.json');
  for (const entry of manifest.files) {
    const path = normalisePath(entry.path);
    if (files.has(path)) throw new Error(`configuration/import-invalid: duplicate path ${path}`);
    const filePath = join(root, 'files', path);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`security/import-invalid: symlink or non-file ${path}`);
    const content = await readFile(filePath, 'utf8');
    if (sha256Hex(content) !== entry.sha256) throw new Error(`security/import-checksum-mismatch: ${path}`);
    if (expectedChecksums.get(`files/${path}`) !== entry.sha256)
      throw new Error(`security/import-checksum-mismatch: files/${path}`);
    files.set(path, content);
  }
  const sourceDigest = await digestFiles(join(root, 'files'), [...files.keys()]);
  if (sourceDigest !== manifest.projectRootDigest)
    throw new Error('security/import-checksum-mismatch: project root digest does not match manifest');
  return { manifest, files, sourceDigest };
}

function mapConfig(input: string | undefined): { config: string; ownership: string; warnings: V2ImportWarning[] } {
  const warnings: V2ImportWarning[] = [];
  if (input === undefined) return { config: 'schemaVersion: 1\n', ownership: 'surfaces: {}\n', warnings };
  let document: Record<string, unknown> = {};
  try {
    const parsed = parse(input) as unknown;
    if (parsed && typeof parsed === 'object') document = parsed as Record<string, unknown>;
  } catch {
    warnings.push(warning('config-invalid-yaml', 'V2 configuration is not valid YAML', 'cohorte.config.yaml', true));
  }
  const profile = (document.pipeline ?? document['pipeline-profile']) as Record<string, unknown> | undefined;
  if (profile?.name === undefined)
    warnings.push(warning('config-project-id-missing', 'project id needs human confirmation'));
  if (document.kanban !== undefined)
    warnings.push(warning('kanban-not-imported', 'Kanban links remain external and are not synchronized'));
  const id = typeof profile?.name === 'string' ? profile.name : 'imported-project';
  return {
    config: stringify({ schemaVersion: 1, project: { id, defaultBranch: 'main', protectedBranches: ['main'] } }),
    ownership: 'surfaces: {}\n',
    warnings,
  };
}

export async function planV2Import(
  bundleRoot: string,
  projectRoot: string,
  options: V2ImportOptions = {},
): Promise<V2ImportPlan> {
  const bundle = await readBundle(bundleRoot);
  const modelSource = bundle.files.get('PIPELINE.md');
  const mapped = mapConfig(bundle.files.get('cohorte.config.yaml'));
  const files: V2ImportFile[] = [
    { path: '.cohorte/config.yaml', content: mapped.config, action: 'create', reason: 'mapped V2 configuration' },
    {
      path: '.cohorte/ownership.yaml',
      content: mapped.ownership,
      action: 'create',
      reason: 'new V3 ownership document',
    },
    ...(options.model === undefined
      ? []
      : [
          {
            path: '.cohorte/project.yaml',
            content: stringify(options.model),
            action: 'create' as const,
            reason: 'deterministic V3 project model generated during import',
          },
        ]),
    ...(modelSource === undefined
      ? []
      : [
          {
            path: '.cohorte/import-source/PIPELINE.md',
            content: modelSource,
            action: 'create' as const,
            reason: 'preserve V2 source',
          },
        ]),
    ...bundle.manifest.files
      .filter((entry) => entry.kind === 'spec' || entry.kind === 'history')
      .map((entry) => ({
        path: `.cohorte/import-source/${normalisePath(entry.path)}`,
        content: bundle.files.get(entry.path) ?? '',
        action: 'create' as const,
        reason: entry.kind === 'spec' ? 'preserve V2 specification' : 'preserve V2 historical artifact',
      })),
  ];
  const currentDigest = await digestProject(projectRoot);
  const conflicts: string[] = [];
  for (const file of files) {
    try {
      const currentPath = join(projectRoot, file.path);
      const info = await lstat(currentPath);
      if (info.isSymbolicLink()) {
        file.action = 'conflict';
        file.reason = 'target is a symbolic link';
        conflicts.push(file.path);
        continue;
      }
      const current = await readFile(currentPath, 'utf8');
      if (current !== file.content) {
        file.action = 'conflict';
        file.reason = 'target exists with different content';
        conflicts.push(file.path);
      } else file.action = 'keep';
    } catch {
      /* create */
    }
  }
  return {
    bundleRoot: resolve(bundleRoot),
    projectRoot: resolve(projectRoot),
    sourceVersion: bundle.manifest.sourceVersion,
    files,
    warnings: [...bundle.manifest.warnings, ...mapped.warnings],
    conflicts,
    sourceDigest: bundle.sourceDigest,
    targetDigest: currentDigest,
  };
}

async function digestProject(root: string): Promise<string> {
  const paths = (await walk(root)).filter((path) => !path.startsWith('.cohorte/import-preview/'));
  return digestFiles(root, paths);
}

export async function applyV2Import(
  plan: V2ImportPlan,
  options: { confirm: boolean; backupRoot: string; now?: string },
): Promise<V2ImportReport> {
  if (plan.conflicts.length) throw new Error(`configuration/import-conflict: ${plan.conflicts.join(', ')}`);
  if (plan.warnings.some((item) => item.blocking))
    throw new Error('configuration/import-blocked: resolve blocking warnings first');
  if (!options.confirm) throw new Error('configuration/import-confirmation-required: rerun with explicit confirmation');
  if ((await digestProject(plan.projectRoot)) !== plan.targetDigest)
    throw new Error('configuration/import-project-changed: project changed since preview');
  const id = sha256Hex(`${plan.sourceDigest}:${plan.targetDigest}:${options.now ?? new Date().toISOString()}`).slice(
    0,
    16,
  );
  const backupRoot = resolve(options.backupRoot, `cohorte-v2-${id}`);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const existing: string[] = [];
  for (const file of plan.files) {
    try {
      await lstat(join(plan.projectRoot, file.path));
      existing.push(file.path);
      await mkdir(dirname(join(backupRoot, file.path)), { recursive: true, mode: 0o700 });
      await cp(join(plan.projectRoot, file.path), join(backupRoot, file.path), {
        recursive: true,
        verbatimSymlinks: true,
      });
    } catch {
      /* new file */
    }
  }
  const stage = join(backupRoot, '.stage');
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    for (const file of plan.files) {
      if (file.action === 'keep') continue;
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o600 });
    }
    for (const file of plan.files) {
      if (file.action === 'keep') continue;
      const target = join(plan.projectRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(join(stage, file.path), target);
    }
    await rm(stage, { recursive: true, force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    for (const file of plan.files) {
      if (file.action === 'keep') continue;
      const target = join(plan.projectRoot, file.path);
      const backup = join(backupRoot, file.path);
      try {
        await stat(backup);
        await cp(backup, target, { recursive: true, verbatimSymlinks: true });
      } catch {
        await rm(target, { recursive: true, force: true });
      }
    }
    throw error;
  }
  const report: V2ImportReport = {
    reportId: id,
    status: 'applied',
    bundleRoot: plan.bundleRoot,
    projectRoot: plan.projectRoot,
    backupRoot,
    sourceDigest: plan.sourceDigest,
    targetDigest: plan.targetDigest,
    files: plan.files.filter((file) => file.action !== 'keep').map((file) => file.path),
    warnings: plan.warnings,
    createdAt: options.now ?? new Date().toISOString(),
  };
  const reportPath = join(plan.projectRoot, '.cohorte', 'import-reports', `${id}.json`);
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify({ ...report, existing }, null, 2)}\n`, { mode: 0o600 });
  return report;
}

export async function rollbackV2Import(report: V2ImportReport): Promise<V2ImportReport> {
  for (const path of report.files) {
    const backup = join(report.backupRoot, path);
    try {
      await stat(backup);
      await mkdir(dirname(join(report.projectRoot, path)), { recursive: true, mode: 0o700 });
      await cp(backup, join(report.projectRoot, path), { recursive: true, verbatimSymlinks: true });
    } catch {
      await rm(join(report.projectRoot, path), { recursive: true, force: true });
    }
  }
  return { ...report, status: 'rolled-back' };
}

export function projectModelFromV2(bundle: V2ExportResult, model: ProjectModel): string {
  return stringify({
    ...model,
    provenance: { ...model.provenance, toolVersion: `v2-import:${bundle.manifest.sourceVersion ?? 'unknown'}` },
  });
}
