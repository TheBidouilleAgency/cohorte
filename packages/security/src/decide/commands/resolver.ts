// ProgramResolver: `argv[0]` through the PATH pinned at run start, then realpath (DESIGN 2.6.4). A repo-local shim,
// a `./node`, or a program planted in a directory outside the pinned list can never stand in for the real program:
// this resolver only ever looks inside the directories it was given, in order, and returns the on-disk realpath of
// whatever it finds there — never the raw candidate path (EV-07).
import { accessSync, constants, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalPath, ProgramResolver } from '../../contract/index.ts';

export interface ProgramResolverFs {
  accessSync(path: string, mode?: number): void;
  realpathSync(path: string): string;
}

const NODE_FS: ProgramResolverFs = { accessSync, realpathSync };

export interface ProgramResolverOptions {
  /** the PATH pinned at run start, as directories, in search order. Never Pi's or Cohorte's own bin directory. */
  pathDirs: readonly string[];
  /** injected for tests; defaults to `node:fs`. */
  fs?: ProgramResolverFs;
}

/**
 * `bareName` SHOULD already be a bare name (no path separator): that is checked one layer up, as the very first
 * thing `evaluate()` does (DESIGN 2.6.4 step 1). This resolver enforces it too, defensively: `node:path.join`
 * normalises a segment like `./node` or `../x` away, so without this guard a relative-looking name would silently
 * resolve through directory-list normalisation rather than being rejected outright, for any OTHER caller of this
 * port that does not repeat the step-1 check.
 */
export function createProgramResolver(options: ProgramResolverOptions): ProgramResolver {
  const dirs = [...options.pathDirs];
  const fs = options.fs ?? NODE_FS;
  const cache = new Map<string, CanonicalPath | undefined>();
  return {
    resolve(bareName: string): CanonicalPath | undefined {
      if (bareName === '' || bareName.includes('/') || bareName.includes('\\')) return undefined;
      const cached = cache.get(bareName);
      if (cached !== undefined || cache.has(bareName)) return cached;
      let found: CanonicalPath | undefined;
      for (const dir of dirs) {
        const candidate = join(dir, bareName);
        try {
          fs.accessSync(candidate, constants.X_OK);
          found = fs.realpathSync(candidate) as CanonicalPath;
          break;
        } catch {
          // not in this directory, or not executable: keep searching the pinned PATH
        }
      }
      cache.set(bareName, found);
      return found;
    },
  };
}
