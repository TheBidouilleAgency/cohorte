// Use-time re-verification (DESIGN 2.6.3 step 8): the last check before an effect actually touches disk, run
// inside the per-slot effect mutex. Nothing here trusts what `resolve()` saw earlier — a symlink can be swapped
// in between the gate decision and the tool actually running (S-06).
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { err, ok, type Result } from '@cohorte/base';
import type { CanonicalPath, PathViolation, ResolvedPath } from '../../contract/index.ts';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function symlinkEscape(detail: string): Result<never, PathViolation> {
  return err({ code: 'symlink-escape', security: true, detail });
}

/**
 * Errno codes that say "this path is not what the caller thought it was", and nothing about an attack: the file
 * a tool is about to create does not exist yet, an ancestor is a regular file, the target is a directory, the
 * permissions do not allow it. `security: true` sends the whole RUN to BLOCKED (DESIGN 2.6.1
 * `PolicyVerdict.securityViolation`, spec 24), so it is reserved for the codes `O_NOFOLLOW` produces on a
 * planted symlink (`ELOOP`, `EMLINK` on some BSDs) — and for anything unclassified, which stays fail-closed.
 */
const BENIGN_OPEN_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ENAMETOOLONG']);

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** `symlink-escape` is the only `PathViolation` code that fits an open failure; `security` separates the two cases (request N6). */
function openFailure(error: unknown, detail: string): Result<never, PathViolation> {
  const code = isErrnoException(error) ? error.code : undefined;
  const security = code === undefined || !BENIGN_OPEN_ERRORS.has(code);
  return err({ code: 'symlink-escape', security, detail });
}

/**
 * Opens `canonical` with `O_NOFOLLOW` (a symlink as the final component fails outright, whatever put it there
 * since the gate ran) and, when `identity` was captured at gate time, `fstat`s the open descriptor — not the
 * path again, which could have changed a second time — and compares `(dev, ino)`. A mismatch means the file
 * the gate approved is not the file this call is about to touch.
 *
 * An open that fails for an ordinary reason — the file a `write` is about to create does not exist yet, an
 * ancestor is not a directory, the mode refuses it — is still a refusal, but NOT a security violation
 * (`BENIGN_OPEN_ERRORS`): it must not send the run to BLOCKED.
 */
export function openVerified(
  canonical: CanonicalPath,
  identity: ResolvedPath['identity'],
  intent: 'read' | 'write',
): Result<number, PathViolation> {
  const flags = (intent === 'read' ? fsConstants.O_RDONLY : fsConstants.O_WRONLY) | fsConstants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(canonical, flags);
  } catch (error) {
    return openFailure(error, `${canonical} could not be opened with O_NOFOLLOW at use time: ${describeError(error)}`);
  }
  if (identity !== undefined) {
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } catch (error) {
      // Total, like `resolve()`: an EBADF or a descriptor revoked under the sandbox closes the fd and fails
      // closed rather than throwing out of a use-time helper (and leaking it).
      closeSync(fd);
      return symlinkEscape(`${canonical} could not be re-stat'ed at use time: ${describeError(error)}`);
    }
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
      closeSync(fd);
      return symlinkEscape(
        `${canonical} identity changed between gate and use: was (${identity.dev},${identity.ino}), is now (${stat.dev},${stat.ino})`,
      );
    }
  }
  return ok(fd);
}

/**
 * The permission bits of an existing regular target. `rename` replaces the inode, so without carrying them over
 * every overwrite would reset a 0644 source file — or an executable script — to the temp file's 0600.
 * `undefined` for anything that is not a plain file (a symlink there is replaced, never followed).
 */
function existingFileMode(canonical: string): number | undefined {
  try {
    const stat = lstatSync(canonical);
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temp file sits inside the agent's own worktree; a run's cleanup sweeps whatever is left.
  }
}

/**
 * Writes `data` to a temp file in `canonical`'s own directory (`O_CREAT|O_EXCL|O_NOFOLLOW`, so the temp name
 * cannot itself be a pre-planted symlink), `fsync`s it, re-`realpath`s the directory to catch it having been
 * swapped for a symlink since the gate ran, then `rename`s the temp file onto `canonical` — atomic, and never a
 * write THROUGH a symlink.
 */
export function writeAtomicVerified(canonical: CanonicalPath, data: Uint8Array | string): Result<void, PathViolation> {
  const dir = dirname(canonical);
  const tempPath = `${dir}/.cohorte-tmp-${randomBytes(9).toString('hex')}`;
  const targetMode = existingFileMode(canonical);

  let fd: number;
  try {
    fd = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    // Same classification as `openVerified`: a missing directory is a tool error, a planted symlink is not.
    return openFailure(error, `could not create a temp file in ${dir}: ${describeError(error)}`);
  }
  try {
    if (targetMode !== undefined) {
      try {
        fchmodSync(fd, targetMode);
      } catch {
        // Best effort: a filesystem that refuses the mode must not fail the write itself, and 0600 is the
        // conservative outcome.
      }
    }
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  let realDir: string;
  try {
    realDir = realpathSync.native(dir);
  } catch (error) {
    bestEffortUnlink(tempPath);
    return symlinkEscape(`${dir} could not be re-verified after the write: ${describeError(error)}`);
  }
  if (realDir !== dir) {
    bestEffortUnlink(tempPath);
    return symlinkEscape(`${dir} was replaced by a symlink between resolution and write`);
  }

  try {
    renameSync(tempPath, canonical);
  } catch (error) {
    bestEffortUnlink(tempPath);
    return openFailure(error, `rename into ${canonical} failed: ${describeError(error)}`);
  }
  return ok(undefined);
}
