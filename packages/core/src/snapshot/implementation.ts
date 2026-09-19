import { type ErrorInfo, err, errorOf, ok, type Result, type Sha256, sha256Hex } from '@cohorte/base';
import type { BlobStore } from '@cohorte/persistence/contract';
import type { RuntimeCapabilities } from '@cohorte/runtime-contract';
import type { SandboxCapabilities } from '@cohorte/security/contract';
import { Compile } from 'typebox/compile';
import type { RunSnapshotter } from '../contract/internal.ts';
import type { InstallInspector } from '../contract/ports.ts';
import type { RunSnapshotManifest } from '../contract/snapshot-manifest.ts';
import { RunSnapshotManifest as RunSnapshotManifestSchema } from '../contract/snapshot-manifest.ts';
import type { SnapshotInput } from '../contract/types.ts';

export interface SnapshotMetadata {
  app: { version: string; gitHash: string | null };
  packages: { name: string; version: string }[];
  assets: { treeSha256: Sha256; embeddedTreeSha256: Sha256 };
  schemas: { stateSchemaVersion: number; configSchemaVersion: number; transitionTableVersion: number };
  prompts: RunSnapshotManifest['prompts'];
  skills: RunSnapshotManifest['skills'];
  environment: {
    pinnedPath: string[];
    platform: string;
    arch: string;
    sandbox: SandboxCapabilities;
    runtimeCapabilities: RuntimeCapabilities;
  };
  readFile(path: string): Promise<Uint8Array>;
  onMaterialized?(logicalPath: string, ref: { sha256: Sha256; bytes: number; path: string }): void;
}

const manifestValidator = Compile(RunSnapshotManifestSchema);
const manifestCheck = (value: unknown): boolean => manifestValidator.Check(value);

function snapshotError(message: string): ErrorInfo {
  return errorOf('security/pin-tampered', message);
}

export function createRunSnapshotterImpl(deps: {
  installInspector: InstallInspector;
  clock: { now(): RunSnapshotManifest['createdAt'] };
  pinStore: BlobStore;
  metadata: SnapshotMetadata;
}): RunSnapshotter {
  const refs = new Map<string, { sha256: Sha256; bytes: number; path: string }>();

  const materialize = async (logicalPath: string, path: string): Promise<Sha256> => {
    const bytes = await deps.metadata.readFile(path);
    const stored = await deps.pinStore.put(bytes);
    const ref = { ...stored, path };
    refs.set(logicalPath, ref);
    deps.metadata.onMaterialized?.(logicalPath, ref);
    return stored.sha256;
  };

  return {
    async capture(input: SnapshotInput): Promise<RunSnapshotManifest> {
      const config = await materialize('config.yaml', input.configPaths.config);
      const ownership = await materialize('ownership.yaml', input.configPaths.ownership);
      const policy = await materialize('policy.yaml', input.configPaths.policy);
      const conventions = input.configPaths.conventions
        ? await materialize('conventions.md', input.configPaths.conventions)
        : null;
      const spec = input.spec ? { id: input.spec.id, sha256: await materialize('spec.md', input.spec.path) } : null;
      const prompts = [
        ...deps.metadata.prompts,
        ...(await Promise.all(
          (input.prompts ?? []).map(async (prompt) => ({
            id: prompt.id,
            source: prompt.source,
            logicalPath: prompt.logicalPath,
            sha256: await materialize(`prompt:${prompt.id}`, prompt.path),
          })),
        )),
      ];
      const bundles = await deps.installInspector.bundleManifest();
      const manifest: RunSnapshotManifest = {
        manifestVersion: 1,
        createdAt: deps.clock.now(),
        app: {
          name: 'cohorte',
          version: deps.metadata.app.version,
          installDir: input.installDir,
          gitHash: deps.metadata.app.gitHash,
        },
        packages: [...deps.metadata.packages].sort((a, b) => a.name.localeCompare(b.name)),
        bundles: [...bundles].sort((a, b) => a.file.localeCompare(b.file)),
        assets: deps.metadata.assets,
        schemas: {
          protocolVersion: '1.0',
          stateSchemaVersion: deps.metadata.schemas.stateSchemaVersion,
          configSchemaVersion: deps.metadata.schemas.configSchemaVersion,
          transitionTable: {
            profile: input.trust.grantedBy === 'none-needed' ? 'feature' : 'feature',
            version: deps.metadata.schemas.transitionTableVersion,
          },
        },
        prompts,
        skills: [...deps.metadata.skills],
        config: {
          resolvedSha256: config,
          ownershipSha256: ownership,
          policySha256: policy,
          conventionsSha256: conventions,
          trust: input.trust,
        },
        spec,
        environment: deps.metadata.environment,
        runtime: input.runtime,
      };
      if (!manifestCheck(manifest)) throw new Error('validation/snapshot-manifest-invalid');
      return manifest;
    },

    async verify(manifest): Promise<Result<true, ErrorInfo>> {
      if (!manifestCheck(manifest))
        return err(errorOf('validation/unexpected', 'snapshot manifest does not match its schema'));
      const expected = new Set<Sha256>([
        manifest.config.resolvedSha256,
        manifest.config.ownershipSha256,
        manifest.config.policySha256,
        ...(manifest.config.conventionsSha256 ? [manifest.config.conventionsSha256] : []),
        ...(manifest.spec ? [manifest.spec.sha256] : []),
        ...manifest.prompts.map((prompt) => prompt.sha256),
      ]);
      for (const [logicalPath, ref] of refs) {
        if (!expected.has(ref.sha256)) continue;
        const bytes = await deps.pinStore.read(ref.sha256);
        if (sha256Hex(bytes) !== ref.sha256) return err(snapshotError(`snapshot blob was modified: ${logicalPath}`));
      }
      return ok(true);
    },
  };
}
