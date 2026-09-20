import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256Hex } from '@cohorte/base';
import { DEFAULT_CONFIG, type Spec, specContentSha256 } from '@cohorte/config/schema';
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

function pipelineBlock(input: string | undefined): Record<string, unknown> {
  const match = input?.match(/```ya?ml\s+pipeline-profile\s*\n([\s\S]*?)\n```/iu);
  if (!match?.[1]) return {};
  try {
    const parsed = parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rule(id: string, program: string, decision: 'allow' | 'ask' | 'deny') {
  return { id, program, decision, replay: 'idempotent' as const, network: false, origin: 'project-config' as const };
}

function mapConfig(
  input: string | undefined,
  pipeline: string | undefined,
  model: ProjectModel | undefined,
): { config: string; ownership: string; warnings: V2ImportWarning[] } {
  const warnings: V2ImportWarning[] = [];
  let document: Record<string, unknown> = {};
  if (input !== undefined) {
    try {
      const parsed = parse(input) as unknown;
      if (parsed && typeof parsed === 'object') document = parsed as Record<string, unknown>;
    } catch {
      warnings.push(warning('config-invalid-yaml', 'V2 configuration is not valid YAML', 'cohorte.config.yaml', true));
    }
  }
  const profile = pipelineBlock(pipeline);
  if (profile.name === undefined)
    warnings.push(warning('config-project-id-missing', 'project id needs human confirmation'));
  if (document.kanban !== undefined)
    warnings.push(warning('kanban-not-imported', 'Kanban links remain external and are not synchronized'));
  const id = typeof profile.name === 'string' ? profile.name : 'imported-project';
  const vcs = (profile.vcs ?? {}) as Record<string, unknown>;
  const commands = (profile.commands ?? {}) as Record<string, unknown>;
  const gate = (profile.gate ?? {}) as Record<string, unknown>;
  const defaultBranch =
    typeof vcs.default_branch === 'string' ? vcs.default_branch : DEFAULT_CONFIG.project.defaultBranch;
  const branchPrefix =
    typeof vcs.feature_branch_prefix === 'string' ? vcs.feature_branch_prefix : DEFAULT_CONFIG.git.branchPrefix;
  const migrated = structuredClone(DEFAULT_CONFIG);
  migrated.project = { ...migrated.project, id, defaultBranch, protectedBranches: [defaultBranch] };
  migrated.git = { ...migrated.git, branchPrefix };
  migrated.checks = {
    ...migrated.checks,
    ...(typeof commands.test === 'string' ? { test: commands.test.split(/\s+/u) } : {}),
    ...(typeof commands.lint === 'string' ? { lint: commands.lint.split(/\s+/u) } : {}),
    ...(typeof commands.typecheck === 'string' ? { typecheck: commands.typecheck.split(/\s+/u) } : {}),
  };
  const deny = Array.isArray(gate.deny) ? gate.deny.filter((v): v is string => typeof v === 'string') : [];
  const ask = Array.isArray(gate.ask) ? gate.ask.filter((v): v is string => typeof v === 'string') : [];
  migrated.policy.commands = {
    allow: [],
    ask: ask.map((value, index) => rule(`v2-ask-${index}`, value.split(/\s+/u)[0] ?? value, 'ask')),
    deny: deny.map((value, index) => rule(`v2-deny-${index}`, value.split(/\s+/u)[0] ?? value, 'deny')),
  };
  warnings.push(
    warning('runtime-review-required', 'V2 runtime adapters are not migrated; review the current runtime selection'),
  );
  const surfaces = Object.fromEntries(
    Object.entries(model?.surfaces ?? {}).map(([key, value]) => [
      key,
      { paths: value.paths.value, owners: ['implementer'], reviewers: ['reviewer'] },
    ]),
  );
  return {
    config: stringify(migrated),
    ownership: stringify({ surfaces }),
    warnings,
  };
}

function section(markdown: string, number: string, fallback: string): string {
  const match = markdown.match(new RegExp(`^##\\s+${number}\\.?.*?\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'imu'));
  return match?.[1]?.trim() ?? fallback;
}

function bullets(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/u)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function importedSpec(path: string, markdown: string): { id: string; content: string; warning?: V2ImportWarning } {
  const front = markdown.match(/^---\s*\n([\s\S]*?)\n---/u);
  const metadata = front?.[1] ? (parse(front[1]) as Record<string, unknown>) : {};
  const filename = path.split('/').pop()?.replace(/\.md$/iu, '') ?? 'imported-spec';
  const id =
    String(metadata.feature_id ?? filename)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 48) || 'imported-spec';
  const heading = markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const title = String(metadata.title ?? heading ?? id);
  const rawStatus = String(metadata.status ?? 'draft');
  const status = rawStatus === 'draft' ? 'draft' : 'frozen';
  const acceptance = bullets(section(markdown, '9', ''));
  const openQuestions = bullets(section(markdown, '10', ''));
  const surfaces: Record<string, { tasks: string[] }> = {};
  const surfaceSection = section(markdown, '6', '');
  for (const match of surfaceSection.matchAll(/^###\s+([^\n]+)\n([\s\S]*?)(?=^###\s+|$)/gmu)) {
    const key =
      match[1]
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '') || 'shared';
    surfaces[key] = { tasks: bullets(match[2] ?? '') };
  }
  if (Object.keys(surfaces).length === 0)
    surfaces.shared = { tasks: ['Review imported V2 specification and assign implementation tasks.'] };
  const body = {
    id,
    kind: 'feature' as const,
    status,
    title,
    acceptance: acceptance.length ? acceptance : [`Review imported V2 specification: ${title}`],
    surfaces,
    openQuestions: [...openQuestions, ...(rawStatus === 'draft' ? [] : [`Original V2 status: ${rawStatus}`])],
  } as Spec;
  if (status === 'frozen') return { id, content: stringify({ ...body, sha256: specContentSha256(body) }) };
  return {
    id,
    content: stringify(body),
    ...(rawStatus === 'draft'
      ? {}
      : { warning: warning('spec-status-normalized', `V2 status ${rawStatus} was normalized to frozen`, path) }),
  };
}

export async function planV2Import(
  bundleRoot: string,
  projectRoot: string,
  options: V2ImportOptions = {},
): Promise<V2ImportPlan> {
  const bundle = await readBundle(bundleRoot);
  const modelSource = bundle.files.get('PIPELINE.md');
  const mapped = mapConfig(bundle.files.get('cohorte.config.yaml'), modelSource, options.model);
  const projectContent = options.model === undefined ? undefined : stringify(options.model);
  const generated =
    projectContent === undefined
      ? []
      : [
          {
            path: 'project.yaml',
            templateId: 'project-model/v1',
            templateSha256: sha256Hex(projectContent),
            renderedSha256: sha256Hex(projectContent),
          },
        ];
  const manifestContent = stringify({
    schemaVersion: 1,
    cohorteVersion: '3.0.0',
    createdWith: 'v2-import',
    protocol: { min: '3.0', max: '3.x' },
    stateSchemaVersion: 1,
    generated,
  });
  const convertedSpecs = bundle.manifest.files
    .filter((entry) => entry.kind === 'spec')
    .map((entry) => ({ entry, converted: importedSpec(entry.path, bundle.files.get(entry.path) ?? '') }));
  const specWarnings = convertedSpecs.flatMap(({ converted }) => (converted.warning ? [converted.warning] : []));
  const files: V2ImportFile[] = [
    { path: '.cohorte/manifest.yaml', content: manifestContent, action: 'create', reason: 'V3 migration marker' },
    { path: '.cohorte/.gitignore', content: 'state/\nruns/\n', action: 'create', reason: 'protect V3 local state' },
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
            content: projectContent ?? '',
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
    ...convertedSpecs.map(({ entry, converted }) => ({
      path: `.cohorte/specs/${converted.id}.yaml`,
      content: converted.content,
      action: 'create' as const,
      reason: `convert V2 Markdown specification ${entry.path} to native schema`,
    })),
    ...bundle.manifest.files
      .filter((entry) => entry.kind === 'history')
      .map((entry) => ({
        path: `.cohorte/artifacts/v2-history/${normalisePath(entry.path).replace(/^specs\/reports\//u, '')}`,
        content: bundle.files.get(entry.path) ?? '',
        action: 'create' as const,
        reason: 'import V2 historical artifact',
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
    warnings: [...bundle.manifest.warnings, ...mapped.warnings, ...specWarnings],
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
