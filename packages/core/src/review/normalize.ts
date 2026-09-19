import { type SurfaceId, sha256Hex } from '@cohorte/base';
import type { Finding, ReviewResult } from '@cohorte/protocol';

type Severity = 'critical' | 'major' | 'minor' | 'info';

function identity(finding: Finding): string {
  const file = finding.location?.file ?? '(unknown)';
  const words = finding.actual
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');
  return `${file}|${words}`;
}

function severityOf(finding: Finding): Severity {
  if (finding.kind === 'complexity' && (finding.severity === 'critical' || finding.severity === 'major'))
    return 'minor';
  return finding.severity as Severity;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

export function calculateReview(
  findings: readonly Finding[],
  unreviewed: readonly SurfaceId[],
  changedFiles: ReadonlySet<string> = new Set(),
): ReviewResult {
  const needsInvestigation: Finding[] = [];
  const eligible: Finding[] = [];
  for (const original of findings) {
    const finding = { ...original, severity: severityOf(original) } as Finding;
    if (finding.location?.file === undefined || finding.reproduction === undefined) {
      needsInvestigation.push(finding);
      continue;
    }
    if (finding.scope === 'deferred' && changedFiles.has(finding.location.file)) {
      eligible.push({ ...finding, scope: 'in-scope' });
    } else {
      eligible.push(finding);
    }
  }

  const ordered = eligible
    .sort((a, b) => {
      const rank = (f: Finding): number =>
        f.kind === 'security' || f.severity === 'critical'
          ? 0
          : f.severity === 'major'
            ? 1
            : f.severity === 'minor'
              ? 2
              : 3;
      return rank(a) - rank(b) || identity(a).localeCompare(identity(b));
    })
    .slice(0, 30);
  const deferred = ordered.filter((f) => f.scope === 'deferred');
  const kept = ordered.filter((f) => f.scope === 'in-scope');
  const refuted: Finding[] = [];
  const blockingItems = sortedUnique(
    kept.filter((f) => f.severity === 'critical' || f.kind === 'security').map(identity),
  );
  const fixItems = sortedUnique(
    kept.filter((f) => f.severity === 'critical' || f.kind === 'security' || f.severity === 'major').map(identity),
  );
  const fingerprint = fixItems.length === 0 ? '' : sha256Hex(`${fixItems.join('\n')}\n`).slice(0, 16);
  const counts = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const finding of kept) counts[severityOf(finding)] += 1;
  const security = kept.some((f) => f.kind === 'security');
  const clean = fixItems.length === 0 && !security && deferred.length === 0;
  return {
    verdict: unreviewed.length > 0 || security ? 'needs-human' : clean ? 'approved' : 'findings',
    kept,
    refuted,
    deferred,
    needsInvestigation,
    blocking: blockingItems.length,
    blockingItems,
    fingerprint,
    unreviewed: [...unreviewed],
    clean,
    counts,
  };
}

export function findingIdentity(finding: Finding): string {
  return identity(finding);
}
