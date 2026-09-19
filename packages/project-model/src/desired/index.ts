import { canonicalJson, type JsonValue, sha256Hex } from '@cohorte/base';
import type { CohorteConfig } from '@cohorte/config/schema';
import { stringify } from 'yaml';
import type { DesiredState, ProjectModel } from '../contract.ts';

export interface DesiredStateInput {
  model: ProjectModel;
  config: CohorteConfig;
  cohorteVersion: string;
  /** skill id -> version */
  skills: Readonly<Record<string, string>>;
}

export function deriveDesiredState(input: DesiredStateInput): DesiredState {
  const modelYaml = stringify(input.model);
  const builtin: Record<string, string> = {
    'manifest.yaml': stringify({
      schemaVersion: 1,
      cohorteVersion: input.cohorteVersion,
      createdWith: input.cohorteVersion,
      protocol: { min: '3.0', max: '3.x' },
      stateSchemaVersion: 1,
      generated: [
        {
          path: 'project.yaml',
          templateId: 'project-model/v1',
          templateSha256: sha256Hex(modelYaml),
          renderedSha256: sha256Hex(modelYaml),
        },
        {
          path: '.gitignore',
          templateId: 'cohorte/gitignore/v1',
          templateSha256: sha256Hex('state/\nruns/\n'),
          renderedSha256: sha256Hex('state/\nruns/\n'),
        },
        {
          path: 'generated/.gitkeep',
          templateId: 'cohorte/generated-dir/v1',
          templateSha256: sha256Hex(''),
          renderedSha256: sha256Hex(''),
        },
      ],
    }),
    'project.yaml': modelYaml,
    'config.yaml': 'schemaVersion: 1\n',
    'ownership.yaml': 'surfaces: {}\n',
    '.gitignore': 'state/\nruns/\n',
    'generated/.gitkeep': '',
  };
  const files = new Set(Object.keys(builtin));
  for (const path of input.model.generatedArtifacts.value) files.add(path.replace(/^\.cohorte\//u, ''));
  const stateFiles = [...files].sort().map((path) => ({
    path,
    class: path === 'config.yaml' || path === 'ownership.yaml' ? ('human' as const) : ('generated' as const),
    sha256: sha256Hex(
      builtin[path] ??
        canonicalJson({ path, model: input.model, config: input.config, skills: input.skills } as unknown as JsonValue),
    ),
    ...(input.skills[path] === undefined ? {} : { templateId: path }),
  }));
  return { cohorteVersion: input.cohorteVersion, files: stateFiles };
}
