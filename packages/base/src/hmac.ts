import { createHmac } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import type { RunId } from './ids.ts';

/** HMAC-SHA256 as lowercase hex. A string is authenticated as UTF-8. Comparing two MACs is the caller's job, and must be timing-safe. */
export function hmacSha256Hex(key: Uint8Array, data: string | Uint8Array): string {
  if (key.byteLength === 0) throw new RangeError('hmacSha256Hex: empty key');
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Domain separation: an anchor body can never be mistaken for a command body signed with the same project key. */
export const ANCHOR_MAC_PURPOSE = 'cohorte/chain-anchor/v1';

/**
 * The MAC anchor of `checkpoint.created` over `(runId, atSequence, chainHash)` (DESIGN 2.6.7, ADR-0022).
 * THE definition: `security` signs with it (`CommandAuthenticator.anchor`) and `persistence` verifies with it
 * (`verifyChain`), and those two packages may not import each other. The signed bytes are the canonical JSON of
 * `{ purpose, runId, atSequence, chainHash }`, so no field can bleed into its neighbour.
 */
export function computeAnchorMac(key: Uint8Array, runId: RunId, atSequence: number, chainHash: string): string {
  if (!Number.isSafeInteger(atSequence) || atSequence < 0) {
    throw new RangeError(`computeAnchorMac: atSequence must be a non-negative safe integer, got ${atSequence}`);
  }
  return hmacSha256Hex(key, canonicalJson({ purpose: ANCHOR_MAC_PURPOSE, runId, atSequence, chainHash }));
}
