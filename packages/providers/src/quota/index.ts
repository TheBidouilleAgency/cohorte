// Rate-limit header parsing (PLAN U3.10).
import { toIsoInstant } from '@cohorte/base';
import type { ParsedQuota } from '../contract.ts';

export function parseQuotaHeaders(
  provider: string,
  headers: Readonly<Record<string, string>>,
  observedAt: Date,
): ParsedQuota {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const numberOf = (key: string): number | undefined => {
    const raw = normalized.get(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const resetRaw =
    normalized.get('retry-after') ?? normalized.get('x-ratelimit-reset-requests') ?? normalized.get('x-codex-reset');
  let retryAfterMs: number | undefined;
  if (resetRaw !== undefined) {
    const seconds = Number(resetRaw);
    retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(resetRaw) - observedAt.getTime());
  }
  const remaining = numberOf('x-ratelimit-remaining-requests') ?? numberOf('x-ratelimit-remaining');
  const limit = numberOf('x-ratelimit-limit-requests') ?? numberOf('x-ratelimit-limit');
  const usedPercent =
    remaining !== undefined && limit !== undefined && limit > 0
      ? Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100))
      : undefined;
  return {
    quota: {
      known: true,
      source: 'response-headers',
      provider,
      windows: [
        {
          name: 'requests',
          ...(usedPercent === undefined ? {} : { usedPercent }),
          ...(resetRaw === undefined ? {} : { resetsAt: toIsoInstant(observedAt.getTime() + (retryAfterMs ?? 0)) }),
          ...(limit === undefined ? {} : { limitLabel: String(limit) }),
        },
      ],
      observedAt: toIsoInstant(observedAt),
    },
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}
