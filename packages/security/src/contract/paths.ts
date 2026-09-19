// Canonical paths and the symlink policy (DESIGN 2.6.3, spec 23).
import type { Brand, Result } from '@cohorte/base';
import type { SymlinkPolicy } from '@cohorte/config/schema';

export type { SymlinkPolicy } from '@cohorte/config/schema';

/** absolute, realpath'd, NFC, no trailing slash, on-disk case */
export type CanonicalPath = Brand<string, 'CanonicalPath'>;

export type PathIntent = 'read' | 'write' | 'create' | 'list' | 'exec-cwd';

/** never throws; never follows a link it has not vetted */
export interface PathResolver {
  resolve(input: string, base: CanonicalPath, intent: PathIntent): Result<ResolvedPath, PathViolation>;
}

export interface ResolvedPath {
  canonical: CanonicalPath;
  /** POSIX, to the matched root */
  relative: string;
  root: CanonicalPath;
  exists: boolean;
  identity?: { dev: number; ino: number; nlink: number };
  viaSymlink: boolean;
}

export const PATH_VIOLATION_CODES = [
  'nul-byte',
  'outside-roots',
  'symlink-escape',
  'symlink-denied',
  'symlink-final-write',
  'hardlink-multiply-linked',
  'protected-root',
  'special-file',
  'too-long',
  'case-collision',
] as const;

export type PathViolation = { code: (typeof PATH_VIOLATION_CODES)[number]; security: boolean; detail: string };

/** What `createPathResolver` is built from. The built-in protected roots are NOT an option: they cannot be lifted. */
export interface PathResolverOptions {
  /** the agent's workspace first, then its read-only roots */
  roots: readonly CanonicalPath[];
  symlinks: SymlinkPolicy;
  /** the absolute protected roots of THIS machine (home-relative entries of `PROTECTED_HOME_PATHS` resolved by the caller, the install dir, the node dir) */
  protectedRoots: readonly CanonicalPath[];
}
