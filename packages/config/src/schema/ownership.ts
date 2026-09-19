// `.cohorte/ownership.yaml` (DESIGN 2.10): surfaces, their paths, owners and reviewers.
import { ID_PATTERN } from '@cohorte/base';
import { type TUnsafe, Type } from 'typebox';

const closed = { additionalProperties: false } as const;

/** The one surface whose paths may overlap any other surface's (DESIGN 2.10, 5.6). */
export const SHARED_SURFACE_ID = 'shared';

export interface Surface {
  /** worktree-relative POSIX globs */
  paths: string[];
  /** role ids allowed to WRITE the surface */
  owners: string[];
  reviewers: string[];
  /** a write to one of these paths is an `ask` (DESIGN 5.6) */
  approval?: 'human';
}
export interface Ownership {
  surfaces: Record<string, Surface>;
}

const names = () => Type.Array(Type.String({ minLength: 1 }));
const SurfaceSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    owners: names(),
    reviewers: names(),
    approval: Type.Optional(Type.Literal('human')),
  },
  closed,
);
const OwnershipSchema = Type.Object(
  { surfaces: Type.Record(Type.String({ pattern: ID_PATTERN }), SurfaceSchema) },
  closed,
);

/** [S]. Annotated: a `Static<TRecord>` inferred by Biome overflows its stack (docs/v3/requests/U0.03.md R1). */
export const Ownership: TUnsafe<Ownership> = Type.Unsafe<Ownership>(OwnershipSchema);

const GLOB_META = /[*?[\]{}()!]/;

/** The literal prefix of a glob, by path SEGMENT: the segments before the first one holding a glob metacharacter (DESIGN 5.6). */
export function literalPrefixOf(pattern: string): string[] {
  const prefix: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (GLOB_META.test(segment)) break;
    prefix.push(segment);
  }
  return prefix;
}

const isSegmentAncestorOrEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((segment, index) => segment === b[index]);

/** Two patterns overlap when one literal prefix is a segment-ancestor of (or equal to) the other; no literal prefix overlaps everything. */
export function patternsOverlap(a: string, b: string): boolean {
  const left = literalPrefixOf(a);
  const right = literalPrefixOf(b);
  return isSegmentAncestorOrEqual(left, right) || isSegmentAncestorOrEqual(right, left);
}

export interface OwnershipProblem {
  /** JSON pointer into the ownership document */
  path: string;
  message: string;
}

/**
 * The rule a JSON Schema cannot say: every surface path is DISJOINT from the paths of every other surface, unless
 * one of the two surfaces is `shared`. Conservative on purpose (prefix overlap, not glob intersection): a false
 * "overlap" costs an edit of ownership.yaml, a missed one lets two agents write the same file.
 */
export function ownershipProblems(ownership: Ownership): OwnershipProblem[] {
  const problems: OwnershipProblem[] = [];
  const entries = Object.entries(ownership.surfaces).filter(([id]) => id !== SHARED_SURFACE_ID);
  entries.forEach(([id, surface], at) => {
    for (const [otherId, other] of entries.slice(at + 1)) {
      surface.paths.forEach((path, index) => {
        const clash = other.paths.find((candidate) => patternsOverlap(path, candidate));
        if (clash !== undefined) {
          problems.push({
            path: `/surfaces/${id}/paths/${index}`,
            message: `"${path}" of surface "${id}" overlaps "${clash}" of surface "${otherId}": make them disjoint or move the path to the "${SHARED_SURFACE_ID}" surface`,
          });
        }
      });
    }
  });
  return problems;
}
