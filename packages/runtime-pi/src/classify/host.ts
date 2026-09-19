// The last two rows of DESIGN 3.8: errors the PARENT mints from what it observes itself, never from an engine signal.
import { type ErrorInfo, errorOf } from '@cohorte/base';
import type { AttestationMismatch } from '../protocol.ts';

export type ProcessExitReason = 'disconnect' | 'exit-without-settled' | 'heartbeat-lost' | 'spawn-failed';

/** `outcome: 'crashed'`: the host starts a new incarnation. */
export function processExitError(reason: ProcessExitReason, detail = ''): ErrorInfo {
  return errorOf(
    'tool-transient/agent-process-exit',
    `the agent process went away (${reason})${detail ? `: ${detail}` : ''}`,
    {
      details: { reason },
    },
  );
}

export type ProtocolViolationKind =
  | 'unknown-tool'
  | 'frame-schema'
  | 'ordinal-gap'
  | 'nonce-mismatch'
  | 'unexpected-frame'
  | 'handshake-timeout';

/**
 * A child that breaks the host protocol is treated as hostile. The catalogue has no dedicated row yet
 * (docs/v3/requests/U0.03.md R4), so the code is `security/unexpected` and `details.violation` says which rule broke.
 * `detail` says WHERE, never WHAT: a refused frame may hold anything.
 */
export function protocolViolation(kind: ProtocolViolationKind, detail: string): ErrorInfo {
  return errorOf('security/unexpected', `the agent process broke the host protocol (${kind}): ${detail}`, {
    details: { violation: kind },
  });
}

/** The spawn fails closed on ANY mismatch; the two mismatches that have a catalogue row of their own keep it. */
export function attestationError(mismatches: readonly AttestationMismatch[]): ErrorInfo {
  const fields = mismatches.map((mismatch) => mismatch.field);
  const message = `the agent process attested something else than what was asked: ${mismatches
    .map(({ field, expected, got }) => `${field} (expected ${expected}, got ${got})`)
    .join('; ')}`;
  const details = { violation: 'attestation-mismatch', fields };
  if (fields.includes('effective.baseUrl')) return errorOf('security/auth-endpoint-mismatch', message, { details });
  if (fields.some((field) => field.startsWith('auth.')))
    return errorOf('security/auth-mode-violation', message, { details });
  return errorOf('security/unexpected', message, { details });
}
