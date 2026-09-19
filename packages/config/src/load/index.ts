// Configuration loading and trust resolution (PLAN U2.09).

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, type JsonValue, type Sha256, sha256Hex } from '@cohorte/base';
import { Compile } from 'typebox/compile';
import { parse } from 'yaml';
import {
  CohorteConfig,
  type CohorteConfig as CohorteConfigType,
  DEFAULT_CONFIG,
  type FrozenSpec as FrozenSpecType,
  frozenSpecProblems,
  Ownership,
  type Ownership as OwnershipType,
  Spec,
  type Spec as SpecType,
  specContentSha256,
  type TrustStore,
} from '../schema/index.ts';

export interface LoadConfigOptions {
  /** any directory inside the project: the loader walks up to `.cohorte/` */
  cwd: string;
  /** the user's home: `~/.cohorte/config.yaml` is the user layer. Injected, never read from the environment here. */
  home: string;
  /** the CLI-flag layer, already shaped like a partial config document */
  flags?: JsonValue;
}

/** The four layers of DESIGN 2.10, UNMERGED: shipped defaults < user file < project file < CLI flags. */
export interface LoadedConfig {
  projectRoot: string;
  layers: { defaults: CohorteConfig; user?: JsonValue; project?: JsonValue; flags?: JsonValue };
  ownership: Ownership;
}

export interface ResolveConfigOptions {
  trustStore: TrustStore;
  projectKeyId: string;
  /** `--trust-project-config`: consent form `cli-flag` for every loosening key of the project file */
  trustProjectConfig?: boolean;
}

export interface ConfigTrust {
  policySha256: Sha256;
  loosenedKeys: string[];
  grantedBy: 'none-needed' | 'user-config' | 'cli-flag' | 'trust-record';
}

export type ResolvedConfig =
  | { status: 'resolved'; config: CohorteConfig; sha256: Sha256; trust: ConfigTrust; warnings: string[] }
  /** the caller fails closed with `security/project-policy-untrusted` */
  | {
      status: 'untrusted';
      policySha256: Sha256;
      loosenedKeys: string[];
      diff: { pointer: string; trusted?: JsonValue; requested: JsonValue }[];
    };

const readYaml = async (file: string): Promise<JsonValue | undefined> => {
  try {
    const value: unknown = parse(await readFile(file, 'utf8'));
    return value === undefined ? undefined : (value as JsonValue);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `configuration/invalid: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const merge = (left: JsonValue, right: JsonValue): JsonValue => {
  if (
    typeof left !== 'object' ||
    left === null ||
    Array.isArray(left) ||
    typeof right !== 'object' ||
    right === null ||
    Array.isArray(right)
  )
    return structuredClone(right);
  const output: Record<string, JsonValue> = structuredClone(left);
  for (const [key, value] of Object.entries(right as Record<string, JsonValue>)) {
    const existing = output[key];
    output[key] = existing === undefined ? structuredClone(value) : merge(existing, value);
  }
  return output;
};

const findProjectRoot = async (cwd: string): Promise<string> => {
  let current = resolve(cwd);
  while (true) {
    try {
      const value = await readYaml(join(current, '.cohorte', 'config.yaml'));
      if (value !== undefined) return current;
    } catch {
      /* continue to the parent so a malformed nested file is still reported by the selected root */
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
};

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const projectRoot = await findProjectRoot(options.cwd);
  const project = await readYaml(join(projectRoot, '.cohorte', 'config.yaml'));
  const user = await readYaml(join(options.home, '.cohorte', 'config.yaml'));
  const ownershipDocument = (await readYaml(join(projectRoot, '.cohorte', 'ownership.yaml'))) ?? { surfaces: {} };
  const ownershipCheck = Compile(Ownership).Check(ownershipDocument);
  if (!ownershipCheck) throw new Error('configuration/ownership-invalid: ownership.yaml does not match its schema');
  return {
    projectRoot,
    layers: {
      defaults: DEFAULT_CONFIG,
      ...(user === undefined ? {} : { user }),
      ...(project === undefined ? {} : { project }),
      ...(options.flags === undefined ? {} : { flags: options.flags }),
    },
    ownership: ownershipDocument as OwnershipType,
  };
}

export async function resolveConfig(loaded: LoadedConfig, options: ResolveConfigOptions): Promise<ResolvedConfig> {
  const layers: JsonValue[] = [loaded.layers.defaults as unknown as JsonValue];
  if (loaded.layers.user !== undefined) layers.push(loaded.layers.user);
  if (loaded.layers.project !== undefined) layers.push(loaded.layers.project);
  if (loaded.layers.flags !== undefined) layers.push(loaded.layers.flags);
  const [defaults, ...overrides] = layers;
  if (defaults === undefined) throw new Error('configuration/policy-invalid: defaults are missing');
  const merged = overrides.reduce(merge, defaults);
  if (!Compile(CohorteConfig).Check(merged))
    throw new Error('configuration/policy-invalid: merged configuration does not match its schema');
  const config = merged as unknown as CohorteConfigType;
  const project = loaded.layers.project;
  const loosenedKeys: string[] = [];
  if (project && typeof project === 'object' && !Array.isArray(project)) {
    for (const [key, value] of Object.entries(project)) {
      const pointer = `/${key}`;
      if (value !== undefined) loosenedKeys.push(pointer);
    }
  }
  const policySha256 = sha256Hex(
    canonicalJson({ project: project ?? {}, ownership: loaded.ownership as unknown as JsonValue }),
  );
  const trust =
    loosenedKeys.length === 0 ? undefined : await options.trustStore.lookup(options.projectKeyId, policySha256);
  if (loosenedKeys.length > 0 && !options.trustProjectConfig && trust === undefined)
    return {
      status: 'untrusted',
      policySha256,
      loosenedKeys,
      diff: loosenedKeys.map((pointer) => ({
        pointer,
        requested:
          project && typeof project === 'object' && !Array.isArray(project)
            ? (project[pointer.slice(1)] ?? null)
            : null,
      })),
    };
  return {
    status: 'resolved',
    config,
    sha256: sha256Hex(canonicalJson(config as unknown as JsonValue)),
    trust: {
      policySha256,
      loosenedKeys,
      grantedBy: loosenedKeys.length === 0 ? 'none-needed' : options.trustProjectConfig ? 'cli-flag' : 'trust-record',
    },
    warnings: [],
  };
}

export async function loadSpec(file: string): Promise<SpecType> {
  const value = await readYaml(file);
  if (value === undefined || !Compile(Spec).Check(value)) throw new Error(`validation/spec: invalid spec ${file}`);
  const spec = value as unknown as SpecType;
  if (frozenSpecProblems(spec).length > 0) throw new Error(`validation/spec: frozen spec ${spec.id} was edited`);
  return spec;
}

/** Immutable once frozen: freezing an already frozen spec is a no-op, freezing an edited one is an error. */
export async function freezeSpec(file: string): Promise<FrozenSpecType> {
  const spec = await loadSpec(file);
  if (spec.status === 'frozen') return spec;
  return { ...spec, status: 'frozen', sha256: specContentSha256(spec) };
}
