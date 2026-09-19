// DESIGN 6.1 — what is snapshotted at run start (spec 16, all eight items). Lives here, not in `@cohorte/config`:
// it embeds `SandboxCapabilities` (security) and `RuntimeCapabilities` / `RuntimePin` (runtime-contract); `config`
// may import neither `security` nor `runtime-contract` (DESIGN 1.1), and `core` is the lowest package allowed to
// import all three (PLAN PC-8). `gen-schemas` (U0.G) reads it from `@cohorte/core/contract`.
import type { IsoInstant, Sha256, SpecId } from '@cohorte/base';
import { IsoInstant as IsoInstantSchema, Sha256 as Sha256Schema, SpecId as SpecIdSchema } from '@cohorte/base';
import type { PipelineProfile, RunPlan } from '@cohorte/protocol';
import { PipelineProfile as PipelineProfileSchema } from '@cohorte/protocol';
import type {
  RuntimeCapabilities as RuntimeCapabilitiesType,
  RuntimePin as RuntimePinType,
} from '@cohorte/runtime-contract';
import { RuntimeCapabilities, RuntimePin } from '@cohorte/runtime-contract';
import type { SandboxCapabilities as SandboxCapabilitiesType } from '@cohorte/security/contract';
import { SandboxCapabilities } from '@cohorte/security/contract';
import { type TUnsafe, Type } from 'typebox';

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });

export interface RunSnapshotManifest {
  manifestVersion: 1;
  /** version de l'application, hash Git */
  createdAt: IsoInstant;
  app: { name: 'cohorte'; version: string; installDir: string; gitHash: string | null };
  /** resolved direct runtime deps (node_modules/<pkg>/package.json) */
  packages: { name: string; version: string }[];
  /** every file under dist/ == bundle-manifest.json */
  bundles: { file: string; sha256: Sha256; bytes: number }[];
  assets: { treeSha256: Sha256; embeddedTreeSha256: Sha256 };
  schemas: {
    protocolVersion: '1.0';
    stateSchemaVersion: number;
    configSchemaVersion: number;
    transitionTable: { profile: PipelineProfile; version: number };
  };
  /** bytes in the CAS */
  prompts: { id: string; source: 'shipped' | 'project-override'; logicalPath: string; sha256: Sha256 }[];
  skills: { id: string; version: string; source: 'shipped' | 'project'; sha256: Sha256 }[];
  config: {
    resolvedSha256: Sha256;
    ownershipSha256: Sha256;
    policySha256: Sha256;
    conventionsSha256: Sha256 | null;
    /** 2.10.1: the consent under which the loosening keys of the project file were honoured */
    trust: RunPlan['trust'];
  };
  spec: { id: SpecId; sha256: Sha256 } | null;
  environment: {
    pinnedPath: string[];
    platform: string;
    arch: string;
    sandbox: SandboxCapabilitiesType;
    runtimeCapabilities: RuntimeCapabilitiesType;
  };
  /** AgentRuntime actif (3.9) */
  runtime: RuntimePinType;
}

const TrustSchema = Type.Object(
  {
    policySha256: Sha256Schema,
    loosenedKeys: Type.Array(Type.String()),
    grantedBy: Type.Unsafe<RunPlan['trust']['grantedBy']>(Type.String()),
  },
  strict,
);

/** [S]. Annotated so that Biome's type-aware `noFloatingPromises` has nothing to infer (docs/v3/requests/U0.02.md R1). */
export const RunSnapshotManifest: TUnsafe<RunSnapshotManifest> = Type.Unsafe<RunSnapshotManifest>(
  Type.Object(
    {
      manifestVersion: Type.Literal(1),
      createdAt: IsoInstantSchema,
      app: Type.Object(
        {
          name: Type.Literal('cohorte'),
          version: Type.String(),
          installDir: Type.String(),
          gitHash: Type.Union([Type.String(), Type.Null()]),
        },
        strict,
      ),
      packages: Type.Array(Type.Object({ name: Type.String(), version: Type.String() }, strict)),
      bundles: Type.Array(Type.Object({ file: Type.String(), sha256: Sha256Schema, bytes: count() }, strict)),
      assets: Type.Object({ treeSha256: Sha256Schema, embeddedTreeSha256: Sha256Schema }, strict),
      schemas: Type.Object(
        {
          protocolVersion: Type.Literal('1.0'),
          stateSchemaVersion: count(),
          configSchemaVersion: count(),
          transitionTable: Type.Object({ profile: PipelineProfileSchema, version: count() }, strict),
        },
        strict,
      ),
      prompts: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            source: Type.Union([Type.Literal('shipped'), Type.Literal('project-override')]),
            logicalPath: Type.String(),
            sha256: Sha256Schema,
          },
          strict,
        ),
      ),
      skills: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            version: Type.String(),
            source: Type.Union([Type.Literal('shipped'), Type.Literal('project')]),
            sha256: Sha256Schema,
          },
          strict,
        ),
      ),
      config: Type.Object(
        {
          resolvedSha256: Sha256Schema,
          ownershipSha256: Sha256Schema,
          policySha256: Sha256Schema,
          conventionsSha256: Type.Union([Sha256Schema, Type.Null()]),
          trust: TrustSchema,
        },
        strict,
      ),
      spec: Type.Union([Type.Object({ id: SpecIdSchema, sha256: Sha256Schema }, strict), Type.Null()]),
      environment: Type.Object(
        {
          pinnedPath: Type.Array(Type.String()),
          platform: Type.String(),
          arch: Type.String(),
          sandbox: SandboxCapabilities,
          runtimeCapabilities: RuntimeCapabilities,
        },
        strict,
      ),
      runtime: RuntimePin,
    },
    strict,
  ),
);
