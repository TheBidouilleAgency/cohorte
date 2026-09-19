// `.cohorte/specs/<id>.yaml` (DESIGN 2.10): a feature or a patch, draft or frozen; immutable once frozen.
import { canonicalJson, ID_PATTERN, type JsonValue, Sha256, sha256Hex } from '@cohorte/base';
import { type TUnsafe, Type } from 'typebox';

const closed = { additionalProperties: false } as const;

interface SpecBody {
  id: string;
  kind: 'feature' | 'patch';
  title: string;
  acceptance: string[];
  surfaces: Record<string, { tasks: string[] }>;
  /** worktree-relative path of the contract file */
  contract?: string;
  openQuestions: string[];
  patch?: { repro: string; regressionTest: string; causeConfirmed: boolean };
}
export interface DraftSpec extends SpecBody {
  status: 'draft';
}
export interface FrozenSpec extends SpecBody {
  status: 'frozen';
  /** sha256 of the canonical JSON of the spec WITHOUT `status` and `sha256`: see {@link specContentSha256} */
  sha256: Sha256;
}
export type Spec = DraftSpec | FrozenSpec;

const texts = () => Type.Array(Type.String({ minLength: 1 }));
const body = {
  id: Type.String({ pattern: ID_PATTERN }),
  kind: Type.Union([Type.Literal('feature'), Type.Literal('patch')]),
  title: Type.String({ minLength: 1 }),
  acceptance: texts(),
  surfaces: Type.Record(Type.String({ pattern: ID_PATTERN }), Type.Object({ tasks: texts() }, closed)),
  contract: Type.Optional(Type.String({ minLength: 1 })),
  openQuestions: texts(),
  patch: Type.Optional(
    Type.Object({ repro: Type.String(), regressionTest: Type.String(), causeConfirmed: Type.Boolean() }, closed),
  ),
};
const SpecSchema = Type.Union([
  Type.Object({ ...body, status: Type.Literal('draft') }, closed),
  Type.Object({ ...body, status: Type.Literal('frozen'), sha256: Sha256 }, closed),
]);

/** [S]. A frozen spec WITHOUT a sha256, and a draft WITH one, are both invalid. */
export const Spec: TUnsafe<Spec> = Type.Unsafe<Spec>(SpecSchema);

/** What freezing signs: everything a human wrote, nothing the freeze itself adds. */
export function specContentSha256(spec: Spec): Sha256 {
  const content: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key !== 'status' && key !== 'sha256' && value !== undefined) content[key] = value as JsonValue;
  }
  return sha256Hex(canonicalJson(content));
}

export interface SpecProblem {
  path: string;
  message: string;
}

/** A frozen spec rejects edits: its content must still hash to the sha256 it was frozen with. A draft has nothing to prove. */
export function frozenSpecProblems(spec: Spec): SpecProblem[] {
  if (spec.status !== 'frozen') return [];
  const actual = specContentSha256(spec);
  if (actual === spec.sha256) return [];
  return [
    {
      path: '/sha256',
      message: `spec "${spec.id}" is frozen and was edited: content hashes to ${actual}, frozen as ${spec.sha256}. Revert the edit, or write a new spec`,
    },
  ];
}
