// Control-plane authentication (DESIGN 2.6.7, ADR-0022): file modes + HMAC. `security` names no `protocol` type.
import type { RunId } from '@cohorte/base';

/** ~/.cohorte/keys/<projectId>-<sha256(realpath(git common dir))[0:12]>.key — 32 random bytes, file 0600, directory 0700 */
export interface KeyStore {
  projectKey(projectKeyId: string, opts: { create: boolean }): Promise<Uint8Array>;
}

/**
 * Signs BYTES, not envelopes: `canonicalBody` is `protocol.canonicalCommandBody(envelope)` (the envelope minus `auth`,
 * canonical JSON), computed by the caller (`apps/cli` controllers, `core` inbox drain).
 */
export interface CommandAuthenticator {
  readonly scheme: 'hmac-sha256';
  sign(canonicalBody: string, key: Uint8Array): string;
  /** timing-safe */
  verify(canonicalBody: string, value: string, key: Uint8Array): boolean;
  anchor(runId: RunId, atSequence: number, chainHash: string, key: Uint8Array): string;
}
