// apps/cli/src/pin/index.ts — AREA barrel: verifies the running install against `bundle-manifest.json` before a
// `resume` re-execs it (DESIGN 6.3 "A run belongs to its install ... after its dist/** hashes verify"). Wave-0
// stub: filled by `U4.01`, which owns `apps/cli/src/pin/**`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type ErrorInfo, err, errorOf, ok, type Result, type Sha256, sha256Hex } from '@cohorte/base';
import type { InstallInspector } from '../contract/index.ts';

/** DESIGN 6.3 rule 2: refuses (`runtime-incompatible`) rather than falling back to whichever CLI is running. */
export async function verifyPinnedInstall(
  install: InstallInspector,
  pinnedDir: string,
): Promise<Result<true, ErrorInfo>> {
  try {
    const expected = await install.bundleManifest();
    for (const file of expected) {
      const path = resolve(pinnedDir, file.file);
      if (!path.startsWith(`${resolve(pinnedDir)}/`) || !existsSync(path) || !statSync(path).isFile())
        return err(errorOf('security/runtime-pin-mismatch', `pinned install is missing ${file.file}`));
      const bytes = readFileSync(path);
      if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256)
        return err(errorOf('security/runtime-pin-mismatch', `pinned install differs at ${file.file}`));
    }
    return ok(true);
  } catch (error) {
    return err(errorOf('security/runtime-pin-mismatch', `cannot verify pinned install: ${String(error)}`));
  }
}

export function createInstallInspector(): InstallInspector {
  return {
    installDir: () => dirname(distDirectory()),
    async bundleManifest() {
      const path = join(distDirectory(), 'bundle-manifest.json');
      if (!existsSync(path)) return [];
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return Object.entries(raw)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([file, digest]) => {
          if (typeof digest !== 'string') throw new TypeError(`invalid bundle manifest entry: ${file}`);
          const filePath = join(distDirectory(), file);
          return {
            file: join('dist', file),
            sha256: digest as Sha256,
            bytes: existsSync(filePath) ? statSync(filePath).size : 0,
          };
        });
    },
  };
}

function distDirectory(): string {
  const candidates = [import.meta.dirname, dirname(import.meta.dirname)];
  return candidates.find((candidate) => existsSync(join(candidate, 'bundle-manifest.json'))) ?? import.meta.dirname;
}
