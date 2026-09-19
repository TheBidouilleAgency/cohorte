// @cohorte/project-model/contract (PLAN PC-4, spec 12-13): frozen in Wave 0 so that the scan unit and the drift unit
// never import each other. Types are written by hand and the schema consts annotated: see docs/v3/requests/U0.02.md R1.
import { ID_PATTERN, IsoInstant, Sha256 } from '@cohorte/base';
import type { Manifest } from '@cohorte/config/schema';
import { type TSchema, type TUnsafe, Type } from 'typebox';

const closed = { additionalProperties: false } as const;
const oneOf = <const V extends readonly string[]>(values: V): TUnsafe<V[number]> =>
  Type.Unsafe<V[number]>({ type: 'string', enum: [...values] });

/** Spec 13: every field of the model, and every file of `.cohorte/`, has exactly one class. */
export const FIELD_CLASSES = ['human', 'generated', 'derived', 'observed', 'mixed'] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

/** Spec 13: what the diff engine must tell apart. */
export const DIFF_CLASSES = [
  'absent',
  'expected-change',
  'human-change',
  'conflict',
  'potential-deletion',
  'unknown',
] as const;
export type DiffClass = (typeof DIFF_CLASSES)[number];

export interface Provenance {
  /** which deterministic detector produced the value, e.g. 'package-json', 'lockfile', 'git', 'human-config' */
  detector: string;
  /** repo-relative POSIX paths the value was read from */
  sources: string[];
  /** 0..1; only a SEMANTIC inference carries one (spec 12), and V3.0 has none */
  confidence?: number;
}

export interface ModelField<T> {
  value: T;
  class: FieldClass;
  provenance: Provenance;
}

/** Ambiguity is recorded, NEVER resolved by inventing a value (a command least of all). */
export interface Unknown {
  id: string;
  question: string;
  candidates: string[];
  sources: string[];
}

export interface Risk {
  id: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  sources: string[];
}

/** Spec 12. `commands` are argv arrays, not the shell strings of the spec's example: the product is argv-only (I3, D-25). */
export interface ProjectModel {
  schemaVersion: 1;
  project: { id: ModelField<string>; root: ModelField<string> };
  stack: {
    languages: ModelField<string[]>;
    packageManager: ModelField<string | null>;
    frameworks: ModelField<string[]>;
  };
  surfaces: Record<string, { paths: ModelField<string[]> }>;
  commands: Record<string, ModelField<string[]>>;
  testStrategy: ModelField<{ runner: string | null; locations: string[] }>;
  deploymentHints: ModelField<string[]>;
  ownership: ModelField<{ codeowners: string | null }>;
  risks: Risk[];
  conventions: ModelField<string[]>;
  generatedArtifacts: ModelField<string[]>;
  unknowns: Unknown[];
  provenance: { generatedAt: IsoInstant; toolVersion: string; analysis: 'deterministic' };
}

const strings = () => Type.Array(Type.String());
const ProvenanceSchema = Type.Object(
  {
    detector: Type.String({ minLength: 1 }),
    sources: strings(),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  closed,
);
const field = (value: TSchema) =>
  Type.Object({ value, class: oneOf(FIELD_CLASSES), provenance: ProvenanceSchema }, closed);
const nullableString = () => Type.Union([Type.String(), Type.Null()]);

/** [S] `.cohorte/project.yaml`, and the document `cohorte discover` prints. */
export const ProjectModel: TUnsafe<ProjectModel> = Type.Unsafe<ProjectModel>(
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      project: Type.Object({ id: field(Type.String({ pattern: ID_PATTERN })), root: field(Type.String()) }, closed),
      stack: Type.Object(
        { languages: field(strings()), packageManager: field(nullableString()), frameworks: field(strings()) },
        closed,
      ),
      surfaces: Type.Record(Type.String({ pattern: ID_PATTERN }), Type.Object({ paths: field(strings()) }, closed)),
      commands: Type.Record(Type.String(), field(Type.Array(Type.String(), { minItems: 1 }))),
      testStrategy: field(Type.Object({ runner: nullableString(), locations: strings() }, closed)),
      deploymentHints: field(strings()),
      ownership: field(Type.Object({ codeowners: nullableString() }, closed)),
      risks: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            severity: oneOf(['high', 'medium', 'low']),
            message: Type.String(),
            sources: strings(),
          },
          closed,
        ),
      ),
      conventions: field(strings()),
      generatedArtifacts: field(strings()),
      unknowns: Type.Array(
        Type.Object({ id: Type.String(), question: Type.String(), candidates: strings(), sources: strings() }, closed),
      ),
      provenance: Type.Object(
        { generatedAt: IsoInstant, toolVersion: Type.String(), analysis: Type.Literal('deterministic') },
        closed,
      ),
    },
    closed,
  ),
);

/** One file Cohorte wants to exist under `.cohorte/` (desired) or found there (actual). */
export interface StateFile {
  /** `.cohorte`-relative POSIX path */
  path: string;
  class: FieldClass;
  sha256: Sha256;
  templateId?: string;
  /** Rendered content, kept in-memory for an authorized reconcile apply. */
  content?: string;
}
export interface DesiredState {
  cohorteVersion: string;
  files: StateFile[];
}
export interface ActualState {
  /** the manifest found on disk; null = not initialised */
  manifest: Manifest | null;
  files: StateFile[];
}

export interface DriftEntry {
  /** `.cohorte`-relative POSIX path, or a JSON pointer into project.yaml prefixed with `project.yaml#` */
  target: string;
  class: FieldClass;
  diff: DiffClass;
  /** what the desired state renders to */
  desiredSha256?: Sha256;
  /** what is on disk */
  actualSha256?: Sha256;
  /** `renderedSha256` of the manifest: the previous-hash guard of spec 14 */
  recordedSha256?: Sha256;
  detail: string;
}

export interface DriftReport {
  schemaVersion: 1;
  generatedAt: IsoInstant;
  entries: DriftEntry[];
}

export const RECONCILE_OPS = ['create', 'replace', 'delete', 'keep', 'ask'] as const;

export interface ReconcileOperation {
  op: (typeof RECONCILE_OPS)[number];
  target: string;
  diff: DiffClass;
  reason: string;
}

/** The `--json` document of `cohorte reconcile --plan`. */
export interface ReconcilePlan {
  schemaVersion: 1;
  cohorteVersion: string;
  generatedAt: IsoInstant;
  drift: DriftReport;
  /** a human override is never in here as `replace` or `delete`: a collision is a `conflict` */
  operations: ReconcileOperation[];
  /** targets whose diff class is `conflict` */
  conflicts: string[];
  applyAvailable: boolean;
}

const sha = () => Type.Optional(Sha256);
const DriftReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    generatedAt: IsoInstant,
    entries: Type.Array(
      Type.Object(
        {
          target: Type.String({ minLength: 1 }),
          class: oneOf(FIELD_CLASSES),
          diff: oneOf(DIFF_CLASSES),
          desiredSha256: sha(),
          actualSha256: sha(),
          recordedSha256: sha(),
          detail: Type.String(),
        },
        closed,
      ),
    ),
  },
  closed,
);

/** [S] */
export const DriftReport: TUnsafe<DriftReport> = Type.Unsafe<DriftReport>(DriftReportSchema);

/** [S] published by `gen-schemas` */
export const ReconcilePlan: TUnsafe<ReconcilePlan> = Type.Unsafe<ReconcilePlan>(
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      cohorteVersion: Type.String({ minLength: 1 }),
      generatedAt: IsoInstant,
      drift: DriftReportSchema,
      operations: Type.Array(
        Type.Object(
          {
            op: oneOf(RECONCILE_OPS),
            target: Type.String({ minLength: 1 }),
            diff: oneOf(DIFF_CLASSES),
            reason: Type.String(),
          },
          closed,
        ),
      ),
      conflicts: Type.Array(Type.String()),
      applyAvailable: Type.Boolean(),
    },
    closed,
  ),
);

export interface InitFile {
  /** `.cohorte`-relative POSIX path */
  path: string;
  /** an existing human file is NEVER overwritten */
  action: 'create' | 'keep-existing';
  class: FieldClass;
  content: string;
  templateId?: string;
  templateSha256?: Sha256;
  renderedSha256?: Sha256;
}

/** What `cohorte init` will do, computed without writing anything. Idempotent: planning twice yields the same plan. */
export interface InitPlan {
  projectRoot: string;
  model: ProjectModel;
  files: InitFile[];
  manifest: Manifest;
  warnings: string[];
}

/** INJECTED into `planReconcile`, so the drift unit never imports the scan unit. */
export type RepositoryScanner = (root: string) => Promise<ProjectModel>;
