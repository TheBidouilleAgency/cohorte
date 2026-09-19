// DESIGN 2.7 — gated reads/lists for ContextBuilder, using the same resolver and grant rules as tools.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type ErrorInfo, err, errorOf, ok, type Result, type Sha256 } from '@cohorte/base';
import type { AgentGrant, CanonicalPath, GlobMatcher, GlobSet, PathResolver } from '@cohorte/security/contract';

export interface WorkspaceReader {
  read(
    root: CanonicalPath,
    rel: string,
    grant: AgentGrant,
  ): Promise<Result<{ bytes: Uint8Array; sha256: Sha256 }, ErrorInfo>>;
  list(root: CanonicalPath, globs: GlobSet, grant: AgentGrant): Promise<string[]>;
}

export interface WorkspaceReaderDeps {
  paths: PathResolver;
  globs: GlobMatcher;
}

const digest = (bytes: Uint8Array): Sha256 => createHash('sha256').update(bytes).digest('hex') as Sha256;
const denied = (detail: string): Result<never, ErrorInfo> => err(errorOf('permission/path-outside-grant', detail));

function grantAllows(path: { relative: string }, grant: AgentGrant, globs: GlobMatcher, intent: 'read' | 'write') {
  return !globs.isDenied(path.relative, grant, intent);
}

/** The only filesystem reader used by ContextBuilder. Every requested path is resolved and grant-filtered first. */
export function createWorkspaceReader(deps: WorkspaceReaderDeps): WorkspaceReader {
  return {
    async read(root, rel, grant) {
      const resolved = deps.paths.resolve(rel, root, 'read');
      if (!resolved.ok) return denied(resolved.error.detail);
      if (!grantAllows(resolved.value, grant, deps.globs, 'read')) return denied(`read denied for ${rel}`);
      if (!resolved.value.exists) return denied(`read target does not exist: ${rel}`);
      try {
        const bytes = await readFile(resolved.value.canonical);
        if (bytes.byteLength > 256 * 1024) return denied(`read target exceeds the 256 KiB context limit: ${rel}`);
        if (bytes.includes(0)) return denied(`binary read target refused: ${rel}`);
        return ok({ bytes, sha256: digest(bytes) });
      } catch {
        return denied(`read target is not accessible: ${rel}`);
      }
    },

    async list(root, globs, grant) {
      const resolvedRoot = deps.paths.resolve('.', root, 'list');
      if (!resolvedRoot.ok || !grantAllows(resolvedRoot.value, grant, deps.globs, 'read')) return [];
      const found: string[] = [];
      async function walk(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const absolute = join(current, entry.name);
          const rel = relative(root, absolute).split('\\').join('/');
          const candidate = deps.paths.resolve(rel, root, 'read');
          if (!candidate.ok || !candidate.value.exists || !grantAllows(candidate.value, grant, deps.globs, 'read'))
            continue;
          if (entry.isDirectory()) await walk(absolute);
          else if (deps.globs.matches(candidate.value.relative, globs)) found.push(candidate.value.relative);
        }
      }
      await walk(resolvedRoot.value.canonical);
      return found.sort();
    },
  };
}
