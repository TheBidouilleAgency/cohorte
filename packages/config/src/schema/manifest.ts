// `.cohorte/manifest.yaml` (DESIGN 2.10): the detection marker and the previous-hash guard of spec 14.
import { Sha256 } from '@cohorte/base';
import { type Static, Type } from 'typebox';

const closed = { additionalProperties: false } as const;

export const GeneratedFile = Type.Object(
  {
    /** `.cohorte`-relative POSIX path */
    path: Type.String({ minLength: 1 }),
    templateId: Type.String({ minLength: 1 }),
    templateSha256: Sha256,
    /** a generated file is replaced only if its CURRENT hash equals this one */
    renderedSha256: Sha256,
  },
  closed,
);
export type GeneratedFile = Static<typeof GeneratedFile>;

/** [S] */
export const Manifest = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    cohorteVersion: Type.String({ minLength: 1 }),
    createdWith: Type.String({ minLength: 1 }),
    protocol: Type.Object({ min: Type.String({ minLength: 1 }), max: Type.String({ minLength: 1 }) }, closed),
    stateSchemaVersion: Type.Integer({ minimum: 0 }),
    generated: Type.Array(GeneratedFile),
  },
  closed,
);
export type Manifest = Static<typeof Manifest>;
