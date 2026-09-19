// Shared scaffolding for packages/security/test/decide/paths/**. Not a test file itself (no `.test.ts` suffix):
// packages/security/test/contract/samples.ts already establishes this pattern in the sibling suite.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SYMLINK_POLICY } from '@cohorte/config/schema';
import type {
  AgentGrant,
  CanonicalPath,
  GlobSet,
  PathResolver,
  PathResolverOptions,
} from '../../../src/contract/index.ts';
import { createPathResolver } from '../../../src/decide/paths/index.ts';

/** `deny-outgoing` + `hardlinksOnWrite: deny` (the project default), one root, no protected roots — override as needed. */
export function resolverFor(root: string, overrides: Partial<PathResolverOptions> = {}): PathResolver {
  return createPathResolver({
    roots: [root as CanonicalPath],
    symlinks: DEFAULT_SYMLINK_POLICY,
    protectedRoots: [],
    ...overrides,
  });
}

export const emptySet = (): GlobSet => ({ include: [], exclude: [] });
export const setOf = (include: string[], exclude: string[] = []): GlobSet => ({ include, exclude });

/** A grant whose only interesting fields are the four glob sets: everything else is inert filler. */
export function grantOf(sets: Partial<Pick<AgentGrant, 'read' | 'write' | 'denyRead' | 'denyWrite'>>): AgentGrant {
  return {
    agentId: 'agt_test_main' as AgentGrant['agentId'],
    role: 'implementer',
    digest: '0'.repeat(64) as AgentGrant['digest'],
    tools: [],
    roots: { workspace: null, readOnly: [] },
    read: sets.read ?? emptySet(),
    write: sets.write ?? emptySet(),
    denyRead: sets.denyRead ?? emptySet(),
    denyWrite: sets.denyWrite ?? emptySet(),
    commands: { default: 'deny', rules: [] },
    secrets: [],
    temporary: [],
    limits: { maxToolCalls: 0, maxCallsPerMinute: 0, perTool: {} },
  };
}

/** A fresh directory that is a SIBLING of `root`: outside every root a test builds only from `root`. */
export function siblingDir(root: string, suffix = 'outside'): string {
  const dir = join(dirname(root), `${suffix}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when `candidate` is `root` or nested under it, compared by path SEGMENTS (never `startsWith`). */
export function isUnder(candidate: string, root: string): boolean {
  const candidateSegments = candidate.split('/').filter(Boolean);
  const rootSegments = root.split('/').filter(Boolean);
  if (candidateSegments.length < rootSegments.length) return false;
  return rootSegments.every((segment, index) => candidateSegments[index] === segment);
}

/** A tiny, seeded PRNG (mulberry32): deterministic across machines and CI, unlike `Math.random`. */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
