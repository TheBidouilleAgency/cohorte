// Reads a REVIEW REPORT (specs/reports/<id>.md, the shape in core/agents/cohorte-review.md) into rows.
// One line per finding:  - **[SEVERITY]** `file:line` · category · problem → **Fix:** change [· out of scope: why]
// Anything that does not match stays out: the page also offers the raw report, so a drifting prompt costs rows, not truth.

import type { Finding, FindingsReport } from '../shared/api';

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const LINE = /^\s*[-*]\s+\*\*\[(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*\s*(.*)$/i;

export function parseFinding(line: string): Finding | null {
  const m = LINE.exec(line);
  if (!m) return null;
  let rest = m[2].trim();
  const severity = m[1].toUpperCase();
  let file = ''; let ln: number | null = null;
  const loc = /^`([^`]+)`\s*(?:·|—|-)?\s*(.*)$/.exec(rest);
  if (loc) {
    rest = loc[2];
    const pos = /^(.*?):(\d+)(?:[-–]\d+)?$/.exec(loc[1]);
    file = pos ? pos[1] : loc[1];
    ln = pos ? Number(pos[2]) : null;
  }
  const parts = rest.split(/\s+·\s+/);
  let category = '';
  if (parts.length > 1 && /^(spec-violation|quality|security|complexity)$/i.test(parts[0].trim())) category = (parts.shift() as string).trim().toLowerCase();
  let body = parts.join(' · ');
  let scope = '';
  const oos = /\s*·\s*out of scope:\s*(.*)$/i.exec(body);
  if (oos) { scope = oos[1].trim(); body = body.slice(0, oos.index); }
  const fix = /^(.*?)\s*(?:→|->)\s*\*\*Fix:\*\*\s*(.*)$/s.exec(body);
  return { severity, file, line: ln, category, problem: (fix ? fix[1] : body).trim(), fix: fix ? fix[2].trim() : '', outOfScope: scope };
}

export function parseReviewReport(md: string): FindingsReport {
  const out: FindingsReport = { findings: [], deferred: [], verdict: null };
  let section: 'findings' | 'deferred' | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(raw);
    if (h) { const t = h[1].trim().toLowerCase(); section = t.startsWith('findings') ? 'findings' : t.startsWith('deferred') ? 'deferred' : null; continue; }
    const v = /^Verdict:\s*(SHIP|REVISE|BLOCK)\b/i.exec(raw);
    if (v) { out.verdict = v[1].toUpperCase(); continue; }
    if (!section) continue;
    const f = parseFinding(raw);
    if (f) out[section].push(f);
  }
  const rank = (s: string): number => SEVERITIES.indexOf(s);
  out.findings.sort((a, b) => rank(a.severity) - rank(b.severity));
  out.deferred.sort((a, b) => rank(a.severity) - rank(b.severity));
  return out;
}
