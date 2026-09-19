import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '@cohorte/base';
import { stringify } from 'yaml';
import type { InitPlan, ProjectModel } from '../contract.ts';

export interface PlanInitOptions {
  root: string;
  model: ProjectModel;
  cohorteVersion: string;
  /** refused in V3.0: `configuration/phase-not-available` */
  semantic?: boolean;
}

export async function planInit(options: PlanInitOptions): Promise<InitPlan> {
  if (options.semantic) throw new Error('configuration/phase-not-available: semantic init is not available in V3.0');
  const root = options.root;
  const modelYaml = stringify(options.model);
  const files = [
    { path: 'project.yaml', class: 'generated' as const, content: modelYaml, templateId: 'project-model/v1' },
    { path: 'config.yaml', class: 'human' as const, content: 'schemaVersion: 1\n' },
    { path: 'ownership.yaml', class: 'human' as const, content: 'surfaces: {}\n' },
    {
      path: '.gitignore',
      class: 'generated' as const,
      content: 'state/\nruns/\n',
      templateId: 'cohorte/gitignore/v1',
    },
    {
      path: 'generated/.gitkeep',
      class: 'generated' as const,
      content: '',
      templateId: 'cohorte/generated-dir/v1',
    },
  ];
  const initFiles: InitPlan['files'] = [];
  for (const file of files) {
    let exists = false;
    try {
      await readFile(join(root, '.cohorte', file.path));
      exists = true;
    } catch {
      /* create */
    }
    const renderedSha256 = sha256Hex(file.content);
    initFiles.push({
      path: file.path,
      action: exists ? 'keep-existing' : 'create',
      class: file.class,
      content: file.content,
      ...(file.templateId === undefined ? {} : { templateId: file.templateId }),
      ...(file.class === 'generated' ? { templateSha256: renderedSha256, renderedSha256 } : {}),
    });
  }
  const generated = initFiles
    .filter((file) => file.class === 'generated')
    .map((file) => ({
      path: file.path,
      templateId: file.templateId ?? 'builtin',
      templateSha256: file.templateSha256 ?? sha256Hex(file.content),
      renderedSha256: file.renderedSha256 ?? sha256Hex(file.content),
    }));
  return {
    projectRoot: root,
    model: options.model,
    files: initFiles,
    manifest: {
      schemaVersion: 1,
      cohorteVersion: options.cohorteVersion,
      createdWith: options.cohorteVersion,
      protocol: { min: '3.0', max: '3.x' },
      stateSchemaVersion: 1,
      generated,
    },
    warnings: [],
  };
}

export async function applyInit(plan: InitPlan): Promise<{ written: string[]; kept: string[] }> {
  await mkdir(join(plan.projectRoot, '.cohorte'), { recursive: true, mode: 0o700 });
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of plan.files) {
    const target = join(plan.projectRoot, '.cohorte', file.path);
    if (file.action === 'keep-existing') {
      kept.push(file.path);
      continue;
    }
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { mode: 0o600 });
    written.push(file.path);
  }
  const manifestPath = join(plan.projectRoot, '.cohorte', 'manifest.yaml');
  try {
    await readFile(manifestPath);
    kept.push('manifest.yaml');
  } catch {
    await writeFile(manifestPath, stringify(plan.manifest), { mode: 0o600 });
    written.push('manifest.yaml');
  }
  return { written, kept };
}
