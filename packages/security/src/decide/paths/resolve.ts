// The canonical PathResolver (DESIGN 2.6.3 steps 1-7, spec 23): one implementation shared by the gate,
// `WorkspaceReader`, `WorktreeService` and `tools`. Never throws — every failure mode, expected or not, comes
// back as a `PathViolation` (I2: fail closed).
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { err, ok, type Result } from '@cohorte/base';
import type {
  CanonicalPath,
  PathIntent,
  PathResolver,
  PathResolverOptions,
  PathViolation,
  ResolvedPath,
} from '../../contract/index.ts';
import { PROTECTED_REPO_GLOBS } from '../../contract/index.ts';
import { compilePatterns } from './glob.ts';

const MAX_INPUT_LENGTH = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the whole point is to catch a NUL byte or control character.
const CONTROL_OR_NUL = /[\x00-\x1f\x7f]/;
const ENV_SYNTAX = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%/;
// The home-directory shorthand is a whole SEGMENT — `~` or `~user` — never a tilde anywhere in a name: refusing
// every `~` made `notes.txt~`, `a~b.ts` and `~$report.docx` (an Office lock file) unaddressable.
const HOME_SHORTHAND_SEGMENT = /^~([A-Za-z0-9_][A-Za-z0-9_-]*)?$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^\\\\/;
const WRITE_LIKE = new Set<PathIntent>(['write', 'create']);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function violation(code: PathViolation['code'], security: boolean, detail: string): Result<never, PathViolation> {
  return err({ code, security, detail });
}

function segmentsOf(absolutePosixPath: string): string[] {
  return absolutePosixPath.split('/').filter((part) => part.length > 0);
}

/** Containment by path SEGMENTS, never `startsWith`: `apps/api` must not contain `apps/api-gateway`. */
function segmentsContain(longer: readonly string[], shorter: readonly string[]): boolean {
  if (longer.length < shorter.length) return false;
  for (let index = 0; index < shorter.length; index += 1) {
    if (longer[index] !== shorter[index]) return false;
  }
  return true;
}

function findRoot(absolutePosixPath: string, roots: readonly string[]): string | undefined {
  const target = segmentsOf(absolutePosixPath);
  return roots.find((root) => segmentsContain(target, segmentsOf(root)));
}

function isWithinAny(absolutePosixPath: string, candidates: readonly string[]): boolean {
  const target = segmentsOf(absolutePosixPath);
  return candidates.some((candidate) => segmentsContain(target, segmentsOf(candidate)));
}

/**
 * POSIX-relative form of `absolutePosixPath` to `root`, which always CONTAINS it: the caller picks `root` with
 * `findRoot` on the CANONICAL path. It can therefore never climb with `..` — and it must not, because the deny
 * globs and the protected-repository patterns are matched against this string, and a `..` segment matches no
 * double-star pattern (a relative form with `..` silently disabled both layers).
 */
function relativeTo(root: string, absolutePosixPath: string): string {
  return segmentsOf(absolutePosixPath).slice(segmentsOf(root).length).join('/');
}

interface Lstat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  dev: number;
  ino: number;
  nlink: number;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** `null` for "does not exist" (ENOENT — or ENOTDIR, an ancestor turned out not to be a directory). */
function lstatOrNull(absolutePath: string): Lstat | null {
  try {
    return lstatSync(absolutePath);
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function isSpecialFile(stat: Lstat): boolean {
  return stat.isFIFO() || stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice();
}

/**
 * The one point a blind create could alias an existing entry that `realpath` cannot fix for us, because the
 * requested name does not exist yet: a case-insensitive volume already holds a differently-cased sibling.
 */
function caseInsensitiveSiblingExists(dir: string, requestedName: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  const lower = requestedName.toLowerCase();
  return entries.some((entry) => entry !== requestedName && entry.toLowerCase() === lower);
}

interface WalkOutcome {
  /** on-disk case, absolute POSIX, no trailing slash: the deepest existing position of the walk. */
  canonicalDir: string;
  /** the requested-case segments beyond `canonicalDir` that do not exist yet; empty once fully resolved. */
  tailSegments: string[];
  exists: boolean;
  viaSymlink: boolean;
}

export function createPathResolver(options: PathResolverOptions): PathResolver {
  const roots = options.roots.map((root): string => root);
  const protectedRoots = options.protectedRoots.map((root): string => root);
  const protectedRepoPath = compilePatterns(PROTECTED_REPO_GLOBS);
  const { mode: symlinkMode, hardlinksOnWrite } = options.symlinks;

  /** DESIGN 2.6.3 steps 3-4: one component at a time, from `root` to the leaf. */
  function walk(root: string, target: string, intent: PathIntent): Result<WalkOutcome, PathViolation> {
    const remaining = segmentsOf(target).slice(segmentsOf(root).length);
    let current = root;
    let viaSymlink = false;

    for (let index = 0; index < remaining.length; index += 1) {
      const name = remaining[index];
      if (name === undefined) break; // unreachable: index ranges over remaining.length
      const candidate = `${current}/${name}`;
      const isFinal = index === remaining.length - 1;
      const stat = lstatOrNull(candidate);

      if (stat === null) {
        const canonicalDir = realpathSync.native(current);
        if (WRITE_LIKE.has(intent) && caseInsensitiveSiblingExists(canonicalDir, name)) {
          return violation(
            'case-collision',
            true,
            `${candidate} collides, case-insensitively, with an existing entry of ${canonicalDir}`,
          );
        }
        return ok({ canonicalDir, tailSegments: remaining.slice(index), exists: false, viaSymlink });
      }

      if (stat.isSymbolicLink()) {
        if (isFinal && WRITE_LIKE.has(intent)) {
          return violation(
            'symlink-final-write',
            true,
            `${candidate} is a symlink; a write never follows the final path component`,
          );
        }
        if (symlinkMode === 'deny-all') {
          return violation('symlink-denied', true, `${candidate} is a symlink; policy is deny-all`);
        }
        let linkTarget: string;
        try {
          linkTarget = realpathSync.native(candidate);
        } catch (error) {
          return violation('symlink-escape', true, `${candidate} could not be resolved: ${describeError(error)}`);
        }
        if (symlinkMode === 'deny-outgoing' && findRoot(linkTarget, roots) === undefined) {
          return violation('symlink-escape', true, `${candidate} -> ${linkTarget} leaves every root`);
        }
        current = linkTarget;
        viaSymlink = true;
        continue;
      }

      if (isSpecialFile(stat) && !isFinal) {
        return violation('special-file', true, `${candidate} is a FIFO, socket or device: cannot descend into it`);
      }
      current = candidate;
    }

    return ok({ canonicalDir: realpathSync.native(current), tailSegments: [], exists: true, viaSymlink });
  }

  function resolveOnce(input: string, base: CanonicalPath, intent: PathIntent): Result<ResolvedPath, PathViolation> {
    if (CONTROL_OR_NUL.test(input)) return violation('nul-byte', true, 'control character or NUL byte in path');
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_LENGTH) {
      return violation('too-long', true, `path exceeds ${MAX_INPUT_LENGTH} bytes`);
    }
    if (input.split('/').some((segment) => HOME_SHORTHAND_SEGMENT.test(segment))) {
      return violation('outside-roots', true, 'home-directory shorthand (~) is never expanded');
    }
    if (ENV_SYNTAX.test(input))
      return violation('outside-roots', true, 'environment-variable syntax is never expanded');
    if (WINDOWS_DRIVE.test(input) || UNC_PREFIX.test(input)) {
      return violation('outside-roots', true, 'Windows drive/UNC path forms are not supported');
    }

    const target = resolvePath(base, input.normalize('NFC'));
    // The LEXICAL root only says where to start the walk; it decides nothing.
    const lexicalRoot = findRoot(target, roots);
    if (lexicalRoot === undefined) return violation('outside-roots', true, `${target} is outside every root`);

    const walked = walk(lexicalRoot, target, intent);
    if (!walked.ok) return walked;
    const { canonicalDir, tailSegments, exists, viaSymlink } = walked.value;
    const canonical = tailSegments.length === 0 ? canonicalDir : `${canonicalDir}/${tailSegments.join('/')}`;

    // Step 4, AFTER the walk: containment is decided on the canonical path, never on the lexical one. With more
    // than one root — the normal grant shape, a workspace plus read-only roots — a symlink (or a realpath'd
    // ancestor) can land in a root OTHER than the one the input pointed at, and `root` / `relative` must name
    // where the bytes really are: step 5 and every relative deny-glob below match on `relative`.
    const root = findRoot(canonical, roots);
    if (root === undefined) return violation('outside-roots', true, `${canonical} resolves outside every root`);

    // Step 5: built-in protected roots — never overridable by config or approval.
    if (isWithinAny(canonical, protectedRoots))
      return violation('protected-root', true, `${canonical} is a protected root`);
    const relative = relativeTo(root, canonical);
    if (protectedRepoPath(relative))
      return violation('protected-root', true, `${relative} is a protected repository path`);

    // Step 6: hardlink / special-file, on the resolved target.
    let identity: ResolvedPath['identity'];
    if (exists) {
      const stat = lstatSync(canonical);
      if (isSpecialFile(stat)) return violation('special-file', true, `${canonical} is a FIFO, socket or device`);
      if (WRITE_LIKE.has(intent) && stat.isFile() && stat.nlink > 1 && hardlinksOnWrite === 'deny') {
        return violation('hardlink-multiply-linked', true, `${canonical} has ${stat.nlink} hard links`);
      }
      identity = { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
    }

    return ok({
      canonical: canonical as CanonicalPath,
      relative,
      root: root as CanonicalPath,
      exists,
      viaSymlink,
      ...(identity ? { identity } : {}),
    });
  }

  return {
    resolve(input, base, intent) {
      try {
        return resolveOnce(input, base, intent);
      } catch (error) {
        // Fail closed (I2): a symlink loop `realpath` cannot follow, a permission error walking a component,
        // anything unforeseen — never an uncaught throw.
        const detail = `unexpected error resolving ${JSON.stringify(input)}: ${describeError(error)}`;
        return violation('outside-roots', true, detail);
      }
    },
  };
}
